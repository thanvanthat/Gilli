# Changelog

## 1.1.0 — 2026-10-09 · Single player and security

### Added
* **Single player vs Computer:** Easy / Normal / Hard, 1–3 players per team, CPU batters, fielders, catchers and
  throwers that use the same validated server actions and physics as humans (`Room.Bots.cs`). New Play menu panel,
  "You / Computer" scoreboard, CPU tags, and "You beat the computer!" results.
* **Security hardening** (see [SECURITY.md](SECURITY.md)): per-connection rate limits on every hub method, a room
  cap, a per-IP connection cap, Kestrel limits, CSPRNG seat tokens with constant-time comparison, forwarded headers
  only when explicitly enabled, rejection of spoofing Unicode in names, CSP and security headers, metrics restricted
  to local callers, a catch-press cooldown, and the debug hook removed from production builds.
* **GitHub:** CI workflow (C# + web tests, build, dependency audit, end-to-end smoke test), CodeQL scanning,
  Dependabot, a Codespaces dev container, and `scripts/start.sh`.
* Tests: 65 C# tests (+9 bot, +16 security, +1 hub).

### Fixed
* A new room could be closed by the game loop before its creator was seated (B13).

## 1.0.0 — 2026-10-09 · Gilli online

### Added
* **C# authoritative server** (`server/`, .NET 10): ASP.NET Core, SignalR hub `/hubs/game`, 60 Hz game loop,
  `/health`, `/api/layout`, `/api/config` and `/api/metrics`. Serves the built website in production.
* **BEPUphysics v2.4 simulation** per room: gilli rigid body, kinematic swinging danda (960 Hz substeps), real
  contact-based impact impulse with torque, drag, ground bounce, rolling, rest detection, a target danda for
  throws, and colliders for trees and buildings.
* **Rules engine** (`MatchRules`): toss, innings, batting order, consecutive misses, catches, target hits,
  distance scoring `floor(d/0.75)+1`, attempt limit, chase completion, draws and forfeits. Every attempt resolves exactly once.
* **Rooms:** 5-letter codes, 2–4 players, Team A/B, ready, host start, toss choice with timeout, play again,
  return to lobby, leave, reconnect with token, disconnect grace, host migration.
* **Browser client** (`client/`, React 19, TypeScript, Vite 8, Three.js 0.186): loading screen, main / play /
  multiplayer menus, lobby with team selection, toss, controls guide, settings, HUD, pause menu, result screen,
  connection status and toasts.
* **3D Tamil Nadu village maidan** built from the server layout: daylight sky, shadows, fog, red-earth field, grass,
  boundary stones, distance arcs, the pit, crease and fielding spots, coconut palms (instanced), neem and banyan,
  tiled and thatched houses with thinnai and kolam, a tea kadai, temple wall and gopuram, thoranam, paddy fields,
  hills and cheering villagers.
* Procedural players with idle, walk, run, bat, throw, catch and celebrate animation. Name tags.
* Snapshot interpolation, ballistic prediction of the airborne gilli, client movement prediction with server reconciliation.
* Practice mode (solo batting with real physics).
* Scripts: `dev.ps1` (start, health check, URLs), `stop.ps1`, `publish.ps1`, `smoke-test.mjs`. Dockerfile.
* Tests: 39 C# (physics, rules, rooms, SignalR), 6 client unit tests, a 17-check end-to-end smoke test.
* Docs: README, GAMEPLAY_DESIGN, DEVELOPMENT_PLAN, BUGS_AND_FIXES, TEST_REPORT, CHANGELOG.

### Kept
* The original `index.html`, `kitti_pull.py` and `python/` versions are unchanged. The classic game is also served at
  `/classic.html` so it runs without Python.

### Fixed
* See [BUGS_AND_FIXES.md](BUGS_AND_FIXES.md): lost join broadcast, background-tab loading hang, UTF-8 mojibake,
  first-match physics stall, production content root, thrower view obstruction, and more.

## 0.1.0 — earlier · Kitti Pull 3D (classic)
* Single-file Three.js game against the computer or a friend on one device, a Python localhost launcher, and Python
  console versions.
