#!/usr/bin/env bash
# Deploy the telemetry collector to paperclip.mplace.co.za
# Run from this directory.
set -euo pipefail

REMOTE_USER="${REMOTE_USER:-isak}"
REMOTE_HOST="${REMOTE_HOST:-paperclip.mplace.co.za}"
REMOTE_DIR="${REMOTE_DIR:-/home/isak/telemetry-collector}"
SSH_KEY="${SSH_KEY:-$HOME/.ssh/isak_vps}"

echo "Deploying to $REMOTE_USER@$REMOTE_HOST:$REMOTE_DIR"

ssh -i "$SSH_KEY" "$REMOTE_USER@$REMOTE_HOST" "mkdir -p $REMOTE_DIR"
scp -i "$SSH_KEY" server.js package.json "$REMOTE_USER@$REMOTE_HOST:$REMOTE_DIR/"

# Create systemd unit
ssh -i "$SSH_KEY" "$REMOTE_USER@$REMOTE_HOST" "
cat > /tmp/telemetry-collector.service << 'EOF'
[Unit]
Description=powershell-mcp telemetry collector
After=network.target

[Service]
Type=simple
User=$REMOTE_USER
WorkingDirectory=$REMOTE_DIR
ExecStart=/usr/bin/node $REMOTE_DIR/server.js
Restart=always
RestartSec=5
Environment=PORT=4242
Environment=TELEMETRY_FILE=$REMOTE_DIR/telemetry.jsonl

[Install]
WantedBy=multi-user.target
EOF
sudo mv /tmp/telemetry-collector.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now telemetry-collector
sudo systemctl status telemetry-collector --no-pager
"

echo ""
echo "Add nginx proxy: copy nginx-telemetry.conf block into the paperclip.mplace.co.za server block,"
echo "then: sudo nginx -t && sudo systemctl reload nginx"
echo ""
echo "Test: curl -X POST https://paperclip.mplace.co.za/api/telemetry -H 'Content-Type: application/json' -d '{\"event\":\"test\",\"version\":\"0.0.0\",\"hostId\":\"test\",\"os\":\"linux\",\"ts\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\"}'"
