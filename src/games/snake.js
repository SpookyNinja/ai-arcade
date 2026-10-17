// snake.js - Serpent Garden: a moss-and-jade garden at night. One continuous tube snake,
// glowing amber berries, ambient fireflies. The AI plays through a separate SnakeAI object.
(() => {
  'use strict';
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


  const COLS = 20, ROWS = 12, N = COLS * ROWS;
  const WIN_LEN = 140; // tuned up from 110: with stones the AI otherwise never loses
  const TIME_CAP = 240; // seconds: dawn breaks and the night hunt ends (also the safety cap)
  const START_LEN = 3;
  const BERRY_LIFE = 9; // seconds before an uneaten berry shrivels
  const STONE_EVERY = 2, STONE_MAX = 30;
  const DX = [1, 0, -1, 0], DY = [0, 1, 0, -1]; // 0 = east, 1 = south, 2 = west, 3 = north

  // ------------------------------------------------------------------ AI
  // SnakeAI sees exactly what a human sees: the whole board - the snake's cells in order,
  // the berry cell - and its heading. It returns one direction per move tick (so at most one
  // direction change per tick, exactly like a keyboard player). No hidden state is read.
  // Tactic styles: weights added to a route's length when ranking first moves (all stay safe-checked).
  const STYLES = [
    { name: 'Direct', straight: 0, horiz: 0, hug: 0 },
    { name: 'Wall hugger', straight: 0.1, horiz: 0, hug: 0.45 },
    { name: 'Zigzag sweeper', straight: 0.5, horiz: 0.2, hug: 0 },
  ];
  const SnakeAI = (() => {
    const dist = new Int16Array(N), prev = new Int16Array(N), queue = new Int16Array(N);
    const occ = new Int16Array(N); // 0 = free, else "free after this many moves"
    const mark = new Uint8Array(N);
    let stone = new Uint8Array(N); // mossy stones the player sees lying on the board

    const nbr = (c, d) => {
      const x = c % COLS, y = (c / COLS) | 0, nx = x + DX[d], ny = y + DY[d];
      return nx < 0 || ny < 0 || nx >= COLS || ny >= ROWS ? -1 : ny * COLS + nx;
    };

    // shortest path honoring when body cells vacate. Returns array of cells (head excluded) or null.
    function pathTo(body, target, v = 0) {
      const o0 = v & 3, os = v & 4 ? 3 : 1;
      const n = body.length;
      occ.fill(0);
      for (let i = 0; i < n; i++) occ[body[i]] = n - i;
      for (let c = 0; c < N; c++) if (stone[c]) occ[c] = 32000;
      dist.fill(-1);
      let qh = 0, qt = 0;
      const h = body[0];
      dist[h] = 0; queue[qt++] = h;
      while (qh < qt) {
        const c = queue[qh++];
        if (c === target) break;
        const d1 = dist[c] + 1;
        for (let k = 0; k < 4; k++) {
          const m = nbr(c, (o0 + k * os) & 3);
          if (m < 0 || dist[m] >= 0 || occ[m] > d1) continue;
          dist[m] = d1; prev[m] = c; queue[qt++] = m;
        }
      }
      if (dist[target] < 0) return null;
      const p = [];
      for (let c = target; c !== h; c = prev[c]) p.push(c);
      return p.reverse();
    }

    // Is `goal` (a cell that will be passable) reachable from body[0] when `blocked` cells (the
    // body, except the tail goal) are walls? Returns BFS distance or -1.
    function reach(body, goal) {
      mark.fill(0);
      for (let i = 0; i < body.length; i++) mark[body[i]] = 1;
      for (let c = 0; c < N; c++) if (stone[c]) mark[c] = 1;
      mark[goal] = 0;
      dist.fill(-1);
      let qh = 0, qt = 0;
      const h = body[0];
      dist[h] = 0; queue[qt++] = h;
      while (qh < qt) {
        const c = queue[qh++];
        for (let d = 0; d < 4; d++) {
          const m = nbr(c, d);
          if (m < 0 || dist[m] >= 0 || mark[m]) continue;
          dist[m] = dist[c] + 1;
          if (m === goal) return dist[m];
          queue[qt++] = m;
        }
      }
      return h === goal ? 0 : -1;
    }

    // Is the tail reachable? Super AI: time-aware (cells the body vacates in time count as free),
    // normal AI: classic static check (every body cell is a wall).
    let timeAware = false;
    function tailReach(vb, tail) {
      if (!timeAware) return reach(vb, tail);
      const p = pathTo(vb, tail);
      return p ? p.length : -1;
    }

    function flood(body) {
      mark.fill(0);
      for (let i = 0; i < body.length - 1; i++) mark[body[i]] = 1; // tail cell will vacate
      for (let c = 0; c < N; c++) if (stone[c]) mark[c] = 1;
      let qh = 0, qt = 0, n = 0;
      queue[qt++] = body[0]; mark[body[0]] = 1;
      while (qh < qt) {
        const c = queue[qh++]; n++;
        for (let d = 0; d < 4; d++) {
          const m = nbr(c, d);
          if (m < 0 || mark[m]) continue;
          mark[m] = 1; queue[qt++] = m;
        }
      }
      return n;
    }


    // Super AI: can the snake reach the berry from `body` along some route that keeps its tail reachable?
    function canEat(body, food) {
      const n = body.length, head = body[0];
      for (let d = 0; d < 4; d++) {
        const c = nbr(head, d);
        if (c < 0 || stone[c]) continue;
        const eats = c === food;
        let ok = true;
        for (let i = 0; i < n - (eats ? 0 : 1); i++) if (body[i] === c) { ok = false; break; }
        if (!ok) continue;
        if (eats) { const vb = [c].concat(body); if (tailReach(vb, vb[vb.length - 1]) >= 0) return true; continue; }
        const nb = [c].concat(body.slice(0, n - 1));
        for (let vr = 0; vr < 4; vr++) {
          const p = pathTo(nb, food, vr);
          if (!p) break;
          const vb = p.slice().reverse().concat(nb).slice(0, n + 1);
          if (tailReach(vb, vb[vb.length - 1]) >= 0) return true;
        }
      }
      return false;
    }
    let budget = 0;
    function lookahead(body, food, depth) {
      if (budget-- <= 0) return false;
      if (canEat(body, food)) return true;
      if (depth <= 0) return false;
      const n = body.length, head = body[0];
      for (let d = 0; d < 4; d++) {
        const c = nbr(head, d);
        if (c < 0 || stone[c] || c === food) continue;
        let ok = true;
        for (let i = 0; i < n - 1; i++) if (body[i] === c) { ok = false; break; }
        if (!ok) continue;
        const vb = [c].concat(body.slice(0, n - 1));
        if (tailReach(vb, vb[vb.length - 1]) < 0) continue;
        if (lookahead(vb, food, depth - 1)) return true;
      }
      return false;
    }

    function dirOf(a, b) {
      for (let d = 0; d < 4; d++) if (nbr(a, d) === b) return d;
      return 0;
    }

    return {
      decide(view) {
        const body = view.body, food = view.food, n = body.length, head = body[0];
        stone = view.stone;
        // (1) routes to the berry: score each first move by (route length + style preference), accept only
        // routes that keep the tail reachable afterwards. Equal scores break randomly.
        const st = view.style || STYLES[0];
        timeAware = !!st.aware;
        let stoneN = 0; if (st.enc) for (let c = 0; c < N; c++) stoneN += stone[c];
        let bestD = -1, bestV = 1e9;
        for (let d = 0; d < 4; d++) {
          const c = nbr(head, d);
          if (c < 0 || stone[c]) continue;
          const eats = c === food;
          let ok = true;
          for (let i = 0; i < n - (eats ? 0 : 1); i++) if (body[i] === c) { ok = false; break; }
          if (!ok) continue;
          let len, vb;
          if (eats) { len = 1; vb = [c].concat(body); }
          else {
            const nb = [c].concat(body.slice(0, n - 1));
            let okp = false;
            for (let vr = 0; vr < (st.multi ? 8 : 1) && !okp; vr++) {
              const p = pathTo(nb, food, vr);
              if (!p) break;
              len = 1 + p.length;
              vb = p.slice().reverse().concat(nb).slice(0, n + 1);
              if (tailReach(vb, vb[vb.length - 1]) >= 0) okp = true;
            }
            if (!okp) continue;
          }
          if (eats && tailReach(vb, vb[vb.length - 1]) < 0) continue;
          let blocked = 0;
          for (let k = 0; k < 4; k++) { const m = nbr(c, k); if (m < 0 || stone[m] || (m !== body[n - 1] && body.indexOf(m) >= 0)) blocked++; }
          let v = len;
          if (d === view.dir) v -= st.straight;
          if (d % 2 === 0) v -= st.horiz;
          v -= st.hug * blocked;
          if (st.enc) v += st.enc * (N - stoneN - vb.length - (flood(vb) - 1));
          v += Math.random() * 0.01;
          if (v < bestV) { bestV = v; bestD = d; }
        }
        if (bestD >= 0) return bestD;
        if (st.multi) { // Super AI: simulate "keep chasing the tail" for each safe stalling move; take the one that soonest opens a safe route to the berry
          const K = 36;
          let bd = -1, bsteps = 1e9;
          for (let d = 0; d < 4; d++) {
            const c0 = nbr(head, d);
            if (c0 < 0 || stone[c0] || c0 === food) continue;
            let ok = true;
            for (let i = 0; i < n - 1; i++) if (body[i] === c0) { ok = false; break; }
            if (!ok) continue;
            let vb = [c0].concat(body.slice(0, n - 1));
            if (tailReach(vb, vb[vb.length - 1]) < 0) continue;
            let steps = 1;
            for (; steps < Math.min(K, bsteps); steps++) {
              if (canEat(vb, food)) break;
              // next stalling move: the neighbour from which the tail is nearest
              const h = vb[0]; let nc = -1, nl = 1e9;
              for (let k = 0; k < 4; k++) {
                const m = nbr(h, k);
                if (m < 0 || stone[m] || m === food) continue;
                let free = true;
                for (let i = 0; i < n - 1; i++) if (vb[i] === m) { free = false; break; }
                if (!free) continue;
                const w = [m].concat(vb.slice(0, n - 1));
                const l = tailReach(w, w[w.length - 1]);
                if (l >= 0 && l < nl) { nl = l; nc = m; }
              }
              if (nc < 0) { steps = 1e9; break; }
              vb = [nc].concat(vb.slice(0, n - 1));
            }
            if (steps < bsteps && steps < K) { bsteps = steps; bd = d; }
          }
          if (bd >= 0) return bd;
        }
        // (2) chase the tail: stall safely by taking the move that keeps the tail farthest.
        let best = -1, bestScore = -1, bestFlood = -1, floodDir = -1;
        for (let d = 0; d < 4; d++) {
          const c = nbr(head, d);
          if (c < 0 || stone[c]) continue;
          const eats = c === food;
          let ok = true;
          for (let i = 0; i < n - (eats ? 0 : 1); i++) if (body[i] === c) { ok = false; break; }
          if (!ok) continue;
          const vb = [c].concat(eats ? body : body.slice(0, n - 1));
          const tail = vb[vb.length - 1];
          const dt = vb.length > 1 ? reach(vb, tail) : 0;
          if (dt >= 0 && (dt > bestScore || (dt === bestScore && Math.random() < 0.5))) { bestScore = dt; best = d; }
          const fl = flood(vb);
          if (fl > bestFlood || (fl === bestFlood && Math.random() < 0.5)) { bestFlood = fl; floodDir = d; }
        }
        if (best >= 0) return best;
        // (3) no tail access: go where there is most room.
        if (floodDir >= 0) return floodDir;
        return view.dir;
      },
    };
  })();

  // ------------------------------------------------------------------ helpers
  const TAUV = Math.PI * 2;
  const mkSprite = (size, stops) => {
    const c = document.createElement('canvas'); c.width = c.height = size;
    const g = c.getContext('2d');
    const r = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    for (const [o, col] of stops) r.addColorStop(o, col);
    g.fillStyle = r; g.fillRect(0, 0, size, size);
    return c;
  };
  let amberGlow = null, mistSprite = null, flySprite = null;
  const sprites = () => {
    if (amberGlow) return;
    amberGlow = mkSprite(128, [[0, 'rgba(255,190,70,0.95)'], [0.35, 'rgba(255,150,40,0.38)'], [1, 'rgba(255,120,20,0)']]);
    mistSprite = mkSprite(256, [[0, 'rgba(120,220,190,0.16)'], [1, 'rgba(120,220,190,0)']]);
    flySprite = mkSprite(64, [[0, 'rgba(230,255,170,1)'], [0.25, 'rgba(190,255,140,0.45)'], [1, 'rgba(170,255,120,0)']]);
  };
  const BODY_COLORS = [];
  for (let i = 0; i < 64; i++) {
    const f = i / 63;
    BODY_COLORS.push({
      fill: `hsl(${(152 + 28 * f).toFixed(1)},${(72 - 18 * f).toFixed(1)}%,${(56 - 32 * f).toFixed(1)}%)`,
      rim: `hsl(${(158 + 26 * f).toFixed(1)},${(62 - 12 * f).toFixed(1)}%,${(26 - 12 * f).toFixed(1)}%)`,
    });
  }
  const angDiff = (a, b) => { let d = (b - a) % TAUV; if (d > Math.PI) d -= TAUV; if (d < -Math.PI) d += TAUV; return d; };

  // ------------------------------------------------------------------ game
  Arcade.register({
    id: 'snake', name: 'Serpent Garden', genre: 'Snake',
    aiNote: "Sees the whole board but, like a keyboard player, turns at most once per move tick and plans routes that always keep its tail reachable.",
    blurb: 'A jade serpent threads a moonlit garden, hunting amber berries.',
    bg: '#0b1f1c', accent: '#4ee0a0',
    create(opts = {}) {
      sprites();
      const g = {
        over: false, won: false,
        W: 800, H: 600, cell: 40, bx: 0, by: 0, dpr: 1,
        t: 0, acc: 0, interval: 0.1, moves: 0, berries: 0,
        body: [], prevTail: -1, prevHead: 0, dir: 0, headAng: 0,
        food: -1, foodT: 0, stone: new Uint8Array(N), stones: [],
        parts: new Particles(), ripples: [], floaters: [], bulges: [],
        death: null, endT: 0, bg: null,
        styleDef: opts.superAI ? { name: 'Super AI', straight: 0, horiz: 0, hug: 0, enc: 3, multi: 1 } : STYLES[(Math.random() * STYLES.length) | 0],
        flies: [], blobs: [],
      };
      const startY = ROWS >> 1;
      for (let i = 0; i < START_LEN; i++) g.body.push(startY * COLS + 4 - i);
      g.prevHead = g.body[1];
      for (let i = 0; i < 28; i++) g.flies.push({ x: Math.random(), y: Math.random(), ph: Math.random() * 20, sp: 0.15 + Math.random() * 0.35, r: 0.6 + Math.random() * 0.8 });
      for (let i = 0; i < 4; i++) g.blobs.push({ x: Math.random(), y: Math.random(), sp: 0.01 + Math.random() * 0.015, ph: Math.random() * 10, r: 0.35 + Math.random() * 0.3 });

      const spawnFood = () => {
        const occ = new Uint8Array(N);
        for (const c of g.body) occ[c] = 1;
        for (let c = 0; c < N; c++) if (g.stone[c]) occ[c] = 1;
        const free = [];
        for (let c = 0; c < N; c++) if (!occ[c]) free.push(c);
        g.food = free.length ? free[(Math.random() * free.length) | 0] : -1;
        g.foodT = 0;
      };
      g.style = g.styleDef.name;
      if (opts.superAI) g.superAI = true;
      spawnFood();

      const speedFor = len => 10 + 18 * Math.pow(clamp((len - START_LEN) / 100, 0, 1), 0.9);
      g.speed = () => speedFor(g.body.length);
      const cc = c => [(c % COLS) + 0.5, ((c / COLS) | 0) + 0.5]; // cell center in board units

      // Rising difficulty: every few berries a mossy stone drops somewhere on the lawn. It never
      // lands near the head, never walls off part of the lawn, and is visible to the AI like to a human.
      function dropStone() {
        const occ = new Uint8Array(N);
        for (const c of g.body) occ[c] = 1;
        const hx = g.body[0] % COLS, hy = (g.body[0] / COLS) | 0;
        const cand = [];
        for (let c = 0; c < N; c++) {
          if (occ[c] || g.stone[c] || c === g.food) continue;
          if (Math.max(Math.abs((c % COLS) - hx), Math.abs(((c / COLS) | 0) - hy)) < 3) continue;
          cand.push(c);
        }
        rnd.shuffle(cand);
        for (const c of cand.slice(0, 30)) {
          g.stone[c] = 1;
          // connectivity of the stone-free lawn
          const seen = new Uint8Array(N); const q = [g.body[0]]; seen[g.body[0]] = 1; let cnt = 0;
          while (q.length) {
            const a = q.pop(); cnt++;
            for (let d = 0; d < 4; d++) {
              const x = (a % COLS) + DX[d], y = ((a / COLS) | 0) + DY[d];
              if (x < 0 || y < 0 || x >= COLS || y >= ROWS) continue;
              const m = y * COLS + x;
              if (seen[m] || g.stone[m]) continue;
              seen[m] = 1; q.push(m);
            }
          }
          let stones = 0; for (let k = 0; k < N; k++) stones += g.stone[k];
          if (cnt === N - stones) {
            g.stones.push({ c, t: 0, rot: Math.random() * 6, sx: 0.85 + Math.random() * 0.25 });
            const [px, py] = cc(c);
            g.parts.burst(px, py, 10, { speed: 2.2, speedMin: 0.5, life: 0.7, size: 0.09, color: ['#8fb7a6', '#c9e6d8', '#5e8b78'], drag: 3 });
            return;
          }
          g.stone[c] = 0;
        }
      }

      function die(reason) {
        g.over = true; g.won = false; g.death = { reason, t: 0, front: 0, started: false };
        g.parts.burst(...cc(g.body[0]), 14, { speed: 4, speedMin: 1, life: 0.7, size: 0.1, color: ['#ffffff', '#b8ffe0'], drag: 2.5 });
      }

      function tick() {
        const view = { style: g.styleDef, cols: COLS, rows: ROWS, body: g.body.slice(), dir: g.dir, food: g.food, stone: g.stone };
        const nd = SnakeAI.decide(view);
        if (((nd + 2) & 3) !== g.dir) g.dir = nd; // reversing is impossible for a keyboard player
        const head = g.body[0], hx = head % COLS, hy = (head / COLS) | 0;
        const nx = hx + DX[g.dir], ny = hy + DY[g.dir];
        if (nx < 0 || ny < 0 || nx >= COLS || ny >= ROWS) return die('wall');
        const nc = ny * COLS + nx;
        const grow = nc === g.food;
        const lim = g.body.length - (grow ? 0 : 1);
        if (g.stone[nc]) return die('stone');
        for (let i = 0; i < lim; i++) if (g.body[i] === nc) return die('self');
        g.prevHead = head;
        g.body.unshift(nc);
        g.moves++;
        for (const b of g.bulges) b.tick++;
        if (grow) {
          g.prevTail = -1;
          g.berries++;
          const [fx, fy] = cc(nc);
          g.parts.burst(fx, fy, 22, { speed: 4.2, speedMin: 0.8, life: 0.9, size: 0.12, color: ['#ffd27a', '#ffb347', '#fff1c4', '#ff9d3c'], drag: 3 });
          g.ripples.push({ x: fx, y: fy, t: 0 });
          g.floaters.push({ x: fx, y: fy, t: 0, txt: '+1' });
          g.bulges.push({ tick: 0 });
          if (g.body.length >= WIN_LEN) { g.over = true; g.won = true; g.endT = 0; g.food = -1; return; }
          if (g.berries % STONE_EVERY === 0 && g.stones.length < STONE_MAX) dropStone();
          spawnFood();
        } else g.prevTail = g.body.pop();
      }

      g.resize = function (W, H) {
        g.W = W; g.H = H;
        g.cell = Math.max(8, Math.min(W * 0.88 / COLS, H * 0.84 / ROWS));
        g.bx = (W - g.cell * COLS) / 2;
        g.by = H * 0.485 - g.cell * ROWS / 2;
        if (g.bx < 370) { // keep clear of the shell HUD box (bottom-left, ~360x100 px)
          const top = H * 0.03, bottom = H - 104;
          g.cell = Math.max(8, Math.min(W * 0.88 / COLS, (bottom - top) / (ROWS + 0.64)));
          g.bx = (W - g.cell * COLS) / 2;
          g.by = (top + bottom) / 2 - g.cell * ROWS / 2;
        }
        g.dpr = Math.min(2, window.devicePixelRatio || 1);
        buildBg();
      };

      function buildBg() {
        const { W, H, cell, bx, by } = g, dpr = g.dpr;
        const c = document.createElement('canvas');
        c.width = Math.ceil(W * dpr); c.height = Math.ceil(H * dpr);
        const x = c.getContext('2d');
        x.scale(dpr, dpr);
        const rg = x.createRadialGradient(W / 2, H * 0.45, 0, W / 2, H * 0.5, Math.hypot(W, H) * 0.6);
        rg.addColorStop(0, '#12332c'); rg.addColorStop(0.55, '#0b1f1c'); rg.addColorStop(1, '#06120f');
        x.fillStyle = rg; x.fillRect(0, 0, W, H);
        // leafy texture scattered around the garden
        let seed = 1234;
        const rand = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
        for (let i = 0; i < 260; i++) {
          const px = rand() * W, py = rand() * H, r = 6 + rand() * 22, a = rand() * Math.PI;
          x.save(); x.translate(px, py); x.rotate(a);
          x.fillStyle = `rgba(${40 + rand() * 30 | 0},${110 + rand() * 50 | 0},${90 + rand() * 40 | 0},${0.025 + rand() * 0.035})`;
          x.beginPath(); x.ellipse(0, 0, r, r * 0.38, 0, 0, TAUV); x.fill(); x.restore();
        }
        // board slab
        const bw = cell * COLS, bh = cell * ROWS, pad = cell * 0.32;
        x.save();
        x.shadowColor = 'rgba(0,0,0,0.55)'; x.shadowBlur = cell * 0.8; x.shadowOffsetY = cell * 0.2;
        roundRect(x, bx - pad, by - pad, bw + pad * 2, bh + pad * 2, cell * 0.5);
        x.fillStyle = '#0a1a17'; x.fill();
        x.restore();
        const fr = x.createLinearGradient(0, by - pad, 0, by + bh + pad);
        fr.addColorStop(0, '#2a5a4c'); fr.addColorStop(1, '#143a32');
        roundRect(x, bx - pad, by - pad, bw + pad * 2, bh + pad * 2, cell * 0.5);
        x.strokeStyle = fr; x.lineWidth = cell * 0.14; x.stroke();
        roundRect(x, bx - pad * 0.45, by - pad * 0.45, bw + pad * 0.9, bh + pad * 0.9, cell * 0.38);
        x.strokeStyle = 'rgba(0,0,0,0.35)'; x.lineWidth = 2; x.stroke();
        // checker (clip to rounded board)
        x.save();
        roundRect(x, bx, by, bw, bh, cell * 0.22); x.clip();
        for (let j = 0; j < ROWS; j++) for (let i = 0; i < COLS; i++) {
          x.fillStyle = (i + j) & 1 ? '#0f2d27' : '#12352e';
          x.fillRect(bx + i * cell, by + j * cell, cell + 0.5, cell + 0.5);
          // tiny grass specks
          const k = 1 + (rand() * 3 | 0);
          for (let s = 0; s < k; s++) {
            x.fillStyle = `rgba(150,230,190,${0.04 + rand() * 0.05})`;
            const sx = bx + (i + rand()) * cell, sy = by + (j + rand()) * cell;
            x.beginPath(); x.ellipse(sx, sy, cell * 0.035, cell * 0.075, rand() * 3, 0, TAUV); x.fill();
          }
        }
        const sheen = x.createLinearGradient(0, by, 0, by + bh);
        sheen.addColorStop(0, 'rgba(120,255,200,0.05)'); sheen.addColorStop(0.5, 'rgba(0,0,0,0)'); sheen.addColorStop(1, 'rgba(0,0,0,0.18)');
        x.fillStyle = sheen; x.fillRect(bx, by, bw, bh);
        x.restore();
        g.bg = c;
      }

      g.step = function (dt) {
        g.t += dt;
        g.parts.update(dt);
        g.foodT += dt;
        // an uneaten berry shrivels after a while and a fresh one grows elsewhere
        if (!g.over && g.food >= 0 && g.foodT > BERRY_LIFE) {
          const [px, py] = cc(g.food);
          g.parts.burst(px, py, 8, { speed: 1.5, speedMin: 0.3, life: 0.6, size: 0.07, color: ['#a8743a', '#6b4a2a'], drag: 3 });
          spawnFood();
        }
        for (const s of g.stones) s.t += dt;
        for (const r of g.ripples) r.t += dt;
        g.ripples = g.ripples.filter(r => r.t < 0.9);
        for (const f of g.floaters) f.t += dt;
        g.floaters = g.floaters.filter(f => f.t < 1.1);
        g.bulges = g.bulges.filter(b => b.tick < g.body.length + 1);
        // head angle eases toward its heading
        const ta = g.dir * Math.PI / 2;
        g.headAng += angDiff(g.headAng, ta) * (1 - Math.exp(-dt * 22));

        if (g.over) {
          g.endT += dt;
          if (g.death) {
            const d = g.death; d.t += dt;
            if (d.t > 0.55) {
              const rate = Math.max(55, g.body.length / 1.25);
              const before = d.front;
              d.front += rate * dt;
              for (let i = Math.floor(before); i < Math.min(g.body.length, Math.floor(d.front)); i++) {
                const [px, py] = cc(g.body[i]);
                g.parts.burst(px, py, 5, { speed: 2.6, speedMin: 0.4, life: 1.0, size: 0.1, color: ['#5df0b0', '#2fb88f', '#b8ffe0', '#1f8f78'], drag: 2, gravity: 1.2 });
              }
            }
          } else {
            // victory: sparkles rise from along the body
            if (Math.random() < 0.9) {
              const [px, py] = cc(g.body[(Math.random() * g.body.length) | 0]);
              g.parts.burst(px, py, 2, { speed: 1.8, speedMin: 0.5, life: 1.2, size: 0.09, color: ['#fff3c4', '#9bffd6', '#ffd27a'], angle: -Math.PI / 2, spread: 0.9, drag: 1 });
            }
          }
          return;
        }
        if (g.t > TIME_CAP) { g.over = true; g.won = false; g.death = { reason: 'time', t: 0, front: 0 }; return; }

        g.interval = 1 / g.speed();
        g.acc += dt;
        let guard = 0;
        while (g.acc >= g.interval && !g.over && guard++ < 4) {
          g.acc -= g.interval;
          tick();
          g.interval = 1 / g.speed();
        }
        if (g.over && g.death) g.acc = g.interval; // freeze at the end of the last move
      };

      // ---- drawing
      function snakePoints(p) {
        const { cell, bx, by } = g, b = g.body, n = b.length;
        const C = c => [bx + ((c % COLS) + 0.5) * cell, by + (((c / COLS) | 0) + 0.5) * cell];
        const pts = [];
        const [h1x, h1y] = C(b[0]);
        const [h0x, h0y] = C(n > 1 ? (g.prevHead !== undefined && !g.over ? g.prevHead : b[1]) : b[0]);
        pts.push([lerp(h0x, h1x, p), lerp(h0y, h1y, p)]);
        for (let i = 1; i < n; i++) pts.push(C(b[i]));
        if (g.prevTail >= 0) {
          const [ax, ay] = C(g.prevTail), [bx2, by2] = C(b[n - 1]);
          pts.push([lerp(ax, bx2, p), lerp(ay, by2, p)]);
        }
        return pts;
      }
      function chaikin(pts, it) {
        let P = pts;
        for (let k = 0; k < it; k++) {
          const Q = [P[0]];
          for (let i = 0; i < P.length - 1; i++) {
            const a = P[i], c = P[i + 1];
            Q.push([a[0] * 0.75 + c[0] * 0.25, a[1] * 0.75 + c[1] * 0.25], [a[0] * 0.25 + c[0] * 0.75, a[1] * 0.25 + c[1] * 0.75]);
          }
          Q.push(P[P.length - 1]);
          P = Q;
        }
        return P;
      }

      g.draw = function (ctx, W, H) {
        const { cell, bx, by, t } = g;
        if (!g.bg) g.resize(W, H);
        ctx.drawImage(g.bg, 0, 0, W, H);

        // drifting mist
        ctx.save();
        ctx.globalCompositeOperation = 'lighter';
        for (const b of g.blobs) {
          const x = (b.x + Math.sin(t * b.sp * 6 + b.ph) * 0.15) * W, y = (b.y + Math.cos(t * b.sp * 5 + b.ph) * 0.12) * H, r = b.r * Math.max(W, H);
          ctx.drawImage(mistSprite, x - r, y - r, r * 2, r * 2);
        }
        ctx.restore();

        const p = g.over ? 1 : clamp((g.acc + (Arcade.alpha === undefined ? 0 : Math.max(0, Math.min(1, Arcade.alpha))) / 60) / g.interval, 0, 1); // + alpha*step: sub-step tick progress
        const dying = g.death && !g.won;

        // stones
        for (const s of g.stones) {
          const k = ease.outBack(clamp(s.t / 0.5, 0, 1));
          const sx = bx + ((s.c % COLS) + 0.5) * cell, sy = by + (((s.c / COLS) | 0) + 0.5) * cell;
          const r = cell * 0.4 * k;
          ctx.save(); ctx.translate(sx, sy); ctx.rotate(s.rot);
          ctx.fillStyle = 'rgba(0,0,0,0.35)';
          ctx.beginPath(); ctx.ellipse(r * 0.1, r * 0.35, r * 1.05 * s.sx, r * 0.85, 0, 0, TAUV); ctx.fill();
          const sg = ctx.createRadialGradient(-r * 0.3, -r * 0.4, r * 0.1, 0, 0, r * 1.1);
          sg.addColorStop(0, '#7f9b8e'); sg.addColorStop(0.6, '#4a6358'); sg.addColorStop(1, '#2c4038');
          ctx.fillStyle = sg;
          ctx.beginPath();
          for (let i = 0; i < 7; i++) { const a = i / 7 * TAUV, rr = r * (0.9 + 0.12 * Math.sin(i * 2.3 + s.c)); const px = Math.cos(a) * rr * s.sx, py = Math.sin(a) * rr * 0.9; if (i) ctx.lineTo(px, py); else ctx.moveTo(px, py); }
          ctx.closePath(); ctx.fill();
          ctx.fillStyle = 'rgba(110,200,120,0.55)';
          ctx.beginPath(); ctx.ellipse(-r * 0.25, -r * 0.35, r * 0.5, r * 0.25, -0.4, 0, TAUV); ctx.fill();
          ctx.restore();
        }

        // berry
        if (g.food >= 0) {
          const fx = bx + ((g.food % COLS) + 0.5) * cell, fy = by + (((g.food / COLS) | 0) + 0.5) * cell;
          const grow = ease.outBack(clamp(g.foodT / 0.45, 0, 1));
          const pulse = 1 + 0.07 * Math.sin(t * 5);
          const gr = cell * 1.55 * pulse * grow;
          ctx.save();
          ctx.globalCompositeOperation = 'lighter';
          ctx.globalAlpha = 0.55 + 0.25 * Math.sin(t * 5);
          ctx.drawImage(amberGlow, fx - gr, fy - gr, gr * 2, gr * 2);
          ctx.restore();
          const life = 1 - g.foodT / BERRY_LIFE;
          if (!g.over) {
            ctx.strokeStyle = life < 0.3 ? 'rgba(255,170,90,0.55)' : 'rgba(255,220,150,0.22)';
            ctx.lineWidth = cell * 0.045; ctx.lineCap = 'round';
            ctx.beginPath(); ctx.arc(fx, fy, cell * 0.43, -Math.PI / 2, -Math.PI / 2 + TAUV * clamp(life, 0, 1)); ctx.stroke();
          }
          const r = cell * 0.3 * pulse * grow * (life < 0.12 ? 0.6 + life * 3.3 : 1);
          const bg = ctx.createRadialGradient(fx - r * 0.35, fy - r * 0.4, r * 0.1, fx, fy, r);
          bg.addColorStop(0, '#ffe9a8'); bg.addColorStop(0.35, '#ffb43a'); bg.addColorStop(1, '#d9601a');
          ctx.fillStyle = bg;
          ctx.beginPath(); ctx.arc(fx, fy, r, 0, TAUV); ctx.fill();
          ctx.fillStyle = 'rgba(255,255,255,0.7)';
          ctx.beginPath(); ctx.ellipse(fx - r * 0.35, fy - r * 0.42, r * 0.2, r * 0.12, -0.6, 0, TAUV); ctx.fill();
          ctx.fillStyle = '#4fb36a';
          ctx.beginPath(); ctx.ellipse(fx + r * 0.25, fy - r * 0.95, r * 0.34, r * 0.16, -0.5, 0, TAUV); ctx.fill();
        }

        // ripples
        ctx.save();
        ctx.translate(bx, by); ctx.scale(cell, cell);
        for (const r of g.ripples) {
          const k = ease.outCubic(r.t / 0.9);
          ctx.globalAlpha = (1 - k) * 0.8;
          ctx.strokeStyle = '#ffd27a'; ctx.lineWidth = 0.07 * (1 - k) + 0.01;
          ctx.beginPath(); ctx.arc(r.x, r.y, 0.3 + k * 1.6, 0, TAUV); ctx.stroke();
        }
        ctx.restore();

        // snake
        const n = g.body.length;
        let pts = chaikin(snakePoints(p), 2);
        // cumulative length (in cells)
        const cum = [0];
        for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]) / cell);
        const total = cum[cum.length - 1] || 1;
        const front = g.death && g.death.t > 0.55 ? g.death.front + (g.death.reason ? 0 : 0) : 0;
        let first = 0;
        while (first < pts.length - 1 && cum[first + 1] < front) first++;
        const alive = !(g.death && front >= total);
        const win = g.over && g.won;
        const flash = dying && g.death.t < 0.55 ? 0.5 + 0.5 * Math.sin(g.death.t * 40) : 0;

        if (alive && pts.length > 1) {
          ctx.lineCap = 'round'; ctx.lineJoin = 'round';
          // soft shadow
          ctx.globalAlpha = 0.28;
          ctx.strokeStyle = '#000'; ctx.lineWidth = cell * 0.82;
          ctx.beginPath();
          ctx.moveTo(pts[first][0], pts[first][1] + cell * 0.08);
          for (let i = first + 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1] + cell * 0.08);
          ctx.stroke();
          ctx.globalAlpha = 1;

          const bulgeD = g.bulges.map(b => b.tick + p);
          const widthAt = (i) => {
            const f = cum[i] / total;
            let w = cell * 0.78 * (1 - 0.4 * Math.pow(f, 1.6));
            for (const d of bulgeD) { const q = cum[i] - d; w += cell * 0.14 * Math.exp(-q * q / 0.6); }
            return w;
          };
          const colorAt = (i, rim) => {
            const f = cum[i] / total;
            if (win) {
              const wv = 0.5 + 0.5 * Math.sin(cum[i] * 0.45 - g.endT * 7);
              return rim ? `hsl(${160 + 20 * f},60%,${24 + 10 * wv}%)` : `hsl(${152 + 28 * f - 14 * wv},75%,${(56 - 28 * f) + 22 * wv}%)`;
            }
            const k = BODY_COLORS[Math.min(63, (f * 63) | 0)];
            return rim ? k.rim : k.fill;
          };
          // rim then fill, per segment
          for (const rim of [true, false]) {
            for (let i = first; i < pts.length - 1; i++) {
              const a = pts[i], b = pts[i + 1];
              ctx.strokeStyle = colorAt(i, rim);
              ctx.lineWidth = widthAt(i) + (rim ? cell * 0.07 : 0);
              ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke();
            }
          }
          // back stripe
          ctx.globalAlpha = 0.2;
          ctx.strokeStyle = '#d9fff0'; ctx.lineWidth = cell * 0.2;
          ctx.beginPath();
          ctx.moveTo(pts[first][0], pts[first][1] - cell * 0.1);
          for (let i = first + 1; i < pts.length; i++) {
            const f = cum[i] / total;
            if (f > 0.93) break;
            ctx.lineTo(pts[i][0], pts[i][1] - cell * 0.1 * (1 - f));
          }
          ctx.stroke();
          ctx.globalAlpha = 1;
          // scale diamonds
          ctx.fillStyle = 'rgba(0,30,25,0.16)';
          for (let i = first + 4; i < pts.length - 2; i += 4) {
            const f = cum[i] / total;
            ctx.beginPath(); ctx.arc(pts[i][0], pts[i][1], cell * 0.075 * (1 - 0.5 * f), 0, TAUV); ctx.fill();
          }
          if (flash > 0.01) {
            ctx.globalAlpha = flash * 0.85; ctx.strokeStyle = '#fff';
            for (let i = first; i < pts.length - 1; i++) {
              ctx.lineWidth = widthAt(i);
              ctx.beginPath(); ctx.moveTo(pts[i][0], pts[i][1]); ctx.lineTo(pts[i + 1][0], pts[i + 1][1]); ctx.stroke();
            }
            ctx.globalAlpha = 1;
          }
          // head
          if (first === 0) {
            const hx = pts[0][0], hy = pts[0][1], a = g.headAng, ca = Math.cos(a), sa = Math.sin(a);
            const hr = cell * 0.43;
            // tongue
            const tc = (t % 3.2);
            if (!g.over && tc < 0.4) {
              const k = Math.sin(tc / 0.4 * Math.PI);
              const tl = cell * 0.55 * k, tx = hx + ca * (hr + tl * 0.5), ty = hy + sa * (hr + tl * 0.5);
              ctx.strokeStyle = '#ff6f8a'; ctx.lineWidth = cell * 0.05;
              ctx.beginPath(); ctx.moveTo(hx + ca * hr * 0.8, hy + sa * hr * 0.8); ctx.lineTo(tx, ty);
              ctx.lineTo(tx + (ca - sa * 0.7) * cell * 0.12 * k, ty + (sa + ca * 0.7) * cell * 0.12 * k);
              ctx.moveTo(tx, ty);
              ctx.lineTo(tx + (ca + sa * 0.7) * cell * 0.12 * k, ty + (sa - ca * 0.7) * cell * 0.12 * k);
              ctx.stroke();
            }
            const hg = ctx.createRadialGradient(hx - ca * hr * 0.2, hy - sa * hr * 0.2 - hr * 0.2, hr * 0.1, hx, hy, hr * 1.1);
            hg.addColorStop(0, win ? '#c8ffe8' : '#7dffc6'); hg.addColorStop(1, '#27c28c');
            ctx.fillStyle = hg;
            ctx.beginPath(); ctx.ellipse(hx + ca * hr * 0.12, hy + sa * hr * 0.12, hr * 1.08, hr * 0.96, a, 0, TAUV); ctx.fill();
            ctx.strokeStyle = '#0f5a47'; ctx.lineWidth = cell * 0.04; ctx.stroke();
            if (flash > 0.01) { ctx.fillStyle = `rgba(255,255,255,${flash * 0.85})`; ctx.fill(); }
            // eyes
            const dead = dying && g.death.t > 0.0;
            for (const s of [-1, 1]) {
              const ex = hx + ca * hr * 0.42 - sa * s * hr * 0.55, ey = hy + sa * hr * 0.42 + ca * s * hr * 0.55;
              ctx.fillStyle = '#f4fff8';
              ctx.beginPath(); ctx.arc(ex, ey, hr * 0.3, 0, TAUV); ctx.fill();
              ctx.fillStyle = '#0b2a24';
              ctx.beginPath();
              if (dead) { ctx.lineWidth = cell * 0.04; ctx.strokeStyle = '#0b2a24'; ctx.moveTo(ex - hr * 0.16, ey - hr * 0.16); ctx.lineTo(ex + hr * 0.16, ey + hr * 0.16); ctx.moveTo(ex + hr * 0.16, ey - hr * 0.16); ctx.lineTo(ex - hr * 0.16, ey + hr * 0.16); ctx.stroke(); }
              else ctx.arc(ex + ca * hr * 0.1, ey + sa * hr * 0.1, hr * 0.15, 0, TAUV);
              ctx.fill();
            }
          }
        }

        // particles + floaters (board units)
        ctx.save();
        ctx.translate(bx, by); ctx.scale(cell, cell);
        g.parts.draw(ctx, 1);
        ctx.restore();
        for (const f of g.floaters) {
          const k = f.t / 1.1;
          ctx.globalAlpha = 1 - k * k;
          ctx.fillStyle = '#ffe3a0';
          ctx.font = `600 ${(cell * 0.5) | 0}px Fredoka, "Trebuchet MS", sans-serif`;
          ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
          ctx.fillText(f.txt, bx + f.x * cell, by + (f.y - 0.5 - ease.outCubic(k) * 1.1) * cell);
        }
        ctx.globalAlpha = 1;

        // fireflies
        ctx.save();
        ctx.globalCompositeOperation = 'lighter';
        for (const f of g.flies) {
          const x = (f.x + Math.sin(t * f.sp + f.ph) * 0.04 + Math.sin(t * f.sp * 0.37 + f.ph * 2) * 0.03) * W;
          const y = (f.y + Math.cos(t * f.sp * 0.8 + f.ph) * 0.05) * H;
          const tw = 0.5 + 0.5 * Math.sin(t * (1.2 + f.sp * 3) + f.ph * 3);
          const r = cell * 0.2 * f.r * (0.7 + 0.5 * tw);
          ctx.globalAlpha = 0.25 + 0.65 * tw;
          ctx.drawImage(flySprite, x - r, y - r, r * 2, r * 2);
        }
        ctx.restore();

        // vignette
        staticLayer(ctx, 'vg', W, H, (x, W, H) => {
          const vg = x.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.35, W / 2, H / 2, Math.hypot(W, H) * 0.55);
          vg.addColorStop(0, 'rgba(0,0,0,0)'); vg.addColorStop(1, 'rgba(0,8,6,0.55)');
          x.fillStyle = vg; x.fillRect(0, 0, W, H);
        });

        // dawn creeping in during the last minute
        const dawn = clamp((g.t - (TIME_CAP - 60)) / 60, 0, 1);
        if (dawn > 0) {
          const dg = ctx.createLinearGradient(0, H, 0, 0);
          dg.addColorStop(0, `rgba(255,170,90,${0.16 * dawn})`); dg.addColorStop(0.6, `rgba(255,140,100,${0.05 * dawn})`); dg.addColorStop(1, 'rgba(255,140,100,0)');
          ctx.fillStyle = dg; ctx.fillRect(0, 0, W, H);
        }
        if (win) {
          const k = clamp(g.endT / 1.2, 0, 1);
          ctx.globalAlpha = 0.18 * Math.sin(k * Math.PI);
          ctx.fillStyle = '#baffe0'; ctx.fillRect(0, 0, W, H);
          ctx.globalAlpha = 1;
        }
      };

      g.hud = () => ({ score: `Length ${g.body.length}`, detail: `${g.berries} berries · ${g.speed().toFixed(0)} moves/s` });
      g.result = () => g.result0() + ` (${g.style})`;
      g.result0 = () => {
        if (g.won) return `Grew to ${g.body.length} cells in ${g.moves} moves`;
        if (g.death && g.death.reason === 'time') return 'Dawn broke before the serpent finished';
        if (g.death && g.death.reason === 'wall') return `Hit the wall at length ${g.body.length}`;
        if (g.death && g.death.reason === 'stone') return `Ran into a stone at length ${g.body.length}`;
        return `Tangled itself at length ${g.body.length}`;
      };
      return g;
    },
  });
})();
