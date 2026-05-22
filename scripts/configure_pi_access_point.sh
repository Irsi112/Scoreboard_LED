#!/usr/bin/env bash

set -euo pipefail

AP_NAME="kylltalAnzeigetafel"
AP_PASSWORD='Gemein$chaftMacht$tark2013'
AP_ADDRESS="10.42.0.1/24"
AP_ADMIN_URL="http://10.42.0.1:3000/admin.html"
HOSTNAME_VALUE="kylltal-scoreboard"
WIFI_DEVICE="wlan0"
ACTIVATE_NOW=0

if [[ "${1:-}" == "--activate-now" ]]; then
  ACTIVATE_NOW=1
fi

disable_other_wifi_autoconnect() {
  while IFS=: read -r connection_name connection_type; do
    if [[ "$connection_type" != "802-11-wireless" ]]; then
      continue
    fi

    if [[ "$connection_name" == "$AP_NAME" ]]; then
      continue
    fi

    sudo nmcli connection modify "$connection_name" connection.autoconnect no || true
  done < <(nmcli -t -f NAME,TYPE connection show)
}

write_ap_service() {
  sudo tee /etc/systemd/system/scoreboard-ap.service >/dev/null <<EOF
[Unit]
Description=Scoreboard access point on ${WIFI_DEVICE}
After=NetworkManager.service scoreboard.service
Wants=NetworkManager.service

[Service]
Type=oneshot
ExecStart=/bin/sh -lc '/usr/bin/nmcli connection up "${AP_NAME}" ifname ${WIFI_DEVICE} || true'
RemainAfterExit=yes

[Install]
WantedBy=multi-user.target
EOF

  sudo systemctl daemon-reload
  sudo systemctl enable scoreboard-ap.service
}

configure_ap_connection() {
  if ! sudo nmcli connection show "$AP_NAME" >/dev/null 2>&1; then
    sudo nmcli connection add type wifi ifname "$WIFI_DEVICE" con-name "$AP_NAME" ssid "$AP_NAME"
  fi

  sudo nmcli connection modify "$AP_NAME" \
    connection.interface-name "$WIFI_DEVICE" \
    connection.autoconnect yes \
    connection.autoconnect-priority 999 \
    802-11-wireless.mode ap \
    802-11-wireless.band bg \
    802-11-wireless.channel 6 \
    wifi-sec.key-mgmt wpa-psk \
    wifi-sec.psk "$AP_PASSWORD" \
    ipv4.method shared \
    ipv4.addresses "$AP_ADDRESS" \
    ipv6.method disabled
}

activate_ap_now() {
  local active_wifi_connection

  active_wifi_connection="$(nmcli -t -f NAME,DEVICE connection show --active | awk -F: -v dev="$WIFI_DEVICE" '$2 == dev { print $1; exit }')"

  if [[ -n "$active_wifi_connection" && "$active_wifi_connection" != "$AP_NAME" ]]; then
    sudo nmcli connection down "$active_wifi_connection" || true
  fi

  sudo nmcli connection up "$AP_NAME" ifname "$WIFI_DEVICE"
}

main() {
  sudo apt-get update -y
  sudo apt-get install -y network-manager avahi-daemon
  sudo systemctl enable --now NetworkManager avahi-daemon scoreboard.service
  sudo hostnamectl set-hostname "$HOSTNAME_VALUE"

  configure_ap_connection
  disable_other_wifi_autoconnect
  write_ap_service

  echo
  echo "Access point prepared."
  echo "SSID: $AP_NAME"
  echo "Password: $AP_PASSWORD"
  echo "Admin URL after AP activation: $AP_ADMIN_URL"
  echo "Optional mDNS URL: http://${HOSTNAME_VALUE}.local:3000/admin.html"

  if [[ "$ACTIVATE_NOW" -eq 1 ]]; then
    echo
    echo "Activating the access point now. The current SSH session may disconnect immediately."
    activate_ap_now
  else
    echo "Run this script with --activate-now or reboot the Pi to switch to AP mode."
  fi
}

main "$@"