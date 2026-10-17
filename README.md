# Autopilot Arcade

A second-screen web app where an AI plays 24 games for you to watch. Press **Start** and it plays a random game; when the game ends (won or lost) it rotates to another.

The AI plays fair: it only sees what is drawn on screen and acts through human-rate inputs. Each game picks a random tactic every time it comes up (shown as "Tactic" on the intro card), so replays differ and the AI sometimes loses.

**Play:** open `index.html` (it is fully self-contained) or enable GitHub Pages for this repo (Settings → Pages → Deploy from branch `main`, folder `/ (root)`).

Keys: Space pauses, N skips, F fullscreen, Esc returns to the menu.

Every game has a 5% chance of starting with a **Super AI**: zero reaction time, no noise, inhuman speed (still only sees what is on screen). Add `?super=1` to the URL to force it, `?super=0` to turn it off.

The app is fully self-contained: fonts are embedded, nothing is loaded from the network.

## Layout

- `index.html` — the built app (generated, do not edit by hand)
- `src/core.js` — shared helpers and the game contract; `src/shell.js` — menu, rotation and HUD; `src/games/*.js` — one file per game
- `build.py` — bundles everything into `index.html` and `dist/`
- `tools/` — dev harness (`tools/dev.html?game=<id>`) and headless Playwright tests (`node tools/run.mjs <id> [rounds]`)
- `DESIGN.md` — the full design spec
