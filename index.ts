/**
 * OpenClaw Claude Runner Extension
 *
 * Registers "claude-runner" as an LLM provider that spawns Claude Code CLI
 * as a subprocess. All intelligence is delegated to the CLI — tool use,
 * file editing, multi-step reasoning, MCP servers, memory.
 *
 * Architecture:
 *   OpenClaw Gateway → provider: "claude-runner"
 *     → embedded bridge server (OpenAI-compat on localhost)
 *       → spawn `claude -p ... --output-format stream-json`
 *         → NDJSON → SSE translation → back to OpenClaw
 */

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  OpenClawPluginApi,
  ProviderAuthContext,
  ProviderAuthResult,
  ProviderDiscoveryContext,
} from "openclaw/plugin-sdk/core";
import { startBridgeServer, stopBridgeServer } from "./src/claude-bridge.js";

const PROVIDER_ID = "claude-runner";
const DEFAULT_PORT = 7779;
const DEFAULT_CLAUDE_BIN = "claude";
const DEFAULT_WORK_DIR = "~/.openclaw/workspace";

// Load config from extension's own config.json (not openclaw.json)
function loadExtensionConfig(): Record<string, unknown> {
  try {
    const extDir = dirname(fileURLToPath(import.meta.url));
    const raw = readFileSync(join(extDir, "config.json"), "utf-8");
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

const MODELS = [
  {
    id: "claude-opus-4-5",
    name: "Claude Opus 4.5 (CLI)",
    reasoning: true,
    input: ["text", "image"] as Array<"text" | "image">,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, // Max plan = flat rate
    contextWindow: 200_000,
    maxTokens: 16_384,
  },
  {
    id: "claude-sonnet-4-6",
    name: "Claude Sonnet 4.6 (CLI)",
    reasoning: true,
    input: ["text", "image"] as Array<"text" | "image">,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200_000,
    maxTokens: 16_384,
  },
  {
    id: "claude-sonnet-4",
    name: "Claude Sonnet 4 (CLI)",
    reasoning: false,
    input: ["text", "image"] as Array<"text" | "image">,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200_000,
    maxTokens: 8_192,
  },
  {
    id: "claude-haiku-4-5",
    name: "Claude Haiku 4.5 (CLI)",
    reasoning: false,
    input: ["text"] as Array<"text" | "image">,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200_000,
    maxTokens: 8_192,
  },
];

let bridgeServer: Awaited<ReturnType<typeof startBridgeServer>> | null = null;

const claudeRunnerPlugin = {
  id: PROVIDER_ID,
  name: "Claude Code Runner",
  description: "Spawns Claude Code CLI locally — full agentic capabilities via Max plan",

  register(api: OpenClawPluginApi) {
    const extConfig = loadExtensionConfig();
    const claudeBin = (extConfig.claudeBin as string) ?? DEFAULT_CLAUDE_BIN;
    const port = (extConfig.port as number) ?? DEFAULT_PORT;
    const skipPermissions = (extConfig.skipPermissions as boolean) ?? true;
    const defaultModel = (extConfig.defaultModel as string) ?? "claude-opus-4-5";
    const maxTurns = (extConfig.maxTurns as number) ?? 30;

    // Register the bridge as a background service
    api.registerService({
      id: "claude-runner-bridge",
      start: async (ctx) => {
        const workDir = ctx.workspaceDir ?? DEFAULT_WORK_DIR;
        bridgeServer = await startBridgeServer({ port, claudeBin, skipPermissions, workDir, maxTurns });
        ctx.logger.info(`Claude Runner bridge listening on 127.0.0.1:${port}`);
      },
      stop: async (ctx) => {
        if (bridgeServer) {
          await stopBridgeServer(bridgeServer);
          bridgeServer = null;
          ctx.logger.info("Claude Runner bridge stopped");
        }
      },
    });

    // Register as a provider
    api.registerProvider({
      id: PROVIDER_ID,
      label: "Claude Code CLI",
      docsPath: "/providers/models",
      auth: [
        {
          id: "local",
          label: "Local Claude CLI",
          hint: "Uses locally installed Claude Code CLI binary (requires Max plan)",
          kind: "custom",
          run: async (ctx: ProviderAuthContext): Promise<ProviderAuthResult> => {
            const binPath = await ctx.prompter.text({
              message: "Path to claude binary",
              initialValue: claudeBin,
              validate: (v: string) => (v.trim() ? undefined : "Path is required"),
            });

            const bridgePort = await ctx.prompter.text({
              message: "Bridge server port",
              initialValue: String(port),
              validate: (v: string) => {
                const n = parseInt(v, 10);
                return n > 0 && n < 65536 ? undefined : "Enter a valid port";
              },
            });

            const baseUrl = `http://127.0.0.1:${bridgePort}/v1`;

            return {
              profiles: [
                {
                  profileId: "claude-runner:default",
                  credential: {
                    type: "api_key",
                    provider: PROVIDER_ID,
                    key: "claude-runner-local",
                  },
                },
              ],
              configPatch: {
                models: {
                  providers: {
                    [PROVIDER_ID]: {
                      baseUrl,
                      apiKey: "claude-runner-local",
                      api: "openai-completions",
                      authHeader: false,
                      models: MODELS.map((m) => ({ ...m, api: "openai-completions" as const })),
                    },
                  },
                },
                agents: {
                  defaults: {
                    models: Object.fromEntries(
                      MODELS.map((m) => [`${PROVIDER_ID}/${m.id}`, {}]),
                    ),
                  },
                },
                plugins: {
                  entries: {
                    "claude-runner": {
                      enabled: true,
                    },
                  },
                },
              },
              defaultModel: `${PROVIDER_ID}/${defaultModel}`,
              notes: [
                "Claude Code CLI must be installed (npm i -g @anthropic-ai/claude-code).",
                "Requires an active Anthropic Max subscription for --dangerously-skip-permissions.",
                "All reasoning, tool use, and file editing is handled by the CLI — zero cost per token on Max plan.",
              ],
            };
          },
        },
      ],
      discovery: {
        order: "late",
        run: async (ctx: ProviderDiscoveryContext) => {
          const explicit = ctx.config.models?.providers?.[PROVIDER_ID];
          if (explicit && Array.isArray(explicit.models) && explicit.models.length > 0) {
            return {
              provider: {
                ...explicit,
                baseUrl: explicit.baseUrl ?? `http://127.0.0.1:${port}/v1`,
                api: explicit.api ?? ("openai-completions" as const),
                apiKey: explicit.apiKey ?? "claude-runner-local",
                authHeader: false,
              },
            };
          }

          // Auto-discover if plugin is enabled but provider not yet configured
          const pluginEnabled = ctx.config.plugins?.entries?.["claude-runner"];
          if (pluginEnabled) {
            return {
              provider: {
                baseUrl: `http://127.0.0.1:${port}/v1`,
                api: "openai-completions" as const,
                apiKey: "claude-runner-local",
                authHeader: false,
                models: MODELS.map((m) => ({ ...m, api: "openai-completions" as const })),
              },
            };
          }

          return null;
        },
      },
      wizard: {
        onboarding: {
          choiceId: "claude-runner",
          choiceLabel: "Claude Code CLI",
          choiceHint: "Full agentic Claude via local CLI (Max plan)",
          groupId: "claude-runner",
          groupLabel: "Claude Code CLI",
          groupHint: "Spawn Claude Code CLI for full tool use and file editing",
          methodId: "local",
        },
        modelPicker: {
          label: "Claude Code CLI",
          hint: "Use Claude Code CLI for full agentic capabilities",
          methodId: "local",
        },
      },
    });
  },
};

export default claudeRunnerPlugin;
