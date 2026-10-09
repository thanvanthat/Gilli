# Gameplay design

These are **this game's selected rules**. Gilli-Danda / Kitti Pull is played many ways across Tamil Nadu and India,
and this document does not claim that every region plays it like this. The rules are configurable in
`server/Gilli.Core/GameConfig.cs` (`RulesConfig`, `PhysicsConfig`).

## Equipment (as simulated)

| Item | Model | Values |
|---|---|---|
| Gilli | BEPU dynamic capsule with tapered ends drawn on the client | 18 cm long, 4.4 cm thick, 60 g |
| Danda (bat) | BEPU kinematic capsule held at one end | 74 cm long, 5 cm thick |
| Danda (target) | BEPU static box across the pit, present only during a throw | 74 cm |
| Pit (kuzhi) | at the origin; the field opens towards −Z | |
| Scoring unit | one danda length | **0.75 m** |

## Match structure

1. **Lobby:** 2 or 4 players, Team A and Team B. Teams must be even (1 v 1 or 2 v 2). Every non-host player
   presses Ready, then the host starts the match.
2. **Toss:** the server flips a coin. The first player of the winning team chooses **Bat first** or **Field
   first** within 15 s. If time runs out, the toss winner bats.
3. **Innings:** each team bats once (`InningsPerTeam = 1`). Batters go in join order and each bats until out or retired.
4. **End:** the side batting second wins as soon as it passes the first side's total (*target chased*).
   Otherwise the higher total wins after both innings, and equal totals are a **draw**.
5. **After the match:** the host chooses **Play again** (new toss, same teams) or **Return to lobby**. Anyone can go to the main menu.

**Practice** is a one-player room: you bat alone with no fielders, real physics and real scoring. It ends after three misses in a row.

## Single player: vs Computer

You are Team A (with 0–2 CPU teammates) against a CPU Team B (1–3 players), on Easy, Normal or Hard. The match
uses the same toss, innings, rules and physics as an online match.

CPU players are server-side seats driven by `Room.Bots.cs`. They call the **same validated actions** as a browser:
`Aim`, `Flick`, `Swing`, `Catch`, `Throw`, and they move at a capped speed inside the field. They get no
shortcut: a CPU hit, catch or throw happens only if the physics says so.

| Behaviour | How it works | Easy | Normal | Hard |
|---|---|---|---|---|
| Batting | Aims randomly within ±26°, flicks after 1–1.9 s, swings ~0.29 s (rising) or ~0.46 s (falling) after the flick, plus Gaussian timing error σ | 75 ms | 45 ms | 25 ms |
| Fielding | After a reaction time, the nearest CPU fielder runs to where the gilli will come down to catching height (predicted with the server's integrator). Others shade towards it | 0.55 s, 5.2 m/s | 0.35 s, 6.3 m/s | 0.2 s, 7.2 m/s |
| Catching | Chance that the chaser goes for the catch this attempt (otherwise it "misjudges"). The catch itself still needs reach and height | 50% | 72% | 90% |
| Throwing | Aims at the pit with the power that lands on it, then adds aim and power error σ | 0.07 rad / 0.07 | 0.04 / 0.045 | 0.02 / 0.025 |
| Toss | If the CPU wins, it chooses after ~2 s (bats 60% of the time) | | | |

Measured in `BotTests`: the CPU completes whole matches on every difficulty. Against Hard fielders, a well-timed
human batter was caught 3 times, faced 5 throws and scored 3 safe hits across 6 matches.

## One attempt

| Phase | What happens | Who acts |
|---|---|---|
| Ready | Gilli lies across the pit. The batter aims (±43°). 25 s limit, after which it counts as a miss. | batter: aim, flick |
| Popped | The flick impulse pops the gilli to ~1 m with a little spin. The batter gets one swing. | batter: swing · fielders: may pre-press catch |
| InFlight | The danda hit the gilli. It flies, bounces and rolls until it rests. | fielders: run, catch |
| AwaitThrow | The connected fielder nearest the resting gilli picks it up there. The danda is laid across the pit. 15 s limit. | thrower: aim, charge, throw |
| Throwing | The thrown gilli is simulated. Touching the danda, or first landing within 1 m of the pit, is a target hit. | — |
| Result | The result is shown for 3.2 s, then the next attempt, batter or innings starts. | — |

### Outcomes (each attempt resolves exactly once)

| Event | Outcome | Points |
|---|---|---|
| Swing misses, no swing before the gilli lands, or 25 s flick timeout | **Miss** (+1 consecutive miss) | 0 |
| Hit, but the gilli stops behind the batting line (z > 0.5 m) or within 2 m of the pit | **Miss** (mishit) | 0 |
| Fielder catches the gilli before its first ground contact | **Out: caught** | 0 |
| Throw hits the target | **Out: danda hit** | 0 |
| Throw misses, no throw within 15 s, or no fielder connected | **Safe** | floor(d / 0.75) + 1 |
| 3rd consecutive miss | **Out: three misses** | 0 |
| 8th attempt of a batter finishes (safe or miss) | batter **retires** (not a dismissal) | as earned |
| Batter left or disconnected for more than 20 s | batter **retires** | 0 |

* The consecutive-miss count resets after every safe hit. The attempt count does not reset.
* `d` is the horizontal distance from the centre of the pit to where the simulated gilli comes to rest, rounded to
  1 cm. Points are computed from that rounded value, so every client shows the same number. Example: 27.40 m →
  floor(36.53) = 36 dandas + 1 bonus = **37 points**.
* The HUD shows the landing distance (first ground contact), the resting distance, the danda count, the bonus and the
  updated score.

## Catching

* Only fielding-team players can catch. Press **Space / F / click**.
* A press stays live for 0.35 s. During that time the server checks every physics step whether the gilli is within
  **1.6 m** horizontally of the fielder, between **0.15 m and 2.7 m** high, and has not touched the ground yet.
* A green ring around your fielder shows your reach while the gilli is in the air.

## Throwing at the danda

* The thrower releases from 1.5 m above the resting point. Speed is 6–30 m/s depending on charge (the charge rises and
  falls, so timing the release matters). Elevation is 3°–69°. Yaw is free.
* A dashed preview arc uses the same gravity and drag integrator as the server. The server still decides the outcome.

## Physics model

* **Engine:** BEPUphysics v2.4 on the server, one simulation per room. Fixed 120 Hz step, with **8 substeps** (960 Hz)
  while the danda is swinging so the 32 rad/s danda cannot tunnel through the 4.4 cm gilli. The gilli uses continuous
  collision detection.
* **Swing:** the danda rotates about an axis through the batter's hands, tilted back 25°. At the moment it points
  at the pit it moves forward and upward at ~16 m/s. The swing lasts 0.13 s. The aim angle rotates the whole rig around the pit.
* **Impact:** BEPU's narrow phase detects the danda–gilli contact. The server then applies
  `j = (1 + e)·v_n / (1/m + n·((I⁻¹(r×n))×r))` at the contact point (e = 0.5) plus Coulomb friction (μ = 0.3).
  Off-centre contact therefore changes both direction and spin. One impulse per swing.
* **Flight:** gravity 9.81 m/s², quadratic drag `a = −0.012·|v|·v` (tuned for gameplay), angular damping.
* **Ground:** BEPU contact with friction 0.65. BEPU v2 has no restitution coefficient, so bounces restore 30% of
  the incoming normal speed above 1.2 m/s. Rolling drag applies while in ground contact.
* **Rest:** the gilli counts as at rest when speed < 0.15 m/s and spin < 2 rad/s for 0.3 s (9 s safety timeout).
* **Solid objects:** trees, banyan platforms, houses, the tea kadai, the cart, the water tank and the temple walls are
  static colliders built from the same layout the browser draws (`GET /api/layout`).

Measured spread (see the `Swing_timing_sweep` test): swings pressed 0.20–0.52 s after the flick connect, and clean
hits travel 8–33 m. Too early or too late is a clean miss.

## Multiplayer model

* **Authority:** the server owns physics, rules, turns, scores and outcomes. Clients send intents only: `Flick`,
  `Swing`, `Catch`, `Throw(yaw, pitch, power)`, `Aim`, `Move(x, z, yaw)`, plus lobby actions.
* **Validation:** every action carries the current `attemptId`. Wrong turn, wrong phase, stale attempt, duplicate
  flick/swing/throw and non-finite numbers are rejected with a reason code.
* **State:** full room state (versioned) is sent on every change. Events drive sounds and banners. Motion snapshots
  (~400 bytes) go out at 30 Hz while the gilli moves and 10 Hz otherwise.
* **Client rendering:** interpolation 100 ms behind the server clock. An airborne gilli is extrapolated
  ballistically from the newest snapshot (the batter sees it half a round trip ahead), and corrections are smoothed.
* **Movement:** the client predicts locally. The server limits speed (7.5 m/s × 1.35 tolerance), clamps to the walkable
  circle and pushes players out of solid objects. The client snaps to the server position if they disagree by more than 2.5 m.
* **Connections:** automatic reconnect with backoff. The seat is re-claimed with a per-player token (kept in
  `sessionStorage`, so a reload in the same tab resumes). Disconnected players show as offline. In the lobby they are
  removed after 20 s. In a match the batter retires, a missing thrower forfeits the throw, and a team that is
  entirely gone forfeits the match.

## Visual identity

Village signboard style: terracotta (kumkum) red, turmeric yellow, indigo and leaf green on chalk white, with
*Yatra One* for display and *Hind Madurai* (Tamil-capable) for text. Kolam dot motifs decorate the cards and logo.
The scene includes a red-earth maidan fading into village grass, whitewashed boundary stones, chalk distance arcs,
coconut groves, neem trees inside the field edge, banyan trees with stone platforms, Mangalore-tile and thatched
houses with thinnai and kolam, a tea kadai with a Tamil signboard, a striped temple wall and gopuram, a
festival thoranam, paddy fields, haystacks, a well and distant hills.
