// gems.js — Velvet Facets (match three). See DESIGN.md game 8.5 #1. Endless: a time bar drains, matches refill it.
(() => {
'use strict';

  // ---- render interpolation: the shell sets Arcade.alpha (0..1) before each draw; gems keep px,py (previous step).
  const alphaNow = () => { const a = Arcade.alpha; return a === undefined ? 1 : Math.max(0, Math.min(1, a)); };
  // ---- offscreen layer helper: the static velvet backdrop is painted once per canvas size and blitted.
  const _layers = {};
  function staticLayer(ctx, key, W, H, paint) {
    const sc = Math.min(2, (ctx.getTransform ? ctx.getTransform().a : 1) || 1);
    let l = _layers[key];
    if (!l || l.W !== W || l.H !== H || l.sc !== sc) {
      const c = document.createElement('canvas'); c.width = Math.max(1, Math.ceil(W * sc)); c.height = Math.max(1, Math.ceil(H * sc));
      l = _layers[key] = { c, x: c.getContext('2d'), W, H, sc, fresh: true };
    }
    if (l.fresh) { l.fresh = false; l.x.setTransform(l.sc, 0, 0, l.sc, 0, 0); paint(l.x, W, H); }
    ctx.drawImage(l.c, 0, 0, W, H);
  }

  const N = 8, NN = 64;
  const EMPTY = -2, BOMB = -1;
  // jewels: ruby, topaz, emerald, aquamarine, sapphire, amethyst, rose quartz (each also has its own silhouette)
  const HUE = [352, 36, 148, 186, 222, 282, 322];
  const NAMES = ['ruby', 'topaz', 'emerald', 'aquamarine', 'sapphire', 'amethyst', 'rose quartz'];
  const PAR_SCORE = 31000;
  const TIME_CAP = 900;
  const REFILL = 0.0135, BAR_START = 0.85;

  const TWISTS = [
    { key: 'locks', name: 'Locked gems', desc: 'Chains snap onto gems; a match or blast must reach them to break free.' },
    { key: 'surge', name: 'Fast drain', desc: 'The time bar drains faster, with sudden surges.' },
  ];

  // ---------------------------------------------------------------------------------------------
  // Pure board logic, shared by the game and the AI's lookahead. A board B = {c, sp, lk} (Int8Array x64):
  //   c  colour 0..6, -1 colour bomb, -2 empty;  sp 0 none, 1 row blast, 2 column blast, 3 bomb, 4 nova (3x3);  lk lock strength.
  // ---------------------------------------------------------------------------------------------
  const newBoard = () => ({ c: new Int8Array(NN).fill(EMPTY), sp: new Int8Array(NN), lk: new Int8Array(NN) });
  const cloneB = B => ({ c: B.c.slice(), sp: B.sp.slice(), lk: B.lk.slice() });
  function swapAll(B, a, b) {
    for (const k of ['c', 'sp', 'lk']) { const t = B[k][a]; B[k][a] = B[k][b]; B[k][b] = t; }
  }
  function runAt(c, i, col) {
    const x = i % N, y = (i / N) | 0;
    let n = 1;
    for (let k = x - 1; k >= 0 && c[y * N + k] === col; k--) n++;
    for (let k = x + 1; k < N && c[y * N + k] === col; k++) n++;
    if (n >= 3) return true;
    n = 1;
    for (let k = y - 1; k >= 0 && c[k * N + x] === col; k--) n++;
    for (let k = y + 1; k < N && c[k * N + x] === col; k++) n++;
    return n >= 3;
  }
  function swapOK(B, a, b) {
    const ca = B.c[a], cb = B.c[b];
    if (ca === EMPTY || cb === EMPTY || B.lk[a] || B.lk[b]) return false;
    if (B.sp[a] === 3 || B.sp[b] === 3) return true;
    if (ca === cb) return false;
    B.c[a] = cb; B.c[b] = ca;
    const ok = runAt(B.c, a, cb) || runAt(B.c, b, ca);
    B.c[a] = ca; B.c[b] = cb;
    return ok;
  }
  function eachPair(fn) {
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
      const i = y * N + x;
      if (x < N - 1) fn(i, i + 1);
      if (y < N - 1) fn(i, i + N);
    }
  }
  function countMoves(B, cap) {
    let n = 0;
    eachPair((a, b) => { if (n < cap && swapOK(B, a, b)) n++; });
    return n;
  }
  function hasMatches(B) {
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
      const i = y * N + x, col = B.c[i];
      if (col >= 0 && runAt(B.c, i, col)) return true;
    }
    return false;
  }
  function findRuns(c) {
    const runs = [];
    for (let r = 0; r < N; r++) {
      let k = 0;
      while (k < N) {
        const col = c[r * N + k];
        if (col < 0) { k++; continue; }
        let j = k + 1; while (j < N && c[r * N + j] === col) j++;
        if (j - k >= 3) { const cells = []; for (let q = k; q < j; q++) cells.push(r * N + q); runs.push({ h: true, len: j - k, col, cells }); }
        k = j;
      }
    }
    for (let x = 0; x < N; x++) {
      let k = 0;
      while (k < N) {
        const col = c[k * N + x];
        if (col < 0) { k++; continue; }
        let j = k + 1; while (j < N && c[j * N + x] === col) j++;
        if (j - k >= 3) { const cells = []; for (let q = k; q < j; q++) cells.push(q * N + x); runs.push({ h: false, len: j - k, col, cells }); }
        k = j;
      }
    }
    return runs;
  }
  // The cells a swap forces to detonate (colour bomb swaps).
  function bombForced(B, a, b) {
    if (B.sp[a] !== 3 && B.sp[b] !== 3) return null;
    const out = [];
    if (B.sp[a] === 3 && B.sp[b] === 3) { for (let i = 0; i < NN; i++) if (B.c[i] !== EMPTY) out.push(i); return { cells: out, done: [a, b] }; }
    const bi = B.sp[a] === 3 ? a : b, oi = bi === a ? b : a, col = B.c[oi];
    out.push(bi);
    for (let i = 0; i < NN; i++) if (B.c[i] === col && B.c[i] >= 0) out.push(i);
    return { cells: out, done: [bi] };
  }
  // One clearing wave: which cells are hit, which specials get created, which specials fire. Does not mutate.
  function wave(B, forced, hints) {
    const runs = findRuns(B.c);
    if (!runs.length && !(forced && forced.cells.length)) return null;
    const set = new Uint8Array(NN), done = new Uint8Array(NN);
    const hm = new Int8Array(NN).fill(-1), vm = new Int8Array(NN).fill(-1);
    const make = [], makeAt = new Uint8Array(NN);
    for (let ri = 0; ri < runs.length; ri++) {
      const r = runs[ri];
      for (const i of r.cells) { set[i] = 1; if (r.h) hm[i] = ri; else vm[i] = ri; }
    }
    for (const r of runs) {
      if (r.len < 4) continue;
      let o = r.cells[(r.len - 1) >> 1];
      if (hints) for (const h of hints) if (r.cells.includes(h)) { o = h; break; }
      if (B.lk[o] || makeAt[o]) continue;
      makeAt[o] = 1; make.push({ i: o, sp: r.len >= 5 ? 3 : (r.h ? 1 : 2), c: r.len >= 5 ? BOMB : r.col });
    }
    for (let i = 0; i < NN; i++) {
      if (hm[i] < 0 || vm[i] < 0 || makeAt[i] || B.lk[i]) continue;
      if (runs[hm[i]].len >= 4 || runs[vm[i]].len >= 4) continue;
      makeAt[i] = 1; make.push({ i, sp: 4, c: B.c[i] });
    }
    for (const m of make) set[m.i] = 0;
    const q = [];
    for (let i = 0; i < NN; i++) if (set[i]) q.push(i);
    if (forced) { for (const i of forced.cells) if (!set[i]) { set[i] = 1; q.push(i); } for (const i of forced.done) done[i] = 1; }
    const trig = [];
    const add = i => { if (!set[i]) { set[i] = 1; q.push(i); } };
    while (q.length) {
      const i = q.pop();
      const s = B.sp[i];
      if (!s || B.lk[i] || done[i]) continue;
      done[i] = 1; trig.push(i);
      const x = i % N, y = (i / N) | 0;
      if (s === 1) for (let k = 0; k < N; k++) add(y * N + k);
      else if (s === 2) for (let k = 0; k < N; k++) add(k * N + x);
      else if (s === 4) { for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const nx = x + dx, ny = y + dy; if (nx >= 0 && nx < N && ny >= 0 && ny < N) add(ny * N + nx); } }
      else if (s === 3) {              // a bomb caught in a blast: clears the most common colour on the board
        const cnt = new Int8Array(8); for (let k = 0; k < NN; k++) if (B.c[k] >= 0) cnt[B.c[k]]++;
        let bc = 0; for (let k = 1; k < 7; k++) if (cnt[k] > cnt[bc]) bc = k;
        for (let k = 0; k < NN; k++) if (B.c[k] === bc) add(k);
      }
    }
    const cells = [];
    for (let i = 0; i < NN; i++) if (set[i]) cells.push(i);
    const keep = make.filter(m => !set[m.i]);
    return { cells, make: keep, trig, forced: !!forced };
  }
  // Applies a wave to B (no refill). Returns tallies.
  function applyWave(B, w) {
    let cleared = 0, locks = 0, low = 0;
    for (const i of w.cells) {
      if (B.lk[i] > 0) { B.lk[i]--; locks++; }
      else { B.c[i] = EMPTY; B.sp[i] = 0; cleared++; low += (i / N | 0) / 7; }
    }
    for (const m of w.make) { B.c[m.i] = m.c; B.sp[m.i] = m.sp; }
    return { cleared, locks, low };
  }
  function settle(B) {
    for (let x = 0; x < N; x++) {
      let wr = N - 1;
      for (let y = N - 1; y >= 0; y--) {
        const i = y * N + x;
        if (B.c[i] !== EMPTY) {
          if (wr !== y) { const j = wr * N + x; B.c[j] = B.c[i]; B.sp[j] = B.sp[i]; B.lk[j] = B.lk[i]; B.c[i] = EMPTY; B.sp[i] = 0; B.lk[i] = 0; }
          wr--;
        }
      }
    }
  }
  const waveScore = (cleared, chain, trig, made) => cleared * 10 * chain + trig * 40 + made * 60;
  const waveRefill = (cleared, chain, made) => REFILL * cleared * (1 + 0.5 * (chain - 1)) + made * 0.02;

  // Plays a swap out on a copy of the board, following the cascade through the VISIBLE gems only (refills are unknown).
  function playOut(B0, a, b, needMob) {
    const B = cloneB(B0);
    const forced = bombForced(B, a, b);
    swapAll(B, a, b);
    let forcedUse = forced, chain = 0;
    const po = { gems: 0, score: 0, refill: 0, makes: 0, trig: 0, locks: 0, low: 0, chain: 0, mob: 0, B, usedSpecial: !!forced };
    for (let g = 0; g < 12; g++) {
      const w = wave(B, forcedUse, g === 0 ? [a, b] : null);
      if (!w) break;
      chain++;
      const t = applyWave(B, w);
      po.gems += t.cleared; po.locks += t.locks; po.low += t.low;
      po.score += waveScore(t.cleared, chain, w.trig.length, w.make.length);
      po.refill += waveRefill(t.cleared, chain, w.make.length);
      po.makes += w.make.length; po.trig += w.trig.length;
      settle(B); forcedUse = null;
    }
    po.chain = chain;
    po.low = po.gems ? po.low / po.gems : 0;
    if (needMob) po.mob = countMoves(B, 8);
    return po;
  }

  // ---------------------------------------------------------------------------------------------
  // AI. It sees only what is on screen: the settled 8x8 board (colours, specials, chains) and the time bar.
  // It cannot see the gems that will drop in from above the board, so every look-ahead leaves those cells empty.
  // It acts through a single swap per decision, after a human "reading" delay and a short aiming hover.
  // The search is a generator that is advanced a few evaluations per step to keep each step cheap.
  // ---------------------------------------------------------------------------------------------
  const STYLES = [
    { name: 'Bottom-feeder', read: 0.32, hover: 0.16, wMake: 3, wTrig: 2, wLock: 1.5, wLow: 3.2, wMob: 0.6, wChain: 1.2 },
    { name: 'Specialist', read: 0.34, hover: 0.16, wMake: 8, wTrig: 3.5, wLock: 1.5, wLow: 0.8, wMob: 0.5, wChain: 1.5 },
    { name: 'Quick hands', read: 0.10, hover: 0.05, wMake: 2.5, wTrig: 2, wLock: 1.5, wLow: 0.8, wMob: 0.1, wChain: 1.0 },
    { name: 'Locksmith', read: 0.32, hover: 0.15, wMake: 3.5, wTrig: 2, wLock: 6, wLow: 1.2, wMob: 0.5, wChain: 1.2 },
  ];
  const SUPER_STYLE = { name: 'Super AI', read: 0, hover: 0, wMake: 5, wTrig: 3, wLock: 3, wLow: 1.5, wMob: 0.7, wChain: 1.5 };

  function makeAI(S, sup) {
    const ai = { gen: null, wait: 0, hover: 0, plan: null, done: false, budget: sup ? 140 : 9 };
    function value(po, obs, second) {
      const low = obs.bar < 0.35, u = low ? 1.5 : 1;
      let v = po.refill * 100 * u + S.wMake * po.makes * (low ? 0.5 : 1) + S.wTrig * po.trig + S.wLock * po.locks + S.wLow * po.low * (po.gems ? 1 : 0) + S.wChain * po.chain;
      if (!second) v += S.wMob * po.mob * (low ? 0.3 : 1);
      return v;
    }
    function* search(obs) {
      const B = obs.board, res = [];
      const cand = [];
      eachPair((a, b) => { if (swapOK(B, a, b)) cand.push([a, b]); });
      for (const [a, b] of cand) {
        const po = playOut(B, a, b, S.wMob > 0);
        res.push({ a, b, v: value(po, obs, false) + (sup ? 0 : Math.random() * 0.8), po });
        yield;
      }
      if (sup && res.length) {
        // 2-ply over the visible board: best follow-up on the board left after the first move settles
        res.sort((x, y) => y.v - x.v);
        for (const r of res.slice(0, 6)) {
          let best = 0;
          const B1 = r.po.B, c2 = [];
          eachPair((a, b) => { if (swapOK(B1, a, b)) c2.push([a, b]); });
          for (const [a, b] of c2) { const p2 = playOut(B1, a, b, false); const v2 = value(p2, obs, true); if (v2 > best) best = v2; yield; }
          r.v += 0.6 * best;
        }
      }
      let bst = null;
      for (const r of res) if (!bst || r.v > bst.v) bst = r;
      return bst ? [bst.a, bst.b] : null;
    }
    ai.reset = () => { ai.gen = null; ai.plan = null; ai.done = false; };
    // returns {hint:[a,b]} while aiming, {go:[a,b]} to swap, {stuck:true} if nothing is playable, else null
    ai.act = (obs, dt) => {
      if (!ai.gen) { ai.gen = search(obs); ai.wait = S.read; ai.hover = S.hover; ai.plan = null; ai.done = false; }
      if (!ai.done) {
        for (let k = 0; k < ai.budget; k++) { const r = ai.gen.next(); if (r.done) { ai.done = true; ai.plan = r.value; break; } }
      }
      ai.wait -= dt;
      if (!ai.done || ai.wait > 0) return null;
      if (!ai.plan) return { stuck: true };
      if (ai.hover > 0) { ai.hover -= dt; return { hint: ai.plan }; }
      return { go: ai.plan };
    };
    return ai;
  }

  // ---------------------------------------------------------------------------------------------
  // Gem artwork: faceted sprites (cached per colour and size), specials and chains drawn live.
  // ---------------------------------------------------------------------------------------------
  const poly = (n, r, a0, rx = 1, ry = 1) => { const p = []; for (let i = 0; i < n; i++) { const a = a0 + i * TAU / n; p.push([Math.cos(a) * r * rx, Math.sin(a) * r * ry]); } return p; };
  const oct = (ax, ay, cut) => [[-ax + cut, -ay], [ax - cut, -ay], [ax, -ay + cut], [ax, ay - cut], [ax - cut, ay], [-ax + cut, ay], [-ax, ay - cut], [-ax, -ay + cut]];
  const SHAPES = [
    poly(12, 0.92, 0),                                                     // ruby: round brilliant
    [[0, -0.97], [0.46, -0.52], [0.82, 0], [0.46, 0.52], [0, 0.97], [-0.46, 0.52], [-0.82, 0], [-0.46, -0.52]], // topaz: marquise-ish diamond
    oct(0.7, 0.92, 0.28),                                                  // emerald cut
    poly(6, 0.95, TAU / 12),                                               // aquamarine hexagon
    oct(0.86, 0.86, 0.3),                                                  // sapphire cushion
    poly(5, 0.97, -TAU / 4),                                               // amethyst pentagon
    [[0, -0.98], [0.34, -0.4], [0.9, 0.62], [0.74, 0.8], [-0.74, 0.8], [-0.9, 0.62], [-0.34, -0.4]], // rose quartz trillion
  ];
  const _spr = {};
  function gemSprite(ci, px) {
    const key = ci + '_' + px;
    if (_spr[key]) return _spr[key];
    const cv = document.createElement('canvas'); cv.width = cv.height = px;
    const g = cv.getContext('2d');
    g.translate(px / 2, px / 2); g.scale(px / 2 * 0.97, px / 2 * 0.97);
    const P = SHAPES[ci], h = HUE[ci], n = P.length;
    const ctr = P.reduce((s, p) => [s[0] + p[0] / n, s[1] + p[1] / n], [0, 0]);
    const T = P.map(p => [ctr[0] + (p[0] - ctr[0]) * 0.56, ctr[1] + (p[1] - ctr[1]) * 0.56 - 0.03]);
    // body glow / base
    g.beginPath(); P.forEach((p, i) => (i ? g.lineTo(p[0], p[1]) : g.moveTo(p[0], p[1]))); g.closePath();
    g.fillStyle = `hsl(${h},70%,26%)`; g.fill();
    // crown facets (quads between rim and table), shaded by facing the light from the upper left
    const L = [-0.62, -0.78];
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n, a = P[i], b = P[j];
      const mx = (a[0] + b[0]) / 2 - ctr[0], my = (a[1] + b[1]) / 2 - ctr[1], ml = Math.hypot(mx, my) || 1;
      const d = (mx * L[0] + my * L[1]) / ml;
      g.beginPath(); g.moveTo(a[0], a[1]); g.lineTo(b[0], b[1]); g.lineTo(T[j][0], T[j][1]); g.lineTo(T[i][0], T[i][1]); g.closePath();
      g.fillStyle = `hsl(${h + (d < 0 ? 6 : -4)},${72 + d * 8}%,${44 + d * 26}%)`; g.fill();
      g.strokeStyle = `hsla(${h},80%,${60 + d * 20}%,0.35)`; g.lineWidth = 0.02; g.stroke();
    }
    // table
    const gr = g.createLinearGradient(-0.5, -0.6, 0.5, 0.6);
    gr.addColorStop(0, `hsl(${h - 4},85%,80%)`); gr.addColorStop(0.5, `hsl(${h},78%,56%)`); gr.addColorStop(1, `hsl(${h + 8},72%,34%)`);
    g.beginPath(); T.forEach((p, i) => (i ? g.lineTo(p[0], p[1]) : g.moveTo(p[0], p[1]))); g.closePath(); g.fillStyle = gr; g.fill();
    // star facets on the table
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      g.beginPath(); g.moveTo(ctr[0], ctr[1] - 0.03); g.lineTo(T[i][0], T[i][1]); g.lineTo(T[j][0], T[j][1]); g.closePath();
      g.fillStyle = i % 2 ? 'rgba(255,255,255,0.13)' : 'rgba(0,0,40,0.14)'; g.fill();
    }
    // rim: dark outline, bright upper-left edge
    g.beginPath(); P.forEach((p, i) => (i ? g.lineTo(p[0], p[1]) : g.moveTo(p[0], p[1]))); g.closePath();
    g.strokeStyle = `hsla(${h},70%,12%,0.9)`; g.lineWidth = 0.07; g.lineJoin = 'round'; g.stroke();
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n, a = P[i], b = P[j];
      const mx = (a[0] + b[0]) / 2 - ctr[0], my = (a[1] + b[1]) / 2 - ctr[1], d = (mx * L[0] + my * L[1]) / (Math.hypot(mx, my) || 1);
      if (d > 0.2) { g.beginPath(); g.moveTo(a[0] * 0.97, a[1] * 0.97); g.lineTo(b[0] * 0.97, b[1] * 0.97); g.strokeStyle = `rgba(255,255,255,${0.15 + d * 0.45})`; g.lineWidth = 0.035; g.stroke(); }
    }
    // specular
    const sg = g.createRadialGradient(-0.22, -0.3, 0, -0.22, -0.3, 0.3);
    sg.addColorStop(0, 'rgba(255,255,255,0.95)'); sg.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = sg; g.beginPath(); g.arc(-0.22, -0.3, 0.3, 0, TAU); g.fill();
    _spr[key] = cv;
    return cv;
  }
  let _glow = null;
  function glowSprite() {
    if (_glow) return _glow;
    const cv = document.createElement('canvas'); cv.width = cv.height = 96;
    const g = cv.getContext('2d'), gr = g.createRadialGradient(48, 48, 0, 48, 48, 48);
    gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(0.35, 'rgba(255,255,255,0.35)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = gr; g.fillRect(0, 0, 96, 96);
    return (_glow = cv);
  }
  function star4(ctx, x, y, r, rot) {
    ctx.beginPath();
    for (let i = 0; i < 8; i++) { const a = rot + i * Math.PI / 4, rr = i % 2 ? r * 0.18 : r; ctx.lineTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr); }
    ctx.closePath();
  }

  const fmt = n => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  const easeIO = t => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);

  // ---------------------------------------------------------------------------------------------
  // make sure the bundled faces are loaded before canvas text uses them (canvas does not trigger loading by itself)
  function loadFonts() {
    try { if (document.fonts && document.fonts.load) for (const f of ['600 40px Fraunces', '600 40px Fredoka', '600 40px "IBM Plex Mono"', '400 40px "IBM Plex Mono"']) document.fonts.load(f, '0123456789ABC\u00d7+'); } catch (e) { /* ok */ }
  }
  function create(opts = {}) {
    loadFonts();
    const sup = !!opts.superAI;
    const S = sup ? SUPER_STYLE : STYLES[(Math.random() * STYLES.length) | 0];
    const ai = makeAI(S, sup);
    let twist = null;
    if (opts.twist) twist = (typeof opts.twist === 'string' && TWISTS.find(t => t.key === opts.twist)) || rnd.pick(TWISTS);
    const parts = new Particles();
    const TS = sup ? 1.9 : 1;            // super AI: inhuman hands, so animations run faster too

    const inst = {
      over: false, won: false, superAI: sup, style: S.name, twist: twist ? { key: twist.key, name: twist.name, desc: twist.desc } : null,
      score: 0, t: 0,
    };
    let W = 800, H = 600, L = null;
    const grid = new Array(NN).fill(null);
    let phase = 'intro', phT = 0, tier = 0, bar = BAR_START, chain = 0, bestChain = 0, moves = 0, nextId = 1;
    let swapPair = null, curWave = null, hint = null, reason = '', endT = 0;
    let shake = 0, flashRed = 0, lockT = rnd.float(14, 22), surgeT = rnd.float(14, 22), surge = 0, sinceMove = 0;
    const fx = { shards: [], beams: [], rings: [], floats: [], banners: [], glints: [] };
    let glintCd = 0.2;
    const stars = [];
    for (let i = 0; i < 46; i++) stars.push({ u: Math.random(), v: Math.random(), s: rnd.float(0.4, 1.4), ph: rnd.float(0, 6.28), sp: rnd.float(0.05, 0.14), h: rnd.pick([280, 320, 40, 200]) });
    const blobs = [];
    for (let i = 0; i < 5; i++) blobs.push({ u: Math.random(), v: Math.random(), r: rnd.float(0.25, 0.5), h: rnd.pick([275, 300, 320, 255]), ph: rnd.float(0, 6.28), sp: rnd.float(0.02, 0.05) });

    const ncol = () => (tier < 2 ? 5 : tier < 5 ? 6 : 7);
    const drainRate = () => Math.min(0.12, 0.028 + 0.0075 * tier) * (twist && twist.key === 'surge' ? 1.1 : 1) * (surge > 0 ? 2.2 : 1);
    const refillScale = () => Math.max(0.5, 1 - 0.04 * tier);
    function lockChance() {
      let p = tier >= 2 ? Math.min(0.12, 0.025 * (tier - 1)) : 0;
      if (twist && twist.key === 'locks') p = Math.min(0.18, p * 1.6 + 0.04);
      return p;
    }
    function newGem(c, x, y, lk) {
      return { id: nextId++, c, sp: 0, lk: lk || 0, x, y, px: x, py: y, vy: 0, sc: 1, pop: 0, sq: 0, dying: -1, dead: false, ty: y, fx: 0, fy: 0, tx: 0, ty2: 0, flash: 0, shk: 0, dieAt: 0 };
    }
    function randGem(x, y, withLocks) {
      let lk = 0;
      if (withLocks && Math.random() < lockChance()) lk = tier >= 5 && Math.random() < 0.3 ? 2 : 1;
      return newGem(rnd.int(ncol()), x, y, lk);
    }
    function board() {
      const B = newBoard();
      for (let i = 0; i < NN; i++) { const g = grid[i]; if (g && g.dying < 0 && !g.dead) { B.c[i] = g.c; B.sp[i] = g.sp; B.lk[i] = g.lk; } }
      return B;
    }
    function fillInitial() {
      for (let guard = 0; guard < 50; guard++) {
        const B = newBoard();
        for (let i = 0; i < NN; i++) {
          let c; let tries = 0;
          do { c = rnd.int(ncol()); tries++; B.c[i] = c; } while (tries < 20 && runAt(B.c, i, c));
        }
        if (!hasMatches(B) && countMoves(B, 4) >= 3) {
          for (let i = 0; i < NN; i++) { const x = i % N, y = (i / N) | 0; const g = newGem(B.c[i], x, y - N - 1 - (N - y) * 0.0 - Math.random() * 0.6, 0); g.ty = y; grid[i] = g; g.py = g.y; }
          if (twist && twist.key === 'locks') for (let k = 0; k < 3; k++) { const g = grid[rnd.int(NN)]; if (g) g.lk = 1; }
          return;
        }
      }
    }
    // ---- cascade bookkeeping -------------------------------------------------------------------
    const ctr = i => ({ x: i % N, y: (i / N) | 0 });
    function px_(cx, cy) { return { x: L.bx + (cx + 0.5) * L.c, y: L.by + (cy + 0.5) * L.c }; }
    function banner(txt, o = {}) { if (o.chain) fx.banners = fx.banners.filter(b => !b.chain); fx.banners.push({ chain: !!o.chain, txt, t: 0, max: o.max || 1.5, hue: o.hue ?? 40, big: o.big || 1, font: o.font || 'Fraunces', y: o.y ?? 0.42 }); }
    function shatter(g, i, power = 1) {
      if (!L) return;
      const p = px_(g.x, g.y), h = g.c >= 0 ? HUE[g.c] : 300;
      for (let k = 0; k < 6; k++) {
        const a = rnd.float(0, TAU), sp = rnd.float(80, 300) * power;
        fx.shards.push({ x: p.x + Math.cos(a) * L.c * 0.15, y: p.y + Math.sin(a) * L.c * 0.15, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - 80, rot: rnd.float(0, 6.28), vr: rnd.float(-9, 9), s: rnd.float(0.14, 0.3) * L.c, h: h + rnd.float(-8, 8), t: 0, max: rnd.float(0.7, 1.3) });
      }
      parts.burst(p.x, p.y, 7, { color: [`hsl(${h},90%,75%)`, '#fff', `hsl(${h + 20},95%,65%)`], speed: 260 * power, life: 0.8, size: 4, drag: 3.2, gravity: 160 });
    }
    function startClear(w, hints) {
      curWave = w;
      chain++; if (chain > bestChain) bestChain = chain;
      let cleared = 0, cx = 0, cy = 0;
      for (const i of w.cells) {
        const g = grid[i]; if (!g) continue;
        if (g.lk > 0) {
          g.lk--; g.shk = 0.35; g.flash = 0.4;
          const p = px_(g.x, g.y);
          parts.burst(p.x, p.y, 10, { color: ['#d9c39a', '#fff0c8', '#a88c5a'], speed: 280, life: 0.6, size: 3.5, drag: 3 });
        } else { g.dying = 0; cleared++; const c = ctr(i); cx += c.x; cy += c.y; }
      }
      for (const m of w.make) {
        const g = grid[m.i]; if (!g) continue;
        g.c = m.c; g.sp = m.sp; g.pop = 0.0001; g.flash = 0.6;
        const p = px_(g.x, g.y);
        fx.rings.push({ x: p.x, y: p.y, t: 0, max: 0.6, r: L.c * 1.3, h: m.c >= 0 ? HUE[m.c] : 50 });
        parts.burst(p.x, p.y, 16, { color: ['#fff', '#ffe9a8', '#ffc4ff'], speed: 320, life: 0.8, size: 4, drag: 3 });
      }
      for (const i of w.trig) {
        const g = grid[i]; if (!g) continue;
        const p = px_(g.x, g.y), h = g.c >= 0 ? HUE[g.c] : 48;
        if (g.sp === 1) fx.beams.push({ k: 'row', x: p.x, y: p.y, t: 0, max: 0.5, h });
        else if (g.sp === 2) fx.beams.push({ k: 'col', x: p.x, y: p.y, t: 0, max: 0.5, h });
        else if (g.sp === 4) fx.rings.push({ x: p.x, y: p.y, t: 0, max: 0.55, r: L.c * 2.4, h, thick: 1 });
        else if (g.sp === 3) {
          for (const j of w.cells) { const t = grid[j]; if (t && t !== g) { const q = px_(t.x, t.y); fx.beams.push({ k: 'line', x: p.x, y: p.y, x2: q.x, y2: q.y, t: 0, max: 0.4, h: HUE[Math.max(0, t.c)] }); } }
          fx.rings.push({ x: p.x, y: p.y, t: 0, max: 0.7, r: L.c * 3, h: 300, thick: 1 });
        }
        shake = Math.max(shake, 0.6);
      }
      const made = w.make.length, trg = w.trig.length;
      const gain = waveScore(cleared, chain, trg, made);
      inst.score += gain;
      bar = Math.min(1, bar + waveRefill(cleared, chain, made) * refillScale());
      if (cleared) {
        const p = px_(cx / cleared, cy / cleared);
        fx.floats.push({ txt: '+' + fmt(gain), x: p.x, y: p.y, t: 0, max: 1.2, big: Math.min(2.2, 0.9 + chain * 0.25 + cleared * 0.02), h: 44 + chain * 14 });
      }
      if (chain >= 2) {
        const words = ['', '', 'NICE', 'SPLENDID', 'BRILLIANT', 'FLAWLESS', 'DAZZLING', 'LEGENDARY'];
        banner(`${words[Math.min(7, chain)]}  ×${chain}`, { hue: 40 + chain * 18, big: 0.7 + Math.min(0.3, chain * 0.04), y: 0.35, chain: true, max: 1.1 });
      }
      shake = Math.max(shake, 0.12 * Math.min(6, cleared / 3));
      phase = 'clear'; phT = 0;
    }
    function endClear() {
      // remove dying gems, compact columns, spawn refills above the board
      for (let i = 0; i < NN; i++) { const g = grid[i]; if (g && g.dying >= 0) grid[i] = null; }
      for (let x = 0; x < N; x++) {
        let wr = N - 1;
        for (let y = N - 1; y >= 0; y--) {
          const g = grid[y * N + x];
          if (g) { if (wr !== y) { grid[wr * N + x] = g; grid[y * N + x] = null; } g.ty = wr; wr--; }
        }
        const k = wr + 1;                 // empty cells at the top
        for (let r = 0; r < k; r++) {
          const g = randGem(x, r - k - 0.2 - Math.random() * 0.25, true);
          g.ty = r; g.py = g.y; grid[r * N + x] = g;
        }
      }
      curWave = null; phase = 'fall'; phT = 0;
    }
    function allSettled() { for (let i = 0; i < NN; i++) { const g = grid[i]; if (g && (Math.abs(g.y - g.ty) > 1e-3 || g.vy !== 0)) return false; } return true; }

    function beginSwap(a, b) {
      const ga = grid[a], gb = grid[b];
      const A = ctr(a), Bc = ctr(b);
      ga.fx = ga.x; ga.fy = ga.y; ga.tx = Bc.x; ga.ty2 = Bc.y;
      gb.fx = gb.x; gb.fy = gb.y; gb.tx = A.x; gb.ty2 = A.y;
      grid[a] = gb; grid[b] = ga; ga.ty = Bc.y; gb.ty = A.y;
      swapPair = { a, b, ga, gb };
      moves++; sinceMove = 0;
      phase = 'swap'; phT = 0; hint = null; ai.reset();
    }
    function afterSwap() {
      const { a, b, ga, gb } = swapPair;
      ga.x = ga.tx; ga.y = ga.ty2; gb.x = gb.tx; gb.y = gb.ty2;
      const B = board();
      // the grid already holds the swapped gems; recompute the bomb info from the pre-swap arrangement
      swapAll(B, a, b);
      const forced = bombForced(B, a, b);
      swapAll(B, a, b);
      chain = 0;
      const w = wave(B, forced, [a, b]);
      if (!w) {   // not a legal move (AI never does this): swap back
        grid[a] = ga; grid[b] = gb; const t = { x: ga.x, y: ga.y }; ga.x = gb.x; ga.y = gb.y; gb.x = t.x; gb.y = t.y; ga.ty = ga.y; gb.ty = gb.y; phase = 'idle'; phT = 0; return;
      }
      startClear(w, [a, b]);
    }
    function nextWaveOrIdle() {
      const B = board();
      const w = wave(B, null, null);
      if (w) { startClear(w, null); return; }
      if (chain >= 3) { /* chain finished */ }
      chain = 0;
      if (bar <= 0) { startOver('Time ran out'); return; }
      if (countMoves(B, 1) === 0) { phase = 'shuffle'; phT = 0; banner('NO MOVES  ·  SHUFFLE', { hue: 280, max: 1.4, y: 0.5 }); return; }
      phase = 'idle'; phT = 0; ai.reset();
    }
    function startOver(why) {
      reason = why; inst.over = true; inst.won = false; phase = 'over'; endT = 0;
      for (let i = 0; i < NN; i++) { const g = grid[i]; if (g) { g.dieAt = (7 - (i / N | 0)) * 0.07 + Math.random() * 0.12 + 0.2; g.dying = -1; } }
    }
    function doShuffle() {
      for (let g = 0; g < 60; g++) {
        const B = newBoard();
        for (let i = 0; i < NN; i++) { let c, k = 0; do { c = rnd.int(ncol()); B.c[i] = c; k++; } while (k < 20 && runAt(B.c, i, c)); }
        if (!hasMatches(B) && countMoves(B, 4) >= 3) {
          for (let i = 0; i < NN; i++) { const o = grid[i]; const gm = newGem(B.c[i], i % N, (i / N) | 0, 0); gm.sc = 0; gm.pop = 0.0001; grid[i] = gm; if (o) { const p = px_(o.x, o.y); parts.burst(p.x, p.y, 3, { color: ['#fff', '#e6c8ff'], speed: 200, life: 0.7, size: 3.5 }); } }
          return;
        }
      }
    }

    // ---- step ------------------------------------------------------------------------------------
    function stepFx(dt) {
      for (const k of ['shards']) { const L2 = fx[k]; for (let i = L2.length - 1; i >= 0; i--) { const s = L2[i]; s.t += dt; if (s.t > s.max) { L2.splice(i, 1); continue; } s.vy += 900 * dt; s.x += s.vx * dt; s.y += s.vy * dt; s.rot += s.vr * dt; s.vx *= 0.995; } }
      for (const k of ['beams', 'rings', 'floats', 'banners', 'glints']) { const L2 = fx[k]; for (let i = L2.length - 1; i >= 0; i--) { L2[i].t += dt; if (L2[i].t > L2[i].max) L2.splice(i, 1); } }
      parts.update(dt);
      shake = Math.max(0, shake - dt * 2.4); flashRed = Math.max(0, flashRed - dt);
    }
    inst.step = function (dt) {
      inst.t += dt;
      const d = dt * TS;
      for (let i = 0; i < NN; i++) { const g = grid[i]; if (g) { g.px = g.x; g.py = g.y; } }
      stepFx(dt);
      // ambient glints on random gems
      glintCd -= dt;
      if (glintCd <= 0 && phase !== 'over') { glintCd = rnd.float(0.18, 0.45); fx.glints.push({ i: rnd.int(NN), t: 0, max: 0.7 }); }
      for (let i = 0; i < NN; i++) {
        const g = grid[i]; if (!g) continue;
        if (g.pop > 0) { g.pop += d; if (g.pop > 0.5) g.pop = 0; }
        if (g.sq > 0) g.sq = Math.max(0, g.sq - d * 4);
        if (g.flash > 0) g.flash = Math.max(0, g.flash - d * 2.5);
        if (g.shk > 0) g.shk = Math.max(0, g.shk - d);
      }
      if (inst.over && phase === 'over') {
        endT += dt;
        for (let i = 0; i < NN; i++) { const g = grid[i]; if (g && !g.dead && endT > g.dieAt) { g.dead = true; shatter(g, i, 1.2); } }
        shake = Math.max(shake, endT < 1.2 ? 0.25 : 0);
        return;
      }
      // time bar: drains steadily, faster each level; matches refill it
      if (phase !== 'intro') {
        bar = Math.max(0, bar - drainRate() * dt);
        const nt = Math.floor(inst.t / 40);
        if (nt > tier) {
          tier = nt;
          banner(`LEVEL ${tier + 1}`, { hue: 280, max: 1.8, y: 0.5 });
          if (tier === 2 || tier === 5) banner('A NEW GEM JOINS THE BOARD', { hue: 330, max: 2.2, y: 0.6, big: 0.55, font: 'Fredoka' });
        }
        if (inst.t > TIME_CAP) { startOver('Out of time'); return; }
        if (surge > 0) surge -= dt;
        if (twist && twist.key === 'surge' && phase !== 'intro') {
          surgeT -= dt;
          if (surgeT <= 0) { surgeT = rnd.float(16, 26); surge = 4.5; flashRed = 0.6; banner('TIME SURGE', { hue: 8, max: 1.6, y: 0.5 }); }
        }
        if (twist && twist.key === 'locks' && phase === 'idle') {
          lockT -= dt;
          if (lockT <= 0) {
            lockT = rnd.float(18, 28);
            let n = 0;
            for (let tries = 0; tries < 30 && n < 4 + (tier > 3 ? 1 : 0); tries++) { const g = grid[rnd.int(NN)]; if (g && !g.lk && g.sp !== 3) { g.lk = 1; g.shk = 0.4; g.sq = 1; n++; const p = px_(g.x, g.y); parts.burst(p.x, p.y, 8, { color: ['#d9c39a', '#fff0c8'], speed: 200, life: 0.5, size: 3 }); } }
            banner('LOCKDOWN', { hue: 28, max: 1.5, y: 0.5 }); shake = 0.5;
          }
        }
      }
      // phases
      phT += d;
      if (phase === 'intro' || phase === 'fall') {
        for (let i = 0; i < NN; i++) {
          const g = grid[i]; if (!g) continue;
          if (g.y < g.ty - 1e-4 || g.vy !== 0) {
            g.vy = Math.min(26, g.vy + 62 * d);
            g.y += g.vy * d;
            if (g.y >= g.ty) { g.y = g.ty; if (g.vy > 4) g.sq = Math.min(1, g.vy / 18); g.vy = 0; }
          }
        }
        if (allSettled()) {
          if (phase === 'intro') { if (phT > 0.2) { phase = 'idle'; phT = 0; } }
          else if (phT > 0.06 / TS) nextWaveOrIdle();
        }
      } else if (phase === 'swap') {
        const dur = 0.17;
        const k = Math.min(1, phT / dur), e = easeIO(k);
        const { ga, gb } = swapPair;
        ga.x = lerp(ga.fx, ga.tx, e); ga.y = lerp(ga.fy, ga.ty2, e);
        gb.x = lerp(gb.fx, gb.tx, e); gb.y = lerp(gb.fy, gb.ty2, e);
        if (k >= 1) afterSwap();
      } else if (phase === 'clear') {
        const dur = 0.24;
        for (let i = 0; i < NN; i++) { const g = grid[i]; if (g && g.dying >= 0) { const was = g.dying; g.dying += d; if (was < 0.02 && g.dying >= 0.02) { shatter(g, i, 0.8); } } }
        if (phT >= dur) endClear();
      } else if (phase === 'shuffle') {
        if (phT < 0.4) { for (const g of grid) if (g) g.sc = Math.max(0, 1 - phT / 0.4); }
        else if (phT < 0.45) { doShuffle(); }
        else { let all = true; for (const g of grid) if (g) { g.sc = Math.min(1, g.sc + d * 3); if (g.sc < 1) all = false; } if (all) { phase = 'idle'; phT = 0; ai.reset(); } }
      } else if (phase === 'idle') {
        sinceMove += dt;
        if (bar <= 0) { startOver('Time ran out'); return; }
        const obs = { board: board(), bar };
        const r = ai.act(obs, dt);
        if (r) {
          if (r.hint) hint = r.hint;
          else if (r.go) beginSwap(r.go[0], r.go[1]);
          else if (r.stuck) { phase = 'shuffle'; phT = 0; }
        }
      }
    };
    // A fresh observe() snapshot is built in idle (above): settled gems only, colours/specials/chains and the time bar.
    // No gem that is still above the board, no RNG, no colour bag.

    // ---- layout ------------------------------------------------------------------------------------
    inst.resize = function (w, h) {
      W = w; H = h;
      const c = Math.min(H * 0.84 / N, W * 0.94 / 16.6);
      L = { c, bw: c * N, bx: (W - c * N) / 2, by: (H - c * N) / 2 - c * 0.05, pad: c * 0.22 };
    };

    // ---- drawing -----------------------------------------------------------------------------------
    function paintBackdrop(g, W, H) {
      let gr = g.createRadialGradient(W / 2, H * 0.42, 0, W / 2, H * 0.42, Math.hypot(W, H) * 0.62);
      gr.addColorStop(0, '#231238'); gr.addColorStop(0.55, '#130a22'); gr.addColorStop(1, '#07040d');
      g.fillStyle = gr; g.fillRect(0, 0, W, H);
      // velvet drapes: soft vertical folds
      const n = Math.max(10, Math.round(W / 70));
      for (let i = 0; i < n; i++) {
        const x = (i + 0.5) / n * W + Math.sin(i * 7.3) * 14, w = W / n * (1.1 + 0.4 * Math.sin(i * 3.1));
        const lg = g.createLinearGradient(x - w, 0, x + w, 0);
        const a = 0.05 + 0.04 * Math.sin(i * 1.7 + 1);
        lg.addColorStop(0, 'rgba(0,0,0,0)'); lg.addColorStop(0.45, `rgba(190,120,255,${a})`); lg.addColorStop(0.55, `rgba(255,190,240,${a * 0.6})`); lg.addColorStop(1, 'rgba(0,0,0,0)');
        g.fillStyle = lg; g.fillRect(x - w, 0, w * 2, H);
      }
      const vg = g.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.35, W / 2, H / 2, Math.hypot(W, H) * 0.65);
      vg.addColorStop(0, 'rgba(0,0,0,0)'); vg.addColorStop(1, 'rgba(0,0,0,0.65)');
      g.fillStyle = vg; g.fillRect(0, 0, W, H);
    }
    function drawAmbient(ctx, W, H) {
      const t = inst.t;
      ctx.save(); ctx.globalCompositeOperation = 'lighter';
      for (const b of blobs) {
        const x = (b.u + Math.sin(t * b.sp + b.ph) * 0.08) * W, y = (b.v + Math.cos(t * b.sp * 0.8 + b.ph) * 0.07) * H, r = b.r * Math.max(W, H);
        const gr = ctx.createRadialGradient(x, y, 0, x, y, r);
        gr.addColorStop(0, `hsla(${b.h},70%,45%,0.10)`); gr.addColorStop(1, `hsla(${b.h},70%,45%,0)`);
        ctx.fillStyle = gr; ctx.fillRect(x - r, y - r, r * 2, r * 2);
      }
      const gs = glowSprite();
      for (const s of stars) {
        const y = ((s.v - t * s.sp * 0.05) % 1 + 1) % 1, tw = 0.5 + 0.5 * Math.sin(t * 1.3 + s.ph);
        ctx.globalAlpha = 0.12 + 0.28 * tw; const r = s.s * Math.max(4, L.c * 0.09);
        ctx.drawImage(gs, s.u * W - r * 2, y * H - r * 2, r * 4, r * 4);
      }
      ctx.restore();
    }
    function drawBoardPanel(ctx) {
      const { bx, by, bw, pad, c } = L;
      ctx.save();
      roundRect(ctx, bx - pad - 6, by - pad - 6, bw + pad * 2 + 12, bw + pad * 2 + 12, c * 0.4);
      ctx.fillStyle = 'rgba(0,0,0,0.5)'; ctx.fill();
      roundRect(ctx, bx - pad, by - pad, bw + pad * 2, bw + pad * 2, c * 0.3);
      const gr = ctx.createLinearGradient(0, by - pad, 0, by + bw + pad);
      gr.addColorStop(0, '#1d1031'); gr.addColorStop(1, '#0f0719');
      ctx.fillStyle = gr; ctx.fill();
      ctx.lineWidth = Math.max(1.5, c * 0.045);
      const bg = ctx.createLinearGradient(bx, by, bx + bw, by + bw);
      bg.addColorStop(0, '#e9c98a'); bg.addColorStop(0.5, '#7b5a8a'); bg.addColorStop(1, '#d9a9c8');
      ctx.strokeStyle = bg; ctx.stroke();
      ctx.restore();
      for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
        ctx.fillStyle = (x + y) & 1 ? 'rgba(255,255,255,0.045)' : 'rgba(255,255,255,0.012)';
        roundRect(ctx, bx + x * c + 1, by + y * c + 1, c - 2, c - 2, c * 0.12); ctx.fill();
      }
    }
    function drawGem(ctx, g, a, now) {
      const { c, bx, by } = L;
      const gx = g.px + (g.x - g.px) * a, gy = g.py + (g.y - g.py) * a;
      let cx = bx + (gx + 0.5) * c, cy = by + (gy + 0.5) * c;
      let sc = g.sc;
      if (g.pop > 0) sc *= 1 + 0.35 * Math.sin(Math.min(1, g.pop / 0.4) * Math.PI) * (1 - g.pop / 0.5);
      if (g.sq > 0) { /* squash handled via sy */ }
      let sx = 1, sy = 1;
      if (g.sq > 0) { const q = ease.outQuad(g.sq); sy = 1 - 0.16 * q; sx = 1 + 0.1 * q; }
      let alpha = 1, white = 0;
      if (g.dying >= 0) {
        const k = Math.min(1, (g.dying + a * (1 / 60) * TS) / 0.24);
        white = Math.min(1, k * 3); sc *= k < 0.3 ? 1 + 0.2 * (k / 0.3) : 1.2 * (1 - ease.outCubic((k - 0.3) / 0.7)); alpha = 1;
      }
      if (g.shk > 0) { cx += Math.sin(now * 90) * c * 0.04 * (g.shk / 0.35); }
      if (g.dead || sc <= 0.01) return;
      const size = c * 0.9 * sc;
      ctx.save(); ctx.translate(cx, cy); ctx.scale(sx, sy);
      ctx.globalAlpha = alpha;
      const spx = Math.max(24, Math.min(256, Math.round(size * (ctx.getTransform().a || 1) / 8) * 8));
      if (g.sp === 3) {
        // colour bomb: dark orb ringed by every jewel colour
        const r = size * 0.5;
        const og = ctx.createRadialGradient(-r * 0.3, -r * 0.35, 0, 0, 0, r);
        og.addColorStop(0, '#6a4a8a'); og.addColorStop(0.5, '#1d1030'); og.addColorStop(1, '#07030f');
        ctx.beginPath(); ctx.arc(0, 0, r, 0, TAU); ctx.fillStyle = og; ctx.fill();
        for (let k = 0; k < 7; k++) {
          const ang = now * 1.6 + k * TAU / 7;
          ctx.beginPath(); ctx.arc(0, 0, r * 0.9, ang, ang + TAU / 7 * 0.75); ctx.strokeStyle = `hsl(${HUE[k]},90%,62%)`; ctx.lineWidth = r * 0.16; ctx.lineCap = 'round'; ctx.stroke();
          const sa = -now * 2.2 + k * TAU / 7;
          ctx.beginPath(); ctx.arc(Math.cos(sa) * r * 0.45, Math.sin(sa) * r * 0.45, r * 0.09, 0, TAU); ctx.fillStyle = `hsl(${HUE[k]},95%,75%)`; ctx.fill();
        }
        ctx.beginPath(); ctx.arc(-r * 0.3, -r * 0.35, r * 0.16, 0, TAU); ctx.fillStyle = 'rgba(255,255,255,0.7)'; ctx.fill();
      } else {
        if (g.sp === 4) {      // nova: rotating star halo
          ctx.save(); ctx.globalCompositeOperation = 'lighter';
          ctx.fillStyle = `hsla(${HUE[g.c]},90%,70%,${0.35 + 0.15 * Math.sin(now * 5)})`;
          star4(ctx, 0, 0, size * (0.72 + 0.05 * Math.sin(now * 4)), now * 0.8); ctx.fill();
          star4(ctx, 0, 0, size * 0.55, -now * 0.6 + 0.4); ctx.fill();
          ctx.restore();
        }
        ctx.drawImage(gemSprite(g.c, spx), -size / 2, -size / 2, size, size);
        if (g.sp === 1 || g.sp === 2) {
          const pulse = 0.65 + 0.3 * Math.sin(now * 6 + g.id);
          ctx.save(); ctx.globalCompositeOperation = 'lighter'; ctx.globalAlpha = pulse;
          ctx.fillStyle = '#fff';
          const h = g.sp === 1;
          for (const sgn of [-1, 1]) {
            ctx.save(); if (!h) ctx.rotate(Math.PI / 2); ctx.translate(sgn * size * 0.2, 0); if (sgn < 0) ctx.scale(-1, 1);
            ctx.beginPath(); ctx.moveTo(0, -size * 0.17); ctx.lineTo(size * 0.2, 0); ctx.lineTo(0, size * 0.17); ctx.lineTo(size * 0.045, 0); ctx.closePath(); ctx.fill();
            ctx.restore();
          }
          ctx.beginPath(); ctx.arc(0, 0, size * 0.56, 0, TAU); ctx.strokeStyle = `hsla(${HUE[g.c]},95%,80%,0.8)`; ctx.lineWidth = size * 0.045; ctx.stroke();
          ctx.restore();
        } else if (g.sp === 4) {
          ctx.save(); ctx.globalCompositeOperation = 'lighter'; ctx.globalAlpha = 0.9;
          star4(ctx, 0, 0, size * 0.3, now * 1.5); ctx.fillStyle = '#fff'; ctx.fill(); ctx.restore();
        }
      }
      if (g.flash > 0 || white > 0) {
        ctx.save(); ctx.globalCompositeOperation = 'lighter';
        ctx.globalAlpha = Math.min(1, Math.max(g.flash, white) * 1.1);
        ctx.drawImage(glowSprite(), -size * 0.8, -size * 0.8, size * 1.6, size * 1.6);
        ctx.restore();
      }
      if (g.lk > 0) drawLock(ctx, size, g.lk);
      ctx.restore();
    }
    function drawLock(ctx, size, lv) {
      const s = size * 0.5;
      ctx.save();
      ctx.fillStyle = 'rgba(10,6,20,0.38)'; roundRect(ctx, -s, -s, s * 2, s * 2, s * 0.25); ctx.fill();
      const gr = ctx.createLinearGradient(-s, -s, s, s);
      gr.addColorStop(0, '#f0dcae'); gr.addColorStop(0.5, '#8d7448'); gr.addColorStop(1, '#d8c08a');
      ctx.strokeStyle = gr; ctx.lineWidth = size * (lv > 1 ? 0.1 : 0.065); roundRect(ctx, -s, -s, s * 2, s * 2, s * 0.25); ctx.stroke();
      ctx.lineWidth = size * 0.05;
      ctx.beginPath(); ctx.moveTo(-s, -s * 0.2); ctx.lineTo(s, s * 0.2); ctx.moveTo(-s, s * 0.2); ctx.lineTo(s, -s * 0.2); ctx.strokeStyle = 'rgba(210,190,140,0.75)'; ctx.stroke();
      // padlock
      ctx.fillStyle = gr; roundRect(ctx, -s * 0.28, -s * 0.12, s * 0.56, s * 0.46, s * 0.1); ctx.fill();
      ctx.beginPath(); ctx.arc(0, -s * 0.12, s * 0.2, Math.PI, 0); ctx.strokeStyle = gr; ctx.lineWidth = size * 0.05; ctx.stroke();
      ctx.fillStyle = '#2a1c10'; ctx.beginPath(); ctx.arc(0, s * 0.1, s * 0.07, 0, TAU); ctx.fill();
      if (lv > 1) { ctx.font = `700 ${size * 0.3}px Fredoka, sans-serif`; ctx.textAlign = 'center'; ctx.fillStyle = '#fff6dc'; ctx.fillText('2', s * 0.62, s * 0.88); }
      ctx.restore();
    }
    function drawTimeBar(ctx) {
      const { c, bx, by, bw, pad } = L;
      const w = c * 0.5, x = bx - pad - c * 0.55 - w, y = by - pad, h = bw + pad * 2;
      const low = bar < 0.25;
      ctx.save();
      roundRect(ctx, x, y, w, h, w / 2); ctx.fillStyle = 'rgba(0,0,0,0.5)'; ctx.fill();
      ctx.clip();
      const fy = y + h * (1 - bar), now = inst.t;
      const gr = ctx.createLinearGradient(0, y + h, 0, y);
      if (low) { gr.addColorStop(0, '#ff5a6a'); gr.addColorStop(1, '#ff9a7a'); }
      else if (surge > 0) { gr.addColorStop(0, '#ff6a3a'); gr.addColorStop(1, '#ffb05a'); }
      else { gr.addColorStop(0, '#7a3cff'); gr.addColorStop(0.55, '#d05cff'); gr.addColorStop(1, '#ffd98a'); }
      ctx.fillStyle = gr;
      ctx.beginPath(); ctx.moveTo(x, y + h + 2);
      for (let i = 0; i <= 12; i++) ctx.lineTo(x + w * i / 12, fy + Math.sin(now * 3 + i * 0.9) * c * 0.025);
      ctx.lineTo(x + w, y + h + 2); ctx.closePath(); ctx.fill();
      ctx.globalCompositeOperation = 'lighter'; ctx.fillStyle = 'rgba(255,255,255,0.12)'; ctx.fillRect(x + w * 0.15, fy, w * 0.14, y + h - fy);
      ctx.restore();
      ctx.save();
      roundRect(ctx, x, y, w, h, w / 2); ctx.lineWidth = Math.max(1.5, c * 0.04);
      ctx.strokeStyle = low ? `rgba(255,110,120,${0.6 + 0.4 * Math.sin(now * 9)})` : 'rgba(233,201,138,0.7)'; ctx.stroke();
      ctx.font = `600 ${c * 0.26}px Fredoka, sans-serif`; ctx.textAlign = 'center'; ctx.fillStyle = 'rgba(233,201,138,0.8)';
      try { ctx.letterSpacing = c * 0.04 + 'px'; } catch (e) { /* ok */ }
      ctx.fillText('TIME', x + w / 2, y - c * 0.14);
      try { ctx.letterSpacing = '0px'; } catch (e) { /* ok */ }
      ctx.restore();
    }
    function drawPanel(ctx) {
      const { c, bx, by, bw, pad } = L;
      const x = bx + bw + pad + c * 0.55, w = c * 3.4;
      ctx.save(); ctx.textAlign = 'left';
      const label = (t, y) => { ctx.font = `600 ${c * 0.26}px Fredoka, sans-serif`; ctx.fillStyle = 'rgba(233,201,138,0.75)'; try { ctx.letterSpacing = c * 0.04 + 'px'; } catch (e) { /* ok */ } ctx.fillText(t, x, y); try { ctx.letterSpacing = '0px'; } catch (e) { /* ok */ } };
      const best = Math.max(opts.best || PAR_SCORE, inst.score);
      let y = by + c * 0.5;
      label('SCORE', y);
      ctx.font = `600 ${c * 0.78}px "IBM Plex Mono", monospace`; ctx.fillStyle = '#fff4e6'; ctx.fillText(fmt(inst.score), x, y + c * 0.8);
      y += c * 1.55;
      label(inst.score >= (opts.best || PAR_SCORE) ? 'NEW BEST' : 'BEST', y);
      ctx.font = `600 ${c * 0.46}px "IBM Plex Mono", monospace`; ctx.fillStyle = inst.score >= (opts.best || PAR_SCORE) ? '#ffd98a' : 'rgba(255,244,230,0.55)'; ctx.fillText(fmt(best), x, y + c * 0.52);
      y += c * 1.25;
      label('LEVEL', y);
      ctx.font = `600 ${c * 0.62}px Fredoka, sans-serif`; ctx.fillStyle = '#e6c8ff'; ctx.fillText(String(tier + 1), x, y + c * 0.66);
      // gem colours in play
      const nc = ncol();
      for (let i = 0; i < 7; i++) {
        const gx = x + c * 1.0 + (i % 4) * c * 0.5, gy = y + c * 0.12 + ((i / 4) | 0) * c * 0.5;
        ctx.globalAlpha = i < nc ? 1 : 0.18;
        ctx.drawImage(gemSprite(i, 48), gx, gy, c * 0.42, c * 0.42);
      }
      ctx.globalAlpha = 1;
      y += c * 1.35;
      label('CHAIN', y);
      const hot = chain >= 2;
      ctx.font = `600 ${c * (hot ? 0.8 : 0.62)}px Fraunces, serif`; ctx.fillStyle = hot ? `hsl(${40 + chain * 14},95%,72%)` : 'rgba(255,244,230,0.45)';
      ctx.fillText(chain > 0 ? `×${chain}` : '–', x, y + c * 0.78);
      if (twist) {
        y += c * 1.4;
        ctx.font = `600 ${c * 0.3}px Fredoka, sans-serif`;
        const tw = ctx.measureText(twist.name.toUpperCase()).width + c * 0.4;
        roundRect(ctx, x, y - c * 0.28, tw, c * 0.42, c * 0.1);
        ctx.fillStyle = surge > 0 ? 'rgba(255,90,50,0.9)' : 'rgba(255,120,50,0.25)'; ctx.fill();
        ctx.fillStyle = '#ffd9b8'; ctx.fillText(twist.name.toUpperCase(), x + c * 0.2, y + c * 0.03);
      }
      ctx.restore();
    }
    function drawFx(ctx, a) {
      const now = inst.t, c = L.c;
      // beams
      ctx.save(); ctx.globalCompositeOperation = 'lighter';
      for (const b of fx.beams) {
        const k = b.t / b.max, f = 1 - k;
        ctx.globalAlpha = f;
        if (b.k === 'row') {
          const reach = ease.outCubic(Math.min(1, k * 2.2)) * L.bw, th = c * 0.55 * f + 2;
          const g1 = ctx.createLinearGradient(b.x - reach, 0, b.x + reach, 0);
          g1.addColorStop(0, `hsla(${b.h},95%,70%,0)`); g1.addColorStop(0.5, '#fff'); g1.addColorStop(1, `hsla(${b.h},95%,70%,0)`);
          ctx.fillStyle = g1; ctx.fillRect(b.x - reach, b.y - th / 2, reach * 2, th);
        } else if (b.k === 'col') {
          const reach = ease.outCubic(Math.min(1, k * 2.2)) * L.bw, th = c * 0.55 * f + 2;
          const g1 = ctx.createLinearGradient(0, b.y - reach, 0, b.y + reach);
          g1.addColorStop(0, `hsla(${b.h},95%,70%,0)`); g1.addColorStop(0.5, '#fff'); g1.addColorStop(1, `hsla(${b.h},95%,70%,0)`);
          ctx.fillStyle = g1; ctx.fillRect(b.x - th / 2, b.y - reach, th, reach * 2);
        } else {
          ctx.strokeStyle = `hsl(${b.h},95%,75%)`; ctx.lineWidth = c * 0.09 * f + 1;
          const e = ease.outCubic(Math.min(1, k * 2));
          ctx.beginPath(); ctx.moveTo(b.x, b.y); ctx.lineTo(b.x + (b.x2 - b.x) * e, b.y + (b.y2 - b.y) * e); ctx.stroke();
        }
      }
      for (const r of fx.rings) {
        const k = r.t / r.max, rr = r.r * ease.outCubic(k);
        ctx.globalAlpha = (1 - k) * 0.9; ctx.strokeStyle = `hsl(${r.h},95%,78%)`; ctx.lineWidth = c * (r.thick ? 0.2 : 0.1) * (1 - k) + 1;
        ctx.beginPath(); ctx.arc(r.x, r.y, rr, 0, TAU); ctx.stroke();
      }
      // glints
      ctx.fillStyle = '#fff';
      for (const gl of fx.glints) {
        const g = grid[gl.i]; if (!g || g.dying >= 0 || g.sp === 3 || g.y < 0) continue;
        const k = gl.t / gl.max, s = Math.sin(k * Math.PI);
        const p = px_(g.x - 0.18, g.y - 0.2);
        ctx.globalAlpha = s * 0.95; star4(ctx, p.x, p.y, c * 0.2 * s + 1, 0.2); ctx.fill();
      }
      ctx.restore();
      // shards
      for (const s of fx.shards) {
        const k = s.t / s.max;
        ctx.save(); ctx.translate(s.x, s.y); ctx.rotate(s.rot); ctx.globalAlpha = Math.min(1, (1 - k) * 1.6);
        ctx.beginPath(); ctx.moveTo(-s.s * 0.5, s.s * 0.4); ctx.lineTo(s.s * 0.6, 0); ctx.lineTo(-s.s * 0.1, -s.s * 0.5); ctx.closePath();
        ctx.fillStyle = `hsl(${s.h},80%,${58 - k * 18}%)`; ctx.fill();
        ctx.strokeStyle = 'rgba(255,255,255,0.5)'; ctx.lineWidth = 1; ctx.stroke();
        ctx.restore();
      }
      parts.draw(ctx, Math.max(0.5, c / 40));
      // floating scores
      ctx.textAlign = 'center';
      for (const f of fx.floats) {
        const k = f.t / f.max, al = k < 0.12 ? k / 0.12 : 1 - Math.max(0, (k - 0.5) / 0.5);
        ctx.globalAlpha = Math.max(0, al);
        ctx.font = `600 ${c * 0.42 * f.big}px "IBM Plex Mono", monospace`;
        const y = f.y - ease.outCubic(Math.min(1, f.t / 0.8)) * c * 1.1;
        ctx.lineJoin = 'round'; ctx.shadowColor = 'rgba(8,0,20,0.9)'; ctx.shadowBlur = c * 0.25; ctx.lineWidth = c * 0.13; ctx.strokeStyle = 'rgba(12,2,28,0.95)'; ctx.strokeText(f.txt, f.x, y);
        ctx.shadowBlur = 0; ctx.fillStyle = `hsl(${f.h},100%,88%)`; ctx.fillText(f.txt, f.x, y);
      }
      ctx.globalAlpha = 1;
    }
    function drawBanners(ctx) {
      const c = L.c;
      ctx.save(); ctx.textAlign = 'center';
      for (const b of fx.banners) {
        const k = b.t / b.max, a = k < 0.15 ? k / 0.15 : 1 - Math.max(0, (k - 0.6) / 0.4);
        const sc = 0.7 + 0.3 * ease.outBack(Math.min(1, k / 0.25));
        ctx.save(); ctx.translate(L.bx + L.bw / 2, L.by + L.bw * b.y - k * c * 0.6); ctx.scale(sc, sc); ctx.globalAlpha = Math.max(0, a);
        ctx.font = b.font === 'Fraunces' ? `600 ${c * 0.9 * b.big}px Fraunces, serif` : `600 ${c * 0.5 * b.big}px Fredoka, sans-serif`;
        ctx.shadowColor = 'rgba(8,0,20,0.95)'; ctx.shadowBlur = c * 0.4; ctx.lineWidth = c * 0.2; ctx.lineJoin = 'round'; ctx.strokeStyle = 'rgba(12,2,28,0.95)'; ctx.strokeText(b.txt, 0, 0); ctx.shadowBlur = 0;
        const gr = ctx.createLinearGradient(0, -c * 0.7, 0, c * 0.2); gr.addColorStop(0, `hsl(${b.hue},100%,92%)`); gr.addColorStop(1, `hsl(${b.hue + 20},100%,72%)`);
        ctx.fillStyle = gr; ctx.fillText(b.txt, 0, 0);
        ctx.restore();
      }
      ctx.restore();
    }
    function drawHint(ctx, a) {
      if (!hint || phase !== 'idle') return;
      const c = L.c, now = inst.t, p = 0.5 + 0.5 * Math.sin(now * 12);
      ctx.save();
      for (const i of hint) {
        const g = grid[i]; if (!g) continue;
        const q = px_(g.x, g.y);
        ctx.strokeStyle = `rgba(255,240,210,${0.5 + 0.4 * p})`; ctx.lineWidth = c * 0.05;
        roundRect(ctx, q.x - c * 0.46, q.y - c * 0.46, c * 0.92, c * 0.92, c * 0.2); ctx.stroke();
      }
      ctx.restore();
    }
    const drawRaw = (ctx, W, H) => {
      if (!L) inst.resize(W, H);
      const a = alphaNow(), now = inst.t, c = L.c;
      staticLayer(ctx, 'gems-bg', W, H, paintBackdrop);
      drawAmbient(ctx, W, H);
      ctx.save();
      if (shake > 0.01) ctx.translate(Math.sin(now * 91) * shake * c * 0.07, Math.cos(now * 77) * shake * c * 0.07);
      drawBoardPanel(ctx);
      ctx.save();
      ctx.beginPath(); ctx.rect(L.bx - 1, L.by - 1, L.bw + 2, L.bw + 2); ctx.clip();
      // paint gems by row so lower rows overlap upper rows during squashes
      for (let i = 0; i < NN; i++) { const g = grid[i]; if (g) drawGem(ctx, g, a, now); }
      drawHint(ctx, a);
      ctx.restore();
      drawTimeBar(ctx);
      drawPanel(ctx);
      drawFx(ctx, a);
      drawBanners(ctx);
      ctx.restore();
      // danger vignette
      const danger = Math.max(flashRed, bar < 0.22 && !inst.over ? (0.22 - bar) / 0.22 * (0.6 + 0.4 * Math.sin(now * 7)) : 0);
      if (danger > 0.01) {
        const vg = ctx.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.4, W / 2, H / 2, Math.hypot(W, H) * 0.6);
        vg.addColorStop(0, 'rgba(255,40,70,0)'); vg.addColorStop(1, `rgba(255,40,70,${0.35 * Math.min(1, danger)})`);
        ctx.fillStyle = vg; ctx.fillRect(0, 0, W, H);
      }
      if (inst.over) {
        const k = Math.min(1, Math.max(0, (endT - 0.6) / 0.8));
        if (k > 0) {
          ctx.save(); ctx.globalAlpha = k; ctx.textAlign = 'center';
          ctx.font = `600 ${c * 1.0}px Fraunces, serif`; ctx.lineWidth = c * 0.16; ctx.lineJoin = 'round';
          ctx.strokeStyle = 'rgba(10,2,24,0.85)'; ctx.strokeText(reason === 'Out of time' ? 'OUT OF TIME' : "TIME'S UP", W / 2, L.by + L.bw / 2);
          ctx.fillStyle = '#ffd9e8'; ctx.fillText(reason === 'Out of time' ? 'OUT OF TIME' : "TIME'S UP", W / 2, L.by + L.bw / 2);
          ctx.restore();
        }
      }
    };
    inst.draw = (ctx, W, H) => drawRaw(ctx, W, H);
    inst.hud = () => ({ score: fmt(inst.score), detail: `Level ${tier + 1} · best chain ×${bestChain} · best ${fmt(Math.max(opts.best || PAR_SCORE, inst.score))}` });
    inst.result = () => `${fmt(inst.score)} points on level ${tier + 1}, best chain ×${bestChain}, ${moves} swaps` + (reason === 'Out of time' ? ' (out of time)' : '') + ` (${S.name})`;
    fillInitial();
    return inst;
  }

  Arcade.register({
    id: 'gems', name: 'Velvet Facets', genre: 'Match three',
    blurb: 'Jewels on black velvet. Match, cascade, and keep the time bar alive.',
    aiNote: 'Reads the 8x8 board and the time bar, tries every swap in its head (including the visible cascade, never the gems that fall in), then swaps about once a second.',
    bg: '#150a24', accent: '#d98cff', endless: true, parScore: PAR_SCORE, twists: TWISTS, create,
  });
})();
