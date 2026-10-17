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


// ---------------------------------------------------------------------------
// Bubble Reef — bubble shooter. Hex grid 15 wide, deep-sea look.
// Logical world: x 0..600 is the playfield (walls outside), y 0 is the ceiling
// plate at start, the launcher pivot is at (300,560). The ceiling plate is a
// physical object: when it drops, every bubble moves down with it.
// ---------------------------------------------------------------------------
const DEG = Math.PI / 180;
const R = 20, D = 40, RH = D * Math.sqrt(3) / 2;
const FW = 600, COLS = 15, MAXR = 18, START_ROWS = 9;
const DANGER_ABS = 12;                  // ceiling drops + row >= 13 means a bubble crossed the line
const DANGER_Y = 11 * RH + D;           // y of the drawn danger line
const PIV_X = 300, PIV_Y = 560;
const SPEED = 1000, SUB = 5, HIT = D * 0.88;
const MAX_ANG = 75 * DEG, ROT = 200 * DEG;
const TIDE_EVERY = 12;
const DROP_EVERY = 6, TIME_CAP = 360;
const NEXT_X = 120, NEXT_Y = 588;

const COLORS = [
  { name: 'coral',  base: '#ff6f61', light: '#ffd0c4', dark: '#a82f2f' },
  { name: 'glass',  base: '#4fd8a0', light: '#c9ffe6', dark: '#127a5c' },
  { name: 'sun',    base: '#ffd23f', light: '#fff4b8', dark: '#b8860f' },
  { name: 'lagoon', base: '#3b9cff', light: '#c4e4ff', dark: '#1646a8' },
  { name: 'urchin', base: '#a468e8', light: '#e6d0ff', dark: '#5a2a9c' },
  { name: 'shell',  base: '#ff9cc8', light: '#ffe0ef', dark: '#b8467e' },
];

// ---------------------------------------------------------------------------
// Grid helpers (rows are relative to the ceiling; odd rows are shifted by R
// and have 14 cells, even rows have 15). Shared by game rules and by the AI's
// physics model (a skilled player knows how shots bounce and settle).
// ---------------------------------------------------------------------------
const rowCols = r => (r & 1) ? COLS - 1 : COLS;
const cellX = (r, c) => ((r & 1) ? D : R) + c * D;
const cellY = (drops, r) => drops * RH + R + r * RH;
const newGrid = () => Array.from({ length: MAXR }, () => new Int8Array(COLS).fill(-1));
const cloneGrid = g => g.map(r => r.slice());

function nbrs(r, c) {
  const o = [];
  if (c > 0) o.push(r, c - 1);
  if (c < rowCols(r) - 1) o.push(r, c + 1);
  if (r & 1) {
    if (r > 0) o.push(r - 1, c, r - 1, c + 1);
    if (r < MAXR - 1) o.push(r + 1, c, r + 1, c + 1);
  } else {
    if (r > 0) { if (c > 0) o.push(r - 1, c - 1); if (c < COLS - 1) o.push(r - 1, c); }
    if (r < MAXR - 1) { if (c > 0) o.push(r + 1, c - 1); if (c < COLS - 1) o.push(r + 1, c); }
  }
  return o;
}

// Place `col` at (r,c); pop same-colour group of >=3, then drop unattached bubbles. Mutates g.
function apply(g, r, c, col) {
  g[r][c] = col;
  const seen = new Uint8Array(MAXR * COLS);
  const stack = [r, c], grp = [r, c];
  seen[r * COLS + c] = 1;
  while (stack.length) {
    const cc = stack.pop(), rr = stack.pop();
    const n = nbrs(rr, cc);
    for (let i = 0; i < n.length; i += 2) {
      const nr = n[i], nc = n[i + 1];
      if (!seen[nr * COLS + nc] && g[nr][nc] === col) { seen[nr * COLS + nc] = 1; stack.push(nr, nc); grp.push(nr, nc); }
    }
  }
  const popped = [], orphans = [];
  const gsz = grp.length / 2;
  if (gsz >= 3) {
    for (let i = 0; i < grp.length; i += 2) { popped.push([grp[i], grp[i + 1], col]); g[grp[i]][grp[i + 1]] = -1; }
    const att = new Uint8Array(MAXR * COLS);
    const st = [];
    for (let j = 0; j < COLS; j++) if (g[0][j] >= 0) { att[j] = 1; st.push(0, j); }
    while (st.length) {
      const cc = st.pop(), rr = st.pop();
      const n = nbrs(rr, cc);
      for (let i = 0; i < n.length; i += 2) {
        const nr = n[i], nc = n[i + 1];
        if (!att[nr * COLS + nc] && g[nr][nc] >= 0) { att[nr * COLS + nc] = 1; st.push(nr, nc); }
      }
    }
    for (let i = 0; i < MAXR; i++) for (let j = 0; j < rowCols(i); j++) {
      if (g[i][j] >= 0 && !att[i * COLS + j]) { orphans.push([i, j, g[i][j]]); g[i][j] = -1; }
    }
  }
  return { gsz, popped, orphans };
}

function nearHit(g, cy0, x, y) {
  const r0 = Math.max(0, Math.floor((y - cy0 - R) / RH) - 1), r1 = Math.min(MAXR - 1, r0 + 3);
  for (let r = r0; r <= r1; r++) {
    const dy = y - (cy0 + R + r * RH);
    if (dy > HIT || dy < -HIT) continue;
    const row = g[r], off = (r & 1) ? D : R;
    const c0 = Math.max(0, Math.floor((x - off) / D) - 1), c1 = Math.min(rowCols(r) - 1, c0 + 3);
    for (let c = c0; c <= c1; c++) {
      if (row[c] >= 0) { const dx = x - (off + c * D); if (dx * dx + dy * dy < HIT * HIT) return true; }
    }
  }
  return false;
}

// One SUB-length step of a flying bubble; returns true when it stops.
function advance(g, cy0, s) {
  s.x += s.dx * SUB; s.y += s.dy * SUB;
  if (s.x < R) { s.x = 2 * R - s.x; s.dx = -s.dx; }
  else if (s.x > FW - R) { s.x = 2 * (FW - R) - s.x; s.dx = -s.dx; }
  if (s.y <= cy0 + R) { s.y = cy0 + R; return true; }
  return nearHit(g, cy0, s.x, s.y);
}

function settleCell(g, cy0, x, y) {
  const rc = Math.round((y - cy0 - R) / RH);
  let best = null, bd = 1e12;
  for (let r = Math.max(0, rc - 1); r <= Math.min(MAXR - 1, rc + 1); r++) {
    const off = (r & 1) ? D : R;
    const c0 = Math.max(0, Math.floor((x - off) / D) - 1), c1 = Math.min(rowCols(r) - 1, c0 + 3);
    for (let c = c0; c <= c1; c++) {
      if (g[r][c] >= 0) continue;
      let ok = r === 0;
      if (!ok) { const n = nbrs(r, c); for (let i = 0; i < n.length; i += 2) if (g[n[i]][n[i + 1]] >= 0) { ok = true; break; } }
      if (!ok) continue;
      const dx = x - (off + c * D), dy = y - (cy0 + R + r * RH), d = dx * dx + dy * dy;
      if (d < bd) { bd = d; best = { r, c }; }
    }
  }
  return best;
}

// Trace a shot at `ang` (radians from vertical). rec (optional) gets the polyline.
function trace(g, drops, ang, rec) {
  const s = { x: PIV_X, y: PIV_Y, dx: Math.sin(ang), dy: -Math.cos(ang) };
  const cy0 = drops * RH;
  if (rec) rec.pts = [{ x: s.x, y: s.y }];
  for (let i = 0; i < 700; i++) {
    const pdx = s.dx;
    const stop = advance(g, cy0, s);
    if (rec && pdx !== s.dx) rec.pts.push({ x: s.x < FW / 2 ? R : FW - R, y: s.y });
    if (stop) {
      if (rec) rec.pts.push({ x: s.x, y: s.y });
      const cell = settleCell(g, cy0, s.x, s.y);
      return cell ? { r: cell.r, c: cell.c, x: s.x, y: s.y } : null;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// AI — "ReefAI". WHAT IT SEES: exactly what is on screen — the colour of every
// bubble in the grid, how many times the ceiling has dropped (the plate's
// position), the loaded bubble and the one NEXT bubble, the 6 ceiling studs
// (shots without a pop), and the barrel angle. It does not see future random
// colours beyond NEXT. HOW IT ACTS: it only sets a target barrel angle (the
// barrel turns at <= 200 deg/s with easing) and presses fire after the barrel
// has settled for 0.1 s. It re-derives wall bounces itself (the on-screen
// guide shows only one bounce, but a human can extend it with geometry).
// Planning is spread across ticks (a "thinking" pause of ~0.25 s).
// ---------------------------------------------------------------------------
function colorCounts(g) {
  const cnt = new Array(6).fill(0);
  for (let i = 0; i < MAXR; i++) for (let j = 0; j < COLS; j++) { const v = g[i][j]; if (v >= 0) cnt[v]++; }
  return cnt;
}

// Styles: how placements are valued. pexp>1 favours big pops; drop weights orphaned (falling)
// bubbles; bank adds a bonus for cells reachable by a wall bounce (and aims via the bounce).
const STYLES = {
  'Big combos': { pexp: 1.4, drop: 1.5, bank: 0 },
  'Drop hunter': { pexp: 1, drop: 3.4, bank: 0 },
  'Bank-shot lover': { pexp: 1, drop: 1.5, bank: 1.1 },
};
let ST = STYLES['Big combos'];

function evalPlacement(g0, drops, shots, tide, r, c, col, counts) {
  const g = cloneGrid(g0);
  const res = apply(g, r, c, col);
  let score = 0, nd = drops, ns = shots, nt = tide + 1;
  if (nt >= TIDE_EVERY) { nt = 0; nd++; }
  const popped = res.popped.length, dropped = res.orphans.length;
  let empty = true, lowest = -1;
  for (let i = 0; i < MAXR; i++) { const row = g[i]; for (let j = 0; j < COLS; j++) if (row[j] >= 0) { empty = false; if (i > lowest) lowest = i; } }
  if (popped) { score += Math.pow(popped, ST.pexp) + ST.drop * dropped + 1; ns = 0; }
  else {
    ns = shots + 1;
    if (ns >= DROP_EVERY) { ns = 0; nd++; }
    if (res.gsz === 2) score += 0.6;
    const nb = nbrs(r, c);
    let rare = 0, k = 0;
    for (let i = 0; i < nb.length; i += 2) {
      const v = g[nb[i]][nb[i + 1]];
      if (v >= 0) { k++; if (v !== col && counts[v] <= 4) rare++; }
    }
    score += 0.12 * k - 0.8 * rare;
  }
  if (empty) return { score: score + 200, g, drops: nd, shots: ns, tide: nt, empty: true };
  const absLow = nd + lowest;
  if (absLow >= DANGER_ABS) return { score: -1000, g, drops: nd, shots: ns, tide: nt, dead: true };
  score -= 0.35 * Math.pow(Math.max(0, absLow - 6), 1.6);
  return { score, g, drops: nd, shots: ns, tide: nt };
}

const ReefAI = {
  gen: null, plan: null, shotKey: -1, settle: 0, delay: 0,
  reset() { this.gen = null; this.plan = null; this.shotKey = -1; this.settle = 0; },

  tick(dt, obs) {
    if (!obs.ready) { this.gen = null; this.plan = null; this.shotKey = -1; this.settle = 0; return { target: null, fire: false }; }
    if (obs.shotId !== this.shotKey) {
      this.shotKey = obs.shotId; this.plan = null; this.settle = 0; this.delay = 0.12;
      this.gen = this.planner(obs.grid(), obs.drops, obs.cur, obs.next, obs.shots, obs.tide);
    }
    this.delay -= dt;
    if (!this.plan && this.gen && this.delay <= 0) { if (this.gen.next().done) this.gen = null; }
    if (!this.plan) return { target: null, fire: false };
    const err = Math.abs(obs.angle - this.plan.target);
    if (err < 0.0009) this.settle += dt; else this.settle = 0;
    return { target: this.plan.target, fire: this.settle >= 0.1 };
  },

  *planner(g, drops, cur, nxt, shots, tide) {
    // Stage A: sample the allowed aim range every 0.4 deg and find where each shot lands.
    const runs = [];
    let prev = null, n = 0;
    for (let i = 0; i <= 375; i++) {
      const a = (-75 + i * 0.4) * DEG;
      const res = trace(g, drops, a);
      const key = res ? res.r * 32 + res.c : -1;
      if (prev && prev.key === key && prev.last === i - 1) { prev.a1 = a; prev.n++; prev.last = i; }
      else { prev = { key, r: res ? res.r : 0, c: res ? res.c : 0, a0: a, a1: a, n: 1, last: i }; runs.push(prev); }
      if (++n % 70 === 0) yield;
    }
    const cells = new Map();
    for (const run of runs) {
      if (run.key < 0) continue;
      let e = cells.get(run.key);
      if (!e) { e = { key: run.key, r: run.r, c: run.c, runs: [] }; cells.set(run.key, e); }
      e.runs.push(run);
    }
    yield;
    // Stage B: static score of every reachable cell.
    const counts = colorCounts(g);
    const list = [];
    for (const e of cells.values()) {
      e.ev = evalPlacement(g, drops, shots, tide, e.r, e.c, cur, counts);
      e.total = e.ev.score;
      list.push(e);
    }
    yield;
    // Stage C: one-ply lookahead with the visible NEXT bubble.
    let k = 0;
    for (const e of list) {
      const ev = e.ev;
      if (!ev.dead && !ev.empty) {
        const cnt2 = colorCounts(ev.g);
        if (cnt2[nxt] > 0) {
          let best = -1e9;
          const memo = new Set();
          for (let a = -75; a <= 75; a += 2) {
            const res = trace(ev.g, ev.drops, a * DEG);
            if (!res) continue;
            const key = res.r * 32 + res.c;
            if (memo.has(key)) continue;
            memo.add(key);
            const s2 = evalPlacement(ev.g, ev.drops, ev.shots, ev.tide, res.r, res.c, nxt, cnt2).score;
            if (s2 > best) best = s2;
          }
          if (best > -1e8) e.total += 0.7 * best;
        }
        if (nxt === cur && ev.g[e.r][e.c] === cur && ev.shots !== 0 && !e.ev.dead) e.total += 0.0;
      }
      if (++k % 2 === 0) yield;
    }
    // Pick the best cell; aim at the middle of its widest angle run (nearest to the barrel on ties).
    const isBank = run => { const rec = {}; trace(g, drops, (run.a0 + run.a1) / 2, rec); return rec.pts.length > 2; };
    if (ST.bank) {
      list.sort((x, y) => y.total - x.total);
      for (let i = 0; i < Math.min(8, list.length); i++) {
        const e = list[i];
        for (const run of e.runs) if (run.n >= 3 && isBank(run)) { run.bank = true; e.total += ST.bank; break; }
      }
    }
    let bestE = null;
    for (const e of list) { e.total += Math.random() * 0.03; if (!bestE || e.total > bestE.total) bestE = e; }
    let bestRun = null;
    for (const run of bestE.runs) {
      const w = run.n + (ST.bank && run.bank ? 1000 : 0) + Math.random() * 0.5;
      if (!bestRun || w > bestRun.w) { bestRun = run; run.w = w; }
    }
    this.plan = { target: (bestRun.a0 + bestRun.a1) / 2, cell: bestE };
  },
};

// ---------------------------------------------------------------------------
// Game
// ---------------------------------------------------------------------------
const SPR = 96, BR = 44, SPR_DRAW = SPR * R / BR;
let sprites = null;
function makeSprites() {
  return COLORS.map(c => {
    const cv = document.createElement('canvas');
    cv.width = cv.height = SPR;
    const x = cv.getContext('2d');
    const m = SPR / 2;
    let g = x.createRadialGradient(m - BR * 0.28, m - BR * 0.32, BR * 0.08, m, m, BR);
    g.addColorStop(0, c.light); g.addColorStop(0.5, c.base); g.addColorStop(1, c.dark);
    x.fillStyle = g; x.beginPath(); x.arc(m, m, BR - 1, 0, TAU); x.fill();
    x.save(); x.beginPath(); x.arc(m, m, BR - 1, 0, TAU); x.clip();
    g = x.createRadialGradient(m + BR * 0.38, m + BR * 0.45, 0, m + BR * 0.38, m + BR * 0.45, BR * 0.85);
    g.addColorStop(0, 'rgba(255,255,255,0.34)'); g.addColorStop(1, 'rgba(255,255,255,0)');
    x.fillStyle = g; x.fillRect(0, 0, SPR, SPR);
    g = x.createRadialGradient(m, m, BR * 0.72, m, m, BR);
    g.addColorStop(0, 'rgba(255,255,255,0)'); g.addColorStop(1, 'rgba(255,255,255,0.35)');
    x.fillStyle = g; x.fillRect(0, 0, SPR, SPR);
    x.restore();
    x.strokeStyle = 'rgba(255,255,255,0.5)'; x.lineWidth = 2;
    x.beginPath(); x.arc(m, m, BR - 1.5, 0, TAU); x.stroke();
    x.save(); x.translate(m - BR * 0.36, m - BR * 0.44); x.rotate(-0.75);
    g = x.createLinearGradient(0, -BR * 0.18, 0, BR * 0.18);
    g.addColorStop(0, 'rgba(255,255,255,0.95)'); g.addColorStop(1, 'rgba(255,255,255,0.35)');
    x.fillStyle = g; x.beginPath(); x.ellipse(0, 0, BR * 0.3, BR * 0.16, 0, 0, TAU); x.fill();
    x.restore();
    x.fillStyle = 'rgba(255,255,255,0.7)';
    x.beginPath(); x.arc(m + BR * 0.46, m + BR * 0.5, BR * 0.06, 0, TAU); x.fill();
    return cv;
  });
}

function bub(ctx, col, x, y, sc, alpha) {
  const sz = SPR_DRAW * sc;
  if (alpha !== 1) ctx.globalAlpha = alpha;
  ctx.drawImage(sprites[col], x - sz / 2, y - sz / 2, sz, sz);
  if (alpha !== 1) ctx.globalAlpha = 1;
}

class Reef {
  constructor() {
    this.W = 1600; this.H = 900; this.s = 1; this.tx = 0; this.ty = 0;
    this.t = 0; this.over = false; this.won = false; this.endMsg = ''; this.endT = 0;
    this.g = newGrid(); this.drops = 0; this.dropT = 1; this.gridVer = 0; this._obsVer = -1; this._obsGrid = null;
    this.ang = 0;
    this.shots = 0; this.fired = 0; this.score = 0; this.popTotal = 0; this.shotId = 0;
    this.state = 'reload'; this.reloadT = 1.0; this.shot = null; this.trail = [];
    this.pops = []; this.falling = []; this.rings = []; this.floats = []; this.bumps = []; this.rise = [];
    this.parts = new Particles();
    this.settle = null; this.shake = 0; this.recoil = 0; this.flash = 0; this.curT = 1; this.nextT = 0;
    this.riseAcc = 0; this.burstAcc = 0;
    this.fill();
    const present = this.present();
    this.cur = rnd.pick(present); this.next = rnd.pick(present);
    // ambient
    this.shafts = Array.from({ length: 6 }, (_, i) => ({ x: 0.08 + i * 0.17 + rnd.float(-0.03, 0.03), w: rnd.float(0.04, 0.08), ph: rnd.float(0, TAU), sp: rnd.float(0.08, 0.16), a: rnd.float(0.045, 0.09) }));
    this.motes = Array.from({ length: 80 }, () => ({ x: Math.random(), y: Math.random(), r: rnd.float(0.8, 2.6), vx: rnd.float(-0.006, 0.006), vy: rnd.float(-0.012, -0.002), ph: rnd.float(0, TAU) }));
    this.kelp = [];
    for (const side of [-1, 1]) for (let i = 0; i < 6; i++) this.kelp.push({ side, off: Math.random(), h: rnd.float(0.28, 0.75), w: rnd.float(7, 15), ph: rnd.float(0, TAU), amp: rnd.float(14, 34), a: rnd.float(0.35, 0.8), n: rnd.int(3) });
    this.style = rnd.pick(Object.keys(STYLES)); ST = STYLES[this.style];
    ReefAI.reset();
  }

  fill() {
    for (let r = 0; r < START_ROWS; r++) {
      for (let c = 0; c < rowCols(r); c++) {
        let col = rnd.int(6);
        const u = Math.random();
        if (u < 0.06 && c > 0) col = this.g[r][c - 1];
        else if (u < 0.12 && r > 0) col = this.g[r - 1][Math.min(c, rowCols(r - 1) - 1)];
        this.g[r][c] = col;
      }
    }
    this.gridVer++;
  }

  present() {
    const cnt = colorCounts(this.g), out = [];
    for (let i = 0; i < 6; i++) if (cnt[i] > 0) out.push(i);
    return out;
  }

  resize(W, H) {
    this.W = W; this.H = H;
    this.s = Math.min(W * 0.92 / 672, H * 0.9 / 700);
    let cy = H / 2;
    // keep clear of the shell HUD box (bottom-left, ~360x100 px)
    if (W / 2 - 300 * this.s < 370 && H / 2 + 350 * this.s > H - 104) {
      this.s = Math.min(this.s, (H - 104 - H * 0.02) / 700);
      cy = (H * 0.01 + H - 104) / 2;
    }
    this.tx = W / 2 - 300 * this.s; this.ty = cy - 300 * this.s;
  }

  hud() {
    let left = 0;
    for (let i = 0; i < MAXR; i++) for (let j = 0; j < COLS; j++) if (this.g[i][j] >= 0) left++;
    return { score: String(this.score).replace(/\B(?=(\d{3})+(?!\d))/g, ' '), detail: `${left} bubbles left · shot ${this.fired}` };
  }
  result() {
    if (this.won) return `Cleared the reef in ${this.fired} shots (${this.style})`;
    return `${this.endMsg || 'The reef got too crowded'} after ${this.fired} shots (${this.style})`;
  }

  ceilVis() { return (this.drops - (1 - ease.outCubic(Math.min(1, this.dropT)))) * RH; }

  tideCount() { return (this.fired - (this.state === 'fly' ? 1 : 0)) % TIDE_EVERY; }

  observe() {
    if (this._obsVer !== this.gridVer) { this._obsGrid = cloneGrid(this.g); this._obsVer = this.gridVer; }
    const gg = this._obsGrid;
    return {
      ready: !this.over && this.state !== 'fly' && this.cur >= 0,
      shotId: this.shotId, grid: () => cloneGrid(gg), drops: this.drops, cur: this.cur, next: this.next,
      shots: this.shots, tide: this.tideCount(), angle: this.ang,
    };
  }

  _ipg() { return [[[this], ['ang'], 2], [this.shot ? [this.shot] : [], ['x', 'y'], 60]]; }

  step(dt) {

    IP.snap(this._ipg());
    this.t += dt;
    this.animate(dt);
    if (this.over) return;
    if (this.t > TIME_CAP) { this.lose('Out of time'); return; }
    if (this.state === 'reload') {
      this.reloadT -= dt;
      if (this.reloadT <= 0) this.state = 'aim';
    }
    const cmd = ReefAI.tick(dt, this.observe());
    if (cmd.target != null && this.state !== 'fly') {
      const tgt = clamp(cmd.target, -MAX_ANG, MAX_ANG);
      const diff = tgt - this.ang;
      if (Math.abs(diff) < 0.0004) this.ang = tgt;
      else this.ang += clamp(diff * 9, -ROT, ROT) * dt;
    }
    if (this.state === 'aim' && cmd.fire) this.fire();
    if (this.state === 'fly') this.fly(dt);
  }

  fire() {
    const a = this.ang;
    this.shot = { x: PIV_X, y: PIV_Y, dx: Math.sin(a), dy: -Math.cos(a), col: this.cur, budget: 0 };
    this.cur = -1; this.state = 'fly'; this.fired++; this.recoil = 1; this.trail = [];
  }

  fly(dt) {
    const s = this.shot, cy0 = this.drops * RH;
    s.budget += SPEED * dt;
    while (s.budget >= SUB) {
      s.budget -= SUB;
      if (advance(this.g, cy0, s)) { this.land(); return; }
    }
    this.trail.push({ x: s.x, y: s.y });
    if (this.trail.length > 9) this.trail.shift();
  }

  land() {
    const s = this.shot; this.shot = null;
    const cy0 = this.drops * RH;
    this.shotId++;
    const cell = settleCell(this.g, cy0, s.x, s.y);
    let dropped = false;
    if (cell) {
      const { r, c } = cell, col = s.col;
      const px = cellX(r, c), py = cellY(this.drops, r);
      const res = apply(this.g, r, c, col);
      this.gridVer++;
      this.bumps.push({ x: px, y: py, t: 0 });
      this.shake = Math.max(this.shake, 1.2);
      if (this.g[r][c] >= 0) this.settle = { r, c, fx: s.x, fy: s.y, t: 0 };
      if (res.popped.length) {
        this.shots = 0;
        for (const [pr, pc, pcol] of res.popped) {
          const x = cellX(pr, pc), y = cellY(this.drops, pr);
          this.pops.push({ x, y, col: pcol, delay: Math.hypot(x - px, y - py) / D * 0.05 + 0.04, t: 0 });
        }
        for (const [orr, occ, ocol] of res.orphans) {
          const x = cellX(orr, occ), y = cellY(this.drops, orr);
          this.falling.push({ x, y, col: ocol, vx: rnd.float(-50, 50), vy: rnd.float(-140, -40), delay: 0.14 + Math.hypot(x - px, y - py) / D * 0.035 + Math.random() * 0.08, age: 0, go: false });
        }
        const pts = res.popped.length * 10 + res.orphans.length * 25;
        this.score += pts; this.popTotal += res.popped.length + res.orphans.length;
        this.floats.push({ x: px, y: py - 10, t: 0, txt: '+' + pts, big: res.orphans.length > 0 });
      } else {
        this.shots++;
        if (this.shots >= DROP_EVERY) {
          this.shots = 0; this.drops++; this.dropT = 0; dropped = true; this.shake = 3; this.gridVer++;
        }
      }
      // creeping tide: the ceiling also sinks every TIDE_EVERY shots whatever happens
      if (!dropped && this.fired % TIDE_EVERY === 0) { this.drops++; this.dropT = 0; dropped = true; this.shake = 3; this.gridVer++; }
    }
    // end checks
    let any = false, danger = false;
    for (let i = 0; i < MAXR; i++) for (let j = 0; j < COLS; j++) if (this.g[i][j] >= 0) { any = true; if (this.drops + i >= DANGER_ABS) danger = true; }
    if (!any) { this.win(); return; }
    if (danger) { this.lose('The reef got too crowded'); return; }
    const pres = this.present();
    this.cur = pres.includes(this.next) ? this.next : rnd.pick(pres);
    this.next = rnd.pick(pres);
    this.curT = 0; this.nextT = 0;
    this.state = 'reload'; this.reloadT = dropped ? 0.9 : 0.62;
  }

  win() {
    this.over = true; this.won = true; this.endT = 0; this.state = 'over'; this.cur = -1;
    this.shake = 2;
    for (let i = 0; i < 4; i++) this.parts.burst(rnd.float(60, 540), rnd.float(60, 400), 26, { speed: 300, color: ['#fff', '#ffd23f', '#4fd8a0', '#ff9cc8', '#3b9cff'], gravity: 200, life: 1.2, size: 4 });
  }

  lose(msg) {
    this.over = true; this.won = false; this.endMsg = msg; this.endT = 0; this.state = 'over';
    this.shot = null; this.flash = 1; this.shake = 6; this.cur = -1;
    let maxRow = 0;
    for (let i = 0; i < MAXR; i++) for (let j = 0; j < COLS; j++) if (this.g[i][j] >= 0 && i > maxRow) maxRow = i;
    for (let i = 0; i < MAXR; i++) for (let j = 0; j < COLS; j++) {
      const v = this.g[i][j];
      if (v >= 0) { this.pops.push({ x: cellX(i, j), y: cellY(this.drops, i), col: v, delay: 0.3 + (maxRow - i) * 0.07 + Math.random() * 0.06, t: 0, dull: true }); this.g[i][j] = -1; }
    }
    this.gridVer++;
  }

  animate(dt) {
    this.parts.update(dt);
    for (let i = this.pops.length - 1; i >= 0; i--) {
      const p = this.pops[i]; p.t += dt;
      if (p.t >= p.delay) {
        const c = COLORS[p.col];
        this.rings.push({ x: p.x, y: p.y, t: 0, col: p.dull ? '#9fc4d4' : c.light });
        this.parts.burst(p.x, p.y, p.dull ? 5 : 9, { speed: 230, speedMin: 50, color: [c.light, '#fff', c.base], gravity: 520, life: 0.8, size: 3.4, drag: 1.6 });
        this.pops[i] = this.pops[this.pops.length - 1]; this.pops.pop();
      }
    }
    for (let i = this.falling.length - 1; i >= 0; i--) {
      const f = this.falling[i]; f.age += dt;
      if (!f.go && f.age >= f.delay) f.go = true;
      if (f.go) { f.vy += 1700 * dt; f.x += f.vx * dt; f.y += f.vy * dt; }
      if (f.y > 900 || f.age > 2.2) { this.falling[i] = this.falling[this.falling.length - 1]; this.falling.pop(); }
    }
    for (let i = this.rings.length - 1; i >= 0; i--) { this.rings[i].t += dt / 0.45; if (this.rings[i].t >= 1) { this.rings[i] = this.rings[this.rings.length - 1]; this.rings.pop(); } }
    for (let i = this.floats.length - 1; i >= 0; i--) { this.floats[i].t += dt; if (this.floats[i].t > 1.2) { this.floats[i] = this.floats[this.floats.length - 1]; this.floats.pop(); } }
    for (let i = this.bumps.length - 1; i >= 0; i--) { this.bumps[i].t += dt; if (this.bumps[i].t > 0.55) { this.bumps[i] = this.bumps[this.bumps.length - 1]; this.bumps.pop(); } }
    if (this.settle) { this.settle.t += dt / 0.1; if (this.settle.t >= 1) this.settle = null; }
    if (this.dropT < 1) { this.dropT = Math.min(1, this.dropT + dt / 0.7); this.shake = Math.max(this.shake, 2.6 * (1 - this.dropT)); }
    this.shake *= Math.exp(-6 * dt);
    this.recoil *= Math.exp(-9 * dt);
    this.flash *= Math.exp(-2.2 * dt);
    this.curT = Math.min(1, this.curT + dt / 0.4);
    this.nextT = Math.min(1, this.nextT + dt / 0.4);
    if (this.over) this.endT += dt;
    if (this.won && this.endT < 2.8) {
      this.riseAcc += dt * 24;
      while (this.riseAcc >= 1) { this.riseAcc--; this.rise.push({ x: rnd.float(10, 590), y: 670, vy: -rnd.float(140, 300), col: rnd.int(6), sc: rnd.float(0.6, 1.4), ph: rnd.float(0, TAU) }); }
      this.burstAcc += dt;
      if (this.burstAcc > 0.28) { this.burstAcc = 0; this.parts.burst(rnd.float(50, 550), rnd.float(40, 420), 22, { speed: 280, color: ['#fff', '#ffd23f', '#4fd8a0', '#ff9cc8', '#3b9cff', '#a468e8'], gravity: 220, life: 1.1, size: 4 }); }
    }
    for (let i = this.rise.length - 1; i >= 0; i--) { const b = this.rise[i]; b.y += b.vy * dt; b.x += Math.sin(this.t * 2 + b.ph) * 20 * dt; if (b.y < -80) { this.rise[i] = this.rise[this.rise.length - 1]; this.rise.pop(); } }
  }

  // ------------------------------------------------------------------ drawing
  draw(ctx, W, H) {
    const a = IP.alpha();
    const st = IP.push(this._ipg(), a);
    try { this._draw(ctx, W, H); } finally { IP.pop(st); }
  }
  _draw(ctx, W, H) {
    if (!sprites) sprites = makeSprites();
    this.drawBackground(ctx, W, H);
    const sx = Math.sin(this.t * 83) * this.shake, sy = Math.cos(this.t * 71) * this.shake * 0.7;
    ctx.save();
    ctx.translate(this.tx + sx * this.s, this.ty + sy * this.s);
    ctx.scale(this.s, this.s);
    this.drawBoard(ctx);
    ctx.restore();
  }

  drawBackground(ctx, W, H) {
    const t = this.t;
    staticLayer(ctx, 'bg', W, H, (x, W, H) => {
      const g = x.createLinearGradient(0, 0, 0, H);
      g.addColorStop(0, '#06283d'); g.addColorStop(1, '#0b4f6c');
      x.fillStyle = g; x.fillRect(0, 0, W, H);
    });
    let g;
    // soft glow from above
    g = ctx.createRadialGradient(W * 0.5, -H * 0.1, 0, W * 0.5, -H * 0.1, H * 1.1);
    g.addColorStop(0, 'rgba(120,220,240,0.22)'); g.addColorStop(1, 'rgba(120,220,240,0)');
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
    // light shafts
    ctx.save(); ctx.globalCompositeOperation = 'lighter';
    for (const sh of this.shafts) {
      const cx = W * (sh.x + 0.03 * Math.sin(t * sh.sp + sh.ph));
      const lean = W * 0.1 + W * 0.04 * Math.sin(t * sh.sp * 0.7 + sh.ph * 2);
      const w0 = W * sh.w * 0.5, w1 = W * sh.w * 1.6;
      const gg = ctx.createLinearGradient(0, 0, 0, H);
      const a = sh.a * (0.75 + 0.25 * Math.sin(t * 0.3 + sh.ph));
      gg.addColorStop(0, `rgba(170,240,255,${a})`); gg.addColorStop(1, 'rgba(170,240,255,0)');
      ctx.fillStyle = gg;
      ctx.beginPath();
      ctx.moveTo(cx - w0, -10); ctx.lineTo(cx + w0, -10);
      ctx.lineTo(cx + lean + w1, H); ctx.lineTo(cx + lean - w1, H);
      ctx.closePath(); ctx.fill();
    }
    ctx.restore();
    // kelp
    const sc = Math.min(W, H) / 900;
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    for (const k of this.kelp) {
      const bx = k.side < 0 ? W * 0.16 * k.off - 10 * sc : W - W * 0.16 * k.off + 10 * sc;
      const hh = H * k.h, N = 12;
      const pts = [];
      for (let i = 0; i <= N; i++) {
        const f = i / N;
        pts.push([bx + Math.sin(t * 0.7 + k.ph + f * 2.4) * k.amp * sc * f * f * 1.4 + k.side * -f * 12 * sc, H + 12 - hh * f]);
      }
      ctx.strokeStyle = `rgba(2,28,40,${k.a})`; ctx.lineWidth = k.w * sc;
      ctx.beginPath(); ctx.moveTo(pts[0][0], pts[0][1]);
      for (let i = 1; i <= N; i++) ctx.lineTo(pts[i][0], pts[i][1]);
      ctx.stroke();
      ctx.fillStyle = `rgba(2,28,40,${k.a})`;
      for (let i = 2; i < N; i += 2) {
        const p = pts[i], dir = (i / 2 + k.n) % 2 ? 1 : -1;
        ctx.save(); ctx.translate(p[0], p[1]); ctx.rotate(dir * 0.9 + Math.sin(t * 0.9 + i + k.ph) * 0.15);
        ctx.beginPath(); ctx.ellipse(dir * 14 * sc, 0, 20 * sc, 5.5 * sc, 0, 0, TAU); ctx.fill();
        ctx.restore();
      }
    }
    // seabed haze
    g = ctx.createLinearGradient(0, H * 0.72, 0, H);
    g.addColorStop(0, 'rgba(2,20,30,0)'); g.addColorStop(1, 'rgba(2,20,30,0.55)');
    ctx.fillStyle = g; ctx.fillRect(0, H * 0.72, W, H * 0.28);
    // plankton motes
    ctx.fillStyle = '#d6f6ff';
    for (const m of this.motes) {
      const x = ((m.x + m.vx * t + 0.03 * Math.sin(t * 0.4 + m.ph)) % 1 + 1) % 1 * W;
      const y = ((m.y + m.vy * t) % 1 + 1) % 1 * H;
      ctx.globalAlpha = 0.15 + 0.3 * (0.5 + 0.5 * Math.sin(t * 0.8 + m.ph));
      ctx.beginPath(); ctx.arc(x, y, m.r * sc * 1.2, 0, TAU); ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  drawBoard(ctx) {
    const t = this.t;
    const ceil = this.ceilVis();
    // panel
    let g = ctx.createLinearGradient(0, 0, 0, 640);
    g.addColorStop(0, 'rgba(3,26,42,0.55)'); g.addColorStop(1, 'rgba(3,40,58,0.35)');
    ctx.fillStyle = g; ctx.fillRect(0, -60, FW, 720);
    // sand floor
    g = ctx.createLinearGradient(0, 612, 0, 650);
    g.addColorStop(0, 'rgba(214,184,128,0.55)'); g.addColorStop(1, 'rgba(110,86,52,0.8)');
    ctx.fillStyle = g; ctx.fillRect(0, 618, FW, 40);
    ctx.fillStyle = 'rgba(255,240,200,0.18)';
    for (let i = 0; i < 14; i++) { ctx.beginPath(); ctx.ellipse(20 + i * 43 + (i % 3) * 7, 632 + (i % 4) * 4, 5 + (i % 3) * 2, 2.2, 0, 0, TAU); ctx.fill(); }
    // walls
    for (const side of [0, 1]) {
      const x0 = side ? FW : -24;
      g = ctx.createLinearGradient(x0, 0, x0 + 24, 0);
      if (side) { g.addColorStop(0, 'rgba(120,210,225,0.55)'); g.addColorStop(1, 'rgba(10,60,80,0.9)'); }
      else { g.addColorStop(0, 'rgba(10,60,80,0.9)'); g.addColorStop(1, 'rgba(120,210,225,0.55)'); }
      ctx.fillStyle = g; ctx.fillRect(x0, -60, 24, 722);
      ctx.fillStyle = 'rgba(210,250,255,0.28)'; ctx.fillRect(side ? FW : -1.5, -60, 1.5, 722);
      for (let y = 20; y < 640; y += 78) {
        const sg = ctx.createRadialGradient(x0 + 12 - 2, y - 2, 0.5, x0 + 12, y, 6);
        sg.addColorStop(0, '#fff2b8'); sg.addColorStop(0.6, '#d9a93f'); sg.addColorStop(1, '#7a5518');
        ctx.fillStyle = sg; ctx.beginPath(); ctx.arc(x0 + 12, y, 5, 0, TAU); ctx.fill();
      }
    }
    // danger line
    let lowAbs = 0;
    for (let i = 0; i < MAXR; i++) { const row = this.g[i]; for (let j = 0; j < COLS; j++) if (row[j] >= 0) { lowAbs = Math.max(lowAbs, this.drops + i); break; } }
    const near = lowAbs >= 10;
    const pulse = near ? 0.5 + 0.5 * Math.sin(t * 7) : 0;
    ctx.save();
    ctx.setLineDash([12, 9]); ctx.lineDashOffset = -t * 12;
    ctx.strokeStyle = `rgba(255,112,96,${0.28 + 0.4 * pulse + 0.5 * this.flash})`; ctx.lineWidth = 2.5;
    ctx.beginPath(); ctx.moveTo(0, DANGER_Y); ctx.lineTo(FW, DANGER_Y); ctx.stroke();
    ctx.restore();
    if (near) { g = ctx.createLinearGradient(0, DANGER_Y - 60, 0, DANGER_Y); g.addColorStop(0, 'rgba(255,90,70,0)'); g.addColorStop(1, `rgba(255,90,70,${0.12 * pulse})`); ctx.fillStyle = g; ctx.fillRect(0, DANGER_Y - 60, FW, 60); }

    // aiming guide
    if (!this.over && this.state !== 'fly' && this.cur >= 0) this.drawGuide(ctx);

    // grid bubbles
    const gridDrops = this.drops;
    const yBase = ceil + R;
    for (let r = 0; r < MAXR; r++) {
      const row = this.g[r];
      for (let c = 0; c < rowCols(r); c++) {
        const col = row[c];
        if (col < 0) continue;
        let x = cellX(r, c), y = yBase + r * RH;
        if (this.settle && this.settle.r === r && this.settle.c === c) {
          const e = ease.outCubic(Math.min(1, this.settle.t));
          x = lerp(this.settle.fx, x, e); y = lerp(this.settle.fy + (ceil - gridDrops * RH), y, e);
        }
        x += Math.sin(t * 1.3 + r * 0.7 + c * 1.9) * 0.7; y += Math.cos(t * 1.1 + r * 1.3 + c * 0.6) * 0.7;
        for (let b = 0; b < this.bumps.length; b++) {
          const bp = this.bumps[b];
          const dx = x - bp.x, dy = y - (bp.y + ceil - gridDrops * RH), d = Math.hypot(dx, dy);
          if (d > 1 && d < 130) {
            const amp = 5 * Math.exp(-bp.t * 7) * Math.sin(bp.t * 28) * (1 - d / 130);
            x += dx / d * amp; y += dy / d * amp;
          }
        }
        bub(ctx, col, x, y, 1, 1);
        if (this.drops + r >= 11) {
          ctx.fillStyle = `rgba(255,90,70,${0.12 + 0.1 * Math.sin(t * 7 + c)})`;
          ctx.beginPath(); ctx.arc(x, y, R, 0, TAU); ctx.fill();
        }
      }
    }
    // popping bubbles (swell just before bursting)
    for (const p of this.pops) {
      const k = clamp(1 - (p.delay - p.t) / 0.07, 0, 1);
      bub(ctx, p.col, p.x, p.y, 1 + 0.18 * k, 1 - 0.3 * k);
      if (p.dull) { ctx.fillStyle = 'rgba(8,24,36,0.5)'; ctx.beginPath(); ctx.arc(p.x, p.y, R, 0, TAU); ctx.fill(); }
    }
    for (const f of this.falling) {
      const a = f.go ? clamp(1 - (f.age - f.delay) / 1.3, 0, 1) : 1;
      bub(ctx, f.col, f.x, f.y, 1, a);
    }
    for (const b of this.rise) bub(ctx, b.col, b.x, b.y, b.sc, 0.9);

    // flying shot
    if (this.shot) {
      const s = this.shot;
      for (let i = 0; i < this.trail.length; i++) {
        const p = this.trail[i], k = (i + 1) / this.trail.length;
        ctx.fillStyle = `rgba(220,248,255,${0.16 * k})`;
        ctx.beginPath(); ctx.arc(p.x, p.y, R * (0.35 + 0.5 * k), 0, TAU); ctx.fill();
      }
      bub(ctx, s.col, s.x + s.dx * s.budget, s.y + s.dy * s.budget, 1, 1);
    }

    this.drawPlate(ctx, ceil);
    this.drawLauncher(ctx);

    // rings
    for (const r of this.rings) {
      const e = ease.outCubic(r.t);
      ctx.strokeStyle = r.col; ctx.globalAlpha = (1 - r.t) * 0.9; ctx.lineWidth = 3.5 * (1 - r.t) + 0.8;
      ctx.beginPath(); ctx.arc(r.x, r.y, R * (0.8 + 1.5 * e), 0, TAU); ctx.stroke();
    }
    ctx.globalAlpha = 1;
    this.parts.draw(ctx, 1);
    // floats
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    for (const f of this.floats) {
      const k = f.t / 1.2;
      ctx.font = `600 ${f.big ? 24 : 19}px Fredoka, sans-serif`;
      ctx.globalAlpha = k < 0.7 ? 1 : 1 - (k - 0.7) / 0.3;
      const y = f.y - 46 * ease.outCubic(k);
      ctx.lineWidth = 4; ctx.strokeStyle = 'rgba(4,30,46,0.7)'; ctx.strokeText(f.txt, f.x, y);
      ctx.fillStyle = f.big ? '#ffe27a' : '#e9fbff'; ctx.fillText(f.txt, f.x, y);
    }
    ctx.globalAlpha = 1;
  }

  drawPlate(ctx, ceil) {
    const t = this.t;
    let g = ctx.createLinearGradient(0, ceil - 90, 0, ceil);
    g.addColorStop(0, '#0e2f3f'); g.addColorStop(1, '#215a6c');
    ctx.fillStyle = g; ctx.fillRect(-26, ceil - 3000, FW + 52, 3000);
    // rock mottling
    ctx.fillStyle = 'rgba(6,28,40,0.35)';
    for (let i = 0; i < 9; i++) { ctx.beginPath(); ctx.ellipse(30 + i * 68, ceil - 40 - (i % 3) * 18, 26, 9, 0, 0, TAU); ctx.fill(); }
    // brass strip
    g = ctx.createLinearGradient(0, ceil - 9, 0, ceil);
    g.addColorStop(0, '#f2d27c'); g.addColorStop(0.5, '#c8963a'); g.addColorStop(1, '#6e4d14');
    ctx.fillStyle = g; ctx.fillRect(-26, ceil - 9, FW + 52, 9);
    // studs: shots without a pop
    const lit = this.shots, warn = lit >= DROP_EVERY - 1;
    for (let i = 0; i < DROP_EVERY; i++) {
      const x = 300 + (i - (DROP_EVERY - 1) / 2) * 32, y = ceil - 26;
      ctx.fillStyle = '#082030'; ctx.beginPath(); ctx.arc(x, y, 8.5, 0, TAU); ctx.fill();
      ctx.strokeStyle = '#c8963a'; ctx.lineWidth = 2; ctx.stroke();
      if (i < lit) {
        const a = warn ? 0.7 + 0.3 * Math.sin(t * 9) : 1;
        const rg = ctx.createRadialGradient(x, y, 0, x, y, 7);
        rg.addColorStop(0, '#fff6c8'); rg.addColorStop(0.6, '#ffc94a'); rg.addColorStop(1, '#d9791f');
        ctx.globalAlpha = a; ctx.fillStyle = rg; ctx.beginPath(); ctx.arc(x, y, 6.2, 0, TAU); ctx.fill();
        ctx.globalAlpha = a * 0.25; ctx.beginPath(); ctx.arc(x, y, 13, 0, TAU); ctx.fill();
        ctx.globalAlpha = 1;
      }
    }
  }

  drawGuide(ctx) {
    const rec = {};
    trace(this.g, this.drops, this.ang, rec);
    const pts = rec.pts;
    if (!pts || pts.length < 2) return;
    const fade = this.state === 'reload' ? clamp(this.curT * 1.4, 0, 1) : 1;
    const c = COLORS[this.cur];
    let budgetSegs = 2;
    const dist = 16, off = (this.t * 26) % dist;
    let carry = off;
    ctx.fillStyle = c.light;
    let total = 0;
    for (let i = 0; i + 1 < pts.length && budgetSegs > 0; i++, budgetSegs--) {
      const a = pts[i], b = pts[i + 1];
      let len = Math.hypot(b.x - a.x, b.y - a.y);
      if (len < 0.01) continue;
      const ux = (b.x - a.x) / len, uy = (b.y - a.y) / len;
      if (i === 1) len = Math.min(len, 280);
      for (let d = carry; d < len; d += dist) {
        const x = a.x + ux * d, y = a.y + uy * d;
        const k = 1 - clamp((total + d) / 900, 0, 0.8);
        ctx.globalAlpha = fade * 0.75 * k;
        ctx.beginPath(); ctx.arc(x, y, 2.8, 0, TAU); ctx.fill();
        carry = d + dist - len;
      }
      if (carry < 0) carry = 0;
      total += len;
    }
    ctx.globalAlpha = 1;
  }

  drawLauncher(ctx) {
    const t = this.t, a = this.ang;
    // shell base
    ctx.save(); ctx.translate(PIV_X, PIV_Y + 52);
    const n = 9, rad = 70;
    let g = ctx.createRadialGradient(0, 4, 4, 0, 4, rad);
    g.addColorStop(0, '#fff0e4'); g.addColorStop(0.7, '#f4b9b0'); g.addColorStop(1, '#d9788a');
    for (let i = 0; i < n; i++) {
      const a0 = Math.PI + i * Math.PI / n, a1 = a0 + Math.PI / n;
      ctx.beginPath(); ctx.moveTo(0, 6); ctx.arc(0, 6, rad - (i % 2) * 3, a0, a1); ctx.closePath();
      ctx.fillStyle = g; ctx.fill();
      ctx.fillStyle = i % 2 ? 'rgba(255,255,255,0.12)' : 'rgba(120,40,60,0.12)'; ctx.fill();
      ctx.strokeStyle = 'rgba(130,50,70,0.45)'; ctx.lineWidth = 1.2; ctx.stroke();
    }
    g = ctx.createLinearGradient(0, 2, 0, 20);
    g.addColorStop(0, '#f6da8a'); g.addColorStop(0.5, '#c8963a'); g.addColorStop(1, '#6e4d14');
    roundRect(ctx, -76, 2, 152, 16, 8); ctx.fillStyle = g; ctx.fill();
    ctx.restore();
    // pivot cap
    g = ctx.createRadialGradient(PIV_X - 4, PIV_Y + 26, 1, PIV_X, PIV_Y + 32, 18);
    g.addColorStop(0, '#fff2b8'); g.addColorStop(1, '#8a6420');
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(PIV_X, PIV_Y + 32, 18, 0, TAU); ctx.fill();
    // barrel
    const rc = this.recoil * 9;
    ctx.save(); ctx.translate(PIV_X, PIV_Y); ctx.rotate(a); ctx.translate(0, rc);
    g = ctx.createLinearGradient(-22, 0, 22, 0);
    g.addColorStop(0, '#7c5a1c'); g.addColorStop(0.3, '#f3d98a'); g.addColorStop(0.6, '#c8963a'); g.addColorStop(1, '#6b4a14');
    roundRect(ctx, -22, -4, 44, 32, 8); ctx.fillStyle = g; ctx.fill();
    ctx.fillStyle = 'rgba(70,45,10,0.5)'; ctx.fillRect(-22, 14, 44, 3);
    ctx.restore();
    // loaded bubble
    if (this.cur >= 0) {
      const e = ease.outCubic(this.curT);
      const px = lerp(NEXT_X, PIV_X, e), py = lerp(NEXT_Y, PIV_Y, e) - Math.sin(e * Math.PI) * 40;
      const bx = this.curT >= 1 ? PIV_X : px, by = this.curT >= 1 ? PIV_Y : py;
      const sc = lerp(0.82, 1, e) * (this.curT >= 1 ? 1 + 0.015 * Math.sin(t * 3) : 1);
      bub(ctx, this.cur, bx, by, sc, 1);
    }
    // cradle
    ctx.save(); ctx.translate(PIV_X, PIV_Y); ctx.rotate(a); ctx.translate(0, rc);
    g = ctx.createLinearGradient(-26, 0, 26, 0);
    g.addColorStop(0, '#7c5a1c'); g.addColorStop(0.3, '#f6df94'); g.addColorStop(0.7, '#c8963a'); g.addColorStop(1, '#6b4a14');
    ctx.fillStyle = g;
    roundRect(ctx, -26, -40, 8, 46, 4); ctx.fill();
    roundRect(ctx, 18, -40, 8, 46, 4); ctx.fill();
    roundRect(ctx, -27, -48, 54, 12, 6); ctx.fill();
    ctx.fillStyle = 'rgba(255,250,220,0.45)'; ctx.fillRect(-24, -46, 48, 2);
    ctx.restore();
    // next preview
    ctx.strokeStyle = '#c8963a'; ctx.lineWidth = 3;
    ctx.fillStyle = 'rgba(2,24,38,0.55)';
    ctx.beginPath(); ctx.arc(NEXT_X, NEXT_Y, 27, 0, TAU); ctx.fill(); ctx.stroke();
    ctx.strokeStyle = 'rgba(255,240,180,0.35)'; ctx.lineWidth = 1; ctx.beginPath(); ctx.arc(NEXT_X, NEXT_Y, 30.5, 0, TAU); ctx.stroke();
    if (this.next >= 0 && !this.over) bub(ctx, this.next, NEXT_X, NEXT_Y, 0.82 * ease.outBack(clamp(this.nextT * 1.2, 0, 1)), 1);
    ctx.font = '600 12px Fredoka, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillStyle = 'rgba(220,245,255,0.7)'; ctx.fillText('NEXT', NEXT_X, NEXT_Y - 42);
    // tide gauge: 12 pearls fill per shot; when full the ceiling sinks one extra row
    const tc = this.tideCount();
    ctx.fillText('TIDE', 480, 560);
    for (let i = 0; i < TIDE_EVERY; i++) {
      const x = 410 + (i % 6) * 24, y = 578 + Math.floor(i / 6) * 24;
      ctx.fillStyle = 'rgba(2,24,38,0.6)'; ctx.beginPath(); ctx.arc(x, y, 9, 0, TAU); ctx.fill();
      ctx.strokeStyle = '#c8963a'; ctx.lineWidth = 1.5; ctx.stroke();
      if (i < tc) {
        const pg = ctx.createRadialGradient(x - 2, y - 2, 0.5, x, y, 7);
        pg.addColorStop(0, '#ffffff'); pg.addColorStop(0.6, '#e6dcf5'); pg.addColorStop(1, '#a89cc8');
        ctx.fillStyle = pg; ctx.beginPath(); ctx.arc(x, y, 6.5, 0, TAU); ctx.fill();
      }
    }
  }
}

Arcade.register({
  id: 'bubbles', name: 'Bubble Reef', genre: 'Bubble shooter',
  aiNote: "Sees every bubble plus the loaded and next one, steers a barrel limited to 200 degrees a second, and thinks for about a quarter second per shot.",
  blurb: 'Aim, bounce and pop colour clusters before the ceiling closes in.',
  bg: '#06283d', accent: '#4fd8d0',
  create() { return new Reef(); },
});
})();
