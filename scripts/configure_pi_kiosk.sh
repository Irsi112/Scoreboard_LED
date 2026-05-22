#!/usr/bin/env bash

set -euo pipefail

HOSTNAME_VALUE="kylltal-scoreboard"
LOCAL_DISPLAY_URL="http://127.0.0.1:3000/"
REMOTE_ADMIN_URL="http://${HOSTNAME_VALUE}.local:3000/admin.html"

find_project_root() {
  local candidate script_dir script_root

  script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  script_root="$(dirname "$script_dir")"

  if [[ -f "$script_root/backend/server.js" ]]; then
    printf '%s\n' "$script_root"
    return 0
  fi

  for candidate in "$(pwd)" "$HOME/Scoreboard_LED" "$HOME/scoreboard-led"; do
    if [[ -f "$candidate/backend/server.js" ]]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done

  candidate="$(find "$HOME" -maxdepth 6 -path '*/backend/server.js' | head -n 1 || true)"
  if [[ -n "$candidate" ]]; then
    dirname "$(dirname "$candidate")"
    return 0
  fi

  return 1
}

choose_browser_command() {
  if command -v chromium-browser >/dev/null 2>&1; then
    printf '%s\n' "chromium-browser"
    return 0
  fi

  if command -v chromium >/dev/null 2>&1; then
    printf '%s\n' "chromium"
    return 0
  fi

  if command -v epiphany-browser >/dev/null 2>&1; then
    printf '%s\n' "epiphany-browser"
    return 0
  fi

  return 1
}

install_browser() {
  if choose_browser_command >/dev/null 2>&1; then
    return 0
  fi

  if apt-cache show chromium-browser >/dev/null 2>&1; then
    sudo apt-get install -y chromium-browser
    return 0
  fi

  if apt-cache show chromium >/dev/null 2>&1; then
    sudo apt-get install -y chromium
    return 0
  fi

  sudo apt-get install -y epiphany-browser
}

write_kiosk_launcher() {
  local browser_command="$1"

  mkdir -p "$HOME/bin" "$HOME/.config/autostart"

  cat >"$HOME/bin/scoreboard-kiosk.sh" <<EOF
#!/usr/bin/env bash
set -euo pipefail

export XDG_RUNTIME_DIR="\${XDG_RUNTIME_DIR:-/run/user/\$(id -u)}"

LOG_PATH="$HOME/scoreboard-kiosk.log"
SERVER_URL="${LOCAL_DISPLAY_URL}"
BROWSER_URL="${LOCAL_DISPLAY_URL}"
BROWSER_COMMAND="${browser_command}"

touch "$LOG_PATH"
echo "[\$(date '+%Y-%m-%d %H:%M:%S')] Starting kiosk launcher with \${BROWSER_COMMAND}" >>"$LOG_PATH"

if command -v unclutter >/dev/null 2>&1; then
  pkill -x unclutter >/dev/null 2>&1 || true
  nohup unclutter -idle 0 -root >/dev/null 2>&1 &
fi

pkill -f 'chromium|epiphany-browser' >/dev/null 2>&1 || true

ready=0
for attempt in \$(seq 1 180); do
  if curl -fsS "$SERVER_URL" >/dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 2
done

if [[ "$ready" -ne 1 ]]; then
  echo "[\$(date '+%Y-%m-%d %H:%M:%S')] Backend not reachable at $SERVER_URL" >>"$LOG_PATH"
  exit 1
fi

echo "[\$(date '+%Y-%m-%d %H:%M:%S')] Backend reachable, launching browser" >>"$LOG_PATH"

if [[ "$BROWSER_COMMAND" == chromium* ]]; then
  exec "$BROWSER_COMMAND" \
    --kiosk \
    --app="$BROWSER_URL" \
    --start-fullscreen \
    --incognito \
    --noerrdialogs \
    --disable-infobars \
    --disable-session-crashed-bubble \
    --check-for-update-interval=31536000 \
    --overscroll-history-navigation=0 \
    --disable-features=TranslateUI
fi

exec "$BROWSER_COMMAND" "$BROWSER_URL"
EOF

  chmod +x "$HOME/bin/scoreboard-kiosk.sh"

  cat >"$HOME/.config/autostart/scoreboard-kiosk.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=Scoreboard Kiosk
Exec=$HOME/bin/scoreboard-kiosk.sh
Terminal=false
X-GNOME-Autostart-enabled=true
EOF
}

main() {
  local project_root browser_command

  project_root="$(find_project_root)"
  if [[ -z "$project_root" ]]; then
    echo "Unable to find the project root containing backend/server.js"
    exit 1
  fi

  echo "Using project root: $project_root"

  sudo apt-get update -y
  sudo apt-get install -y curl avahi-daemon unclutter
  install_browser
  browser_command="$(choose_browser_command)"

  sudo hostnamectl set-hostname "$HOSTNAME_VALUE"
  sudo systemctl enable --now avahi-daemon scoreboard.service

  if command -v raspi-config >/dev/null 2>&1; then
    sudo raspi-config nonint do_boot_behaviour B4 || true
  fi

  write_kiosk_launcher "$browser_command"

  echo
  echo "Kiosk autostart configured."
  echo "Local display URL: $LOCAL_DISPLAY_URL"
  echo "Admin URL on the same network: $REMOTE_ADMIN_URL"
  echo "Reboot the Pi once to verify the HDMI kiosk start."
}

main "$@"