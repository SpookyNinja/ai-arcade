// chase.js - Night Market: a maze chase. A golden dumpling muncher collects paper lanterns while four
// paper-kite chasers hunt it with classic targeting (direct, ahead, pincer, shy). Original 28x31 maze.
// Movement is fully continuous: every mover sits on a tile-to-tile segment (tile, direction, progress)
// and corners are drawn as rounded Bezier arcs, so nothing ever snaps.
// The player is steered by ChaseAI, a separate object that only receives an observe() snapshot
// (visible lantern board, visible positions/directions of the muncher and chasers, whether chasers are
// frightened) and outputs one direction input at a time, rate limited like a human.
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


  // ----------------------------------------------------------------- maze data
  const COLS = 28, ROWS = 31, GW = 32, OFF = 2, TUN = 14; // GW: 2 phantom tunnel columns on each side
  // left halves (14 wide), mirrored to the right. # wall . lantern o power lantern H house - door
  // Three original mazes (all symmetric, no dead ends, no 2x2 open blocks, same ghost house / tunnel / start
  // strip so every rule works unchanged). One is picked at random per game; night 2 uses a different one.
  const MAZES = [
    [
    '##############',
    '#.............',
    '#.####.#####.#',
    '#o####.#####.#',
    '#.####.#####.#',
    '#.............',
    '#.####.##.####',
    '#.####.##.####',
    '#......##.....',
    '###### ## ####',
    '###### ## ####',
    '###### ##.....',
    '###### ## ###-',
    '###### ## #HHH',
    '   .......#HHH',
    '###### ## #HHH',
    '###### ## ####',
    '###### ##     ',
    '###### ## ####',
    '###### ## ####',
    '#.............',
    '#.####.#####.#',
    '#.####.#####.#',
    '#o..##....    ',
    '###.##.##.####',
    '###.##.##.####',
    '#......##.....',
    '#.####.#####.#',
    '#.####.#####.#',
    '#.............',
    '##############',
    ],
    [
    '##############',
    '#............#',
    '#.########.#.#',
    '#o..##.....#..',
    '###.##.#####.#',
    '###.##.#####.#',
    '#...##.....#..',
    '#.########.###',
    '#......##.....',
    '###### ## ####',
    '###### ## ####',
    '###### ##.....',
    '###### ## ###-',
    '###### ## #HHH',
    '   .......#HHH',
    '###### ## #HHH',
    '###### ## ####',
    '###### ##     ',
    '###### ## ####',
    '###### ## ####',
    '#.............',
    '#.#.####.#####',
    '#.#.####.#####',
    '#o#.####.     ',
    '#.#.####.###.#',
    '#.#.####.###.#',
    '#.#.####.###.#',
    '#........#...#',
    '#.########.###',
    '#.............',
    '##############',
    ],
    [
    '##############',
    '#....#....####',
    '#.##.#.##.####',
    '#o##.#.##.####',
    '#......##.....',
    '######.##.####',
    '#....#........',
    '#.##.####.####',
    '#......##.....',
    '###### ## ####',
    '###### ## ####',
    '###### ##.....',
    '###### ## ###-',
    '###### ## #HHH',
    '   .......#HHH',
    '###### ## #HHH',
    '###### ## ####',
    '###### ##     ',
    '###### ## ####',
    '###### ## ####',
    '#.............',
    '#.###.#.#.####',
    '#.###.#.#.####',
    '#o###.#.#     ',
    '#.###.#.###.##',
    '#.###.#.###.##',
    '#.###.#...#.##',
    '#.###.#.#.#.##',
    '#.###.#.#.#.##',
    '#.........#...',
    '##############',
    ],
  ];
  let HALF = MAZES[0], mazeId = 0;
  const DX = [0, -1, 0, 1], DY = [-1, 0, 1, 0]; // up, left, down, right (ghost tie-break order)
  const opp = d => (d + 2) & 3;
  const IDX = (c, r) => r * GW + c + OFF;
  const NTILE = GW * ROWS;
  const colOf = i => (i % GW) - OFF;
  const rowOf = i => (i / GW) | 0;

  const TYPE = new Uint8Array(NTILE); // 0 path, 1 wall, 2 door, 3 house
  const PEL0 = new Uint8Array(NTILE);
  let PELLETS0 = 0;
  const PEL_LIST = [];
  const NB = new Int16Array(NTILE * 4);
  function loadMaze(k) {
    mazeId = k; HALF = MAZES[k];
    TYPE.fill(1); PEL0.fill(0); PELLETS0 = 0; PEL_LIST.length = 0; NB.fill(-1);
    for (let r = 0; r < ROWS; r++) {
      const row = HALF[r] + HALF[r].split('').reverse().join('');
      for (let c = 0; c < COLS; c++) {
        const ch = row[c], i = IDX(c, r);
        TYPE[i] = ch === '#' ? 1 : ch === '-' ? 2 : ch === 'H' ? 3 : 0;
        if (ch === '.' || ch === 'o') { PEL0[i] = ch === 'o' ? 2 : 1; PELLETS0++; PEL_LIST.push(i); }
      }
    }
    for (const c of [-2, -1, 28, 29]) TYPE[IDX(c, TUN)] = 0;
    for (let r = 0; r < ROWS; r++) {
      for (let c = -OFF; c < COLS + OFF; c++) {
        const i = IDX(c, r);
        if (TYPE[i] !== 0) continue;
        for (let d = 0; d < 4; d++) {
          let nc = c + DX[d]; const nr = r + DY[d];
          if (nr < 0 || nr >= ROWS) continue;
          if (r === TUN) { if (nc < -OFF) nc = COLS + OFF - 1; else if (nc > COLS + OFF - 1) nc = -OFF; }
          else if (nc < 0 || nc >= COLS) continue;
          const j = IDX(nc, nr);
          if (TYPE[j] === 0) NB[i * 4 + d] = j;
        }
      }
    }
    bfsField([HOME_A, HOME_B], DIST_HOME);
    LOOPS = computeLoops();
  }
  const HOME_A = IDX(13, 11), HOME_B = IDX(14, 11);

  const bfsQ = new Int16Array(NTILE);
  function bfsField(sources, out) {
    out.fill(-1);
    let h = 0, t = 0;
    for (const s of sources) { if (s >= 0 && out[s] < 0) { out[s] = 0; bfsQ[t++] = s; } }
    while (h < t) {
      const i = bfsQ[h++];
      for (let d = 0; d < 4; d++) { const j = NB[i * 4 + d]; if (j >= 0 && out[j] < 0) { out[j] = out[i] + 1; bfsQ[t++] = j; } }
    }
    return out;
  }
  const DIST_HOME = new Int16Array(NTILE);
  let LOOPS = [];

  // wall outline loops (rectilinear polygons around the wall tiles), computed once
  function computeLoops() {
    const isWall = (c, r) => c >= 0 && c < COLS && r >= 0 && r < ROWS && TYPE[IDX(c, r)] === 1;
    const edges = [], byStart = new Map();
    const key = (x, y) => y * 64 + x;
    const add = (x0, y0, x1, y1) => { const e = { x0, y0, x1, y1, used: false }; edges.push(e); const k = key(x0, y0); if (!byStart.has(k)) byStart.set(k, []); byStart.get(k).push(e); };
    for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) {
      if (!isWall(c, r)) continue;
      if (!isWall(c, r - 1)) add(c, r, c + 1, r);
      if (!isWall(c + 1, r)) add(c + 1, r, c + 1, r + 1);
      if (!isWall(c, r + 1)) add(c + 1, r + 1, c, r + 1);
      if (!isWall(c - 1, r)) add(c, r + 1, c, r);
    }
    const loops = [];
    for (const e0 of edges) {
      if (e0.used) continue;
      const pts = []; let e = e0;
      while (e && !e.used) {
        e.used = true; pts.push({ x: e.x0, y: e.y0 });
        const cand = byStart.get(key(e.x1, e.y1)) || [];
        e = cand.find(n => !n.used);
      }
      // drop collinear vertices
      const out = [];
      for (let i = 0; i < pts.length; i++) {
        const a = pts[(i + pts.length - 1) % pts.length], b = pts[i], c = pts[(i + 1) % pts.length];
        if ((b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x) !== 0) out.push(b);
      }
      if (out.length >= 3) loops.push(out);
    }
    return loops;
  }
  loadMaze(0);

  function loopPath(ctx, pts, inset, rad) {
    const n = pts.length, v = [];
    for (let i = 0; i < n; i++) {
      const a = pts[(i + n - 1) % n], b = pts[i], c = pts[(i + 1) % n];
      let d1x = b.x - a.x, d1y = b.y - a.y, l1 = Math.hypot(d1x, d1y); d1x /= l1; d1y /= l1;
      let d2x = c.x - b.x, d2y = c.y - b.y, l2 = Math.hypot(d2x, d2y); d2x /= l2; d2y /= l2;
      v.push({ x: b.x + inset * (-d1y - d2y), y: b.y + inset * (d1x + d2x) });
    }
    const mid = (p, q) => ({ x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 });
    const m0 = mid(v[n - 1], v[0]);
    ctx.moveTo(m0.x, m0.y);
    for (let i = 0; i < n; i++) {
      const p = v[i], q = v[(i + 1) % n], m = mid(p, q);
      const prev = v[(i + n - 1) % n];
      const r = Math.min(rad, Math.hypot(p.x - prev.x, p.y - prev.y) / 2, Math.hypot(q.x - p.x, q.y - p.y) / 2);
      ctx.arcTo(p.x, p.y, m.x, m.y, r);
    }
    ctx.closePath();
  }

  // ----------------------------------------------------------------- tuning
  const LV = [
    { ps: 8.8, gs: 8.2, gfr: 4.3, gtun: 4.2, fright: 7, sched: [9, 12, 9, 12, 7, 12, 7, 1e9], rel: [0, 14, 34] },
    { ps: 8.9, gs: 8.6, gfr: 4.6, gtun: 4.4, fright: 4, sched: [7, 14, 7, 14, 5, 18, 5, 1e9], rel: [0, 0, 20] },
  ];
  const EYES_SPEED = 14, HOUSE_SPEED = 3.8;
  const TIME_CAP = 360;
  const GHOST_DEFS = [
    { name: 'Ember', color: '#e5384f', dark: '#9e1c36', light: '#ff8d99', scatter: [25, -3], slot: 14.0 },  // crimson: direct
    { name: 'Saffron', color: '#f6a82c', dark: '#b8690f', light: '#ffd98a', scatter: [2, -3], slot: 14.0 }, // saffron: ahead of player
    { name: 'Sky', color: '#46b6ee', dark: '#1f72b5', light: '#a5e0ff', scatter: [27, 33], slot: 12.5 },     // sky: pincer
    { name: 'Jade', color: '#2fbf8c', dark: '#127a5c', light: '#8ff0cb', scatter: [0, 33], slot: 15.5 },     // jade: shy
  ];

  // ----------------------------------------------------------------- movers
  function mkMover(i, d) {
    const m = { i: 0, tx: 0, ty: 0, dx: 0, dy: 0, pdx: 0, pdy: 0, ndx: 0, ndy: 0, committed: false, prog: 0 };
    setTile(m, i, d);
    return m;
  }
  function setTile(m, i, d) {
    m.i = i; m.tx = colOf(i); m.ty = rowOf(i);
    m.dx = d >= 0 ? DX[d] : 0; m.dy = d >= 0 ? DY[d] : 0;
    m.pdx = m.pdy = m.ndx = m.ndy = 0; m.committed = false; m.prog = 0;
  }
  const dirOf = m => (m.dx === 0 && m.dy === 0) ? -1 : (m.dy < 0 ? 0 : m.dx < 0 ? 1 : m.dy > 0 ? 2 : 3);
  function reverseMover(m) {
    const d = dirOf(m); if (d < 0) return;
    const j = NB[m.i * 4 + d]; if (j < 0) return;
    m.i = j; m.tx = colOf(j); m.ty = rowOf(j);
    m.dx = -m.dx; m.dy = -m.dy; m.prog = 1 - m.prog;
    m.pdx = m.pdy = m.ndx = m.ndy = 0; m.committed = false;
  }
  // advance along tile segments; pick(m) chooses the exit direction (sets ndx/ndy) at the half-way
  // commit point, arrive(m) is called when a tile centre is reached.
  function advance(m, dist, pick, arrive) {
    let guard = 0;
    while (dist > 1e-9 && guard++ < 8) {
      if (m.dx === 0 && m.dy === 0) break;
      if (!m.committed) {
        if (m.prog >= 0.5) { pick(m); m.committed = true; continue; }
        const d = Math.min(dist, 0.5 - m.prog); m.prog += d; dist -= d; continue;
      }
      const rem = 1 - m.prog;
      if (dist < rem) { m.prog += dist; dist = 0; break; }
      dist -= rem;
      const j = NB[m.i * 4 + dirOf(m)];
      m.i = j; m.tx = colOf(j); m.ty = rowOf(j);
      m.pdx = m.dx; m.pdy = m.dy; m.dx = m.ndx; m.dy = m.ndy; m.ndx = m.ndy = 0;
      m.prog = 0; m.committed = false;
      if (arrive) arrive(m);
    }
  }
  function bez(ax, ay, bx, by, cx, cy, t, o) {
    const u = 1 - t;
    o.x = u * u * ax + 2 * u * t * bx + t * t * cx;
    o.y = u * u * ay + 2 * u * t * by + t * t * cy;
  }
  // drawn position: straight along the segment, with corners cut as quadratic Bezier arcs
  function visPos(m, o) {
    const cx = m.tx + 0.5, cy = m.ty + 0.5;
    if (m.dx === 0 && m.dy === 0) { o.x = cx; o.y = cy; return o; }
    const p = m.prog;
    if (p < 0.5 && (m.pdx || m.pdy) && (m.pdx * m.dx + m.pdy * m.dy === 0)) {
      bez(cx - m.pdx * 0.5, cy - m.pdy * 0.5, cx, cy, cx + m.dx * 0.5, cy + m.dy * 0.5, 0.5 + p, o);
    } else if (p >= 0.5 && m.committed && (m.ndx || m.ndy) && (m.ndx * m.dx + m.ndy * m.dy === 0)) {
      const bx = cx + m.dx, by = cy + m.dy;
      bez(bx - m.dx * 0.5, by - m.dy * 0.5, bx, by, bx + m.ndx * 0.5, by + m.ndy * 0.5, p - 0.5, o);
    } else { o.x = cx + m.dx * p; o.y = cy + m.dy * p; }
    return o;
  }
  const logicPos = (m, o) => { o.x = m.tx + 0.5 + m.dx * m.prog; o.y = m.ty + 0.5 + m.dy * m.prog; return o; };

  function chaikin(pts, n) {
    for (let k = 0; k < n; k++) {
      const out = [pts[0]];
      for (let i = 0; i < pts.length - 1; i++) {
        const a = pts[i], b = pts[i + 1];
        out.push({ x: a.x * 0.75 + b.x * 0.25, y: a.y * 0.75 + b.y * 0.25 }, { x: a.x * 0.25 + b.x * 0.75, y: a.y * 0.25 + b.y * 0.75 });
      }
      out.push(pts[pts.length - 1]); pts = out;
    }
    return pts;
  }

  // ----------------------------------------------------------------- AI
  // ChaseAI sees what a player sees on screen: the lantern board (which lanterns remain), where the
  // muncher and each chaser are and which way they head, whether a chaser is frightened (and roughly
  // how long it has left), the public speeds and the well-known chaser personalities. It does NOT see
  // the chasers' scatter/chase timers, release counters or their next turn.
  // Each decision: (1) depth-first over the tile graph (a few dozen tiles = several junctions) scores
  // lantern routes, with a soft worst-case "could a chaser beat me there" term; (2) the best routes
  // per first move are then rolled out against a forward simulation of the four chasers (each assumed
  // to hunt in chase mode with its usual targeting) and any route that gets caught is heavily
  // penalised. Frightened chasers are hunted while they cannot recover first. Output: one direction
  // input (0 up, 1 left, 2 down, 3 right) or -1, at most every tile / 0.1 s like a human.
  const ChaseAI = (() => {
    const tMin = new Float32Array(NTILE);
    const dQ = new Int16Array(NTILE), dPel = new Int16Array(NTILE), dPow = new Int16Array(NTILE), dFG = new Int16Array(NTILE);
    const mark = new Uint8Array(NTILE);
    const fgBonus = new Float32Array(NTILE);
    let DEPTH = 30, NODE_CAP = 16000, K_PER = 6;
    let force = -1, lastCmd = -1, totalLeft = 0, lastCount = -1, lastChange = 0;
    let nodes = 0, pel = null, field = null, wField = 2.2, powerVal = 4, hasThreat = false, curDir = -1, simSpeed = 7;
    let cands = [[], [], [], [], [], [], [], []];
    const stack = new Int16Array(80);
    let aiEpoch = -1, modeClock = 0, lastNow = 0, sched = [7, 20, 7, 20, 5, 20, 5, 1e9];
    let startX = 0, startY = 0, rootD0 = 0, rootRev = false, clearing = false, simClr = false;

    // worst-case arrival time of a chaser at each tile (shortest route, never reversing)
    const sdist = new Int16Array(NTILE * 4), sq = new Int16Array(NTILE * 4);
    function ghostTimes(start, startDir, startDist, speed, delay, frLeft) {
      sdist.fill(-1);
      let h = 0, t = 0;
      const s0 = start * 4 + startDir;
      sdist[s0] = 0; sq[t++] = s0;
      while (h < t) {
        const st = sq[h++], i = st >> 2, d = st & 3, s = sdist[st];
        if (s > 60) break;
        const tn = delay + (startDist + s) / speed;
        if (!(frLeft > 0 && tn < frLeft - 0.2) && tn < tMin[i]) tMin[i] = tn;
        for (let nd = 0; nd < 4; nd++) {
          if (nd === ((d + 2) & 3)) continue;
          const j = NB[i * 4 + nd];
          if (j < 0) continue;
          const ns = j * 4 + nd;
          if (sdist[ns] >= 0) continue;
          sdist[ns] = s + 1; sq[t++] = ns;
        }
      }
    }

    // ---- forward simulation of the chasers against a candidate route
    const G = { on: new Uint8Array(4), i: new Int16Array(4), d: new Int8Array(4), p: new Float32Array(4), delay: new Float32Array(4), frl: new Float32Array(4) };
    let gsp = 6;
    function simInit(ghosts) {
      for (let k = 0; k < 4; k++) { G.on[k] = 0; }
      for (const g of ghosts) {
        const k = g.k;
        if (g.mode === 'eyes' || g.mode === 'entering') continue;
        G.frl[k] = g.fr ? g.frLeft : 0;
        if (g.mode === 'house') { G.on[k] = 1; G.i[k] = HOME_A; G.d[k] = 1; G.p[k] = 0; G.delay[k] = g.fr ? 99 : 1.4; continue; }
        if (g.mode === 'leaving') { G.on[k] = 1; G.i[k] = HOME_A; G.d[k] = 1; G.p[k] = 0; G.delay[k] = 0.5; continue; }
        const gd = g.dx === 0 && g.dy === 0 ? -1 : (g.dy < 0 ? 0 : g.dx < 0 ? 1 : g.dy > 0 ? 2 : 3);
        if (gd < 0) continue;
        G.on[k] = 1; G.i[k] = g.i; G.d[k] = gd; G.p[k] = g.prog; G.delay[k] = 0;
      }
    }
    const tgt = [0, 0];
    function targetOf(k, c, r, pc, pr, pdx, pdy, scatter) {
      if (scatter) { tgt[0] = GHOST_DEFS[k].scatter[0]; tgt[1] = GHOST_DEFS[k].scatter[1]; return; }
      switch (k) {
        case 0: tgt[0] = pc; tgt[1] = pr; break;
        case 1: tgt[0] = pc + pdx * 4; tgt[1] = pr + pdy * 4; break;
        case 2: {
          let bc = pc, br = pr;
          if (G.on[0] && G.delay[0] <= 0) { bc = colOf(G.i[0]); br = rowOf(G.i[0]); }
          tgt[0] = bc + (pc + pdx * 2 - bc) * 2; tgt[1] = br + (pr + pdy * 2 - br) * 2; break;
        }
        default: {
          const dx = c - pc, dy = r - pr;
          if (dx * dx + dy * dy > 64) { tgt[0] = pc; tgt[1] = pr; } else { tgt[0] = GHOST_DEFS[3].scatter[0]; tgt[1] = GHOST_DEFS[3].scatter[1]; }
        }
      }
    }
    // route = tiles stack[0..n); the muncher walks start -> tile0 -> tile1 ... at simSpeed.
    // Returns capture time (Infinity if it survives) and writes the closest approach to simMin.
    let simMin = 9;
    function rollout(n) {
      const dt = 0.03;
      const tEnd = simClr ? (rootD0 + n - 1) / simSpeed : Math.min(5.2, (rootD0 + n) / simSpeed + 0.5);
      let c0x = colOf(stack[0]) + 0.5, c0y = rowOf(stack[0]) + 0.5;
      const d0 = Math.max(0.0001, rootD0);
      simInit(curGhosts);
      for (let k = 0; k < 4; k++) { if (G.on[k] && G.frl[k] > 0 && G.i[k] === 0) { /* noop */ } }
      simMin = 9;
      let px = startX, py = startY, pdx = 0, pdy = 0;
      // where the known scatter/chase schedule stands (it is public knowledge and observable as
      // the chasers all turn around at each switch)
      let ri = 0, acc = 0;
      while (ri < sched.length - 1 && acc + sched[ri] <= modeClock) { acc += sched[ri]; ri++; }
      let nextSwitch = acc + sched[ri];
      for (let t = dt; t <= tEnd; t += dt) {
        if (modeClock + t >= nextSwitch && ri < sched.length - 1) {
          ri++; nextSwitch += sched[ri];
          for (let k = 0; k < 4; k++) {
            if (!G.on[k] || G.delay[k] > 0 || G.frl[k] > 0) continue;
            const j = NB[G.i[k] * 4 + G.d[k]];
            if (j >= 0) { G.i[k] = j; G.d[k] = (G.d[k] + 2) & 3; G.p[k] = 1 - G.p[k]; }
          }
        }
        const scatterNow = (ri & 1) === 0;
        // muncher position at travelled distance s
        const s = t * simSpeed;
        if (s <= d0) { px = startX + (c0x - startX) * (s / d0); py = startY + (c0y - startY) * (s / d0); pdx = Math.sign(c0x - startX); pdy = Math.sign(c0y - startY); if (Math.abs(c0x - startX) > Math.abs(c0y - startY)) pdy = 0; else pdx = 0; }
        else {
          const u = s - d0; let k = Math.floor(u); if (k > n - 2) k = n - 2;
          if (k < 0) { px = c0x; py = c0y; }
          else {
            const fr = Math.min(1, u - k);
            const ax = colOf(stack[k]) + 0.5, ay = rowOf(stack[k]) + 0.5, bx = colOf(stack[k + 1]) + 0.5, by = rowOf(stack[k + 1]) + 0.5;
            px = ax + (bx - ax) * fr; py = ay + (by - ay) * fr; pdx = Math.sign(bx - ax); pdy = Math.sign(by - ay);
          }
        }
        const pc = Math.floor(px), pr = Math.floor(py);
        for (let k = 0; k < 4; k++) {
          if (!G.on[k]) continue;
          if (G.delay[k] > 0) { G.delay[k] -= dt; continue; }
          if (G.frl[k] > 0) G.frl[k] -= dt;
          let prog = G.p[k] + gsp * dt;
          let i = G.i[k], d = G.d[k];
          while (prog >= 1) {
            prog -= 1;
            const j = NB[i * 4 + d];
            if (j < 0) { prog = 0; break; }
            i = j;
            // pick exit direction by the chaser rule (frightened ones wander: treat as the same rule)
            const c = colOf(i), r = rowOf(i);
            targetOf(k, c, r, pc, pr, pdx, pdy, scatterNow);
            let best = 1e9, bd = -1;
            for (let nd = 0; nd < 4; nd++) {
              if (nd === ((d + 2) & 3)) continue;
              const jj = NB[i * 4 + nd]; if (jj < 0) continue;
              const ex = c + DX[nd] - tgt[0], ey = r + DY[nd] - tgt[1], v = ex * ex + ey * ey;
              if (v < best - 1e-9) { best = v; bd = nd; }
            }
            d = bd < 0 ? ((d + 2) & 3) : bd;
          }
          G.i[k] = i; G.d[k] = d; G.p[k] = prog;
          if (G.frl[k] > 0) continue; // frightened: harmless for now
          const gx = colOf(i) + 0.5 + DX[d] * prog, gy = rowOf(i) + 0.5 + DY[d] * prog;
          const ex = gx - px, ey = gy - py, dd = Math.sqrt(ex * ex + ey * ey);
          if (dd < simMin) simMin = dd;
          if (dd < 0.62) return t;
        }
      }
      return Infinity;
    }

    let SAFE_MS = 0.35;
    // ---- tactics (each is a competent, differently-weighted way to play)
    const STYLES = {
      'Pellet sweeper': { safe: 0.5, impat: 0.6, fg: 140, hunt: false, pow: 1, quad: false },
      'Ghost hunter': { safe: 0.32, impat: 1, fg: 260, hunt: true, pow: 1.5, quad: false },
      'Corner clearer': { safe: 0.38, impat: 0.9, fg: 150, hunt: false, pow: 1, quad: true },
      'Super AI': { safe: 0.3, impat: 0, fg: 100, hunt: true, pow: 1.5, quad: false },   // never accepts a close call; best of the swept weightings
    };
    let SUP = false;
    let ST = STYLES['Pellet sweeper'], wJit = 1;
    const quadN = [0, 0, 0, 0];
    const quadOf = i => (colOf(i) >= 14 ? 1 : 0) + (rowOf(i) >= 15 ? 2 : 0);
    function offer(score, cmd, n, ms) {
      if (cmd < 0) cmd = curDir;
      if (cmd < 0) return;
      score += SUP ? 0 : Math.random() * 0.4; // exact ties between equal routes are broken at random
      const L = cands[cmd + (ms < SAFE_MS ? 4 : 0)];
      if (L.length >= K_PER && score <= L[L.length - 1].score) return;
      const e = { score, cmd, n, path: stack.slice(0, n), d0: rootD0, rev: rootRev, sx: startX, sy: startY, clr: clearing };
      let k = L.length;
      L.push(e);
      while (k > 0 && L[k - 1].score < score) { L[k] = L[k - 1]; k--; }
      L[k] = e;
      if (L.length > K_PER) L.pop();
    }

    function visit(node, arrive, tp, steps, acc, cmd, pen, ms, taken) {
      if (++nodes > NODE_CAP) return;
      const slack = tMin[node] - tp;
      if (slack < ms) ms = slack;
      stack[steps] = node;
      let took = 0;
      const pv = pel[node];
      if (pv && !mark[node]) { took = (pv === 2 ? powerVal : 10) * (1 - 0.012 * steps); mark[node] = 1; acc += took; taken++; }
      if (taken >= totalLeft) { // this route clears the board: nothing after it matters
        clearing = true; offer(acc + 3000 - tp * 20 - pen - (ms < SAFE_MS ? 40 : 0), cmd, steps + 1, ms); clearing = false;
        if (took) mark[node] = 0;
        return;
      }
      if (fgBonus[node] && steps > 0) acc += fgBonus[node];
      let any = false;
      if (steps < DEPTH) {
        for (let d = 0; d < 4; d++) {
          if (arrive >= 0 && d === opp(arrive)) continue;
          if (steps === 0 && force !== -1 && force !== d) continue;
          const nb = NB[node * 4 + d];
          if (nb < 0) continue;
          any = true;
          visit(nb, d, tp + 1 / simSpeed, steps + 1, acc, cmd < 0 ? d : cmd, pen, ms, taken);
        }
      }
      if (!any || steps >= DEPTH) {
        let sc;
        if (!any && steps < DEPTH) sc = acc - pen - (hasThreat ? 120 : 10);
        else {
          const dd = field[node] < 0 ? 90 : field[node];
          sc = acc - wField * dd - pen;
        }
        if (hasThreat) sc += Math.max(-1.5, Math.min(ms, 1.5)) * 8 - (ms < SAFE_MS ? 30 + 90 * Math.min(1, SAFE_MS - ms) : 0);
        if (cmd === curDir) sc += 3;
        if (cmd === lastCmd) sc += 14;
        offer(sc, cmd, steps + 1, ms);
      }
      if (took) mark[node] = 0;
    }

    let curGhosts = [];
    return {
      nextDelay: 0.2,
      style: '',
      // new game: forget run state and pick a tactic at random
      reset(sup) {
        const names = Object.keys(STYLES).filter(n => n !== 'Super AI');
        SUP = !!sup;
        DEPTH = 30; NODE_CAP = SUP ? 24000 : 16000; K_PER = SUP ? 10 : 6;
        this.style = SUP ? 'Super AI' : names[(Math.random() * names.length) | 0];
        ST = STYLES[this.style]; SAFE_MS = ST.safe; wJit = SUP ? 1 : 0.9 + Math.random() * 0.2;
        force = -1; lastCmd = -1; lastCount = -1; lastChange = 0; aiEpoch = -1; modeClock = 0;
        return this.style;
      },
      think(o) {
        pel = o.pel;
        let cnt = 0; for (let k = 0; k < PEL_LIST.length; k++) if (pel[PEL_LIST[k]]) cnt++;
        if (cnt !== lastCount) { lastCount = cnt; lastChange = o.now; }
        const stag = o.now - lastChange;
        if (o.epoch !== aiEpoch) { aiEpoch = o.epoch; modeClock = 0; lastNow = o.now; sched = o.sched; }
        else { if (o.frightLeft <= 0) modeClock += o.now - lastNow; lastNow = o.now; }
        totalLeft = cnt;
        simSpeed = o.ps * 0.94; gsp = o.gs;
        tMin.fill(Infinity); fgBonus.fill(0);
        const pac = o.pac;
        curDir = pac.dx === 0 && pac.dy === 0 ? -1 : (pac.dy < 0 ? 0 : pac.dx < 0 ? 1 : pac.dy > 0 ? 2 : 3);
        let rootFwd, d0 = 0;
        if (curDir < 0) rootFwd = pac.i;
        else { rootFwd = NB[pac.i * 4 + curDir]; d0 = 1 - pac.prog; }
        // ---- threats (worst case) and catchable frightened chasers
        const fgSrc = [];
        curGhosts = [];
        for (const g of o.ghosts) {
          if (g.mode === 'eyes' || g.mode === 'entering') continue;
          const fl = g.fr ? o.frightLeft : 0;
          const gd = g.dx === 0 && g.dy === 0 ? -1 : (g.dy < 0 ? 0 : g.dx < 0 ? 1 : g.dy > 0 ? 2 : 3);
          curGhosts.push({ k: g.k, mode: g.mode, fr: g.fr, frLeft: fl, i: g.i, dx: g.dx, dy: g.dy, prog: g.prog });
          if (g.mode === 'house') { ghostTimes(HOME_A, 1, 0.5, o.gs, g.fr ? 99 : 1.4, 0); continue; }
          if (g.mode === 'leaving') { ghostTimes(HOME_A, 1, 0.5, o.gs, 0, g.fr ? fl : 0); continue; }
          if (gd < 0) continue;
          const B = NB[g.i * 4 + gd], rem = 1 - g.prog;
          if (B < 0) continue;
          if (g.fr) { fgSrc.push(B); if (fl > 1.3) continue; }
          ghostTimes(B, gd, rem, o.gs, 0, g.fr ? fl : 0);
        }
        const nearT = tMin[rootFwd >= 0 ? rootFwd : pac.i];
        hasThreat = nearT < 7;
        // ---- goal fields
        const srcP = [], srcW = [];
        for (let k = 0; k < PEL_LIST.length; k++) { const i = PEL_LIST[k]; if (pel[i]) { srcP.push(i); if (pel[i] === 2) srcW.push(i); } }
        bfsField(srcP, dPel);
        let fgActive = false;
        if (fgSrc.length) {
          bfsField(fgSrc, dFG);
          const rt = rootFwd >= 0 ? rootFwd : pac.i;
          const dd = dFG[rt];
          if (dd >= 0 && (dd + d0) / simSpeed < o.frightLeft - 0.4) {
            fgActive = true;
            for (const s of fgSrc) fgBonus[s] = ST.fg;
          }
        }
        powerVal = -6;
        const nonPower = srcP.length - srcW.length;
        if (nonPower <= 6) powerVal = 14;
        if (fgActive) { field = dFG; wField = 7; }
        else if (srcW.length && (nearT < (ST.hunt ? 3.4 : 2.2) || stag >= (ST.hunt ? 4 : 6)) && (ST.hunt || srcW.length > 1 || cnt <= 70 || stag >= 6 || nearT < 1.0)) {
          bfsField(srcW, dPow); field = dPow; wField = 4.5; powerVal = 140 * ST.pow;
        } else {
          if (srcW.length === 1 && cnt > 70 && !ST.hunt) powerVal = -20; // keep the last power lantern in reserve
          field = dPel; wField = 2.2 + Math.min(4, Math.max(0, stag - 4) * 0.35);
          if (ST.quad && !hasThreat) {
            // corner clearer: finish the quarter of the board it is in (or the emptiest one) before moving on
            quadN[0] = quadN[1] = quadN[2] = quadN[3] = 0;
            for (const i of srcP) quadN[quadOf(i)]++;
            let q = quadOf(pac.i); if (quadN[q] === 0) { q = -1; let b = 1e9; for (let k = 0; k < 4; k++) if (quadN[k] > 0 && quadN[k] < b) { b = quadN[k]; q = k; } }
            if (q >= 0 && quadN[q] > 0) { const qs = srcP.filter(i => quadOf(i) === q); bfsField(qs, dQ); field = dQ; }
          }
          wField *= wJit;
        }
        // ---- stage 1: enumerate routes
        nodes = 0; cands = [[], [], [], [], [], [], [], []];
        startX = pac.i >= 0 ? colOf(pac.i) + 0.5 + pac.dx * pac.prog : 0; startY = rowOf(pac.i) + 0.5 + pac.dy * pac.prog;
        if (curDir < 0) {
          rootD0 = 0; rootRev = false;
          visit(pac.i, -1, 0, 0, 0, -1, 0, 9, 0);
        } else {
          force = pac.nd >= 0 ? pac.nd : (pac.nd === -2 ? -3 : -1);
          rootD0 = d0; rootRev = false;
          if (rootFwd >= 0) visit(rootFwd, curDir, d0 / simSpeed, 0, 0, pac.nd >= 0 ? pac.nd : -1, 0, 9, 0);
          force = -1;
          const rv = opp(curDir);
          rootD0 = pac.prog; rootRev = true;
          visit(pac.i, rv, pac.prog / simSpeed, 0, 0, rv, 60, 9, 0);
        }
        // ---- stage 2: rollouts against the simulated chasers
        let bestScore = -1e9, bestCmd = -1;
        const any = o.ghosts.some(g => g.mode !== 'eyes' && g.mode !== 'entering');
        const margin = ST.impat * Math.max(stag < 4 ? 0 : Math.min(1, (stag - 4) / 10), cnt <= 50 ? (50 - cnt) / 50 * 0.65 : 0); // impatience: stalled / nearly done -> accept closer calls
        for (let c = 0; c < 8; c++) {
          for (const e of cands[c]) {
            rootD0 = e.d0; startX = e.sx; startY = e.sy; simClr = e.clr;
            for (let k = 0; k < e.n; k++) stack[k] = e.path[k];
            let sc = e.score;
            if (any) {
              const tc = rollout(e.n);
              if (this.debug) this.debug.push([e.cmd, e.rev ? 'R' : 'F', Math.round(e.score), +tc.toFixed(2), e.n, +simMin.toFixed(2)]);
              if (tc !== Infinity) sc += -6000 * (1 - 0.97 * margin) + 250 * tc;
              else sc += Math.min(simMin, 4) * 7;
            }
            sc += SUP ? 0 : Math.random() * 0.4;
            if (sc > bestScore) { bestScore = sc; bestCmd = e.cmd; }
          }
        }
        this.nextDelay = SUP ? (hasThreat ? 0.04 : 0.1) : hasThreat ? 0.1 : 0.25;
        this.lastNodes = nodes;
        if (bestCmd >= 0) lastCmd = bestCmd;
        return bestCmd;
      },
    };
  })();

  // ----------------------------------------------------------------- visuals: sprites and caches
  const haloCache = {};
  function halo(color) {
    if (haloCache[color]) return haloCache[color];
    const c = document.createElement('canvas'); c.width = c.height = 64;
    const x = c.getContext('2d'), g = x.createRadialGradient(32, 32, 0, 32, 32, 32);
    g.addColorStop(0, color); g.addColorStop(0.35, color.replace(/[\d.]+\)$/, '0.35)')); g.addColorStop(1, color.replace(/[\d.]+\)$/, '0)'));
    x.fillStyle = g; x.fillRect(0, 0, 64, 64);
    return (haloCache[color] = c);
  }
  const H_WARM = 'rgba(255,190,100,1)', H_HOT = 'rgba(255,120,60,1)', H_GOLD = 'rgba(255,215,120,1)';
  const frac = v => v - Math.floor(v);

  function buildMazeCache(T, dpr) {
    const w = Math.ceil(COLS * T * dpr), h = Math.ceil(ROWS * T * dpr);
    const mk = () => { const c = document.createElement('canvas'); c.width = w; c.height = h; const x = c.getContext('2d'); x.scale(w / COLS, h / ROWS); x.lineJoin = 'round'; x.lineCap = 'round'; return [c, x]; };
    const [fillC, fx] = mk();
    fx.beginPath();
    for (const lp of LOOPS) loopPath(fx, lp, 0, 0.32);
    const gr = fx.createLinearGradient(0, 0, 0, ROWS);
    gr.addColorStop(0, '#271b45'); gr.addColorStop(0.5, '#20173b'); gr.addColorStop(1, '#1b1332');
    fx.fillStyle = gr; fx.fill('evenodd');
    fx.save(); fx.clip('evenodd');
    // awning stripes + soft inner light
    for (let k = -2; k < COLS * 2; k += 1) { fx.fillStyle = (k & 1) ? 'rgba(255,170,90,0.028)' : 'rgba(120,80,200,0.03)'; fx.fillRect(k * 0.5, 0, 0.5, ROWS); }
    fx.restore();
    fx.beginPath(); for (const lp of LOOPS) loopPath(fx, lp, 0.1, 0.28);
    fx.strokeStyle = 'rgba(255,190,110,0.07)'; fx.lineWidth = 0.09; fx.stroke();

    const lines = (core, hi, glowA, glowB) => {
      const [lc, lx] = mk(); const [gc, gx] = mk();
      lx.beginPath(); for (const lp of LOOPS) loopPath(lx, lp, 0.2, 0.3);
      lx.strokeStyle = core; lx.lineWidth = 0.075; lx.stroke();
      lx.strokeStyle = hi; lx.lineWidth = 0.025; lx.globalAlpha = 0.85; lx.stroke();
      gx.beginPath(); for (const lp of LOOPS) loopPath(gx, lp, 0.2, 0.3);
      gx.strokeStyle = glowA; gx.lineWidth = 0.62; gx.globalAlpha = 0.07; gx.stroke();
      gx.strokeStyle = glowB; gx.lineWidth = 0.34; gx.globalAlpha = 0.11; gx.stroke();
      gx.lineWidth = 0.16; gx.globalAlpha = 0.2; gx.stroke();
      return [lc, gc];
    };
    const [lA, gA] = lines('#ffbf55', '#fff0c8', '#ff8a2a', '#ffa43f');
    const [lB, gB] = lines('#cfe6ff', '#ffffff', '#6fa8ff', '#9cc6ff');
    return { key: T + '|' + dpr, fillC, lA, gA, lB, gB };
  }

  // ----------------------------------------------------------------- the game
  class Chase {
    constructor(opts = {}) {
      this.superAI = !!opts.superAI;
      this.W = 1600; this.H = 900; this.T = 24; this.ox = 0; this.oy = 0;
      this.t = 0; this.clock = 0; this.over = false; this.won = false; this.endReason = '';
      this.score = 0; this.lives = 3; this.level = 1;
      this.particles = new Particles(); this.popups = []; this.rings = [];
      this.cache = null; this.want = -1; this.aiCool = 0; this.aiTile = -1;
      this.endT = 0; this.celebT = 0;
      this.bg = { seed: Math.random() * 100 };
      // random maze per game (night 2 switches to a different one) and a random AI tactic
      this.mazes = [(Math.random() * MAZES.length) | 0];
      this.mazes.push((this.mazes[0] + 1 + ((Math.random() * (MAZES.length - 1)) | 0)) % MAZES.length);
      this.style = ChaseAI.reset(this.superAI);
      this.loadLevel(1);
    }

    // ---- level / life setup
    loadLevel(n) {
      this.level = n; this.lv = LV[n - 1];
      if (mazeId !== this.mazes[n - 1]) { loadMaze(this.mazes[n - 1]); this.cache = null; }
      this.pel = new Uint8Array(PEL0); this.pelLeft = PELLETS0;
      this.eaten = 0; this.globalMode = false; this.globalCount = 0;
      this.reveal = 0; this.flashT = 0;
      this.resetActors(true);
    }
    resetActors(newLevel) {
      const lv = this.lv;
      this.pl = mkMover(IDX(13, 23), -1);
      this.plAng = Math.PI; this.plAngTarget = Math.PI; this.mouth = 0.4; this.chomp = 0; this.eatSlow = 0;
      this.want = -1; this.aiTile = -1; this.aiCool = 0;
      this.gh = GHOST_DEFS.map((d, k) => {
        const g = { k, def: d, mode: 'house', fr: false, m: mkMover(HOME_A, 1), x: d.slot, y: 14.5, path: null, pi: 0, wait: 0, lx: 0, ly: 0, phase: Math.random() * 6, bob: Math.random() * 6, alpha: 1 };
        if (k === 0) { g.mode = 'move'; g.m = mkMover(HOME_A, 1); const p = visPos(g.m, {}); g.x = p.x; g.y = p.y; g.lx = -1; }
        return g;
      });
      this.modeIdx = 0; this.modeT = 0; this.chaseMode = false;
      this.fright = 0; this.frightTotal = 0; this.eatCount = 0;
      this.idleT = 0;
      this.phase = 'ready'; this.phaseT = newLevel ? 2.6 : 1.9; this.epoch = (this.epoch || 0) + 1;
      this.dyingT = 0; this.freezeT = 0; this.ghostFade = 1;
    }

    resize(W, H) {
      this.W = W; this.H = H;
      const rows = ROWS + 1.7;
      this.T = Math.max(8, Math.min(W * 0.88 / COLS, H * 0.9 / rows));
      this.ox = (W - COLS * this.T) / 2;
      this.oy = (H - rows * this.T) / 2 + 1.7 * this.T;
      if (this.ox < 370 && this.oy + ROWS * this.T > H - 104) { // keep clear of the shell HUD box (bottom-left)
        this.T = Math.max(8, Math.min(W * 0.88 / COLS, (H - 104 - H * 0.03) / rows));
        this.ox = (W - COLS * this.T) / 2;
        this.oy = (H * 0.03 + H - 104 - rows * this.T) / 2 + 1.7 * this.T;
      }
    }

    // ---- observation: strictly what is visible
    observe() {
      const pl = this.pl;
      return {
        pel: this.pel,
        pac: { i: pl.i, dx: pl.dx, dy: pl.dy, prog: pl.prog, nd: pl.committed ? ((pl.ndx || pl.ndy) ? (pl.ndy < 0 ? 0 : pl.ndx < 0 ? 1 : pl.ndy > 0 ? 2 : 3) : -2) : -1 },
        ghosts: this.gh.map(g => ({ k: g.k, mode: g.mode, fr: g.fr, i: g.m.i, dx: g.mode === 'move' ? g.m.dx : 0, dy: g.mode === 'move' ? g.m.dy : 0, prog: g.m.prog })),
        frightLeft: this.fright, now: this.clock, epoch: this.epoch, sched: this.lv.sched,
        ps: this.lv.ps, gs: this.lv.gs,
      };
    }

    // ---- player control
    pickPlayer = (m) => {
      const d = dirOf(m), B = NB[m.i * 4 + d];
      let nd = -1;
      if (this.want >= 0 && this.want !== opp(d) && B >= 0 && NB[B * 4 + this.want] >= 0) nd = this.want;
      else if (B >= 0 && NB[B * 4 + d] >= 0) nd = d;
      m.ndx = nd >= 0 ? DX[nd] : 0; m.ndy = nd >= 0 ? DY[nd] : 0;
    };
    arrivePlayer = (m) => {
      const i = m.i, pv = this.pel[i];
      if (pv) {
        this.pel[i] = 0; this.pelLeft--; this.eaten++; this.eatSlow = 0.12; this.idleT = 0;
        if (this.globalMode) this.globalCount++;
        const cx = colOf(i) + 0.5, cy = rowOf(i) + 0.5;
        if (pv === 2) {
          this.score += 50; this.startFright();
          this.rings.push({ x: cx, y: cy, t: 0 });
          this.particles.burst(cx, cy, 26, { speed: 7, speedMin: 2, size: 0.13, life: 0.9, color: ['#ffd27a', '#ff8a4a', '#fff0c8'], drag: 2.5 });
        } else {
          this.score += 10;
          if (Math.random() < 0.5) this.particles.burst(cx, cy, 2, { speed: 2.2, speedMin: 0.6, size: 0.07, life: 0.5, color: ['#ffd27a', '#fff0c8'], drag: 3 });
        }
      }
    };
    startFright() {
      const lv = this.lv;
      this.fright = lv.fright; this.frightTotal = lv.fright; this.eatCount = 0;
      for (const g of this.gh) {
        if (g.mode === 'eyes' || g.mode === 'entering') continue;
        const wasFr = g.fr; g.fr = true;
        if (g.mode === 'move' && !wasFr) reverseMover(g.m);
      }
    }

    // ---- ghosts
    ghostTarget(g) {
      const pl = this.pl, pp = logicPos(pl, {});
      const pc = Math.floor(pp.x), pr = Math.floor(pp.y);
      let pdx = pl.dx, pdy = pl.dy;
      if (!this.chaseMode) return g.def.scatter;
      switch (g.k) {
        case 0: return [pc, pr];
        case 1: return [pc + pdx * 4, pr + pdy * 4];
        case 2: {
          const b = this.gh[0].m;
          const px = pc + pdx * 2, py = pr + pdy * 2;
          return [b.tx + (px - b.tx) * 2, b.ty + (py - b.ty) * 2];
        }
        default: {
          const dx = g.m.tx - pc, dy = g.m.ty - pr;
          return (dx * dx + dy * dy > 64) ? [pc, pr] : g.def.scatter;
        }
      }
    }
    pickGhost(g) {
      const m = g.m, d = dirOf(m), B = NB[m.i * 4 + d];
      const choices = [];
      if (B >= 0) for (let k = 0; k < 4; k++) { if (k === opp(d)) continue; if (NB[B * 4 + k] >= 0) choices.push(k); }
      let nd;
      if (!choices.length) nd = opp(d);
      else if (choices.length === 1) nd = choices[0];
      else if (g.mode === 'eyes') {
        let best = 1e9; nd = choices[0];
        for (const k of choices) { const v = DIST_HOME[NB[B * 4 + k]]; if (v < best) { best = v; nd = k; } }
      } else if (g.fr) nd = choices[(Math.random() * choices.length) | 0];
      else {
        const tg = this.ghostTarget(g), bc = colOf(B), br = rowOf(B);
        let best = 1e9; nd = choices[0];
        for (const k of choices) {
          const dx = bc + DX[k] - tg[0], dy = br + DY[k] - tg[1], v = dx * dx + dy * dy;
          if (v < best - 1e-9) { best = v; nd = k; }
        }
      }
      m.ndx = DX[nd]; m.ndy = DY[nd];
    }
    ghostSpeed(g) {
      const lv = this.lv;
      if (g.mode === 'eyes') return EYES_SPEED;
      if (g.mode !== 'move') return HOUSE_SPEED;
      const m = g.m;
      if (m.ty === TUN && (m.tx < 2 || m.tx > 25)) return lv.gtun;
      if (g.fr) return lv.gfr;
      let s = lv.gs;
      if (g.k === 0 && this.pelLeft <= 20) s *= 1.04;
      return s;
    }
    startPath(g, pts, mode) {
      g.mode = mode; g.path = chaikin(pts, 3); g.pi = 1; g.x = g.path[0].x; g.y = g.path[0].y;
    }
    startLeaving(g) {
      this.startPath(g, [{ x: g.x, y: g.y }, { x: 14, y: 14.5 }, { x: 14, y: 12.6 }, { x: 13.5, y: 11.5 }], 'leaving');
    }
    pathDone(g) {
      g.path = null;
      if (g.mode === 'leaving') { g.mode = 'move'; setTile(g.m, HOME_A, 1); }
      else if (g.mode === 'entering') { g.fr = false; g.mode = 'house'; g.wait = 0.45; g.x = 14; g.y = 14.5; }
    }
    updateGhost(g, dt) {
      const sp = this.ghostSpeed(g) * dt;
      g.phase += dt * (g.fr ? 7 : 9);
      let lookx = g.lx, looky = g.ly;
      if (g.mode === 'house') {
        g.bob += dt * 5;
        if (g.wait > 0) g.wait -= dt;
        // after reviving inside the house, leave right away
        if (g.revive && g.wait <= 0) { g.revive = false; this.startLeaving(g); }
      } else if (g.path) {
        let dist = sp;
        while (dist > 1e-9 && g.pi < g.path.length) {
          const p = g.path[g.pi], dx = p.x - g.x, dy = p.y - g.y, L = Math.hypot(dx, dy);
          if (L <= dist) { g.x = p.x; g.y = p.y; dist -= L; g.pi++; }
          else { g.x += dx / L * dist; g.y += dy / L * dist; lookx = dx / L; looky = dy / L; dist = 0; }
        }
        if (g.pi >= g.path.length) this.pathDone(g);
      } else {
        const m = g.m;
        advance(m, sp, () => this.pickGhost(g), mm => {
          if (g.mode === 'eyes' && (mm.i === HOME_A || mm.i === HOME_B)) {
            const cx = mm.tx + 0.5;
            this.startPath(g, [{ x: cx, y: 11.5 }, { x: 14, y: 12.4 }, { x: 14, y: 14.5 }], 'entering');
            g.revive = true;
          }
        });
        if (!g.path) {
          const p = visPos(m, {}); g.x = p.x; g.y = p.y;
          lookx = m.dx; looky = m.dy;
        }
      }
      const k = Math.min(1, dt * 10);
      g.lx += (lookx - g.lx) * k; g.ly += (looky - g.ly) * k;
    }

    // ---- main step
    _ipg() { return [[this.gh, ['x', 'y'], 2.5]]; }
    step(dt) {
      IP.snap(this._ipg());
      { const q = visPos(this.pl, {}); this.pl._vx = q.x; this.pl._vy = q.y; }
      this.t += dt;
      this.particles.update(dt);
      for (let i = this.popups.length - 1; i >= 0; i--) { const p = this.popups[i]; p.t += dt; if (p.t > 1.1) this.popups.splice(i, 1); }
      for (let i = this.rings.length - 1; i >= 0; i--) { this.rings[i].t += dt; if (this.rings[i].t > 0.9) this.rings.splice(i, 1); }
      this.reveal = Math.min(1, this.reveal + dt / 1.3);
      if (this.over) this.endT += dt;
      if (!this.over) {
        this.clock += dt;
        if (this.clock > TIME_CAP) { this.over = true; this.won = false; this.endReason = 'time'; }
      }
      if (this.fright > 0 || this.frightFade > 0) { this.frightFade = Math.min(1, Math.max(0, (this.frightFade || 0) + (this.fright > 0 ? dt * 4 : -dt * 3))); }
      switch (this.phase) {
        case 'ready': this.stepReady(dt); break;
        case 'play': this.stepPlay(dt); break;
        case 'freeze':
          this.freezeT -= dt;
          // eaten chaser's eyes keep moving after the pop
          if (this.freezeT <= 0) this.phase = 'play';
          break;
        case 'dying': this.stepDying(dt); break;
        case 'clear': this.stepClear(dt); break;
        case 'celebrate': this.stepCelebrate(dt); break;
        case 'lost': break;
      }
      // pac animation easing (visual state kept in step so draw stays pure)
      const pl = this.pl, d = dirOf(pl);
      if (this.phase !== 'dying') {
        let tgt = this.plAngTarget;
        if (d >= 0) tgt = Math.atan2(pl.dy, pl.dx);
        this.plAngTarget = tgt;
        let da = tgt - this.plAng; da = Math.atan2(Math.sin(da), Math.cos(da));
        this.plAng += da * Math.min(1, dt * 18);
      }
    }
    stepReady(dt) {
      this.phaseT -= dt;
      for (const g of this.gh) { g.phase += dt * 6; g.bob += dt * 5; const k = Math.min(1, dt * 10); g.lx += (-1 - g.lx) * k; }
      if (this.phaseT <= 0) this.phase = 'play';
    }
    stepPlay(dt) {
      const lv = this.lv;
      // scatter / chase schedule (paused while frightened)
      if (this.fright <= 0) {
        this.modeT += dt;
        if (this.modeT >= lv.sched[this.modeIdx]) {
          this.modeT = 0; this.modeIdx = Math.min(this.modeIdx + 1, lv.sched.length - 1);
          this.chaseMode = (this.modeIdx & 1) === 1;
          for (const g of this.gh) if (g.mode === 'move' && !g.fr) reverseMover(g.m);
        }
      } else {
        this.fright -= dt;
        if (this.fright <= 0) { this.fright = 0; for (const g of this.gh) g.fr = false; }
      }
      this.idleT += dt;

      // AI -> direction input
      this.aiCool -= dt;
      const pl = this.pl;
      if (pl.i !== this.aiTile || this.aiCool <= 0) {
        this.aiTile = pl.i;
        const cmd = ChaseAI.think(this.observe());
        this.aiCool = ChaseAI.nextDelay;
        if (cmd >= 0) this.want = cmd;
      }
      // player movement
      const pd = dirOf(pl);
      if (pd >= 0 && this.want === opp(pd)) reverseMover(pl);
      if (pd < 0 && this.want >= 0 && NB[pl.i * 4 + this.want] >= 0) {
        pl.dx = DX[this.want]; pl.dy = DY[this.want]; pl.prog = 0; pl.committed = false; pl.pdx = pl.pdy = 0;
      }
      this.eatSlow = Math.max(0, this.eatSlow - dt);
      let ps = lv.ps * (this.eatSlow > 0 ? 0.9 : 1) * (this.fright > 0 ? 1.08 : 1);
      if (pl.ty === TUN && (pl.tx < 2 || pl.tx > 25)) ps *= 0.95;
      const before = pl.prog + pl.i * 2;
      const moving = dirOf(pl) >= 0;
      advance(pl, ps * dt, this.pickPlayer, this.arrivePlayer);
      if (moving) this.chomp += ps * dt * 3.4; else this.chomp += dt * 2;
      const mt = moving ? 0.5 + 0.5 * Math.sin(this.chomp * 3.2) : 0.5;
      this.mouth = 0.05 + 0.6 * mt;
      void before;

      if (this.pelLeft <= 0) { this.beginClear(); return; }

      // release from house
      this.releaseCheck(dt);
      // ghosts
      for (const g of this.gh) this.updateGhost(g, dt);
      // collisions
      const pp = logicPos(pl, {}), gp = {};
      for (const g of this.gh) {
        if (g.mode !== 'move') continue;
        let dx = g.x - pp.x; const dy = g.y - pp.y;
        if (Math.abs(dx) > 15) dx -= Math.sign(dx) * 31;
        if (dx * dx + dy * dy < 0.5 * 0.5) {
          if (g.fr) this.eatGhost(g);
          else { this.beginDeath(); return; }
        }
      }
      void gp;
    }
    releaseCheck(dt) {
      const lv = this.lv;
      const waiting = this.gh.filter(g => g.mode === 'house' && !g.revive);
      if (!waiting.length) return;
      // leave in order pinky(1) inky(2) clyde(3)
      const g = waiting.sort((a, b) => a.k - b.k)[0];
      let go = false;
      if (this.globalMode) go = this.globalCount >= [0, 7, 17, 32][g.k];
      else go = this.eaten >= lv.rel[g.k - 1];
      if (!go && this.idleT > (this.level === 1 ? 3.5 : 2.5)) { go = true; this.idleT = 0; }
      if (go && g.wait <= 0) this.startLeaving(g);
    }
    eatGhost(g) {
      const pts = 200 << Math.min(3, this.eatCount); this.eatCount++;
      this.score += pts;
      this.popups.push({ x: g.x, y: g.y, text: String(pts), t: 0 });
      this.particles.burst(g.x, g.y, 34, { speed: 8, speedMin: 2, size: 0.14, life: 1.1, gravity: 7, drag: 1.6, color: ['#ff5d73', '#ffd166', '#06d6a0', '#4cc9f0', '#b794f6', '#ffffff', g.def.color] });
      g.fr = false; g.mode = 'eyes'; g.path = null;
      // make sure the mover is on the grid for eye pathing
      this.phase = 'freeze'; this.freezeT = 0.5;
    }
    beginDeath() {
      this.phase = 'dying'; this.dyingT = 0;
      if (this.lives <= 1) { this.lives = 0; this.over = true; this.won = false; this.endReason = 'caught'; }
    }
    stepDying(dt) {
      this.dyingT += dt;
      this.ghostFade = Math.max(0, 1 - this.dyingT / 0.5);
      const pp = visPos(this.pl, {});
      if (!this.deathPopped && this.dyingT > 1.25) {
        this.deathPopped = true;
        this.particles.burst(pp.x, pp.y, 30, { speed: 6, speedMin: 1, size: 0.12, life: 1.2, gravity: 3, drag: 1.8, color: ['#ffd36a', '#ffb43a', '#fff0c8'] });
      }
      if (this.dyingT > 1.9) {
        this.deathPopped = false;
        if (this.over) { this.phase = 'lost'; return; }
        this.lives--;
        this.globalMode = true; this.globalCount = 0;
        this.resetActors(false);
        this.phase = 'ready'; this.phaseT = 1.8;
        for (const g of this.gh) g.fr = false;
      }
    }
    beginClear() {
      this.phase = 'clear'; this.phaseT = 2.3; this.flashT = 0;
      if (this.level >= 2) { this.over = true; this.won = true; this.endReason = 'won'; }
    }
    stepClear(dt) {
      this.phaseT -= dt; this.flashT += dt;
      this.ghostFade = Math.max(0, 1 - this.flashT / 0.5);
      if (this.over && this.won && Math.random() < dt * 14) this.confetti();
      if (this.phaseT <= 0) {
        if (this.level >= 2) { this.phase = 'celebrate'; return; }
        this.loadLevel(this.level + 1);
        this.ghostFade = 1;
      }
    }
    stepCelebrate(dt) {
      this.celebT += dt;
      if (Math.random() < dt * 8) this.confetti();
    }
    confetti() {
      const x = 3 + Math.random() * 22, y = 4 + Math.random() * 20;
      this.particles.burst(x, y, 22, { speed: 7, speedMin: 2, size: 0.15, life: 1.4, gravity: 5, drag: 1.4, color: ['#ff5d73', '#ffd166', '#06d6a0', '#4cc9f0', '#b794f6', '#ffffff'] });
    }

    hud() {
      const s = String(this.score).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
      return { score: s, detail: `Level ${this.level}/2 · ${this.lives} ${this.lives === 1 ? 'life' : 'lives'} · ${this.pelLeft} lanterns left` };
    }
    result() {
      if (this.endReason === 'won') return `Cleared both nights with ${this.lives} ${this.lives === 1 ? 'life' : 'lives'} to spare`;
      if (this.endReason === 'time') return `Out of time on night ${this.level}`;
      return `Caught on night ${this.level} with ${this.pelLeft} lanterns left`;
    }

    // ================================================================= drawing
    draw(ctx, W, H) {
      const a = IP.alpha();
      const st = IP.push(this._ipg(), a);
      try { this._draw(ctx, W, H); } finally { IP.pop(st); }
    }
    _draw(ctx, W, H) {
      const T = this.T, ox = this.ox, oy = this.oy, t = this.t;
      const dpr = ctx.getTransform().a || 1;
      this.drawBackground(ctx, W, H, t);
      // panel
      const px = ox - T * 0.5, py = oy - T * 2.0, pw = COLS * T + T, ph = (ROWS + 2.5) * T;
      ctx.save();
      roundRect(ctx, px, py, pw, ph, T * 0.9);
      ctx.fillStyle = 'rgba(14,9,26,0.97)'; ctx.fill();
      const pg = ctx.createRadialGradient(W / 2, oy + ROWS * T * 0.5, T, W / 2, oy + ROWS * T * 0.5, T * 20);
      pg.addColorStop(0, 'rgba(255,150,70,0.05)'); pg.addColorStop(1, 'rgba(255,150,70,0)');
      ctx.fillStyle = pg; ctx.fill();
      ctx.strokeStyle = 'rgba(255,190,110,0.14)'; ctx.lineWidth = Math.max(1, T * 0.06); ctx.stroke();
      ctx.restore();

      if (!this.cache || this.cache.key !== T + '|' + dpr) this.cache = buildMazeCache(T, dpr);
      const C = this.cache;
      const flashing = this.phase === 'clear' && this.flashT > 0.3;
      const alt = flashing && (Math.floor((this.flashT - 0.3) / 0.28) & 1) === 1;
      const rv = ease.outCubic(this.reveal);
      const fadeAll = (this.phase === 'lost' || (this.over && !this.won && this.phase === 'dying')) ? Math.max(0.35, 1 - this.endT * 0.25) : 1;

      ctx.save();
      ctx.beginPath(); ctx.rect(ox, oy, COLS * T, ROWS * T * Math.max(0.001, rv)); ctx.clip();
      ctx.globalAlpha = fadeAll;
      ctx.drawImage(C.fillC, ox, oy, COLS * T, ROWS * T);
      ctx.drawImage(alt ? C.lB : C.lA, ox, oy, COLS * T, ROWS * T);
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = fadeAll * (alt ? 0.9 : 0.8 + 0.2 * Math.sin(t * 1.7));
      ctx.drawImage(alt ? C.gB : C.gA, ox, oy, COLS * T, ROWS * T);
      ctx.restore();

      // frightened tint
      if ((this.frightFade || 0) > 0) {
        ctx.save(); ctx.globalAlpha = 0.1 * this.frightFade; ctx.fillStyle = '#3a40d8';
        ctx.fillRect(ox, oy, COLS * T, ROWS * T); ctx.restore();
      }

      // world space
      ctx.save();
      ctx.beginPath(); ctx.rect(ox, oy, COLS * T, ROWS * T); ctx.clip();
      ctx.translate(ox, oy); ctx.scale(T, T);
      this.drawDoor(ctx, t);
      this.drawPellets(ctx, t, rv, fadeAll);
      this.drawRings(ctx);
      const ghostsFirst = true; void ghostsFirst;
      for (const g of this.gh) this.drawGhost(ctx, g, t);
      this.drawPlayer(ctx, t);
      this.particles.draw(ctx, 1);
      ctx.restore();

      this.drawText(ctx, W, H);
      this.drawStrip(ctx, W, H);
      // dim at the end of a lost game
      if (this.over && !this.won) {
        ctx.save(); ctx.globalAlpha = Math.min(0.45, this.endT * 0.25); ctx.fillStyle = '#0a0612'; ctx.fillRect(0, 0, W, H); ctx.restore();
      }
    }

    drawBackground(ctx, W, H, t) {
      staticLayer(ctx, 'bg', W, H, (x, W, H) => {
        const g = x.createLinearGradient(0, 0, 0, H);
        g.addColorStop(0, '#1d1434'); g.addColorStop(0.45, '#140f24'); g.addColorStop(1, '#0d0919');
        x.fillStyle = g; x.fillRect(0, 0, W, H);
      });
      // warm bokeh
      const seed = this.bg.seed;
      const cols = [H_WARM, H_HOT, H_GOLD, 'rgba(170,110,255,1)'];
      ctx.save(); ctx.globalCompositeOperation = 'lighter';
      for (let i = 0; i < 9; i++) {
        const x = W * (0.08 + 0.84 * frac(i * 0.381 + seed)) + Math.sin(t * 0.06 * (1 + i * 0.3) + i * 2) * W * 0.05;
        const y = H * (0.12 + 0.8 * frac(i * 0.713 + seed * 0.3)) + Math.cos(t * 0.05 * (1 + i * 0.2) + i) * H * 0.04;
        const r = H * (0.08 + 0.1 * frac(i * 0.57 + 0.2));
        ctx.globalAlpha = 0.05 + 0.025 * Math.sin(t * 0.3 + i);
        ctx.drawImage(halo(cols[i % cols.length]), x - r, y - r, r * 2, r * 2);
      }
      ctx.restore();
      // hanging strings of paper lanterns
      const strings = [[0.035, 0.05], [0.1, 0.06]];
      const lcol = [['#e5484d', '#ff8a6a'], ['#f5a524', '#ffe08a'], ['#ff6f3c', '#ffb48a']];
      for (let s = 0; s < strings.length; s++) {
        const y0 = H * strings[s][0], sag = H * strings[s][1];
        const n = Math.max(6, Math.round(W / (s ? 130 : 105)));
        ctx.strokeStyle = 'rgba(255,200,140,0.22)'; ctx.lineWidth = 1.2;
        ctx.beginPath();
        for (let k = 0; k <= 40; k++) { const u = k / 40; const x = -10 + (W + 20) * u, y = y0 + sag * 4 * u * (1 - u); k ? ctx.lineTo(x, y) : ctx.moveTo(x, y); }
        ctx.stroke();
        for (let k = 0; k < n; k++) {
          const u = (k + 0.5 + (s ? 0.35 : 0)) / (n + 0.4);
          const x = -10 + (W + 20) * u, y = y0 + sag * 4 * u * (1 - u);
          const r = Math.max(7, Math.min(22, H * 0.02)) * (0.85 + 0.3 * frac(k * 0.77 + s));
          const sw = Math.sin(t * 0.9 + k * 1.7 + s) * 0.09;
          const cc = lcol[(k + s) % lcol.length];
          this.paperLantern(ctx, x, y, r, sw, cc[0], cc[1], t + k);
        }
      }
      // embers
      ctx.save(); ctx.globalCompositeOperation = 'lighter';
      for (let i = 0; i < 38; i++) {
        const sp = 0.012 + 0.02 * frac(i * 0.77);
        const life = frac(t * sp + i * 0.137);
        const x = W * frac(i * 0.618 + seed) + Math.sin(t * 0.7 + i) * 14;
        const y = H * (1.05 - life * 1.1);
        ctx.globalAlpha = 0.5 * Math.sin(Math.PI * life);
        const r = 1 + 1.6 * frac(i * 0.31);
        ctx.fillStyle = i % 3 ? '#ffb066' : '#ffe0a0';
        ctx.beginPath(); ctx.arc(x, y, r, 0, TAU); ctx.fill();
      }
      ctx.restore();
    }
    paperLantern(ctx, x, y, r, sway, c1, c2, t) {
      ctx.save();
      ctx.translate(x, y); ctx.rotate(sway);
      ctx.globalCompositeOperation = 'lighter'; ctx.globalAlpha = 0.5 + 0.1 * Math.sin(t * 2.3);
      ctx.drawImage(halo(H_HOT), -r * 3, r * 0.6 - r * 3, r * 6, r * 6);
      ctx.globalCompositeOperation = 'source-over'; ctx.globalAlpha = 1;
      ctx.strokeStyle = 'rgba(255,200,140,0.35)'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(0, r * 0.35); ctx.stroke();
      const g = ctx.createRadialGradient(-r * 0.2, r * 0.7, r * 0.1, 0, r * 0.95, r * 1.1);
      g.addColorStop(0, c2); g.addColorStop(0.6, c1); g.addColorStop(1, '#6a1830');
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.ellipse(0, r * 0.95, r * 0.82, r * 0.98, 0, 0, TAU); ctx.fill();
      ctx.strokeStyle = 'rgba(80,20,30,0.35)'; ctx.lineWidth = Math.max(1, r * 0.06);
      for (const k of [-0.5, 0, 0.5]) { ctx.beginPath(); ctx.ellipse(0, r * 0.95, r * 0.82 * Math.abs(k) + 0.01, r * 0.98, 0, 0, TAU); ctx.stroke(); }
      ctx.fillStyle = '#3a2410';
      ctx.fillRect(-r * 0.3, r * 0.2, r * 0.6, r * 0.2);
      ctx.fillRect(-r * 0.3, r * 1.85, r * 0.6, r * 0.18);
      ctx.strokeStyle = c2; ctx.lineWidth = Math.max(1, r * 0.08);
      ctx.beginPath(); ctx.moveTo(0, r * 2.0); ctx.lineTo(0, r * 2.45); ctx.stroke();
      ctx.restore();
    }

    drawDoor(ctx, t) {
      ctx.save();
      ctx.lineCap = 'round';
      ctx.strokeStyle = 'rgba(255,140,175,0.25)'; ctx.lineWidth = 0.34;
      ctx.beginPath(); ctx.moveTo(13.15, 12.5); ctx.lineTo(14.85, 12.5); ctx.stroke();
      ctx.strokeStyle = '#ff94b4'; ctx.lineWidth = 0.1;
      ctx.beginPath(); ctx.moveTo(13.15, 12.5); ctx.lineTo(14.85, 12.5); ctx.stroke();
      ctx.restore();
    }

    drawPellets(ctx, t, rv, alpha) {
      const hw = halo(H_WARM), hh = halo(H_HOT);
      ctx.save();
      ctx.globalAlpha = alpha;
      for (let k = 0; k < PEL_LIST.length; k++) {
        const i = PEL_LIST[k], v = this.pel[i];
        if (!v) continue;
        const c = colOf(i), r = rowOf(i), x = c + 0.5, y = r + 0.5;
        if (r > rv * ROWS) continue;
        if (v === 1) {
          const tw = 0.75 + 0.25 * Math.sin(t * 2.6 + c * 0.9 + r * 1.3);
          ctx.globalAlpha = alpha * 0.55 * tw;
          ctx.drawImage(hw, x - 0.34, y - 0.34, 0.68, 0.68);
          ctx.globalAlpha = alpha;
          ctx.fillStyle = '#ffe3a8';
          ctx.beginPath(); ctx.ellipse(x, y, 0.075, 0.095, 0, 0, TAU); ctx.fill();
        } else {
          const pulse = 0.5 + 0.5 * Math.sin(t * 4.2 + c);
          ctx.globalAlpha = alpha * (0.55 + 0.3 * pulse);
          ctx.globalCompositeOperation = 'lighter';
          ctx.drawImage(hh, x - 0.95, y - 0.95, 1.9, 1.9);
          ctx.globalCompositeOperation = 'source-over';
          ctx.globalAlpha = alpha;
          this.drawBigLantern(ctx, x, y, t, c, pulse);
        }
      }
      ctx.restore();
    }
    drawBigLantern(ctx, x, y, t, seed, pulse) {
      ctx.save();
      ctx.translate(x, y + 0.04); ctx.rotate(Math.sin(t * 1.6 + seed) * 0.08);
      const s = 1 + pulse * 0.07;
      ctx.scale(s, s);
      const g = ctx.createRadialGradient(-0.07, -0.05, 0.02, 0, 0, 0.32);
      g.addColorStop(0, '#ffe08a'); g.addColorStop(0.55, '#ff7a3a'); g.addColorStop(1, '#b92a2a');
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.ellipse(0, 0, 0.27, 0.23, 0, 0, TAU); ctx.fill();
      ctx.strokeStyle = 'rgba(120,20,20,0.5)'; ctx.lineWidth = 0.025;
      for (const k of [0.08, 0.17]) { ctx.beginPath(); ctx.ellipse(0, 0, k, 0.23, 0, 0, TAU); ctx.stroke(); }
      ctx.fillStyle = '#4a2c10';
      ctx.fillRect(-0.1, -0.29, 0.2, 0.08); ctx.fillRect(-0.1, 0.21, 0.2, 0.07);
      ctx.strokeStyle = '#ffd27a'; ctx.lineWidth = 0.03;
      ctx.beginPath(); ctx.moveTo(0, 0.28); ctx.lineTo(0, 0.38); ctx.stroke();
      ctx.restore();
    }
    drawRings(ctx) {
      for (const r of this.rings) {
        const u = r.t / 0.9;
        ctx.save(); ctx.globalAlpha = (1 - u) * 0.7; ctx.strokeStyle = '#ffd89a'; ctx.lineWidth = 0.12 * (1 - u) + 0.02;
        ctx.beginPath(); ctx.arc(r.x, r.y, 0.4 + ease.outCubic(u) * 7, 0, TAU); ctx.stroke(); ctx.restore();
      }
    }

    drawPlayer(ctx, t) {
      const pl = this.pl;
      let x, y, scale = 1, mouth = this.mouth, ang = this.plAng;
      const p = visPos(pl, {}); x = p.x; y = p.y;
      { const a = IP.alpha(); if (a < 1 && pl._vx !== undefined && Math.abs(x - pl._vx) < 2.5 && Math.abs(y - pl._vy) < 2.5) { x = pl._vx + (x - pl._vx) * a; y = pl._vy + (y - pl._vy) * a; } }
      if (this.phase === 'clear' && this.over && this.won) { y -= Math.abs(Math.sin(this.flashT * 7)) * 0.5; }
      if (this.phase === 'celebrate') { y -= Math.abs(Math.sin(this.celebT * 6)) * 0.55; mouth = 0.1 + 0.55 * Math.abs(Math.sin(this.celebT * 6)); }
      let alpha = 1;
      if (this.phase === 'dying') {
        const u = Math.min(1, this.dyingT / 1.25);
        if (this.dyingT > 1.25) return;
        ang = -Math.PI / 2; mouth = 0.3 + (Math.PI - 0.3) * ease.inOutCubic(u);
        scale = 1 - 0.1 * u;
      }
      if (this.phase === 'lost') return;
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = 0.45; ctx.drawImage(halo(H_GOLD), x - 1.1, y - 1.1, 2.2, 2.2);
      ctx.restore();
      ctx.save();
      ctx.translate(x, y); ctx.scale(scale, scale);
      const r = 0.48;
      // soft drop shadow
      ctx.fillStyle = 'rgba(0,0,0,0.25)'; ctx.beginPath(); ctx.ellipse(0.04, 0.1, r, r * 0.95, 0, 0, TAU); ctx.fill();
      ctx.save();
      ctx.rotate(ang);
      const g = ctx.createRadialGradient(-r * 0.3, -r * 0.35, r * 0.1, 0, 0, r * 1.05);
      g.addColorStop(0, '#fff0b0'); g.addColorStop(0.45, '#ffc93c'); g.addColorStop(1, '#d9861a');
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.moveTo(0, 0); ctx.arc(0, 0, r, mouth, TAU - mouth); ctx.closePath(); ctx.fill();
      // pleats on the back
      ctx.strokeStyle = 'rgba(150,80,10,0.55)'; ctx.lineWidth = 0.032; ctx.lineCap = 'round';
      for (const a of [-0.55, 0, 0.55]) {
        const aa = Math.PI + a;
        ctx.beginPath();
        ctx.moveTo(Math.cos(aa) * r * 0.5, Math.sin(aa) * r * 0.5);
        ctx.quadraticCurveTo(Math.cos(aa + 0.2) * r * 0.75, Math.sin(aa + 0.2) * r * 0.75, Math.cos(aa) * r * 0.93, Math.sin(aa) * r * 0.93);
        ctx.stroke();
      }
      ctx.restore();
      // rim light + eye (screen space so it never goes upside-down)
      ctx.strokeStyle = 'rgba(255,245,200,0.5)'; ctx.lineWidth = 0.03;
      ctx.beginPath(); ctx.arc(0, 0, r * 0.93, Math.PI * 1.1, Math.PI * 1.55); ctx.stroke();
      if (this.phase !== 'dying') {
        const fx = Math.cos(ang) * 0.12, fy = Math.sin(ang) * 0.05;
        ctx.fillStyle = '#3a2008';
        ctx.beginPath(); ctx.ellipse(fx + 0.02, -0.25 + fy, 0.055, 0.07, 0, 0, TAU); ctx.fill();
        ctx.fillStyle = 'rgba(255,255,255,0.85)';
        ctx.beginPath(); ctx.arc(fx + 0.04, -0.27 + fy, 0.02, 0, TAU); ctx.fill();
      }
      ctx.restore();
    }

    drawGhost(ctx, g, t) {
      if (this.phase === 'lost') return;
      const fade = (this.phase === 'dying' || this.phase === 'clear') ? this.ghostFade : 1;
      if (fade <= 0.01) return;
      let x = g.x, y = g.y;
      if (g.mode === 'house') y = 14.5 + Math.sin(g.bob) * 0.17;
      if (this.phase === 'ready') { x = g.def.slot; if (g.k > 0) y = 14.5 + Math.sin(g.bob) * 0.17; }
      const r = 0.47;
      const flick = g.fr && this.fright < 2 && (Math.floor(t / 0.17) & 1) === 1;
      ctx.save();
      ctx.globalAlpha = fade;
      if (g.mode === 'eyes' || g.mode === 'entering') {
        this.drawEyes(ctx, x, y, g, r, '#fff');
        ctx.restore(); return;
      }
      // halo
      ctx.save(); ctx.globalCompositeOperation = 'lighter'; ctx.globalAlpha = fade * (g.fr ? 0.25 : 0.32);
      ctx.drawImage(halo(g.fr ? 'rgba(110,120,255,1)' : hexToRgba(g.def.color)), x - 1.1, y - 1.1, 2.2, 2.2); ctx.restore();
      const fl = Math.hypot(g.lx, g.ly) || 1;
      const fx = g.lx / Math.max(1, fl), fy = g.ly / Math.max(1, fl);
      // fluttering kite tail (trails opposite to the heading)
      const ax = x - fx * 0.3, ay = y + 0.3 - fy * 0.1;
      const tailCol = g.fr ? (flick ? '#f1eeff' : '#6a72e8') : g.def.light;
      ctx.strokeStyle = tailCol; ctx.lineWidth = 0.05; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      ctx.beginPath();
      const pts = [];
      for (let i = 0; i <= 6; i++) {
        const u = i / 6, back = u * 0.85;
        const wob = Math.sin(g.phase * 1.1 - u * 5) * 0.13 * u;
        const px = ax - fx * back - fy * wob * 0 + (-fy) * wob, py = ay - fy * back + 0.05 * u + fx * wob + Math.abs(fx) * 0 ;
        pts.push([px, py]); i ? ctx.lineTo(px, py) : ctx.moveTo(px, py);
      }
      ctx.stroke();
      ctx.fillStyle = tailCol;
      for (const i of [2, 4, 6]) {
        const [px, py] = pts[i], s = 0.07 + 0.012 * (i === 6);
        ctx.beginPath(); ctx.moveTo(px, py - s); ctx.lineTo(px + s * 0.8, py); ctx.lineTo(px, py + s); ctx.lineTo(px - s * 0.8, py); ctx.closePath(); ctx.fill();
      }
      // body
      const gr = ctx.createLinearGradient(0, y - r, 0, y + r);
      if (g.fr) { gr.addColorStop(0, flick ? '#ffffff' : '#4a53d6'); gr.addColorStop(1, flick ? '#d6d2f5' : '#252d96'); }
      else { gr.addColorStop(0, g.def.light); gr.addColorStop(0.35, g.def.color); gr.addColorStop(1, g.def.dark); }
      ctx.fillStyle = gr;
      ctx.beginPath();
      ctx.moveTo(x - r, y + r * 0.9);
      ctx.lineTo(x - r, y);
      ctx.arc(x, y, r, Math.PI, TAU);
      ctx.lineTo(x + r, y + r * 0.9);
      const n = 16;
      for (let i = 1; i <= n; i++) {
        const u = i / n;
        ctx.lineTo(x + r - 2 * r * u, y + r * 0.9 + Math.sin(g.phase + u * 3 * TAU) * 0.06 * Math.sin(Math.PI * u) + 0.02);
      }
      ctx.closePath(); ctx.fill();
      // kite spar diamond
      ctx.strokeStyle = g.fr ? 'rgba(255,255,255,0.22)' : 'rgba(255,255,255,0.28)'; ctx.lineWidth = 0.025;
      ctx.beginPath(); ctx.moveTo(x, y + 0.02); ctx.lineTo(x + 0.19, y + 0.24); ctx.lineTo(x, y + 0.44); ctx.lineTo(x - 0.19, y + 0.24); ctx.closePath(); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(x, y + 0.02); ctx.lineTo(x, y + 0.44); ctx.moveTo(x - 0.19, y + 0.24); ctx.lineTo(x + 0.19, y + 0.24); ctx.stroke();
      if (g.fr) {
        const ink = flick ? '#d6322f' : '#f6f0ff';
        ctx.fillStyle = ink;
        ctx.beginPath(); ctx.arc(x - 0.16, y - 0.07, 0.055, 0, TAU); ctx.arc(x + 0.16, y - 0.07, 0.055, 0, TAU); ctx.fill();
        ctx.strokeStyle = ink; ctx.lineWidth = 0.04;
        ctx.beginPath();
        for (let i = 0; i <= 6; i++) { const px = x - 0.27 + i * 0.09, py = y + 0.17 + (i & 1 ? -0.045 : 0.045); i ? ctx.lineTo(px, py) : ctx.moveTo(px, py); }
        ctx.stroke();
      } else this.drawEyes(ctx, x, y, g, r, '#fff');
      ctx.restore();
    }
    drawEyes(ctx, x, y, g, r, col) {
      const fl = Math.hypot(g.lx, g.ly);
      const lx = fl > 1 ? g.lx / fl : g.lx, ly = fl > 1 ? g.ly / fl : g.ly;
      for (const s of [-1, 1]) {
        const ex = x + s * 0.17 + lx * 0.04, ey = y - 0.07 + ly * 0.03;
        ctx.fillStyle = col;
        ctx.beginPath(); ctx.ellipse(ex, ey, 0.115, 0.14, 0, 0, TAU); ctx.fill();
        ctx.fillStyle = '#1b2a6b';
        ctx.beginPath(); ctx.arc(ex + lx * 0.055, ey + ly * 0.065, 0.062, 0, TAU); ctx.fill();
      }
    }

    drawText(ctx, W, H) {
      const T = this.T, ox = this.ox, oy = this.oy;
      ctx.save();
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      if (this.phase === 'ready') {
        const a = Math.min(1, this.phaseT * 3, (this.reveal - 0.3) * 3);
        ctx.globalAlpha = Math.max(0, a);
        ctx.font = `600 ${T * 0.95}px Fredoka, "Trebuchet MS", sans-serif`;
        ctx.fillStyle = '#ffd27a'; ctx.shadowColor = 'rgba(255,170,60,0.8)'; ctx.shadowBlur = T * 0.5;
        ctx.fillText('READY!', ox + 14 * T, oy + 17.55 * T);
        ctx.shadowBlur = 0;
      }
      for (const p of this.popups) {
        const u = p.t / 1.1;
        ctx.globalAlpha = Math.min(1, (1 - u) * 2);
        ctx.font = `600 ${T * 0.7 * (1 + 0.25 * (1 - ease.outCubic(Math.min(1, u * 4))))}px Fredoka, sans-serif`;
        ctx.fillStyle = '#7ff3ff'; ctx.strokeStyle = 'rgba(10,6,20,0.8)'; ctx.lineWidth = T * 0.12;
        const x = ox + p.x * T, y = oy + (p.y - u * 1.1) * T;
        ctx.strokeText(p.text, x, y); ctx.fillText(p.text, x, y);
      }
      ctx.restore();
    }
    drawStrip(ctx, W, H) {
      const T = this.T, ox = this.ox, oy = this.oy;
      const y = oy - T * 0.95;
      ctx.save();
      // lives (little dumplings) at left of the strip
      for (let i = 0; i < this.lives - (this.phase === 'play' || this.phase === 'freeze' ? 1 : 0); i++) {
        const x = ox + T * (1.1 + i * 1.15);
        ctx.save(); ctx.translate(x, y);
        const g = ctx.createRadialGradient(-T * 0.12, -T * 0.14, T * 0.05, 0, 0, T * 0.45);
        g.addColorStop(0, '#fff0b0'); g.addColorStop(0.5, '#ffc93c'); g.addColorStop(1, '#d9861a');
        ctx.fillStyle = g; ctx.beginPath(); ctx.moveTo(0, 0); ctx.arc(0, 0, T * 0.4, 0.5, TAU - 0.5); ctx.closePath(); ctx.fill();
        ctx.restore();
      }
      ctx.textBaseline = 'middle';
      ctx.font = `600 ${T * 0.62}px Fredoka, "Trebuchet MS", sans-serif`;
      ctx.textAlign = 'right'; ctx.fillStyle = 'rgba(255,215,150,0.75)';
      ctx.fillText(`NIGHT ${this.level} / 2`, ox + COLS * T - T * 0.3, y);
      ctx.restore();
    }
  }

  function hexToRgba(h) {
    const n = parseInt(h.slice(1), 16);
    return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},1)`;
  }

  Arcade.register({
    id: 'chase',
    name: 'Night Market',
    genre: 'Maze chase',
    aiNote: "Sees the lanterns and every chaser on screen but not their timers or next turns, and steers with at most one direction input every 0.1 s.",
    blurb: 'A dumpling gobbles lanterns while four paper kites hunt it through the night market.',
    bg: '#140f24',
    accent: '#ffb347',
    create(opts = {}) { return new Chase(opts); },
  });
})();
