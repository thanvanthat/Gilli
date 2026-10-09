# Bugs and fixes

Each entry gives the issue, its root cause, the correction, and how it was actually verified.

## A. Defects found in the original repository (inspection, 2026-10-09)

The repository contained a single-file client-only game (`index.html`, Three.js r128), a copy of it embedded in
`kitti_pull.py` (a Python localhost server) and four Python console versions. There was no backend, no C#, no
multiplayer and no package or build setup. Git: one commit on `main` (`0626c1c`), clean working tree.

| # | Priority | Issue | Root cause | Correction | Verification |
|---|---|---|---|---|---|
| A1 | P0 | The localhost launcher cannot run on this machine | `python kitti_pull.py` needs Python, and only the Microsoft Store stub is installed (`Python was not found`) | Gilli is served by Vite (dev) or by the C# server (production). The classic game is copied to `client/public/classic.html`, so it no longer needs Python | `http://localhost:8080/classic.html` loaded from the published C# server in the built-in browser (screenshot of the Kitti Pull menu) |
| A2 | P0 | No online multiplayer. "Friend" mode is two people on one device | Client-only design | New ASP.NET Core SignalR server with rooms, codes, teams, ready, toss and an authoritative match | Hub tests with real SignalR clients. Two browser tabs played full matches (TEST_REPORT §3) |
| A3 | P0 | A hit is decided by a meter, not a collision | `tap()` computed `q = 1 - |h - ZONE_H|/ZONE_W` from the gilli height and awarded a hit when `q > 0`, with launch direction from `rand()` | BEPU kinematic danda swept through the world. The real contact produces the impulse, and misses are physical | `Swing_timing_sweep_produces_hits_and_misses`, `Swinging_before_the_flick_reaches_the_gilli_never_hits`, browser hits and misses |
| A4 | P0 | Catches and danda hits were dice rolls | `plan.caught = Math.random() < prob`, `plan.dandaHit = Math.random() < hitP` | Catches need a fielder in reach of the simulated gilli. Throws are simulated against a static danda collider | `A_fielder_in_position_who_presses_catch_gets_the_batter_out`, `A_fielder_far_away_cannot_catch`, `A_throw_that_reaches_the_danda_is_out...`. A real catch in the browser ("Caught by Arun") |
| A5 | P1 | Ad-hoc integration: the gilli was clamped to y = 0.06, spin was cosmetic, and there were no colliders | Hand-rolled Euler step in `stepGilli` | BEPU rigid body with gravity, drag, contacts, friction, bounce and rest detection | `Gilli_rests_on_the_ground...`, `Flick_pops_the_gilli...without_clipping` |
| A6 | P2 | No WebGL or load-failure handling. The CDN script failing gives a blank page | Single `<script src=cdn>` with no checks | The new client checks WebGL 2, the backend reachability (`/api/layout`) and the scene build, and shows an error screen with Retry (and a link to the classic game) | Error paths reviewed in code. The success path verified in the browser. The failure screens were not forced in a browser test |
| A7 | P2 | The game code is duplicated (`index.html` and `kitti_pull.py` PAGE string) | Copy-pasted HTML in Python | Left unchanged (the user's classic files). The new game has one source of truth | n/a |

## B. Defects found and fixed while building and testing

| # | Issue | Root cause | Correction | Verification |
|---|---|---|---|---|
| B1 | A joining player was not broadcast to players already in the room | `GameHub.JoinInternal` called `room.BuildState()` to answer the caller, which cleared `StateDirty`, so the following `Flush` sent nothing | `BuildState(broadcast: false)` for caller-only replies | `HubTests.Two_browsers_create_join...` failed before ("timed out waiting for host sees guest") and passes after |
| B2 | A game opened in a background tab stays on "Building the village…" | Browsers pause `requestAnimationFrame` in hidden tabs, and the staged build awaited it | `yieldFrame()` resolves on the next frame or after 60 ms, whichever is first | Two background tabs loaded to the main menu (previously stuck) |
| B3 | Server text showed `Â·` instead of `·`, and the Tamil signboards were garbled | PowerShell `Get-Content`/`Set-Content` read UTF-8 files as Windows-1252 and re-encoded them (also added a BOM) | Strings restored with a UTF-8-safe Node script, BOMs removed. Edits now avoid PowerShell text round-trips | Regression test `Event_texts_are_clean_utf8_without_mojibake`. Grep for mojibake finds nothing |
| B4 | First match after server start froze every room for ~0.4 s | JIT compilation of BEPU on the first physics step inside the shared game loop | Physics warm-up at startup (flick, swing, throw in a scratch world) | `/api/metrics` `tickMaxMs` was 424.8 before and 10.8 / 13.2 after (smoke test runs) |
| B5 | The published server 404s on `/` when started from another folder | The content root defaulted to the current directory, so `wwwroot` and `appsettings.json` were not found | `ContentRootPath = AppContext.BaseDirectory` | `dotnet publish/Gilli.Server.dll` from the repo root served the game. A practice hit over WebSockets succeeded |
| B6 | The thrower's view was blocked by the distance label and their own name tag | The label floated at the rest point (where the thrower stands), and the local tag was always drawn | Label moved to the rope midpoint and hidden for the thrower. Your own tag is never drawn | Screenshot before: view blocked. Screenshot after: clear view of the pit, the rope and the throw-preview arc |
| B7a | Distant hills looked like one grey dome | Tall hemisphere scale | Flatter, wider, more numerous hills | Code review (scene only) |
| B7 | Palm fronds were nearly invisible from the default cameras | Fronds were 0.7 m wide and almost horizontal, so they were seen edge-on | Wider leaf outline, an arched droop, varied tilt | Screenshot shows full palm crowns |
| B8 | `THREE.Clock` and `PCFSoftShadowMap` deprecation warnings | Three.js 0.186 deprecates or removes them | Frame time from `performance.now()`, `PCFShadowMap` | Browser console had no Three.js warnings after reload |
| B9 | The lobby showed "Host" twice for the host | The host tag plus a ready-state tag that also said Host | Ready/Not ready is shown only for non-hosts | Code review |
| B10 | Practice showed "Innings 1/2" and "Team A to bat" | Rules model practice as a match whose team B is empty | HUD hides innings in practice. The banner says "Practice" | Practice HUD screenshot after the fix: no innings field |
| B11 | Dockerfile `HEALTHCHECK` would always fail | The `aspnet` image has no `wget`/`curl` | Removed. Platforms probe `GET /health` | Reasoned from the image contents. Docker not available to build |
| B12 | Smoke test printed "Result given for 'state' method" | The test's `.on` handlers returned `Array.push`'s value, which SignalR treats as a client result | Handlers wrapped in braces (the game's own handlers already return nothing) | Re-run printed only PASS lines |

| B13 | Choosing "Play vs Computer" sometimes dropped the player into an empty lobby, and Start said "That room no longer exists" | Rooms are registered before the creator is seated. The 60 Hz loop could tick in between, see no humans and close the room as "empty" (made likely by logging in that gap) | The loop closes a room as empty only once it is more than 10 s old. Explicit leaves still close at once | Reproduced in the browser (server log: "created" then immediately "closed (empty)"). Regression test `Vs_computer_rooms_start_immediately_and_survive_the_game_loop` creates and starts 15 rooms. Browser vs Computer then started every time |
| B14 | Rate-limit burst too small when a high rate is configured | The lobby bucket capacity was fixed at 5 | Capacity = max(5, 2 × rate) | Hub stress test passes with a relaxed rate |

Security findings S1–S12 (rate limits, room/connection caps, token strength, forwarded-header spoofing, name
spoofing, CSP/headers, metrics exposure, catch spam, debug hook) are listed with fixes and tests in
[SECURITY.md](SECURITY.md).

## C. Test-environment notes (not product bugs)

* In the automated browser pane, background and hidden tabs get almost no animation frames, so the game loop does
  not send movement. The catch test therefore drove `Move` at 15 Hz from a script, which is the same call the frame
  loop makes. With a visible window, keyboard movement goes through the frame loop.
