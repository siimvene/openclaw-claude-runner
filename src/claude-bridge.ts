/**
 * Claude Agent SDK Bridge Server
 *
 * Embeds a tiny HTTP server that speaks OpenAI chat completions protocol.
 * When OpenClaw sends a request, it invokes the Claude Agent SDK's query()
 * function and translates the streaming messages into SSE chunks.
 *
 * Features:
 *   - Agent SDK (no CLI subprocess, no TUI, no PTY)
 *   - Session reuse via SDK resume
 *   - Request queue with randomized jitter
 *   - Structured streaming via includePartialMessages
 *   - Retry with exponential backoff on transient errors
 *   - AbortController-based cancellation
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID, createHash } from "node:crypto";
import { query } from "@anthropic-ai/claude-agent-sdk";

export interface BridgeConfig {
  port: number;
  workDir: string;
  skipPermissions: boolean;
  maxTurns?: number;
  maxRetries?: number;
  queueMinDelayMs?: number;
  queueMaxDelayMs?: number;
  queueMaxConcurrency?: number;
  sessionTtlMs?: number;
  tools?: string[];
  effort?: "low" | "medium" | "high" | "max";
  maxBudgetUsd?: number;
}

const DEFAULT_MAX_TURNS = 30;
const MAX_RETRIES = 2;
const RETRY_DELAYS = [1000, 2000];

// Track active queries for cancellation
const activeQueries = new Map<string, AbortController>();

// ── Session Store ───────────────────────────────────────────────────

interface ContextUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  contextWindow: number;
  totalTokens: number;
  fillPercent: number;
  costUsd: number;
}

interface SessionEntry {
  claudeSessionId: string;
  lastUsed: number;
  turnCount: number;
  contextUsage?: ContextUsage;
  /** Compacted summary injected into new sessions after rotation */
  compactSummary?: string;
}

const COMPACT_FILL_THRESHOLD = 0.75;

class SessionStore {
  private sessions = new Map<string, SessionEntry>();
  private readonly ttlMs: number;

  constructor(ttlMs = 3_600_000) {
    this.ttlMs = ttlMs;
  }

  get(conversationId: string): SessionEntry | undefined {
    const entry = this.sessions.get(conversationId);
    if (!entry) return undefined;
    if (Date.now() - entry.lastUsed > this.ttlMs) {
      this.sessions.delete(conversationId);
      return undefined;
    }
    // Touch on read to prevent premature TTL expiry
    entry.lastUsed = Date.now();
    return entry;
  }

  getSessionId(conversationId: string): string | undefined {
    return this.get(conversationId)?.claudeSessionId;
  }

  record(conversationId: string, claudeSessionId: string): void {
    const existing = this.sessions.get(conversationId);
    this.sessions.set(conversationId, {
      claudeSessionId,
      lastUsed: Date.now(),
      turnCount: (existing?.turnCount ?? 0) + 1,
      contextUsage: existing?.contextUsage,
      compactSummary: existing?.compactSummary,
    });
  }

  updateContextUsage(conversationId: string, usage: ContextUsage): void {
    const entry = this.sessions.get(conversationId);
    if (entry) {
      entry.contextUsage = usage;
    }
  }

  /** Mark session as needing rotation — store summary for next request */
  setCompactSummary(conversationId: string, summary: string): void {
    const entry = this.sessions.get(conversationId);
    if (entry) {
      entry.compactSummary = summary;
    }
  }

  /** Consume and clear the compact summary (used when starting a new session) */
  consumeCompactSummary(conversationId: string): string | undefined {
    const entry = this.sessions.get(conversationId);
    if (!entry?.compactSummary) return undefined;
    const summary = entry.compactSummary;
    entry.compactSummary = undefined;
    return summary;
  }

  /** Reset session for compaction — clears the SDK session ID so next request starts fresh */
  rotateSession(conversationId: string, summary: string): void {
    const entry = this.sessions.get(conversationId);
    if (entry) {
      entry.compactSummary = summary;
      entry.claudeSessionId = ''; // Force new session on next request
      entry.contextUsage = undefined;
      entry.turnCount = 0;
    }
  }

  needsCompaction(conversationId: string): boolean {
    const entry = this.sessions.get(conversationId);
    if (!entry?.contextUsage) return false;
    return entry.contextUsage.fillPercent >= COMPACT_FILL_THRESHOLD;
  }

  getContextInfo(conversationId: string): ContextUsage | undefined {
    return this.get(conversationId)?.contextUsage;
  }

  getAllSessions(): Array<{ conversationId: string; entry: SessionEntry }> {
    const result: Array<{ conversationId: string; entry: SessionEntry }> = [];
    for (const [conversationId, entry] of this.sessions) {
      if (Date.now() - entry.lastUsed <= this.ttlMs) {
        result.push({ conversationId, entry });
      }
    }
    return result;
  }

  clear(): void {
    this.sessions.clear();
  }
}

// ── Request Queue ───────────────────────────────────────────────────

class RequestQueue {
  private queue: Array<{
    execute: () => Promise<void>;
    resolve: () => void;
    reject: (err: Error) => void;
    enqueued: number;
  }> = [];
  private active = 0;
  private readonly maxConcurrency: number;
  private readonly minDelayMs: number;
  private readonly maxDelayMs: number;
  private readonly queueTimeoutMs: number;
  private lastSpawnTime = 0;

  constructor(maxConcurrency = 1, minDelayMs = 1000, maxDelayMs = 4000, queueTimeoutMs = 60_000) {
    this.maxConcurrency = maxConcurrency;
    this.minDelayMs = minDelayMs;
    this.maxDelayMs = maxDelayMs;
    this.queueTimeoutMs = queueTimeoutMs;
  }

  enqueue(fn: () => Promise<void>): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.queue.push({ execute: fn, resolve, reject, enqueued: Date.now() });
      this.drain();
    });
  }

  private async drain(): Promise<void> {
    if (this.active >= this.maxConcurrency || this.queue.length === 0) return;

    const item = this.queue.shift()!;

    if (Date.now() - item.enqueued > this.queueTimeoutMs) {
      item.reject(new Error("Request timed out in queue"));
      this.drain();
      return;
    }

    this.active++;

    const elapsed = Date.now() - this.lastSpawnTime;
    const jitter = this.minDelayMs + Math.random() * (this.maxDelayMs - this.minDelayMs);
    const wait = Math.max(0, jitter - elapsed);
    if (wait > 0) {
      await new Promise((r) => setTimeout(r, wait));
    }

    this.lastSpawnTime = Date.now();

    try {
      await item.execute();
      item.resolve();
    } catch (err: any) {
      item.reject(err);
    } finally {
      this.active--;
      this.drain();
    }
  }
}

// ── Module-level instances ──────────────────────────────────────────

let sessionStore: SessionStore;
let requestQueue: RequestQueue;

// ── Transient error detection ───────────────────────────────────────

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

function isTransientError(message: string): boolean {
  return TRANSIENT_PATTERNS.some((p) => p.test(message));
}

// ── Message extraction ──────────────────────────────────────────────

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

const PROMPT_HISTORY_MAX_MESSAGES = 24;
const PROMPT_HISTORY_MAX_CHARS = 48_000;

function formatRoleLabel(role: string): string {
  switch (role) {
    case "user":
      return "User";
    case "assistant":
      return "Assistant";
    case "tool":
      return "Tool";
    case "system":
      return "System";
    default:
      return role[0]?.toUpperCase() + role.slice(1);
  }
}

function trimPromptHistory(text: string, maxChars = PROMPT_HISTORY_MAX_CHARS): string {
  if (text.length <= maxChars) return text;
  return `[Earlier conversation truncated]\n\n${text.slice(-maxChars)}`;
}

function extractPromptFromMessages(messages: Array<{ role: string; content: unknown }>): string {
  // Only send the latest user message — the SDK manages conversation
  // history internally via session resume. Sending the full history
  // as a giant prompt triggers Anthropic's third-party detection.
  const userMsgs = messages.filter((m) => m.role === "user");
  if (userMsgs.length === 0) return "";
  return flattenContent(userMsgs[userMsgs.length - 1].content);
}

function extractSystemPrompt(messages: Array<{ role: string; content: unknown }>): string | undefined {
  const systemMsgs = messages.filter((m) => m.role === "system");
  if (systemMsgs.length === 0) return undefined;
  const full = systemMsgs.map((m) => flattenContent(m.content)).filter(Boolean).join("\n\n");
  return full || undefined;
}

// ── Session resolution ──────────────────────────────────────────────

/**
 * Derive a stable conversation ID from the messages array.
 * Hashes the role sequence + all user message content so that
 * different conversations with the same opening message don't collide.
 */
function deriveConversationIdFromMessages(messages: Array<{ role: string; content: unknown }>): string {
  if (messages.length === 0) return "default";
  const fingerprint = messages
    .map((m, i) => {
      const text = m.role === "user" ? flattenContent(m.content).slice(0, 200) : "";
      return `${i}:${m.role}:${text}`;
    })
    .join("|");
  const hash = createHash("sha256").update(fingerprint).digest("hex").slice(0, 16);
  return `derived-${hash}`;
}

function resolveConversationId(
  req: IncomingMessage,
  body: Record<string, any>,
): string {
  return (
    (req.headers["x-session-id"] as string) ||
    (req.headers["x-conversation-id"] as string) ||
    body.conversation_id ||
    body.metadata?.conversation_id ||
    deriveConversationIdFromMessages(body.messages ?? [])
  );
}

// ── Request handler ─────────────────────────────────────────────────

async function handleCompletions(
  req: IncomingMessage,
  res: ServerResponse,
  config: BridgeConfig,
): Promise<void> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
  }
  let body: Record<string, any>;
  try {
    body = JSON.parse(Buffer.concat(chunks).toString());
  } catch {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { message: "Invalid JSON body", type: "invalid_request_error" } }));
    return;
  }

  const messages: Array<{ role: string; content: string }> = body.messages ?? [];
  const stream = body.stream !== false;
  const model = body.model?.replace(/^claude-runner\//, "") ?? "claude-opus-4-5";
  const requestId = `req-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  const prompt = extractPromptFromMessages(messages);
  const systemPrompt = extractSystemPrompt(messages);
  const conversationId = resolveConversationId(req, body);

  if (!prompt) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { message: "No user message found", type: "invalid_request_error" } }));
    return;
  }

  try {
    await requestQueue.enqueue(async () => {
      await executeWithRetries(prompt, model, systemPrompt, conversationId, stream, res, requestId, config);
    });
  } catch (err: any) {
    if (!res.headersSent) {
      const status = err.message?.includes("timed out in queue") ? 503 : 502;
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: err.message || "Request failed", type: "server_error" } }));
    }
  }
}

async function executeWithRetries(
  prompt: string,
  model: string,
  systemPrompt: string | undefined,
  conversationId: string,
  stream: boolean,
  res: ServerResponse,
  requestId: string,
  config: BridgeConfig,
): Promise<void> {
  const maxRetries = config.maxRetries ?? MAX_RETRIES;
  let lastError = "";

  // Resolve session — derive stable ID if gateway doesn't send one
  let resumeSessionId: string | undefined;
  let newSessionId: string | undefined;

  const entry = sessionStore.get(conversationId);
  if (entry?.claudeSessionId) {
    resumeSessionId = entry.claudeSessionId;
  } else {
    newSessionId = randomUUID();
  }
  // Consume any pending compact summary for the new session
  const compactSummary = sessionStore.consumeCompactSummary(conversationId);

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (attempt > 0) {
      const delay = RETRY_DELAYS[attempt - 1] ?? 2000;
      await new Promise((r) => setTimeout(r, delay));
    }

    try {
      // Only send system prompt on first turn — resumed sessions already have it.
      // Sending it again causes duplicate instructions and can trigger repeated responses.
      let effectiveSystemPrompt: string | undefined;
      if (!resumeSessionId) {
        effectiveSystemPrompt = compactSummary
          ? [systemPrompt, `\n\n## Previous conversation summary\n${compactSummary}`].filter(Boolean).join('')
          : systemPrompt;
      }

      if (stream) {
        await handleStreamingResponse(prompt, model, effectiveSystemPrompt, resumeSessionId, newSessionId, conversationId, res, requestId, config);
      } else {
        await handleNonStreamingResponse(prompt, model, effectiveSystemPrompt, resumeSessionId, newSessionId, conversationId, res, requestId, config);
      }
      return;
    } catch (err: any) {
      lastError = err.message ?? String(err);

      if (res.headersSent) return;

      // Stale session — retry with fresh
      if (resumeSessionId && /no conversation found|session/i.test(lastError)) {
        resumeSessionId = undefined;
        newSessionId = randomUUID();
        sessionStore.record(conversationId, newSessionId);
        continue;
      }

      if (!isTransientError(lastError)) {
        break;
      }
    }
  }

  if (!res.headersSent) {
    res.writeHead(502, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { message: lastError || "SDK query failed after retries", type: "server_error" } }));
  }
}

// ── Build SDK options ───────────────────────────────────────────────

function buildQueryOptions(
  model: string,
  systemPrompt: string | undefined,
  resumeSessionId: string | undefined,
  newSessionId: string | undefined,
  config: BridgeConfig,
  abortController: AbortController,
): Record<string, any> {
  const opts: Record<string, any> = {
    model,
    cwd: config.workDir,
    maxTurns: config.maxTurns ?? DEFAULT_MAX_TURNS,
    includePartialMessages: true,
    abortController,
  };

  if (config.skipPermissions) {
    opts.permissionMode = "bypassPermissions";
    opts.allowDangerouslySkipPermissions = true;
  }

  if (resumeSessionId) {
    opts.resume = resumeSessionId;
  } else if (newSessionId) {
    opts.sessionId = newSessionId;
  }

  if (systemPrompt) {
    opts.appendSystemPrompt = systemPrompt;
  }

  if (config.tools) {
    opts.tools = config.tools;
  }

  if (config.effort) {
    opts.effort = config.effort;
  }

  if (config.maxBudgetUsd) {
    opts.maxBudgetUsd = config.maxBudgetUsd;
  }

  return opts;
}

// ── Streaming response ──────────────────────────────────────────────

async function handleStreamingResponse(
  prompt: string,
  model: string,
  systemPrompt: string | undefined,
  resumeSessionId: string | undefined,
  newSessionId: string | undefined,
  conversationId: string,
  res: ServerResponse,
  requestId: string,
  config: BridgeConfig,
): Promise<void> {
  const abortController = new AbortController();
  const options = buildQueryOptions(model, systemPrompt, resumeSessionId, newSessionId, config, abortController);

  const q = query({ prompt, options });
  activeQueries.set(requestId, abortController);

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
  let streamedDelta = false;

  try {
    for await (const msg of q) {
      // Token-level streaming deltas
      if (msg.type === "stream_event") {
        const event = (msg as any).event;
        if (event?.type === "content_block_delta" && event.delta?.type === "text_delta" && event.delta.text) {
          streamedDelta = true;
          sendSSE({
            id: requestId,
            object: "chat.completion.chunk",
            created: Math.floor(Date.now() / 1000),
            model,
            choices: [{ index: 0, delta: { content: event.delta.text }, finish_reason: null }],
          });
        }
      }

      // Full assistant message (fallback)
      if (msg.type === "assistant") {
        const content = (msg as any).message?.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block.type === "text" && block.text && !streamedDelta) {
              resultText = block.text;
            }
          }
        }
      }

      // Result — session ID, completion, and context usage
      if (msg.type === "result") {
        const result = msg as any;
        if (result.session_id) {
          sessionStore.record(conversationId, result.session_id);
        }
        if (result.subtype === "success" && result.result && !streamedDelta) {
          resultText = result.result;
        }

        // Extract context usage from SDK result
        if (result.modelUsage) {
          const usage = extractContextUsage(result.modelUsage);
          if (usage) {
            sessionStore.updateContextUsage(conversationId, usage);

            // Check if compaction is needed
            if (sessionStore.needsCompaction(conversationId)) {
              scheduleCompaction(conversationId, result.result ?? resultText);
            }
          }
        }
      }
    }
  } catch (err: any) {
    if (!res.writableEnded) {
      sendSSE({
        id: requestId,
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [{ index: 0, delta: { content: `\n\nError: ${err.message}` }, finish_reason: "stop" }],
      });
    }
  } finally {
    activeQueries.delete(requestId);
  }

  if (!res.writableEnded) {
    // Fallback: send result as one chunk if no streaming deltas came through
    if (resultText && !streamedDelta) {
      sendSSE({
        id: requestId,
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [{ index: 0, delta: { content: resultText }, finish_reason: null }],
      });
    }

    // Include context usage in the final SSE chunk
    const contextInfo = sessionStore.getContextInfo(conversationId);

    sendSSE({
      id: requestId,
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      ...(contextInfo ? {
        usage: {
          prompt_tokens: contextInfo.inputTokens,
          completion_tokens: contextInfo.outputTokens,
          total_tokens: contextInfo.totalTokens,
        },
        context: {
          fill_percent: contextInfo.fillPercent,
          context_window: contextInfo.contextWindow,
          total_tokens: contextInfo.totalTokens,
        },
      } : {}),
    });
    res.write("data: [DONE]\n\n");
    res.end();
  }
}

// ── Non-streaming response ──────────────────────────────────────────

async function handleNonStreamingResponse(
  prompt: string,
  model: string,
  systemPrompt: string | undefined,
  resumeSessionId: string | undefined,
  newSessionId: string | undefined,
  conversationId: string,
  res: ServerResponse,
  requestId: string,
  config: BridgeConfig,
): Promise<void> {
  const abortController = new AbortController();
  const options = buildQueryOptions(model, systemPrompt, resumeSessionId, newSessionId, config, abortController);

  const q = query({ prompt, options });
  activeQueries.set(requestId, abortController);

  let resultText = "";

  try {
    for await (const msg of q) {
      if (msg.type === "result") {
        const result = msg as any;
        if (result.session_id) {
          sessionStore.record(conversationId, result.session_id);
        }
        if (result.subtype === "success") {
          resultText = result.result ?? "";
        } else {
          const errors = result.errors?.join("; ") ?? "Unknown error";
          throw new Error(errors);
        }

        // Extract context usage
        if (result.modelUsage) {
          const usage = extractContextUsage(result.modelUsage);
          if (usage) {
            sessionStore.updateContextUsage(conversationId, usage);
            if (sessionStore.needsCompaction(conversationId)) {
              scheduleCompaction(conversationId, resultText);
            }
          }
        }
      }
    }
  } finally {
    activeQueries.delete(requestId);
  }

  const contextInfo = sessionStore.getContextInfo(conversationId);

  res.writeHead(200, {
    "Content-Type": "application/json",
    ...(contextInfo ? {
      "X-Context-Fill-Percent": String(Math.round(contextInfo.fillPercent * 100)),
      "X-Context-Window": String(contextInfo.contextWindow),
    } : {}),
  });
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
      usage: {
        prompt_tokens: contextInfo?.inputTokens ?? 0,
        completion_tokens: contextInfo?.outputTokens ?? 0,
        total_tokens: contextInfo?.totalTokens ?? 0,
      },
      ...(contextInfo ? {
        context: {
          fill_percent: contextInfo.fillPercent,
          context_window: contextInfo.contextWindow,
          total_tokens: contextInfo.totalTokens,
        },
      } : {}),
    }),
  );
}

// ── Context usage extraction ───────────────────────────────────────

function extractContextUsage(modelUsage: Record<string, any>): ContextUsage | undefined {
  // modelUsage is keyed by model name — aggregate across all models
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadInputTokens = 0;
  let cacheCreationInputTokens = 0;
  let contextWindow = 1_000_000;
  let costUsd = 0;

  for (const usage of Object.values(modelUsage)) {
    inputTokens += usage.inputTokens ?? 0;
    outputTokens += usage.outputTokens ?? 0;
    cacheReadInputTokens += usage.cacheReadInputTokens ?? 0;
    cacheCreationInputTokens += usage.cacheCreationInputTokens ?? 0;
    if (usage.contextWindow) contextWindow = usage.contextWindow;
    costUsd += usage.costUSD ?? 0;
  }

  const totalTokens = inputTokens + outputTokens;
  if (totalTokens === 0) return undefined;

  return {
    inputTokens,
    outputTokens,
    cacheReadInputTokens,
    cacheCreationInputTokens,
    contextWindow,
    totalTokens,
    fillPercent: totalTokens / contextWindow,
    costUsd,
  };
}

// ── Compaction ─────────────────────────────────────────────────────

function scheduleCompaction(conversationId: string, lastResult: string): void {
  // Generate a summary request to compact the conversation.
  // We rotate the session immediately — the next request will start
  // a fresh session with the summary injected as system prompt context.
  const summary = [
    "The conversation was compacted due to high context usage.",
    "Key context from the previous conversation:",
    lastResult ? `Last assistant response: ${lastResult.slice(0, 2000)}` : "",
  ].filter(Boolean).join("\n");

  sessionStore.rotateSession(conversationId, summary);
}

// ── Server lifecycle ────────────────────────────────────────────────

export function startBridgeServer(config: BridgeConfig): Promise<ReturnType<typeof createServer>> {
  sessionStore = new SessionStore(config.sessionTtlMs);
  requestQueue = new RequestQueue(
    config.queueMaxConcurrency ?? 1,
    config.queueMinDelayMs ?? 1000,
    config.queueMaxDelayMs ?? 4000,
  );

  return new Promise((resolve, reject) => {
    const server = createServer(async (req, res) => {
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Session-Id, X-Conversation-Id");
      res.setHeader("Access-Control-Expose-Headers", "X-Context-Fill-Percent, X-Context-Window");

      if (req.method === "OPTIONS") {
        res.writeHead(204);
        res.end();
        return;
      }

      if (req.url === "/health" || req.url === "/v1/health") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "ok", activeQueries: activeQueries.size }));
        return;
      }

      if (req.url === "/v1/models" && req.method === "GET") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            object: "list",
            data: [
              { id: "claude-opus-4-6", object: "model", owned_by: "anthropic" },
              { id: "claude-opus-4-5", object: "model", owned_by: "anthropic" },
              { id: "claude-sonnet-4-6", object: "model", owned_by: "anthropic" },
              { id: "claude-sonnet-4", object: "model", owned_by: "anthropic" },
              { id: "claude-haiku-4-5", object: "model", owned_by: "anthropic" },
            ],
          }),
        );
        return;
      }

      // Session context info endpoint
      if (req.url?.startsWith("/v1/sessions") && req.method === "GET") {
        const sessionId = req.url.split("/v1/sessions/")[1];
        if (sessionId) {
          // Single session context info
          const info = sessionStore.getContextInfo(sessionId);
          const entry = sessionStore.get(sessionId);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({
            session_id: sessionId,
            turn_count: entry?.turnCount ?? 0,
            context: info ? {
              fill_percent: info.fillPercent,
              fill_percent_display: `${Math.round(info.fillPercent * 100)}%`,
              context_window: info.contextWindow,
              input_tokens: info.inputTokens,
              output_tokens: info.outputTokens,
              total_tokens: info.totalTokens,
              cost_usd: info.costUsd,
            } : null,
            needs_compaction: sessionStore.needsCompaction(sessionId),
          }));
        } else {
          // List all sessions
          const sessions = sessionStore.getAllSessions().map(({ conversationId, entry }) => ({
            session_id: conversationId,
            turn_count: entry.turnCount,
            last_used: entry.lastUsed,
            context: entry.contextUsage ? {
              fill_percent: entry.contextUsage.fillPercent,
              fill_percent_display: `${Math.round(entry.contextUsage.fillPercent * 100)}%`,
              context_window: entry.contextUsage.contextWindow,
              total_tokens: entry.contextUsage.totalTokens,
            } : null,
          }));
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ sessions }));
        }
        return;
      }

      // Manual compaction endpoint
      if (req.url?.startsWith("/v1/sessions/") && req.url.endsWith("/compact") && req.method === "POST") {
        const sessionId = req.url.slice("/v1/sessions/".length, -"/compact".length);
        const entry = sessionStore.get(sessionId);
        if (!entry) {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Session not found" }));
        } else {
          scheduleCompaction(sessionId, "Manual compaction requested by user.");
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ status: "compacted", session_id: sessionId }));
        }
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
  // Abort all active queries
  for (const [, controller] of activeQueries) {
    controller.abort();
  }
  activeQueries.clear();
  sessionStore.clear();

  return new Promise((resolve) => {
    server.close(() => resolve());
  });
}
