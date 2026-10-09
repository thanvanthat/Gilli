# Gilli (கில்லி) · 3D online Gilli-Danda

[![CI](https://github.com/thanvanthat/Gilli/actions/workflows/ci.yml/badge.svg)](https://github.com/thanvanthat/Gilli/actions/workflows/ci.yml)
[![CodeQL](https://github.com/thanvanthat/Gilli/actions/workflows/codeql.yml/badge.svg)](https://github.com/thanvanthat/Gilli/actions/workflows/codeql.yml)
[![Open in GitHub Codespaces](https://github.com/codespaces/badge.svg)](https://codespaces.new/thanvanthat/Gilli)
[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/thanvanthat/Gilli)

**Play it without installing anything:** click *Open in GitHub Codespaces* above, then *Create codespace*. The
container installs everything, starts the game, and opens it in a browser tab (port 8080).

A browser-based, online multiplayer 3D game of **Gilli-Danda / Kitti Pull (கிட்டிப்புள்)**, the street game of
Tamil Nadu. You play it on a red-earth village maidan with coconut palms, neem and banyan trees, tiled and
thatched houses with thinnai and kolam, a tea kadai, a temple gopuram and paddy fields.

* **Runs in a desktop browser.** No Unity, no Unreal, no plugin to install.
* **C# authoritative server.** ASP.NET Core + SignalR. The gilli is a real rigid body simulated with
  **BEPUphysics v2** on the server. Every hit, catch, throw, distance and score is decided there and sent to all players.
* **Single player vs Computer.** A full match against CPU batters and fielders (Easy / Normal / Hard,
  1–3 players per team). The CPU plays through the same server rules and physics as people.
* **2–4 players online.** Rooms with 5-letter codes, Team A / Team B, a toss, innings, and a result screen.
* **Practice.** Bat alone with real physics and scoring.
* **Security hardened.** Rate limits, abuse caps, strict CSP and security headers. See [SECURITY.md](SECURITY.md).
* The original single-file game is kept and still playable as **Classic Kitti Pull** at `/classic.html`.

## Quick start (localhost)

Requirements: **.NET 10 SDK** (the projects target `net10.0`; tested with SDK 10.0.400) and **Node.js 20+** (tested with Node 24.21 / npm 11.19). Windows PowerShell for the helper scripts; the manual commands below work on any OS.

```bash
# one command: installs website packages if needed, builds and starts both, checks health, opens the browser
powershell -ExecutionPolicy Bypass -File scripts/dev.ps1
```

It prints the real addresses:

| What | URL |
|---|---|
| Website (play here) | http://localhost:5173/ |
| C# backend | http://localhost:5080/ |
| SignalR hub | http://localhost:5080/hubs/game (reached through the website at `/hubs/game`) |
| Health | http://localhost:5080/health |
| Live performance numbers | http://localhost:5080/api/metrics |

Stop everything with:

```bash
powershell -ExecutionPolicy Bypass -File scripts/stop.ps1
```

The script refuses to start if port 5080 or 5173 is already taken (it never silently moves to another port).
Logs go to `.dev/`.

### Manual commands (any OS)

```bash
cd client && npm ci && cd ..                       # 1. install website dependencies
dotnet run --project server/Gilli.Server           # 2. start the C# backend on http://localhost:5080
npm run dev --prefix client                        # 3. start the website on http://localhost:5173 (new terminal)
curl http://localhost:5080/health                  # 4. confirm server health
```

Open http://localhost:5173/. In development the website proxies `/hubs`, `/api` and `/health` to the backend,
so the browser only ever talks to one origin. To point the dev site at another backend, set
`GILLI_SERVER_URL=http://host:port` before `npm run dev`.

### Single player (vs Computer)

**Play → Single player · vs Computer.** Pick a difficulty and players per team, then **Play vs Computer**. You
are Team A (any teammates are CPU) and the computer is Team B. The toss, both innings, catches, throws at the danda
and the result all work exactly as online. On Linux/macOS (or in Codespaces) `bash scripts/start.sh` builds and serves
everything on http://localhost:8080.

### Try multiplayer on one computer

1. Open http://localhost:5173/ in two separate windows. Each tab is its own player (the seat is kept per tab).
2. Window 1: **Play → Online multiplayer → Create room**. Note the 5-letter code.
3. Window 2: **Play → Online multiplayer → Join room** and enter the code.
4. The guest presses **Ready** and the host presses **Start match**. The toss winner chooses bat or field.

For four players, use four windows: two join Team A and two join Team B. Teams must be even (1 v 1 or 2 v 2).
A `localhost` address only works on this computer. To play over the internet, see *Production release* below.

## Controls

| Role | Controls |
|---|---|
| Batting | **A / D** or mouse: aim · **Space / click**: flick the gilli up · **Space / click** again: strike it in the air |
| Fielding | **WASD**: run · **Shift**: sprint · mouse (click the field to capture it) or **Q / E**: camera · **Space / F / click**: catch |
| Throwing at the danda | Hold **Space / click** to charge, release to throw · **A / D** aim · **W / S** throw height |
| Any time | **Esc / P**: pause menu (the online match keeps running for everyone else) |

The right-hand gauge while batting shows the gilli's height against the swing height. Strike near the top of its rise.

## Rules (summary)

Full details are in [GAMEPLAY_DESIGN.md](GAMEPLAY_DESIGN.md).

* A toss decides who bats. The winner's captain chooses bat or field.
* A batter keeps batting until out. Out happens on **3 consecutive misses**, a **catch** before the gilli lands, or
  a fielder's **throw that hits the danda** laid across the pit.
* A safe hit scores **floor(distance ÷ 0.75 m danda length) + 1 bonus**. The distance is measured by the server
  from the pit to where the simulated gilli actually stops.
* After 8 attempts a batter retires (so an innings cannot run forever). The side batting second wins as soon as it
  passes the target. Otherwise the higher total wins, and equal totals are a draw.

## Tests

```bash
dotnet test server/Gilli.slnx                 # 65 C# tests: physics, rules, rooms, CPU bots, SignalR, security
npm test --prefix client                      # 6 browser-code unit tests (interpolation, rig mirror, ballistics)
npm run build --prefix client                 # type-check + production website build
node scripts/smoke-test.mjs http://localhost:5080   # 17 end-to-end checks against a running server
```

Results and the manual test plan are in [TEST_REPORT.md](TEST_REPORT.md). On GitHub, the **CI** workflow runs all of
these on every push (plus a dependency audit), **CodeQL** scans the C# and TypeScript code, and **Dependabot**
watches the npm, NuGet and Actions dependencies.

## Architecture

```
client/  React 19 + TypeScript + Vite 8 + Three.js 0.186 + @microsoft/signalr 10
  src/net/        GameClient (SignalR, auto-reconnect + seat recovery, clock sync), DTO types
  src/game/       GameView (renderer, cameras, input, interpolation, prediction), rig mirror, audio
  src/game/scene/ World (procedural Tamil Nadu village from the server layout), Characters (procedural animation)
  src/ui/         screens, lobby, toss, HUD, pause, settings, result
server/  .NET 10
  Gilli.Core/     GameConfig, FieldLayout, Physics/ (BEPU world, swing rig), Rules/ (MatchRules), Rooms/ (Room, Room.Bots, DTOs)
  Gilli.Server/   Program (endpoints, CORS, static hosting), GameHub (SignalR), GameLoop (60 Hz), RoomManager, Security
  Gilli.Tests/    xUnit: PhysicsTests, RulesTests, RoomTests, BotTests, HubTests, SecurityTests
scripts/ dev.ps1, stop.ps1, publish.ps1, start.sh, smoke-test.mjs
.github/ CI, CodeQL and Dependabot · .devcontainer/ GitHub Codespaces
index.html, kitti_pull.py, python/   the original classic game (kept unchanged)
```

How one strike flows:

1. The browser sends `Flick(attemptId)`. The server checks the batter, the phase and the attempt, then applies an impulse to the BEPU gilli.
2. The browser sends `Swing(attemptId)`. The server sweeps a kinematic danda capsule through the BEPU world at 960 Hz.
3. BEPU's narrow phase reports the real danda–gilli contact. The server applies the impact impulse (restitution and
   friction, with torque from the contact point) once per swing.
4. The gilli flies, spins, bounces and rolls under gravity and drag. BEPU detects the landing and the resting point.
5. The rules engine resolves the attempt **exactly once** (catch / throw / safe / miss) and the result goes to every client.
6. Clients render 30 Hz snapshots with interpolation. They also predict ballistically while the gilli is airborne, so the batter's
   timing matches the server.

## Production release

```bash
powershell -ExecutionPolicy Bypass -File scripts/publish.ps1     # builds the site and publishes the server to ./publish
dotnet publish/Gilli.Server.dll --urls http://localhost:8080     # one process serves the website and the hub
```

Or build the container: `docker build -t gilli . && docker run -p 8080:8080 gilli`.

In production the C# server hosts the built website from `wwwroot`. The hub is therefore on the same origin, and
the browser uses `https://` and `wss://` automatically when the host provides TLS. Deploy the container (or the
`publish` folder) to any host with WebSocket support, for example Azure App Service, Render, Fly.io, Railway or a VM
behind nginx/Caddy. Point the platform health check at `/health`. If the website is hosted separately (a CDN,
for example), build it with `VITE_SERVER_URL=https://your-server` and set `Cors__Origins__0=https://your-site` on the
server.

**Status:** the production build has been verified locally (published server in Production mode on
http://localhost:8080). It has **not** been deployed to a public host, and the Dockerfile has not been built
(Docker is not installed on the development machine). See [DEVELOPMENT_PLAN.md](DEVELOPMENT_PLAN.md).

## Known limitations

* The characters use procedural low-poly models and animation. No glTF skeletal models or motion capture are bundled.
* Fielders and batters are not physical bodies in the simulation: a gilli cannot bounce off a player.
* Movement is predicted by the client and validated by the server (speed limit, field boundary, solid objects).
  A fast cheater could still steer within the speed limit.
* Input timing is quantised to the server's 60 Hz tick (up to ~17 ms).
* Rooms live in memory: restarting the server ends all matches. The seats survive a dropped connection or a page reload for 20 s.
* Desktop keyboard and mouse only. There are no touch controls.

## Classic Kitti Pull (the original version)

The original single-file game is unchanged: `index.html` (Three.js r128, played against the computer or a friend on one
device). With the new server running it is also available at http://localhost:5173/classic.html. You can open
`index.html` directly, or run `python kitti_pull.py` if Python is installed. The `python/` folder still holds the
console versions written with loops and conditions:

| File | What it uses |
|---|---|
| `python/1_simple.py` | `for`, `while`, `if`, `else` |
| `python/2_full_rules.py` | Full rules (toss, 2 players, catch, danda hit, 3 misses) with only `while`, `for`, `if`, `elif`, `else` |
| `python/3_functions.py` | Functions (`def`), `try/except` |
| `python/4_distance_while_loop.py` | Distance calculated with a `while` loop and gravity |

## Author

Thanvanth AT
