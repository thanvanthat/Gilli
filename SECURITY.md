# Security

## Reporting a vulnerability

Please report security problems privately to the maintainer (Thanvanth AT) through GitHub's
**Security → Report a vulnerability** on this repository, not in a public issue.

## Security review (2026-10-09)

Scope: the C# server (`server/`), the browser client (`client/`), build/deploy files and dependencies.
Method: threat modelling of every network entry point, code review, dependency scanning, and regression tests for
each fix (`server/Gilli.Tests/SecurityTests.cs`, `BotTests.cs`, `HubTests.cs`).

### Attack surface

| Entry point | Who can reach it | Data in |
|---|---|---|
| `GET /`, static files, `/classic.html` | anyone | none |
| `GET /health`, `/api/layout`, `/api/config` | anyone | none (read-only, no secrets) |
| `GET /api/metrics` | local machine only (configurable) | none |
| SignalR hub `/hubs/game` (WebSocket) | anyone | names, room codes, seat tokens, game intents (numbers) |

The server has no database, no file uploads, no accounts and no stored personal data. Rooms live in memory.

### Findings and fixes

| # | Threat (STRIDE) | Finding | Fix | Verified by |
|---|---|---|---|---|
| S1 | DoS | Any client could call hub methods without limit (e.g. thousands of `Move`/`SetReady` per second), each taking a room lock | Per-connection token buckets (`RateLimitHubFilter`): movement 30/s, actions 8/s, lobby 0.5/s with bursts. Flooding returns `RATE_LIMITED`, and persistent flooding drops the connection | `Flooding_game_actions_is_rate_limited` |
| S2 | DoS | Unlimited room creation; each room owns a physics world (memory and CPU exhaustion) | Global cap `Security:MaxRooms` (300) returns `SERVER_BUSY`. Creation is in the lobby rate bucket | `Room_creation_is_capped` |
| S3 | DoS | Unlimited WebSocket connections from one address | `Security:MaxConnectionsPerIp` (12). Kestrel limits: 5000 connections, 64 KB bodies, 16 KB headers. SignalR messages ≤ 16 KB, one parallel invocation per client | `Too_many_connections_from_one_address_are_refused` |
| S4 | Info disclosure / brute force | Room codes (32⁵ ≈ 33 M) could be guessed quickly | `JoinRoom`/`Rejoin` share the lobby bucket (≈ 1 guess per 2 s after a burst of 5) | `Guessing_room_codes_is_throttled` |
| S5 | Spoofing | Seat tokens came from `Guid.NewGuid()` and were compared with a normal string compare | 128-bit tokens from `RandomNumberGenerator`, compared with `CryptographicOperations.FixedTimeEquals`. Bot seats can never be claimed | `Seat_tokens_are_long_random_and_bots_cannot_be_claimed` |
| S6 | Spoofing | The server trusted `X-Forwarded-For` from any sender, so a client could forge its IP to get around per-IP limits | Removed the custom trust-all config. Forwarded headers are honoured only with `ASPNETCORE_FORWARDEDHEADERS_ENABLED=true`, which is set in the Dockerfile for hosting behind a proxy | Code review. Tests run without forwarded headers |
| S7 | Spoofing | Player names could contain invisible bidi overrides or zero-width characters to impersonate others | Unicode *format* characters are rejected (except ZWNJ/ZWJ, which Tamil uses), as are control characters and `<` `>` | `Spoofing_names_are_rejected`, `Real_names_are_accepted` |
| S8 | Tampering / XSS | No browser-side defence in depth | Strict CSP on the game (`script-src 'self'`, `object-src 'none'`, `frame-ancestors 'none'`, `connect-src` limited to this host). A separate CSP for the classic page. `nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, `Permissions-Policy`, COOP. Server banner removed. React escapes all text, and there is no `innerHTML` with user data | `Responses_carry_security_headers...`. Production build played with zero CSP console errors |
| S9 | Info disclosure | `/api/metrics` was public | Loopback only, unless `Security:PublicMetrics=true` | `Metrics_are_not_public_by_default` |
| S10 | Tampering (cheating) | Spamming `Catch` kept the 0.35 s catch window open almost permanently | 0.6 s server-side cooldown between catch presses | `Catch_spam_is_on_cooldown` |
| S11 | Info disclosure | The browser debug hook `window.__gilli` shipped in production builds | Only defined when `import.meta.env.DEV` | Production bundle check |
| S12 | Tampering | Game outcomes (distances, scores, hits) | Already authoritative on the server. Clients send intents only, every action is checked against turn/phase/attempt, and non-finite numbers are rejected | Existing room, hub and rules tests |

### Checked and found fine

* **Dependencies:** `npm audit` reports 0 vulnerabilities (all deps and production deps). `dotnet list package --vulnerable --include-transitive` reports none for all three projects. Lockfiles are committed.
* **Secrets:** none in the repository. No API keys, connection strings or credentials are needed.
* **Errors:** detailed SignalR errors are on only in Development. Production returns a generic problem response. Seat tokens are never logged or broadcast (they go only to their owner in the join reply).
* **CORS:** no cross-origin access in production (the site is served from the same origin). Development allows only `http://localhost:5173`.
* **Transport:** HSTS in production. TLS and WSS come from the hosting platform.

### Residual risks (accepted, documented)

* **Movement is client-predicted.** The server caps speed, keeps players inside the field and out of solid objects, but a modified client can still steer perfectly within those limits.
* **The per-IP cap** can affect many players behind one NAT (raise `Security:MaxConnectionsPerIp` if needed). It does not stop a distributed attack, which needs a platform-level firewall or CDN.
* **The classic page** keeps `'unsafe-inline'` scripts and loads Three.js r128 from cdnjs without Subresource Integrity. It is the unchanged original game and handles no user data.
* **In-memory rooms:** a server restart ends running matches (no data is lost because none is stored).

### Configuration

```json
"Security": {
  "MaxRooms": 300,
  "MaxConnectionsPerIp": 12,
  "MoveRate": 30,
  "ActionRate": 8,
  "LobbyRate": 0.5,
  "AbortAfterRejections": 300,
  "PublicMetrics": false
}
```

Environment variables use double underscores, e.g. `Security__MaxRooms=500`.
