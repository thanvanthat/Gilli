# Kitti Pull 3D (கிட்டிப்புள்)

A 3D browser game of **Kitti Pull / Gilli-Danda**, the traditional Tamil Nadu street game, played on a village maidan with a temple gopuram, thatched huts, kolam, a tea kadai, coconut palms and villagers cheering from the side.

Built with HTML, CSS, JavaScript and [Three.js](https://threejs.org/). The repo also has the same game written in Python using loops and conditions.

## Play

**Option 1: open the file.** Download `index.html` and double-click it. It opens in your browser. (Internet is needed the first time to load Three.js.)

**Option 2: localhost.**
```
python kitti_pull.py
```
Your browser opens at http://localhost:8000. Keep the terminal open while playing. Press Ctrl+C to stop.

## How to play

1. Choose **Computer** or **Friend**, a **Level** (Easy, Normal or Hard) and **players per team** (1 to 3).
2. Toss the coin. The winner chooses to bat or field.
3. **Tap 1** (click, tap or Space) flicks the gilli up. Stop the needle in the yellow zone.
4. **Tap 2** strikes the gilli while it is in the yellow height zone.

| Event | Result |
|---|---|
| Fielder catches the gilli | OUT |
| Fielder's throw hits the danda | OUT |
| 3 misses in a row | OUT |
| Safe hit | Points, and the same player bats again |

When the second team passes the first team's score, the match ends: **Target chased!**

Press **Esc** or **P** to pause.

## Levels

| | Easy | Normal | Hard |
|---|---|---|---|
| Fielders | 3 | 3 | 5 |
| Fielder speed | slow | medium | fast |
| Catch success | low | medium | about 90% |
| Wind | none | light | strong |
| Strike zone | wide | medium | narrow |
| Smart fielding (move to where you hit) | no | no | yes |

## Distance and scoring logic

1. **Hit speed** comes from your timing: `speed = 9 + 13*strikeQuality + 3*flickQuality` (9 to 25 m/s).
2. **Flight** is simulated every frame: gravity (`vy -= 9.8*dt`), wind, a bounce on landing, then rolling with friction.
3. **Distance** from the pit to where the gilli stops (Pythagoras theorem):
   ```
   distance = sqrt(x² + z²)
   ```
4. **Points**:
   ```
   points = floor(distance / 1.5) + 1     # 1 danda = 1.5 m, plus 1 safe-hit bonus
   ```
   Example: the gilli stops at x = 6, z = 24 → distance 24.7 m → 16 dandas → **17 points**.

A `while` loop predicts where the gilli will land the moment it is hit, so the fielders know where to run.

## Python versions

| File | What it uses |
|---|---|
| `python/1_simple.py` | `for`, `while`, `if`, `else` |
| `python/2_full_rules.py` | Full rules (toss, 2 players, catch, danda hit, 3 misses) with only `while`, `for`, `if`, `elif`, `else` |
| `python/3_functions.py` | Functions (`def`), `try/except` |
| `python/4_distance_while_loop.py` | Distance calculated with a `while` loop and gravity |

Run any of them with `python python/1_simple.py`.

## Files

```
index.html        the full 3D game (one file)
kitti_pull.py     runs the game on http://localhost:8000
python/           the Python console versions
```

## Author

Thanvanth AT
