// mines.js — Frostfield (Minesweeper). 30x16, 99 mines, arctic blueprint look.
// The AI (see "THE AI" section) only reads observe(): the revealed numbers, its own flags and the
// mine counter. It acts through click/flag at a human-limited cursor speed and action rate.
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

  const GW = 30, GH = 16, GM = 99, N = GW * GH, SAFE = N - GM;
  const NUMC = [null, '#5ec2ff', '#3fd6b8', '#ff7d6b', '#a58bff', '#ff4d6a', '#28e0f0', '#f0f6ff', '#8b98a8'];
  const MONO = '"IBM Plex Mono", ui-monospace, Menlo, Consolas, monospace';
  const FLIP = 0.26;            // seconds for a tile flip
  const CAP_SECONDS = 360;

  // neighbour table
  const NB = [];
  for (let i = 0; i < N; i++) {
    const x = i % GW, y = (i / GW) | 0, a = [];
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      if (!dx && !dy) continue;
      const nx = x + dx, ny = y + dy;
      if (nx >= 0 && ny >= 0 && nx < GW && ny < GH) a.push(ny * GW + nx);
    }
    NB.push(a);
  }
  // log factorial table for binomials
  const LF = new Float64Array(N + 2);
  for (let i = 1; i < LF.length; i++) LF[i] = LF[i - 1] + Math.log(i);
  const lnC = (n, k) => (k < 0 || k > n ? -Infinity : LF[n] - LF[k] - LF[n - k]);

  const bounceOut = t => {
    const n1 = 7.5625, d1 = 2.75;
    if (t < 1 / d1) return n1 * t * t;
    if (t < 2 / d1) return n1 * (t -= 1.5 / d1) * t + 0.75;
    if (t < 2.5 / d1) return n1 * (t -= 2.25 / d1) * t + 0.9375;
    return n1 * (t -= 2.625 / d1) * t + 0.984375;
  };

  // =====================================================================================
  // THE AI — probability solver. Pure function of the observation, run as a generator so the
  // heavy enumeration is spread over several ticks (each next() does ~4000 search nodes).
  // obs = { st: Int8Array(N)  -1 hidden, -2 own flag, 0..8 revealed number,
  //         minesLeft: mine counter shown on screen (total - flags) }
  // Hidden state (mine positions) is never visible here.
  // =====================================================================================
  const NODE_YIELD = 4096, COMP_NODE_BUDGET = 260000, COMP_CELL_CAP = 80;

  function buildCons(s) {
    const cons = [];
    for (let i = 0; i < N; i++) {
      const v = s[i];
      if (v < 1) continue;
      let need = v;
      const U = [];
      const nb = NB[i];
      for (let k = 0; k < nb.length; k++) {
        const c = nb[k], sv = s[c];
        if (sv === -1) U.push(c); else if (sv === -2) need--;
      }
      if (U.length) cons.push({ U, need });
    }
    return cons;
  }

  function* solveGen(obs) {
    const s = Int8Array.from(obs.st);
    const safe = [], mines = [];
    const markSafe = c => { if (s[c] === -1) { s[c] = -3; safe.push(c); return true; } return false; };
    const markMine = c => { if (s[c] === -1) { s[c] = -2; mines.push(c); return true; } return false; };

    // ---- (a) single-cell rules + (b) subset rule over pairs of constraints, to a fixpoint
    for (let pass = 0; pass < 80; pass++) {
      const cons = buildCons(s);
      let found = false;
      const byCell = new Map();
      for (const A of cons) {
        if (A.need < 0 || A.need > A.U.length) continue; // inconsistent (cannot happen with correct flags)
        if (A.need === 0) { for (const c of A.U) if (markSafe(c)) found = true; }
        else if (A.need === A.U.length) { for (const c of A.U) if (markMine(c)) found = true; }
        for (const c of A.U) { let l = byCell.get(c); if (!l) byCell.set(c, l = []); l.push(A); }
      }
      if (!found) {
        for (const A of cons) {
          const cand = byCell.get(A.U[0]) || [];
          for (const B of cand) {
            if (B === A || B.U.length <= A.U.length) continue;
            let sub = true;
            for (const c of A.U) if (!B.U.includes(c)) { sub = false; break; }
            if (!sub) continue;
            const diff = B.U.filter(c => !A.U.includes(c));
            const dn = B.need - A.need;
            if (dn === 0) { for (const c of diff) if (markSafe(c)) found = true; }
            else if (dn === diff.length) { for (const c of diff) if (markMine(c)) found = true; }
          }
        }
      }
      if (!found) break;
    }
    if (safe.length || mines.length) return { safe, mines, guess: null };
    yield;

    // ---- (c) exact probabilities
    const cons = buildCons(s).filter(c => c.need >= 0 && c.need <= c.U.length);
    // components via union-find over frontier cells
    const par = new Map();
    const find = a => { let r = a; while (par.get(r) !== r) r = par.get(r); while (par.get(a) !== r) { const n = par.get(a); par.set(a, r); a = n; } return r; };
    for (const A of cons) for (const c of A.U) if (!par.has(c)) par.set(c, c);
    for (const A of cons) { const r0 = find(A.U[0]); for (let k = 1; k < A.U.length; k++) { const r = find(A.U[k]); if (r !== r0) par.set(r, r0); } }
    const groups = new Map();
    for (const c of par.keys()) { const r = find(c); let g = groups.get(r); if (!g) groups.set(r, g = { cells: [], cons: [] }); g.cells.push(c); }
    for (const A of cons) groups.get(find(A.U[0])).cons.push(A);

    const prob = new Map();         // cell -> mine probability (frontier)
    const comps = [];                // exactly-enumerated components
    let fallbackMines = 0;
    const frontierSet = new Set(par.keys());

    for (const g of groups.values()) {
      let res = null;
      if (g.cells.length <= COMP_CELL_CAP) res = yield* enumComp(g);
      if (res) comps.push(res);
      else {
        // fallback: local estimate = average of each cell's constraint densities
        for (const c of g.cells) prob.set(c, -1);
        const acc = new Map();
        for (const A of g.cons) { const d = A.need / A.U.length; for (const c of A.U) { const e = acc.get(c) || [0, 0]; e[0] += d; e[1]++; acc.set(c, e); } }
        for (const [c, e] of acc) { const p = Math.min(0.97, Math.max(0.03, e[0] / e[1])); prob.set(c, p); fallbackMines += p; }
      }
    }
    // interior = hidden cells not on the frontier
    const interior = [];
    for (let i = 0; i < N; i++) if (s[i] === -1 && !frontierSet.has(i)) interior.push(i);
    const NI = interior.length;
    const M = Math.max(0, Math.round(obs.minesLeft - fallbackMines));

    // prefix / suffix convolutions of the (normalised) mine-count distributions
    const conv = (a, b) => {
      const r = new Float64Array(a.length + b.length - 1);
      for (let i = 0; i < a.length; i++) { const ai = a[i]; if (!ai) continue; for (let j = 0; j < b.length; j++) r[i + j] += ai * b[j]; }
      let m = 0; for (let i = 0; i < r.length; i++) if (r[i] > m) m = r[i];
      if (m > 0) for (let i = 0; i < r.length; i++) r[i] /= m;
      return r;
    };
    const one = new Float64Array([1]);
    const pre = [one], suf = new Array(comps.length + 1);
    suf[comps.length] = one;
    for (let j = 0; j < comps.length; j++) pre.push(conv(pre[j], comps[j].ways));
    for (let j = comps.length - 1; j >= 0; j--) suf[j] = conv(suf[j + 1], comps[j].ways);
    const T = pre[comps.length];
    // Cw[m] ~ C(NI, M-m), scaled to max 1
    let maxLn = -Infinity;
    for (let m = 0; m < T.length; m++) maxLn = Math.max(maxLn, lnC(NI, M - m));
    const Cw = new Float64Array(T.length + 200);
    for (let m = 0; m < Cw.length; m++) { const l = lnC(NI, M - m); Cw[m] = l === -Infinity || maxLn === -Infinity ? 0 : Math.exp(l - maxLn); }

    const EPS = 1e-9;
    const dSafe = [], dMine = [];
    for (let j = 0; j < comps.length; j++) {
      const cp = comps[j];
      const R = conv(pre[j], suf[j + 1]);
      const S = new Float64Array(cp.ways.length);
      let Z = 0;
      for (let k = 0; k < cp.ways.length; k++) {
        let acc = 0;
        for (let t = 0; t < R.length; t++) acc += R[t] * Cw[k + t];
        S[k] = acc; Z += cp.ways[k] * acc;
      }
      for (let i = 0; i < cp.cells.length; i++) {
        let num = 0;
        const base = i * cp.ways.length;
        for (let k = 0; k < cp.ways.length; k++) num += cp.cm[base + k] * S[k];
        const p = Z > 0 ? num / Z : 0.5;
        prob.set(cp.cells[i], p);
        if (Z > 0) { if (p < EPS) dSafe.push(cp.cells[i]); else if (p > 1 - EPS) dMine.push(cp.cells[i]); }
      }
    }
    let pInt = M > 0 && NI > 0 ? M / NI : 0;
    if (NI > 0) {
      let num = 0, den = 0;
      for (let m = 0; m < T.length; m++) { const w = T[m] * Cw[m]; num += w * (M - m); den += w; }
      pInt = den > 0 ? Math.min(1, Math.max(0, num / (den * NI))) : pInt;
      if (den > 0) {
        if (pInt < EPS) for (const c of interior) dSafe.push(c);
        else if (pInt > 1 - EPS) for (const c of interior) dMine.push(c);
      }
    }
    if (dSafe.length || dMine.length) return { safe: dSafe, mines: dMine, guess: null };

    // ---- choose the least dangerous cell (tie-break: cells likely to open up, edges/corners for interior)
    let best = -1, bestKey = Infinity, bestP = 1;
    const consider = (c, p, isInterior) => {
      let nu = 0; const nb = NB[c];
      for (let k = 0; k < nb.length; k++) if (s[nb[k]] === -1) nu++;
      let key = p - GUESS_INFO * Math.pow(1 - p, nu);
      if (isInterior) key += nu >= 8 ? 0.012 : nu >= 5 ? 0.005 : 0;
      key += SUPER_RUN ? 0 : Math.random() * 1e-4;
      if (key < bestKey) { bestKey = key; best = c; bestP = p; }
    };
    for (const [c, p] of prob) consider(c, p, false);
    for (const c of interior) consider(c, pInt, true);
    if (best < 0) { for (let i = 0; i < N; i++) if (s[i] === -1) { best = i; bestP = 0.5; break; } }
    return { safe: [], mines: [], guess: best >= 0 ? { i: best, p: bestP } : null };
  }

  // exact enumeration of one connected component with forward-checking backtracking.
  // returns {cells, ways[k], cm[cellIdx*(n+1)+k]} (normalised) or null if the node budget is exceeded.
  function* enumComp(g) {
    const cells = g.cells, n = cells.length;
    const lidx = new Map(); cells.forEach((c, i) => lidx.set(c, i));
    const lcons = g.cons.map(A => ({ cells: A.U.map(c => lidx.get(c)), need: A.need }));
    const cellCons = Array.from({ length: n }, () => []);
    lcons.forEach((A, ci) => { for (const c of A.cells) cellCons[c].push(ci); });
    // BFS ordering so constraints close early
    const order = [], seen = new Uint8Array(n), seenC = new Uint8Array(lcons.length);
    for (let st = 0; st < n; st++) {
      if (seen[st]) continue;
      seen[st] = 1; const q = [st];
      while (q.length) {
        const c = q.shift(); order.push(c);
        for (const ci of cellCons[c]) { if (seenC[ci]) continue; seenC[ci] = 1; for (const d of lcons[ci].cells) if (!seen[d]) { seen[d] = 1; q.push(d); } }
      }
    }
    // remap so that cell i in search order = original index order[i]
    const ocons = order.map(o => cellCons[o]);
    const need = lcons.map(A => A.need), left = lcons.map(A => A.cells.length);
    const ways = new Float64Array(n + 1), cm = new Float64Array(n * (n + 1));
    const next = new Int8Array(n), cur = new Int8Array(n).fill(-1);
    let i = 0, k = 0, nodes = 0;
    while (i >= 0) {
      if (i === n) {
        ways[k]++;
        for (let a = 0; a < n; a++) if (cur[a] === 1) cm[order[a] * (n + 1) + k]++;
        nodes += (n >> 3) + 1;
        i--; continue;
      }
      if (cur[i] >= 0) { const v0 = cur[i]; for (const ci of ocons[i]) { left[ci]++; need[ci] += v0; } k -= v0; cur[i] = -1; }
      if (next[i] > 1) { next[i] = 0; i--; continue; }
      const v = next[i]++;
      nodes++;
      let ok = true;
      const cl = ocons[i];
      for (let a = 0; a < cl.length; a++) { const ci = cl[a]; left[ci]--; need[ci] -= v; if (need[ci] < 0 || need[ci] > left[ci]) ok = false; }
      if (ok) { cur[i] = v; k += v; i++; }
      else for (let a = 0; a < cl.length; a++) { const ci = cl[a]; left[ci]++; need[ci] += v; }
      if ((nodes & (NODE_YIELD - 1)) === 0) { if (nodes > COMP_NODE_BUDGET) return null; yield; }
    }
    let m = 0; for (let a = 0; a <= n; a++) if (ways[a] > m) m = ways[a];
    if (m === 0) return null;
    for (let a = 0; a <= n; a++) ways[a] /= m;
    for (let a = 0; a < cm.length; a++) cm[a] /= m;
    // trim to a tight length so convolutions stay small
    let kmax = n; while (kmax > 0 && ways[kmax] === 0) kmax--;
    if (kmax < n) {
      const w2 = ways.slice(0, kmax + 1), cm2 = new Float64Array(n * (kmax + 1));
      for (let c = 0; c < n; c++) for (let q = 0; q <= kmax; q++) cm2[c * (kmax + 1) + q] = cm[c * (n + 1) + q];
      return { cells, ways: w2, cm: cm2 };
    }
    return { cells, ways, cm };
  }

  // =====================================================================================
  // THE GAME
  // =====================================================================================
  // Tactic styles: where the opening click lands and how much a guess values opening up unknown neighbours.
  const MSTYLES = [
    { name: 'Center opener', open: 'center', info: 0.045 },
    { name: 'Corner opener', open: 'corner', info: 0.045 },
    { name: 'Info seeker', open: 'random', info: 0.16 },
    { name: 'Cautious scout', open: 'random', info: 0.0 },
  ];
  let GUESS_INFO = 0.045, SUPER_RUN = false;
  const SUPER_STYLE = { name: 'Super AI', open: 'center', info: 0.045 };
  const TWISTS = [
    { key: 'dense', name: 'Dense field', desc: 'The frozen field hides 7 extra mines.' },
    { key: 'noopen', name: 'No safe opening', desc: 'The first click is safe but the cells around it are not.' },
  ];
  function create(opts = {}) {
    const SUP = !!opts.superAI;
    let twist = null;
    if (opts.twist) twist = (typeof opts.twist === 'string' && TWISTS.find(t => t.key === opts.twist)) || rnd.pick(TWISTS);
    const gm = GM + (twist && twist.key === 'dense' ? 7 : 0), safe = N - gm;
    const sty = SUP ? SUPER_STYLE : rnd.pick(MSTYLES);
    GUESS_INFO = sty.info; SUPER_RUN = SUP;
    const mine = new Uint8Array(N), num = new Uint8Array(N), rev = new Uint8Array(N), flag = new Uint8Array(N);
    const flipAt = new Float32Array(N).fill(-1e9), flagT = new Float32Array(N).fill(-1e9), popAt = new Float32Array(N).fill(1e9);
    const popped = new Uint8Array(N);
    const P = new Particles();
    const rings = [];
    const glints = [];
    const snow = [];
    for (let i = 0; i < 60; i++) snow.push({ x: Math.random(), y: Math.random(), vy: rnd.float(0.012, 0.035), ph: rnd.float(0, TAU), s: rnd.float(0.6, 1.8), a: rnd.float(0.15, 0.45) });

    const g = {
      over: false, won: false, superAI: SUP, style: sty.name, t: 0, first: true, revealed: 0, flags: 0, clicks: 0, busyUntil: 0,
      hit: -1, loseT: 0, winT: 0, flash: 0, shake: 0, lastGuessP: -1, reason: '',
    };
    let W = 800, H = 600, cs = 30, ox = 0, oy = 0;
    let popList = [], popIdx = 0;
    let cache = null, sprites = null;
    const cphase = [rnd.float(0, 6), rnd.float(0, 6), rnd.float(0, 6)];

    // ---------------- rules ----------------
    function placeMines(first) {
      const noOpen = twist && twist.key === 'noopen';
      const fx = first % GW, fy = (first / GW) | 0;
      const cand = [];
      for (let i = 0; i < N; i++) { const x = i % GW, y = (i / GW) | 0; if (noOpen ? i !== first : (Math.abs(x - fx) > 1 || Math.abs(y - fy) > 1)) cand.push(i); }
      rnd.shuffle(cand);
      let k0 = 0;
      if (noOpen) {   // no zero-opening: exactly one mine hides among the first cell's neighbours
        const around = NB[first].slice(); mine[rnd.pick(around)] = 1; k0 = 1;
        const ok = []; for (const c of cand) if (!NB[first].includes(c)) ok.push(c);
        cand.length = 0; for (const c of ok) cand.push(c);
      }
      for (let k = 0; k < gm - k0; k++) mine[cand[k]] = 1;
      for (let i = 0; i < N; i++) { let c = 0; for (const j of NB[i]) c += mine[j]; num[i] = c; }
    }
    function cellPx(i) { return [ox + ((i % GW) + 0.5) * cs, oy + (((i / GW) | 0) + 0.5) * cs]; }

    function reveal(i) {
      if (g.over || rev[i] || flag[i]) return;
      g.clicks++;
      if (g.first) { g.first = false; placeMines(i); }
      if (mine[i]) { lose(i); return; }
      const cx0 = i % GW, cy0 = (i / GW) | 0;
      rev[i] = 1; flipAt[i] = g.t;
      const q = [i]; let head = 0, maxDelay = 0;
      while (head < q.length) {
        const c = q[head++];
        g.revealed++;
        if (num[c] === 0) {
          for (const nb of NB[c]) {
            if (rev[nb] || flag[nb] || mine[nb]) continue;
            rev[nb] = 1;
            const d = Math.hypot((nb % GW) - cx0, ((nb / GW) | 0) - cy0) * 0.032;
            flipAt[nb] = g.t + d; if (d > maxDelay) maxDelay = d;
            q.push(nb);
          }
        }
      }
      g.busyUntil = g.t + (q.length > 1 ? maxDelay + 0.24 : 0.12);
      const [px, py] = cellPx(i);
      P.burst(px, py, q.length > 1 ? 14 : 7, { speed: cs * 4, speedMin: cs, life: 0.6, size: cs * 0.08, color: ['#e8f4ff', '#a9d4ff', '#7fb8ee'], drag: 4 });
      rings.push({ x: px, y: py, t0: g.t, dur: 0.5, r0: cs * 0.3, r1: cs * (q.length > 1 ? 1.6 : 0.9), col: '190,225,255', lw: 2 });
      if (g.revealed === safe) win();
    }
    function toggleFlag(i) {
      if (g.over || rev[i]) return;
      flag[i] ^= 1; g.flags += flag[i] ? 1 : -1; flagT[i] = g.t; g.clicks++;
      if (flag[i]) { const [px, py] = cellPx(i); P.burst(px, py + cs * 0.2, 6, { speed: cs * 2.5, speedMin: cs * 0.5, life: 0.5, size: cs * 0.07, color: ['#ffd0d0', '#ff7b7b'], drag: 5 }); g.busyUntil = Math.max(g.busyUntil, g.t + 0.05); }
    }
    function win() {
      g.over = true; g.won = true; g.winT = g.t;
      let k = 0;
      for (let i = 0; i < N; i++) if (mine[i] && !flag[i]) { flag[i] = 1; flagT[i] = g.t + 0.5 + (((i % GW) + ((i / GW) | 0)) / (GW + GH)) * 1.1 + Math.random() * 0.15; k++; }
      g.flags = gm;
    }
    function lose(i) {
      g.over = true; g.won = false; g.hit = i; g.loseT = g.t; g.flash = 1; g.shake = 1;
      const [px, py] = cellPx(i);
      rings.push({ x: px, y: py, t0: g.t, dur: 1.2, r0: cs * 0.5, r1: cs * 14, col: '255,150,110', lw: 5 });
      rings.push({ x: px, y: py, t0: g.t + 0.1, dur: 1.0, r0: cs * 0.3, r1: cs * 8, col: '255,230,200', lw: 3 });
      P.burst(px, py, 50, { speed: cs * 9, speedMin: cs * 2, life: 1.1, size: cs * 0.12, color: ['#ffd9a0', '#ff8a5c', '#fff4e0'], drag: 2.5 });
      popList = [];
      for (let m = 0; m < N; m++) if (mine[m] && m !== i) popList.push(m);
      popList.sort((a, b) => { const da = Math.hypot((a % GW) - (i % GW), ((a / GW) | 0) - ((i / GW) | 0)), db = Math.hypot((b % GW) - (i % GW), ((b / GW) | 0) - ((i / GW) | 0)); return da - db; });
      const total = 2.1, n = popList.length;
      popList.forEach((m, r) => { popAt[m] = g.loseT + 0.45 + Math.pow(r / n, 0.8) * total + Math.random() * 0.05; });
      popAt[i] = g.loseT;
      popIdx = 0;
    }

    // observation snapshot: what a human sees on screen right now
    function observe() {
      const st = new Int8Array(N);
      for (let i = 0; i < N; i++) {
        if (rev[i]) st[i] = g.t >= flipAt[i] + FLIP * 0.5 ? num[i] : -1;
        else st[i] = flag[i] ? -2 : -1;
      }
      return { st, minesLeft: gm - g.flags };
    }

    // ---------------- pilot: cursor, timing, plan execution ----------------
    const pilot = {
      cx: GW / 2, cy: GH / 2, v: 0, gen: null, plan: null, target: null, dwell: 0, cool: 0,
      thinking: false, hover: 0, trail: [], pulse: -9, guessing: false, idleT: 0,
    };
    function pilotStep(dt) {
      if (g.over) return;
      pilot.cool -= dt;
      // ---- decide
      if (!pilot.target) {
        if (g.first) {
          let fx, fy;
          if (sty.open === 'center') { fx = Math.round(GW / 2) + rnd.int(5) - 2; fy = Math.round(GH / 2) + rnd.int(3) - 1; }
          else if (sty.open === 'corner') { fx = rnd.int(2) ? GW - 1 - rnd.int(2) : rnd.int(2); fy = rnd.int(2) ? GH - 1 - rnd.int(2) : rnd.int(2); }
          else { fx = 1 + rnd.int(GW - 2); fy = 1 + rnd.int(GH - 2); }
          pilot.target = { i: fy * GW + fx, kind: 'reveal' };
          pilot.dwell = SUP ? 0 : 0.25 + Math.random() * 0.2;
        } else if (g.t >= g.busyUntil) {
          if (!pilot.plan) {
            if (!pilot.gen) pilot.gen = solveGen(observe());
            pilot.thinking = true;
            const r = pilot.gen.next();
            if (r.done) { pilot.plan = r.value; pilot.gen = null; pilot.thinking = false; }
          }
          if (pilot.plan) pickTarget();
        }
      }
      // ---- move cursor
      let tx = pilot.cx, ty = pilot.cy;
      if (pilot.target) { tx = pilot.target.i % GW; ty = (pilot.target.i / GW) | 0; }
      const dx = tx - pilot.cx, dy = ty - pilot.cy, d = Math.hypot(dx, dy);
      const vmax = (SUP ? 9000 : 1800) / cs, acc = (SUP ? 80000 : 8500) / cs;
      if (pilot.target && d > 0.05) {
        const vt = Math.min(vmax, Math.sqrt(2 * acc * d) + 0.4);
        pilot.v = Math.min(vt, pilot.v + acc * dt);
        const stp = Math.min(d, pilot.v * dt);
        pilot.cx += dx / d * stp; pilot.cy += dy / d * stp;
      } else {
        pilot.v = 0;
        if (pilot.target) {
          pilot.dwell -= dt;
          if (pilot.dwell <= 0 && pilot.cool <= 0 && g.t >= g.busyUntil - (pilot.target.kind === 'flag' ? 0.25 : 0)) {
            const tg = pilot.target; pilot.target = null; pilot.cool = SUP ? 0 : 0.14; pilot.pulse = g.t;
            if (tg.kind === 'flag') toggleFlag(tg.i);
            else {
              if (tg.guess) { g.lastGuessP = tg.p; pilot.plan = null; }
              reveal(tg.i);
            }
          }
        } else {
          // idle breathing drift while thinking
          pilot.idleT += dt;
        }
      }
      pilot.trail.push(pilot.cx, pilot.cy);
      if (pilot.trail.length > 16) pilot.trail.splice(0, 2);
    }
    function pickTarget() {
      const plan = pilot.plan;
      let best = -1, bestCost = Infinity, kind = 'reveal';
      for (const c of plan.safe) {
        if (rev[c] || flag[c]) continue;
        const d = Math.hypot((c % GW) - pilot.cx, ((c / GW) | 0) - pilot.cy);
        if (d < bestCost) { bestCost = d; best = c; kind = 'reveal'; }
      }
      for (const c of plan.mines) {
        if (flag[c] || rev[c]) continue;
        const d = Math.hypot((c % GW) - pilot.cx, ((c / GW) | 0) - pilot.cy) + 1.6;
        if (d < bestCost) { bestCost = d; best = c; kind = 'flag'; }
      }
      if (best >= 0) { pilot.target = { i: best, kind }; pilot.dwell = SUP ? 0 : 0.1; return; }
      if (plan.guess && !rev[plan.guess.i] && !flag[plan.guess.i]) {
        pilot.target = { i: plan.guess.i, kind: 'reveal', guess: true, p: plan.guess.p };
        pilot.dwell = SUP ? 0 : 0.08 + 0.35 + Math.random() * 0.25; // a beat of hesitation before a risky click
        return;
      }
      pilot.plan = null;
    }

    // ---------------- visuals ----------------
    function buildContours(cw, ch, sc) {
      const c = document.createElement('canvas');
      c.width = Math.ceil(cw * sc); c.height = Math.ceil(ch * sc);
      const x = c.getContext('2d'); x.scale(sc, sc);
      // the static backdrop gradient is baked into this layer (one full-screen blit per frame instead of three)
      const pad = (cw - W) / 2;
      const bgG = x.createLinearGradient(0, pad, 0, pad + H);
      bgG.addColorStop(0, '#14263b'); bgG.addColorStop(1, '#0b1625');
      x.fillStyle = bgG; x.fillRect(0, 0, cw, ch);
      const st = 14, gw = Math.ceil(cw / st) + 1, gh = Math.ceil(ch / st) + 1;
      const f = new Float32Array(gw * gh);
      const p = cphase, mx = cw * 0.35, my = ch * 0.6;
      for (let j = 0; j < gh; j++) for (let i = 0; i < gw; i++) {
        const X = i * st, Y = j * st;
        f[j * gw + i] = Math.sin(X * 0.0061 + p[0]) + 0.9 * Math.sin(Y * 0.0083 + p[1]) + 0.8 * Math.sin((X * 0.5 + Y * 0.9) * 0.0052 + p[2]) + 0.7 * Math.sin(Math.hypot(X - mx, Y - my) * 0.0042);
      }
      for (let lv = -16; lv <= 16; lv++) {
        const L = lv * 0.13;
        x.beginPath();
        for (let j = 0; j < gh - 1; j++) for (let i = 0; i < gw - 1; i++) {
          const a = f[j * gw + i], b = f[j * gw + i + 1], c2 = f[(j + 1) * gw + i + 1], d = f[(j + 1) * gw + i];
          const cs4 = (a > L ? 8 : 0) | (b > L ? 4 : 0) | (c2 > L ? 2 : 0) | (d > L ? 1 : 0);
          if (cs4 === 0 || cs4 === 15) continue;
          const X = i * st, Y = j * st;
          const T = () => [X + st * (L - a) / (b - a), Y], R = () => [X + st, Y + st * (L - b) / (c2 - b)];
          const B = () => [X + st * (L - d) / (c2 - d), Y + st], Lf = () => [X, Y + st * (L - a) / (d - a)];
          let seg;
          switch (cs4) {
            case 1: case 14: seg = [[Lf, B]]; break;
            case 2: case 13: seg = [[B, R]]; break;
            case 3: case 12: seg = [[Lf, R]]; break;
            case 4: case 11: seg = [[T, R]]; break;
            case 5: seg = [[T, Lf], [B, R]]; break;
            case 6: case 9: seg = [[T, B]]; break;
            case 7: case 8: seg = [[T, Lf]]; break;
            case 10: seg = [[T, R], [Lf, B]]; break;
          }
          for (const [u, v] of seg) { const pu = u(), pv = v(); x.moveTo(pu[0], pu[1]); x.lineTo(pv[0], pv[1]); }
        }
        x.strokeStyle = lv % 4 === 0 ? 'rgba(130,180,225,0.13)' : 'rgba(120,170,215,0.065)';
        x.lineWidth = lv % 4 === 0 ? 1.4 : 1;
        x.stroke();
      }
      const vg = x.createRadialGradient(cw / 2, ch / 2, Math.min(W, H) * 0.3, cw / 2, ch / 2, Math.max(W, H) * 0.75);
      vg.addColorStop(0, 'rgba(10,20,34,0)'); vg.addColorStop(1, 'rgba(4,9,16,0.7)');
      x.fillStyle = vg; x.fillRect(0, 0, cw, ch);
      return c;
    }

    function buildSprites(sc) {
      const px = Math.max(8, Math.round(cs * sc));
      const mk = fn => { const c = document.createElement('canvas'); c.width = c.height = px; const x = c.getContext('2d'); x.scale(px / cs, px / cs); fn(x); return c; };
      const gap = Math.max(1, cs * 0.045), r = cs * 0.15;
      const up = mk(x => {
        roundRect(x, gap, gap + cs * 0.055, cs - 2 * gap, cs - 2 * gap - cs * 0.02, r); x.fillStyle = 'rgba(60,100,150,0.75)'; x.fill();
        roundRect(x, gap, gap, cs - 2 * gap, cs - 2 * gap - cs * 0.045, r);
        const gr = x.createLinearGradient(0, gap, 0, cs - gap); gr.addColorStop(0, '#d3e6f6'); gr.addColorStop(0.55, '#a9c5e2'); gr.addColorStop(1, '#7c9fc4');
        x.fillStyle = gr; x.fill();
        roundRect(x, gap + 0.8, gap + 0.8, cs - 2 * gap - 1.6, cs - 2 * gap - cs * 0.045 - 1.6, r - 0.8);
        const hg = x.createLinearGradient(0, gap, 0, cs * 0.6); hg.addColorStop(0, 'rgba(255,255,255,0.95)'); hg.addColorStop(0.4, 'rgba(255,255,255,0.15)'); hg.addColorStop(1, 'rgba(255,255,255,0)');
        x.strokeStyle = hg; x.lineWidth = 1.4; x.stroke();
      });
      const down = mk(x => {
        roundRect(x, gap, gap, cs - 2 * gap, cs - 2 * gap, r * 0.9); x.fillStyle = 'rgba(14,28,46,0.78)'; x.fill();
        roundRect(x, gap + 0.5, gap + 0.5, cs - 2 * gap - 1, cs - 2 * gap - 1, r * 0.9);
        const sg = x.createLinearGradient(0, gap, 0, cs - gap); sg.addColorStop(0, 'rgba(0,0,0,0.38)'); sg.addColorStop(0.35, 'rgba(0,0,0,0)'); sg.addColorStop(0.9, 'rgba(150,200,240,0.07)'); sg.addColorStop(1, 'rgba(150,200,240,0.14)');
        x.strokeStyle = sg; x.lineWidth = 1.2; x.stroke();
      });
      return { px, sc, cs, up, down };
    }

    function drawMineIcon(ctx, cx, cy, r, glow) {
      ctx.save(); ctx.translate(cx, cy);
      if (glow > 0) {
        const gr = ctx.createRadialGradient(0, 0, 0, 0, 0, r * 2.4); gr.addColorStop(0, `rgba(255,120,80,${0.55 * glow})`); gr.addColorStop(1, 'rgba(255,120,80,0)');
        ctx.fillStyle = gr; ctx.fillRect(-r * 2.4, -r * 2.4, r * 4.8, r * 4.8);
      }
      ctx.strokeStyle = '#06090e'; ctx.lineWidth = Math.max(1.5, r * 0.28); ctx.lineCap = 'round';
      ctx.beginPath();
      for (let k = 0; k < 8; k++) { const a = k * Math.PI / 4; ctx.moveTo(Math.cos(a) * r * 0.6, Math.sin(a) * r * 0.6); ctx.lineTo(Math.cos(a) * r * 1.25, Math.sin(a) * r * 1.25); }
      ctx.stroke();
      ctx.fillStyle = '#0a0f17'; ctx.beginPath(); ctx.arc(0, 0, r, 0, TAU); ctx.fill();
      ctx.strokeStyle = 'rgba(170,200,230,0.35)'; ctx.lineWidth = 1; ctx.stroke();
      ctx.fillStyle = 'rgba(255,255,255,0.55)'; ctx.beginPath(); ctx.arc(-r * 0.35, -r * 0.35, r * 0.22, 0, TAU); ctx.fill();
      ctx.restore();
    }
    function drawFlag(ctx, cx, cy, s, a) {
      ctx.save(); ctx.globalAlpha *= a; ctx.translate(cx, cy);
      ctx.fillStyle = 'rgba(10,20,34,0.35)'; ctx.beginPath(); ctx.ellipse(0, s * 0.34, s * 0.26, s * 0.07, 0, 0, TAU); ctx.fill();
      ctx.strokeStyle = '#2a3a4e'; ctx.lineWidth = Math.max(1.5, s * 0.07); ctx.lineCap = 'round';
      ctx.beginPath(); ctx.moveTo(-s * 0.08, s * 0.34); ctx.lineTo(-s * 0.08, -s * 0.34); ctx.stroke();
      const gr = ctx.createLinearGradient(0, -s * 0.34, 0, 0); gr.addColorStop(0, '#ff7a72'); gr.addColorStop(1, '#d6303c');
      ctx.fillStyle = gr; ctx.beginPath(); ctx.moveTo(-s * 0.06, -s * 0.34); ctx.lineTo(s * 0.32, -s * 0.17); ctx.lineTo(-s * 0.06, 0); ctx.closePath(); ctx.fill();
      ctx.restore();
    }

    function drawBg(ctx) {
      if (cache) ctx.drawImage(cache.c, -cache.pad + Math.sin(g.t * 0.05) * 18, -cache.pad + Math.cos(g.t * 0.037) * 14, cache.w, cache.h);
      else { ctx.fillStyle = '#0f1d30'; ctx.fillRect(0, 0, W, H); }
      // snow
      ctx.fillStyle = '#dcecff';
      for (const f of snow) {
        ctx.globalAlpha = f.a;
        const x = ((f.x + Math.sin(g.t * 0.3 + f.ph) * 0.01) % 1) * W, y = f.y * H;
        ctx.beginPath(); ctx.arc(x, y, f.s, 0, TAU); ctx.fill();
      }
      ctx.globalAlpha = 1;
    }

    const ipg = () => [[[g], ['t'], 0, 't'], [snow, ['y'], 0.5]];
    function draw(ctx, w, h) {
      const sc = (ctx.getTransform ? ctx.getTransform().a : 1) || 1;
      if (!cache || cache.W !== W || cache.H !== H || cache.sc !== Math.min(sc, 2)) {
        const pad = 80, s2 = Math.min(sc, 2);
        cache = { W, H, sc: s2, pad, w: W + pad * 2, h: H + pad * 2, c: buildContours(W + pad * 2, H + pad * 2, s2) };
      }
      if (!sprites || sprites.sc !== sc || sprites.cs !== cs) sprites = buildSprites(sc);
      ctx.save();
      drawBg(ctx);
      if (g.shake > 0) { const a = g.shake * g.shake * 7; ctx.translate(Math.sin(g.t * 90) * a, Math.cos(g.t * 77) * a); }

      // slab behind the board
      const bw = GW * cs, bh = GH * cs, pad = cs * 0.45;
      ctx.save();
      roundRect(ctx, ox - pad, oy - pad, bw + pad * 2, bh + pad * 2, cs * 0.5);
      ctx.shadowColor = 'rgba(0,0,0,0.5)'; ctx.shadowBlur = cs * 1.2; ctx.shadowOffsetY = cs * 0.25;
      ctx.fillStyle = 'rgba(8,16,28,0.72)'; ctx.fill();
      ctx.restore();
      roundRect(ctx, ox - pad, oy - pad, bw + pad * 2, bh + pad * 2, cs * 0.5);
      ctx.strokeStyle = 'rgba(150,200,240,0.16)'; ctx.lineWidth = 1.5; ctx.stroke();

      const t = g.t, endLose = g.over && !g.won;
      const spx = sprites.up, dn = sprites.down;
      const fs = Math.round(cs * 0.6);
      ctx.font = `600 ${fs}px ${MONO}`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      const hoverI = Math.round(pilot.cy) * GW + Math.round(pilot.cx);

      for (let i = 0; i < N; i++) {
        const x = ox + (i % GW) * cs, y = oy + ((i / GW) | 0) * cs;
        const cxp = x + cs / 2, cyp = y + cs / 2;
        if (rev[i]) {
          const e = t - flipAt[i];
          if (e < 0) { ctx.drawImage(spx, x, y, cs, cs); }
          else if (e < FLIP) {
            const p = e / FLIP;
            if (p < 0.5) {
              const sx = Math.cos(p * Math.PI), lift = Math.sin(p * Math.PI) * cs * 0.1;
              ctx.drawImage(spx, cxp - cs * sx / 2, y - lift, cs * sx, cs);
            } else {
              const sx = -Math.cos(p * Math.PI);
              ctx.drawImage(dn, cxp - cs * sx / 2, y, cs * sx, cs);
            }
          } else {
            ctx.drawImage(dn, x, y, cs, cs);
            const n = num[i];
            if (n > 0) {
              ctx.fillStyle = NUMC[n];
              const pop = e < FLIP + 0.18 ? 1 + 0.25 * Math.sin((e - FLIP) / 0.18 * Math.PI) : 1;
              if (pop !== 1) { ctx.save(); ctx.translate(cxp, cyp); ctx.scale(pop, pop); ctx.fillText(n, 0, cs * 0.03); ctx.restore(); }
              else ctx.fillText(n, cxp, cyp + cs * 0.03);
            }
          }
        } else if (endLose && t >= popAt[i] && mine[i]) {
          ctx.drawImage(dn, x, y, cs, cs);
          const e = t - popAt[i];
          const hit = i === g.hit;
          if (hit) { ctx.fillStyle = `rgba(230,60,50,${0.55 - Math.min(0.25, e * 0.2)})`; roundRect(ctx, x + 1.5, y + 1.5, cs - 3, cs - 3, cs * 0.14); ctx.fill(); }
          const sc2 = e < 0.35 ? ease.outBack(e / 0.35) : 1;
          drawMineIcon(ctx, cxp, cyp, cs * 0.2 * sc2, Math.max(0, 1 - e * 1.1));
          if (flag[i]) drawFlag(ctx, cxp, cyp - cs * 0.02, cs * 0.5, 0.5);
        } else {
          // hidden tile (maybe flagged)
          ctx.drawImage(spx, x, y, cs, cs);
          if (i === hoverI && !g.over) { ctx.fillStyle = 'rgba(255,255,255,0.2)'; roundRect(ctx, x + cs * 0.045, y + cs * 0.045, cs * 0.91, cs * 0.87, cs * 0.14); ctx.fill(); }
          if (flag[i]) {
            const fe = t - flagT[i];
            if (fe >= 0) {
              const k = Math.min(1, fe / 0.5), drop = (1 - bounceOut(k)) * cs * 1.4;
              drawFlag(ctx, cxp, cyp - drop - cs * 0.02, cs * 0.62, Math.min(1, fe * 6));
            }
          }
        }
      }
      // glints (frost sparkle on hidden tiles)
      ctx.save(); ctx.globalCompositeOperation = 'lighter';
      for (const gl of glints) {
        const k = (t - gl.t0) / 0.7; if (k < 0 || k > 1) continue;
        const x = ox + ((gl.i % GW) + gl.fx) * cs, y = oy + (((gl.i / GW) | 0) + gl.fy) * cs, r = cs * 0.2 * Math.sin(k * Math.PI);
        ctx.strokeStyle = 'rgba(255,255,255,0.9)'; ctx.lineWidth = 1.3;
        ctx.beginPath(); ctx.moveTo(x - r, y); ctx.lineTo(x + r, y); ctx.moveTo(x, y - r); ctx.lineTo(x, y + r); ctx.stroke();
      }
      ctx.restore();

      // win sweep
      if (g.won) {
        const k = (t - g.winT) / 2.0;
        if (k >= 0 && k < 1.6) {
          const diag = GW + GH * 0.8, pos = k * (diag + 8) - 4;
          ctx.save(); ctx.beginPath(); roundRect(ctx, ox - pad, oy - pad, bw + pad * 2, bh + pad * 2, cs * 0.5); ctx.clip();
          ctx.globalCompositeOperation = 'lighter';
          for (let i = 0; i < N; i++) {
            const d = ((i % GW) + ((i / GW) | 0) * 0.8) - pos, a = Math.exp(-d * d / 6);
            if (a < 0.03) continue;
            ctx.fillStyle = `rgba(190,230,255,${a * 0.5})`;
            ctx.fillRect(ox + (i % GW) * cs, oy + ((i / GW) | 0) * cs, cs, cs);
          }
          const bx = ox + pos * cs;
          const lg = ctx.createLinearGradient(bx - cs * 6, 0, bx + cs * 6, 0);
          lg.addColorStop(0, 'rgba(180,225,255,0)'); lg.addColorStop(0.5, 'rgba(220,242,255,0.28)'); lg.addColorStop(1, 'rgba(180,225,255,0)');
          ctx.fillStyle = lg; ctx.fillRect(bx - cs * 6, oy - pad, cs * 12, bh + pad * 2);
          ctx.restore();
        }
      }

      // rings
      for (const r of rings) {
        const k = (t - r.t0) / r.dur; if (k < 0 || k > 1) continue;
        ctx.strokeStyle = `rgba(${r.col},${(1 - k) * 0.8})`; ctx.lineWidth = r.lw * (1 - k * 0.6);
        ctx.beginPath(); ctx.arc(r.x, r.y, r.r0 + (r.r1 - r.r0) * ease.outCubic(k), 0, TAU); ctx.stroke();
      }
      P.draw(ctx, 1);

      // cursor
      if (!g.over || g.won) {
        const px = ox + (pilot.cx + 0.5) * cs, py = oy + (pilot.cy + 0.5) * cs;
        const tr = pilot.trail;
        for (let k = 0; k < tr.length; k += 2) {
          const a = (k / tr.length) * 0.18;
          ctx.fillStyle = `rgba(220,240,255,${a})`;
          ctx.beginPath(); ctx.arc(ox + (tr[k] + 0.5) * cs, oy + (tr[k + 1] + 0.5) * cs, cs * 0.13 * (k / tr.length), 0, TAU); ctx.fill();
        }
        const guessing = pilot.target && pilot.target.guess;
        const pulse = 0.5 + 0.5 * Math.sin(t * 6);
        const col = guessing ? '255,208,120' : '255,255,255';
        const gr = ctx.createRadialGradient(px, py, 0, px, py, cs * 1.0);
        gr.addColorStop(0, `rgba(${col},${guessing ? 0.25 : 0.16})`); gr.addColorStop(1, `rgba(${col},0)`);
        ctx.fillStyle = gr; ctx.fillRect(px - cs, py - cs, cs * 2, cs * 2);
        const cr = cs * (0.4 + (guessing ? pulse * 0.05 : 0)) * (1 + 0.25 * Math.max(0, 1 - (t - pilot.pulse) / 0.18));
        ctx.strokeStyle = `rgba(${col},0.92)`; ctx.lineWidth = Math.max(1.6, cs * 0.055);
        ctx.beginPath(); ctx.arc(px, py, cr, 0, TAU); ctx.stroke();
        if (pilot.thinking) {
          ctx.strokeStyle = 'rgba(255,255,255,0.55)'; ctx.lineWidth = Math.max(1.5, cs * 0.04);
          ctx.beginPath(); ctx.arc(px, py, cr + cs * 0.17, t * 5, t * 5 + 1.6); ctx.stroke();
        }
        ctx.fillStyle = `rgba(${col},0.9)`; ctx.beginPath(); ctx.arc(px, py, cs * 0.045, 0, TAU); ctx.fill();
      }
      ctx.restore();
      if (g.flash > 0) { ctx.fillStyle = `rgba(255,190,150,${g.flash * 0.35})`; ctx.fillRect(0, 0, W, H); }
      if (twist && g.t < 6) {   // twist callout, frosted banner with a hazard-orange rim
        const k = Math.min(1, g.t / 0.4) * Math.min(1, (6 - g.t) / 0.8), bw = Math.min(W * 0.7, cs * 14), bh = cs * 1.5, bx = W / 2 - bw / 2, by = oy - bh - cs * 0.3 > 4 ? oy - bh - cs * 0.3 : oy + cs * 0.3;
        ctx.save(); ctx.globalAlpha = k; roundRect(ctx, bx, by, bw, bh, bh * 0.25); ctx.fillStyle = 'rgba(15,27,43,0.88)'; ctx.fill();
        ctx.lineWidth = Math.max(2, cs * 0.1); ctx.strokeStyle = '#ff8a4a'; ctx.stroke();
        ctx.fillStyle = '#ffb27a'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.font = `700 ${cs * 0.62}px ${MONO}`;
        ctx.fillText('TWIST: ' + twist.name.toUpperCase(), W / 2, by + bh * 0.36);
        ctx.fillStyle = '#cfe6ff'; ctx.font = `500 ${cs * 0.4}px ${MONO}`; ctx.fillText(twist.key === 'dense' ? `${gm} mines instead of ${GM}` : 'first reveal may be a number', W / 2, by + bh * 0.74);
        ctx.restore();
      }
    }

    return {
      twist,
      get over() { return g.over; }, get won() { return g.won; },
      resize(w, h) {
        W = w; H = h;
        cs = Math.max(8, Math.min(W * 0.88 / GW, H * 0.88 / GH));
        ox = (W - GW * cs) / 2; oy = (H - GH * cs) / 2;
        if (ox < 370) { // keep clear of the shell HUD box (bottom-left, ~360x100 px)
          const top = H * 0.03, bottom = H - 104;
          cs = Math.max(8, Math.min(W * 0.9 / GW, (bottom - top) / (GH + 0.9)));
          ox = (W - GW * cs) / 2; oy = (top + bottom) / 2 - GH * cs / 2;
        }
        sprites = null;
      },
      step(dt) {
        IP.snap(ipg());
        g.t += dt;
        const t = g.t;
        P.update(dt);
        for (const f of snow) { f.y += f.vy * dt; if (f.y > 1.02) { f.y = -0.02; f.x = Math.random(); } }
        if (g.flash > 0) g.flash = Math.max(0, g.flash - dt * 3);
        if (g.shake > 0) g.shake = Math.max(0, g.shake - dt * 2.2);
        for (let i = rings.length - 1; i >= 0; i--) if (t - rings[i].t0 > rings[i].dur + 0.1) rings.splice(i, 1);
        for (let i = glints.length - 1; i >= 0; i--) if (t - glints[i].t0 > 0.8) glints.splice(i, 1);
        if (!g.over && Math.random() < dt * 5 && !g.first) {
          const i = rnd.int(N);
          if (!rev[i]) glints.push({ i, t0: t, fx: rnd.float(0.2, 0.8), fy: rnd.float(0.15, 0.55) });
        }
        if (g.over && !g.won) {
          // mine pops in sequence
          while (popIdx < popList.length && t >= popAt[popList[popIdx]]) {
            const m = popList[popIdx++];
            const [px, py] = cellPx(m);
            P.burst(px, py, 9, { speed: cs * 5, speedMin: cs * 1, life: 0.8, size: cs * 0.09, color: ['#ffd9a0', '#ff9a66', '#ffffff'], drag: 3, gravity: cs * 4 });
            rings.push({ x: px, y: py, t0: t, dur: 0.45, r0: cs * 0.2, r1: cs * 1.4, col: '255,170,120', lw: 2 });
          }
        }
        if (g.won) {
          const k = t - g.winT;
          if (Math.random() < dt * 14 && k < 2.4) {
            const x = ox + Math.random() * GW * cs, y = oy + Math.random() * GH * cs;
            P.burst(x, y, 5, { speed: cs * 3, speedMin: cs * 0.5, life: 1, size: cs * 0.07, color: ['#ffffff', '#bfe3ff', '#8fd0ff'], drag: 2.5 });
          }
        }
        if (!g.over) {
          pilotStep(dt);
          if (t > CAP_SECONDS) { g.over = true; g.won = false; g.reason = 'Out of time'; g.loseT = t; }
        } else {
          pilot.trail.length = 0;
        }
      },
      draw(ctx, w, h) { const a = IP.alpha(), st = IP.push(ipg(), a); try { draw(ctx, w, h); } finally { IP.pop(st); } },
      hud() {
        const left = gm - g.flags;
        return { score: `${Math.round(g.revealed / safe * 100)}% cleared`, detail: `${left} mines left · ${g.clicks} clicks` };
      },
      result() { return this.result0() + ` (${sty.name})`; },
      result0() {
        const pct = Math.round(g.revealed / safe * 100);
        if (g.won) return `Swept all ${gm} mines in ${g.clicks} clicks`;
        if (g.reason) return g.reason;
        return g.lastGuessP >= 0 && g.hit >= 0
          ? `Hit a mine on a ${Math.round(g.lastGuessP * 100)}% guess with ${pct}% cleared`
          : `Hit a mine with ${pct}% cleared`;
      },
    };
  }

  Arcade.register({
    id: 'mines', name: 'Frostfield', genre: 'Minesweeper', bg: '#0f1b2b', accent: '#7fc4ff',
    aiNote: "Sees only revealed numbers and its own flags; weighs mine probabilities, guesses only when forced, and moves a human-speed cursor.",
    blurb: 'Probability-driven sweep of a 99-mine frozen field.',
    twists: TWISTS, create,
  });
})();
