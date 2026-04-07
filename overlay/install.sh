#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "Installing context overlay dependencies..."
cd "$SCRIPT_DIR"
npm install

# Extract Discord token from OpenClaw config
OPENCLAW_CONFIG="$HOME/.openclaw/openclaw.json"
if [ -f "$OPENCLAW_CONFIG" ]; then
  TOKEN=$(python3 -c "import json; d=json.load(open('$OPENCLAW_CONFIG')); print(d.get('channels',{}).get('discord',{}).get('token',''))" 2>/dev/null)
  if [ -n "$TOKEN" ]; then
    echo "Found Discord token in OpenClaw config."
  else
    echo "WARNING: No Discord token found in $OPENCLAW_CONFIG"
    echo "Set DISCORD_TOKEN environment variable manually."
  fi
fi

# Create systemd service
SERVICE_FILE="$HOME/.config/systemd/user/openclaw-context-overlay.service"
mkdir -p "$(dirname "$SERVICE_FILE")"

cat > "$SERVICE_FILE" << UNIT
[Unit]
Description=OpenClaw Context Overlay (Discord)
After=openclaw-gateway.service

[Service]
Type=simple
WorkingDirectory=$SCRIPT_DIR
Environment=DISCORD_TOKEN=$TOKEN
Environment=BRIDGE_URL=http://127.0.0.1:7779/v1
ExecStart=/usr/bin/node --import tsx discord-context-overlay.ts
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
UNIT

systemctl --user daemon-reload
echo ""
echo "Service created: $SERVICE_FILE"
echo ""
echo "To start:"
echo "  systemctl --user enable --now openclaw-context-overlay"
echo ""
echo "To check logs:"
echo "  journalctl --user -u openclaw-context-overlay -f"
