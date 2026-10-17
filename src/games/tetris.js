// tetris.js — Glass Stack (falling blocks). See DESIGN.md game #2.
(() => {
'use strict';

  // ---- render interpolation (high-refresh displays): the shell sets Arcade.alpha (0..1) before every draw.
  // step() records previous values (_p<key>); draw() temporarily swaps in lerp(prev, cur, alpha), then restores.
  // Groups: [objects, keys, jumpLimit] (changes bigger than jumpLimit are teleports/wraps: not interpolated)
  // or [objects, keys, 0, 't'] (timer-driven animations: advance the timer by alpha*dt instead).
  const IP = {
    snap(gs) { for (const g of gs) for (const o of g[0]) if (o) for (const k of g[1]) o['_p' + k] = o[k]; },
    push(gs, a) {
      const st = [];
      for (const g of gs) for (const o of g[0]) if (o) for (const k of g[1]) {
        const c = o[k];
        if (g[3] === 't') { if (Arcade.alpha !== undefined) { st.push(o, k, c); o[k] = c + a / 60; } continue; }
        const p = o['_p' + k];
        if (p !== undefined && Math.abs(c - p) < g[2]) { st.push(o, k, c); o[k] = p + (c - p) * a; }
      }
      return st;
    },
    pop(st) { for (let i = st.length - 3; i >= 0; i -= 3) st[i][st[i + 1]] = st[i + 2]; },
    alpha() { const a = Arcade.alpha; return a === undefined ? 1 : Math.max(0, Math.min(1, a)); },
  };
  // ---- offscreen layer helpers: full-screen gradients are costly per frame, so static ones are painted once
  // per canvas size and blitted; slowly-changing ones are repainted at low resolution (then scaled up smoothly).
  const _layers = {};
  function layerFor(ctx, key, W, H, div) {
    const sc = Math.min(2, (ctx.getTransform ? ctx.getTransform().a : 1) || 1) / (div || 1);
    let l = _layers[key];
    if (!l || l.W !== W || l.H !== H || l.sc !== sc) {
      const c = document.createElement('canvas'); c.width = Math.max(1, Math.ceil(W * sc)); c.height = Math.max(1, Math.ceil(H * sc));
      l = _layers[key] = { c, x: c.getContext('2d'), W, H, sc, fresh: true };
    }
    return l;
  }
  function staticLayer(ctx, key, W, H, paint) {
    const l = layerFor(ctx, key, W, H, 1);
    if (l.fresh) { l.fresh = false; l.x.setTransform(l.sc, 0, 0, l.sc, 0, 0); paint(l.x, W, H); }
    ctx.drawImage(l.c, 0, 0, W, H);
  }
  function liveLayer(ctx, key, W, H, div, paint) {
    const l = layerFor(ctx, key, W, H, div);
    l.x.setTransform(l.sc, 0, 0, l.sc, 0, 0); l.x.clearRect(0, 0, W, H); paint(l.x, W, H);
    ctx.drawImage(l.c, 0, 0, W, H);
  }


const COLS = 10, ROWS = 22, HID = 2, VIS = 20;      // 2 hidden rows above the 20 visible ones
const WIN_LINES = 150, TIME_CAP = 360;
const TYPES = ['I', 'O', 'T', 'S', 'Z', 'J', 'L'];
const HUES = { I: 188, O: 46, T: 282, S: 140, Z: 352, J: 222, L: 24 };
const BASE = {
  I: [[0, 1], [1, 1], [2, 1], [3, 1]], O: [[0, 0], [1, 0], [0, 1], [1, 1]],
  T: [[1, 0], [0, 1], [1, 1], [2, 1]], S: [[1, 0], [2, 0], [0, 1], [1, 1]],
  Z: [[0, 0], [1, 0], [1, 1], [2, 1]], J: [[0, 0], [0, 1], [1, 1], [2, 1]],
  L: [[2, 0], [0, 1], [1, 1], [2, 1]],
};
const BOX = { I: 4, O: 2, T: 3, S: 3, Z: 3, J: 3, L: 3 };
const SPAWN_X = { I: 3, O: 4, T: 3, S: 3, Z: 3, J: 3, L: 3 };
const SPAWN_Y = 1;
// ROT[type][rotation] -> list of [cx, cy]
const ROT = {};
for (const t of TYPES) {
  const n = BOX[t]; ROT[t] = [BASE[t]];
  if (t !== 'O') for (let r = 1; r < 4; r++) ROT[t].push(ROT[t][r - 1].map(([x, y]) => [n - 1 - y, x]));
  else for (let r = 1; r < 4; r++) ROT[t].push(BASE[t]);
}
const NROT = { I: 2, O: 1, T: 4, S: 2, Z: 2, J: 4, L: 4 };   // distinct rotations worth considering
const FULL = (1 << COLS) - 1;
const POP = new Uint8Array(4096); for (let i = 1; i < 4096; i++) POP[i] = POP[i >> 1] + (i & 1);

const GRAV = lvl => Math.max(0.0275, 0.8 - 0.08 * lvl);
const HASTE_W = 8;
const LOCK_DELAY = 0.4, SCORES = [0, 100, 300, 500, 800];

// ---------------------------------------------------------------------------
// AI. Sees ONLY what a human sees: the settled board, the falling piece (type, rotation,
// position) and the single NEXT preview piece. No bag contents, no RNG. It acts through an
// InputQueue at one action per 0.07 s after a 0.12 s "reading" delay when a piece appears,
// and works closed-loop (re-reads the board every tick), so gravity acting meanwhile is fine.
// ---------------------------------------------------------------------------
function fitsRows(rows, cells, x, y) {
  for (let i = 0; i < 4; i++) {
    const px = x + cells[i][0], py = y + cells[i][1];
    if (px < 0 || px >= COLS || py >= ROWS) return false;
    if (py >= 0 && (rows[py] >> px) & 1) return false;
  }
  return true;
}
function dropY(rows, cells, x, y) { while (fitsRows(rows, cells, x, y + 1)) y++; return y; }
// place piece, clear lines; returns {rows, cleared, land}
function placeRows(rows, cells, x, y) {
  const r = rows.slice(); let lo = 99, hi = -99;
  for (let i = 0; i < 4; i++) { const py = y + cells[i][1]; r[py] |= 1 << (x + cells[i][0]); lo = Math.min(lo, py); hi = Math.max(hi, py); }
  const land = ROWS - (lo + hi) / 2 - 0.5;           // height of the piece centre above the floor
  let cleared = 0, w = ROWS - 1;
  for (let yy = ROWS - 1; yy >= 0; yy--) { if (r[yy] === FULL) cleared++; else r[w--] = r[yy]; }
  while (w >= 0) r[w--] = 0;
  return { rows: r, cleared, land };
}
// El-Tetris (Dellacherie-style) board evaluation
function evalBoard(rows, cleared, land, W) {
  let rowT = 0, colT = 0, holes = 0, wells = 0;
  for (let y = 0; y < ROWS; y++) {
    const r = rows[y]; if (!r) continue;
    const ext = (r << 1) | 1 | (1 << (COLS + 1));
    rowT += POP[(ext ^ (ext >> 1)) & 0x7FF];
  }
  for (let x = 0; x < COLS; x++) {
    let last = 0, seen = false, d = 0;
    for (let y = 0; y < ROWS; y++) {
      const c = (rows[y] >> x) & 1;
      if (c !== last) { colT++; last = c; }
      if (c) seen = true; else if (seen) holes++;
      if (!c) {
        const l = x === 0 ? 1 : (rows[y] >> (x - 1)) & 1, rr = x === COLS - 1 ? 1 : (rows[y] >> (x + 1)) & 1;
        if (l && rr) { d++; if (x !== W.well) wells += d; } else d = 0;
      } else d = 0;
    }
    if (last === 0) colT++;
  }
  let wellFill = 0;
  if (W.well >= 0) {
    // well builder: keep one column open; reward 4-line clears, discourage cashing in 1-3 lines early
    let top = ROWS;
    for (let y = 0; y < ROWS; y++) if (rows[y]) { top = y; break; }
    for (let y = 0; y < ROWS; y++) if ((rows[y] >> W.well) & 1) wellFill++;
    const tall = top < ROWS - 8 ? 0 : 1;
    return W.land * land + W.clear * cleared - 3.217888287 * rowT - 9.348695305 * colT
      - 7.899265427 * holes - 3.385597225 * wells - 4 * wellFill
      + (cleared === 4 ? 10 : cleared > 0 ? -3 * tall : 0);
  }
  return W.land * land + W.clear * cleared - W.row * rowT - W.col * colT
    - W.hole * holes - W.well_ * wells;
}
// Tactic styles = evaluation weights (all competent; they differ in risk and shape of the stack)
const STYLES = [
  { name: 'Flat stacker', well: -1, land: -4.500158825, clear: 3.418126810, row: 3.217888287, col: 9.348695305, hole: 7.899265427, well_: 3.385597225 },
  { name: 'Well builder', well: 0, land: -4.2, clear: 3.4, row: 3.2, col: 9.3, hole: 8.5, well_: 3.4 },
  { name: 'Low and safe', well: -1, land: -7.5, clear: 4.5, row: 3.0, col: 9.0, hole: 11, well_: 3.0 },
];
function makeAI(W) {
  const q = new InputQueue(0.07);
  let pid = -1, wait = 0, plan = null, lastSig = '', fails = 0;

  // placements the piece can reach by sliding along its current row (reach) or, for the
  // hypothetical next piece, anywhere it could be dropped
  function placements(rows, t, x0, y0, reach) {
    const out = [];
    for (let r = 0; r < NROT[t]; r++) {
      const cells = ROT[t][r];
      if (reach) {
        if (!fitsRows(rows, cells, x0, y0)) continue;
        for (let dir = -1; dir <= 1; dir += 2)
          for (let x = x0 + (dir === 1 ? 1 : 0); fitsRows(rows, cells, x, y0); x += dir)
            out.push({ r, x, y: dropY(rows, cells, x, y0), cells });
      } else {
        for (let x = -2; x < COLS; x++) if (fitsRows(rows, cells, x, 0)) out.push({ r, x, y: dropY(rows, cells, x, 0), cells });
      }
    }
    return out;
  }
  function choose(obs) {
    const p = obs.piece, rows = obs.rows;
    const haste = Math.max(0, Math.min(1, (0.2 - GRAV(obs.level)) / 0.15)) * HASTE_W;
    const firsts = placements(rows, p.t, p.x, p.y, true);
    let best = null, bs = -1e18;
    const seen = new Set();
    for (const f of firsts) {
      const key = f.r + ',' + f.x; if (seen.has(key)) continue; seen.add(key);
      const a = placeRows(rows, f.cells, f.x, f.y);
      const e1 = evalBoard(a.rows, a.cleared, a.land, W);
      let s = e1;
      if (obs.next) {
        let b2 = -1e18;
        for (const g of placements(a.rows, obs.next, 0, 0, false)) {
          const c = placeRows(a.rows, g.cells, g.x, g.y);
          const e2 = evalBoard(c.rows, c.cleared, c.land, W);
          if (e2 > b2) b2 = e2;
        }
        if (b2 > -1e17) s = e1 * 0.5 + b2;
      }
      // when the piece falls fast, a sensible player prefers placements that need fewer key presses
      const presses = (f.r === 3 ? 1 : f.r) + Math.abs(f.x - p.x);
      s -= haste * presses;
      s += Math.random() * 1e-3; // break exact ties randomly
      if (s > bs) { bs = s; best = { r: f.r, x: f.x }; }
    }
    return best;
  }
  return {
    // returns an action string or null for this tick
    tick(dt, obs) {
      if (obs.id !== pid) { pid = obs.id; wait = 0.12; plan = null; fails = 0; lastSig = ''; q.clear(); }
      if (wait > 0) { wait -= dt; return null; }
      if (!plan) { plan = choose(obs) || { r: obs.piece.r, x: obs.piece.x }; }
      const p = obs.piece;
      if (q.pending === 0) {
        const sig = p.r + ',' + p.x + ',' + p.y;
        if (sig === lastSig) fails++; else fails = 0;
        lastSig = sig;
        let a;
        if (fails >= 3) a = 'drop';
        else if (p.r !== plan.r) { const n = (plan.r - p.r + 4) % 4; a = n === 3 ? 'ccw' : 'cw'; }
        else if (p.x < plan.x) a = 'right';
        else if (p.x > plan.x) a = 'left';
        else a = 'drop';
        q.push(a);
      }
      return q.poll(dt);
    },
  };
}

// ---------------------------------------------------------------------------
const CELL_SPR = {};   // sprite cache {key -> canvas}
function cellSprite(type, px, kind) {
  const key = type + px + kind;
  if (CELL_SPR[key]) return CELL_SPR[key];
  const cv = document.createElement('canvas'); cv.width = cv.height = px;
  const g = cv.getContext('2d');
  const h = kind === 'dead' ? 232 : HUES[type], sat = kind === 'dead' ? 12 : 72;
  const m = Math.max(1, px * 0.04), r = px * 0.14, w = px - m * 2;
  const grd = g.createLinearGradient(0, m, 0, px - m);
  grd.addColorStop(0, `hsla(${h},${sat}%,${kind === 'dead' ? 46 : 70}%,0.96)`);
  grd.addColorStop(1, `hsla(${h},${sat}%,${kind === 'dead' ? 28 : 41}%,0.96)`);
  roundRect(g, m, m, w, w, r); g.fillStyle = grd; g.fill();
  g.save(); roundRect(g, m, m, w, w, r); g.clip();
  const sheen = g.createLinearGradient(0, m, w, w);
  sheen.addColorStop(0, 'rgba(255,255,255,0.28)'); sheen.addColorStop(0.5, 'rgba(255,255,255,0.04)'); sheen.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = sheen; g.fillRect(m, m, w, w * 0.62);
  const lw = Math.max(1, px * 0.045);
  g.lineWidth = lw; g.lineCap = 'round'; g.lineJoin = 'round';
  g.strokeStyle = 'rgba(0,0,10,0.34)'; g.beginPath(); g.moveTo(m + lw, px - m - lw * 0.6); g.lineTo(px - m - lw * 0.6, px - m - lw * 0.6); g.lineTo(px - m - lw * 0.6, m + lw); g.stroke();
  g.strokeStyle = 'rgba(255,255,255,0.62)'; g.beginPath(); g.moveTo(m + lw * 0.6, px - m - r); g.lineTo(m + lw * 0.6, m + r); g.quadraticCurveTo(m + lw * 0.6, m + lw * 0.6, m + r, m + lw * 0.6); g.lineTo(px - m - r, m + lw * 0.6); g.stroke();
  g.restore();
  CELL_SPR[key] = cv; return cv;
}
const GLOW_SPR = {};
function glowSprite(hue) {
  if (GLOW_SPR[hue]) return GLOW_SPR[hue];
  const cv = document.createElement('canvas'); cv.width = cv.height = 128;
  const g = cv.getContext('2d'), gr = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  gr.addColorStop(0, `hsla(${hue},85%,62%,0.9)`); gr.addColorStop(0.35, `hsla(${hue},85%,55%,0.3)`); gr.addColorStop(1, `hsla(${hue},85%,50%,0)`);
  g.fillStyle = gr; g.fillRect(0, 0, 128, 128);
  GLOW_SPR[hue] = cv; return cv;
}

function create() {
  const AW = Object.assign({}, STYLES[(Math.random() * STYLES.length) | 0]);
  if (AW.well === 0) AW.well = Math.random() < 0.5 ? 0 : COLS - 1;
  const ai = makeAI(AW);
  const parts = new Particles();
  const inst = {
    over: false, won: false, style: AW.name,
    t: 0, W: 800, H: 600,
    grid: new Uint8Array(COLS * ROWS),       // 0 empty, else type index + 1
    bag: [], cur: null, next: null, pieceId: 0,
    gAcc: 0, lockT: 0, lockResets: 0,
    lines: 0, score: 0, level: 0, pieces: 0,
    phase: 'play', clearT: 0, clearRows: [], burst: false,
    fallOff: new Float32Array(ROWS), fallT: 9,
    pv: { x: 0, y: 0 }, streaks: [], flashes: [], floaters: [],
    shake: 0, endT: 0, endKind: '', msg: '', lastClear: 0, lockGlow: 0,
    bokeh: [], L: null,
  };
  for (let i = 0; i < 16; i++) inst.bokeh.push({
    u: Math.random(), v: Math.random(), s: 0.08 + Math.random() * 0.2, hue: HUES[TYPES[i % 7]],
    a: 0.07 + Math.random() * 0.1, ph: Math.random() * 6.28, sp: 0.03 + Math.random() * 0.05,
  });

  function nextType() {
    if (!inst.bag.length) inst.bag = rnd.shuffle(TYPES.slice());
    return inst.bag.pop();
  }
  function fits(t, r, x, y) {
    const cells = ROT[t][r];
    for (let i = 0; i < 4; i++) {
      const px = x + cells[i][0], py = y + cells[i][1];
      if (px < 0 || px >= COLS || py >= ROWS) return false;
      if (py >= 0 && inst.grid[py * COLS + px]) return false;
    }
    return true;
  }
  function spawn() {
    const t = inst.next || nextType();
    inst.next = nextType();
    inst.cur = { t, r: 0, x: SPAWN_X[t], y: SPAWN_Y };
    inst.pieceId++; inst.pieces++;
    inst.gAcc = 0; inst.lockT = 0; inst.lockResets = 0;
    inst.pv.x = inst.cur.x; inst.pv.y = inst.cur.y - 1.2;
    if (!fits(t, 0, inst.cur.x, inst.cur.y)) topOut();
  }
  function tryMove(dx, dy) {
    const c = inst.cur;
    if (fits(c.t, c.r, c.x + dx, c.y + dy)) { c.x += dx; c.y += dy; return true; }
    return false;
  }
  function onMoved() {
    if (inst.lockT > 0 && inst.lockResets < 15) { inst.lockT = 0; inst.lockResets++; }
  }
  function rotate(dir) {
    const c = inst.cur; if (c.t === 'O') return false;
    const nr = (c.r + dir + 4) % 4;
    const kicks = [0, -1, 1, -2, 2];
    for (const dy of [0, -1]) for (const dx of kicks) {
      if (fits(c.t, nr, c.x + dx, c.y + dy)) { c.r = nr; c.x += dx; c.y += dy; onMoved(); return true; }
    }
    return false;
  }
  function ghostY() {
    const c = inst.cur; let y = c.y;
    while (fits(c.t, c.r, c.x, y + 1)) y++;
    return y;
  }
  function act(a) {
    const c = inst.cur;
    if (a === 'left') { if (tryMove(-1, 0)) onMoved(); }
    else if (a === 'right') { if (tryMove(1, 0)) onMoved(); }
    else if (a === 'cw') rotate(1);
    else if (a === 'ccw') rotate(-1);
    else if (a === 'drop') {
      const y0 = c.y, y1 = ghostY();
      const cells = ROT[c.t][c.r];
      if (y1 > y0) {
        inst.streaks.push({ cols: cells.map(q => c.x + q[0]), y0: y0, y1: y1, hue: HUES[c.t], t: 0, minY: Math.min(...cells.map(q => q[1])) });
        inst.score += 2 * (y1 - y0);
      }
      c.y = y1; inst.pv.y = Math.min(inst.pv.y, y1 - 0.01) + 0; lock(true);
    }
  }
  function cellXY(col, row) { const L = inst.L; return [L.wx + col * L.c, L.wy + (row - HID) * L.c]; }
  function lock(hard) {
    const c = inst.cur, cells = ROT[c.t][c.r];
    let allHidden = true;
    for (const [cx, cy] of cells) {
      const px = c.x + cx, py = c.y + cy;
      if (py >= 0) inst.grid[py * COLS + px] = TYPES.indexOf(c.t) + 1;
      if (py >= HID) allHidden = false;
      inst.flashes.push({ x: px, y: py, t: 0 });
    }
    inst.cur = null;
    inst.shake = Math.max(inst.shake, hard ? 1 : 0.35);
    if (allHidden) { topOut(); return; }
    const rows = [];
    for (let y = 0; y < ROWS; y++) { let f = true; for (let x = 0; x < COLS; x++) if (!inst.grid[y * COLS + x]) { f = false; break; } if (f) rows.push(y); }
    if (rows.length) {
      inst.phase = 'clear'; inst.clearT = 0; inst.clearRows = rows; inst.burst = false;
      const pts = SCORES[rows.length] * (inst.level + 1);
      inst.score += pts; inst.lastClear = rows.length;
      const L = inst.L; const mid = rows.reduce((a, b) => a + b, 0) / rows.length;
      inst.floaters.push({ txt: '+' + pts, x: L.wx + L.c * COLS / 2, y: L.wy + (mid - HID) * L.c, t: 0, big: rows.length });
      if (rows.length === 4) inst.floaters.push({ txt: 'GLASS STACK', x: L.wx + L.c * COLS / 2, y: L.wy + (mid - HID) * L.c - L.c * 1.3, t: 0, big: 0 });
      inst.shake = Math.max(inst.shake, 0.5 + rows.length * 0.25);
    } else spawn();
  }
  function finishClear() {
    const rows = inst.clearRows, set = new Set(rows);
    const old = inst.grid, g = new Uint8Array(COLS * ROWS);
    inst.fallOff.fill(0);
    let w = ROWS - 1;
    for (let y = ROWS - 1; y >= 0; y--) {
      if (set.has(y)) continue;
      for (let x = 0; x < COLS; x++) g[w * COLS + x] = old[y * COLS + x];
      inst.fallOff[w] = y - w; w--;
    }
    inst.grid = g; inst.fallT = 0;
    inst.lines += rows.length; inst.level = Math.floor(inst.lines / 10);
    inst.phase = 'play'; inst.clearRows = [];
    if (inst.lines >= WIN_LINES) { win(); return; }
    spawn();
  }
  function topOut() {
    if (inst.over) return;
    inst.over = true; inst.won = false; inst.endKind = 'lost'; inst.endT = 0; inst.cur = null;
    inst.msg = `Topped out at ${inst.lines} lines (level ${inst.level})`;
    inst.shake = 1.6;
  }
  function win() {
    inst.over = true; inst.won = true; inst.endKind = 'won'; inst.endT = 0; inst.cur = null;
    inst.msg = `Cleared ${inst.lines} lines in ${fmtTime(inst.t)}`;
  }
  const fmtTime = s => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

  function observe() {
    const rows = new Array(ROWS).fill(0);
    for (let y = 0; y < ROWS; y++) for (let x = 0; x < COLS; x++) if (inst.grid[y * COLS + x]) rows[y] |= 1 << x;
    const c = inst.cur;
    return { rows, piece: { t: c.t, r: c.r, x: c.x, y: c.y }, next: inst.next, id: inst.pieceId, level: inst.level };
  }

  inst.resize = (W, H) => {
    inst.W = W; inst.H = H;
    let c = Math.min(H * 0.88 / VIS, W * 0.9 / 16.2);
    c = Math.max(8, Math.floor(c));
    let panelW = c * 5.4, gap = c * 0.7, tw = c * COLS + gap + panelW;
    let wx = Math.round((W - tw) / 2), wy = Math.round((H - c * VIS) / 2);
    if (wx < 370 && wy + c * VIS > H - 104) { // keep clear of the shell HUD box (bottom-left)
      c = Math.max(8, Math.floor(Math.min(c, (H - 104 - H * 0.03) / VIS)));
      panelW = c * 5.4; gap = c * 0.7; tw = c * COLS + gap + panelW;
      wx = Math.round((W - tw) / 2); wy = Math.round((H * 0.03 + H - 104 - c * VIS) / 2);
    }
    inst.L = { c, wx, wy, ww: c * COLS, wh: c * VIS, px: wx + c * COLS + gap, pw: panelW };
  };

  const ipg = () => [[[inst], ['t', 'fallT', 'clearT'], 0, 't'], [inst.streaks, ['t'], 0, 't'], [inst.flashes, ['t'], 0, 't'], [inst.floaters, ['t'], 0, 't']];
  inst.step = dt => {
    IP.snap(ipg());
    inst.t += dt;
    parts.update(dt);
    inst.shake *= Math.exp(-dt * 7);
    inst.fallT += dt;
    for (const s of inst.streaks) s.t += dt;
    inst.streaks = inst.streaks.filter(s => s.t < 0.3);
    for (const f of inst.flashes) f.t += dt;
    inst.flashes = inst.flashes.filter(f => f.t < 0.35);
    for (const f of inst.floaters) f.t += dt;
    inst.floaters = inst.floaters.filter(f => f.t < 1.4);
    const L = inst.L;
    if (inst.over) {
      inst.endT += dt;
      const sweep = inst.endT * 38;               // rows per second sweep
      if (inst.endKind === 'lost' && L) {
        const hi = Math.min(ROWS, Math.floor(sweep));
        if (!inst._deadRow) inst._deadRow = ROWS;
        while (inst._deadRow > ROWS - hi) {
          inst._deadRow--; const y = inst._deadRow;
          for (let x = 0; x < COLS; x++) if (inst.grid[y * COLS + x] && y >= HID) { const [px, py] = cellXY(x, y); parts.burst(px + L.c / 2, py + L.c / 2, 3, { speed: 180, life: 1.1, size: L.c * 0.12, gravity: 500, color: 'hsl(235,25%,70%)' }); }
        }
      } else if (inst.endKind === 'won' && L) {
        if (!inst._winRow) inst._winRow = 0;
        const hi = Math.min(ROWS, Math.floor(sweep * 0.8));
        while (inst._winRow < hi) {
          const y = inst._winRow++;
          for (let x = 0; x < COLS; x++) {
            const v = inst.grid[y * COLS + x]; if (!v || y < HID) continue;
            const [px, py] = cellXY(x, y);
            parts.burst(px + L.c / 2, py + L.c / 2, 4, { speed: 320, life: 1.3, size: L.c * 0.14, gravity: 260, color: [`hsl(${HUES[TYPES[v - 1]]},90%,70%)`, '#fff'] });
          }
        }
        if (inst.endT < 2.2 && Math.random() < 0.25 && L) parts.burst(L.wx + Math.random() * L.ww, L.wy + Math.random() * L.wh * 0.6, 8, { speed: 260, life: 1.2, size: L.c * 0.12, gravity: 200, color: TYPES.map(t => `hsl(${HUES[t]},90%,68%)`) });
      }
      return;
    }
    if (inst.t > TIME_CAP) { inst.over = true; inst.won = false; inst.endKind = 'lost'; inst.msg = 'Out of time'; return; }

    if (inst.phase === 'clear') {
      inst.clearT += dt;
      if (!inst.burst && inst.clearT >= 0.17) {
        inst.burst = true;
        for (const y of inst.clearRows) for (let x = 0; x < COLS; x++) {
          const v = inst.grid[y * COLS + x], [px, py] = cellXY(x, y);
          parts.burst(px + L.c / 2, py + L.c * 0.5, 3 + inst.clearRows.length, { speed: 320, speedMin: 60, life: 0.9, size: L.c * 0.13, gravity: 420, color: [`hsl(${HUES[TYPES[v - 1] || 'I']},90%,72%)`, '#fff'] });
        }
      }
      if (inst.clearT >= 0.27) finishClear();
      return;
    }
    if (!inst.cur) return;

    // ---- player (AI) input
    const a = ai.tick(dt, observe());
    if (a) { act(a); if (!inst.cur) return; }

    // ---- gravity + lock delay
    const gi = GRAV(inst.level);
    inst.gAcc += dt;
    const c = inst.cur;
    while (inst.gAcc >= gi) {
      if (fits(c.t, c.r, c.x, c.y + 1)) { c.y++; inst.gAcc -= gi; } else { inst.gAcc = gi * 0.999; break; }
    }
    if (!fits(c.t, c.r, c.x, c.y + 1)) {
      inst.lockT += dt;
      if (inst.lockT >= LOCK_DELAY) lock(false);
    } else if (inst.lockT > 0) inst.lockT = Math.max(0, inst.lockT - dt);
    if (inst.cur) {
      const k = 1 - Math.exp(-dt * 34);
      inst.pv.x += (inst.cur.x - inst.pv.x) * k;
      const fy = fits(c.t, c.r, c.x, c.y + 1) ? Math.min(1, inst.gAcc / gi) : 0;
      inst.pv.y += (inst.cur.y + fy * 0.95 - inst.pv.y) * (1 - Math.exp(-dt * 40));
    }
  };

  // ------------------------------------------------------------------ drawing
  function drawBg(ctx, W, H) {
    staticLayer(ctx, 'bg', W, H, (x, W, H) => {
      const g = x.createLinearGradient(0, 0, 0, H);
      g.addColorStop(0, '#12143a'); g.addColorStop(1, '#0a0b24');
      x.fillStyle = g; x.fillRect(0, 0, W, H);
    });
    ctx.save(); ctx.globalCompositeOperation = 'lighter';
    const m = Math.max(W, H);
    for (const b of inst.bokeh) {
      const x = (b.u + Math.sin(inst.t * b.sp + b.ph) * 0.06) * W, y = (b.v + Math.cos(inst.t * b.sp * 0.8 + b.ph * 2) * 0.06) * H;
      const r = b.s * m * 0.5 * (1 + Math.sin(inst.t * 0.2 + b.ph) * 0.08);
      ctx.globalAlpha = b.a;
      ctx.drawImage(glowSprite(b.hue), x - r, y - r, r * 2, r * 2);
    }
    ctx.restore();
    staticLayer(ctx, 'vg', W, H, (x, W, H) => {
      const vg = x.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.3, W / 2, H / 2, Math.max(W, H) * 0.75);
      vg.addColorStop(0, 'rgba(5,5,20,0)'); vg.addColorStop(1, 'rgba(5,5,20,0.55)');
      x.fillStyle = vg; x.fillRect(0, 0, W, H);
    });
  }
  function panel(ctx, x, y, w, h, r) {
    roundRect(ctx, x, y, w, h, r);
    const g = ctx.createLinearGradient(0, y, 0, y + h);
    g.addColorStop(0, 'rgba(34,38,92,0.62)'); g.addColorStop(1, 'rgba(14,16,48,0.72)');
    ctx.fillStyle = g; ctx.fill();
    ctx.lineWidth = 1.2; ctx.strokeStyle = 'rgba(190,200,255,0.22)'; ctx.stroke();
  }
  function blockAt(ctx, type, x, y, c, kind) {
    const dpr = ctx.getTransform().a || 1;
    const px = Math.max(8, Math.round(c * dpr));
    ctx.drawImage(cellSprite(type, px, kind || 'n'), x, y, c, c);
  }
  function drawWell(ctx) {
    const L = inst.L, c = L.c;
    panel(ctx, L.wx - c * 0.25, L.wy - c * 0.25, L.ww + c * 0.5, L.wh + c * 0.5, c * 0.35);
    ctx.save();
    roundRect(ctx, L.wx, L.wy, L.ww, L.wh, c * 0.12); ctx.clip();
    ctx.fillStyle = 'rgba(6,7,28,0.45)'; ctx.fillRect(L.wx, L.wy, L.ww, L.wh);
    ctx.strokeStyle = 'rgba(180,190,255,0.055)'; ctx.lineWidth = 1; ctx.beginPath();
    for (let i = 1; i < COLS; i++) { ctx.moveTo(L.wx + i * c + 0.5, L.wy); ctx.lineTo(L.wx + i * c + 0.5, L.wy + L.wh); }
    for (let j = 1; j < VIS; j++) { ctx.moveTo(L.wx, L.wy + j * c + 0.5); ctx.lineTo(L.wx + L.ww, L.wy + j * c + 0.5); }
    ctx.stroke();
    // glass sheen
    const sh = ctx.createLinearGradient(L.wx, L.wy, L.wx + L.ww, L.wy + L.wh);
    sh.addColorStop(0, 'rgba(255,255,255,0.07)'); sh.addColorStop(0.35, 'rgba(255,255,255,0)'); sh.addColorStop(1, 'rgba(255,255,255,0.02)');
    ctx.fillStyle = sh; ctx.fillRect(L.wx, L.wy, L.ww, L.wh);
    ctx.restore();
  }
  function drawBoard(ctx) {
    const L = inst.L, c = L.c;
    ctx.save();
    roundRect(ctx, L.wx, L.wy, L.ww, L.wh, c * 0.12); ctx.clip();
    const fe = ease.outCubic(Math.min(1, inst.fallT / 0.25));
    const clearing = new Set(inst.clearRows);
    const lost = inst.endKind === 'lost' ? Math.floor(inst.endT * 38) : 0;
    for (let y = HID; y < ROWS; y++) {
      const off = inst.fallOff[y] * (1 - fe) * c;
      const deadRow = lost > 0 && y >= ROWS - lost;
      for (let x = 0; x < COLS; x++) {
        const v = inst.grid[y * COLS + x]; if (!v) continue;
        const [px, py] = cellXY(x, y);
        if (clearing.has(y)) {
          const t = inst.clearT;
          if (t < 0.17) { blockAt(ctx, TYPES[v - 1], px, py, c); ctx.fillStyle = `rgba(255,255,255,${0.15 + 0.8 * ease.outQuad(t / 0.17)})`; roundRect(ctx, px + 1, py + 1, c - 2, c - 2, 3); ctx.fill(); }
          else {
            const u = Math.min(1, (t - 0.17) / 0.10), sy = Math.max(0.05, 1 - ease.outCubic(u));
            ctx.save(); ctx.translate(px, py + c / 2); ctx.scale(1, sy); ctx.translate(0, -c / 2);
            blockAt(ctx, TYPES[v - 1], 0, 0, c); ctx.fillStyle = 'rgba(255,255,255,0.9)'; ctx.fillRect(1, 1, c - 2, c - 2); ctx.restore();
          }
        } else blockAt(ctx, TYPES[v - 1], px, py + off, c, deadRow ? 'dead' : 'n');
      }
    }
    // lock flashes
    ctx.globalCompositeOperation = 'lighter';
    for (const f of inst.flashes) {
      if (f.y < HID) continue;
      const [px, py] = cellXY(f.x, f.y), a = (1 - f.t / 0.35) * 0.45;
      ctx.fillStyle = `rgba(255,255,255,${a})`; roundRect(ctx, px + 1, py + 1, c - 2, c - 2, 3); ctx.fill();
    }
    // clear lines
    for (const y of inst.clearRows) {
      const [, py] = cellXY(0, y), t = inst.clearT;
      if (t > 0.17) {
        const u = Math.min(1, (t - 0.17) / 0.10), a = 1 - u * 0.4;
        ctx.fillStyle = `rgba(160,190,255,${0.35 * a})`; ctx.fillRect(L.wx, py + c / 2 - c * 0.45, L.ww, c * 0.9);
        ctx.fillStyle = `rgba(255,255,255,${a})`; ctx.fillRect(L.wx, py + c / 2 - 1.5, L.ww, 3);
      }
    }
    // hard-drop streaks
    for (const s of inst.streaks) {
      const a = 1 - s.t / 0.3;
      for (const col of s.cols) {
        const x = L.wx + col * c, yTop = L.wy + (s.y0 + s.minY - HID) * c, yBot = L.wy + (s.y1 - HID) * c + c;
        const g = ctx.createLinearGradient(0, yTop, 0, yBot);
        g.addColorStop(0, `hsla(${s.hue},90%,70%,0)`); g.addColorStop(1, `hsla(${s.hue},90%,75%,${0.5 * a})`);
        ctx.fillStyle = g; ctx.fillRect(x + c * 0.12, yTop, c * 0.76, Math.max(0, yBot - yTop));
      }
    }
    ctx.restore();
    // active piece + ghost
    const p = inst.cur;
    if (p && !inst.over) {
      const cells = ROT[p.t][p.r], gy = ghostY();
      const hue = HUES[p.t];
      ctx.save();
      roundRect(ctx, L.wx, L.wy, L.ww, L.wh, c * 0.12); ctx.clip();
      // ghost outline = landing spot (also shows the AI's plan)
      ctx.lineWidth = Math.max(1.5, c * 0.06);
      for (const [cx, cy] of cells) {
        const row = gy + cy; if (row < HID) continue;
        const [px, py] = cellXY(p.x + cx, row);
        ctx.fillStyle = `hsla(${hue},80%,60%,0.10)`; ctx.strokeStyle = `hsla(${hue},85%,72%,0.7)`;
        roundRect(ctx, px + 2, py + 2, c - 4, c - 4, 4); ctx.fill(); ctx.stroke();
      }
      ctx.globalCompositeOperation = 'lighter'; ctx.globalAlpha = 0.5;
      for (const [cx, cy] of cells) {
        const gx = L.wx + (inst.pv.x + cx + 0.5) * c, gyy = L.wy + (inst.pv.y + cy - HID + 0.5) * c;
        ctx.drawImage(glowSprite(hue), gx - c * 1.5, gyy - c * 1.5, c * 3, c * 3);
      }
      ctx.restore();
      ctx.save();
      roundRect(ctx, L.wx, L.wy, L.ww, L.wh, c * 0.12); ctx.clip();
      const lockPulse = inst.lockT > 0 ? 0.25 * Math.sin(inst.lockT * 40) ** 2 : 0;
      for (const [cx, cy] of cells) {
        const px = L.wx + (inst.pv.x + cx) * c, py = L.wy + (inst.pv.y + cy - HID) * c;
        if (py < L.wy - c) continue;
        blockAt(ctx, p.t, px, py, c);
        if (lockPulse) { ctx.fillStyle = `rgba(255,255,255,${lockPulse})`; roundRect(ctx, px + 1, py + 1, c - 2, c - 2, 3); ctx.fill(); }
      }
      ctx.restore();
    }
  }
  function drawPanel(ctx) {
    const L = inst.L, c = L.c, x = L.px, w = L.pw;
    const label = (txt, y) => { ctx.font = `600 ${c * 0.46}px Fredoka, sans-serif`; ctx.fillStyle = 'rgba(190,200,255,0.6)'; ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic'; ctx.fillText(txt.split('').join(' '), x + c * 0.5, y); };
    const num = (txt, y, size) => { ctx.font = `600 ${c * size}px "IBM Plex Mono", monospace`; ctx.fillStyle = '#eef0ff'; ctx.textAlign = 'left'; ctx.fillText(txt, x + c * 0.5, y); };
    // NEXT
    const nh = c * 4;
    panel(ctx, x, L.wy, w, nh, c * 0.35);
    label('NEXT', L.wy + c * 0.85);
    if (inst.next) {
      const cells = ROT[inst.next][0];
      const xs = cells.map(q => q[0]), ys = cells.map(q => q[1]);
      const minx = Math.min(...xs), maxx = Math.max(...xs), miny = Math.min(...ys), maxy = Math.max(...ys);
      const s = c * 0.8, bw = (maxx - minx + 1) * s, bh = (maxy - miny + 1) * s;
      const ox = x + (w - bw) / 2 - minx * s, oy = L.wy + c * 1.1 + (nh - c * 1.1 - bh) / 2 - miny * s;
      const bob = Math.sin(inst.t * 1.6) * c * 0.04;
      ctx.save(); ctx.globalCompositeOperation = 'lighter'; ctx.globalAlpha = 0.45;
      ctx.drawImage(glowSprite(HUES[inst.next]), x + w / 2 - c * 2, L.wy + nh / 2 + c * 0.3 - c * 2, c * 4, c * 4); ctx.restore();
      for (const [cx, cy] of cells) blockAt(ctx, inst.next, ox + cx * s, oy + cy * s + bob, s);
    }
    // stats
    const sy = L.wy + nh + c * 0.7, sh = c * 8.4;
    panel(ctx, x, sy, w, sh, c * 0.35);
    label('LINES', sy + c * 1.0); num(String(inst.lines), sy + c * 2.15, 1.25);
    label('LEVEL', sy + c * 3.4); num(String(inst.level), sy + c * 4.55, 1.25);
    label('SCORE', sy + c * 5.8); num(String(inst.score), sy + c * 6.85, 0.95);
    // progress to goal
    const bx = x + c * 0.5, bw2 = w - c * 1.0, by = sy + sh - c * 0.65;
    roundRect(ctx, bx, by, bw2, c * 0.22, c * 0.11); ctx.fillStyle = 'rgba(255,255,255,0.1)'; ctx.fill();
    const pr = Math.min(1, inst.lines / WIN_LINES);
    if (pr > 0) { const g = ctx.createLinearGradient(bx, 0, bx + bw2, 0); g.addColorStop(0, '#6ee7f0'); g.addColorStop(1, '#ffd36e'); roundRect(ctx, bx, by, Math.max(c * 0.22, bw2 * pr), c * 0.22, c * 0.11); ctx.fillStyle = g; ctx.fill(); }
    ctx.font = `500 ${c * 0.36}px Fredoka, sans-serif`; ctx.fillStyle = 'rgba(190,200,255,0.5)';
    ctx.fillText(`GOAL ${WIN_LINES}`, bx, by - c * 0.2);
  }
  const drawRaw = (ctx, W, H) => {
    if (!inst.L) inst.resize(W, H);
    drawBg(ctx, W, H);
    ctx.save();
    const sh = inst.shake, L = inst.L;
    if (sh > 0.01) ctx.translate(Math.sin(inst.t * 83) * sh * L.c * 0.09, Math.cos(inst.t * 71) * sh * L.c * 0.09);
    drawWell(ctx); drawBoard(ctx); drawPanel(ctx);
    for (const f of inst.floaters) {
      const u = f.t / 1.4, a = u < 0.15 ? u / 0.15 : 1 - Math.max(0, (u - 0.5) / 0.5);
      ctx.globalAlpha = Math.max(0, a); ctx.textAlign = 'center';
      ctx.font = f.big === 0 ? `600 ${L.c * 0.8}px Fredoka, sans-serif` : `600 ${L.c * (0.8 + f.big * 0.12)}px "IBM Plex Mono", monospace`;
      ctx.fillStyle = f.big === 0 ? '#ffd36e' : '#fff';
      ctx.fillText(f.txt, f.x, f.y - ease.outCubic(Math.min(1, f.t / 0.8)) * L.c * 1.8);
    }
    ctx.globalAlpha = 1;
    parts.draw(ctx, Math.max(0.6, L.c / 28));
    if (inst.over && inst.endKind === 'lost') {
      const a = Math.min(0.35, inst.endT * 0.4); ctx.fillStyle = `rgba(8,8,30,${a})`; ctx.fillRect(L.wx, L.wy, L.ww, L.wh);
    }
    ctx.restore();
  };
  inst.draw = (ctx, W, H) => { const a = IP.alpha(), st = IP.push(ipg(), a); try { return drawRaw(ctx, W, H); } finally { IP.pop(st); } };
  inst.hud = () => ({ score: String(inst.score).replace(/\B(?=(\d{3})+(?!\d))/g, ' '), detail: `Level ${inst.level} · ${inst.lines} lines` });
  inst.result = () => (inst.msg || (inst.won ? `Cleared ${inst.lines} lines` : `Topped out at ${inst.lines} lines`)) + ` (${AW.name})`;
  spawn();
  return inst;
}

Arcade.register({
  id: 'tetris', name: 'Glass Stack', genre: 'Falling blocks',
  aiNote: "Sees the board, the falling piece and one next piece; reads each new piece for 0.12 s, then presses at most 14 keys a second.",
  blurb: 'Glassy tetrominoes, 150 lines to clear.',
  bg: '#0e1030', accent: '#7aa2ff', create,
});
})();
