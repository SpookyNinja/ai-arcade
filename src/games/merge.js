// merge.js — Twenty Forty-Eight (2048). See DESIGN.md game #4.
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


const N = 4, SLIDE = 0.08, MOVE_GAP = 0.09, TIME_CAP = 900;
const PAR_SCORE = 56000;
const TWISTS = [
  { key: 'double', name: 'Double drop', desc: 'Sometimes two new tiles drop at once.' },
  { key: 'heavy', name: 'Heavy tiles', desc: 'Now and then a heavy 8 tile drops in.' },
];
// endless pressure: after a while an extra tile drops every few moves, ever more often
const PRESS_START = 700, PRESS_EVERY = m => Math.max(2, Math.round(24 - (m - PRESS_START) / 90));

// ---------------------------------------------------------------------------
// AI. Expectimax over spawn chances using the classic bitboard approach (rows packed as
// 16-bit numbers, 4 nibbles of log2). It sees ONLY the visible tile values (observe()),
// never the RNG or the future spawn. It acts through one move per 0.09 s, never while the
// slide animation is still running. Search effort is bounded by a node budget + a wall-clock
// guard, so a move never stalls a tick. Tables are built once, lazily, at first create().
// ---------------------------------------------------------------------------
const AI = (() => {
  let L = null, R = null, H = null, HW = null;
  let snake = false; // style: add snake-shaped corner weights to the heuristic
  const WSNAKE = [0, 1, 2, 3, 7, 6, 5, 4, 8, 9, 10, 11, 15, 14, 13, 12]; // snake path index per cell (row-major)
  const SC = []; for (let i = 0; i < 12; i++) SC.push(new Uint16Array(4));
  let T0 = 0, T1 = 0, T2 = 0, T3 = 0;
  // Super AI: transposition table for chance nodes (key = 4 packed rows + remaining depth, generation-tagged)
  const TT_BITS = 18, TT_MASK = (1 << TT_BITS) - 1;
  let TT = null, ttOn = false, ttGen = 0;
  function ttInit() { TT = { k: new Uint16Array(4 << TT_BITS), r: new Uint8Array(1 << TT_BITS), g: new Uint32Array(1 << TT_BITS), v: new Float64Array(1 << TT_BITS) }; }
  let limit = 3, thr = 0.0001, nodes = 0, nodeCap = 0, deadline = 0, aborted = false;

  function init() {
    if (L) return;
    HW = new Float64Array(4 * 65536);
    L = new Uint16Array(65536); R = new Uint16Array(65536); H = new Float64Array(65536);
    const P35 = [], P4 = [];
    for (let i = 0; i < 16; i++) { P35.push(Math.pow(i, 3.5)); P4.push(Math.pow(i, 4)); }
    const line = [0, 0, 0, 0];
    for (let row = 0; row < 65536; row++) {
      for (let i = 0; i < 4; i++) line[i] = (row >> (4 * i)) & 15;
      // heuristic (nneonneo): lost penalty, monotonicity, sum, merges, empties
      let sum = 0, empty = 0, merges = 0, prev = 0, counter = 0;
      for (let i = 0; i < 4; i++) {
        const rank = line[i]; sum += P35[rank];
        if (rank === 0) empty++;
        else { if (prev === rank) counter++; else if (counter > 0) { merges += 1 + counter; counter = 0; } prev = rank; }
      }
      if (counter > 0) merges += 1 + counter;
      let ml = 0, mr = 0;
      for (let i = 1; i < 4; i++) { if (line[i - 1] > line[i]) ml += P4[line[i - 1]] - P4[line[i]]; else mr += P4[line[i]] - P4[line[i - 1]]; }
      for (let y = 0; y < 4; y++) {
        let w = 0;
        for (let i = 0; i < 4; i++) w += P35[line[i]] * Math.pow(0.62, WSNAKE[y * 4 + i]);
        HW[y * 65536 + row] = 40 * w;
      }
      H[row] = 200000 + 270 * empty + 700 * merges - 47 * Math.min(ml, mr) - 11 * sum;
      // move left: slide non-zero toward index 0, merge equal neighbours once
      const out = [0, 0, 0, 0]; let w = 0, last = 0;
      for (let i = 0; i < 4; i++) {
        const v = line[i]; if (!v) continue;
        if (last && last === v) { out[w - 1] = v + 1; last = 0; } else { out[w++] = v; last = v; }
      }
      L[row] = out[0] | (out[1] << 4) | (out[2] << 8) | (out[3] << 12);
    }
    for (let row = 0; row < 65536; row++) {
      const rev = ((row & 15) << 12) | (((row >> 4) & 15) << 8) | (((row >> 8) & 15) << 4) | ((row >> 12) & 15);
      const m = L[rev];
      R[row] = ((m & 15) << 12) | (((m >> 4) & 15) << 8) | (((m >> 8) & 15) << 4) | ((m >> 12) & 15);
    }
  }
  function transpose(a, b, c, d) {
    T0 = (a & 15) | ((b & 15) << 4) | ((c & 15) << 8) | ((d & 15) << 12);
    T1 = ((a >> 4) & 15) | (((b >> 4) & 15) << 4) | (((c >> 4) & 15) << 8) | (((d >> 4) & 15) << 12);
    T2 = ((a >> 8) & 15) | (((b >> 8) & 15) << 4) | (((c >> 8) & 15) << 8) | (((d >> 8) & 15) << 12);
    T3 = ((a >> 12) & 15) | (((b >> 12) & 15) << 4) | (((c >> 12) & 15) << 8) | (((d >> 12) & 15) << 12);
  }
  function evalBoard(a, b, c, d) {
    let s = H[a] + H[b] + H[c] + H[d];
    if (snake) s += HW[a] + HW[65536 + b] + HW[131072 + c] + HW[196608 + d];
    transpose(a, b, c, d);
    return s + H[T0] + H[T1] + H[T2] + H[T3];
  }
  function chance(a, b, c, d, dep, p) {
    if (dep >= limit || p < thr) return evalBoard(a, b, c, d);
    if ((++nodes & 255) === 0 && (nodes > nodeCap || performance.now() > deadline)) aborted = true;
    if (aborted) return 0;
    let ti = 0;
    if (ttOn) {
      ti = (Math.imul(a, 0x9E3779B1) ^ Math.imul(b + 0x1234, 0x85EBCA6B) ^ Math.imul(c + 0x5678, 0xC2B2AE35) ^ Math.imul(d + 0x9ABC, 0x27D4EB2F)) >>> 0;
      ti = (ti ^ (ti >>> 15)) & TT_MASK;
      if (TT.g[ti] === ttGen && TT.r[ti] === limit - dep && TT.k[ti * 4] === a && TT.k[ti * 4 + 1] === b && TT.k[ti * 4 + 2] === c && TT.k[ti * 4 + 3] === d) return TT.v[ti];
    }
    const s = SC[dep];
    s[0] = a; s[1] = b; s[2] = c; s[3] = d;
    let empt = 0;
    for (let y = 0; y < 4; y++) { const r = s[y]; if (!(r & 15)) empt++; if (!(r & 0xF0)) empt++; if (!(r & 0xF00)) empt++; if (!(r & 0xF000)) empt++; }
    if (!empt) return evalBoard(a, b, c, d);
    const pp = p / empt;
    let res = 0;
    for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) {
      const sh = 4 * x;
      if ((s[y] >> sh) & 15) continue;
      s[y] |= 1 << sh;  res += 0.9 * maxNode(s[0], s[1], s[2], s[3], dep, pp * 0.9);
      s[y] ^= 3 << sh;  res += 0.1 * maxNode(s[0], s[1], s[2], s[3], dep, pp * 0.1);   // 1 -> 2 (log2 of 4)
      s[y] &= ~(15 << sh);
    }
    res /= empt;
    if (ttOn && !aborted) { TT.g[ti] = ttGen; TT.r[ti] = limit - dep; TT.k[ti * 4] = a; TT.k[ti * 4 + 1] = b; TT.k[ti * 4 + 2] = c; TT.k[ti * 4 + 3] = d; TT.v[ti] = res; }
    return res;
  }
  function maxNode(a, b, c, d, dep, p) {
    let best = 0, v, n0, n1, n2, n3;
    n0 = L[a]; n1 = L[b]; n2 = L[c]; n3 = L[d];
    if (n0 !== a || n1 !== b || n2 !== c || n3 !== d) { v = chance(n0, n1, n2, n3, dep + 1, p); if (v > best) best = v; }
    n0 = R[a]; n1 = R[b]; n2 = R[c]; n3 = R[d];
    if (n0 !== a || n1 !== b || n2 !== c || n3 !== d) { v = chance(n0, n1, n2, n3, dep + 1, p); if (v > best) best = v; }
    transpose(a, b, c, d); const t0 = T0, t1 = T1, t2 = T2, t3 = T3;
    transpose(L[t0], L[t1], L[t2], L[t3]);
    n0 = T0; n1 = T1; n2 = T2; n3 = T3;
    if (n0 !== a || n1 !== b || n2 !== c || n3 !== d) { v = chance(n0, n1, n2, n3, dep + 1, p); if (v > best) best = v; }
    transpose(R[t0], R[t1], R[t2], R[t3]);
    n0 = T0; n1 = T1; n2 = T2; n3 = T3;
    if (n0 !== a || n1 !== b || n2 !== c || n3 !== d) { v = chance(n0, n1, n2, n3, dep + 1, p); if (v > best) best = v; }
    return best;
  }
  // dir: 0 left, 1 right, 2 up, 3 down -> [value or -1 if illegal] evaluated at the current `limit`
  function rootValue(rows, dir) {
    const a = rows[0], b = rows[1], c = rows[2], d = rows[3];
    let n0, n1, n2, n3;
    if (dir === 0) { n0 = L[a]; n1 = L[b]; n2 = L[c]; n3 = L[d]; }
    else if (dir === 1) { n0 = R[a]; n1 = R[b]; n2 = R[c]; n3 = R[d]; }
    else { transpose(a, b, c, d); const M = dir === 2 ? L : R; transpose(M[T0], M[T1], M[T2], M[T3]); n0 = T0; n1 = T1; n2 = T2; n3 = T3; }
    if (n0 === a && n1 === b && n2 === c && n3 === d) return -1;
    return chance(n0, n1, n2, n3, 1, 1);
  }
  const TUNE = { nodeCap: 400000, ms: 24, supMs: 16 };
  let worst = 0;
  // vals: 16 visible tile values (0 = empty). Returns direction 0..3 or -1.
  // setStyle(snake, sym): sym = {fh, fv, tr} - the board is mirrored/transposed so the favoured corner is top-left
  let SYM = { fh: false, fv: false, tr: false }, SUP = false;
  function setStyle(sn, sym, sup) { snake = sn; SYM = sym; SUP = !!sup; if (SUP && !TT) ttInit(); }
  function toInner(vals) {
    const o = new Array(16);
    for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) {
      let ox = x, oy = y; // inner (x,y) <- original
      if (SYM.fh) ox = 3 - ox; if (SYM.fv) oy = 3 - oy; if (SYM.tr) { const t = ox; ox = oy; oy = t; }
      o[y * 4 + x] = vals[oy * 4 + ox];
    }
    return o;
  }
  function dirBack(d) {
    let vx = d === 0 ? -1 : d === 1 ? 1 : 0, vy = d === 2 ? -1 : d === 3 ? 1 : 0;
    if (SYM.fh) vx = -vx; if (SYM.fv) vy = -vy;
    if (SYM.tr) { const t = vx; vx = vy; vy = t; }
    return vx < 0 ? 0 : vx > 0 ? 1 : vy < 0 ? 2 : 3;
  }
  function choose(vals0) {
    init();
    const vals = toInner(vals0);
    const d = chooseInner(vals);
    return d < 0 ? -1 : dirBack(d);
  }
  function chooseInner(vals) {
    const rows = [0, 0, 0, 0];
    for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) { const v = vals[y * 4 + x]; if (v) rows[y] |= Math.round(Math.log2(v)) << (4 * x); }
    let best = -1, empt = 0;
    for (const v of vals) if (!v) empt++;
    const t0 = performance.now();
    const maxLim = SUP ? (empt >= 8 ? 3 : empt >= 5 ? 4 : empt >= 3 ? 5 : 6) : empt >= 6 ? 2 : empt >= 3 ? 3 : 4;   // adaptive depth
    ttOn = SUP; ttGen++; thr = SUP ? 0.00002 : 0.0001;
    for (let lim = 2; lim <= maxLim; lim++) {
      limit = lim; nodes = 0; aborted = false; nodeCap = SUP ? 1e9 : lim <= 2 ? 1e9 : TUNE.nodeCap; deadline = t0 + (SUP ? TUNE.supMs : TUNE.ms);
      let bv = -1, bd = -1;
      for (let dir = 0; dir < 4; dir++) {
        const v = rootValue(rows, dir);
        if (aborted) break;
        if (v >= 0 && (bd < 0 || v > bv)) { bv = v; bd = dir; }
      }
      if (aborted) break;
      if (bd >= 0) best = bd;
      if (bd < 0) break;
    }
    ttOn = false;
    worst = Math.max(worst, performance.now() - t0);
    return best;
  }
  return { init, choose, setStyle, TUNE, get worst() { return worst; } };
})();

// ---------------------------------------------------------------------------
// Look
// ---------------------------------------------------------------------------
// hue, sat, light, dark text?
const RAMP = [
  null,
  [268, 30, 76, 1], [292, 36, 73, 1], [10, 88, 63, 0], [4, 82, 60, 0], [352, 76, 58, 0], [24, 96, 58, 0],
  [38, 96, 57, 1], [47, 96, 56, 1], [68, 74, 55, 1], [152, 62, 56, 1], [186, 92, 60, 1],
  [330, 88, 66, 1], [250, 82, 72, 1], [310, 80, 70, 1],
];
const rampFor = v => RAMP[Math.min(RAMP.length - 1, Math.round(Math.log2(v)))];
const INK = '#2b1533';
const GLOWS = {};
function glowSprite(hue, sat = 85, l = 62) {
  const k = hue + '_' + sat + '_' + l;
  if (GLOWS[k]) return GLOWS[k];
  const cv = document.createElement('canvas'); cv.width = cv.height = 128;
  const g = cv.getContext('2d'), gr = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  gr.addColorStop(0, `hsla(${hue},${sat}%,${l}%,0.85)`); gr.addColorStop(0.4, `hsla(${hue},${sat}%,${l}%,0.28)`); gr.addColorStop(1, `hsla(${hue},${sat}%,${l}%,0)`);
  g.fillStyle = gr; g.fillRect(0, 0, 128, 128);
  return (GLOWS[k] = cv);
}
const fmt = n => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');

function create(opts = {}) {
  AI.init();
  const sym = { fh: Math.random() < 0.5, fv: Math.random() < 0.5, tr: Math.random() < 0.5 };
  const snakeStyle = opts.superAI ? true : Math.random() < 0.5;
  AI.setStyle(snakeStyle, sym, !!opts.superAI);
  const cx = sym.tr ? sym.fv : sym.fh, cy = sym.tr ? sym.fh : sym.fv; // corner after flip-then-swap
  const CORNER = cx ? 'right' : 'left', CORNERV = cy ? 'bottom' : 'top';
  const styleName = opts.superAI ? 'Super AI' : snakeStyle ? `Corner snake (${CORNERV}-${CORNER})` : 'Free merger';
  let twist = null;
  if (opts.twist) twist = (typeof opts.twist === 'string' && TWISTS.find(t => t.key === opts.twist)) || rnd.pick(TWISTS);
  const parts = new Particles();
  const inst = {
    twist, best0: opts.best, sinceExtra: 0, pressure: false,
    over: false, won: false, superAI: !!opts.superAI, style: styleName, t: 0, W: 800, H: 600, L: null,
    grid: new Array(16).fill(null), ghosts: [], tid: 0,
    score: 0, moves: 0, best: 2, moveT: -9, lastMove: -9, floaters: [],
    shake: 0, endT: 0, msg: '', winT: 0, deadT: 0,
  };
  const dust = [];
  for (let i = 0; i < 46; i++) dust.push({ u: Math.random(), v: Math.random(), s: 0.6 + Math.random() * 1.8, sp: 0.004 + Math.random() * 0.012, ph: Math.random() * 6.28, h: [300, 330, 20, 190, 45][i % 5] });
  const blobs = [[300, 0.2, 0.25, 0.5], [330, 0.85, 0.2, 0.4], [190, 0.15, 0.85, 0.45], [20, 0.9, 0.85, 0.5], [270, 0.5, 0.5, 0.7]];

  function mk(v, x, y, born) { return { id: ++inst.tid, v, x, y, fx: x, fy: y, born, kind: 'spawn' }; }
  function emptyCells() { const r = []; for (let i = 0; i < 16; i++) if (!inst.grid[i]) r.push(i); return r; }
  function spawn(born, flag) {
    const e = emptyCells(); if (!e.length) return;
    let v = Math.random() < 0.9 ? 2 : 4;
    if (twist && twist.key === 'heavy' && inst.moves > 6 && !flag && Math.random() < 0.025) { v = 8; flag = 'heavy'; }
    const i = rnd.pick(e);
    const t = mk(v, i % 4, i >> 2, born); if (flag) t.flag = flag;
    inst.grid[i] = t;
    if (flag && inst.L) {
      const [px, py] = cellRect(t.x, t.y);
      inst.floaters.push({ txt: flag === 'heavy' ? 'HEAVY' : flag === 'extra' ? 'EXTRA' : 'DOUBLE', x: px + inst.L.cell / 2, y: py + inst.L.cell * 0.1, t: 0, hot: true });
    }
  }
  function canMove() {
    for (let i = 0; i < 16; i++) {
      const t = inst.grid[i]; if (!t) return true;
      if ((i & 3) < 3 && inst.grid[i + 1] && inst.grid[i + 1].v === t.v) return true;
      if (i < 12 && inst.grid[i + 4] && inst.grid[i + 4].v === t.v) return true;
    }
    return false;
  }
  function cellRect(x, y) {
    const L = inst.L; return [L.bx + L.pad + x * (L.cell + L.pad), L.by + L.pad + y * (L.cell + L.pad)];
  }
  // dir: 0 left 1 right 2 up 3 down. Returns true if anything moved.
  function doMove(dir) {
    const g = inst.grid, ng = new Array(16).fill(null), ghosts = [];
    let moved = false, gain = 0, bigMerge = null;
    for (let k = 0; k < 4; k++) {
      const pos = [];
      for (let i = 0; i < 4; i++) {
        if (dir === 0) pos.push([i, k]); else if (dir === 1) pos.push([3 - i, k]);
        else if (dir === 2) pos.push([k, i]); else pos.push([k, 3 - i]);
      }
      const tiles = pos.map(([x, y]) => g[y * 4 + x]).filter(Boolean);
      let w = 0;
      for (let i = 0; i < tiles.length; i++) {
        const [tx, ty] = pos[w];
        if (i + 1 < tiles.length && tiles[i].v === tiles[i + 1].v) {
          const A = tiles[i], B = tiles[i + 1], v = A.v * 2;
          for (const s of [A, B]) { s.fx = s.x; s.fy = s.y; s.x = tx; s.y = ty; ghosts.push(s); }
          const m = mk(v, tx, ty, inst.t + SLIDE); m.kind = 'merge'; ng[ty * 4 + tx] = m;
          gain += v; if (!bigMerge || v > bigMerge.v) bigMerge = m;
          if (v > inst.best) inst.best = v;
          moved = true; i++;
        } else {
          const t = tiles[i];
          if (t.x !== tx || t.y !== ty) moved = true;
          t.fx = t.x; t.fy = t.y; t.x = tx; t.y = ty; t.kind = 'none'; ng[ty * 4 + tx] = t;
        }
        w++;
      }
    }
    if (!moved) return false;
    inst.grid = ng; inst.ghosts = ghosts; inst.moveT = inst.t; inst.moves++;
    inst.score += gain;
    spawn(inst.t + SLIDE * 0.75);
    if (twist && twist.key === 'double' && inst.moves > 6 && Math.random() < 0.06) spawn(inst.t + SLIDE * 0.9, 'double');
    if (inst.moves >= PRESS_START && ++inst.sinceExtra >= PRESS_EVERY(inst.moves)) { inst.sinceExtra = 0; inst.pressure = true; spawn(inst.t + SLIDE * 0.9, 'extra'); }
    if (gain >= 8) {
      const [px, py] = cellRect(bigMerge.x, bigMerge.y), L = inst.L;
      inst.floaters.push({ txt: '+' + gain, x: px + L.cell / 2, y: py + L.cell * 0.05, t: 0 });
      if (bigMerge && bigMerge.v >= 64) {
        const rp = rampFor(bigMerge.v), n = bigMerge.v >= 512 ? 26 : bigMerge.v >= 128 ? 16 : 9;
        inst._pend = inst._pend || [];
        inst._pend.push({ at: inst.t + SLIDE, x: px + L.cell / 2, y: py + L.cell / 2, n, hue: rp[0], v: bigMerge.v });
      }
    }
    return true;
  }
  function observe() {   // exactly what is visible: the tile values on the board
    return inst.grid.map(t => (t ? t.v : 0));
  }

  inst.resize = (W, H) => {
    inst.W = W; inst.H = H;
    let S = Math.floor(Math.min(W * 0.88, H * 0.88 / 1.27));
    let header = S * 0.15, gap = S * 0.05, foot = S * 0.09, total = header + gap + S + foot;
    let top = (H - total) / 2;
    if ((W - S) / 2 < 370 && top + total > H - 104) { // keep clear of the shell HUD box (bottom-left)
      S = Math.floor(Math.min(S, (H - 104 - H * 0.03) / 1.29));
      header = S * 0.15; gap = S * 0.05; foot = S * 0.09; total = header + gap + S + foot;
      top = (H * 0.03 + H - 104 - total) / 2;
    }
    const bx = Math.round((W - S) / 2), by = Math.round(top + header + gap);
    const pad = S * 0.028, cell = (S - 5 * pad) / 4;
    inst.L = { S, bx, by, pad, cell, header, top, foot, hy: top };
  };

  const ipg = () => [[[inst], ['t'], 0, 't']];
  inst.step = dt => {
    inst.t += dt;
    parts.update(dt);
    inst.shake *= Math.exp(-dt * 8);
    for (const f of inst.floaters) f.t += dt;
    inst.floaters = inst.floaters.filter(f => f.t < 1.3);
    if (inst.ghosts.length && inst.t - inst.moveT >= SLIDE) inst.ghosts = [];
    if (inst._pend) {
      for (let i = inst._pend.length - 1; i >= 0; i--) {
        const p = inst._pend[i];
        if (inst.t >= p.at) {
          const c = [`hsl(${p.hue},95%,72%)`, '#fff', `hsl(${p.hue + 30},95%,70%)`];
          parts.burst(p.x, p.y, p.n, { speed: 120 + p.n * 6, life: 0.9, size: inst.L.cell * 0.07, gravity: 160, color: c });
          inst.shake = Math.max(inst.shake, Math.min(1, p.v / 1024));
          inst._pend.splice(i, 1);
        }
      }
    }
    if (inst.over) {
      inst.endT += dt;
      if (inst.won && inst.t >= inst.winT) {
        // confetti fountain around the board
        if (Math.random() < 0.45) {
          const L = inst.L, side = Math.random() < 0.5 ? 0 : 1;
          parts.burst(L.bx + side * L.S, L.by + L.S * 0.9, 6, { angle: -Math.PI / 2 + (side ? -0.35 : 0.35), spread: 0.35, speedMin: 400, speed: 900, life: 1.8, size: L.cell * 0.07, gravity: 700, drag: 0.5, color: ['#9ff4ff', '#ffd36e', '#ff8a7a', '#c9a3e0', '#8ff0b4', '#fff'] });
        }
      }
      if (!inst.won) inst.deadT += dt;
      return;
    }
    if (inst.t > TIME_CAP) { inst.over = true; inst.won = false; inst.msg = 'Out of time'; return; }
    // ---- the AI: one move per 0.09 s, never during the slide animation
    if (inst.t - inst.lastMove >= Math.max(MOVE_GAP, SLIDE + 0.01) && inst.t > 0.4) {
      const dir = AI.choose(observe());
      if (dir >= 0) { inst.lastMove = inst.t; doMove(dir); }
      if (!canMove()) {
        inst.over = true; inst.won = false; inst.endT = 0;
        inst.msg = `No moves left, best tile ${inst.best} · score ${fmt(inst.score)}`;
        inst.shake = 1;
      }
    }
  };

  // ---------------------------------------------------------------- drawing
  function drawBg(ctx, W, H) {
    staticLayer(ctx, 'bg', W, H, (x, W, H) => {
      const g = x.createRadialGradient(W / 2, H * 0.45, 0, W / 2, H * 0.5, Math.max(W, H) * 0.75);
      g.addColorStop(0, '#2a1635'); g.addColorStop(1, '#150a1d');
      x.fillStyle = g; x.fillRect(0, 0, W, H);
    });
    ctx.save(); ctx.globalCompositeOperation = 'lighter';
    const m = Math.max(W, H);
    blobs.forEach(([h, u, v, s], i) => {
      const x = (u + Math.sin(inst.t * 0.05 + i * 2) * 0.07) * W, y = (v + Math.cos(inst.t * 0.04 + i * 3) * 0.07) * H, r = s * m * 0.5;
      ctx.globalAlpha = 0.10; ctx.drawImage(glowSprite(h, 70, 50), x - r, y - r, r * 2, r * 2);
    });
    ctx.restore();
    for (const d of dust) {
      const y = ((d.v - inst.t * d.sp) % 1 + 1) % 1, x = d.u + Math.sin(inst.t * 0.3 + d.ph) * 0.01;
      ctx.fillStyle = `hsla(${d.h},60%,75%,${0.07 + 0.07 * Math.sin(inst.t + d.ph)})`;
      ctx.beginPath(); ctx.arc(x * W, y * H, d.s * Math.max(1, m / 1100), 0, TAU); ctx.fill();
    }
    staticLayer(ctx, 'vg', W, H, (x, W, H) => {
      const vg = x.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.35, W / 2, H / 2, Math.max(W, H) * 0.78);
      vg.addColorStop(0, 'rgba(10,3,16,0)'); vg.addColorStop(1, 'rgba(10,3,16,0.6)');
      x.fillStyle = vg; x.fillRect(0, 0, W, H);
    });
  }
  function drawTile(ctx, v, x, y, size, scale, alpha, gray) {
    const rp = rampFor(v), L = inst.L, s = size * scale, cx = x + size / 2, cy = y + size / 2;
    const px = cx - s / 2, py = cy - s / 2;
    ctx.save();
    ctx.globalAlpha = alpha;
    if (v >= 1024) {
      const gs = v >= 4096 ? 1.7 : v >= 2048 ? 1.35 : 1.1, ga = v >= 4096 ? 0.95 : v >= 2048 ? 0.7 : 0.55;
      const pulse = 0.75 + 0.25 * Math.sin(inst.t * 2.4);
      ctx.globalCompositeOperation = 'lighter'; ctx.globalAlpha = alpha * ga * pulse;
      ctx.drawImage(glowSprite(rp[0], 90, 60), cx - s * gs, cy - s * gs, s * 2 * gs, s * 2 * gs);
      ctx.globalCompositeOperation = 'source-over'; ctx.globalAlpha = alpha;
    }
    const sat = gray ? rp[1] * (1 - gray * 0.85) : rp[1];
    const lt = gray ? rp[2] * (1 - gray * 0.35) : rp[2];
    const grd = ctx.createLinearGradient(0, py, 0, py + s);
    grd.addColorStop(0, `hsl(${rp[0]},${sat}%,${Math.min(92, lt + 7)}%)`);
    grd.addColorStop(1, `hsl(${rp[0]},${sat}%,${Math.max(10, lt - 9)}%)`);
    // soft drop shadow
    ctx.fillStyle = 'rgba(8,2,14,0.28)'; roundRect(ctx, px, py + s * 0.04, s, s, s * 0.13); ctx.fill();
    ctx.fillStyle = grd; roundRect(ctx, px, py, s, s, s * 0.13); ctx.fill();
    ctx.save(); roundRect(ctx, px, py, s, s, s * 0.13); ctx.clip();
    const sh = ctx.createLinearGradient(px, py, px + s * 0.7, py + s * 0.9);
    sh.addColorStop(0, 'rgba(255,255,255,0.26)'); sh.addColorStop(0.5, 'rgba(255,255,255,0.03)'); sh.addColorStop(1, 'rgba(0,0,0,0.08)');
    ctx.fillStyle = sh; ctx.fillRect(px, py, s, s);
    ctx.lineWidth = Math.max(1, s * 0.03); ctx.strokeStyle = 'rgba(255,255,255,0.38)';
    ctx.beginPath(); ctx.moveTo(px + s * 0.12, py + ctx.lineWidth); ctx.lineTo(px + s * 0.88, py + ctx.lineWidth); ctx.stroke();
    ctx.restore();
    const str = String(v), len = str.length;
    const fs = s * (len <= 1 ? 0.56 : len === 2 ? 0.5 : len === 3 ? 0.42 : 0.33);
    ctx.font = `600 ${fs}px Fredoka, "Trebuchet MS", sans-serif`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillStyle = rp[3] ? INK : '#fff8f2';
    if (!rp[3]) { ctx.shadowColor = 'rgba(40,5,25,0.35)'; ctx.shadowBlur = 0; ctx.shadowOffsetY = s * 0.015; }
    ctx.fillText(str, cx, cy + s * 0.035);
    ctx.restore();
  }
  const drawRaw = (ctx, W, H) => {
    if (!inst.L) inst.resize(W, H);
    const L = inst.L;
    drawBg(ctx, W, H);
    ctx.save();
    if (inst.shake > 0.01) ctx.translate(Math.sin(inst.t * 90) * inst.shake * L.S * 0.006, Math.cos(inst.t * 77) * inst.shake * L.S * 0.006);
    // header stats
    const hh = L.header, hw = (L.S - L.S * 0.04) / 3;
    const stats = [['SCORE', fmt(inst.score)], ['MOVES', String(inst.moves)], ['BEST TILE', String(inst.best)]];
    stats.forEach(([k, v], i) => {
      const x = L.bx + i * (hw + L.S * 0.02), y = L.hy;
      roundRect(ctx, x, y, hw, hh, hh * 0.28); ctx.fillStyle = 'rgba(255,255,255,0.06)'; ctx.fill();
      ctx.lineWidth = 1; ctx.strokeStyle = 'rgba(255,255,255,0.08)'; ctx.stroke();
      ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
      ctx.font = `600 ${hh * 0.22}px Fredoka, sans-serif`; ctx.fillStyle = 'rgba(214,190,230,0.65)';
      ctx.fillText(k.split('').join(' '), x + hw / 2, y + hh * 0.35);
      ctx.font = `600 ${hh * 0.42}px "IBM Plex Mono", monospace`; ctx.fillStyle = '#fbeeff';
      ctx.fillText(v, x + hw / 2, y + hh * 0.8);
    });
    // board slab
    const slabR = L.S * 0.035;
    for (let i = 3; i >= 1; i--) { roundRect(ctx, L.bx - i * 3, L.by - i * 2 + L.S * 0.02 + i * 3, L.S + i * 6, L.S + i * 4, slabR + i * 2); ctx.fillStyle = `rgba(6,1,12,${0.12})`; ctx.fill(); }
    roundRect(ctx, L.bx, L.by, L.S, L.S, slabR);
    const sg = ctx.createLinearGradient(0, L.by, 0, L.by + L.S);
    sg.addColorStop(0, '#3a2148'); sg.addColorStop(1, '#2a1636');
    ctx.fillStyle = sg; ctx.fill();
    ctx.lineWidth = 1.5; ctx.strokeStyle = 'rgba(255,220,255,0.14)'; ctx.stroke();
    for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) {
      const [px, py] = cellRect(x, y);
      roundRect(ctx, px, py, L.cell, L.cell, L.cell * 0.13);
      const cg = ctx.createLinearGradient(0, py, 0, py + L.cell);
      cg.addColorStop(0, 'rgba(10,3,16,0.62)'); cg.addColorStop(1, 'rgba(10,3,16,0.38)');
      ctx.fillStyle = cg; ctx.fill();
    }
    // tiles
    const prog = clamp((inst.t - inst.moveT) / SLIDE, 0, 1), sp = ease.outCubic(prog);
    const gray = inst.over && !inst.won ? clamp(inst.deadT / 1.2, 0, 1) : 0;
    const slide = (t) => {
      const [ax, ay] = cellRect(t.fx, t.fy), [bx, by] = cellRect(t.x, t.y);
      return [lerp(ax, bx, sp), lerp(ay, by, sp)];
    };
    for (const t of inst.ghosts) { const [x, y] = slide(t); drawTile(ctx, t.v, x, y, L.cell, 1, 1, gray); }
    const lift = [];
    for (const t of inst.grid) {
      if (!t) continue;
      const age = inst.t - t.born;
      if (age < 0) continue;
      if (t.kind === 'spawn') {
        const u = clamp(age / 0.22, 0, 1), [x, y] = cellRect(t.x, t.y);
        drawTile(ctx, t.v, x, y, L.cell, Math.max(0.001, ease.outBack(u)), Math.min(1, u * 3), gray);
        if (t.flag && age < 0.7) {   // twist / pressure drops flare red-orange
          const k = age / 0.7;
          ctx.save(); ctx.globalCompositeOperation = 'lighter'; ctx.lineWidth = L.cell * 0.06; ctx.strokeStyle = `rgba(255,110,70,${0.9 * (1 - k)})`;
          roundRect(ctx, x - k * L.cell * 0.25, y - k * L.cell * 0.25, L.cell * (1 + k * 0.5), L.cell * (1 + k * 0.5), L.cell * 0.2); ctx.stroke(); ctx.restore();
        }
      } else if (t.kind === 'merge') {
        const u = clamp(age / 0.26, 0, 1), [x, y] = cellRect(t.x, t.y);
        const sc = 1 + 0.18 * Math.sin(Math.PI * Math.pow(u, 0.7)) * (u < 1 ? 1 : 0);
                drawTile(ctx, t.v, x, y, L.cell, sc, 1, gray);
        if (u < 1) {            // expanding ring
          ctx.save(); ctx.globalCompositeOperation = 'lighter'; ctx.lineWidth = L.cell * 0.04;
          ctx.strokeStyle = `rgba(255,255,255,${0.5 * (1 - u)})`;
          roundRect(ctx, x - u * L.cell * 0.2, y - u * L.cell * 0.2, L.cell * (1 + u * 0.4), L.cell * (1 + u * 0.4), L.cell * 0.2); ctx.stroke(); ctx.restore();
        }
      } else {
        const [x, y] = t.fx === t.x && t.fy === t.y ? cellRect(t.x, t.y) : slide(t);
        drawTile(ctx, t.v, x, y, L.cell, 1, 1, gray);
      }
    }
    // progress pips (2 .. 4096)
    const py = L.by + L.S + L.foot * 0.55, pr = L.S * 0.012, step = L.S * 0.05, x0 = L.bx + L.S / 2 - step * 5.5;
    for (let i = 1; i <= 12; i++) {
      const rp = RAMP[i], on = Math.log2(inst.best) >= i, x = x0 + (i - 1) * step;
      ctx.beginPath(); ctx.arc(x, py, pr * (on ? 1.15 : 0.8), 0, TAU);
      ctx.fillStyle = on ? `hsl(${rp[0]},${rp[1]}%,${rp[2]}%)` : 'rgba(255,255,255,0.14)'; ctx.fill();
    }
    // loss dim
    if (inst.over && !inst.won) { ctx.fillStyle = `rgba(20,6,26,${0.35 * gray})`; roundRect(ctx, L.bx, L.by, L.S, L.S, slabR); ctx.fill(); }
    // win glow
    if (inst.won && inst.t >= inst.winT) {
      const a = Math.min(1, (inst.t - inst.winT) / 0.6);
      ctx.save(); ctx.globalCompositeOperation = 'lighter'; ctx.globalAlpha = a * (0.3 + 0.1 * Math.sin(inst.t * 3));
      ctx.drawImage(glowSprite(330, 90, 62), L.bx - L.S * 0.3, L.by - L.S * 0.3, L.S * 1.6, L.S * 1.6); ctx.restore();
    }
    // floaters
    for (const f of inst.floaters) {
      const u = f.t / 1.3, a = u < 0.12 ? u / 0.12 : 1 - Math.max(0, (u - 0.45) / 0.55);
      ctx.globalAlpha = Math.max(0, a); ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.font = `600 ${L.cell * 0.26}px Fredoka, sans-serif`;
      const fy = f.y - ease.outCubic(Math.min(1, f.t / 0.9)) * L.cell * 0.38;
      ctx.lineJoin = 'round'; ctx.lineWidth = L.cell * 0.07; ctx.strokeStyle = 'rgba(40,10,50,0.75)'; ctx.strokeText(f.txt, f.x, fy);
      ctx.fillStyle = f.hot ? '#ff9a6e' : '#fff4c8'; ctx.fillText(f.txt, f.x, fy);
    }
    ctx.globalAlpha = 1;
    parts.draw(ctx, Math.max(0.7, L.cell / 100));
    ctx.restore();
  };

  inst.draw = (ctx, W, H) => { const a = IP.alpha(), st = IP.push(ipg(), a); try { return drawRaw(ctx, W, H); } finally { IP.pop(st); } };
  inst.hud = () => ({ score: fmt(inst.score), detail: `Best tile ${inst.best} · ${inst.moves} moves` });
  inst.result = () => (inst.msg || `No moves left, best tile ${inst.best}`) + ` (${styleName})`;
  spawn(0.1); spawn(0.25);
  return inst;
}

Arcade.register({
  id: 'merge', name: 'Twenty Forty-Eight', genre: 'Sliding tiles',
  aiNote: "Sees only the visible tile values, never the next spawn; searches ahead with expectimax but makes one slide per 0.09 s.",
  blurb: 'Slide, merge, and chase ever bigger tiles until the board fills.',
  bg: '#1d1026', accent: '#ff8a7a', endless: true, parScore: PAR_SCORE, twists: TWISTS, create,
});
})();
