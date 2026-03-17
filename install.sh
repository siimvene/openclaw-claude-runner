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
  echo ""
  echo "Created default config at $EXT_DIR/config.json"
  echo "Edit it to set your claude binary path and other options."
else
  echo ""
  echo "Existing config.json preserved at $EXT_DIR/config.json"
fi

echo ""
echo "Done! Now:"
echo ""
echo "  1. Authenticate Claude Code CLI (if not already done):"
echo "     claude login"
echo ""
echo "  2. Enable the plugin in ~/.openclaw/openclaw.json:"
echo '     "plugins": { "entries": { "claude-runner": { "enabled": true } } }'
echo ""
echo "  3. Add the provider and set as default model in ~/.openclaw/openclaw.json:"
echo '     "models": { "providers": { "claude-runner": {'
echo '       "baseUrl": "http://127.0.0.1:7779/v1",'
echo '       "api": "openai-completions",'
echo '       "apiKey": "claude-runner-local",'
echo '       "authHeader": false,'
echo '       "models": [{"id":"claude-opus-4-5"},{"id":"claude-sonnet-4-6"},{"id":"claude-sonnet-4"},{"id":"claude-haiku-4-5"}]'
echo '     }}}'
echo ""
echo "  4. Restart OpenClaw gateway:"
echo "     openclaw gateway restart"
