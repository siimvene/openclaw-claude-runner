# openclaw-claude-runner

OpenClaw extension that routes LLM requests through [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) instead of API calls.

Instead of paying per-token via the Anthropic API, this spawns the `claude` CLI binary as a subprocess — giving you full agentic capabilities (tool use, file editing, multi-step reasoning, MCP servers, memory) at Anthropic Max plan flat-rate pricing.

## How it works

```
Discord/HTTP → OpenClaw Gateway → claude-runner provider
  → bridge server (OpenAI-compat on localhost:7779)
    → spawn `claude -p "..." --output-format stream-json`
      → NDJSON → SSE translation → back to OpenClaw
```

The extension registers as an OpenClaw LLM provider. When the gateway sends a chat completion request, the bridge spawns `claude` CLI, parses its streaming NDJSON output, and translates it back into OpenAI-compatible SSE chunks.

## Prerequisites

- [OpenClaw](https://github.com/openclaw/openclaw) installed and running
- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) installed (`npm i -g @anthropic-ai/claude-code`)
- Anthropic Max subscription (required for `--dangerously-skip-permissions` in headless mode)

## Install

```bash
git clone https://github.com/siimvene/openclaw-claude-runner.git
cd openclaw-claude-runner
bash install.sh
```

This copies the extension to `~/.openclaw/extensions/claude-runner/`.

## Setup

### 1. Authenticate Claude Code CLI

```bash
claude login
```

This is interactive — it opens a browser for OAuth. On a remote server, use the URL it prints.

Verify:
```bash
claude -p "say hello" --output-format stream-json --verbose --dangerously-skip-permissions --max-turns 1
```

### 2. Configure the extension

Edit `~/.openclaw/extensions/claude-runner/config.json`:

```json
{
  "claudeBin": "claude",
  "port": 7779,
  "skipPermissions": true,
  "maxTurns": 30,
  "defaultModel": "claude-opus-4-5",
  "workDir": "~/.openclaw/workspace"
}
```

| Option | Default | Description |
|---|---|---|
| `claudeBin` | `"claude"` | Path to claude binary. Use full path if not in PATH (e.g., `/home/user/.npm-global/bin/claude`) |
| `port` | `7779` | Port for the local bridge server |
| `skipPermissions` | `true` | Use `--dangerously-skip-permissions` flag (requires Max plan) |
| `maxTurns` | `30` | Max agentic turns per request (safety cap to prevent runaway loops) |
| `defaultModel` | `"claude-opus-4-5"` | Default model when none specified |
| `workDir` | `"~/.openclaw/workspace"` | Working directory for claude CLI |

### 3. Enable in OpenClaw config

Add to `~/.openclaw/openclaw.json`:

```jsonc
{
  // Enable the plugin
  "plugins": {
    "entries": {
      "claude-runner": { "enabled": true }
    }
  },

  // Register the provider
  "models": {
    "providers": {
      "claude-runner": {
        "baseUrl": "http://127.0.0.1:7779/v1",
        "api": "openai-completions",
        "apiKey": "claude-runner-local",
        "authHeader": false,
        "models": [
          { "id": "claude-opus-4-5", "name": "Claude Opus 4.5 (CLI)", "contextWindow": 200000, "maxTokens": 16384 },
          { "id": "claude-sonnet-4-6", "name": "Claude Sonnet 4.6 (CLI)", "contextWindow": 200000, "maxTokens": 16384 },
          { "id": "claude-sonnet-4", "name": "Claude Sonnet 4 (CLI)", "contextWindow": 200000, "maxTokens": 8192 },
          { "id": "claude-haiku-4-5", "name": "Claude Haiku 4.5 (CLI)", "contextWindow": 200000, "maxTokens": 8192 }
        ]
      }
    }
  },

  // Set as default (optional)
  "agents": {
    "defaults": {
      "model": {
        "primary": "claude-runner/claude-opus-4-5",
        "fallbacks": ["anthropic/claude-opus-4-5"]
      }
    }
  }
}
```

### 4. Restart gateway

```bash
openclaw gateway restart
```

## Available models

| Model ID | Description |
|---|---|
| `claude-runner/claude-opus-4-5` | Claude Opus 4.5 via CLI |
| `claude-runner/claude-sonnet-4-6` | Claude Sonnet 4.6 via CLI |
| `claude-runner/claude-sonnet-4` | Claude Sonnet 4 via CLI |
| `claude-runner/claude-haiku-4-5` | Claude Haiku 4.5 via CLI |

## Why use this instead of the Anthropic API directly?

| | API (per-token) | CLI (this extension) |
|---|---|---|
| **Billing** | Pay per token | Max plan flat rate |
| **Capabilities** | Chat completions only | Full Claude Code: tool use, file editing, MCP, memory |
| **Reasoning** | Single-turn | Multi-step agentic loops |
| **Tool handling** | Build your own | Delegated to CLI |

## Updating

Pull the latest version and re-run install:

```bash
cd openclaw-claude-runner
git pull
bash install.sh
```

Your `config.json` is preserved across updates.

## Troubleshooting

**Gateway crashes with "Unrecognized keys" error**

The `plugins.entries.claude-runner` section in `openclaw.json` must only contain `{ "enabled": true }`. All extension settings go in the extension's own `config.json`, not in `openclaw.json`.

**"Invalid API key" or "Please run /login"**

Claude CLI is not authenticated. Run `claude login` on the server.

**Bridge not responding**

Check if the bridge is running: `curl http://127.0.0.1:7779/health`

If not, check gateway logs: `journalctl --user -u openclaw-gateway -n 50`

**Claude binary not found**

Set the full path in `config.json`: `"claudeBin": "/home/user/.npm-global/bin/claude"`

## License

MIT
