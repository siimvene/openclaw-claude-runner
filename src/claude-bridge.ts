/**
 * Claude Code CLI Bridge Server
 *
 * Embeds a tiny HTTP server that speaks OpenAI chat completions protocol.
 * When OpenClaw sends a request, it spawns `claude` CLI and translates
 * the NDJSON streaming output into SSE chunks.
 *
 * Features:
 *   - Line-buffered NDJSON parser (handles split chunks)
 *   - Retry with exponential backoff on transient errors
 *   - --max-turns safety cap to prevent runaway loops
 *   - Session resume via x-session-id header
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { spawn, type ChildProcess } from "node:child_process";

export interface BridgeConfig {
  port: number;
  claudeBin: string;
  skipPermissions: boolean;
  workDir: string;
  maxTurns?: number;
  maxRetries?: number;
}

interface LiveProcess {
  proc: ChildProcess;
  abortReason?: string;
}

const DEFAULT_MAX_TURNS = 30;
const MAX_RETRIES = 2;
const RETRY_DELAYS = [1000, 2000];
const KILL_ESCALATION_MS = 2000;

const liveProcesses = new Map<string, LiveProcess>();

// ── Env cleanup ──────────────────────────────────────────────────────

function buildCleanEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith("CLAUDECODE") || key.startsWith("CLAUDE_CODE_")) {
      delete env[key];
    }
  }
  return env;
}

// ── Transient error detection ────────────────────────────────────────

const TRANSIENT_PATTERNS = [
  /ECONNRESET/i,
  /ETIMEDOUT/i,
  /socket hang up/i,
  /503/,
  /529/,
  /rate.?limit/i,
  /overloaded/i,
  /too many requests/i,
];

function isTransientError(stderr: string, code: number | null): boolean {
  if (code === null) return false;
  return TRANSIENT_PATTERNS.some((p) => p.test(stderr));
}

// ── Message extraction ───────────────────────────────────────────────

// content can be a string or an array of {type:"text",text:"..."} parts
function flattenContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part: any) => {
        if (typeof part === "string") return part;
        if (part?.type === "text" && typeof part.text === "string") return part.text;
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  if (content == null) return "";
  return String(content);
}

function extractPromptFromMessages(messages: Array<{ role: string; content: unknown }>): string {
  const parts: string[] = [];
  for (const msg of messages) {
    if (msg.role === "system") continue;
    const text = flattenContent(msg.content);
    if (!text) continue;
    if (msg.role === "user") {
      parts.push(text);
    } else if (msg.role === "assistant") {
      parts.push(`[Previous assistant response]: ${text}`);
    }
  }
  return parts.join("\n\n");
}

function extractSystemPrompt(messages: Array<{ role: string; content: unknown }>): string | undefined {
  const systemMsgs = messages.filter((m) => m.role === "system");
  if (systemMsgs.length === 0) return undefined;
  return systemMsgs.map((m) => flattenContent(m.content)).filter(Boolean).join("\n\n");
}

// ── Line-buffered NDJSON parser ──────────────────────────────────────
// Handles chunks that split mid-line across `data` events from stdout.

class NdjsonParser {
  private buffer = "";
  private handler: (event: { type: string; [key: string]: any }) => void;

  constructor(handler: (event: { type: string; [key: string]: any }) => void) {
    this.handler = handler;
  }

  feed(chunk: string): void {
    this.buffer += chunk;
    const lines = this.buffer.split("\n");
    // Keep the last (possibly incomplete) line in the buffer
    this.buffer = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const event = JSON.parse(trimmed);
        if (event.type) this.handler(event);
      } catch {
        // Not valid JSON — skip
      }
    }
  }

  flush(): void {
    if (this.buffer.trim()) {
      try {
        const event = JSON.parse(this.buffer.trim());
        if (event.type) this.handler(event);
      } catch {
        // Ignore trailing incomplete data
      }
    }
    this.buffer = "";
  }
}

// ── Process lifecycle ────────────────────────────────────────────────

function killProcess(id: string): void {
  const live = liveProcesses.get(id);
  if (!live) return;
  live.abortReason = "killed";

  try {
    if (live.proc.pid) process.kill(-live.proc.pid, "SIGTERM");
  } catch {
    live.proc.kill("SIGTERM");
  }

  setTimeout(() => {
    if (liveProcesses.has(id)) {
      try {
        if (live.proc.pid) process.kill(-live.proc.pid, "SIGKILL");
      } catch {
        live.proc.kill("SIGKILL");
      }
    }
  }, KILL_ESCALATION_MS);
}

// ── Core: spawn claude CLI ───────────────────────────────────────────

interface SpawnOpts {
  prompt: string;
  model: string;
  systemPrompt?: string;
  sessionId?: string;
  config: BridgeConfig;
}

function buildArgs(opts: SpawnOpts): string[] {
  const args: string[] = ["-p", opts.prompt, "--output-format", "stream-json", "--verbose"];

  if (opts.config.skipPermissions) {
    args.push("--dangerously-skip-permissions");
  }

  const cleanModel = opts.model.replace(/^claude-runner\//, "");
  args.push("--model", cleanModel);

  const maxTurns = opts.config.maxTurns ?? DEFAULT_MAX_TURNS;
  args.push("--max-turns", String(maxTurns));

  if (opts.systemPrompt) {
    args.push("--append-system-prompt", opts.systemPrompt);
  }

  if (opts.sessionId) {
    args.push("--resume", opts.sessionId);
  }

  return args;
}

// ── Request handler ──────────────────────────────────────────────────

async function handleCompletions(
  req: IncomingMessage,
  res: ServerResponse,
  config: BridgeConfig,
): Promise<void> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
  }
  const body = JSON.parse(Buffer.concat(chunks).toString());

  const messages: Array<{ role: string; content: string }> = body.messages ?? [];
  const stream = body.stream !== false;
  const model = body.model ?? "claude-opus-4-5";
  const sessionId = (req.headers["x-session-id"] as string) || undefined;
  const requestId = `req-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  const prompt = extractPromptFromMessages(messages);
  const systemPrompt = extractSystemPrompt(messages);

  if (!prompt) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { message: "No user message found", type: "invalid_request_error" } }));
    return;
  }

  const spawnOpts: SpawnOpts = { prompt, model, systemPrompt, sessionId, config };

  // Retry loop for transient errors
  const maxRetries = config.maxRetries ?? MAX_RETRIES;
  let lastError = "";

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (attempt > 0) {
      const delay = RETRY_DELAYS[attempt - 1] ?? 2000;
      await new Promise((r) => setTimeout(r, delay));
    }

    try {
      if (stream) {
        await handleStreamingResponse(spawnOpts, res, requestId);
      } else {
        await handleNonStreamingResponse(spawnOpts, res, requestId);
      }
      return; // Success — exit retry loop
    } catch (err: any) {
      lastError = err.stderr ?? err.message ?? String(err);

      // If response headers already sent (streaming started), can't retry
      if (res.headersSent) return;

      if (!isTransientError(lastError, err.exitCode ?? null)) {
        break; // Non-transient — don't retry
      }
    }
  }

  // All retries exhausted
  if (!res.headersSent) {
    res.writeHead(502, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { message: lastError || "claude CLI failed after retries", type: "server_error" } }));
  }
}

// ── Streaming response ───────────────────────────────────────────────

async function handleStreamingResponse(
  opts: SpawnOpts,
  res: ServerResponse,
  requestId: string,
): Promise<void> {
  const args = buildArgs(opts);
  const cleanEnv = buildCleanEnv();
  const model = opts.model.replace(/^claude-runner\//, "");

  const proc = spawn(opts.config.claudeBin, args, {
    cwd: opts.config.workDir,
    env: cleanEnv,
    stdio: ["ignore", "pipe", "pipe"],
    detached: process.platform !== "win32",
  });

  liveProcesses.set(requestId, { proc });

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });

  const sendSSE = (data: object) => {
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  // Initial role chunk
  sendSSE({
    id: requestId,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }],
  });

  let resultText = "";
  let stderr = "";

  const parser = new NdjsonParser((event) => {
    if (event.type === "content_block_delta" && event.delta?.type === "text_delta" && event.delta.text) {
      sendSSE({
        id: requestId,
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [{ index: 0, delta: { content: event.delta.text }, finish_reason: null }],
      });
    } else if (event.type === "result") {
      resultText = event.result ?? event.text ?? "";
    }
  });

  proc.stdout!.on("data", (chunk: Buffer) => {
    parser.feed(chunk.toString());
  });

  proc.stderr!.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });

  return new Promise<void>((resolve, reject) => {
    proc.on("close", (code) => {
      parser.flush();
      liveProcesses.delete(requestId);

      // If we got a result but no streaming deltas, send it as a single chunk
      if (resultText && !res.writableEnded) {
        sendSSE({
          id: requestId,
          object: "chat.completion.chunk",
          created: Math.floor(Date.now() / 1000),
          model,
          choices: [{ index: 0, delta: { content: resultText }, finish_reason: null }],
        });
      }

      sendSSE({
        id: requestId,
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      });
      res.write("data: [DONE]\n\n");
      res.end();
      resolve();
    });

    proc.on("error", (err) => {
      liveProcesses.delete(requestId);
      if (!res.headersSent) {
        // Propagate for retry
        const wrapped: any = new Error(err.message);
        wrapped.stderr = stderr;
        reject(wrapped);
      } else {
        sendSSE({
          id: requestId,
          object: "chat.completion.chunk",
          created: Math.floor(Date.now() / 1000),
          model,
          choices: [{ index: 0, delta: { content: `\n\nError: ${err.message}` }, finish_reason: "stop" }],
        });
        res.write("data: [DONE]\n\n");
        res.end();
        resolve();
      }
    });
  });
}

// ── Non-streaming response ───────────────────────────────────────────

async function handleNonStreamingResponse(
  opts: SpawnOpts,
  res: ServerResponse,
  requestId: string,
): Promise<void> {
  const args = buildArgs(opts);
  const cleanEnv = buildCleanEnv();
  const model = opts.model.replace(/^claude-runner\//, "");

  const proc = spawn(opts.config.claudeBin, args, {
    cwd: opts.config.workDir,
    env: cleanEnv,
    stdio: ["ignore", "pipe", "pipe"],
    detached: process.platform !== "win32",
  });

  liveProcesses.set(requestId, { proc });

  let resultText = "";
  let stderr = "";

  const parser = new NdjsonParser((event) => {
    if (event.type === "result") {
      resultText = event.result ?? event.text ?? "";
    }
  });

  proc.stdout!.on("data", (chunk: Buffer) => {
    parser.feed(chunk.toString());
  });

  proc.stderr!.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });

  return new Promise<void>((resolve, reject) => {
    proc.on("close", (code) => {
      parser.flush();
      liveProcesses.delete(requestId);

      if (!resultText && code !== 0) {
        const wrapped: any = new Error(stderr || `claude exited with code ${code}`);
        wrapped.exitCode = code;
        wrapped.stderr = stderr;
        reject(wrapped);
        return;
      }

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          id: requestId,
          object: "chat.completion",
          created: Math.floor(Date.now() / 1000),
          model,
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: resultText },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        }),
      );
      resolve();
    });

    proc.on("error", (err) => {
      liveProcesses.delete(requestId);
      const wrapped: any = new Error(err.message);
      wrapped.stderr = stderr;
      reject(wrapped);
    });
  });
}

// ── Server lifecycle ─────────────────────────────────────────────────

export function startBridgeServer(config: BridgeConfig): Promise<ReturnType<typeof createServer>> {
  return new Promise((resolve, reject) => {
    const server = createServer(async (req, res) => {
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Session-Id");

      if (req.method === "OPTIONS") {
        res.writeHead(204);
        res.end();
        return;
      }

      if (req.url === "/health" || req.url === "/v1/health") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "ok", liveProcesses: liveProcesses.size }));
        return;
      }

      if (req.url === "/v1/models" && req.method === "GET") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            object: "list",
            data: [
              { id: "claude-opus-4-5", object: "model", owned_by: "anthropic" },
              { id: "claude-sonnet-4-6", object: "model", owned_by: "anthropic" },
              { id: "claude-sonnet-4", object: "model", owned_by: "anthropic" },
              { id: "claude-haiku-4-5", object: "model", owned_by: "anthropic" },
            ],
          }),
        );
        return;
      }

      if (req.url === "/v1/chat/completions" && req.method === "POST") {
        try {
          await handleCompletions(req, res, config);
        } catch (err: any) {
          if (!res.headersSent) {
            res.writeHead(500, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: { message: err.message, type: "server_error" } }));
          }
        }
        return;
      }

      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: "Not found", type: "invalid_request_error" } }));
    });

    server.listen(config.port, "127.0.0.1", () => {
      resolve(server);
    });

    server.on("error", reject);
  });
}

export function stopBridgeServer(server: ReturnType<typeof createServer>): Promise<void> {
  for (const [id] of liveProcesses) {
    killProcess(id);
  }
  liveProcesses.clear();

  return new Promise((resolve) => {
    server.close(() => resolve());
  });
}
