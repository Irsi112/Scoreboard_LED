#!/usr/bin/env bash
# install_on_pi.sh
# This script is intended to run on the Raspberry Pi via ssh.
# It installs a Node runtime compatible with the Pi, installs backend deps,
# enables a systemd service for backend/server.js and configures kiosk startup.

set -euo pipefail

find_project_root() {
  local candidate script_dir script_root

  script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  script_root="$(dirname "$script_dir")"

  if [ -f "$script_root/backend/server.js" ]; then
    printf '%s\n' "$script_root"
    return 0
  fi

  for candidate in "$(pwd)" "$HOME/Scoreboard_LED" "$HOME/scoreboard-led"; do
    if [ -f "$candidate/backend/server.js" ]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done

  candidate="$(find "$HOME" -maxdepth 6 -path '*/backend/server.js' | head -n 1 || true)"
  if [ -n "$candidate" ]; then
    dirname "$(dirname "$candidate")"
    return 0
  fi

  return 1
}

install_node_runtime() {
  local arch current_node_major

  arch="$(uname -m)"

  if command -v node >/dev/null 2>&1 && node -v >/dev/null 2>&1; then
    echo "Node.js already works: $(node -v)"
    return 0
  fi

  echo "Installing a Node.js runtime compatible with ${arch}..."

  if [ "$arch" = "armv6l" ]; then
    # NodeSource packages crash on Pi Zero / ARMv6. Use the Raspberry Pi OS package instead.
    sudo rm -f /etc/apt/sources.list.d/nodesource.list /etc/apt/sources.list.d/nodesource*.list
    sudo apt-get purge -y nodejs libnode-dev libnode108 libnode* >/dev/null 2>&1 || true
    sudo apt-get autoremove -y >/dev/null 2>&1 || true
    sudo apt-get update -y
    sudo apt-get install -y nodejs npm
  else
    current_node_major="0"
    if command -v node >/dev/null 2>&1 && node -v >/dev/null 2>&1; then
      current_node_major="$(node -p "process.versions.node.split('.')[0]")"
    fi

    if [ "$current_node_major" -lt 18 ]; then
      curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
      sudo apt-get install -y nodejs
    fi
  fi

  echo "Using Node.js: $(node -v)"
  if command -v npm >/dev/null 2>&1; then
    echo "Using npm: $(npm -v)"
  fi
}

install_backend_dependencies() {
  local arch

  arch="$(uname -m)"

  if [ "$arch" = "armv6l" ]; then
    echo "Installing backend dependencies from Raspberry Pi OS packages..."
    sudo apt-get install -y node-express node-axios node-cheerio
    return 0
  fi

  if [ -f "${PROJECT_ROOT}/backend/package.json" ]; then
    echo "Installing backend npm dependencies..."
    (cd "${PROJECT_ROOT}/backend" && npm install --omit=dev)
    return 0
  fi

  echo "Missing backend/package.json; cannot install backend dependencies."
  exit 1
}

write_backend_service() {
  local service_path

  service_path="/etc/systemd/system/scoreboard.service"

  sudo tee "$service_path" >/dev/null <<EOF
[Unit]
Description=Scoreboard LED backend
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$(whoami)
WorkingDirectory=${PROJECT_ROOT}/backend
ExecStart=/usr/bin/node ${PROJECT_ROOT}/backend/server.js
Restart=always
RestartSec=5
Environment=NODE_ENV=production
Environment=PORT=3000

[Install]
WantedBy=multi-user.target
EOF

  sudo systemctl daemon-reload
  sudo systemctl enable --now scoreboard.service
}

write_kiosk_files() {
  local user_id

  user_id="$(id -u)"

  mkdir -p "$HOME/bin" "$HOME/.config/autostart"

  cat >"$HOME/bin/scoreboard-kiosk.sh" <<EOF
#!/bin/sh
export XDG_RUNTIME_DIR=/run/user/${user_id}
export DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/${user_id}/bus
WAYLAND_SOCKET=\$(ls /run/user/${user_id}/wayland-* 2>/dev/null | head -n 1)
if [ -n "\$WAYLAND_SOCKET" ]; then
  export WAYLAND_DISPLAY=\$(basename "\$WAYLAND_SOCKET")
fi
export GTK_A11Y=none
export LIBGL_ALWAYS_SOFTWARE=1
export GSK_RENDERER=cairo
unset DISPLAY
unset XAUTHORITY
unset GDK_BACKEND

LOG_PATH="$HOME/scoreboard-kiosk.log"
SERVER_URL="http://127.0.0.1:3000/"
BROWSER_URL="http://localhost:3000"

gsettings set org.gnome.Epiphany ask-for-default false >/dev/null 2>&1 || true
gsettings set org.gnome.Epiphany restore-session-policy 'crashed' >/dev/null 2>&1 || true
gsettings set org.gnome.Epiphany homepage-url "\$BROWSER_URL" >/dev/null 2>&1 || true
rm -rf "$HOME/.local/share/epiphany/sessions" "$HOME/.config/epiphany" >/dev/null 2>&1 || true

pkill -f '^epiphany ' >/dev/null 2>&1 || true
pkill -f 'WebKit(Web|Network)Process' >/dev/null 2>&1 || true

echo "[$(date '+%Y-%m-%d %H:%M:%S')] Waiting for scoreboard backend..." >>"$LOG_PATH"
ready=0
for attempt in \$(seq 1 180); do
  if curl -fsS "$SERVER_URL" >/dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 2
done

if [ "$ready" -ne 1 ]; then
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] Backend not reachable, browser start skipped." >>"$LOG_PATH"
  exit 1
fi

echo "[$(date '+%Y-%m-%d %H:%M:%S')] Backend ready, starting kiosk browser." >>"$LOG_PATH"
nohup /usr/bin/epiphany-browser "\$BROWSER_URL" >"$HOME/scoreboard-epiphany.log" 2>&1 &
EOF

  chmod +x "$HOME/bin/scoreboard-kiosk.sh"

  rm -f "$HOME/.config/autostart/scoreboard-kiosk.desktop"
  cat >"$HOME/.config/autostart/scoreboard-kiosk.desktop.disabled" <<EOF
[Desktop Entry]
Type=Application
Name=Scoreboard Kiosk Disabled
Exec=$HOME/bin/scoreboard-kiosk.sh
Terminal=false
X-GNOME-Autostart-enabled=false
NoDisplay=true
EOF
}

echo "Updating apt and installing prerequisites..."
sudo apt-get update -y
sudo apt-get install -y ca-certificates curl epiphany-browser

PROJECT_ROOT="$(find_project_root)"

if [ -z "$PROJECT_ROOT" ]; then
  echo "Unable to find the project root containing backend/server.js"
  exit 1
fi

echo "Using project root: ${PROJECT_ROOT}"

install_node_runtime

mkdir -p "${PROJECT_ROOT}/backend/data"
sudo chown -R "$(whoami):$(whoami)" "${PROJECT_ROOT}"

install_backend_dependencies

write_backend_service
write_kiosk_files

echo "Installation complete."
echo "Backend status: sudo systemctl status scoreboard.service"
echo "Backend logs: sudo journalctl -u scoreboard.service -f"
echo "Browser autostart is disabled. Open http://<pi-ip>:3000 from another device to view the scoreboard."
