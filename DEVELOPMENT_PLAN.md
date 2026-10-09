# Development plan

## Starting point (inspection)

The repository (`github.com/thanvanthat/Gilli`, branch `main`, commit `0626c1c`, clean tree) held a client-only
single-file Three.js game, a Python launcher and Python console versions. There was no package manager, build, backend
or tests. The working folder was not yet a git checkout. It was cloned into place, so nothing local was overwritten.
Prioritised defects are listed in [BUGS_AND_FIXES.md](BUGS_AND_FIXES.md) §A.

Decision: keep the classic files untouched, and build the requested architecture alongside them (`client/` and
`server/`). The village art (gopuram, huts, kolam, tea kadai, banyan, cart, paddy, thoranam, villagers) was ported from
the classic game into TypeScript modules, so its working visuals were reused.

## Physics engine decision

**BEPUphysics v2.4.0 is used.** It integrated correctly:

* A pure C# simulation, one instance per room, single-threaded. It is deterministic enough for an authoritative server.
* The narrow-phase callbacks give exact danda–gilli contacts (offset, normal, depth) from a kinematic swinging
  capsule. Continuous collision detection plus 960 Hz substeps during swings prevented tunneling in every test.
* Two gaps were handled explicitly: BEPU v2 has no restitution coefficient (the bat impact impulse is computed from
  the contact, and ground bounce is a post-contact correction), and the first step JIT-compiles slowly (startup
  warm-up). Both are documented in GAMEPLAY_DESIGN.md.

## Phases

| Phase | Scope | Status |
|---|---|---|
| 1 | Inspect the repo, fix critical startup defects (no runnable launcher, no backend) | **Done** |
| 2 | Playable 3D browser environment and stable gilli physics | **Done** (physics tests, browser hits) |
| 3 | Rules, turns, scoring, results | **Done** (18 rules tests, full matches in the browser) |
| 4 | Multiplayer rooms and synchronised gameplay | **Done** (hub tests, two-tab matches, catch, throw, reconnect) |
| 5 | Tamil Nadu environment and professional UI | **Done** (procedural characters; see limitations) |
| 6 | Regression tests, remaining bugs, localhost multiplayer | **Done** ([TEST_REPORT.md](TEST_REPORT.md)) |
| 7 | Production website and public multiplayer service | **Prepared, not deployed**: `publish.ps1` verified locally in Production mode, Dockerfile written (not built: no Docker) |

## Next steps

1. **Public deployment** (needs your hosting choice and account). Push the container to a host with WebSocket support
   (Azure App Service, Render, Fly.io or Railway), point the health check at `/health`, and confirm the hub works over `wss://`.
   Then run `node scripts/smoke-test.mjs https://<your-host>`.
2. Human play-testing for feel: tune `SwingAngularSpeed`, `FlickSpeed`, `CatchRadius` and the throw speed range in `GameConfig.cs`.
3. Optional: rigged glTF villagers with skeletal animation in place of the procedural fallback.
4. Optional: the batter can defend the throw (strike the incoming gilli). Bots to fill empty fielding positions.
5. Optional: persistence (match history) if wanted. It is deliberately in-memory now.

## Release procedure

1. `dotnet test server/Gilli.slnx` and `npm test --prefix client`, both green.
2. `scripts/publish.ps1` → `publish/` (the server with the website in `wwwroot`), or `docker build -t gilli .`.
3. Deploy. Environment: `ASPNETCORE_ENVIRONMENT=Production`, `ASPNETCORE_URLS=http://+:8080` (container) or the
   platform port. TLS terminates at the platform. Forwarded headers are honoured.
4. Check `GET /health`, then run `node scripts/smoke-test.mjs https://<host>`, then open the site in two browsers on
   different networks and play a match.
5. Only after step 4 passes, announce the public URL.
