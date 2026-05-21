#!/usr/bin/env bash
# deploy_to_pi.sh
# Usage: ./deploy_to_pi.sh <pi_user>@<pi_host> [remote_dir]
# Example: ./deploy_to_pi.sh pi@192.168.178.68 ~/Scoreboard_LED

set -euo pipefail

if [ "$#" -lt 1 ]; then
  echo "Usage: $0 <pi_user>@<pi_host> [remote_dir]"
  exit 2
fi

REMOTE="$1"
REMOTE_DIR="${2:-~/Scoreboard_LED}"

# Local project root (script location assumed in repo root or run from repo root)
PROJECT_ROOT="$(pwd)"
SCRIPTS_DIR="${PROJECT_ROOT}/scripts"

echo "Deploying project from: ${PROJECT_ROOT} to ${REMOTE}:${REMOTE_DIR}"

# Check for rsync; prefer rsync for efficiency
if command -v rsync >/dev/null 2>&1; then
  RSYNC_CMD=(rsync -avz --delete --exclude ".git" --exclude "node_modules" -e "ssh -o StrictHostKeyChecking=no" "${PROJECT_ROOT}/" "${REMOTE}:${REMOTE_DIR}/")
  echo "Using rsync to copy files..."
  "${RSYNC_CMD[@]}"
else
  echo "rsync not found — falling back to scp (slower)."
  scp -r "${PROJECT_ROOT}" "${REMOTE}:${REMOTE_DIR}"
fi

# Copy installer script to remote and run it
echo "Copying installer to remote..."
scp -o StrictHostKeyChecking=no "${SCRIPTS_DIR}/install_on_pi.sh" "${REMOTE}:${REMOTE_DIR}/install_on_pi.sh"

echo "Running remote installer (will prompt for sudo on the Pi)..."
ssh -o StrictHostKeyChecking=no "${REMOTE}" "bash ${REMOTE_DIR}/install_on_pi.sh"

echo "Deployment finished. The backend should be running (pm2 or systemd)."

echo "To view logs on the Pi: ssh ${REMOTE} 'pm2 logs' or 'journalctl -u scoreboard.service -f' if systemd used.'"
