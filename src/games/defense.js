(() => {
'use strict';
// ---------------------------------------------------------------------------
// Bastion Grove — low-poly island tower defense. A freshly generated winding road every game, 20 waves.
// World units: one tile = 64. Board 16x10 tiles. Everything is drawn in world space under a
// single fit-to-screen transform; the static scenery is cached in an offscreen layer.
// ---------------------------------------------------------------------------
const T = 64, COLS = 16, ROWS = 10, BW = COLS * T, BH = ROWS * T;
const M = 34;            // island margin around the board
const STRIP = 58;        // HUD strip above the island
const MAX_WAVE = 20, START_GOLD = 170, START_LIVES = 20, TIME_CAP = 360;
const AI_INTERVAL = 0.6;

const al = () => { const a = Arcade.alpha; return a === undefined ? 1 : a < 0 ? 0 : a > 1 ? 1 : a; };
const wrapA = a => { while (a > Math.PI) a -= TAU; while (a < -Math.PI) a += TAU; return a; };
function mkRng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const fmt = n => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');

// ---------------- offscreen static layer helper ----------------
const _layers = {};
function staticLayer(ctx, key, W, H, paint) {
  const sc = Math.min(2, (ctx.getTransform ? ctx.getTransform().a : 1) || 1);
  let l = _layers[key];
  if (!l || l.W !== W || l.H !== H || l.sc !== sc || l.dirty) {
    const c = document.createElement('canvas'); c.width = Math.max(1, Math.ceil(W * sc)); c.height = Math.max(1, Math.ceil(H * sc));
    l = _layers[key] = { c, W, H, sc, dirty: false };
    const x = c.getContext('2d'); x.setTransform(sc, 0, 0, sc, 0, 0); paint(x, W, H);
  }
  ctx.drawImage(l.c, 0, 0, W, H);
}

// ---------------- map (generated per game) ----------------
// Every game builds a fresh road: a random self-avoiding walk over the 16x10 tile board from one side
// to the other (min. straight run between corners, no two road tiles touching, enough length/corners,
// no huge empty meadows), randomly mirrored left/right. Smooth Bezier corners are cut afterwards.
const PS = 2;
let PX, PY, PA, PN, PLEN;
let MAP_SEED = 0;
const ENTRY = { x: 0, y: 0, side: 1 }, EXIT = { x: 0, y: 0, side: -1 };   // side: +1 = left edge of the board, -1 = right
const GRID = [];        // tile map: 0 grass(buildable), 1 road, 2 decor (blocked)
const TREES = [];       // decor trees {x,y,s,ph}

function genRoadTiles(rng) {
  const DXs = [1, 0, -1, 0], DYs = [0, 1, 0, -1];   // E S W N
  for (let attempt = 0; attempt < 600; attempt++) {
    const r0 = (rng() * ROWS) | 0, vis = new Map(), path = [[0, r0]];
    vis.set(r0, 0);
    const minL = 44 + ((rng() * 5) | 0), maxL = 58, minTurns = 8;
    let budget = 6000, result = null;
    const dfs = (c, r, dir, run, turns) => {
      if (result || --budget < 0) return;
      const L = path.length;
      if (c === COLS - 1 && dir === 0 && L >= minL && turns >= minTurns) { result = path.map(p => p.slice()); return; }
      if (L >= maxL) return;
      const opts = [];
      if (run < 6) opts.push([dir, 0]);
      if (run >= 3) { opts.push([(dir + 1) & 3, 1]); opts.push([(dir + 3) & 3, 1]); }
      for (let i = opts.length - 1; i > 0; i--) { const j = (rng() * (i + 1)) | 0; const t = opts[i]; opts[i] = opts[j]; opts[j] = t; }
      if (run >= 4) opts.sort((p, q) => q[1] - p[1]);
      for (const [nd, isT] of opts) {
        const nc = c + DXs[nd], nr = r + DYs[nd];
        if (nc < 0 || nc >= COLS || nr < 0 || nr >= ROWS || vis.has(nc * 100 + nr)) continue;
        let bad = false;
        for (let dx = -1; dx <= 1 && !bad; dx++) for (let dy = -1; dy <= 1; dy++) {
          if (!dx && !dy) continue;
          const k = vis.get((nc + dx) * 100 + (nr + dy));
          if (k !== undefined && k < L - 2) { bad = true; break; }     // never touches itself (even diagonally)
        }
        if (bad) continue;
        vis.set(nc * 100 + nr, L); path.push([nc, nr]);
        dfs(nc, nr, nd, isT ? 1 : run + 1, turns + isT);
        if (result) return;
        path.pop(); vis.delete(nc * 100 + nr);
      }
    };
    dfs(0, r0, 0, 1, 0);
    if (!result) continue;
    // the island must be used well: little empty meadow far from the road, enough buildable grass beside it
    const road = new Set(result.map(p => p[0] * 100 + p[1]));
    let far = 0, near1 = 0;
    for (let c = 0; c < COLS; c++) for (let r = 0; r < ROWS; r++) {
      if (road.has(c * 100 + r)) continue;
      let d = 9;
      for (let dc = -3; dc <= 3; dc++) for (let dr = -3; dr <= 3; dr++) if (road.has((c + dc) * 100 + (r + dr))) d = Math.min(d, Math.max(Math.abs(dc), Math.abs(dr)));
      if (d >= 3) far++; if (d === 1) near1++;
    }
    if (far <= 20 && near1 >= 36) return result;
  }
  return null;
}

function buildMap(seed) {
  MAP_SEED = seed;
  const rng = mkRng(seed);
  let tiles = genRoadTiles(rng);
  if (!tiles) tiles = [[0, 1], [1, 1], [2, 1], [3, 1], [3, 2], [3, 3], [3, 4], [4, 4], [5, 4], [6, 4], [7, 4], [7, 3], [7, 2], [7, 1], [8, 1], [9, 1], [10, 1], [11, 1], [11, 2], [11, 3], [11, 4], [11, 5], [11, 6], [10, 6], [9, 6], [8, 6], [7, 6], [6, 6], [5, 6], [5, 7], [5, 8], [6, 8], [7, 8], [8, 8], [9, 8], [10, 8], [11, 8], [12, 8], [13, 8], [14, 8], [14, 7], [14, 6], [14, 5], [14, 4], [14, 3], [15, 3]];
  const flip = rng() < 0.5;                       // mirror left/right: the enemies may come from either side
  const fx = x => flip ? BW - x : x;
  const first = tiles[0], last = tiles[tiles.length - 1];
  ENTRY.side = flip ? -1 : 1; ENTRY.x = flip ? BW + M - 18 : -M + 18; ENTRY.y = (first[1] + 0.5) * T;
  EXIT.side = flip ? 1 : -1; EXIT.x = flip ? -M + 22 : BW + M - 22; EXIT.y = (last[1] + 0.5) * T;
  // waypoints = corner tile centres (+ off-board end points)
  const WP = [[fx(-M + 8), (first[1] + 0.5) * T]];
  for (let i = 1; i < tiles.length - 1; i++) {
    const a = tiles[i - 1], b = tiles[i], c = tiles[i + 1];
    if ((b[0] - a[0]) !== (c[0] - b[0]) || (b[1] - a[1]) !== (c[1] - b[1])) WP.push([fx((b[0] + 0.5) * T), (b[1] + 0.5) * T]);
  }
  WP.push([flip ? -M + 10 : BW + M - 10, (last[1] + 0.5) * T]);
  const pts = [WP[0].slice()], R = 48, n = WP.length;
  for (let i = 1; i < n - 1; i++) {
    const P = WP[i], A = WP[i - 1], B = WP[i + 1];
    let ax = A[0] - P[0], ay = A[1] - P[1], al_ = Math.hypot(ax, ay); ax /= al_; ay /= al_;
    let bx = B[0] - P[0], by = B[1] - P[1], bl = Math.hypot(bx, by); bx /= bl; by /= bl;
    const p1 = [P[0] + ax * R, P[1] + ay * R], p2 = [P[0] + bx * R, P[1] + by * R];
    pts.push(p1);
    for (let k = 1; k <= 14; k++) { const u = k / 14, v = 1 - u; pts.push([v * v * p1[0] + 2 * u * v * P[0] + u * u * p2[0], v * v * p1[1] + 2 * u * v * P[1] + u * u * p2[1]]); }
  }
  pts.push(WP[n - 1].slice());
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  PLEN = cum[cum.length - 1]; PN = Math.floor(PLEN / PS) + 1;
  PX = new Float32Array(PN + 2); PY = new Float32Array(PN + 2); PA = new Float32Array(PN + 2);
  let j = 0;
  for (let i = 0; i < PN + 2; i++) {
    const d = Math.min(i * PS, PLEN);
    while (j < pts.length - 2 && cum[j + 1] < d) j++;
    const u = (d - cum[j]) / Math.max(1e-6, cum[j + 1] - cum[j]);
    PX[i] = pts[j][0] + (pts[j + 1][0] - pts[j][0]) * u; PY[i] = pts[j][1] + (pts[j + 1][1] - pts[j][1]) * u;
  }
  for (let i = 0; i < PN + 2; i++) {
    const a = Math.max(0, i - 3), b = Math.min(PN + 1, i + 3);
    PA[i] = Math.atan2(PY[b] - PY[a], PX[b] - PX[a]);
  }
  // tile map + decor
  GRID.length = 0; TREES.length = 0;
  for (let c = 0; c < COLS; c++) GRID.push(new Array(ROWS).fill(0));
  for (let d = 0; d < PLEN; d += 6) {
    const f = Math.min(PN - 1, (d / PS) | 0), c = Math.floor(PX[f] / T), r = Math.floor(PY[f] / T);
    if (c >= 0 && c < COLS && r >= 0 && r < ROWS) GRID[c][r] = 1;
  }
  for (let c = 0; c < COLS; c++) for (let r = 0; r < ROWS; r++) {
    if (GRID[c][r]) continue;
    let near = 99;
    for (let dc = -2; dc <= 2; dc++) for (let dr = -2; dr <= 2; dr++) {
      const cc = c + dc, rr = r + dr;
      if (cc >= 0 && cc < COLS && rr >= 0 && rr < ROWS && GRID[cc][rr] === 1) near = Math.min(near, Math.max(Math.abs(dc), Math.abs(dr)));
    }
    const corner = (c <= 1 && r >= 8) || (c === 0 && r === 7);   // bottom-left stays clear for the shell HUD
    if (corner || (near >= 2 && rng() < 0.4)) {
      GRID[c][r] = 2;
      TREES.push({ x: (c + 0.5) * T + (rng() - 0.5) * 14, y: (r + 0.5) * T + (rng() - 0.5) * 10, s: 0.95 + rng() * 0.25, ph: rng() * 6, rock: rng() < (corner ? 0.4 : 0.15) });
    }
  }
  // small margin trees around the island rim
  for (let i = 0; i < 22; i++) {
    const side = i % 4, u = rng();
    let x, y;
    if (side === 0) { x = u * BW; y = -M + 15; } else if (side === 1) { x = u * BW; y = BH + M - 15; }
    else if (side === 2) { x = -M + 14; y = u * BH; } else { x = BW + M - 14; y = u * BH; }
    if (Math.abs(y - ENTRY.y) < 40 && (ENTRY.side > 0 ? x < 20 : x > BW - 20)) continue;   // keep clear of the gates
    if (Math.abs(y - EXIT.y) < 40 && (EXIT.side > 0 ? x < 20 : x > BW - 20)) continue;
    TREES.push({ x, y, s: 0.5 + rng() * 0.18, ph: rng() * 6, margin: true });
  }
  TREES.sort((p, q) => p.y - q.y);
}
function pathAt(d, lat, out) {
  let f = d / PS; if (f < 0) f = 0; if (f > PN - 1.001) f = PN - 1.001;
  const i = f | 0, u = f - i;
  const x = PX[i] + (PX[i + 1] - PX[i]) * u, y = PY[i] + (PY[i + 1] - PY[i]) * u, a = PA[i];
  out.x = x - Math.sin(a) * lat; out.y = y + Math.cos(a) * lat; out.a = a; return out;
}
buildMap(1);
function newMap() {
  buildMap((Math.random() * 1e9) >>> 0);
  _layers.defense_bg = null;   // the cached scenery belongs to the old road
}

// ---------------- data tables ----------------
const TW = {
  arrow: { name: 'Arrow', cost: 50, col: '#d2a95c', lv: [
    { d: 8, cd: 0.42, r: 150, up: 0 }, { d: 14, cd: 0.36, r: 162, up: 45 }, { d: 24, cd: 0.30, r: 176, up: 85 }] },
  cannon: { name: 'Cannon', cost: 95, col: '#dd7d3d', lv: [
    { d: 26, cd: 1.5, r: 165, sp: 52, up: 0 }, { d: 42, cd: 1.35, r: 178, sp: 60, up: 80 }, { d: 66, cd: 1.2, r: 192, sp: 70, up: 130 }] },
  frost: { name: 'Frost', cost: 70, col: '#86d6f2', lv: [
    { d: 3, cd: 1.1, r: 135, slow: 0.45, dur: 1.5, up: 0 }, { d: 6, cd: 1.0, r: 150, slow: 0.55, dur: 1.7, up: 60 }, { d: 10, cd: 0.9, r: 165, slow: 0.65, dur: 1.9, up: 100 }] },
  lightning: { name: 'Lightning', cost: 130, col: '#f3d54e', lv: [
    { d: 20, cd: 1.05, r: 150, ch: 3, up: 0 }, { d: 32, cd: 0.95, r: 162, ch: 4, up: 100 }, { d: 50, cd: 0.8, r: 176, ch: 5, up: 150 }] },
};
const TYPES = ['arrow', 'cannon', 'frost', 'lightning'];
const EK = {
  scout:   { hp: 30,  sp: 120, ar: 0, gold: 5,  life: 1, r: 9,  sp_gap: 0.36 },
  swarm:   { hp: 15,  sp: 92,  ar: 0, gold: 2,  life: 1, r: 7,  sp_gap: 0.16 },
  armored: { hp: 105, sp: 70,  ar: 5, gold: 9,  life: 1, r: 13, sp_gap: 0.7 },
  giant:   { hp: 620, sp: 54,  ar: 3, gold: 40, life: 5, r: 22, sp_gap: 2.0 },
};
const KINDS = ['scout', 'swarm', 'armored', 'giant'];
//          scout swarm armored giant
const WAVES = [
  [6, 0, 0, 0], [0, 10, 0, 0], [6, 8, 0, 0], [4, 0, 4, 0], [0, 16, 0, 0],
  [8, 0, 6, 0], [0, 10, 0, 1], [6, 20, 0, 0], [0, 0, 10, 0], [10, 0, 4, 1],
  [0, 26, 0, 0], [8, 0, 10, 0], [0, 14, 6, 1], [12, 20, 0, 0], [0, 0, 14, 1],
  [10, 18, 8, 0], [0, 30, 0, 2], [14, 0, 14, 0], [0, 24, 10, 2], [12, 20, 14, 3],
];
const hpMul = w => 1 + 0.30 * (w - 1) + 0.0152 * (w - 1) * (w - 1);
function waveText(w) {
  const arr = [];
  KINDS.forEach((k, i) => { if (WAVES[w - 1][i] > 0) arr.push([k, WAVES[w - 1][i]]); });
  arr.sort((a, b) => b[1] - a[1]);
  return arr.slice(0, 3).map(a => a[1] + ' ' + a[0]).join(' \u00b7 ');
}
function effDmg(d, ar) { return Math.max(d * 0.3, d - ar); }

// ---------------- the AI ----------------
// DefenseAI sees what a player sees: the map (which tiles are free grass), the road, every tower (type,
// level, tile), every enemy on screen (kind, hp, max hp), gold, lives, and the "Next:" wave preview.
// It never reads the RNG or hidden state. Its single output is ONE build or upgrade order per 0.6 s,
// which the game executes exactly like a player click. Placement is scored by path coverage
// (weighted toward corners and the early road), the tower type needed for the visible/upcoming mix
// (cannon vs swarms, lightning vs armor, frost to multiply everything else), and upgrade-vs-build value per gold.
const STYLES = {
  'Frost & cannon':      { mul: { arrow: 1.05, cannon: 1.15, frost: 1.0, lightning: 1.0 }, frostCap: 0.35, up: 1.25, choke: 0 },
  'Lightning network':   { mul: { arrow: 1.05, cannon: 1.0, frost: 1.0, lightning: 1.1 }, frostCap: 0.3, up: 1.1, choke: 0 },
  'Arrow spam':          { mul: { arrow: 1.2, cannon: 0.9, frost: 0.95, lightning: 0.85 }, frostCap: 0.2, up: 1.15, choke: 0 },
  'Balanced mix':        { mul: { arrow: 1.0, cannon: 1.0, frost: 1.0, lightning: 1.0 }, frostCap: 0.3, up: 1.0, choke: 0 },
  'Chokepoint fortress': { mul: { arrow: 1.0, cannon: 1.1, frost: 1.1, lightning: 1.0 }, frostCap: 0.3, up: 1.35, choke: 1 },
};
const DefenseAI = {
  style: '', ST: STYLES['Frost & cannon'], hot: null,
  // new game: pick a tactic at random (a weighting of tower types, upgrade appetite and, for the fortress,
  // a chokepoint: the road stretch that the most road is within range of)
  reset() {
    const names = Object.keys(STYLES);
    this.style = names[(Math.random() * names.length) | 0]; this.ST = STYLES[this.style];
    let best = [];
    for (const tile of this.tiles) {
      let w = 0; for (const i of this.cover(tile, 165)) w += this.samples[i].w;
      best.push({ tile, w });
    }
    best.sort((a, b) => b.w - a.w);
    this.hot = best.length ? best[(Math.random() * Math.min(4, best.length)) | 0].tile : null;
    return this.style;
  },
  init() {
    this.samples = [];
    for (let d = 0; d < PLEN; d += 16) {
      const f = Math.min(PN - 1, (d / PS) | 0);
      const a0 = PA[Math.max(0, f - 20)], a1 = PA[Math.min(PN - 1, f + 20)];
      const corner = Math.abs(wrapA(a1 - a0)) > 0.5;
      this.samples.push({ x: PX[f], y: PY[f], w: 1 + 0.4 * (1 - d / PLEN) + (corner ? 0.4 : 0) + (PX[f] < 0 || PX[f] > BW ? -0.7 : 0) });
    }
    this.cache = new Map();
    this.tiles = [];
    for (let c = 0; c < COLS; c++) for (let r = 0; r < ROWS; r++) if (GRID[c][r] === 0) this.tiles.push({ c, r, x: (c + 0.5) * T, y: (r + 0.5) * T });
  },
  near(tile) {   // fortress style: prefer tiles around the chokepoint
    if (!this.ST.choke || !this.hot) return 1;
    const d = Math.hypot(tile.x - this.hot.x, tile.y - this.hot.y);
    return d < 150 ? 1.6 : d < 260 ? 1.25 : 0.85;
  },
  cover(tile, R) {
    const key = tile.c * 100000 + tile.r * 1000 + R;
    let v = this.cache.get(key);
    if (!v) {
      v = []; const R2 = R * R;
      this.samples.forEach((s, i) => { const dx = s.x - tile.x, dy = s.y - tile.y; if (dx * dx + dy * dy <= R2) v.push(i); });
      this.cache.set(key, v);
    }
    return v;
  },
  profile(obs) {
    const p = { scout: 0.05, swarm: 0.05, armored: 0.05, giant: 0.05 };
    const nw = Math.min(MAX_WAVE, obs.wave + 1), mul = hpMul(nw);
    if (obs.wave < MAX_WAVE) KINDS.forEach((k, i) => { p[k] += WAVES[nw - 1][i] * EK[k].hp * mul / 400; });
    for (const e of obs.enemies) p[e.k] += e.hp / 400;
    let s = 0; for (const k of KINDS) s += p[k];
    for (const k of KINDS) p[k] /= s;
    return p;
  },
  dps(type, lv, p) {
    const L = TW[type].lv[lv]; let sum = 0;
    const splash = { scout: 1.4, swarm: 3.2, armored: 1.5, giant: 1.1 };
    const spread = { scout: 0.6, swarm: 0.9, armored: 0.5, giant: 0.15 };
    for (const k of KINDS) {
      let v = effDmg(L.d, EK[k].ar * (type === 'lightning' ? 0.4 : 1)) / L.cd;
      if (type === 'cannon') v *= splash[k];
      else if (type === 'lightning') v *= 1 + (L.ch - 1) * 0.7 * spread[k];
      sum += p[k] * v;
    }
    return sum;
  },
  // returns {act:'build',type,c,r} | {act:'upgrade',id} | null
  think(obs) {
    if (obs.gold < 45) return null;
    const p = this.profile(obs);
    const S = this.samples, E = new Float32Array(S.length), SL = new Uint8Array(S.length);
    const towerPos = obs.towers;
    for (const t of towerPos) {
      const L = TW[t.type].lv[t.lv], cov = this.cover({ c: t.c, r: t.r, x: (t.c + 0.5) * T, y: (t.r + 0.5) * T }, L.r);
      if (t.type === 'frost') for (const i of cov) SL[i] = 1;
      else { const dd = this.dps(t.type, t.lv, p); for (const i of cov) E[i] += dd; }
    }
    const swarmy = 1 + 0.6 * p.swarm + 0.3 * p.scout;
    const frostVal = (tile, lv) => {
      const L = TW.frost.lv[lv], cov = this.cover(tile, L.r), g = L.slow / (1 - L.slow);
      let v = 0;
      for (const i of cov) v += S[i].w * (E[i] * g * (SL[i] ? 0.06 : 1) * 0.9 * swarmy + this.dps('frost', lv, p));
      return v;
    };
    const val = (type, tile, lv) => {
      if (type === 'frost') return frostVal(tile, lv);
      const L = TW[type].lv[lv], cov = this.cover(tile, L.r), dd = this.dps(type, lv, p);
      let w = 0; for (const i of cov) w += S[i].w;
      return dd * w;
    };
    const occ = new Set(towerPos.map(t => t.c * 100 + t.r));
    const cand = [];
    const cnt = { arrow: 0, cannon: 0, frost: 0, lightning: 0 };
    for (const t of towerPos) cnt[t.type]++;
    const others = towerPos.length - cnt.frost;
    for (const tile of this.tiles) {
      if (occ.has(tile.c * 100 + tile.r)) continue;
      for (const ty of TYPES) {
        const cost = TW[ty].cost;
        if (cost > obs.gold + 80) continue;
        if (ty === 'frost' && cnt.frost >= 1 + this.ST.frostCap * others) continue;   // slows don't stack: keep frost a minority
        cand.push({ act: 'build', type: ty, c: tile.c, r: tile.r, cost, ratio: val(ty, tile, 0) / cost / (1 + 0.15 * cnt[ty]) * this.ST.mul[ty] * this.near(tile) * rnd.float(0.9, 1.1) });
      }
    }
    for (const t of towerPos) {
      if (t.lv >= 2) continue;
      const tile = { c: t.c, r: t.r, x: (t.c + 0.5) * T, y: (t.r + 0.5) * T }, cost = TW[t.type].lv[t.lv + 1].up;
      cand.push({ act: 'upgrade', id: t.id, cost, ratio: (val(t.type, tile, t.lv + 1) - val(t.type, tile, t.lv)) / cost / (1 + 0.3 * (t.lv + 1)) * this.ST.up * this.ST.mul[t.type] * rnd.float(0.95, 1.05) });
    }
    if (!cand.length) return null;
    let best = null;
    for (const c of cand) if (!best || c.ratio > best.ratio) best = c;
    if (best.cost <= obs.gold) return best;
    // saving for the best option: only settle for a cheaper one that is nearly as good per gold
    let alt = null;
    for (const c of cand) if (c.cost <= obs.gold && c.ratio >= best.ratio * 0.85 && (!alt || c.ratio > alt.ratio)) alt = c;
    return alt;
  },
};
DefenseAI.init(); DefenseAI.reset();

// ---------------- drawing helpers ----------------
function poly(ctx, pts) { ctx.beginPath(); ctx.moveTo(pts[0], pts[1]); for (let i = 2; i < pts.length; i += 2) ctx.lineTo(pts[i], pts[i + 1]); ctx.closePath(); }
function coinIcon(ctx, x, y, r) {
  ctx.fillStyle = '#c28a1f'; ctx.beginPath(); ctx.arc(x, y, r, 0, TAU); ctx.fill();
  ctx.fillStyle = '#f4cf5c'; ctx.beginPath(); ctx.arc(x, y - r * 0.08, r * 0.82, 0, TAU); ctx.fill();
  ctx.strokeStyle = '#c28a1f'; ctx.lineWidth = r * 0.18; ctx.beginPath(); ctx.arc(x, y - r * 0.08, r * 0.5, 0, TAU); ctx.stroke();
}
function heartIcon(ctx, x, y, s, col) {
  ctx.fillStyle = col; ctx.beginPath();
  ctx.moveTo(x, y + s * 0.9);
  ctx.bezierCurveTo(x - s * 1.5, y - s * 0.1, x - s * 0.9, y - s * 1.2, x, y - s * 0.4);
  ctx.bezierCurveTo(x + s * 0.9, y - s * 1.2, x + s * 1.5, y - s * 0.1, x, y + s * 0.9);
  ctx.fill();
}

function drawTree(ctx, tr, t) {
  const s = tr.s, x = tr.x, y = tr.y, sw = Math.sin(t * 1.25 + tr.ph);
  if (tr.rock) {
    ctx.fillStyle = 'rgba(15,30,20,0.28)'; ctx.beginPath(); ctx.ellipse(x + 5, y + 7, 22, 10, 0, 0, TAU); ctx.fill();
    ctx.fillStyle = '#7a8594'; poly(ctx, [x - 22, y + 8, x - 14, y - 12, x + 4, y - 18, x + 20, y - 4, x + 22, y + 8]); ctx.fill();
    ctx.fillStyle = '#9aa5b3'; poly(ctx, [x - 14, y - 12, x + 4, y - 18, x + 2, y + 2, x - 10, y + 6]); ctx.fill();
    ctx.fillStyle = '#6a7585'; poly(ctx, [x + 4, y - 18, x + 20, y - 4, x + 22, y + 8, x + 2, y + 2]); ctx.fill();
    return;
  }
  ctx.fillStyle = 'rgba(15,30,20,0.26)'; ctx.beginPath(); ctx.ellipse(x + 9 * s, y + 8 * s, 19 * s, 8 * s, 0, 0, TAU); ctx.fill();
  ctx.fillStyle = '#6b4a2f'; ctx.fillRect(x - 3 * s, y - 4 * s, 6 * s, 12 * s);
  const layers = [[0, 26, 21], [-12, 21, 17], [-23, 15, 13]];
  for (let i = 0; i < 3; i++) {
    const [oy, w, h] = layers[i], sx = sw * (1.2 + i * 1.1) * s, by = y + oy * s - 4 * s;
    const tx = x + sx, ty = by - h * s * 1.5;
    ctx.fillStyle = i % 2 ? '#5f9d4e' : '#58944a';
    poly(ctx, [x - w * s + sx * 0.3, by, tx, ty, x + sx * 0.0, by]); ctx.fill();
    ctx.fillStyle = i % 2 ? '#467f3d' : '#3f7638';
    poly(ctx, [x + w * s + sx * 0.3, by, tx, ty, x, by]); ctx.fill();
  }
}

// ---------------- game ----------------
class Game {
  constructor() {
    newMap(); DefenseAI.init(); this.style = DefenseAI.reset();   // fresh road + a random tactic every game
    this.over = false; this.won = false;
    this.W = 800; this.H = 600; this.s = 1; this.ox = 0; this.oy = 0;
    this.t = 0; this.endT = 0;
    this.gold = START_GOLD; this.goldShown = START_GOLD; this.lives = START_LIVES; this.livesBump = 0; this.goldBump = 0;
    this.score = 0; this.kills = 0;
    this.wave = 0; this.waveTimer = 5; this.waveInterval = 5; this.queue = []; this.spawnClock = 0;
    this.enemies = []; this.towers = []; this.bolts = []; this.shells = []; this.fx = []; this.parts = []; this.floats = [];
    this.nextId = 1; this.aiCd = 1.0; this.shakeT = 0; this.shx = 0; this.shy = 0; this.flash = 0; this.heartPulse = 0;
    this.tmp = { x: 0, y: 0, a: 0 };
    this.cause = '';
    this.glints = []; this.petals = [];
    const pr = mkRng(12);
    for (let i = 0; i < 16; i++) this.petals.push({ u: pr(), v: pr(), sp: 8 + pr() * 10, ph: pr() * 6, c: pr() < 0.5 ? '#f3c9d0' : '#f6efd9' });
  }

  resize(W, H) {
    this.W = W; this.H = H;
    const bw = BW + 2 * M, bh = BH + 2 * M + STRIP;
    this.s = Math.max(0.2, Math.min(W * 0.88 / bw, H * 0.88 / bh));
    this.ox = (W - bw * this.s) / 2 + M * this.s;
    this.oy = (H - bh * this.s) / 2 + (M + STRIP) * this.s;
    this.glints = [];
    const gr = mkRng(31), n = Math.round(W * H / 14000);
    for (let i = 0; i < n; i++) {
      const x = gr() * W, y = gr() * H, wx = (x - this.ox) / this.s, wy = (y - this.oy) / this.s;
      const ph = gr() * 6, len = 8 + gr() * 16;
      if (wx > -M - 8 && wx < BW + M + 8 && wy > -M - 8 && wy < BH + M + 8) continue;
      this.glints.push({ x, y, ph, len });
    }
  }

  // ----- world helpers -----
  tileFree(c, r) {
    if (c < 0 || r < 0 || c >= COLS || r >= ROWS || GRID[c][r] !== 0) return false;
    return !this.towers.some(t => t.c === c && t.r === r);
  }
  puff(x, y, n, col, sp, size, life) {
    for (let i = 0; i < n; i++) {
      const a = rnd.float(0, TAU), v = rnd.float(0.3, 1) * sp;
      this.parts.push({ k: 'puff', x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v - sp * 0.15, life: 0, max: rnd.float(0.6, 1) * life, size: size * rnd.float(0.7, 1.2), col, g: 0, drag: 3.2 });
    }
  }
  spark(x, y, n, cols, sp, size, life, g) {
    for (let i = 0; i < n; i++) {
      const a = rnd.float(0, TAU), v = rnd.float(0.25, 1) * sp;
      this.parts.push({ k: 'spark', x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, life: 0, max: rnd.float(0.5, 1) * life, size: size * rnd.float(0.6, 1.1), col: Array.isArray(cols) ? rnd.pick(cols) : cols, g: g || 0, drag: 2.2 });
    }
  }
  confetti(x, y, n, cols, sp, life) {
    for (let i = 0; i < n; i++) {
      const a = rnd.float(0, TAU), v = rnd.float(0.3, 1) * sp;
      this.parts.push({ k: 'conf', x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v - sp * 0.5, life: 0, max: rnd.float(0.6, 1) * life, size: rnd.float(2.5, 4.5), col: rnd.pick(cols), g: 260, drag: 1.6, rot: rnd.float(0, TAU), vr: rnd.float(-9, 9) });
    }
  }

  startWave() {
    this.wave++;
    const w = this.wave, cnt = WAVES[w - 1];
    let off = 0, gi = 0; const q = [];
    ['swarm', 'scout', 'armored', 'giant'].forEach(k => {
      const n0 = cnt[KINDS.indexOf(k)], n = k === 'giant' ? n0 : Math.round(n0 * rnd.float(0.92, 1.12));
      for (let i = 0; i < n; i++) q.push({ t: gi * 1.4 + i * EK[k].sp_gap, k });
      if (n) { off = Math.max(off, gi * 1.4 + n * EK[k].sp_gap); gi++; }
    });
    q.sort((a, b) => a.t - b.t);
    this.queue = q; this.spawnClock = 0;
    this.waveInterval = this.waveTimer = Math.max(6.2, off + 1.2);
    this.gold += 10 + w * 2; this.goldBump = 1;
  }

  spawnEnemy(k) {
    const K = EK[k], mul = hpMul(this.wave);
    const lat = (Math.random() - 0.5) * 2 * (k === 'giant' ? 0 : 11);
    const hp = Math.round(K.hp * mul);
    const e = { id: this.nextId++, k, hp, mhp: hp, ar: K.ar, sp: K.sp * (0.95 + Math.random() * 0.1), d: 0, lat, x: 0, y: 0, px: 0, py: 0, a: 0, pa: 0, slowT: 0, slowF: 0, flash: 0, ph: Math.random() * 6, key: Math.random() * 6, dead: false, born: 0, gait: 0 };
    pathAt(0, lat, this.tmp); e.x = e.px = this.tmp.x; e.y = e.py = this.tmp.y; e.a = e.pa = this.tmp.a;
    this.enemies.push(e);
  }

  damage(e, dmg, pierce) {
    if (e.dead) return;
    e.hp -= effDmg(dmg, pierce ? e.ar * 0.4 : e.ar);   // lightning ignores most armor e.flash = 0.12;
    if (e.hp <= 0) this.kill(e);
  }
  kill(e) {
    e.dead = true; this.kills++;
    const g = Math.round(EK[e.k].gold * (1 + 0.04 * (this.wave - 1)));
    this.gold += g; this.score += g * 10; this.goldBump = 1;
    const r = EK[e.k].r;
    const col = { scout: '#e8a33d', swarm: '#d96a5b', armored: '#98a5b8', giant: '#a8523f' }[e.k];
    this.puff(e.x, e.y, 5 + (r / 4 | 0), 'rgba(235,228,200,0.8)', 70, r * 0.55, 0.5);
    this.spark(e.x, e.y, 8, [col, '#f3dc8a', '#fff'], 150, 2.6, 0.6, 140);
    this.fx.push({ k: 'ring', x: e.x, y: e.y, r0: r * 0.6, r1: r * 2.4, life: 0, max: 0.35, col: 'rgba(255,240,190,' });
    this.floats.push({ x: e.x, y: e.y - r, text: '+' + g, life: 0, max: 1.0 });
  }

  build(type, c, r) {
    const cost = TW[type].cost;
    if (this.gold < cost || !this.tileFree(c, r)) return false;
    this.gold -= cost;
    const t = { id: this.nextId++, type, lv: 0, c, r, x: (c + 0.5) * T, y: (r + 0.5) * T, cd: 0.4, aim: rnd.float(-3, 3), paim: 0, recoil: 0, precoil: 0, born: 0, ring: 1.6, glow: 0 };
    t.paim = t.aim;
    this.towers.push(t);
    this.puff(t.x, t.y + 14, 9, 'rgba(210,200,170,0.85)', 80, 7, 0.55);
    return true;
  }
  upgrade(t) {
    if (t.lv >= 2) return false;
    const cost = TW[t.type].lv[t.lv + 1].up;
    if (this.gold < cost) return false;
    this.gold -= cost; t.lv++; t.ring = 1.6; t.glow = 1; t.born = 0.1;
    this.fx.push({ k: 'ring', x: t.x, y: t.y, r0: 10, r1: 60, life: 0, max: 0.55, col: 'rgba(255,230,150,' });
    this.spark(t.x, t.y - 6, 14, [TW[t.type].col, '#fff3c4'], 130, 2.6, 0.7, 60);
    return true;
  }

  observe() {
    return {
      gold: this.gold, lives: this.lives, wave: this.wave,
      enemies: this.enemies.map(e => ({ k: e.k, hp: e.hp, mhp: e.mhp })),
      towers: this.towers.map(t => ({ id: t.id, type: t.type, lv: t.lv, c: t.c, r: t.r })),
    };
  }

  // ----- tower logic -----
  firstInRange(t, R) {
    let best = null, bd = -1; const R2 = R * R;
    for (const e of this.enemies) {
      if (e.dead || e.d < 6) continue;
      const dx = e.x - t.x, dy = e.y - t.y;
      if (dx * dx + dy * dy <= R2 && e.d > bd) { bd = e.d; best = e; }
    }
    return best;
  }
  stepTower(t, dt) {
    t.born += dt; t.ring = Math.max(0, t.ring - dt); t.glow = Math.max(0, t.glow - dt * 1.5);
    t.paim = t.aim; t.precoil = t.recoil; t.recoil = Math.max(0, t.recoil - dt * 6);
    t.cd -= dt;
    const L = TW[t.type].lv[t.lv];
    if (t.born < 0.3) return;
    if (t.type === 'frost') {
      if (t.cd <= 0) {
        let any = false; const R2 = L.r * L.r;
        for (const e of this.enemies) { const dx = e.x - t.x, dy = e.y - t.y; if (!e.dead && e.d > 6 && dx * dx + dy * dy <= R2) { any = true; break; } }
        if (any) {
          t.cd = L.cd; t.recoil = 1; t.glow = 1;
          this.fx.push({ k: 'frost', x: t.x, y: t.y, r1: L.r, life: 0, max: 0.6 });
          for (const e of this.enemies) {
            const dx = e.x - t.x, dy = e.y - t.y;
            if (!e.dead && e.d > 6 && dx * dx + dy * dy <= R2) {
              e.slowT = L.dur; e.slowF = Math.max(e.slowF, L.slow); this.damage(e, L.d);
              this.spark(e.x, e.y, 3, ['#bfeaff', '#fff'], 60, 2, 0.5, 0);
            }
          }
        }
      }
      t.aim += dt * 0.6;
      return;
    }
    const tgt = this.firstInRange(t, L.r);
    if (tgt) {
      let ta;
      if (t.type === 'cannon') {
        const fl = Math.hypot(tgt.x - t.x, tgt.y - t.y) / 300, f = pathAt(tgt.d + tgt.sp * (1 - tgt.slowF * (tgt.slowT > 0 ? 1 : 0)) * fl, tgt.lat, this.tmp);
        t.lx = f.x; t.ly = f.y; ta = Math.atan2(f.y - t.y, f.x - t.x);
      } else ta = Math.atan2(tgt.y - t.y, tgt.x - t.x);
      const diff = wrapA(ta - t.aim), tr = 14 * dt;
      t.aim += Math.abs(diff) < tr ? diff : Math.sign(diff) * tr;
      if (t.cd <= 0 && Math.abs(diff) < 0.3) this.fire(t, L, tgt);
    } else t.aim += wrapA((t.type === 'cannon' ? -0.9 : -1.4) - t.aim) * Math.min(1, dt * 1.2) * 0.3;
  }
  fire(t, L, tgt) {
    t.cd = L.cd; t.recoil = 1;
    const mx = t.x + Math.cos(t.aim) * 22, my = t.y - 3 + Math.sin(t.aim) * 22;
    if (t.type === 'arrow') {
      const offs = t.lv === 2 ? [-4.5, 4.5] : [0];
      for (const o of offs) {
        const sx = mx - Math.sin(t.aim) * o, sy = my + Math.cos(t.aim) * o;
        this.bolts.push({ x: sx, y: sy, px: sx, py: sy, tgt, dmg: L.d, a: t.aim, life: 0, lx: tgt.x, ly: tgt.y });
      }
      this.spark(mx, my, 2, ['#fff3c4'], 60, 1.6, 0.25, 0);
    } else if (t.type === 'cannon') {
      const tx = t.lx != null ? t.lx : tgt.x, ty = t.ly != null ? t.ly : tgt.y, dist = Math.hypot(tx - mx, ty - my);
      const Tf = Math.max(0.35, dist / 300);
      this.shells.push({ sx: mx, sy: my, tx, ty, x: mx, y: my, px: mx, py: my, t: 0, pt: 0, Tf, dmg: L.d, sp: L.sp, arc: 26 + dist * 0.28 });
      this.puff(mx, my, 6, 'rgba(230,225,215,0.75)', 70, 6, 0.5);
      this.spark(mx, my, 4, ['#ffd27a', '#ff9c45'], 120, 2.2, 0.3, 0);
    } else if (t.type === 'lightning') {
      const hit = [tgt]; let last = tgt;
      for (let i = 1; i < L.ch; i++) {
        let nb = null, nd = 90 * 90;
        for (const e of this.enemies) {
          if (e.dead || hit.includes(e)) continue;
          const dx = e.x - last.x, dy = e.y - last.y, d2 = dx * dx + dy * dy;
          if (d2 < nd) { nd = d2; nb = e; }
        }
        if (!nb) break; hit.push(nb); last = nb;
      }
      const pts = [[t.x, t.y - 16]];
      hit.forEach(e => pts.push([e.x, e.y]));
      this.fx.push({ k: 'bolt', pts: pts.map(p => p.slice()), seeds: [Math.random() * 99, Math.random() * 99], life: 0, max: 0.26, w: 1.5 + t.lv * 0.7 });
      hit.forEach((e, i) => { this.damage(e, L.d * Math.pow(0.8, i), true); this.spark(e.x, e.y, 5, ['#fff6b0', '#ffe27a', '#fff'], 120, 2.2, 0.35, 0); });
      this.spark(t.x, t.y - 16, 4, ['#fff6b0'], 70, 2, 0.3, 0);
    }
  }

  step(dt) {
    this.t += dt;
    const ps = this.parts;
    for (let i = ps.length - 1; i >= 0; i--) {
      const p = ps[i]; p.life += dt;
      if (p.life >= p.max) { ps[i] = ps[ps.length - 1]; ps.pop(); continue; }
      const dr = Math.exp(-p.drag * dt); p.vx *= dr; p.vy = p.vy * dr + p.g * dt; p.x += p.vx * dt; p.y += p.vy * dt;
      if (p.rot !== undefined) p.rot += p.vr * dt;
    }
    for (let i = this.fx.length - 1; i >= 0; i--) { const f = this.fx[i]; f.life += dt; if (f.life >= f.max) this.fx.splice(i, 1); }
    for (let i = this.floats.length - 1; i >= 0; i--) { const f = this.floats[i]; f.life += dt; if (f.life >= f.max) this.floats.splice(i, 1); }
    this.goldShown += (this.gold - this.goldShown) * Math.min(1, dt * 9);
    this.goldBump = Math.max(0, this.goldBump - dt * 3.2); this.livesBump = Math.max(0, this.livesBump - dt * 2.2);
    this.heartPulse = Math.max(0, this.heartPulse - dt * 1.5);
    this.shakeT = Math.max(0, this.shakeT - dt); this.flash = Math.max(0, this.flash - dt * 2);
    const sk = this.shakeT > 0 ? this.shakeT * 14 : 0;
    this.shx = sk ? Math.sin(this.t * 90) * sk : 0; this.shy = sk ? Math.cos(this.t * 77) * sk : 0;

    if (this.over) {
      this.endT += dt;
      for (const e of this.enemies) { e.px = e.x; e.py = e.y; }
      for (const tw of this.towers) { tw.paim = tw.aim; tw.precoil = tw.recoil; tw.recoil = Math.max(0, tw.recoil - dt * 6); tw.glow = Math.max(0, tw.glow - dt); }
      if (this.won && this.endT < 4 && Math.random() < 0.5) this.confetti(rnd.float(0, BW), rnd.float(-30, 80), 4, ['#f3c9d0', '#f6efd9', '#f4cf5c', '#9ed08a', '#86d6f2'], 60, 2.6);
      return;
    }

    // wave clock
    if (this.wave < MAX_WAVE) {
      this.waveTimer -= dt;
      if (this.waveTimer <= 0) this.startWave();
    }
    this.spawnClock += dt;
    while (this.queue.length && this.queue[0].t <= this.spawnClock) this.spawnEnemy(this.queue.shift().k);

    // AI
    this.aiCd -= dt;
    if (this.aiCd <= 0) {
      const act = DefenseAI.think(this.observe());
      if (act) {
        this.aiCd = AI_INTERVAL;
        if (act.act === 'build') this.build(act.type, act.c, act.r);
        else { const tw = this.towers.find(x => x.id === act.id); if (tw) this.upgrade(tw); }
      } else this.aiCd = 0.25;
    }

    for (const t of this.towers) this.stepTower(t, dt);

    // enemies
    for (const e of this.enemies) {
      e.px = e.x; e.py = e.y; e.pa = e.a;
      e.born += dt; e.flash = Math.max(0, e.flash - dt);
      if (e.slowT > 0) { e.slowT -= dt; if (e.slowT <= 0) e.slowF = 0; }
      const v = e.sp * (1 - e.slowF);
      e.d += v * dt; e.gait += v * dt * 0.22; e.key += dt * (1.2 + v * 0.02);
      pathAt(e.d, e.lat, this.tmp); e.x = this.tmp.x; e.y = this.tmp.y; e.a = this.tmp.a;
      if (e.d >= PLEN - 4 && !e.dead) {
        e.dead = true; const cost = EK[e.k].life;
        this.lives -= cost; this.livesBump = 1; this.heartPulse = 1; this.shakeT = 0.25 + cost * 0.05; this.flash = 0.5;
        this.puff(e.x, e.y, 8, 'rgba(255,120,90,0.8)', 110, 6, 0.6);
        this.floats.push({ x: e.x - 20, y: e.y, text: '-' + cost, life: 0, max: 1.1, bad: true });
      }
    }
    // projectiles
    for (let i = this.bolts.length - 1; i >= 0; i--) {
      const b = this.bolts[i]; b.px = b.x; b.py = b.y; b.life += dt;
      if (!b.tgt.dead) { b.lx = b.tgt.x; b.ly = b.tgt.y; }
      const dx = b.lx - b.x, dy = b.ly - b.y, dist = Math.hypot(dx, dy), mv = 600 * dt;
      b.a = Math.atan2(dy, dx);
      if (dist <= mv + 4) {
        if (!b.tgt.dead) this.damage(b.tgt, b.dmg);
        this.spark(b.lx, b.ly, 3, ['#fff3c4', '#e7c37a'], 80, 1.6, 0.3, 0);
        this.bolts.splice(i, 1);
      } else { b.x += dx / dist * mv; b.y += dy / dist * mv; if (b.life > 2) this.bolts.splice(i, 1); }
    }
    for (let i = this.shells.length - 1; i >= 0; i--) {
      const s = this.shells[i]; s.px = s.x; s.py = s.y; s.pt = s.t; s.t += dt / s.Tf;
      const u = Math.min(1, s.t); s.x = s.sx + (s.tx - s.sx) * u; s.y = s.sy + (s.ty - s.sy) * u;
      if (s.t >= 1) {
        this.shells.splice(i, 1);
        const R = s.sp;
        for (const e of this.enemies) {
          if (e.dead) continue;
          const d = Math.hypot(e.x - s.tx, e.y - s.ty);
          if (d <= R + EK[e.k].r * 0.6) this.damage(e, s.dmg * (d < R * 0.45 ? 1 : 0.65));
        }
        this.fx.push({ k: 'boom', x: s.tx, y: s.ty, r1: R, life: 0, max: 0.45 });
        this.puff(s.tx, s.ty, 9, 'rgba(210,190,150,0.8)', 110, 8, 0.7);
        this.spark(s.tx, s.ty, 10, ['#ffd27a', '#ff9c45', '#fff0c0'], 200, 2.8, 0.45, 80);
        if (this.shakeT < 0.05) this.shakeT = 0.06;
      }
    }
    // remove dead / leaked
    if (this.enemies.some(e => e.dead)) this.enemies = this.enemies.filter(e => !e.dead);

    // end conditions
    if (this.lives <= 0) { this.lives = 0; this.finish(false, 'lives'); return; }
    if (this.wave >= MAX_WAVE && !this.queue.length && !this.enemies.length) { this.finish(true); return; }
    if (this.t >= TIME_CAP) this.finish(false, 'time');
  }

  finish(won, cause) {
    this.over = true; this.won = won; this.cause = cause || ''; this.endT = 0;
    if (won) this.confetti(BW / 2, BH / 2, 40, ['#f3c9d0', '#f6efd9', '#f4cf5c', '#9ed08a', '#86d6f2'], 300, 3);
    else { this.shakeT = 0.6; this.flash = 1; }
  }

  hud() {
    return { score: fmt(this.score), detail: `Wave ${Math.max(1, this.wave)}/${MAX_WAVE} \u00b7 ${this.lives} lives \u00b7 ${Math.round(this.gold)} gold` };
  }
  result() {
    if (this.won) return `Held the grove through all ${MAX_WAVE} waves with ${this.lives} lives to spare`;
    if (this.cause === 'time') return 'Out of time';
    return `The grove fell on wave ${this.wave} after ${this.kills} beetles felled`;
  }

  // ======================= DRAWING =======================
  drawStatic(x, W, H) {
    // water
    const wg = x.createLinearGradient(0, 0, 0, H); wg.addColorStop(0, '#2b5666'); wg.addColorStop(1, '#1f4254');
    x.fillStyle = wg; x.fillRect(0, 0, W, H);
    const rg = x.createRadialGradient(W / 2, H / 2, 0, W / 2, H / 2, Math.max(W, H) * 0.65);
    rg.addColorStop(0, 'rgba(120,190,200,0.22)'); rg.addColorStop(1, 'rgba(10,30,45,0.35)');
    x.fillStyle = rg; x.fillRect(0, 0, W, H);
    x.save(); x.translate(this.ox, this.oy); x.scale(this.s, this.s);
    // island shadow & shallows
    for (let i = 4; i >= 1; i--) {
      x.fillStyle = `rgba(120,200,205,${0.05 * (5 - i)})`; roundRect(x, -M - i * 7, -M - i * 7, BW + 2 * M + i * 14, BH + 2 * M + i * 14, 46 + i * 7); x.fill();
    }
    x.fillStyle = 'rgba(8,24,34,0.35)'; roundRect(x, -M + 8, -M + 12, BW + 2 * M, BH + 2 * M, 46); x.fill();
    x.fillStyle = '#a89868'; roundRect(x, -M, -M + 6, BW + 2 * M, BH + 2 * M, 46); x.fill();   // cliff lip
    x.fillStyle = '#d3c594'; roundRect(x, -M, -M, BW + 2 * M, BH + 2 * M, 46); x.fill();       // sand
    x.fillStyle = '#6e9a52'; roundRect(x, -M + 9, -M + 9, BW + 2 * M - 18, BH + 2 * M - 18, 38); x.fill();
    // low-poly grass tiles
    const rng = mkRng(2024);
    for (let c = 0; c < COLS; c++) for (let r = 0; r < ROWS; r++) {
      const x0 = c * T, y0 = r * T, chk = (c + r) & 1, j1 = rng() * 5 - 2.5, j2 = rng() * 5 - 2.5, flip = rng() < 0.5;
      const L1 = 40 + chk * 1.6 + j1, L2 = 38 + chk * 1.6 + j2;
      x.fillStyle = `hsl(${98 + rng() * 6},${32 + rng() * 5}%,${L1}%)`;
      if (flip) poly(x, [x0, y0, x0 + T, y0, x0, y0 + T]); else poly(x, [x0, y0, x0 + T, y0, x0 + T, y0 + T]);
      x.fill();
      x.fillStyle = `hsl(${100 + rng() * 6},${30 + rng() * 5}%,${L2 - 2.5}%)`;
      if (flip) poly(x, [x0 + T, y0, x0 + T, y0 + T, x0, y0 + T]); else poly(x, [x0, y0, x0 + T, y0 + T, x0, y0 + T]);
      x.fill();
    }
    // margin tufts & flowers
    const fr = mkRng(8);
    for (let i = 0; i < 90; i++) {
      const fx = -M + 12 + fr() * (BW + 2 * M - 24), fy = -M + 12 + fr() * (BH + 2 * M - 24);
      const c = Math.floor(fx / T), r = Math.floor(fy / T);
      const inB = fx >= 0 && fx < BW && fy >= 0 && fy < BH;
      if (inB && (GRID[c][r] === 1)) continue;
      if (inB && fr() < 0.5) continue;
      const kind = fr();
      if (kind < 0.55) { x.fillStyle = 'rgba(40,90,40,0.5)'; poly(x, [fx - 3, fy + 2, fx, fy - 5, fx + 1, fy + 2]); x.fill(); poly(x, [fx + 1, fy + 2, fx + 4, fy - 4, fx + 5, fy + 2]); x.fill(); }
      else { x.fillStyle = ['#f6efd9', '#f3c9d0', '#f4cf5c'][(fr() * 3) | 0]; x.beginPath(); x.arc(fx, fy, 1.8, 0, TAU); x.fill(); }
    }
    // road
    const road = (w, col, ox, oy) => {
      x.strokeStyle = col; x.lineWidth = w; x.lineJoin = 'round'; x.lineCap = 'butt';
      x.beginPath(); x.moveTo(PX[0] + ox, PY[0] + oy);
      for (let i = 4; i < PN; i += 4) x.lineTo(PX[i] + ox, PY[i] + oy);
      x.lineTo(PX[PN - 1] + ox, PY[PN - 1] + oy); x.stroke();
    };
    road(T * 0.92, 'rgba(15,35,25,0.22)', 4, 6);
    road(T * 0.86, '#4d5766', 0, 0);
    road(T * 0.76, '#7c8797', 0, 0);
    road(T * 0.62, '#8a96a6', 0, 0);
    // cobbles
    const cr = mkRng(99);
    for (let d = 8; d < PLEN - 8; d += 9) {
      const f = Math.min(PN - 1, (d / PS) | 0), lat = (cr() - 0.5) * T * 0.62, a = PA[f];
      const cx = PX[f] - Math.sin(a) * lat, cy = PY[f] + Math.cos(a) * lat, sz = 5 + cr() * 5;
      x.fillStyle = cr() < 0.5 ? 'rgba(255,255,255,0.08)' : 'rgba(30,40,55,0.12)';
      x.save(); x.translate(cx, cy); x.rotate(a + (cr() - 0.5) * 0.5); roundRect(x, -sz, -sz * 0.6, sz * 2, sz * 1.2, 2); x.fill(); x.restore();
    }
    // entry gate (on whichever side the road enters)
    {
      x.save(); x.translate(ENTRY.x, ENTRY.y); if (ENTRY.side < 0) x.scale(-1, 1);
      x.fillStyle = 'rgba(15,30,20,0.3)'; x.fillRect(-4, -52, 18, 112);
      for (const sy of [-46, 46]) {
        x.fillStyle = '#6b4a2f'; roundRect(x, -8, sy - 14, 16, 28, 3); x.fill();
        x.fillStyle = '#8b6540'; roundRect(x, -8, sy - 14, 8, 28, 3); x.fill();
        x.fillStyle = '#c95a4a'; poly(x, [8, sy - 12, 22, sy - 8, 8, sy - 2]); x.fill();
      }
      x.restore();
    }
    x.restore();
  }

  drawTower(ctx, t, tt, a) {
    const ty = t.type, col = TW[ty].col, lv = t.lv;
    const s = ease.outBack(Math.min(1, t.born / 0.35)), cx = t.x, cy = t.y;
    const aim = lerp(t.paim, t.aim, a), rec = lerp(t.precoil, t.recoil, a);
    ctx.save(); ctx.translate(cx, cy + 10); ctx.scale(s, s); ctx.translate(-cx, -(cy + 10));
    // shadow
    ctx.fillStyle = 'rgba(12,28,20,0.3)'; roundRect(ctx, cx - 24 + 8, cy - 22 + 12, 52, 50, 8); ctx.fill();
    // pedestal
    ctx.fillStyle = '#4f5763'; roundRect(ctx, cx - 26, cy - 22 + 7, 52, 46, 8); ctx.fill();
    const pg = ctx.createLinearGradient(0, cy - 22, 0, cy + 24); pg.addColorStop(0, '#b4bcc7'); pg.addColorStop(1, '#8f99a7');
    ctx.fillStyle = pg; roundRect(ctx, cx - 26, cy - 22, 52, 46, 8); ctx.fill();
    ctx.strokeStyle = lv === 2 ? '#f0d078' : col; ctx.globalAlpha = 0.85; ctx.lineWidth = lv === 2 ? 3 : 2;
    roundRect(ctx, cx - 20, cy - 16, 40, 34, 5); ctx.stroke(); ctx.globalAlpha = 1;
    if (lv >= 1) { ctx.fillStyle = lv === 2 ? '#f0d078' : '#dfe5ec'; for (const [dx, dy] of [[-22, -18], [22, -18], [-22, 20], [22, 20]]) { ctx.beginPath(); ctx.arc(cx + dx, cy + dy, 2.2, 0, TAU); ctx.fill(); } }
    ctx.fillStyle = lv === 2 ? '#f0d078' : '#dde3ea';
    for (let i = 0; i <= lv; i++) { ctx.beginPath(); ctx.arc(cx - lv * 4.5 + i * 9, cy + 28, 2.3, 0, TAU); ctx.fill(); }
    // top
    const ty0 = cy - 3 + Math.sin(tt * 2 + t.id) * (ty === 'frost' ? 1.5 : 0);
    ctx.save(); ctx.translate(cx, ty0);
    if (ty === 'arrow') {
      ctx.rotate(aim); ctx.translate(-rec * 3, 0);
      const offs = lv === 2 ? [-6, 6] : [0], sc = 1 + lv * 0.12;
      ctx.fillStyle = '#4a3a2a'; ctx.beginPath(); ctx.arc(-4 + rec * 3, 0, 8 + lv, 0, TAU); ctx.fill();
      for (const o of offs) {
        ctx.save(); ctx.translate(0, o * 0.9); ctx.scale(sc, sc);
        ctx.fillStyle = '#946237'; roundRect(ctx, -12, -3, 28, 6, 2.5); ctx.fill();
        ctx.fillStyle = '#b8824a'; roundRect(ctx, -12, -3, 28, 2.6, 1.3); ctx.fill();
        ctx.strokeStyle = lv >= 1 ? '#e6c37c' : '#c9a15a'; ctx.lineWidth = 3; ctx.lineCap = 'round';
        ctx.beginPath(); ctx.moveTo(6, -14); ctx.quadraticCurveTo(18, 0, 6, 14); ctx.stroke();
        ctx.strokeStyle = 'rgba(255,248,225,0.85)'; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(6, -14); ctx.lineTo(4 - rec * 6, 0); ctx.lineTo(6, 14); ctx.stroke();
        if (rec < 0.6) { ctx.strokeStyle = '#efe6cf'; ctx.lineWidth = 1.6; ctx.beginPath(); ctx.moveTo(-6, 0); ctx.lineTo(16, 0); ctx.stroke(); ctx.fillStyle = '#cfd6de'; poly(ctx, [16, -2.5, 22, 0, 16, 2.5]); ctx.fill(); }
        ctx.restore();
      }
      if (lv === 2) { ctx.strokeStyle = '#f0d078'; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(-4, 0, 11, 0, TAU); ctx.stroke(); }
    } else if (ty === 'cannon') {
      ctx.rotate(aim); const sz = 1 + lv * 0.13;
      ctx.fillStyle = '#2f353f'; ctx.beginPath(); ctx.arc(0, 0, 12 + lv * 1.5, 0, TAU); ctx.fill();
      ctx.fillStyle = '#4a525e'; ctx.beginPath(); ctx.arc(-1, -1, 9 + lv * 1.5, 0, TAU); ctx.fill();
      ctx.translate(-rec * 5, 0);
      const bg = ctx.createLinearGradient(0, -8 * sz, 0, 8 * sz); bg.addColorStop(0, '#6a7380'); bg.addColorStop(0.5, '#3d444f'); bg.addColorStop(1, '#2a2f38');
      ctx.fillStyle = bg; roundRect(ctx, -4, -7 * sz, 28 * sz, 14 * sz, 4); ctx.fill();
      ctx.fillStyle = lv === 2 ? '#f0d078' : '#8d97a5'; roundRect(ctx, 20 * sz, -8.5 * sz, 6 * sz, 17 * sz, 2.5); ctx.fill();
      if (lv >= 1) { ctx.fillStyle = lv === 2 ? '#f0d078' : '#8d97a5'; ctx.fillRect(6, -7 * sz, 3, 14 * sz); }
      if (lv === 2) ctx.fillRect(13, -7 * sz, 3, 14 * sz);
      ctx.fillStyle = '#16191e'; ctx.beginPath(); ctx.arc(26 * sz, 0, 3.2 * sz, 0, TAU); ctx.fill();
      ctx.fillStyle = col; ctx.globalAlpha = 0.9 * (0.4 + rec * 0.6); ctx.beginPath(); ctx.arc(-1, -1, 3, 0, TAU); ctx.fill(); ctx.globalAlpha = 1;
    } else if (ty === 'frost') {
      const gl = 0.22 + t.glow * 0.4;
      ctx.fillStyle = `rgba(140,220,255,${gl * 0.5})`; ctx.beginPath(); ctx.arc(0, -4, 24 + lv * 3, 0, TAU); ctx.fill();
      ctx.fillStyle = `rgba(170,235,255,${gl * 0.6})`; ctx.beginPath(); ctx.arc(0, -4, 15 + lv * 2, 0, TAU); ctx.fill();
      const crystal = (px, py, w, h, rot) => {
        ctx.save(); ctx.translate(px, py); ctx.rotate(rot);
        ctx.fillStyle = '#bfeeff'; poly(ctx, [0, -h, w, -h * 0.2, 0, h * 0.35]); ctx.fill();
        ctx.fillStyle = '#6cc4ea'; poly(ctx, [0, -h, -w, -h * 0.2, 0, h * 0.35]); ctx.fill();
        ctx.fillStyle = '#e8fbff'; poly(ctx, [0, -h, w * 0.35, -h * 0.4, 0, -h * 0.05]); ctx.fill();
        ctx.restore();
      };
      const sc = 1 + lv * 0.18;
      if (lv >= 1) { crystal(-13 * sc, 4, 6 * sc, 12 * sc, -0.35); crystal(13 * sc, 4, 6 * sc, 12 * sc, 0.35); }
      crystal(0, 2, 8 * sc, 17 * sc, 0);
      if (lv === 2) for (let i = 0; i < 3; i++) { const a2 = tt * 1.6 + i * TAU / 3; crystal(Math.cos(a2) * 21, Math.sin(a2) * 9 - 6, 3, 6, a2); }
    } else {
      // lightning coil
      const rings = 3 + lv, sc = 1 + lv * 0.1;
      ctx.fillStyle = '#6b4a2f'; ctx.beginPath(); ctx.ellipse(0, 6, 13 * sc, 7 * sc, 0, 0, TAU); ctx.fill();
      for (let i = 0; i < rings; i++) {
        const k = i / rings, ry = 4 - i * 4.6 * sc, rw = (12 - i * 1.7) * sc;
        ctx.fillStyle = i % 2 ? '#b9763b' : '#d89a55'; ctx.beginPath(); ctx.ellipse(0, ry, rw, rw * 0.5, 0, 0, TAU); ctx.fill();
        ctx.strokeStyle = 'rgba(60,35,15,0.5)'; ctx.lineWidth = 1; ctx.stroke();
      }
      const tipY = 4 - rings * 4.6 * sc - 3, fl = 0.7 + 0.3 * Math.sin(tt * 30 + t.id) + t.glow * 0.4;
      ctx.fillStyle = `rgba(255,236,120,${0.25 * fl})`; ctx.beginPath(); ctx.arc(0, tipY, 15, 0, TAU); ctx.fill();
      ctx.fillStyle = `rgba(255,246,170,${0.5 * fl})`; ctx.beginPath(); ctx.arc(0, tipY, 9, 0, TAU); ctx.fill();
      ctx.fillStyle = '#fff8c8'; ctx.beginPath(); ctx.arc(0, tipY, 4.5 + lv, 0, TAU); ctx.fill();
      const ph = Math.floor(tt * 14 + t.id);
      ctx.strokeStyle = 'rgba(255,240,140,0.8)'; ctx.lineWidth = 1.1;
      for (let i = 0; i < 2 + lv; i++) {
        const a2 = ((ph * 2.3 + i * 2.1 + t.id) % TAU), l = 9 + ((ph * 7 + i * 3) % 6);
        ctx.beginPath(); ctx.moveTo(Math.cos(a2) * 5, tipY + Math.sin(a2) * 5); ctx.lineTo(Math.cos(a2 + 0.2) * l, tipY + Math.sin(a2 + 0.2) * l); ctx.stroke();
      }
      if (lv === 2) for (let i = 0; i < 2; i++) { const a2 = tt * 2.4 + i * Math.PI; ctx.fillStyle = '#fff3a0'; ctx.beginPath(); ctx.arc(Math.cos(a2) * 18, tipY + 8 + Math.sin(a2) * 5, 2.6, 0, TAU); ctx.fill(); }
    }
    ctx.restore();
    ctx.restore();
    // range ring when fresh
    if (t.ring > 0) {
      const L = TW[ty].lv[lv], k = Math.min(1, t.ring / 0.6);
      ctx.strokeStyle = `rgba(255,255,240,${0.55 * k})`; ctx.lineWidth = 2; ctx.setLineDash([6, 8]); ctx.lineDashOffset = -tt * 20;
      ctx.beginPath(); ctx.arc(cx, cy, L.r * ease.outCubic(Math.min(1, (1.6 - t.ring) / 0.5 + 0.05)), 0, TAU); ctx.stroke(); ctx.setLineDash([]);
      ctx.fillStyle = `rgba(255,255,240,${0.05 * k})`; ctx.fill();
    }
  }

  drawBeetle(ctx, e, tt, a) {
    const K = EK[e.k], r = K.r;
    const x = lerp(e.px, e.x, a), y = lerp(e.py, e.y, a), ang = e.pa + wrapA(e.a - e.pa) * a;
    const sp = ease.outBack(Math.min(1, e.born / 0.4));
    const pal = { scout: ['#f0b240', '#c98820', '#ffd987'], swarm: ['#e0766a', '#b24c42', '#ff9d90'], armored: ['#9aa6b8', '#667286', '#cdd6e2'], giant: ['#b5574a', '#7e382e', '#dc8a78'] }[e.k];
    // shadow
    ctx.fillStyle = 'rgba(12,28,20,0.28)'; ctx.beginPath(); ctx.ellipse(x + r * 0.45, y + r * 0.6, r * 1.25, r * 0.85, ang, 0, TAU); ctx.fill();
    ctx.save(); ctx.translate(x, y); ctx.scale(sp, sp);
    if (e.slowT > 0) { ctx.fillStyle = 'rgba(150,225,255,0.28)'; ctx.beginPath(); ctx.arc(0, 0, r * 1.5, 0, TAU); ctx.fill(); }
    ctx.rotate(ang);
    // legs
    ctx.strokeStyle = '#2f2a28'; ctx.lineWidth = Math.max(1.2, r * 0.16); ctx.lineCap = 'round';
    for (let i = -1; i <= 1; i++) {
      const lx = i * r * 0.55, sw = Math.sin(e.gait * 6 + i * 2.1) * r * 0.32;
      ctx.beginPath(); ctx.moveTo(lx, -r * 0.55); ctx.lineTo(lx + sw, -r * 1.12); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(lx, r * 0.55); ctx.lineTo(lx - sw, r * 1.12); ctx.stroke();
    }
    // body
    ctx.fillStyle = pal[1]; ctx.beginPath(); ctx.ellipse(0, 1, r * 1.18, r * 0.92, 0, 0, TAU); ctx.fill();
    ctx.fillStyle = pal[0]; ctx.beginPath(); ctx.ellipse(-r * 0.04, -r * 0.05, r * 1.12, r * 0.85, 0, 0, TAU); ctx.fill();
    // lit highlight (light from the top-left in world space)
    const lx = Math.cos(ang) * -r * 0.3 + Math.sin(ang) * -r * 0.38, ly = -Math.sin(ang) * -r * 0.3 + Math.cos(ang) * -r * 0.38;
    ctx.fillStyle = pal[2]; ctx.globalAlpha = 0.55; ctx.beginPath(); ctx.ellipse(lx, ly, r * 0.6, r * 0.36, -ang * 0.0, 0, TAU); ctx.fill(); ctx.globalAlpha = 1;
    ctx.strokeStyle = pal[1]; ctx.lineWidth = Math.max(1, r * 0.1);
    ctx.beginPath(); ctx.moveTo(-r * 1.05, 0); ctx.lineTo(r * 0.5, 0); ctx.stroke();
    if (e.k === 'scout') { ctx.fillStyle = pal[1]; ctx.fillRect(-r * 0.55, -r * 0.8, r * 0.28, r * 1.6); }
    if (e.k === 'swarm') { ctx.fillStyle = pal[1]; ctx.beginPath(); ctx.arc(-r * 0.4, -r * 0.35, r * 0.2, 0, TAU); ctx.arc(-r * 0.4, r * 0.35, r * 0.2, 0, TAU); ctx.fill(); }
    if (e.k === 'armored') {
      ctx.strokeStyle = pal[1]; ctx.lineWidth = r * 0.12;
      for (const px of [-r * 0.55, -r * 0.05]) { ctx.beginPath(); ctx.ellipse(px, 0, r * 0.2, r * 0.78, 0, 0, TAU); ctx.stroke(); }
      ctx.fillStyle = '#eef2f8'; for (const [px, py] of [[-r * 0.55, -r * 0.55], [-r * 0.55, r * 0.55], [-r * 0.05, -r * 0.5], [-r * 0.05, r * 0.5]]) { ctx.beginPath(); ctx.arc(px, py, r * 0.08, 0, TAU); ctx.fill(); }
    }
    if (e.k === 'giant') {
      ctx.fillStyle = pal[1];
      for (let i = -2; i <= 2; i++) { poly(ctx, [-r * 0.6 + i * r * 0.28, -r * 0.18, -r * 0.6 + i * r * 0.28 - r * 0.28, 0, -r * 0.6 + i * r * 0.28, r * 0.18]); ctx.fill(); }
      ctx.fillStyle = pal[2]; for (const s of [-1, 1]) { ctx.beginPath(); ctx.arc(-r * 0.25, s * r * 0.5, r * 0.14, 0, TAU); ctx.fill(); }
    }
    // wind-up key
    ctx.save(); ctx.translate(-r * 0.35, 0); ctx.rotate(e.key);
    ctx.strokeStyle = '#d9c88c'; ctx.lineWidth = Math.max(1.3, r * 0.14);
    ctx.beginPath(); ctx.moveTo(-r * 0.5, 0); ctx.lineTo(r * 0.5, 0); ctx.stroke();
    ctx.beginPath(); ctx.arc(-r * 0.62, 0, r * 0.2, 0, TAU); ctx.arc(r * 0.62, 0, r * 0.2, 0, TAU); ctx.stroke();
    ctx.restore();
    // head
    ctx.fillStyle = '#3a3330'; ctx.beginPath(); ctx.arc(r * 1.0, 0, r * 0.5, 0, TAU); ctx.fill();
    ctx.strokeStyle = '#3a3330'; ctx.lineWidth = Math.max(1, r * 0.1);
    ctx.beginPath(); ctx.moveTo(r * 1.25, -r * 0.2); ctx.lineTo(r * 1.65, -r * 0.5); ctx.moveTo(r * 1.25, r * 0.2); ctx.lineTo(r * 1.65, r * 0.5); ctx.stroke();
    ctx.fillStyle = '#fff'; for (const sd of [-1, 1]) { ctx.beginPath(); ctx.arc(r * 1.2, sd * r * 0.22, r * 0.17, 0, TAU); ctx.fill(); }
    ctx.fillStyle = '#111'; for (const sd of [-1, 1]) { ctx.beginPath(); ctx.arc(r * 1.25, sd * r * 0.22, r * 0.08, 0, TAU); ctx.fill(); }
    if (e.flash > 0) { ctx.fillStyle = `rgba(255,255,255,${Math.min(0.7, e.flash * 6)})`; ctx.beginPath(); ctx.ellipse(0, 0, r * 1.2, r * 0.95, 0, 0, TAU); ctx.fill(); }
    if (e.slowT > 0) { ctx.fillStyle = 'rgba(130,210,255,0.3)'; ctx.beginPath(); ctx.ellipse(0, 0, r * 1.2, r * 0.95, 0, 0, TAU); ctx.fill(); }
    ctx.restore();
    // health bar
    if (e.hp < e.mhp || e.k === 'giant') {
      const w = r * 2 + 8, f = Math.max(0, e.hp / e.mhp), by = y - r * 1.5 - 8;
      ctx.fillStyle = 'rgba(15,22,25,0.7)'; roundRect(ctx, x - w / 2 - 1, by - 1, w + 2, 6, 3); ctx.fill();
      ctx.fillStyle = f > 0.6 ? '#8fcf6a' : f > 0.3 ? '#f0c04a' : '#e2644f';
      if (f > 0) { roundRect(ctx, x - w / 2, by, Math.max(3, w * f), 4, 2); ctx.fill(); }
    }
  }

  draw(ctx, W, H) {
    const a = al(), tt = this.t + a / 60, s = this.s;
    staticLayer(ctx, 'defense_bg', W, H, (x, w, h) => this.drawStatic(x, w, h));
    // water glints (outside the island)
    ctx.lineCap = 'round'; ctx.lineWidth = 1.4;
    for (const g of this.glints) {
      const k = 0.5 + 0.5 * Math.sin(tt * 0.9 + g.ph);
      ctx.strokeStyle = `rgba(200,240,245,${0.05 + 0.2 * k})`;
      const w = g.len * (0.6 + 0.4 * k);
      ctx.beginPath(); ctx.moveTo(g.x - w / 2, g.y); ctx.quadraticCurveTo(g.x, g.y - 2.5, g.x + w / 2, g.y); ctx.stroke();
    }
    ctx.save();
    ctx.translate(this.ox + this.shx * s, this.oy + this.shy * s); ctx.scale(s, s);
    // drifting cloud shadows
    ctx.fillStyle = 'rgba(8,25,20,0.07)';
    for (let i = 0; i < 3; i++) {
      const span = BW + 500, cxx = ((tt * (9 + i * 3) + i * 420) % span) - 250, cyy = 120 + i * 220 + Math.sin(tt * 0.15 + i) * 20;
      ctx.beginPath(); ctx.ellipse(cxx, cyy, 190, 70, -0.15, 0, TAU); ctx.fill();
    }
    // exit shrine (grove heart)
    {
      const gx = EXIT.x, gy = EXIT.y, pl = this.heartPulse;
      ctx.save(); ctx.translate(gx, gy); if (EXIT.side > 0) ctx.scale(-1, 1); ctx.translate(-gx, -gy);
      ctx.fillStyle = 'rgba(15,30,20,0.3)'; ctx.fillRect(gx - 6, gy - 50, 22, 112);
      for (const sy of [-44, 44]) {
        ctx.fillStyle = '#7a8594'; roundRect(ctx, gx - 10, gy + sy - 16, 20, 32, 4); ctx.fill();
        ctx.fillStyle = '#9aa5b3'; roundRect(ctx, gx - 10, gy + sy - 16, 10, 32, 4); ctx.fill();
        const gl = 0.5 + 0.3 * Math.sin(tt * 2 + sy) + pl * 0.5;
        ctx.fillStyle = `rgba(150,235,170,${0.25 * gl})`; ctx.beginPath(); ctx.arc(gx, gy + sy, 16, 0, TAU); ctx.fill();
        ctx.fillStyle = pl > 0.2 ? '#ff9a80' : '#9fe5a8'; ctx.beginPath(); ctx.arc(gx, gy + sy, 5, 0, TAU); ctx.fill();
      }
      ctx.restore();
    }
    for (const tr of TREES) drawTree(ctx, tr, tt);
    // towers (y-sorted)
    const tws = this.towers.slice().sort((p, q) => p.y - q.y);
    for (const t of tws) this.drawTower(ctx, t, tt, a);
    // enemies (y-sorted)
    const ens = this.enemies.slice().sort((p, q) => p.y - q.y);
    for (const e of ens) this.drawBeetle(ctx, e, tt, a);

    // shells (ground shadow + airborne ball)
    for (const sh of this.shells) {
      const u = lerp(sh.pt, sh.t, a), uu = Math.min(1, u);
      const gx = sh.sx + (sh.tx - sh.sx) * uu, gy = sh.sy + (sh.ty - sh.sy) * uu, h = Math.sin(uu * Math.PI) * sh.arc;
      ctx.fillStyle = 'rgba(10,25,18,0.3)'; ctx.beginPath(); ctx.ellipse(gx, gy + 3, 6 - h * 0.03, 3, 0, 0, TAU); ctx.fill();
      ctx.fillStyle = '#23262c'; ctx.beginPath(); ctx.arc(gx, gy - h, 5.5, 0, TAU); ctx.fill();
      ctx.fillStyle = '#6a7380'; ctx.beginPath(); ctx.arc(gx - 1.5, gy - h - 1.5, 2, 0, TAU); ctx.fill();
    }
    for (const b of this.bolts) {
      const x = lerp(b.px, b.x, a), y = lerp(b.py, b.y, a);
      ctx.save(); ctx.translate(x, y); ctx.rotate(b.a);
      ctx.strokeStyle = 'rgba(255,245,200,0.35)'; ctx.lineWidth = 3; ctx.beginPath(); ctx.moveTo(-14, 0); ctx.lineTo(0, 0); ctx.stroke();
      ctx.strokeStyle = '#f2ead2'; ctx.lineWidth = 1.8; ctx.beginPath(); ctx.moveTo(-9, 0); ctx.lineTo(4, 0); ctx.stroke();
      ctx.fillStyle = '#d4dbe3'; poly(ctx, [3, -2.6, 8, 0, 3, 2.6]); ctx.fill();
      ctx.restore();
    }
    // fx
    for (const f of this.fx) {
      const u = (f.life + a / 60) / f.max;
      if (u > 1) continue;
      if (f.k === 'ring') {
        const rr = lerp(f.r0, f.r1, ease.outCubic(u)); ctx.strokeStyle = f.col + (1 - u) * 0.8 + ')'; ctx.lineWidth = 2.5 * (1 - u) + 0.5; ctx.beginPath(); ctx.arc(f.x, f.y, rr, 0, TAU); ctx.stroke();
      } else if (f.k === 'frost') {
        const rr = f.r1 * ease.outCubic(u);
        ctx.fillStyle = `rgba(150,225,255,${0.14 * (1 - u)})`; ctx.beginPath(); ctx.arc(f.x, f.y, rr, 0, TAU); ctx.fill();
        ctx.strokeStyle = `rgba(200,240,255,${0.85 * (1 - u)})`; ctx.lineWidth = 3 * (1 - u) + 1; ctx.beginPath(); ctx.arc(f.x, f.y, rr, 0, TAU); ctx.stroke();
        ctx.strokeStyle = `rgba(130,205,245,${0.6 * (1 - u)})`; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.arc(f.x, f.y, rr * 0.82, 0, TAU); ctx.stroke();
      } else if (f.k === 'boom') {
        const rr = f.r1 * (0.4 + 0.6 * ease.outCubic(u));
        ctx.fillStyle = `rgba(255,190,100,${0.4 * (1 - u)})`; ctx.beginPath(); ctx.arc(f.x, f.y, rr, 0, TAU); ctx.fill();
        ctx.strokeStyle = `rgba(255,235,190,${0.9 * (1 - u)})`; ctx.lineWidth = 3 * (1 - u) + 1; ctx.beginPath(); ctx.arc(f.x, f.y, rr, 0, TAU); ctx.stroke();
      } else if (f.k === 'bolt') {
        const seed = f.seeds[Math.floor(tt * 40) & 1], fade = 1 - u;
        for (const pass of [0, 1]) {
          ctx.strokeStyle = pass ? `rgba(255,255,235,${fade})` : `rgba(255,226,90,${0.55 * fade})`; ctx.lineWidth = pass ? f.w : f.w * 3;
          ctx.lineJoin = 'round'; ctx.beginPath();
          for (let i = 0; i < f.pts.length - 1; i++) {
            const p0 = f.pts[i], p1 = f.pts[i + 1], dx = p1[0] - p0[0], dy = p1[1] - p0[1], len = Math.hypot(dx, dy) || 1, nx = -dy / len, ny = dx / len, segs = Math.max(3, (len / 14) | 0);
            if (i === 0) ctx.moveTo(p0[0], p0[1]);
            for (let k = 1; k <= segs; k++) {
              const q = k / segs, jit = k === segs ? 0 : (Math.sin(seed * 12.9 + i * 7.1 + k * 3.7) * 7);
              ctx.lineTo(p0[0] + dx * q + nx * jit, p0[1] + dy * q + ny * jit);
            }
          }
          ctx.stroke();
        }
      }
    }
    // particles
    for (const p of this.parts) {
      const t = 1 - p.life / p.max, px = p.x + p.vx * a / 60, py = p.y + p.vy * a / 60;
      if (p.k === 'puff') { ctx.globalAlpha = 0.55 * t; ctx.fillStyle = p.col; ctx.beginPath(); ctx.arc(px, py, p.size * (1.6 - 0.6 * t), 0, TAU); ctx.fill(); }
      else if (p.k === 'conf') { ctx.globalAlpha = Math.min(1, t * 2); ctx.fillStyle = p.col; ctx.save(); ctx.translate(px, py); ctx.rotate(p.rot); ctx.fillRect(-p.size, -p.size * 0.5, p.size * 2, p.size); ctx.restore(); }
      else { ctx.globalAlpha = t; ctx.fillStyle = p.col; ctx.beginPath(); ctx.arc(px, py, p.size * (0.4 + 0.6 * t), 0, TAU); ctx.fill(); }
    }
    ctx.globalAlpha = 1;
    // petals
    for (const p of this.petals) {
      const x = ((p.u * BW + tt * p.sp * 1.2) % (BW + 80)) - 40, y = ((p.v * BH + tt * p.sp * 0.6) % (BH + 60)) - 30 + Math.sin(tt + p.ph) * 10;
      ctx.fillStyle = p.c; ctx.globalAlpha = 0.65; ctx.save(); ctx.translate(x, y); ctx.rotate(tt * 0.8 + p.ph); ctx.beginPath(); ctx.ellipse(0, 0, 3.2, 1.6, 0, 0, TAU); ctx.fill(); ctx.restore();
    }
    ctx.globalAlpha = 1;
    // floaters
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    for (const f of this.floats) {
      const u = (f.life + a / 60) / f.max; if (u > 1) continue;
      const y = f.y - 38 * ease.outCubic(u), al2 = u < 0.7 ? 1 : 1 - (u - 0.7) / 0.3;
      ctx.globalAlpha = al2; ctx.font = '600 15px Fredoka, sans-serif';
      if (f.bad) { ctx.fillStyle = '#ff8a72'; ctx.fillText(f.text, f.x, y); }
      else { coinIcon(ctx, f.x - 11, y, 5.2); ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(20,30,20,0.55)'; ctx.strokeText(f.text, f.x + 6, y + 0.5); ctx.fillStyle = '#ffe9a0'; ctx.fillText(f.text, f.x + 6, y + 0.5); }
    }
    ctx.globalAlpha = 1;
    this.drawHud(ctx, tt);
    ctx.restore();

    // end overlays
    if (this.over) {
      const k = Math.min(1, this.endT / 1.5);
      if (this.won) {
        const g = ctx.createRadialGradient(W / 2, H / 2, 0, W / 2, H / 2, Math.max(W, H) * 0.7);
        g.addColorStop(0, `rgba(255,236,170,${0.14 * k})`); g.addColorStop(1, `rgba(255,236,170,${0.02 * k})`);
        ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
      } else { ctx.fillStyle = `rgba(30,8,8,${0.5 * k})`; ctx.fillRect(0, 0, W, H); }
    }
    if (this.flash > 0 && !this.won) { ctx.fillStyle = `rgba(255,70,50,${0.18 * this.flash})`; ctx.fillRect(0, 0, W, H); }
    // soft vignette
    const vg = ctx.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.45, W / 2, H / 2, Math.max(W, H) * 0.8);
    vg.addColorStop(0, 'rgba(0,0,0,0)'); vg.addColorStop(1, 'rgba(0,10,15,0.35)');
    ctx.fillStyle = vg; ctx.fillRect(0, 0, W, H);
  }

  drawHud(ctx, tt) {
    const cy = -M - STRIP / 2 - 2;
    ctx.textBaseline = 'middle';
    const pill = (x, w) => { ctx.fillStyle = 'rgba(10,26,32,0.55)'; roundRect(ctx, x, cy - 20, w, 40, 20); ctx.fill(); };
    const ink = '#f4ecd8';
    // wave
    pill(-M, 190);
    ctx.textAlign = 'left'; ctx.fillStyle = 'rgba(244,236,216,0.6)'; ctx.font = '600 12px Fredoka, sans-serif'; ctx.fillText('WAVE', -M + 18, cy - 8);
    ctx.fillStyle = ink; ctx.font = '600 24px Fredoka, sans-serif'; ctx.fillText(String(Math.max(1, this.wave)), -M + 18, cy + 8);
    ctx.fillStyle = 'rgba(244,236,216,0.55)'; ctx.font = '500 14px Fredoka, sans-serif'; ctx.fillText('/ ' + MAX_WAVE, -M + 18 + (this.wave > 9 ? 30 : 17), cy + 10);
    for (let i = 0; i < MAX_WAVE; i++) {
      const col = i < this.wave ? '#f0c04a' : 'rgba(244,236,216,0.2)';
      ctx.fillStyle = col; ctx.beginPath(); ctx.arc(-M + 92 + (i % 10) * 9.4, cy - 6 + ((i / 10) | 0) * 11, 3, 0, TAU); ctx.fill();
    }
    // next
    let txt;
    if (this.wave >= MAX_WAVE) txt = this.queue.length ? 'Final wave incoming!' : 'Hold the line!';
    else txt = 'Next: ' + waveText(this.wave + 1);
    ctx.font = '600 19px Fredoka, sans-serif';
    const tw = ctx.measureText(txt).width, pw = Math.max(210, tw + 44), px = BW / 2 - pw / 2;
    pill(px, pw);
    ctx.textAlign = 'center'; ctx.fillStyle = ink; ctx.fillText(txt, BW / 2, cy - 2);
    if (this.wave < MAX_WAVE) {
      const f = 1 - Math.max(0, this.waveTimer) / this.waveInterval;
      ctx.fillStyle = 'rgba(244,236,216,0.18)'; roundRect(ctx, px + 22, cy + 11, pw - 44, 3, 1.5); ctx.fill();
      ctx.fillStyle = '#f0c04a'; roundRect(ctx, px + 22, cy + 11, Math.max(3, (pw - 44) * f), 3, 1.5); ctx.fill();
    }
    // right: lives + gold
    const rw = 260, rx = BW + M - rw; pill(rx, rw);
    const lb = 1 + this.livesBump * 0.25;
    ctx.save(); ctx.translate(rx + 34, cy); ctx.scale(lb, lb);
    heartIcon(ctx, 0, 0, 9, this.livesBump > 0.3 ? '#ff7a62' : '#e8584a'); ctx.restore();
    ctx.textAlign = 'left'; ctx.font = '600 24px Fredoka, sans-serif'; ctx.fillStyle = this.lives <= 6 ? '#ff9a82' : ink; ctx.fillText(String(this.lives), rx + 52, cy + 1);
    const gb = 1 + this.goldBump * 0.18;
    ctx.save(); ctx.translate(rx + 138, cy); ctx.scale(gb, gb); coinIcon(ctx, 0, 0, 10); ctx.restore();
    ctx.fillStyle = ink; ctx.font = '600 24px Fredoka, sans-serif'; ctx.fillText(String(Math.round(this.goldShown)), rx + 156, cy + 1);
    ctx.textAlign = 'center';
  }
}

Arcade.register({
  id: 'defense', name: 'Bastion Grove', genre: 'Tower defense',
  aiNote: "Sees the map, towers, enemies, gold and the next-wave preview, and places or upgrades at most one tower every 0.6 s.",
  blurb: 'Stone towers guard a winding road against wind-up beetles.',
  bg: '#2b5666', accent: '#9ed08a',
  create() { return new Game(); },
});
})();
