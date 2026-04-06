# openclaw-claude-runner

OpenClaw extension that routes LLM requests through the [Claude Agent SDK](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk) instead of API calls.

Instead of paying per-token via the Anthropic API, this uses the Agent SDK with your Max plan subscription — giving you full agentic capabilities (tool use, file editing, multi-step reasoning, MCP servers, memory) at flat-rate pricing.

## How it works

```
Request → OpenClaw Gateway → claude-runner provider
  → bridge server (OpenAI-compat on localhost:7779)
    → SDK query() with streaming
      → SDKMessage stream → SSE translation → back to OpenClaw
```

The extension registers as an OpenClaw LLM provider. When the gateway sends a chat completion request, the bridge invokes the Claude Agent SDK's `query()` function and translates the streaming messages back into OpenAI-compatible SSE chunks.

## Prerequisites

- [OpenClaw](https://github.com/openclaw/openclaw) installed and running
- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) installed and authenticated (`claude login`)
- Anthropic Max subscription

## Install

```bash
git clone https://github.com/siimvene/openclaw-claude-runner.git
cd openclaw-claude-runner
bash install.sh
```

The install script:
- Copies the extension to `~/.openclaw/extensions/claude-runner/`
- Runs `npm install` for the Agent SDK dependency
- Enables the plugin via `openclaw plugins enable`
- Registers the provider via `openclaw config set`
- Creates a default `config.json` if one doesn't exist

After install:

```bash
# 1. Authenticate Claude Code CLI (if not already done)
claude login

# 2. Restart the gateway to pick up the extension
openclaw gateway restart
```

## Configuration

Extension settings are in `~/.openclaw/extensions/claude-runner/config.json`:

| Option | Default | Description |
|---|---|---|
| `port` | `7779` | Port for the local bridge server |
| `skipPermissions` | `true` | Use `bypassPermissions` mode |
| `maxTurns` | `30` | Max agentic turns per request |
| `defaultModel` | `"claude-opus-4-6"` | Default model when none specified |
| `workDir` | `"~/.openclaw/workspace"` | Working directory for the SDK |
| `queueMinDelayMs` | `1000` | Min delay between SDK queries (ms) |
| `queueMaxDelayMs` | `4000` | Max delay between SDK queries (ms) |
| `queueMaxConcurrency` | `1` | Max concurrent SDK queries |
| `sessionTtlMs` | `3600000` | Session cache TTL (ms) |
| `effort` | `"medium"` | Effort level: low, medium, high, max |
| `maxBudgetUsd` | — | Cost cap per request (optional) |
| `tools` | — | Restrict available tools (optional) |

To set as default model (optional):

```bash
openclaw config set agents.defaults.model.primary "claude-runner/claude-opus-4-6"
openclaw config set agents.defaults.model.fallbacks '["anthropic/claude-opus-4-5"]'
```

## Available models

| Model ID | Description |
|---|---|
| `claude-runner/claude-opus-4-6` | Claude Opus 4.6 via SDK |
| `claude-runner/claude-opus-4-5` | Claude Opus 4.5 via SDK |
| `claude-runner/claude-sonnet-4-6` | Claude Sonnet 4.6 via SDK |
| `claude-runner/claude-sonnet-4` | Claude Sonnet 4 via SDK |
| `claude-runner/claude-haiku-4-5` | Claude Haiku 4.5 via SDK |

## Why use this instead of the Anthropic API directly?

| | API (per-token) | SDK (this extension) |
|---|---|---|
| **Billing** | Pay per token | Max plan flat rate |
| **Capabilities** | Chat completions only | Full Claude Code: tool use, file editing, MCP, memory |
| **Reasoning** | Single-turn | Multi-step agentic loops |
| **Tool handling** | Build your own | Delegated to SDK |

## Troubleshooting

**"Invalid API key" or "Please run /login"**

Claude CLI is not authenticated. Run `claude login` on the server.

**Bridge not responding**

Check if the bridge is running: `curl http://127.0.0.1:7779/health`

If not, check gateway logs: `journalctl --user -u openclaw-gateway -n 50`

## License

MIT
