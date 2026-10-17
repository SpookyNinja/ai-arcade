(() => {
'use strict';
// =====================================================================================
// Pearl & Jade — Reversi, Autopilot vs. a house engine.
// A celadon-jade board with pale-gold hairlines on an ink-blue night table, lit by a warm
// paper lamp; discs are mother-of-pearl and onyx and flip like tossed coins.
// Sections: 1) rules + move generation  2) evaluation + time-sliced alpha-beta "Brain"
//           3) configs (styles, house)  4) the game (state, animation, drawing)
// =====================================================================================

// ------------------------------------------------------------------ 1. rules
// 10x10 padded board: 0 empty, 1 onyx (moves first), 2 pearl, 3 border sentinel.
const DIRS = [-11, -10, -9, -1, 1, 9, 10, 11];
const SQS = []; for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) SQS.push((r + 1) * 10 + c + 1);
const CORNERS = [11, 18, 81, 88];
const CADJ = [[12, 21, 22], [17, 28, 27], [71, 82, 72], [78, 87, 77]];       // C, C, X squares per corner
const CEDGE = [[1, 10], [-1, 10], [1, -10], [-1, -10]];                      // edge directions from each corner
const PWT = [
  100, -22, 10, 5, 5, 10, -22, 100,
  -22, -55, -2, -2, -2, -2, -55, -22,
  10, -2, 4, 1, 1, 4, -2, 10,
  5, -2, 1, 0, 0, 1, -2, 5,
  5, -2, 1, 0, 0, 1, -2, 5,
  10, -2, 4, 1, 1, 4, -2, 10,
  -22, -55, -2, -2, -2, -2, -55, -22,
  100, -22, 10, 5, 5, 10, -22, 100,
];
const PW = new Int16Array(100);
for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) PW[(r + 1) * 10 + c + 1] = PWT[r * 8 + c];
const initBoard = () => {
  const b = new Int8Array(100).fill(3);
  for (const s of SQS) b[s] = 0;
  b[44] = 2; b[55] = 2; b[45] = 1; b[54] = 1;
  return b;
};
const sqName = s => 'abcdefgh'[s % 10 - 1] + (Math.floor(s / 10));
const rowOf = s => Math.floor(s / 10) - 1, colOf = s => s % 10 - 1;

function gen(b, me, out) {
  const op = 3 - me; let n = 0;
  for (let i = 0; i < 64; i++) {
    const s = SQS[i]; if (b[s] !== 0) continue;
    for (let d = 0; d < 8; d++) {
      const dd = DIRS[d]; let p = s + dd;
      if (b[p] !== op) continue;
      p += dd; while (b[p] === op) p += dd;
      if (b[p] === me) { out[n++] = s; break; }
    }
  }
  return n;
}
function countMoves(b, me) {
  const op = 3 - me; let n = 0;
  for (let i = 0; i < 64; i++) {
    const s = SQS[i]; if (b[s] !== 0) continue;
    for (let d = 0; d < 8; d++) {
      const dd = DIRS[d]; let p = s + dd;
      if (b[p] !== op) continue;
      p += dd; while (b[p] === op) p += dd;
      if (b[p] === me) { n++; break; }
    }
  }
  return n;
}
function make(src, dst, s, me) {
  dst.set(src); const op = 3 - me; dst[s] = me; let f = 0;
  for (let d = 0; d < 8; d++) {
    const dd = DIRS[d]; let p = s + dd;
    if (dst[p] !== op) continue;
    do p += dd; while (dst[p] === op);
    if (dst[p] === me) { p -= dd; while (p !== s) { dst[p] = me; f++; p -= dd; } }
  }
  return f;
}
function flipList(b, s, me) {
  const op = 3 - me, out = [];
  for (let d = 0; d < 8; d++) {
    const dd = DIRS[d]; let p = s + dd;
    if (b[p] !== op) continue;
    do p += dd; while (b[p] === op);
    if (b[p] === me) { p -= dd; while (p !== s) { out.push(p); p -= dd; } }
  }
  return out;
}
const countDiscs = (b, who) => { let n = 0; for (let i = 0; i < 64; i++) if (b[SQS[i]] === who) n++; return n; };

// ------------------------------------------------------------------ 2. evaluation + search
function evaluate(b, me, emp, cfg) {
  const op = 3 - me;
  let pos = 0, mine = 0, theirs = 0, front = 0, cm = 0, xs = 0, stab = 0;
  for (let i = 0; i < 64; i++) {
    const s = SQS[i], v = b[s]; if (!v) continue;
    const sg = v === me ? 1 : -1;
    pos += sg * PW[s];
    if (sg > 0) mine++; else theirs++;
    for (let d = 0; d < 8; d++) if (b[s + DIRS[d]] === 0) { front += sg; break; }
  }
  for (let k = 0; k < 4; k++) {
    const c = CORNERS[k], v = b[c];
    if (v) {
      const sg = v === me ? 1 : -1; cm += sg;
      for (let a = 0; a < 3; a++) { const va = b[CADJ[k][a]]; if (va) { pos -= (va === me ? 1 : -1) * PW[CADJ[k][a]]; if (va === v) pos += sg * 8; } }
      for (let e = 0; e < 2; e++) { const dd = CEDGE[k][e]; let p = c; while (b[p] === v) { stab += sg; p += dd; } }
    } else {
      for (let a = 0; a < 3; a++) { const va = b[CADJ[k][a]]; if (va) xs += va === me ? 1 : -1; }
    }
  }
  const mm = countMoves(b, me), om = countMoves(b, op);
  let mob = 100 * (mm - om) / (mm + om + 1);
  if (om === 0 && mm > 0) mob += 70;
  if (mm === 0 && om > 0) mob -= 70;
  const late = Math.max(0, 30 - emp) / 30;
  const early = emp > 34 ? 1 : 0;
  return cfg.pos * pos + cfg.mob * mob + cfg.corner * cm * 110 + cfg.x * xs * -12 - cfg.front * front * 6 + cfg.stab * stab * 14
    + (mine - theirs) * (cfg.disc * late * late * 45 + cfg.discEarly * early * 3) + (cfg.noise ? (Math.random() - 0.5) * cfg.noise : 0);
}

const MAXPLY = 70;
const bufs = Array.from({ length: MAXPLY + 2 }, () => new Int8Array(100));
const mvs = Array.from({ length: MAXPLY + 2 }, () => new Uint8Array(40));

// The Brain only ever receives an observe() snapshot (board + side to move), like a spectator who can see the board.
class Brain {
  constructor(cfg) { this.cfg = cfg; this.done = true; this.active = false; this.nodes = 0; this.depthDone = 0; this.bestMove = 0; this.result = null; }
  start(snap, me) {
    const cfg = this.cfg;
    this.root = snap.b.slice(); this.me = me; this.active = true; this.done = false; this.nodes = 0; this.depthDone = 0; this.bestMove = 0; this.result = null;
    const mv = new Uint8Array(40), n = gen(this.root, me, mv);
    this.moves = Array.from(mv.subarray(0, n)).sort((a, b) => PW[b] - PW[a] + (Math.random() - 0.5));
    this.scores = this.moves.map(() => -1e9);
    this.emp = 0; for (let i = 0; i < 64; i++) if (this.root[SQS[i]] === 0) this.emp++;
    this.discs = 64 - this.emp;
    this.exact = this.emp <= cfg.exact;
    this.maxD = this.exact ? this.emp : cfg.depth;
    this.cur = null; this.d = this.exact ? this.maxD : 1; this.i = 0; this.alpha = -1e9;
    if (n === 0) { this.done = true; this.result = { move: 0 }; }
    else if (n === 1 && !cfg.thinkAlways) { this.done = true; this.result = { move: this.moves[0] }; this.bestMove = this.moves[0]; }
  }
  // Work is sliced into units (one reply of one root move) and bounded by wall-clock per step.
  tick(ms) {
    const t0 = performance.now();
    do { this.unit(); } while (!this.done && performance.now() - t0 < ms);
  }
  unit() {
    const cfg = this.cfg, me = this.me;
    if (!this.cur) {
      const cb = this.cb || (this.cb = new Int8Array(100)); make(this.root, cb, this.moves[this.i], me);
      const lo = this.alpha - cfg.margin - 0.01;
      const rep = new Uint8Array(40), n = this.d >= 2 && this.emp >= 2 ? gen(cb, 3 - me, rep) : 0;
      if (n === 0) { this.endRoot(-this.nega(cb, 1, 3 - me, this.d - 1, this.emp - 1, -1e9, -lo, false)); return; }
      rep.subarray(0, n).sort((a, b) => PW[b] - PW[a]);
      this.cur = { rep, n, j: 0, ao: -1e9, beta: -lo };
    }
    const c = this.cur;
    make(this.cb, bufs[0], c.rep[c.j], 3 - me);
    const v = -this.nega(bufs[0], 1, me, this.d - 2, this.emp - 2, -c.beta, -c.ao, false);
    if (v > c.ao) c.ao = v;
    c.j++;
    if (c.ao >= c.beta || c.j >= c.n) { this.cur = null; this.endRoot(-c.ao); }
  }
  endRoot(v) {
    this.scores[this.i] = v;
    if (v > this.alpha) this.alpha = v;
    this.i++;
    if (this.i >= this.moves.length) {
      // order for next iteration
      const idx = this.moves.map((_, k) => k).sort((a, b) => this.scores[b] - this.scores[a]);
      this.moves = idx.map(k => this.moves[k]); this.scores = idx.map(k => this.scores[k]);
      this.bestMove = this.moves[0]; this.depthDone = this.d;
      if (this.d >= this.maxD) { this.finish(); return; }
      this.d++; this.i = 0; this.alpha = -1e9;
    }
  }
  finish() {
    const cfg = this.cfg, sc = this.scores, mv = this.moves, best = sc[0];
    let cands = [];
    if (cfg.noiseP && Math.random() < cfg.noiseP) {
      for (let k = 0; k < mv.length; k++) if (sc[k] >= best - cfg.noiseTol) cands.push(mv[k]);
      if (cands.length < 2) cands = mv.slice(0, Math.min(3, mv.length));
    } else if (cfg.openTol && this.discs <= 4 + cfg.openPlies) {
      for (let k = 0; k < mv.length; k++) if (sc[k] >= best - cfg.openTol) cands.push(mv[k]);
    } else {
      for (let k = 0; k < mv.length; k++) if (sc[k] >= best - 1e-6) cands.push(mv[k]);
    }
    this.result = { move: rnd.pick(cands), score: best }; this.done = true;
  }
  nega(b, ply, me, depth, emp, alpha, beta, passed) {
    this.nodes++;
    if (!this.exact && depth <= 0) return evaluate(b, me, emp, this.cfg);
    const mv = mvs[ply], n = gen(b, me, mv);
    if (n === 0) {
      if (passed) { const d = countDiscs(b, me) - countDiscs(b, 3 - me); return d * 100 + (d > 0 ? 8000 : d < 0 ? -8000 : 0); }
      return -this.nega(b, ply, 3 - me, depth, emp, -beta, -alpha, true);
    }
    for (let i = 1; i < n; i++) { const m = mv[i], w = PW[m]; let j = i - 1; while (j >= 0 && PW[mv[j]] < w) { mv[j + 1] = mv[j]; j--; } mv[j + 1] = m; }
    const child = bufs[ply];
    for (let i = 0; i < n; i++) {
      make(b, child, mv[i], me);
      const v = -this.nega(child, ply + 1, 3 - me, depth - 1, emp - 1, -beta, -alpha, false);
      if (v >= beta) return v;
      if (v > alpha) alpha = v;
    }
    return alpha;
  }
}

// ------------------------------------------------------------------ 3. configs
const BASE = { pos: 1, mob: 1, corner: 1, x: 1, front: 1, stab: 1, disc: 1, discEarly: 0 };
const mk = o => Object.assign({}, BASE, o);
const STYLES = {
  'Corner hunter': mk({ corner: 1.7, pos: 1.3, mob: 0.8, stab: 1.5 }),
  'Mobility': mk({ mob: 1.9, front: 1.4, pos: 0.6 }),
  'Quiet moves': mk({ front: 2.4, mob: 1.3, discEarly: -1, pos: 0.8 }),
};
const AUTOPILOT = { depth: 5, exact: 9, margin: 60, openTol: 60, openPlies: 6, nodes: 1500, noiseP: 0, thinkAlways: true };
const SUPER = { depth: 8, exact: 13, margin: 0, openTol: 0, openPlies: 0, nodes: 4500, noiseP: 0 };
const HOUSE = { depth: 5, exact: 6, margin: 1e9, openTol: 0, openPlies: 0, nodes: 1200, noiseP: 0.2, noiseTol: 40, noise: 12 };
const houseCfg = lvl => Object.assign(mk({ pos: 1, mob: 0.9, corner: 1, front: 0.9, stab: 0.8, disc: 0.9 }), HOUSE,
  lvl === 'sharp' ? { depth: 5, exact: 8, noiseP: 0.08, noiseTol: 25, noise: 6 } : {});
const autoCfg = (style, superAI) => Object.assign({}, superAI ? mk({ mob: 1.2, stab: 1.2 }) : STYLES[style], superAI ? SUPER : AUTOPILOT);

const TWISTS = [
  { key: 'cheat', name: 'Cheating engine', desc: 'The house may sneak in an illegal move or an extra flip.' },
  { key: 'first', name: 'House first', desc: 'The house takes Onyx and opens the game.' },
  { key: 'sharp', name: 'Sharper house', desc: 'The house engine looks further ahead than usual.' },
];

// ------------------------------------------------------------------ 4. the game
const PEARL = 2, ONYX = 1;
const GOLD = '#e6cf94', GOLD_D = '#b79a58';
const mulberry = a => () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };

function create(opts = {}) {
  const superAI = !!opts.superAI;
  let twist = null;
  if (opts.twist) { twist = typeof opts.twist === 'string' ? TWISTS.find(t => t.key === opts.twist) || rnd.pick(TWISTS) : rnd.pick(TWISTS); }
  const tk = twist && twist.key;
  const style = superAI ? 'Super AI' : rnd.pick(Object.keys(STYLES));
  let aiSide = rnd.int(2) + 1;
  if (tk === 'first') aiSide = PEARL;
  const houseSide = 3 - aiSide;
  const names = { [ONYX]: 'Onyx', [PEARL]: 'Pearl' };
  const brains = [];
  brains[aiSide] = new Brain(autoCfg(style, superAI));
  brains[houseSide] = new Brain(houseCfg(tk === 'sharp' ? 'sharp' : 'normal'));
  const particles = new Particles();
  const board = initBoard();
  const rng = mulberry(rnd.int(1e9));

  // visual cell state: one object per occupied square
  const cells = new Array(100).fill(null);
  const mkCell = (col, t0 = -9) => ({ col, from: col, t0: -9, dur: 0.6, placeT0: t0, cheat: -9, flipEnd: -9 });
  for (const s of SQS) if (board[s]) cells[s] = mkCell(board[s]);

  const st = {
    T: 0, side: ONYX, nextAt: 1.2, over: false, endT: 0, ply: 0, history: [], last: null, resultText: '', passes: 0,
    banners: [], events: [], shake: 0, redFlash: -9, barShown: 0.5, thinkInfo: '', animEnd: 0, finalAt: -1, final: null, won: false, started: false,
    cheatPlan: [], houseMoves: 0, cheats: 0,
  };
  if (tk === 'cheat') {
    const a = 4 + rnd.int(8), b = a + 6 + rnd.int(10);
    st.cheatPlan = [a, b, b + 6 + rnd.int(8)];
  }
  let W = 1600, H = 900, L = null, bgc = null, boardC = null, spr = null;
  const bokeh = Array.from({ length: 16 }, () => ({ x: rng(), y: rng(), r: 0.02 + rng() * 0.06, vx: (rng() - 0.5) * 0.004, ph: rng() * 6.28, h: rng() }));
  const petals = Array.from({ length: 16 }, () => ({ x: rng(), y: rng(), s: 0.5 + rng(), ph: rng() * 6.28, sp: 0.012 + rng() * 0.018, rot: rng() * 6.28 }));

  function layout() {
    const fr0 = 0.3;
    const c = Math.max(22, Math.min(0.86 * H / (8 + 2 * fr0), 0.94 * W / (8 + 2 * fr0 + 0.5 + 3.8)));
    const fr = fr0 * c, pw = 3.8 * c, gap = 0.5 * c;
    const total = 8 * c + 2 * fr + gap + pw;
    const x0 = (W - total) / 2, cy = H * 0.46;
    const bh = 8 * c + 2 * fr;
    L = { c, fr, bx: x0 + fr, by: cy - bh / 2 + fr, pw, px: x0 + 8 * c + 2 * fr + gap, py: cy - bh / 2, ph: bh };
    bgc = null; boardC = null; spr = null;
  }
  const sqXY = s => [L.bx + (colOf(s) + 0.5) * L.c, L.by + (rowOf(s) + 0.5) * L.c];

  // ---- observe(): everything a spectator sees on the board right now
  function observe() { return { b: board.slice(), side: st.side }; }

  // ---- move application (logic + animation)
  function addBanner(text, kind, dur = 2.2) { st.banners.push({ text, kind, t0: st.T, dur }); }
  function fx(at, fn) { st.events.push({ at, fn }); }
  function applyMove(sq, side, flips, cheatKind) {
    const T = st.T, speed = superAI ? 0.7 : 1;
    board[sq] = side; for (const f of flips) board[f] = side;
    const cell = mkCell(side, T); cell.dur = 0.6 * speed; cells[sq] = cell;
    const [px, py] = sqXY(sq);
    let end = T + 0.38 * speed;
    for (const f of flips) {
      const dist = Math.max(Math.abs(rowOf(f) - rowOf(sq)), Math.abs(colOf(f) - colOf(sq)));
      const c0 = cells[f]; const t0 = T + (0.3 + dist * 0.09) * speed;
      cells[f] = { col: side, from: 3 - side, t0, dur: 0.62 * speed, placeT0: -9, cheat: cheatKind ? T : -9 };
      end = Math.max(end, t0 + 0.62 * speed);
      const [fx_, fy_] = sqXY(f);
      fx(t0 + 0.3 * speed, () => particles.burst(fx_, fy_, 3, { color: side === PEARL ? ['#fff3ea', '#cfe9ff', '#ffd6e8'] : ['#7fe0d0', '#6e8bd8', '#cfd6ff'], speed: 90, size: L.c * 0.03, life: 0.6, gravity: 40 }));
    }
    fx(T + 0.26 * speed, () => {
      particles.burst(px, py + L.c * 0.2, 10, { color: side === PEARL ? ['#fff6ee', '#f6d9e8'] : ['#8aa0c8', '#5d7c9a'], speed: 120, speedMin: 40, size: L.c * 0.035, life: 0.55 });
      st.shake = Math.max(st.shake, 0.12);
    });
    if (CORNERS.includes(sq)) fx(T + 0.3, () => particles.burst(px, py, 26, { color: ['#ffe8a8', '#fff', '#e6cf94'], speed: 260, size: L.c * 0.05, life: 1.1, drag: 1.6 }));
    if (cheatKind) {
      st.redFlash = T; st.shake = 0.5;
      cell.cheat = T;
      addBanner(cheatKind === 'illegal' ? 'ILLEGAL MOVE' : 'EXTRA FLIP', 'cheat', 2.6);
      fx(T + 0.1, () => particles.burst(px, py, 30, { color: ['#ff5a3c', '#ffb347', '#fff'], speed: 320, size: L.c * 0.045, life: 0.9, drag: 2.2 }));
    }
    st.history.push({ side, txt: sqName(sq), n: flips.length, cheat: cheatKind, ply: st.history.length + 1 });
    st.last = { sq, T };
    st.animEnd = end;
    return end;
  }

  function houseCheat(sq, flips, side) {
    // returns {sq, flips, kind} - a nastier version of the house's legal move
    const op = 3 - side, tmp = new Int8Array(100);
    const sc = (bd) => evaluate(bd, side, 0, houseCfg('normal')) ;
    const kinds = Math.random() < 0.5 ? ['illegal', 'extra'] : ['extra', 'illegal'];
    for (const kind of kinds) {
      if (kind === 'extra') {
        const bd = board.slice(); bd[sq] = side; for (const f of flips) bd[f] = side;
        let best = null, bv = -1e9;
        for (const s of SQS) {
          if (bd[s] !== op) continue;
          let adj = false; for (const d of DIRS) if (bd[s + d] === side) { adj = true; break; }
          if (!adj) continue;
          tmp.set(bd); tmp[s] = side; const v = sc(tmp) + Math.random() * 10;
          if (v > bv) { bv = v; best = s; }
        }
        if (best) return { sq, flips: flips.concat([best]), kind: 'extra' };
      } else {
        let best = null, bv = -1e9;
        const legal = new Uint8Array(40), n = gen(board, side, legal), L2 = new Set(legal.subarray(0, n));
        for (const s of SQS) {
          if (board[s] !== 0 || L2.has(s)) continue;
          const adjOp = []; for (const d of DIRS) if (board[s + d] === op) adjOp.push(s + d);
          if (!adjOp.length) continue;
          adjOp.sort((a, b) => PW[b] - PW[a]);
          const fl = adjOp.slice(0, 2);
          tmp.set(board); tmp[s] = side; for (const f of fl) tmp[f] = side;
          const v = sc(tmp) + Math.random() * 10;
          if (v > bv) { bv = v; best = { sq: s, flips: fl, kind: 'illegal' }; }
        }
        if (best) return best;
      }
    }
    return { sq, flips, kind: null };
  }

  function finishGame(reason) {
    if (st.final) return;
    const a = countDiscs(board, aiSide), h = countDiscs(board, houseSide);
    st.final = { a, h };
    st.won = a > h;
    st.resultText = reason || (a > h ? `Won ${a}–${h} as ${names[aiSide]}` : a < h ? `Lost ${a}–${h} as ${names[aiSide]}` : `Draw ${a}–${h}, counted as lost`);
    st.finalAt = Math.max(st.animEnd, st.T) + 1.0;
    st.endFlag = true;
    st.winner = a > h ? aiSide : a < h ? houseSide : 0;
    addBanner(a > h ? 'AUTOPILOT WINS' : a < h ? 'HOUSE WINS' : 'DRAW', a > h ? 'win' : 'info', 4);
    fx(st.finalAt - 0.8, () => {
      if (st.winner) for (const s of SQS) if (board[s] === st.winner && Math.random() < 0.5) { const [x, y] = sqXY(s); particles.burst(x, y, 3, { color: ['#fff', '#ffe8a8', '#bff3e0'], speed: 160, size: L.c * 0.04, life: 1.2, gravity: -20 }); }
    });
  }

  function turn() {
    // called when the current side must act
    const T = st.T, side = st.side, br = brains[side];
    if (!br.active) {
      const tmp = new Uint8Array(40);
      const n = gen(board, side, tmp);
      if (n === 0) {
        const n2 = gen(board, 3 - side, tmp);
        if (n2 === 0) { finishGame(); return; }
        addBanner(`${names[side].toUpperCase()} PASSES`, 'info', 1.6);
        st.history.push({ side, txt: 'pass', n: 0, ply: st.history.length + 1 });
        st.side = 3 - side; st.nextAt = T + 1.4; br.active = false; return;
      }
      br.start(observe(), side);
    }
    if (!br.done) br.tick(3.5);
    if (side === aiSide) st.thinkInfo = br.depthDone ? `d${br.depthDone}${br.exact ? ' solve' : ''} · ${br.nodes >= 1000 ? Math.round(br.nodes / 1000) + 'k' : br.nodes} nodes` : 'thinking';
    if (br.done && T >= st.nextAt && T >= st.animEnd) {
      let sq = br.result.move; let flips = flipList(board, sq, side), kind = null;
      if (side === houseSide) {
        st.houseMoves++;
        if (tk === 'cheat' && st.cheatPlan.length && st.houseMoves >= st.cheatPlan[0] && st.cheats < 3) {
          st.cheatPlan.shift(); const r = houseCheat(sq, flips, side); sq = r.sq; flips = r.flips; kind = r.kind; if (kind) st.cheats++;
        }
      }
      br.active = false;
      const end = applyMove(sq, side, flips, kind);
      st.side = 3 - side; st.ply++;
      const nb = brains[st.side];
      const wait = superAI ? 0.12 : st.side === aiSide ? 1.1 + rnd.float(0, 0.5) : 0.8 + rnd.float(0, 0.5);
      st.nextAt = end + wait;
    }
  }

  const discCounts = (T) => {
    let o = 0, p = 0;
    for (const s of SQS) { const c = cells[s]; if (!c) continue; const col = faceAt(c, T); if (col === ONYX) o++; else p++; }
    return [o, p];
  };
  function faceAt(c, T) {
    if (c.t0 > -9 && T < c.t0 + c.dur) { if (T < c.t0) return c.from; return (T - c.t0) / c.dur < 0.5 ? c.from : c.col; }
    return c.col;
  }

  const inst = {
    over: false, won: false, style, superAI, twist: twist ? { key: twist.key, name: twist.name, desc: twist.desc } : null,
    resize(w, h) { W = w; H = h; layout(); },
    step(dt) {
      st.T += dt; const T = st.T;
      particles.update(dt);
      for (let i = st.events.length - 1; i >= 0; i--) if (T >= st.events[i].at) { const f = st.events[i].fn; st.events.splice(i, 1); f(); }
      st.shake = Math.max(0, st.shake - dt);
      const [o, p] = discCounts(T); const share = (aiSide === ONYX ? o : p) / Math.max(1, o + p);
      st.barShown += (share - st.barShown) * (1 - Math.exp(-dt * 6));
      for (let i = st.banners.length - 1; i >= 0; i--) if (T > st.banners[i].t0 + st.banners[i].dur) st.banners.splice(i, 1);
      if (inst.over) { st.endT += dt; return; }
      if (st.final) { if (T >= st.finalAt) { inst.over = true; inst.won = st.won; } return; }
      if (T > 360) { st.final = {}; st.won = false; st.resultText = 'Out of time'; inst.over = true; inst.won = false; return; }
      turn();
    },
    hud() {
      const [o, p] = discCounts(st.T), a = aiSide === ONYX ? o : p, h = aiSide === ONYX ? p : o;
      return { score: `${a} – ${h}`, detail: `${names[aiSide]} · move ${Math.min(60, st.history.length + 1)}` };
    },
    result() { return st.resultText || 'Game ended'; },
    draw(ctx, w, h) { drawAll(ctx, w, h); },
  };

  // ------------------------------------------------------------------ drawing
  function buildSprites(dpr) {
    const r = L.c * 0.42, S = Math.ceil(r * 2 * dpr) + 2;
    const mkc = () => { const cv = document.createElement('canvas'); cv.width = cv.height = S; return cv; };
    const pearl = mkc(), onyx = mkc();
    let g = pearl.getContext('2d'); const m = S / 2, R = m - 1;
    let gr = g.createRadialGradient(m - R * 0.3, m - R * 0.35, R * 0.1, m, m, R);
    gr.addColorStop(0, '#ffffff'); gr.addColorStop(0.55, '#f3e9e4'); gr.addColorStop(1, '#cdbfc4');
    g.fillStyle = gr; g.beginPath(); g.arc(m, m, R, 0, TAU); g.fill();
    g.save(); g.beginPath(); g.arc(m, m, R, 0, TAU); g.clip();
    for (const [dx, dy, col] of [[-0.45, 0.35, 'rgba(255,170,205,0.40)'], [0.5, 0.2, 'rgba(150,225,255,0.42)'], [0.05, -0.55, 'rgba(255,240,170,0.30)'], [0.3, 0.6, 'rgba(190,170,255,0.30)']]) {
      const q = g.createRadialGradient(m + dx * R, m + dy * R, 0, m + dx * R, m + dy * R, R * 0.8); q.addColorStop(0, col); q.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = q; g.fillRect(0, 0, S, S);
    }
    g.restore();
    g.strokeStyle = 'rgba(120,100,110,0.45)'; g.lineWidth = Math.max(1, R * 0.04); g.beginPath(); g.arc(m, m, R - g.lineWidth / 2, 0, TAU); g.stroke();
    g.strokeStyle = 'rgba(255,255,255,0.55)'; g.lineWidth = Math.max(1, R * 0.05); g.beginPath(); g.arc(m, m, R * 0.8, Math.PI * 1.05, Math.PI * 1.55); g.stroke();
    g = onyx.getContext('2d');
    gr = g.createRadialGradient(m - R * 0.3, m - R * 0.35, R * 0.05, m, m, R);
    gr.addColorStop(0, '#4b5064'); gr.addColorStop(0.5, '#1c1f2b'); gr.addColorStop(1, '#07080c');
    g.fillStyle = gr; g.beginPath(); g.arc(m, m, R, 0, TAU); g.fill();
    g.strokeStyle = 'rgba(120,200,190,0.35)'; g.lineWidth = Math.max(1, R * 0.045); g.beginPath(); g.arc(m, m, R - g.lineWidth / 2, 0, TAU); g.stroke();
    g.strokeStyle = 'rgba(255,255,255,0.14)'; g.lineWidth = Math.max(1, R * 0.03); g.beginPath(); g.arc(m, m, R * 0.7, 0, TAU); g.stroke();
    g.strokeStyle = 'rgba(255,255,255,0.6)'; g.lineWidth = Math.max(1, R * 0.06); g.lineCap = 'round'; g.beginPath(); g.arc(m, m, R * 0.78, Math.PI * 1.08, Math.PI * 1.45); g.stroke();
    spr = { dpr, c: L.c, [PEARL]: pearl, [ONYX]: onyx, S };
  }

  function buildBg(dpr) {
    const cv = document.createElement('canvas'); cv.width = Math.ceil(W * dpr); cv.height = Math.ceil(H * dpr);
    const g = cv.getContext('2d'); g.scale(dpr, dpr);
    const bg = g.createLinearGradient(0, 0, W * 0.4, H); bg.addColorStop(0, '#16303a'); bg.addColorStop(0.5, '#0f2029'); bg.addColorStop(1, '#0a141c');
    g.fillStyle = bg; g.fillRect(0, 0, W, H);
    // faint woven pattern
    g.strokeStyle = 'rgba(160,220,210,0.025)'; g.lineWidth = 1;
    const step = Math.max(14, L.c * 0.35);
    for (let x = -H; x < W + H; x += step) { g.beginPath(); g.moveTo(x, 0); g.lineTo(x + H, H); g.stroke(); }
    for (let x = 0; x < W + H; x += step) { g.beginPath(); g.moveTo(x, 0); g.lineTo(x - H, H); g.stroke(); }
    const cx = L.bx + 4 * L.c, cy = L.by + 4 * L.c;
    const lamp = g.createRadialGradient(cx - L.c * 2, cy - L.c * 3.5, L.c, cx, cy, Math.max(W, H) * 0.75);
    lamp.addColorStop(0, 'rgba(255,214,150,0.22)'); lamp.addColorStop(0.4, 'rgba(255,190,120,0.07)'); lamp.addColorStop(1, 'rgba(255,190,120,0)');
    g.fillStyle = lamp; g.fillRect(0, 0, W, H);
    const vg = g.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.35, W / 2, H / 2, Math.max(W, H) * 0.8);
    vg.addColorStop(0, 'rgba(0,0,0,0)'); vg.addColorStop(1, 'rgba(0,0,0,0.55)');
    g.fillStyle = vg; g.fillRect(0, 0, W, H);
    // glow sprite for bokeh
    const gl = document.createElement('canvas'); gl.width = gl.height = 64; const q = gl.getContext('2d');
    const rg = q.createRadialGradient(32, 32, 0, 32, 32, 32); rg.addColorStop(0, 'rgba(255,225,170,0.9)'); rg.addColorStop(0.6, 'rgba(255,200,130,0.25)'); rg.addColorStop(1, 'rgba(255,200,130,0)');
    q.fillStyle = rg; q.fillRect(0, 0, 64, 64);
    bgc = { cv, gl, dpr, W, H };
  }

  function buildBoard(dpr) {
    const c = L.c, fr = L.fr, M = 0.6 * c, S = 8 * c + 2 * fr;
    const cv = document.createElement('canvas'); cv.width = Math.ceil((S + 2 * M) * dpr); cv.height = cv.width;
    const g = cv.getContext('2d'); g.scale(dpr, dpr); g.translate(M, M);
    const r2 = mulberry(1234);
    // shadow
    g.save(); g.shadowColor = 'rgba(0,0,0,0.65)'; g.shadowBlur = c * 0.5; g.shadowOffsetY = c * 0.18; g.fillStyle = '#20100f';
    roundRect(g, 0, 0, S, S, c * 0.18); g.fill(); g.restore();
    // frame: dark rosewood
    const fg = g.createLinearGradient(0, 0, S, S); fg.addColorStop(0, '#4a2a26'); fg.addColorStop(0.5, '#2f1917'); fg.addColorStop(1, '#3c2220');
    g.fillStyle = fg; roundRect(g, 0, 0, S, S, c * 0.18); g.fill();
    for (let i = 0; i < 60; i++) { g.strokeStyle = `rgba(${r2() < 0.5 ? '255,200,170' : '0,0,0'},${0.03 + r2() * 0.04})`; g.lineWidth = 1; const y = r2() * S; g.beginPath(); g.moveTo(0, y); g.bezierCurveTo(S * 0.3, y + (r2() - 0.5) * 8, S * 0.7, y + (r2() - 0.5) * 8, S, y + (r2() - 0.5) * 6); g.stroke(); }
    g.strokeStyle = 'rgba(230,207,148,0.5)'; g.lineWidth = Math.max(1, c * 0.02); roundRect(g, c * 0.04, c * 0.04, S - c * 0.08, S - c * 0.08, c * 0.15); g.stroke();
    g.strokeStyle = 'rgba(0,0,0,0.5)'; g.lineWidth = 2; roundRect(g, fr - 2, fr - 2, 8 * c + 4, 8 * c + 4, 3); g.stroke();
    // squares
    for (let r = 0; r < 8; r++) for (let q = 0; q < 8; q++) {
      const x = fr + q * c, y = fr + r * c, dark = (r + q) & 1;
      const cg = g.createLinearGradient(x, y, x + c, y + c);
      cg.addColorStop(0, dark ? '#2f6b5e' : '#3a7a6a'); cg.addColorStop(1, dark ? '#265a50' : '#2f6a5b');
      g.fillStyle = cg; g.fillRect(x, y, c, c);
      g.save(); g.beginPath(); g.rect(x, y, c, c); g.clip();
      for (let i = 0; i < 16; i++) { g.fillStyle = r2() < 0.5 ? `rgba(200,255,230,${0.025 + r2() * 0.035})` : `rgba(0,20,20,${0.04 + r2() * 0.05})`; g.beginPath(); g.ellipse(x + r2() * c, y + r2() * c, c * (0.1 + r2() * 0.3), c * (0.04 + r2() * 0.1), r2() * 3, 0, TAU); g.fill(); }
      g.restore();
    }
    // sheen across the whole board
    const sh = g.createLinearGradient(fr, fr, fr + 8 * c, fr + 8 * c); sh.addColorStop(0, 'rgba(255,255,230,0.10)'); sh.addColorStop(0.5, 'rgba(255,255,230,0)'); sh.addColorStop(1, 'rgba(0,0,0,0.12)');
    g.fillStyle = sh; g.fillRect(fr, fr, 8 * c, 8 * c);
    // hairlines
    g.strokeStyle = 'rgba(0,0,0,0.35)'; g.lineWidth = Math.max(1.5, c * 0.025);
    for (let i = 0; i <= 8; i++) { g.beginPath(); g.moveTo(fr + i * c, fr); g.lineTo(fr + i * c, fr + 8 * c); g.moveTo(fr, fr + i * c); g.lineTo(fr + 8 * c, fr + i * c); g.stroke(); }
    g.strokeStyle = 'rgba(230,207,148,0.45)'; g.lineWidth = Math.max(1, c * 0.013);
    for (let i = 0; i <= 8; i++) { g.beginPath(); g.moveTo(fr + i * c, fr); g.lineTo(fr + i * c, fr + 8 * c); g.moveTo(fr, fr + i * c); g.lineTo(fr + 8 * c, fr + i * c); g.stroke(); }
    // gold inlay: corner diamonds + star dots
    g.fillStyle = 'rgba(230,207,148,0.75)';
    for (const [qx, ry] of [[2, 2], [6, 2], [2, 6], [6, 6]]) { g.beginPath(); g.arc(fr + qx * c, fr + ry * c, c * 0.045, 0, TAU); g.fill(); }
    g.fillStyle = 'rgba(255,230,160,0.45)';
    for (const [qx, ry] of [[0, 0], [7, 0], [0, 7], [7, 7]]) { const x = fr + (qx + 0.5) * c, y = fr + (ry + 0.5) * c, d = c * 0.1; g.beginPath(); g.moveTo(x, y - d); g.lineTo(x + d, y); g.lineTo(x, y + d); g.lineTo(x - d, y); g.closePath(); g.fill(); }
    // coordinates
    g.fillStyle = 'rgba(230,207,148,0.6)'; g.font = `600 ${Math.max(9, c * 0.19)}px Fraunces, Georgia, serif`; g.textAlign = 'center'; g.textBaseline = 'middle';
    for (let i = 0; i < 8; i++) { g.fillText('abcdefgh'[i], fr + (i + 0.5) * c, fr / 2); g.fillText(String(i + 1), fr / 2, fr + (i + 0.5) * c); }
    boardC = { cv, M, dpr, c };
  }

  function disc(ctx, x, y, r, z, k, face, extraGlint) {
    // z = lift in px, k = vertical squash 0..1 (coin flip), face = ONYX/PEARL
    const s = Math.sqrt(Math.max(0, 1 - k * k));
    const th = r * 0.15 + r * 0.2 * s;
    const cy = y - z;
    ctx.save(); ctx.translate(x, cy);
    ctx.fillStyle = face === PEARL ? '#a89aa4' : '#06070a';
    ctx.beginPath(); ctx.ellipse(0, th / 2, r, Math.max(0.5, r * k), 0, 0, TAU); ctx.fill();
    ctx.fillRect(-r, -th / 2, 2 * r, th);
    if (face === PEARL) { ctx.fillStyle = 'rgba(255,255,255,0.25)'; ctx.fillRect(-r, -th / 2, 2 * r, Math.max(1, th * 0.35)); }
    const hh = Math.max(1, 2 * r * k);
    ctx.drawImage(spr[face], -r, -th / 2 - hh / 2, 2 * r, hh);
    if (extraGlint > 0.01) {
      ctx.globalCompositeOperation = 'lighter'; ctx.globalAlpha = extraGlint * 0.6;
      ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.ellipse(-r * 0.3, -th / 2 - r * k * 0.35, r * 0.28, Math.max(0.5, r * k * 0.12), -0.5, 0, TAU); ctx.fill();
    }
    ctx.restore();
  }

  function drawAll(ctx, w, h) {
    const dpr = Math.min(2, ctx.getTransform().a || 1);
    if (!L) layout();
    if (!bgc || bgc.dpr !== dpr || bgc.W !== W || bgc.H !== H) buildBg(dpr);
    if (!boardC || boardC.dpr !== dpr) buildBoard(dpr);
    if (!spr || spr.dpr !== dpr || spr.c !== L.c) buildSprites(dpr);
    const c = L.c, fr = L.fr, al = Math.max(0, Math.min(1, Arcade.alpha === undefined ? 0 : Arcade.alpha)) / 60;
    const T = st.T + (inst.over ? 0 : al);
    ctx.drawImage(bgc.cv, 0, 0, w, h);
    // ambient: bokeh + petals
    ctx.save(); ctx.globalCompositeOperation = 'lighter';
    for (const b of bokeh) {
      const x = ((b.x + b.vx * T) % 1 + 1) % 1 * w, y = (b.y + Math.sin(T * 0.1 + b.ph) * 0.02) * h, r = b.r * Math.min(w, h);
      ctx.globalAlpha = 0.07 + 0.05 * Math.sin(T * 0.4 + b.ph); ctx.drawImage(bgc.gl, x - r, y - r, 2 * r, 2 * r);
    }
    ctx.restore();
    ctx.save();
    for (const p of petals) {
      const y = ((p.y + T * p.sp) % 1.1) * h - 0.05 * h, x = ((p.x + Math.sin(T * 0.3 + p.ph) * 0.03) % 1) * w;
      ctx.globalAlpha = 0.16; ctx.fillStyle = p.s > 1 ? '#ffd9e6' : '#cfeee3';
      ctx.beginPath(); ctx.ellipse(x, y, c * 0.07 * p.s, c * 0.035 * p.s, p.rot + T * 0.4 * p.s, 0, TAU); ctx.fill();
    }
    ctx.restore();

    ctx.save();
    if (st.shake > 0) { const a = Math.min(1, st.shake * 3) * c * 0.05; ctx.translate(Math.sin(T * 90) * a, Math.cos(T * 77) * a); }
    const bm = boardC.M, S = 8 * c + 2 * fr;
    ctx.drawImage(boardC.cv, L.bx - fr - bm, L.by - fr - bm, S + 2 * bm, S + 2 * bm);

    // last move glow
    if (st.last) {
      const k = Math.min(1, (T - st.last.T) / 0.4), pulse = 0.7 + 0.3 * Math.sin(T * 2.4);
      const [x, y] = sqXY(st.last.sq);
      const gg = ctx.createRadialGradient(x, y, c * 0.1, x, y, c * 0.75); gg.addColorStop(0, `rgba(255,225,150,${0.4 * k * pulse})`); gg.addColorStop(1, 'rgba(255,225,150,0)');
      ctx.fillStyle = gg; ctx.fillRect(x - c, y - c, 2 * c, 2 * c);
      ctx.strokeStyle = `rgba(240,215,150,${0.55 * k * pulse})`; ctx.lineWidth = Math.max(1.5, c * 0.035); ctx.strokeRect(L.bx + colOf(st.last.sq) * c + c * 0.04, L.by + rowOf(st.last.sq) * c + c * 0.04, c * 0.92, c * 0.92);
    }
    // legal-move hints + the Autopilot's candidate
    if (!st.final && !inst.over) {
      const side = st.side, tmp = new Uint8Array(40), n = gen(board, side, tmp);
      for (let i = 0; i < n; i++) {
        const [x, y] = sqXY(tmp[i]);
        ctx.fillStyle = side === PEARL ? 'rgba(255,245,235,0.20)' : 'rgba(10,15,25,0.30)';
        ctx.beginPath(); ctx.arc(x, y, c * 0.085 * (0.9 + 0.1 * Math.sin(T * 3 + i)), 0, TAU); ctx.fill();
      }
      const br = brains[side];
      if (br.bestMove && (!br.done || T < st.nextAt) && br.active) {
        const [x, y] = sqXY(br.bestMove), pu = 0.6 + 0.4 * Math.sin(T * 5);
        ctx.strokeStyle = `rgba(255,225,150,${0.5 + 0.4 * pu})`; ctx.lineWidth = Math.max(2, c * 0.04);
        ctx.beginPath(); ctx.arc(x, y, c * (0.3 + 0.04 * pu), 0, TAU); ctx.stroke();
        ctx.setLineDash([c * 0.06, c * 0.07]); ctx.strokeStyle = 'rgba(255,240,200,0.5)'; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.arc(x, y, c * 0.4, T * 0.8, T * 0.8 + TAU); ctx.stroke(); ctx.setLineDash([]);
      }
    }

    // discs: shadows, then resting, then movers
    const r = c * 0.42, moving = [];
    for (const s of SQS) {
      const cell = cells[s]; if (!cell) continue;
      const [x, y] = sqXY(s);
      let z = 0, k = 1, face = cell.col, drop = false;
      const placeU = (T - cell.placeT0) / (0.38 * (superAI ? 0.7 : 1));
      if (cell.placeT0 > -9 && placeU < 1) {
        if (placeU < 0) continue;
        drop = true;
        const u = placeU;
        if (u < 0.65) { const v = u / 0.65; z = c * 0.95 * (1 - v * v); } else { const v = (u - 0.65) / 0.35; z = c * 0.13 * Math.sin(Math.PI * v); }
      }
      if (cell.t0 > -9 && T < cell.t0 + cell.dur) {
        if (T < cell.t0) face = cell.from;
        else { const u = (T - cell.t0) / cell.dur, e = ease.inOutCubic(u), th = Math.PI * e; k = Math.abs(Math.cos(th)); face = th < Math.PI / 2 ? cell.from : cell.col; z = Math.sin(Math.PI * u) * c * 0.55; }
      }
      // shadow
      const sa = 0.34 * (1 - Math.min(0.8, z / c));
      ctx.fillStyle = `rgba(0,0,0,${sa})`; ctx.beginPath(); ctx.ellipse(x + c * 0.03 + z * 0.12, y + c * 0.07 + z * 0.1, r * (1 + z / c * 0.1), r * 0.92 * (k > 0.1 ? 1 : 0.6 + k * 4), 0, 0, TAU); ctx.fill();
      if (z > 0.5 || k < 0.999 || drop) moving.push({ s, x, y, z, k, face, cell });
      else {
        const gl = glint(s, T);
        disc(ctx, x, y, r, 0, 1, face, gl);
        if (st.winner && st.final && cell.col === st.winner) winnerShine(ctx, x, y, r, s, T);
        if (cell.cheat > -9 && T - cell.cheat < 3) cheatRing(ctx, x, y, r, T - cell.cheat);
      }
    }
    moving.sort((a, b) => a.z - b.z);
    for (const m of moving) {
      disc(ctx, m.x, m.y, r * (1 + m.z / c * 0.18), m.z, m.k, m.face, 0.3);
      if (m.cell.cheat > -9 && T - m.cell.cheat < 3) cheatRing(ctx, m.x, m.y - m.z, r, T - m.cell.cheat);
    }
    particles.draw(ctx);
    ctx.restore();

    // red flash for cheats
    if (T - st.redFlash < 1.4) {
      const a = Math.max(0, 1 - (T - st.redFlash) / 1.4);
      const vg = ctx.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.3, w / 2, h / 2, Math.max(w, h) * 0.75);
      vg.addColorStop(0, 'rgba(255,40,20,0)'); vg.addColorStop(1, `rgba(255,50,30,${0.45 * a * (0.6 + 0.4 * Math.sin(T * 30))})`);
      ctx.fillStyle = vg; ctx.fillRect(0, 0, w, h);
    }
    drawBanners(ctx, T);
    drawPanel(ctx, T);
  }

  function glint(s, T) {
    const ph = (colOf(s) + rowOf(s)) * 0.5 - T * 0.9, m = ((ph % 14) + 14) % 14;
    return m < 1.4 ? Math.sin(m / 1.4 * Math.PI) : 0;
  }
  function winnerShine(ctx, x, y, r, s, T) {
    const a = 0.25 + 0.25 * Math.sin(T * 3 - (colOf(s) + rowOf(s)) * 0.6);
    ctx.save(); ctx.globalCompositeOperation = 'lighter'; ctx.strokeStyle = `rgba(255,230,160,${a})`; ctx.lineWidth = Math.max(1.5, r * 0.08);
    ctx.beginPath(); ctx.arc(x, y, r * 1.02, 0, TAU); ctx.stroke(); ctx.restore();
  }
  function cheatRing(ctx, x, y, r, t) {
    const a = Math.max(0, 1 - t / 3) * (0.5 + 0.5 * Math.sin(t * 18));
    ctx.save(); ctx.strokeStyle = `rgba(255,70,40,${a})`; ctx.lineWidth = Math.max(2, r * 0.12); ctx.beginPath(); ctx.arc(x, y, r * 1.12, 0, TAU); ctx.stroke(); ctx.restore();
  }

  function drawBanners(ctx, T) {
    const c = L.c, cx = L.bx + 4 * c, cy = L.by + 4 * c;
    for (const b of st.banners) {
      const u = (T - b.t0) / b.dur, inK = Math.min(1, (T - b.t0) / 0.3), out = u > 0.8 ? 1 - (u - 0.8) / 0.2 : 1;
      if (inK <= 0) continue;
      const sc = 0.6 + 0.4 * ease.outBack(inK), fs = c * (b.kind === 'cheat' ? 0.78 : 0.6);
      ctx.save(); ctx.translate(cx, cy + (b.kind === 'cheat' ? -c * 0.2 : c * 0.0)); ctx.scale(sc, sc); ctx.globalAlpha = out * Math.min(1, inK * 1.5);
      ctx.font = `800 ${fs}px "Big Shoulders Display", Impact, sans-serif`;
      const tw = ctx.measureText(b.text).width + c * 1.1, hh = fs * 1.4;
      roundRect(ctx, -tw / 2, -hh / 2, tw, hh, hh * 0.18);
      if (b.kind === 'cheat') {
        ctx.fillStyle = '#220a06'; ctx.fill();
        ctx.save(); ctx.clip(); ctx.fillStyle = '#ff5a2c'; ctx.globalAlpha *= 0.55;
        for (let x = -tw; x < tw; x += c * 0.5) { ctx.beginPath(); ctx.moveTo(x + (T * 40 % (c * 0.5)), -hh / 2); ctx.lineTo(x + c * 0.25 + (T * 40 % (c * 0.5)), -hh / 2); ctx.lineTo(x - hh * 0.4 + c * 0.25 + (T * 40 % (c * 0.5)), hh / 2); ctx.lineTo(x - hh * 0.4 + (T * 40 % (c * 0.5)), hh / 2); ctx.fill(); }
        ctx.restore();
        ctx.strokeStyle = '#ff7a3c'; ctx.lineWidth = Math.max(2, c * 0.05); roundRect(ctx, -tw / 2, -hh / 2, tw, hh, hh * 0.18); ctx.stroke();
        ctx.fillStyle = '#fff1e0';
      } else if (b.kind === 'win') {
        ctx.fillStyle = 'rgba(18,40,38,0.88)'; ctx.fill(); ctx.strokeStyle = GOLD; ctx.lineWidth = Math.max(2, c * 0.04); ctx.stroke(); ctx.fillStyle = GOLD;
      } else {
        ctx.fillStyle = 'rgba(14,32,36,0.85)'; ctx.fill(); ctx.strokeStyle = 'rgba(230,207,148,0.6)'; ctx.lineWidth = Math.max(1.5, c * 0.03); ctx.stroke(); ctx.fillStyle = '#f3ead2';
      }
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(b.text, 0, fs * 0.04);
      ctx.restore();
    }
  }

  function drawPanel(ctx, T) {
    const c = L.c, x0 = L.px, y0 = L.py, w = L.pw, hgt = L.ph;
    const [o, p] = discCounts(T);
    ctx.save();
    const pg = ctx.createLinearGradient(x0, y0, x0 + w, y0 + hgt); pg.addColorStop(0, 'rgba(22,48,56,0.82)'); pg.addColorStop(1, 'rgba(10,24,30,0.86)');
    ctx.fillStyle = pg; roundRect(ctx, x0, y0, w, hgt, 0.2 * c); ctx.fill();
    ctx.strokeStyle = 'rgba(230,207,148,0.35)'; ctx.lineWidth = 1.2; roundRect(ctx, x0, y0, w, hgt, 0.2 * c); ctx.stroke();
    const blocks = [
      { side: houseSide, name: 'House engine', info: tk === 'sharp' ? 'depth 5 · sharp' : 'depth 5 · rusty', top: true, n: houseSide === ONYX ? o : p },
      { side: aiSide, name: 'Autopilot', info: st.thinkInfo || (superAI ? 'depth 8 · exact endgame' : style), top: false, n: aiSide === ONYX ? o : p },
    ];
    for (const b of blocks) {
      const ny = b.top ? y0 + 0.62 * c : y0 + hgt - 0.62 * c;
      const active = !st.final && st.side === b.side;
      if (active) { const g = ctx.createLinearGradient(x0, 0, x0 + w, 0); g.addColorStop(0, `rgba(230,207,148,${0.1 + 0.05 * Math.sin(T * 3)})`); g.addColorStop(1, 'rgba(230,207,148,0)'); ctx.fillStyle = g; roundRect(ctx, x0 + 3, ny - 0.62 * c, w - 6, 1.24 * c, 0.15 * c); ctx.fill(); }
      const rr = c * 0.3, ix = x0 + 0.55 * c;
      ctx.fillStyle = 'rgba(0,0,0,0.3)'; ctx.beginPath(); ctx.ellipse(ix + 2, ny + 3, rr, rr, 0, 0, TAU); ctx.fill();
      ctx.drawImage(spr[b.side], ix - rr, ny - rr, 2 * rr, 2 * rr);
      ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
      ctx.fillStyle = active ? '#f6e7b8' : '#d7e4de'; ctx.font = `600 ${0.25 * c}px Fraunces, Georgia, serif`; ctx.fillText(b.name, x0 + 1.05 * c, ny - 0.14 * c);
      ctx.fillStyle = 'rgba(215,228,222,0.55)'; ctx.font = `400 ${Math.max(8, 0.16 * c)}px "IBM Plex Mono", monospace`; ctx.fillText(b.info, x0 + 1.05 * c, ny + 0.2 * c, w - 1.4 * c);
      ctx.textAlign = 'right'; ctx.fillStyle = '#fff'; ctx.font = `600 ${0.5 * c}px Fredoka, sans-serif`; ctx.fillText(String(b.n), x0 + w - 0.35 * c, ny - 0.02 * c);
      if (active) for (let i = 0; i < 3; i++) { ctx.fillStyle = `rgba(232,207,143,${0.25 + 0.75 * Math.max(0, Math.sin(T * 5 - i * 0.9))})`; ctx.beginPath(); ctx.arc(x0 + w - 1.2 * c - i * 0.16 * c, ny + 0.5 * c, c * 0.04, 0, TAU); ctx.fill(); }
    }
    // share bar (Autopilot vs House)
    const by = y0 + hgt / 2 + 0.0 * c, bh = 0.2 * c, bx = x0 + 0.35 * c, bw = w - 0.7 * c;
    const aiFirst = st.barShown;
    // bar, positioned between the top/log area and bottom block
    const barY = y0 + 1.5 * c;
    ctx.save(); roundRect(ctx, bx, barY, bw, bh, bh / 2); ctx.clip();
    ctx.fillStyle = houseSide === PEARL ? '#e9dfe0' : '#14161f'; ctx.fillRect(bx, barY, bw, bh);
    ctx.fillStyle = aiSide === PEARL ? '#f3ebe8' : '#222636';
    // AI share grows from the bottom block side => left to right
    ctx.fillStyle = aiSide === PEARL ? '#f3ebe8' : '#242a3c'; ctx.fillRect(bx, barY, bw * aiFirst, bh);
    ctx.fillStyle = GOLD; ctx.fillRect(bx + bw * aiFirst - 1.5, barY, 3, bh);
    ctx.restore();
    ctx.strokeStyle = 'rgba(230,207,148,0.4)'; ctx.lineWidth = 1; roundRect(ctx, bx, barY, bw, bh, bh / 2); ctx.stroke();
    ctx.fillStyle = 'rgba(215,228,222,0.5)'; ctx.font = `400 ${Math.max(8, 0.14 * c)}px "IBM Plex Mono", monospace`; ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic'; ctx.fillText('AUTOPILOT', bx, barY + bh + 0.2 * c);
    ctx.textAlign = 'right'; ctx.fillText('HOUSE', bx + bw, barY + bh + 0.2 * c);
    // move log
    const ly0 = y0 + 2.3 * c, ly1 = y0 + hgt - 1.35 * c, rowH = 0.4 * c;
    const rows = Math.max(1, Math.floor((ly1 - ly0) / rowH)), hist = st.history, start = Math.max(0, hist.length - rows);
    ctx.textBaseline = 'middle';
    for (let i = start; i < hist.length; i++) {
      const e = hist[i], ry = ly0 + (i - start) * rowH + rowH / 2, fresh = i === hist.length - 1;
      if (fresh) { ctx.fillStyle = e.cheat ? 'rgba(255,80,40,0.22)' : 'rgba(230,207,148,0.14)'; roundRect(ctx, x0 + 0.25 * c, ry - rowH * 0.45, w - 0.5 * c, rowH * 0.9, 0.08 * c); ctx.fill(); }
      ctx.textAlign = 'right'; ctx.fillStyle = 'rgba(230,207,148,0.55)'; ctx.font = `400 ${0.17 * c}px "IBM Plex Mono", monospace`; ctx.fillText(e.ply + '.', x0 + 0.95 * c, ry);
      if (e.txt !== 'pass') { ctx.drawImage(spr[e.side], x0 + 1.12 * c, ry - 0.12 * c, 0.24 * c, 0.24 * c); }
      ctx.textAlign = 'left'; ctx.fillStyle = e.cheat ? '#ff9a78' : fresh ? '#f6e7b8' : '#dfe9e4'; ctx.font = `600 ${0.25 * c}px Fraunces, Georgia, serif`;
      ctx.fillText(e.txt + (e.cheat ? '  !' : ''), x0 + 1.5 * c, ry);
      if (e.n) { ctx.textAlign = 'right'; ctx.fillStyle = 'rgba(215,228,222,0.5)'; ctx.font = `400 ${0.17 * c}px "IBM Plex Mono", monospace`; ctx.fillText('+' + e.n, x0 + w - 0.4 * c, ry); }
    }
    ctx.restore();
  }

  layout();
  return inst;
}

Arcade.register({
  id: 'reversi', name: 'Pearl & Jade', genre: 'Board game',
  blurb: 'Mother-of-pearl and onyx coins flip across a celadon board under a paper lamp.',
  bg: '#0f2029', accent: '#7fd6b8',
  aiNote: 'Searches several moves ahead with alpha-beta (weighing corners, mobility and stable edges, and solving the endgame exactly); it only sees the board, like a spectator.',
  twists: TWISTS,
  create,
});
})();
