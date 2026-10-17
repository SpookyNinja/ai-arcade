# Autopilot Arcade — design spec

A background "second screen" web app: press **Start**, a random game begins, an AI plays it
well, and when the game ends (win or loss) a result card shows and the next random game
starts. Runs forever. Must look smooth and satisfying on a dark second monitor, fullscreen.

## Files

```
ai-arcade/
  DESIGN.md                this spec
  src/core.js              shared helpers + game contract (Arcade.register, Particles, InputQueue, ...)
  src/games/<id>.js        one file per game, each calls Arcade.register({...})
  src/shell.js             start screen, rotation, transitions, HUD, controls
  src/shell.css
  src/index.template.html  page markup; build inlines everything
  build.py                 -> dist/ai-arcade.html (standalone, full document, double-click to run)
                           -> dist/artifact.html  (same, minus <!doctype>/<html>/<head>/<body> wrappers)
  tools/dev.html           dev harness: tools/dev.html?game=<id>&speed=4
  tools/run.mjs            headless test: node tools/run.mjs <id> [rounds] [maxSec]
```

No build tools, no npm deps, no server. Plain ES2020 in classic `<script>`s that share globals
(`'use strict'`, wrap each game file in an IIFE so helpers don't collide).

## Game contract (see src/core.js)

```js
Arcade.register({ id, name, genre, blurb, bg, accent, create() { return instance; } });
instance.resize(W, H)   // CSS px. Lay out the board to fit, centered, with ~6% margin. Must handle any aspect (16:9 to 4:3, also small windows).
instance.step(dt)       // dt = 1/60 always. Advance game rules, animations' logical timers, AND the AI.
instance.draw(ctx,W,H)  // paint EVERYTHING incl. full background every frame. No DOM.
instance.over / won     // flags; once over=true keep animating the end (explosion, fade) in draw/step
instance.hud()          // {score, detail} short strings for the shell overlay
instance.result()       // one short sentence for the end card, e.g. "Reached the 2048 tile in 912 moves"
```

Rules for every game:
- Fixed timestep logic in `step`; `draw` must be pure rendering (it may read time accumulated in step). The headless test calls `step` thousands of times without `draw`, so `step` must not depend on `draw`.
- Each game should normally finish in **1.5 to 4 minutes** of game time. Every game has a win condition AND a way to lose. Add a hard safety cap (e.g. 6 minutes) that ends the game as a loss ("Out of time") so rotation never stalls.
- Performance: 60 fps at 2560x1440. Avoid `shadowBlur` on many shapes per frame; fake glow with a wider low-alpha stroke or a cached radial gradient sprite (offscreen canvas).
- Draw nothing about the shell (no game title, no score overlay chrome); the shell's HUD shows name + `hud()` in the bottom-left corner. Games may draw in-world score elements if they're part of the look (e.g. floating "+1"), but keep the bottom-left ~320x70 px corner free of important content.
- Games fill the whole canvas with their own background (no black bars): extend the background pattern/gradient beyond the board.

### Fair play (the AI must not cheat)

1. **Observation only.** The AI is a separate object/function in the game file. Each tick it gets an
   `observe()` snapshot containing only what a human sees on screen at that moment (board,
   visible pieces, positions). Hidden state (RNG, upcoming random spawns, mine positions,
   undrawn future pipes, next pieces beyond the shown preview) is never in the snapshot.
   Velocities are allowed only where a human sees motion (estimate from the last two
   observed positions, or pass the drawn velocity if it is obvious on screen).
2. **Same input limits as a human.** The AI acts only through the inputs a player has
   (keys, clicks, a tap) and at human speed: use `InputQueue` or explicit cooldowns. Paddle/cursor
   movement has a max speed. Note the limit for each game below.
3. **Same rules.** No special powers, no undo, no peeking. Knowledge of the game's physics
   constants is fine (a skilled player learns them).

### Look and feel (shared)

- Every game has its **own** visual identity (palette, shapes, type) listed below. All are
  dark-leaning so a second monitor isn't blinding, but they shouldn't all be "black + neon".
- Smoothness is the point: interpolate movement between logic ticks, ease everything
  (`ease.outCubic`, `ease.outBack`), animate spawns/merges/clears, particles on scoring,
  gentle camera/screen moves, slow ambient background motion.
- Fonts available (loaded by the shell from Google Fonts; always give a fallback):
  `"Big Shoulders Display"` (shell/display), `"IBM Plex Mono"` (numbers), `"Fredoka"`
  (rounded, friendly), `"Fraunces"` (serif). Canvas: `ctx.font = '600 20px Fredoka, sans-serif'`.

---

## Shell (src/shell.js, shell.css, index.template.html, build.py)

Name: **Autopilot Arcade**. Page `<title>Autopilot Arcade</title>`.

**Start screen** (DOM over an animated canvas backdrop): wordmark "AUTOPILOT ARCADE" in Big
Shoulders Display 800, one line "Sit back. The machine plays.", a big **Start** button, and a
grid of the registered games (small card each: color swatch from `accent`/`bg`, name, genre,
blurb; plus this browser's AI record "3 W · 1 L" from localStorage, wrapped in try/catch).
Each card has a toggle to include/exclude it from the rotation (saved in localStorage; at
least one must stay on). Backdrop: slow drifting soft color blobs or a faint animated grid —
calm. Palette for the shell: deep blue-graphite `#0d1117`-ish with warm off-white text and
one amber accent; avoid acid green and purple-blue gradients.

**Start** → request fullscreen (ignore failures), request a screen wake lock (ignore
failures; re-request on visibilitychange), pick a random enabled game, begin rotation.

**Rotation state machine** per game:
1. `intro` (1.8 s): game is created, resized, drawn but NOT stepped. Title card over it:
   genre in small caps, game name large, accent-colored underline; fades out.
2. `play`: step at fixed 60 Hz with an accumulator (cap 5 steps/frame; if the tab was
   hidden, don't fast-forward minutes — clamp). Speed multiplier (1x default).
3. `ending` (2.5 s after `over` turns true): keep stepping/drawing for the end animation.
4. `card` (4 s): dim the frame, show result card: "AI WON" / "AI LOST" (won = accent color,
   lost = muted coral), `result()` text, final score, and "Next: <name>" with a thin progress bar.
5. crossfade (0.8 s) into next game's `intro`. Next game is drawn from a shuffle bag of
   enabled games so it never repeats until all have played, and never the same game twice in a row.
   Record W/L in localStorage.

**HUD** (bottom-left, small, semi-transparent, tabular numbers): game name, then
`hud().score` and `hud().detail`. A tiny "AI" chip. Fades to 35% opacity after a few seconds.

**Controls**: when the mouse moves, show a small control bar (top-right): Skip (next game),
Pause/Resume, Speed (1x/2x), Fullscreen, Menu (back to start screen). Hide bar and cursor
after 2.5 s idle. Keys: `N` next, `Space` pause, `F` fullscreen, `H` hide HUD, `Esc` menu
(when not in fullscreen), `1`/`2` speed.

**Errors**: wrap each game's step/draw in try/catch; on exception, log it and move on to the
next game (so one bug never freezes the second screen).

**Canvas**: one full-window canvas, devicePixelRatio-aware (cap DPR at 2), resize on window
resize → `instance.resize`.

**URL hooks for testing** (query string; ignored in the artifact where it doesn't arrive):
`?game=<id>` start directly with that game, `?autostart=1` skip the start screen,
`?speed=4`. Expose `window.__arcade = { state, current }` for tests.

**build.py**: reads `src/index.template.html` which contains markers `/*CSS*/` and
`/*JS*/`; inlines shell.css, then core.js + all `src/games/*.js` (sorted) + shell.js.
Writes `dist/ai-arcade.html` (complete document) and `dist/artifact.html` (only the inner
part: `<title>`, `<meta name="claude:viewport-fit-sides" content="cover">`, font `<link>`,
`<style>`, body markup, `<script>`; no doctype/html/head/body tags). Fonts link:
`https://fonts.googleapis.com/css2?family=Big+Shoulders+Display:wght@500;800&family=IBM+Plex+Mono:wght@400;600&family=Fredoka:wght@500;600&family=Fraunces:opsz,wght@9..144,600&display=swap`.
In artifact mode the page is wrapped in a skeleton with `:root` safe-area padding: make
html/body `height:100%`, body background `#0d1117`, canvas `position:fixed; inset:0`.

---

## The games

Difficulty target: the AI should look **expert** and win often, but lose sometimes
(roughly 55–85% wins), because losses come from the game's own rising difficulty or luck,
never from deliberate AI mistakes — except where the human limit is reaction/timing noise
(Stack), which is modeled honestly.

### 1. `snake` — Serpent Garden (Snake)
- **Look**: a moss-and-jade garden at night. Background deep green-teal `#0b1f1c` with a
  subtle checker of two close greens on the board; soft vignette. Snake is ONE continuous
  rounded tube (round caps/joins), gradient from bright jade head to deep teal tail, with
  a faint lighter stripe along its back; head has two small eyes looking in the move
  direction. Food is a glowing amber berry that pulses; eating it → ring ripple + particles.
- **Smoothness**: logic moves one cell per tick; draw interpolates: path = interpolated head,
  body[1..n-1] cell centers, interpolated tail (lerp prev tail → current tail by tick progress).
- **Rules**: board 20x12 cells (size cells to fit). Speed starts 10 moves/s and rises to 24
  as length grows. Grow by 1 per berry. Hitting wall or self = loss (death: snake flashes and
  dissolves into particles from head to tail). Moving into the cell the tail is leaving is legal
  (unless growing that tick).
- **Win**: length ≥ 110 (≈46% of board). Show "+1" floaters is optional.
- **AI** (sees full board, like a human): (1) BFS shortest path head→berry; simulate the snake
  along it; if from the virtual head the virtual tail is reachable (BFS), take the path's first
  step. (2) Else "chase tail": among safe moves from which the tail is reachable, pick the one
  with the **longest** BFS distance to the tail (stalls safely). (3) Else pick the move with the
  largest flood-fill area. Input limit: one direction change per move tick (same as a human).

### 2. `tetris` — Glass Stack (falling blocks)
- **Look**: midnight indigo `#0e1030` backdrop with slowly drifting large blurred bokeh
  circles in piece colors at low alpha. Well is a frosted dark glass panel with faint
  grid. Blocks are glassy: vertical gradient of the piece color, 1px inner highlight on
  top-left, slight inner shadow bottom-right, rounded 3px corners. Ghost piece shows the
  landing spot as an outline (this also visualizes the AI's plan). Right side panel: "NEXT"
  preview (1 piece only), lines, level. Line clear: rows flash white, then shrink to a
  bright horizontal line that bursts into particles, then rows above fall with easing (0.25 s).
  Hard drop: a short vertical light streak from start to landing.
- **Rules**: 10x20, 7-bag randomizer, simple SRS rotation with kicks (try x offsets 0,−1,+1,−2,+2
  then up 1). Gravity interval = max(0.05, 0.8 − 0.07·level) s per row, level = floor(lines/10).
  Lock delay 0.4 s. Top-out = loss. Score: 100/300/500/800 × (level+1).
- **Win**: 150 lines.
- **AI**: observes the board, current piece and the ONE visible next piece. For every
  reachable placement (rotation, x) of the current piece, and for each of those every placement
  of the next piece, evaluate with El-Tetris (Dellacherie) features: landing height −4.500158825,
  rows cleared +3.418126810, row transitions −3.217888287, column transitions −9.348695305,
  holes −7.899265427, well sums −3.385597225. Pick the best first move. Inputs via `InputQueue`
  at 1 action / 0.07 s (≈14 inputs/s — fast human), after a 0.12 s "read" delay on spawn: rotations,
  then left/right steps, then hard drop. Gravity keeps acting while inputs execute.

### 3. `breakout` — Prism Breaker (brick breaker)
- **Look**: dark violet `#140a24` with a slow radial gradient and faint diagonal light
  rays. Bricks are rows of jewel tones (a hue sweep top to bottom), slightly beveled with a
  top highlight. Ball is white-hot with a fading comet trail (last ~14 positions). Paddle is
  a pill of light with a soft underglow. Brick break: brick shatters into 6–10 small shards
  that tumble with gravity + sparkle particles; tiny screen shake (2 px, decays fast).
- **Rules**: logical field 1000x760 scaled to fit. 12x8 bricks, layout picked randomly from
  4 patterns (full wall, pyramid, diamond, checker with 2-hit armored bricks). Ball speed 520,
  +12 per paddle hit, max 860. Paddle width 130, **max speed 1100 units/s** (human-like). Bounce
  angle from paddle = offset ∈ [−1,1] × 60° from vertical. Use substeps to avoid tunneling.
  3 lives (shown as small dots). Ball lost = −1 life, relaunch from paddle after 1 s.
- **Win**: all bricks cleared. Loss: no lives, or 6-minute cap.
- **AI**: estimates ball velocity from its last two observed positions. When the ball is coming
  down, predict where it crosses the paddle's y (reflect off side walls). Choose an aim: for
  offsets −0.85..0.85 step 0.05, cast the outgoing ray (with wall bounces) and score which brick
  it would hit first — prefer hits that open a channel above the wall, and bricks in sparse
  areas when few remain; small penalty for extreme offsets. Move the paddle toward
  `landingX − offset·halfWidth` at max speed. When the ball goes up, drift toward the
  predicted area / center.

### 4. `merge` — Twenty Forty-Eight (2048)
- **Look**: deep plum `#1d1026` backdrop, board a rounded dark slab with inset cells. Tiles
  are candy-colored rounded squares on a gradient ramp by value: 2 dusty lilac → 8 coral →
  64 tangerine → 256 gold → 1024 mint → 2048 bright cyan with a gentle glow. Numbers in
  Fredoka 600, dark on light tiles, light on dark. Animation: slide 110 ms ease-out, merge pop
  (scale 1→1.18→1 outBack), spawn grow from 0 (outBack), score "+N" floats up from the board.
- **Rules**: standard 2048; spawn 2 (90%) or 4 (10%).
- **Win**: reach the 2048 tile. Loss: no moves.
- **AI**: expectimax over spawn chances (spawns are random, not peeked). Use the classic
  bitboard approach: rows as 16-bit numbers (4 nibbles of log2), precomputed 65536-entry tables for
  row moves and heuristic. Heuristic per row/column (nneonneo): lost penalty 200000, monotonicity
  power 4 weight 47, sum power 3.5 weight 11, merges weight 700, empty weight 270. Depth
  adaptive (≥3 when few empty cells), prune chance nodes below cumulative probability 0.0001, cache.
  Input limit: one move per 0.13 s and never while the slide animation is still running.

### 5. `mines` — Frostfield (Minesweeper)
- **Look**: arctic blueprint. Background deep slate blue `#0f1b2b` with a faint topographic
  contour pattern. Unrevealed cells are raised frosty tiles (pale blue-white gradient, top
  highlight); revealed cells are flat, darker, slightly translucent. Numbers in IBM Plex Mono 600
  with distinct cool-to-warm colors (1 sky, 2 teal, 3 coral, 4 violet, 5 crimson, 6 cyan, 7 white, 8 grey).
  Reveals ripple outward from the click (each cell flips with delay ∝ distance). Flags: small red
  pennant drops in with a bounce. The AI's **cursor** is a soft white ring that glides between cells.
  Loss: the hit mine flashes, a shockwave ring, then all mines pop in sequence. Win: a sweep of light.
- **Rules**: 30x16, 99 mines, first click is guaranteed to open (no mine in the 3x3 around it).
- **Win**: all safe cells revealed. Loss: reveal a mine.
- **AI**: knows only revealed numbers and its own flags. Order of reasoning: (a) single-cell rules,
  (b) subset rule over pairs of constraints, (c) when stuck, exact probabilities: split the frontier
  into connected components, enumerate each component's consistent mine assignments with
  backtracking (cap ~45 cells per component; above that fall back to local estimates), combine
  components with the global mine count weighting C(remaining interior cells, remaining mines − k),
  compute every unknown cell's mine probability, click the lowest (tie-break: prefer corners/edges for
  interior cells, prefer frontier cells otherwise). It flags certain mines (for the look).
  Input limit: the cursor moves at most 1800 px/s with easing, then 0.08 s click delay; ~6–8
  actions/s max. Cascades from a zero do not cost actions (game rule).

### 6. `glide` — Lantern Glide (flappy)
- **Look**: dusk festival. Sky gradient indigo top → warm apricot horizon; 3 parallax layers of
  mountain/hill silhouettes in cool purples; drifting fireflies. The player is a paper lantern
  (rounded red-orange body, light ribs, glowing flicker, a little tilt with velocity). Obstacles
  are bamboo stalks (green-gold gradient, segment rings) from top and bottom with a gap. Passing a
  gap: soft chime-like sparkle and "+1". Crash: lantern tumbles, flames out to embers.
- **Rules**: logical height 600 (width from aspect). Gravity 1500 u/s², flap sets vy = −470.
  Scroll speed 230 u/s rising +3 per point (cap 330). Gate spacing 300 units; gap height
  175 shrinking to 135 by score 50; gap center moves up to ±(80 + 2·score, cap 200) from
  the previous gap. Hitting a stalk, the ground or the sky ceiling = loss.
- **Win**: 60 gates.
- **AI**: sees bird y and its motion, and only the stalks currently on screen. Each tick: decide
  flap or wait (min 0.12 s between flaps — a human tap rate). Model-predictive check: simulate
  "wait now" and "flap now", each followed by a greedy policy (flap when y is below the target
  line of the next visible gap and falling) for 1.4 s against the visible stalks; choose wait if it
  survives, else flap if it survives, else whichever survives longer.

### 7. `stack` — Skyline Stack (stacking timing game)
- **Look**: isometric tower of slabs in soft pastel hues that shift slowly floor by floor;
  background is a vertical gradient matching the current hue (darkened, low saturation) with a
  few slow clouds. Slabs are drawn as isometric boxes (top face lightest, two side faces darker).
  The camera eases upward as the tower grows. Perfect placement: white ripple ring around the slab
  and a soft "streak" counter; cut-off overhang falls away, rotating, fading.
- **Rules**: a slab slides back and forth along x, then next floor along z, alternating, starting
  speed 1.1 units/s (slab start width 1.0, travel ±1.3), speed +0.02 per floor. Tap drops it: the
  overlap stays, the overhang is cut off. Within 0.025 of perfect = snaps perfect (no cut). Every
  5 consecutive perfects grows the slab back 0.05 (up to 1.0). Zero overlap = loss.
- **Win**: 80 floors.
- **AI**: watches the moving slab; computes when it will align with the slab below (from observed
  position and speed) and schedules a tap. Honest human motor noise: the tap fires with Gaussian
  timing error σ = 14 ms (so position error grows with speed — that's what eventually makes it lose).
  No other information.

### 8. `maze` — Lamplight Labyrinth (maze exploration in fog)
- **Look**: ink-blue `#0a1426` parchment-dark background with a faint grain; unknown areas show a
  dotted grid; discovered walls are drawn as warm gold lines that fade/draw in as they are seen;
  visited floor gets a faint warm wash; the explorer is a small lantern-light orb with a soft light
  radius and a fading trail. The exit is a pulsing teal beacon (always visible). The AI's current
  planned route is a faint dashed line.
- **Rules**: perfect maze (recursive backtracker, with ~6% extra walls removed to create loops),
  sized ~33x19 cells to fit. Explorer starts at a random cell on one side, exit on the opposite side.
  Explorer sees: its own cell's walls plus straight lines of sight along open corridors in the 4
  directions (stops at a wall), including the side walls of each seen cell. Moves 7 cells/s with
  smooth interpolation. 
- **Win**: reach the exit. Loss: 70 s time limit (show a subtle timer ring around the beacon).
- **AI**: "freespace assumption" planning (like D* Lite): A* to the exit over known walls,
  assuming unknown walls are open; move one step; update what is now seen; replan. One step per
  move tick (no teleporting).

---

## Round 2 (new games + changes)

### Changes to existing games
- `merge`: the AI must play at **full strength** (Andre wants a very good AI; weakening the search is
  not allowed). Use adaptive depth (2 with many empties, 3–4 with few), with a ~25 ms time guard.
  Raise difficulty through the goal instead: **win = reach the 4096 tile**. Move interval 0.09 s
  (slide animation shortened to 80 ms to match). Target ~3–4.5 min per game.
- `maze`: 2.2 cells/s is too slow to be fun. Walk **6 cells/s**. The game becomes **3 floors** of
  growing size (≈25x14, 33x19, 41x23 cells, scaled to fit). Reaching a floor's exit: beacon flare, the
  whole floor lights up from the exit outward, then the camera zooms into the stairs and the next
  floor fades in (~2 s). One shared time budget for all three floors shown as the ring; tune it so the
  AI wins ~70%. Win = clear floor 3.

### 9. `solitaire` — Brass & Burgundy (Klondike)
- **Look**: oxblood/burgundy felt `#3a0f17` with a subtle woven noise texture and a soft spotlight
  vignette; brass-gold outlines for empty piles and foundations (suit glyph faint inside). Cards are
  ivory with rounded corners, crisp red/black suit pips (draw suits with canvas paths, large center
  pip + corner index in Fraunces), card backs deep navy with a gold geometric lattice. Cards fly
  between piles on a gentle arc (0.22 s, outCubic) with a small lift shadow; flipping a face-down card
  is a horizontal scale flip. **Win**: the classic bouncing card cascade (cards leap off the
  foundations and bounce down the screen leaving trails) for ~4 s.
- **Rules**: Klondike, draw 1, unlimited passes through the stock. Deal is a fully random shuffle.
- **Loss**: the AI makes no progress (no new card to foundation or tableau reveal) over a full pass of
  the stock without any productive move, or 6-minute cap → "No moves left".
- **AI** (sees only face-up cards; face-down cards are unknown): priority-based with a short lookahead
  on visible information. Priorities roughly: move to foundation when safe (no card of opposite color
  one rank lower still needed); moves that reveal a face-down card (prefer the pile with the most
  face-down cards); kings to empty columns only if it frees something; waste→tableau; stock draw last.
  Avoid ping-pong loops (remember visible-state hashes). Moves at most every 0.35 s (cards in flight
  ~0.22 s).

### 10. `bubbles` — Bubble Reef (bubble shooter)
- **Look**: deep sea: blue-teal gradient `#06283d`→`#0b4f6c`, light shafts from the top swaying
  slowly, drifting plankton motes, kelp silhouettes on the sides. Bubbles are glossy (radial gradient,
  white specular highlight, slight rim) in 6 reef colors (coral, sea-glass green, sun yellow, lagoon
  blue, urchin purple, shell pink). Launcher is a brass-and-shell cannon at bottom center with an
  aiming guide dotted line (only the first segment + one bounce, like many real games — this is
  shown to the AI as well; the AI may compute further bounces itself since a human can too).
  Pops: bubble bursts into droplets and a ring; orphaned bubbles drop with gravity and fade.
- **Rules**: hex grid 15 columns wide (offset rows), 9 starting rows. Shoot current bubble; next
  bubble is shown. Match 3+ same color = pop; unattached bubbles fall. Every 6 shots without a pop,
  the ceiling drops one row (with a grinding shake). Bubbles crossing the danger line = loss.
  Bubble colors drawn only from colors still on the board.
- **Win**: board cleared. 
- **AI**: for aim angles every 0.4° in the allowed range, simulate the shot with wall bounces to find
  the landing cell. Score: bubbles popped + 1.5× bubbles dropped, bonus for hits that set up the
  NEXT bubble's color, penalty for landing low/near the danger line and for burying bubbles of a
  color that's becoming rare. Launcher rotates at most 200°/s; fires after settling 0.1 s.

### 11. `asteroids` — Orbital Drift (asteroids)
- **Look**: not black: deep eclipse blue `#0b1030` with a big softly glowing planet limb at one corner
  and slow parallax star dust. Asteroids are lumpy polygons with filled dark rock and a warm sunlit
  rim stroke on one side (consistent light direction). Ship: sleek white-gold arrowhead with an
  engine flame that flickers when thrusting. Bullets are short glowing dashes. Explosions: debris
  shards + glowing ring; big rocks split in two with a satisfying crack.
- **Rules**: classic: screen wraps, ship rotate 240°/s, thrust accel 380 u/s² with drag, max 4
  bullets on screen, fire cooldown 0.18 s, bullet life 1 s. Waves of 4,5,6,... large rocks; large →
  2 medium → 2 small. 3 lives, 2 s invulnerability on respawn (respawn when center is clear).
- **Win**: clear wave 6. **Loss**: all lives lost.
- **AI** (sees all positions and motion): each tick, compute intercept solutions for every rock
  (accounting for wrap) and pick the target with the least time-to-aim+time-to-hit; rotate toward
  the lead angle at max turn rate, fire when within ~3° and bullet will hit. Danger check: predict
  closest approach of each rock over the next 1.2 s; if one comes within a safety radius, turn and
  thrust away perpendicular (or shoot it if aligned). Keep speed low (brief thrusts only).

### 12. `chase` — Night Market (maze chase)
- **Look**: a night market maze: dark plum-navy streets `#140f24`, walls drawn as rounded lane
  borders in warm stall-light amber with soft glow; pellets are tiny paper lanterns (warm dots), power
  pellets are bigger glowing lanterns. The player is a round golden dumpling-like muncher with a
  chomping mouth; the 4 chasers are colorful paper-kite ghosts (each a distinct color: crimson, jade,
  saffron, sky) with fluttering tails. Frightened chasers turn indigo with a flicker before expiring.
  Eating a chaser: it pops into confetti and its eyes float back home.
- **Rules**: classic Pac-Man-style maze (28x31 tiles layout — design an original layout with the
  same feel, symmetric, with a ghost house and side tunnels). Chasers alternate scatter/chase phases
  with classic targeting (direct, ahead-of-player, pincer, shy). Power lantern = 7 s frightened (less
  on level 2). 3 lives.
- **Win**: clear 2 levels. **Loss**: all lives lost.
- **AI** (sees the whole board like a human): at each tile decide the direction by a short
  search (depth ~ 3 junctions) over the maze graph, scoring pellets collected, distance to nearest
  pellet when none on path, and heavy danger penalties from predicted chaser positions (each chaser
  assumed to move toward the player — a cautious human model; frightened ones are targets if
  reachable before they recover). Use power lanterns when chasers are close. One direction input
  per tile (human-like; can pre-turn like a human).

---

## Round 3 (new games)

### 13. `pinball` — Clockwork Pinball
- **Look**: a steampunk/brass clockwork table, but dark: walnut-black playfield `#17110c` with
  engraved brass rails, copper bumpers that ring (flash + expanding ring when hit), slowly turning
  gear silhouettes in the background art under a glass sheen, warm filament-bulb inserts that light
  up as targets are completed. Ball is polished steel (radial gradient + moving specular highlight)
  with a short motion blur trail. Flippers are brass with rubber edges. Score shown on an in-table
  "nixie tube" style display at the top (part of the art; keep the shell HUD corner free).
- **Rules**: portrait table fitted to the screen height (logical 600x1000). Real-feeling physics:
  gravity along the table, circle-vs-segment collisions with restitution, substeps (≥8 per tick),
  flippers as rotating segments that impart velocity (angular speed ~ 25 rad/s up). Elements: 3 pop
  bumpers, 2 slingshots, a bank of 4 drop targets (complete = multiplier up), 2 lanes at top
  (light both = bonus), an orbit ramp loop on the left. Plunger launch with slight random strength.
  Drain between flippers and side outlanes. 3 balls. No tilt.
- **Win**: reach a target score (tune so a good game hits it in ~2–3.5 min). **Loss**: 3 balls drained.
- **AI** (sees ball position and motion): it only presses the left/right flipper buttons (and the
  plunger). Predict the ball path a short horizon ahead with the known physics; flip when the ball
  will be in the flipper's sweet spot at the moment the flipper reaches mid-swing (flipper takes
  time to rise — the AI must anticipate). Aim: choose early/late flips to send the ball toward
  unlit targets/the orbit. Catch/hold: hold a flipper up to trap a slow ball, then release and
  shoot deliberately (a real expert technique). Reaction latency ≥ 40 ms.

### 14. `sudoku` — Ink & Paper (sudoku solving)
- **Look**: a warm dark desk: deep walnut background with a soft lamp pool of light; the puzzle is
  an off-white paper card with a subtle fiber texture, slightly rotated (~-1.5°) with a soft shadow.
  Grid lines in printed navy; givens printed in navy Fraunces; the AI's digits are "handwritten"
  — draw them with an animated stroke reveal (render the glyph progressively, left-to-right
  clip reveal over 0.25 s) in fountain-pen blue-black. Pencil marks (candidates) in small light
  grey. A ghostly pen-tip cursor moves between cells. When a technique fires, briefly highlight the
  involved unit/cells with a translucent marker-yellow wash and a tiny label in the margin
  ("Naked pair", "X-Wing"...).
- **Rules/flow**: generate (or embed a list of ~40) hard puzzles with unique solutions. The AI fills
  in pencil marks first (fast sweep), then solves with human techniques in order of simplicity:
  naked single, hidden single, naked/hidden pairs/triples, pointing pairs, box-line reduction,
  X-Wing, Swordfish, XY-Wing; if stuck, it **guesses** (bifurcation) on a bivalue cell, writing the
  guess in red ink — a wrong guess leads to a contradiction, erasing back with a smudge animation.
  It may make a wrong guess, but it never reads the solution. 
- **Win**: grid solved (sweep of green check marks, the card lifts slightly). **Loss**: time limit
  (~3.5 min) reached; tune puzzle difficulty so it wins ~80% (losses from long guess chains).
  Actions are human-paced: ~3 digits/s, eliminations shown in batches.

### 15. `runner` — Canyon Runner (auto runner)
- **Look**: desert canyon at golden hour: layered sandstone mesas in 4 parallax layers (rust,
  terracotta, ochre, hazy lilac far), a big low sun with heat shimmer, tumbleweeds. The runner is a
  small courier fox (simple geometric shapes, animated run cycle with legs/tail) — or an abstract
  runner if that reads better. Obstacles: cacti (jump), low rock arches (slide), gaps (jump), and
  hawks (duck). Dust puffs on landing, speed lines at high speed.
- **Rules**: constant forward speed ramping from 360 to 720 u/s; jump (variable height by hold
  duration, up to 0.25 s), slide/duck (0.6 s). Obstacles generated with spacing that's always
  clearable at the current speed (validate with the physics). Collision = loss.
- **Win**: run 3000 m (tune so ~2.5–3.5 min). Distance on an in-world mile marker sign is optional.
- **AI**: sees only on-screen obstacles. Uses known jump physics to choose jump timing and hold
  duration (plan via short simulation over the visible window); reaction latency 80 ms ± 15 ms
  Gaussian, which (with speed) creates the occasional loss.

### 16. `hockey` — Ice Hockey Duel (air hockey: AI vs house bot)
- **Look**: an air-hockey table seen from above, cool ice/arctic: frosted white-blue surface
  `#dfeaf2`?? NO — keep it dark-leaning: deep glacier blue table `#0e2a3a` with faint ice
  scratches, glowing goal slots, two mallets (Autopilot AI = warm amber, house bot = cool cyan),
  white puck with a trail; air-table dot pattern faintly visible. Goal: flash + ripple + score tick.
- **Rules**: classic air hockey, first to 7 goals. Mallets have max speed and acceleration
  (equal for both). Puck physics with wall restitution and slight friction.
- **Players**: the bottom mallet is the Autopilot AI (the one whose win/loss counts). The top is
  a decent but simpler "house" bot (defend-the-goal + straight shots) with the same physical
  limits. Autopilot AI: predicts puck path with wall bounces, intercepts, uses bank shots aimed
  off the side wall into the goal, defends by staying between puck and goal. Tune the house
  bot so Autopilot wins ~70%.

---

## Round 4

### Smooth motion on high-refresh monitors (shell + games)
Logic runs at a fixed 60 Hz. On 120/144 Hz displays, frames between steps repeat and moving
things judder. Fix: the shell sets a global `Arcade.alpha` (0..1 = fraction of the way from the
last completed step to the next, i.e. accumulator / STEP) right before every `draw`. Games keep
the previous-step position of fast-moving things (`px, py` alongside `x, y`) and draw at
`lerp(prev, cur, Arcade.alpha)`. This is render-only; logic and AI are unchanged. A game that
ignores alpha still works (alpha just isn't used). When paused, alpha stays fixed.

### 17. `pool` — Velvet Break (pool, 8-ball vs house bot)
- **Look**: top-down table; deep teal-green? no — **midnight blue cloth** `#0f2547` with a soft
  overhead lamp hotspot and darker edges, rich mahogany rails with brass diamond sights, leather
  pockets. Balls: classic colors with stripes/numbers, glossy highlight that stays fixed relative to
  the lamp while the ball's number rotates with the roll (fake 3D roll by moving the number disc across
  the sphere). Cue stick slides in, pulls back, strikes; aiming line from the cue ball only (like an
  aim assist, visible to both). Pocketed balls roll into a rack tray at the side.
- **Rules**: simplified 8-ball: break, open table, solids/stripes assigned on first legal pot, must
  hit own group first, pot the 8 last; scratch = ball in hand (placed by AI anywhere behind…
  anywhere on table — keep simple: ball in hand anywhere). Fouls: scratch, wrong first contact, no
  rail after contact (optional). Potting 8 early or scratching on the 8 = loss.
- **Players**: Autopilot AI vs a "house" bot (simpler: picks the easiest straight-in shot, with angle
  noise). Autopilot AI: for each of its balls × each pocket, compute ghost-ball aim, check path
  clearance (cue→ghost and ball→pocket), estimate difficulty (cut angle, distances), add a bank
  shot search when nothing is clear, choose power, and simulate the shot with the real physics to
  pick the best, including cue-ball position for the next shot (sample several powers/spins). Human
  limit: aim error Gaussian σ ≈ 0.25°. Physics: elastic ball-ball collisions, rolling friction,
  cushion restitution 0.8, pockets as capture circles at corners/sides; substeps.
- **Win**: Autopilot wins the rack. One rack per game (~2–3 min). Tune house bot so Autopilot wins ~70%.

### 18. `defense` — Bastion Grove (tower defense)
- **Look**: a stylised low-poly island viewed from above in muted spring greens and slate stone
  path, soft cast shadows, little trees swaying; enemies are cute wind-up beetles of 4 kinds
  (scout, armored, swarm, giant) with health bars; towers are stone pedestals with distinct tops:
  arrow (quick bolts), cannon (arc shells, splash), frost (slows, blue rings), lightning (chains).
  Satisfying projectiles, impact puffs, coins floating up when an enemy pops.
- **Rules**: a fixed winding path; 20 waves with increasing count/HP, mixed types; start gold, gold per
  kill; build on grass tiles (not path), towers upgrade to level 3 (visual change each level),
  sell disabled. 20 lives; an enemy reaching the end costs lives (giants cost 5).
- **Win**: survive wave 20. **Loss**: lives reach 0.
- **AI** (sees the whole map, enemy types and HP like a human; it knows the wave preview shown on
  screen — show "Next: 12 armored" above the field): between and during waves it spends gold by
  evaluating candidate tile placements by **path coverage** (number of path tiles in range weighted
  toward chokepoints/corners), tower-type mix needed for upcoming wave (frost before swarms, cannon for
  swarms, lightning for armored), and upgrade vs new build value per gold. One build/upgrade action
  per 0.6 s (human-ish). Tune waves so it wins ~70% with ~3 min games (waves auto-advance quickly).

### 19. `invaders` — Coral Invaders (space invaders)
- **Look**: underwater-themed invaders? No — make it a **paper-cut** look: layered construction-paper
  textures (warm cream, mustard, teal, brick), invaders are cut-paper critters that flap between two
  frames, the player is a paper rocket on a craft-stick base, shields are torn-paper bunkers that lose
  bites. Explosions are confetti snippets. Slight paper drop shadows everywhere. Background deep
  ink-teal paper.
- **Rules**: 11x5 formation stepping sideways and down, speeding up as numbers drop; invaders shoot
  random bombs (visible). Player moves (max speed), one bullet on screen at a time. UFO occasionally.
  3 lives; 3 waves, each starting lower.
- **Win**: clear wave 3. **Loss**: lives gone or invaders reach the bottom.
- **AI**: dodges visible bombs by predicting their fall (safe-x intervals), picks the column whose
  lowest invader it can hit soonest (lead the target as the formation moves), prefers clearing outer
  columns to slow the march, shoots the UFO when the timing works. Reaction delay 60 ms.

### 20. `slicer` — Orchard Slash (fruit slicing)
- **Look**: a dark wooden board / dojo backdrop with paper lanterns? (Avoid duplicating Night Market.)
  Use **stone & moss zen garden** at night: raked gravel pattern background, a moss rock, faint mist.
  Fruits are juicy and round with gradient shading (melon, orange, apple, kiwi, plum, pineapple);
  slicing splits them into two halves that tumble apart with juice splatter that stains the gravel and
  slowly fades. The blade leaves a glowing white trail that tapers. Bombs are dark iron with a fizzing
  fuse — touching one = lose a life with a flash.
- **Rules**: fruits are tossed up from the bottom in volleys (with gravity); missing a fruit (it falls
  off screen) costs a life (3 lives); bombs mixed in more often over time. Combos for 3+ fruits in one
  swipe. Volleys get bigger/faster.
- **Win**: score 300. **Loss**: lives gone.
- **AI**: the blade is a cursor with max speed 3500 px/s and max acceleration (human hand); plans
  swipe paths through as many fruits as possible within the next ~0.4 s, avoiding bombs by a margin
  (predict bomb trajectories), with reaction delay 70 ms. Swipes are straight-ish strokes.

---

## Round 5

### Shell v2
- Each game gets an `aiNote` in its `Arcade.register` metadata: one sentence on how the AI plays and
  what limits it plays under (e.g. "Sees only the next piece; presses at most 14 keys a second.").
  Shown on the intro title card under the name (small, muted), and on the start-screen card.
- Transition: after the result card, a diagonal wipe in the NEXT game's accent color sweeps across
  (0.7 s, eased), then the next intro card appears over the next game's first frame.
- Start screen: footer line with this browser's totals ("142 games watched · AI won 103"), and a
  "Select all / none" pair of small text buttons above the grid. Cards sorted alphabetically.
- During play, the HUD's second line occasionally (every ~45 s, for 6 s) swaps to "Up next: <name>".
- Long-run stability: the app must run for many hours. No growing arrays across games, cancel any
  per-game timers, drop references to finished games, cap particle counts.

### 21. `racing` — Slipstream (top-down racing)
- **Look**: night city circuit seen from above: wet asphalt with reflections of street lamps (soft
  colored blooms), kerbs in red/white, glowing lane markings, the cars are small sleek capsule
  shapes with headlight cones and taillight streaks. The Autopilot car is amber; 5 rivals in other
  colors. Tyre marks fade on the road when cornering hard. Camera follows the Autopilot car with
  smooth look-ahead and slight rotation easing (or a fixed full-track view if the track fits —
  prefer the follow cam zoomed so ~1/3 of the track is visible, plus a mini-map).
- **Rules**: 3 laps on a randomly chosen one of 3 closed tracks (spline-based). Simple car physics:
  speed, steering with grip limit (lateral accel cap), braking; off-track = grass slowdown; car-car
  collisions push apart. Rivals follow the racing line with varied skill.
- **Win**: finish 1st. **Loss**: finish 2nd or lower.
- **AI** (sees the track and the cars, like a driver): follows a precomputed racing line computed from
  the visible track geometry (minimum-curvature-ish via smoothing), speed profile from curvature and
  grip, brakes ahead of corners, overtakes by offsetting the line when a car ahead is slower. Inputs:
  steering rate-limited, throttle/brake. Tune rivals so it wins ~65%.

### 22. `golf` — Moonlit Links (mini golf)
- **Look**: a mini-golf course at night under string lights: deep green felt fairways with darker
  edges, brick-red borders, wooden windmill, loops, bumpers, water, sand; the ball leaves a short
  trail; hole cup with a little flag that waves. Each hole is a distinct top-down layout.
- **Rules**: 9 holes, par 2–4 each. Physics: rolling friction, wall bounces, slopes (shown as subtle
  shaded gradients with arrows), sand slows, water = +1 stroke and reset. Windmill blades rotate
  (timing!).
- **Win**: finish at or under par total. **Loss**: over par. (Tune ~65% win.)
- **AI**: for each putt, search angle×power (coarse grid then refine) by simulating the visible
  physics (the same physics a human learns), choosing the shot maximizing hole-in probability with
  safety (robust to small aim error σ=0.4°, power σ=2%), and timing the windmill.

### 23. `lander` — Quiet Descent (lunar lander)
- **Look**: monochrome-plus-one-color: soft grey moon terrain with craters drawn as gentle shaded
  hills, black-blue sky with Earth rising (blue marble), the lander is a detailed little line-art
  craft with gold foil body; thruster plume flickers; dust kicks up near the ground. Landing pads
  flash with multipliers (x2, x3, x5 for narrow ones).
- **Rules**: gravity 1.62 u/s²-ish scaled; rotate and main thrust; limited fuel (shown); landing safe
  if vertical speed < limit, horizontal < limit, angle < 8°, on a pad. Each game = 5 landings on
  increasingly rugged random terrain (new terrain each round, fuel carries over with a small refill).
  Crash = lose that landing; 2 crashes = loss.
- **Win**: 5 landings with ≤1 crash. 
- **AI**: picks a pad weighing multiplier vs difficulty; plans a trajectory with a simple guidance
  law (e.g. ZEM/ZEV or an energy-aware descent profile), executes with the same rotate/thrust
  controls (rotation rate limited), with sensor noise on readings. Tune to win ~70%.

### 24. `chess` — Marble & Brass (chess, Autopilot vs house engine)
- **Look**: a marble board (cream and slate veined squares, procedurally drawn) on a dark walnut
  table, pieces as clean 2D Staunton silhouettes with subtle bevel shading (ivory vs ebony), the
  last move highlighted with a soft brass glow, pieces glide (0.35 s) and captured pieces slide off to
  the side tray. Move list on the side in Fraunces with figurine notation. A thin evaluation bar.
- **Rules**: full legal chess (castling, en passant, promotion, check/mate/stalemate, 50-move,
  threefold). Autopilot plays white or black at random.
- **Players**: Autopilot = alpha-beta with iterative deepening (depth ~4–5 within ~200 ms budget
  spread over ticks), PST evaluation, quiescence. House = same engine at depth 2 with some randomness.
  Move pace ~1 move/1.5 s. Draws count as loss for rotation purposes (show "Draw").
- **Win**: checkmate. Cap: 160 plies → adjudicate by material (> +3 = win, else draw/loss).

---

## Round 6 — AI tactics vary between runs

Andre: the AI may lose; it should **try different tactics** from run to run. Games must stay
winnable but may be hard and random.

Contract addition: at `create()`, each game picks one of 2–4 **AI styles** at random (a named set of
strategy parameters — genuinely different play, not just noise) and exposes it as
`instance.style = 'Corner anchor'` (short, 1–3 words). The shell shows it on the intro card under
the aiNote as "Tactic: <style>" and in the HUD detail line for the first few seconds. Styles must all
be competent (no deliberately dumb style), but they may differ in risk and win rate. Also break exact
ties between equal moves randomly. Fair-play rules still hold.

Style ideas per game (pick 2–4, adapt as fits the code):
- snake: Direct (shortest path) · Wall hugger (prefers edges/compact coiling) · Zigzag sweeper (lawnmower-like fill when safe)
- tetris: Flat stacker (El-Tetris) · Well builder (keeps a column open for tetrises; weights rewarding 4-line clears) · Low and safe (heavier height penalty)
- breakout: Tunneler (aims to break through to the top) · Sweeper (clears row by row from the bottom) · Edge hunter (works the sides)
- merge (2048): anchor corner chosen at random (4 corners) × heuristic variant (snake weights vs. nneonneo) 
- mines: opening click spot (center / corner / random) · guess policy (min-prob vs. prefers info-rich cells)
- glide: Center line · Low rider (hugs the bottom of gaps) · Late flapper (flaps as late as safe)
- stack: Metronome (taps at center) · Anticipator (slightly earlier lead) — different noise profiles are fine here
- maze: Beeline (freespace A*) · Right-hand explorer with A* shortcuts · Corridor scout (prefers long straight sight lines)
- solitaire: Foundation first · Reveal first · Column builder (keeps empty columns for kings)
- bubbles: Big combos · Drop hunter (aims to orphan clusters) · Bank-shot lover
- asteroids: Turret (stays central, rotates and shoots) · Hunter (flies to targets) · Sweeper (orbits the screen)
- chase: Pellet sweeper (cautious) · Ghost hunter (baits ghosts to power lanterns) · Corner clearer
- pinball: Trapper (holds and aims) · Fast flipper (hits on the fly) · Orbit hunter
- sudoku: Row-by-row scanner · Hardest-region-first · Pencil-mark heavy (full candidates first)
- runner: Early jumper · Late jumper · Slider (prefers sliding where possible)
- hockey: Banker (bank shots) · Striker (direct power shots) · Wall (defensive counter-attacker)
- pool: Position player (cue-ball control) · Pot everything (aggressive, harder pots) · Safety-first (plays safeties when no good pot)
- defense: Frost & cannon · Lightning network · Arrow spam then upgrade · Chokepoint fortress
- invaders: Edge cutter (clears outer columns) · Bottom-up · UFO hunter
- slicer: Combo hunter (waits for lines of 3+) · Quick cutter (cuts fruit as soon as reachable)
- racing: Aggressive overtaker · Patient drafter (waits in slipstream, passes late) · Inside-line diver
- golf: Bold (aims for the cup, riskier) · Lag putter (safe two-putts) · Bank artist
- lander: Direct descent · Hover and settle · Pad hopper (prefers high multipliers)
- chess: Attacker (king-safety/attack weights up) · Positional (structure/mobility weights) · Trader (simplifies when ahead); plus opening variety
