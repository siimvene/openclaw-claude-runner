#!/bin/bash
set -e

EXT_DIR="${OPENCLAW_EXTENSIONS:-$HOME/.openclaw/extensions}/claude-runner"

echo "Installing openclaw-claude-runner to $EXT_DIR ..."
mkdir -p "$EXT_DIR/src"

cp index.ts "$EXT_DIR/"
cp src/claude-bridge.ts "$EXT_DIR/src/"
cp openclaw.plugin.json "$EXT_DIR/"
cp package.json "$EXT_DIR/"

# Create config.json from example if it doesn't exist
if [ ! -f "$EXT_DIR/config.json" ]; then
  cp config.example.json "$EXT_DIR/config.json"
  echo "Created default config at $EXT_DIR/config.json"
else
  echo "Existing config.json preserved at $EXT_DIR/config.json"
fi

# Detect claude binary path
CLAUDE_BIN=$(which claude 2>/dev/null || echo "")
if [ -z "$CLAUDE_BIN" ]; then
  echo ""
  echo "WARNING: 'claude' not found in PATH."
  echo "Install it: npm i -g @anthropic-ai/claude-code"
  echo "Then set the full path in $EXT_DIR/config.json"
else
  echo "Found claude at: $CLAUDE_BIN"
fi

# Configure OpenClaw via CLI
echo ""
echo "Configuring OpenClaw..."

# Enable the plugin
openclaw plugins enable claude-runner 2>/dev/null && echo "Plugin enabled." || \
  npx openclaw plugins enable claude-runner 2>/dev/null && echo "Plugin enabled." || \
  echo "Could not auto-enable plugin. Run: openclaw plugins enable claude-runner"

# Register the provider
openclaw config set models.providers.claude-runner.baseUrl "http://127.0.0.1:7779/v1" 2>/dev/null || \
  npx openclaw config set models.providers.claude-runner.baseUrl "http://127.0.0.1:7779/v1" 2>/dev/null || true
openclaw config set models.providers.claude-runner.api "openai-completions" 2>/dev/null || \
  npx openclaw config set models.providers.claude-runner.api "openai-completions" 2>/dev/null || true
openclaw config set models.providers.claude-runner.apiKey "claude-runner-local" 2>/dev/null || \
  npx openclaw config set models.providers.claude-runner.apiKey "claude-runner-local" 2>/dev/null || true
openclaw config set models.providers.claude-runner.authHeader false 2>/dev/null || \
  npx openclaw config set models.providers.claude-runner.authHeader false 2>/dev/null || true

echo "Provider configured."

# Create auth profile for the main agent so OpenClaw doesn't complain about missing API key
AUTH_DIR="$HOME/.openclaw/agents/main/agent"
AUTH_FILE="$AUTH_DIR/auth-profiles.json"
if [ -f "$AUTH_FILE" ]; then
  # Add claude-runner profile if not already present
  if ! grep -q "claude-runner:default" "$AUTH_FILE" 2>/dev/null; then
    python3 -c "
import json, sys
with open('$AUTH_FILE') as f: d = json.load(f)
d['claude-runner:default'] = {'type': 'api_key', 'provider': 'claude-runner', 'key': 'claude-runner-local'}
with open('$AUTH_FILE', 'w') as f: json.dump(d, f, indent=2)
print('Added claude-runner auth profile to', '$AUTH_FILE')
" 2>/dev/null || echo "Could not auto-add auth profile. See README troubleshooting."
  fi
else
  mkdir -p "$AUTH_DIR"
  echo '{"claude-runner:default":{"type":"api_key","provider":"claude-runner","key":"claude-runner-local"}}' > "$AUTH_FILE"
  echo "Created auth profile at $AUTH_FILE"
fi

echo ""
echo "Done! Remaining steps:"
echo ""
echo "  1. Authenticate Claude Code CLI (if not already done):"
echo "     claude login"
echo ""
echo "  2. Restart OpenClaw gateway:"
echo "     openclaw gateway restart"
echo ""
if [ -z "$CLAUDE_BIN" ]; then
  echo "  3. Set claude binary path in $EXT_DIR/config.json"
  echo ""
fi
