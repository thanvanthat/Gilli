#!/usr/bin/env bash
# Vercel build for the static site (run from client/, set as buildCommand in client/vercel.json).
# Vercel's build image has no .NET SDK, so install it, compile the C# engine to
# WebAssembly, then build the website in peer-to-peer mode.
set -euo pipefail

DOTNET_DIR="$HOME/.dotnet"
if [ ! -x "$DOTNET_DIR/dotnet" ]; then
  curl -sSL https://dot.net/v1/dotnet-install.sh -o /tmp/dotnet-install.sh
  bash /tmp/dotnet-install.sh --channel 10.0 --install-dir "$DOTNET_DIR"
fi
export PATH="$DOTNET_DIR:$PATH"
export DOTNET_ROOT="$DOTNET_DIR" DOTNET_CLI_TELEMETRY_OPTOUT=1 DOTNET_NOLOGO=1 DOTNET_SYSTEM_GLOBALIZATION_INVARIANT=1
dotnet --version

npm run build:engine
VITE_ONLINE=p2p npm run build
