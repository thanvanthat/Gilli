# Test report

Date: 2026-10-09 · Machine: Windows 11, .NET SDK 10.0.400, Node 24.21.0, npm 11.19.0.
Browser checks used the Claude desktop app's built-in Chromium browser pane.

Legend: **PASS** verified with evidence · **FAIL** · **UNVERIFIED** not executed (reason given).

## 1. Automated tests (final run)

| Suite | Command | Result |
|---|---|---|
| C# physics, rules, rooms, CPU bots, SignalR, security | `dotnet test server/Gilli.slnx` | **65 passed, 0 failed** (v1.1.0) |
| Client unit (interpolation, rig mirror, ballistics) | `npm test --prefix client` | **6 passed, 0 failed** |
| Client type-check + production build | `npm run build --prefix client` | **PASS** (`tsc --noEmit` clean, Vite build OK) |
| Server build | `dotnet build` / `dotnet publish -c Release` | **PASS** (0 warnings, 0 errors) |
| End-to-end smoke (2 real SignalR clients vs running server) | `node scripts/smoke-test.mjs` | **17/17 PASS** (dev server and hardened production build) |
| Dependency audit | `npm audit`, `dotnet list package --vulnerable --include-transitive` | **0 vulnerabilities** |

### C# test inventory

* **PhysicsTests (4):** the gilli rests without sinking or drifting. The flick reaches ~1 m (measured apex 0.979 m) and
  falls without clipping. A swing-timing sweep gives both hits and misses, with at most one hit per swing. Swinging
  before the gilli rises never hits.
* **RulesTests (18):** scoring formula (6 distances), misses and outs never score, three consecutive misses means out,
  a safe hit resets misses but not attempts, catch and target hit are outs, batting order across innings, winner and
  draw, chase completion, attempt-limit retirement, toss choice, solo practice side, actions rejected after
  completion, forfeit.
* **RoomTests (14):** clean hit scored exactly once from the simulated rest distance (and unchanged 2.5 s later).
  Not swinging is a miss, and three is out. A late swing misses. Turn, phase, stale and duplicate validation. A
  positioned fielder catches; a distant one cannot. A simulated throw hits the danda (out) and a wild throw is safe.
  Throw timeout is safe. A complete match produces the winner, and Play again resets. Lobby name, capacity, team, ready
  and host validation. Disconnect, reconnect with token, grace removal and host migration. Leaving mid-match forfeits.
  Speed limit, solid-object push-out and batter lock. Event text encoding.
* **HubTests (3):** `/health` and `/api/layout`. Two real SignalR clients create and join (unknown and malformed codes
  rejected), host-only start, ready gating, toss, flick, an identical authoritative result on both clients,
  in-progress rejection. Four players join, a fifth gets `ROOM_FULL`, and a disconnect is shown in the lobby.

### Physics sweep (evidence for "real physics")

Swing pressed *t* seconds after the flick (from `Swing_timing_sweep_produces_hits_and_misses`, tuned configuration):
0.00–0.20 s: miss (the danda passes under the rising gilli) · 0.22–0.52 s: hits, resting 7.7–32.8 m · 0.54 s and
later: miss. Every swing produced at most one contact.

### v1.1.0 additions

* **BotTests (9):** CPU seats for team sizes 1–3 (and bots cannot be claimed). The CPU decides its own toss. Whole
  matches finish with the human idle on Easy/Normal/Hard (CPU flicks, swings, hits, catches and throws; the score
  equals the sum of safe hits). Hard CPU fielders catch and throw against a human batter. A room with only bots counts as empty.
* **SecurityTests (16):** security headers and CSP, no server banner, metrics hidden by default, action flooding
  rate-limited, room-code guessing throttled, room cap, per-IP connection cap, spoofing names rejected and real
  (Tamil) names accepted, token strength and bot seats, catch cooldown.
* **HubTests (+1):** 15 vs-computer rooms created and started back to back over SignalR (regression for B13), and invalid difficulty/team size rejected.
* **Browser (built-in Chromium):** Play → *Single player · vs Computer* (Hard, 2 per team) started straight into the
  match. A hit was chased by "Karthik (CPU)", who threw from 20.7 m and missed: Safe +28. The production build
  (CSP on) played vs Computer (Easy) with zero console errors. The classic page loaded with no CSP errors.

## 2. Measured performance

From `GET /api/metrics` during the smoke test (2 rooms live): **average room tick 0.24 ms**, max 20.4 ms (max was
**424.8 ms before** the BEPU warm-up fix B4). Snapshots average **388 bytes**, which is ~11.6 KB/s per client at 30 Hz.
Local round trip for hub calls: 5–8 ms.

## 3. Required test cases

| # | Case | Result | Evidence |
|---|---|---|---|
| 1 | Website loads in a supported browser | **PASS** | Loading screen, then main menu in the built-in Chromium pane (dev :5173 and production :8080) |
| 2 | 3D scene renders and resizes | **PASS** | Screenshots at 800×450 and 724×913 viewports. The scene re-fits (ResizeObserver) |
| 3 | Gilli rests on the ground | **PASS** | `Gilli_rests_on_the_ground...` (y within ±6 mm of its radius). Visible at the pit |
| 4 | A valid swing hits the gilli | **PASS** | Browser practice: flick + 0.28 s swing gave Safe, 28.30 m. Smoke test hit 24.42 m |
| 5 | A missed swing does not score | **PASS** | `Swinging_far_too_late_misses`. Browser: "Swung and missed", 0 points |
| 6 | A hit launches and rotates the gilli | **PASS** | Snapshot angular velocity is non-zero after impact (impulse at the contact point). Trail and spin visible |
| 7 | The gilli collides with the ground | **PASS** | Landing events (e.g. landed 19.1 m, rested 28.3 m). Flick test: no clipping |
| 8 | Landing distance calculated correctly | **PASS** | Rest distance equals the HUD and scoring distance (rounded 1 cm). 28.30 → 37 + 1 = 38, 23.73 → 31 + 1 = 32 |
| 9 | One hit produces at most one score | **PASS** | Room test (unchanged after 2.5 s). Smoke "no duplicate scoring". Browser totals 38 → 70 |
| 10 | A valid catch results in an out | **PASS** | Room test. Browser: fielder walked under the gilli, server ruled "Out/Caught: Caught by Arun" |
| 11 | Three consecutive misses → out | **PASS** | Rules and room tests. Browser: Miss 1, Miss 2, then Out/ThreeMisses, innings switched |
| 12 | Safe hit resets consecutive misses | **PASS** | `Safe_hit_resets_consecutive_misses_but_not_attempt_count` |
| 13 | Room creation works | **PASS** | Browser UI: room VHV2U created. Smoke and hub tests |
| 14 | A second browser session joins | **PASS** | Second tab joined VHV2U through the UI (each tab is its own session) |
| 15 | Both players see each other | **PASS** | Both lobbies list both players live. In-match, the thrower's 3D view shows the batter |
| 16 | Consistent turn and score updates | **PASS** | Both tabs reported identical scores (56–0, then 56–30) and results. Smoke "identical authoritative result" |
| 17 | Invalid room codes rejected | **PASS** | Browser: "No room with code ZZZZZ." Hub test for malformed codes |
| 18 | Full rooms reject more players | **PASS (automated only)** | `Fifth_player_is_rejected...` with 5 real SignalR clients. Not repeated with 5 browser tabs |
| 19 | Disconnecting updates the lobby | **PASS** | Closing a tab marked the player offline at once and removed them after the 20 s grace |
| 20 | Complete match produces the correct winner | **PASS** | Browser: Team A wins 56–30 on both tabs. A second match ended in a draw 0–0 |
| 21 | Restart resets state | **PASS** | Play again: new toss, toss timeout defaulted to bat, scores 0–0, misses 0, attempt 1 |
| 22 | Frontend builds | **PASS** | `npm run build` |
| 23 | C# backend builds | **PASS** | `dotnet build`, `dotnet publish -c Release` |
| 24 | Physics and scoring tests pass | **PASS** | 39/39 |
| 25 | Existing functionality still works | **PASS** | The classic game loads from the C# server at `/classic.html`. Original files unchanged |

Extra checks: a server restart during play was handled (both tabs auto-reconnected, saw "That room no longer
exists." and returned to the menu). A page reload resumed the seat in the same room. The real **Space** key flicks
the gilli. The published production server worked in Production mode (website + WebSocket hub on :8080).

## 4. Manual test plan (repeatable)

1. `scripts/dev.ps1`. Expect "Backend healthy" and both URLs printed. The browser opens http://localhost:5173/.
2. **Practice:** Play → name → Practice. Press Space, then Space again ~0.3 s later. Expect the gilli to fly, a
   rope and distance label, and a "SAFE! +N" where N = floor(d/0.75)+1. Press Space once and wait: expect a Miss.
3. **Two windows:** create a room in window 1 and join it from window 2 (the second window can be private).
   Ready, then Start, then the toss.
4. **Fielding (window 2):** click the field to capture the mouse, run with WASD/Shift, and watch the green reach
   ring. Press Space when "CATCH IT!" appears.
5. **Throwing:** when the gilli stops, hold Space and release with the dashed arc ending on the pit.
6. Check that both windows show the same scoreboard and banners. Close one window: the other shows the player offline.
7. Finish the match. Check the result screen, Play again (host) and Return to lobby.
8. `scripts/stop.ps1`. Expect both ports freed.

## 5. Not verified / limitations of this testing

| Item | Status | Why / next step |
|---|---|---|
| Human play feel with mouse capture (pointer lock), keyboard running and camera | **UNVERIFIED by a human** | Automation used the game's own input functions, the real Space key and hub calls. Pointer lock needs a person |
| A full 2 v 2 match in four browser windows | **UNVERIFIED in browsers** | Four-player rooms are covered by hub and rules tests (batting order across 4 players). Needs 4 windows |
| Sound effects | **UNVERIFIED** | Audio output was not observed in automation |
| Play across two different computers (LAN or internet) | **UNVERIFIED** | Needs a reachable host. See README → Production release |
| `docker build` | **UNVERIFIED** | Docker is not installed on this machine |
| Public deployment | **NOT DONE** | Requires choosing a host and an account. The code is on GitHub, and Codespaces can run it from there |
| GitHub Actions CI / CodeQL on github.com | **see the Actions tab** | Workflows were added with the push. Their results are on GitHub, not on this machine |
| A complete human-played match vs Computer | **UNVERIFIED by a human** | CPU-vs-idle-human matches are automated. A human playing the full match needs a person |
| Browsers other than Chromium (Firefox, Safari) | **UNVERIFIED** | Standard WebGL 2 and WebSocket APIs only |
| Error screens (no WebGL 2, backend down at load) | **PARTIAL** | Code paths reviewed; the backend-gone-mid-game path verified; the load-time failure screens not forced |
