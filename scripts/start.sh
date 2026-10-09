#!/usr/bin/env bash
# Builds the website, then runs the C# server hosting both the game and the multiplayer hub on one port.
# Used by GitHub Codespaces (.devcontainer) and works on Linux/macOS:  bash scripts/start.sh [port]
set -euo pipefail
PORT="${1:-8080}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/publish"

if curl -sf "http://localhost:$PORT/health" >/dev/null 2>&1; then
  echo "Gilli is already running on port $PORT"; exit 0
fi
( cd "$ROOT/client" && { [ -d node_modules ] || npm ci; } && npm run build )
dotnet publish "$ROOT/server/Gilli.Server" -c Release -o "$OUT" --nologo -v q
rm -rf "$OUT/wwwroot" && cp -r "$ROOT/client/dist" "$OUT/wwwroot"

nohup dotnet "$OUT/Gilli.Server.dll" --urls "http://0.0.0.0:$PORT" > "$ROOT/gilli-server.log" 2>&1 &
for i in $(seq 1 60); do
  if curl -sf "http://localhost:$PORT/health" >/dev/null; then
    echo "Gilli is running: http://localhost:$PORT  (log: gilli-server.log)"
    exit 0
  fi
  sleep 1
done
echo "Server did not start; see gilli-server.log" >&2
exit 1
