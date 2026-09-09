#!/usr/bin/env bash
set -euo pipefail

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

mkdir -p "$HOME/bin" "$HOME/.config/autostart"

browser_command="$(choose_browser_command)"
if [[ -z "$browser_command" ]]; then
  echo "No browser command found. Install chromium-browser or chromium first." >&2
  exit 1
fi

cat >"$HOME/bin/scoreboard-kiosk.sh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

user_id="$(id -u)"
export XDG_RUNTIME_DIR="/run/user/$user_id"
export DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$user_id/bus"
export XDG_SESSION_TYPE=wayland
export GDK_BACKEND=wayland
WAYLAND_SOCKET=""
for attempt in $(seq 1 30); do
  WAYLAND_SOCKET=$(ls /run/user/$user_id/wayland-* 2>/dev/null | head -n 1 || true)
  if [[ -n "${WAYLAND_SOCKET:-}" ]]; then
    break
  fi
  sleep 1
done
if [[ -n "${WAYLAND_SOCKET:-}" ]]; then
  export WAYLAND_DISPLAY="$(basename "$WAYLAND_SOCKET")"
else
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] Wayland socket not found after wait" >>"$HOME/scoreboard-kiosk.log"
fi
export GTK_A11Y=none
export LIBGL_ALWAYS_SOFTWARE=1
export GSK_RENDERER=cairo
unset DISPLAY
unset XAUTHORITY

LOG_PATH="$HOME/scoreboard-kiosk.log"
SERVER_URL="http://127.0.0.1:3000/"
BROWSER_URL="http://localhost:3000"
BROWSER_COMMAND="__SCOREBOARD_BROWSER_COMMAND__"

echo "[$(date '+%Y-%m-%d %H:%M:%S')] Waiting for scoreboard backend..." >>"$LOG_PATH"
ready=0
for attempt in $(seq 1 180); do
  if curl -fsS "$SERVER_URL" >/dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 2
done

if [[ "$ready" -ne 1 ]]; then
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] Backend not reachable, browser start skipped." >>"$LOG_PATH"
  exit 1
fi

echo "[$(date '+%Y-%m-%d %H:%M:%S')] Backend ready, starting kiosk browser." >>"$LOG_PATH"

if [[ "$BROWSER_COMMAND" == chromium* ]]; then
  exec "$BROWSER_COMMAND" \
    --ozone-platform=wayland \
    --no-sandbox \
    --no-memcheck \
    --enable-low-end-device-mode \
    --disable-gpu \
    --disable-gpu-compositing \
    --disable-software-rasterizer \
    --disable-gpu-sandbox \
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
else
  exec "$BROWSER_COMMAND" "$BROWSER_URL"
fi
EOF

sed -i "s|__SCOREBOARD_BROWSER_COMMAND__|${browser_command}|g" "$HOME/bin/scoreboard-kiosk.sh"
chmod +x "$HOME/bin/scoreboard-kiosk.sh"

cat >"$HOME/.config/autostart/scoreboard-kiosk.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=Scoreboard Kiosk
Exec=$HOME/bin/scoreboard-kiosk.sh
Terminal=false
X-GNOME-Autostart-enabled=true
NoDisplay=false
EOF

echo "Recreated kiosk launcher at $HOME/bin/scoreboard-kiosk.sh"
echo "Autostart entry written to $HOME/.config/autostart/scoreboard-kiosk.desktop"
