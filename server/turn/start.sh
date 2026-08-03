#!/usr/bin/env bash
# PortalBreakout TURN relay — one-shot setup + start (podman-first).
# Creates .env from .env.example on first run, auto-generates TURN_SECRET,
# auto-detects TURN_HOST if empty, then brings the stack up.
set -euo pipefail
cd "$(dirname "$0")"

if [ ! -f .env ]; then
  cp .env.example .env
  echo "Created .env from .env.example"
fi

# Read a key's current value from .env (empty if unset or blank).
get() { sed -n "s/^$1=\(.*\)$/\1/p" .env | tail -1; }
# Set key=value in .env (replace or append).
set_kv() {
  if grep -q "^$1=" .env; then
    sed -i "s|^$1=.*|$1=$2|" .env
  else
    printf '%s=%s\n' "$1" "$2" >> .env
  fi
}

if [ -z "$(get TURN_SECRET)" ]; then
  set_kv TURN_SECRET "$(openssl rand -hex 32)"
  echo "Generated TURN_SECRET"
fi

if [ -z "$(get TURN_HOST)" ]; then
  ip="$(curl -fsS --max-time 5 https://api.ipify.org 2>/dev/null || true)"
  if [ -z "$ip" ]; then
    ip="$(hostname -I 2>/dev/null | awk '{print $1}')"
    echo "WARNING: could not detect the public IP; using $ip — edit TURN_HOST in .env if this is not reachable from the internet." >&2
  fi
  [ -n "$ip" ] || { echo "ERROR: set TURN_HOST in .env (public IP or DNS name)." >&2; exit 1; }
  set_kv TURN_HOST "$ip"
  echo "TURN_HOST set to $ip"
fi

if podman compose version >/dev/null 2>&1; then
  runner="podman compose"
elif command -v podman-compose >/dev/null 2>&1; then
  runner="podman-compose"
elif docker compose version >/dev/null 2>&1; then
  runner="docker compose"
else
  echo "ERROR: need podman compose (or docker compose) installed." >&2
  exit 1
fi

echo "Starting with: $runner"
$runner up -d
echo
echo "TURN relay:  turn:$(get TURN_HOST):$(get TURN_PORT || echo 3478)  (udp+tcp)"
echo "Credentials: http://$(get CREDS_BIND || echo 127.0.0.1):$(get CREDS_PORT || echo 8788)/ice  — reverse-proxy this over https"
echo "Health:      curl -s http://$(get CREDS_BIND || echo 127.0.0.1):$(get CREDS_PORT || echo 8788)/healthz"
echo
echo "Firewall: allow $(get TURN_PORT || echo 3478)/udp+tcp and $(get TURN_MIN_PORT || echo 49160)-$(get TURN_MAX_PORT || echo 49200)/udp"
echo "Then set ICE_ENDPOINT in src/js/constants.js to your https /ice URL and rebuild the game."
