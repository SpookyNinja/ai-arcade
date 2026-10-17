// maze.js - Lamplight Labyrinth: a lantern-bearing explorer crosses a fogged maze toward a teal
// beacon. Discovered walls glow gold. The AI plans with the "freespace assumption" (A* to the exit
// treating every wall it has not seen as open) through a separate MazeAI object.
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

  const FLOORS = [[25, 14], [33, 19], [41, 23]]; // maze size per floor
  const MAXN = 41 * 23;
  let MW = 33, MH = 19, N = MW * MH; // current floor's size (set by loadFloor)
  const TIME_LIMIT = 100;     // shared time budget (seconds) for all three floors, shown as the beacon ring
  const SIGHT = 99;           // how far (in cells) lamplight carries down a corridor
  const SPEED = 6;            // cells per second
  const START_DELAY = 0.7;    // seconds of lamp-lighting before the explorer sets off
  const LOOP_FRACTION = 0.04; // extra walls knocked out (fraction of cells) to make loops
  const DX = [1, 0, -1, 0], DY = [0, 1, 0, -1]; // 0 east, 1 south, 2 west, 3 north
  const TAUV = Math.PI * 2;

  // ------------------------------------------------------------------ AI
  // MazeAI sees only what the lantern light has revealed and the (always visible) beacon:
  //   view.pos {x,y}, view.exit {x,y}, view.heading, view.edge(x,y,d) -> -1 unseen, 0 open, 1 wall.
  // It never touches the real maze. Every time the explorer reaches a cell it re-plans an A* route
  // to the exit that treats unseen edges as open, then takes ONE step along it.
  const MazeAI = (() => {
    const gS = new Float32Array(MAXN * 4), from = new Int32Array(MAXN * 4), closed = new Uint8Array(MAXN * 4);
    // tiny binary heap of [f, h, state]
    let heap = [];
    const push = (f, h, s) => {
      heap.push([f, h, s]);
      let i = heap.length - 1;
      while (i > 0) {
        const p = (i - 1) >> 1;
        if (less(heap[i], heap[p])) { const t = heap[i]; heap[i] = heap[p]; heap[p] = t; i = p; } else break;
      }
    };
    const less = (a, b) => a[0] < b[0] - 1e-9 || (Math.abs(a[0] - b[0]) <= 1e-9 && a[1] < b[1]);
    const pop = () => {
      const top = heap[0], last = heap.pop();
      if (heap.length) {
        heap[0] = last;
        let i = 0;
        for (;;) {
          const l = 2 * i + 1, r = l + 1; let m = i;
          if (l < heap.length && less(heap[l], heap[m])) m = l;
          if (r < heap.length && less(heap[r], heap[m])) m = r;
          if (m === i) break;
          const t = heap[i]; heap[i] = heap[m]; heap[m] = t; i = m;
        }
      }
      return top;
    };

    // Styles: heuristic weight (hw >1 dives greedily at the exit), turn penalty (high = prefers long
    // straight sight lines), revisit penalty (>0 = prefers fresh ground, explorer-like).
    const STYLES = {
      'Beeline': { hw: 1, turn: 0.01, vis: 0 },
      'Bold diver': { hw: 1.4, turn: 0.01, vis: 0 },
      'Explorer': { hw: 1, turn: 0.05, vis: 0.35 },
      'Corridor scout': { hw: 1, turn: 0.35, vis: 0 },
    };
    return {
      STYLES, st: STYLES['Beeline'],
      // returns the planned route as an array of {x,y} cells (start excluded), or []
      plan(view) {
        const ex = view.exit.x, ey = view.exit.y;
        const st = this.st;
        const hh = (x, y) => (Math.abs(x - ex) + Math.abs(y - ey)) * st.hw;
        gS.fill(1e9); closed.fill(0); heap = [];
        const s0 = (view.pos.y * MW + view.pos.x) * 4 + view.heading;
        gS[s0] = 0; from[s0] = -1;
        push(hh(view.pos.x, view.pos.y), hh(view.pos.x, view.pos.y), s0);
        let goal = -1;
        while (heap.length) {
          const [, , s] = pop();
          if (closed[s]) continue;
          closed[s] = 1;
          const c = s >> 2, dir = s & 3, x = c % MW, y = (c / MW) | 0;
          if (x === ex && y === ey) { goal = s; break; }
          for (let d = 0; d < 4; d++) {
            if (view.edge(x, y, d) === 1) continue; // known wall; unknown counts as open
            const nx = x + DX[d], ny = y + DY[d];
            if (nx < 0 || ny < 0 || nx >= MW || ny >= MH) continue;
            const ns = (ny * MW + nx) * 4 + d;
            if (closed[ns]) continue;
            const cost = gS[s] + 1 + (d === dir ? 0 : st.turn) + (st.vis && view.visited(nx, ny) ? st.vis : 0) + Math.random() * 0.003; // random tie-breaks
            if (cost < gS[ns]) { gS[ns] = cost; from[ns] = s; const h = hh(nx, ny); push(cost + h, h, ns); }
          }
        }
        const route = [];
        for (let s = goal; s >= 0 && from[s] >= 0; s = from[s]) route.push({ x: (s >> 2) % MW, y: (((s >> 2) / MW) | 0) });
        return route.reverse();
      },
    };
  })();

  // ------------------------------------------------------------------ helpers
  const mkSprite = (size, stops) => {
    const c = document.createElement('canvas'); c.width = c.height = size;
    const g = c.getContext('2d');
    const r = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    for (const [o, col] of stops) r.addColorStop(o, col);
    g.fillStyle = r; g.fillRect(0, 0, size, size);
    return c;
  };
  let lampSprite = null, tealSprite = null, grain = null;
  const sprites = () => {
    if (lampSprite) return;
    lampSprite = mkSprite(256, [[0, 'rgba(255,214,140,0.55)'], [0.18, 'rgba(255,190,100,0.28)'], [0.5, 'rgba(255,170,80,0.09)'], [1, 'rgba(255,160,70,0)']]);
    tealSprite = mkSprite(128, [[0, 'rgba(120,255,235,0.85)'], [0.3, 'rgba(40,220,200,0.35)'], [1, 'rgba(20,200,190,0)']]);
    grain = document.createElement('canvas'); grain.width = grain.height = 192;
    const g = grain.getContext('2d'), id = g.createImageData(192, 192);
    for (let i = 0; i < id.data.length; i += 4) {
      const v = Math.random();
      id.data[i] = 180; id.data[i + 1] = 200; id.data[i + 2] = 255; id.data[i + 3] = v < 0.5 ? 0 : (v - 0.5) * 22;
    }
    g.putImageData(id, 0, 0);
  };

  function generate() {
    const wE = new Uint8Array(N).fill(1), wS = new Uint8Array(N).fill(1), vis = new Uint8Array(N);
    const open = (c, d) => { if (d === 0) wE[c] = 0; else if (d === 1) wS[c] = 0; else if (d === 2) wE[c - 1] = 0; else wS[c - MW] = 0; };
    const stack = [(Math.random() * N) | 0];
    vis[stack[0]] = 1;
    while (stack.length) {
      const c = stack[stack.length - 1], x = c % MW, y = (c / MW) | 0;
      const ds = [];
      for (let d = 0; d < 4; d++) {
        const nx = x + DX[d], ny = y + DY[d];
        if (nx >= 0 && ny >= 0 && nx < MW && ny < MH && !vis[ny * MW + nx]) ds.push(d);
      }
      if (!ds.length) { stack.pop(); continue; }
      const d = rnd.pick(ds), n = (y + DY[d]) * MW + x + DX[d];
      open(c, d); vis[n] = 1; stack.push(n);
    }
    // knock out a few extra walls so the maze has loops
    const cand = [];
    for (let c = 0; c < N; c++) {
      const x = c % MW, y = (c / MW) | 0;
      if (x < MW - 1 && wE[c]) cand.push([c, 0]);
      if (y < MH - 1 && wS[c]) cand.push([c, 1]);
    }
    rnd.shuffle(cand);
    for (let i = 0; i < Math.round(N * LOOP_FRACTION); i++) open(cand[i][0], cand[i][1]);
    return { wE, wS };
  }

  // ------------------------------------------------------------------ game
  Arcade.register({
    id: 'maze', name: 'Lamplight Labyrinth', genre: 'Maze Exploration',
    aiNote: "Sees only what its lantern has lit plus the beacon, assumes unseen walls are open, and re-plans an A* route at every cell.",
    blurb: 'A lantern explorer feels its way through a fogged maze toward a teal beacon.',
    bg: '#0a1426', accent: '#e8b45a',
    create() {
      sprites();
      let wE, wS, leftStart, start, exit;
      const style = rnd.pick(Object.keys(MazeAI.STYLES));
      MazeAI.st = MazeAI.STYLES[style];

      const g = {
        over: false, won: false, W: 800, H: 600, cell: 30, bx: 0, by: 0,
        t: 0, clock: 0, steps: 0, endT: 0, floor: 0, phase: 'play', phT: 0,
        trail: [], parts: new Particles(), rings: [], dust: [], flare: 0, fade: 0,
      };
      // Build floor i: new maze, fresh knowledge, explorer back at a start cell.
      function loadFloor(i) {
        g.floor = i;
        [MW, MH] = FLOORS[i]; N = MW * MH;
        ({ wE, wS } = generate());
        leftStart = i % 2 === 0 ? Math.random() < 0.5 : !leftStart;
        start = { x: leftStart ? 0 : MW - 1, y: rnd.int(MH) };
        exit = { x: leftStart ? MW - 1 : 0, y: rnd.int(MH) };
        Object.assign(g, {
          pos: { x: start.x, y: start.y }, target: null, m: 0, heading: leftStart ? 0 : 2,
          vx: start.x + 0.5, vy: start.y + 0.5,
          seenT: new Float32Array(N).fill(-1), visT: new Float32Array(N).fill(-1),
          kE: new Float32Array(N).fill(-1), kS: new Float32Array(N).fill(-1), // reveal times, -1 unknown
          seenCount: 0, route: [],
          wallAnim: [], wallPath: new Path2D(), seenAnim: [], seenPath: new Path2D(), visAnim: [], visPath: new Path2D(),
          dots: null, dotsKey: -1, trail: [], rings: [],
        });
      }
      loadFloor(0);
      for (let i = 0; i < 36; i++) g.dust.push({ x: Math.random(), y: Math.random(), ph: Math.random() * 10, sp: 0.01 + Math.random() * 0.02, r: 0.5 + Math.random() });

      // ----- what the explorer can see
      const trueWall = (x, y, d) => {
        if (d === 0) return x >= MW - 1 || wE[y * MW + x] === 1;
        if (d === 1) return y >= MH - 1 || wS[y * MW + x] === 1;
        if (d === 2) return x <= 0 || wE[y * MW + x - 1] === 1;
        return y <= 0 || wS[(y - 1) * MW + x] === 1;
      };
      const edgeIdx = (x, y, d) => {
        if (d === 0) return x < MW - 1 ? [g.kE, y * MW + x] : null;
        if (d === 1) return y < MH - 1 ? [g.kS, y * MW + x] : null;
        if (d === 2) return x > 0 ? [g.kE, y * MW + x - 1] : null;
        return y > 0 ? [g.kS, (y - 1) * MW + x] : null;
      };
      const revealEdge = (x, y, d, at) => {
        const e = edgeIdx(x, y, d);
        if (!e || e[0][e[1]] >= 0) return;
        e[0][e[1]] = at;
        if (trueWall(x, y, d)) {
          const cx = x + (d === 0 ? 1 : 0), cy = y + (d === 1 ? 1 : 0);
          // segment between this cell and its neighbour
          let seg;
          if (d === 0) seg = [x + 1, y, x + 1, y + 1];
          else if (d === 2) seg = [x, y, x, y + 1];
          else if (d === 1) seg = [x, y + 1, x + 1, y + 1];
          else seg = [x, y, x + 1, y];
          void cx; void cy;
          g.wallAnim.push({ a: seg, t0: at });
        }
      };
      const markSeen = (x, y, at) => {
        const c = y * MW + x;
        if (g.seenT[c] >= 0) return;
        g.seenT[c] = at; g.seenCount++;
        g.seenAnim.push({ c, t0: at });
        for (let d = 0; d < 4; d++) revealEdge(x, y, d, at);
      };
      const look = () => {
        const { x, y } = g.pos;
        markSeen(x, y, g.t);
        for (let d = 0; d < 4; d++) {
          let cx = x, cy = y, k = 0;
          while (k < SIGHT && !trueWall(cx, cy, d)) {
            cx += DX[d]; cy += DY[d]; k++;
            markSeen(cx, cy, g.t + k * 0.03);
          }
        }
      };
      const view = {
        visited(x, y) { return g.visT[y * MW + x] >= 0; },
        get pos() { return g.pos; }, get exit() { return exit; }, get heading() { return g.heading; },
        // -1 = not yet seen, 0 = seen open, 1 = seen wall (outer border is always visible)
        edge(x, y, d) {
          const e = edgeIdx(x, y, d);
          if (!e) return 1;
          if (e[0][e[1]] < 0) return -1;
          return trueWall(x, y, d) ? 1 : 0;
        },
      };

      // ----- logic
      const arrive = () => {
        g.pos = g.target; g.target = null; g.m = 0; g.steps++;
        const c = g.pos.y * MW + g.pos.x;
        if (g.visT[c] < 0) { g.visT[c] = g.t; g.visAnim.push({ c, t0: g.t }); }
        look();
        if (g.pos.x === exit.x && g.pos.y === exit.y) { if (g.floor >= FLOORS.length - 1) win(); else floorClear(); }
      };
      const floorClear = () => {
        g.phase = 'clear'; g.phT = 0; g.target = null; g.route = [];
        lightUp(); g.flare = 1;
      };
      const win = () => {
        g.over = true; g.won = true; g.endT = 0;
        lightUp();
      };
      const lightUp = () => {
        // the whole labyrinth lights up outward from the beacon
        for (let y = 0; y < MH; y++) for (let x = 0; x < MW; x++) {
          const at = g.t + 0.25 + (Math.abs(x - exit.x) + Math.abs(y - exit.y)) * 0.016;
          markSeen(x, y, at);
        }
        g.parts.burst(exit.x + 0.5, exit.y + 0.5, 70, { speed: 4.5, speedMin: 1, life: 1.4, size: 0.09, color: ['#7ffff0', '#ffe3a0', '#ffffff', '#3fe0d0'], drag: 1.6 });
        g.rings.push({ t: 0, x: exit.x + 0.5, y: exit.y + 0.5 }, { t: -0.25, x: exit.x + 0.5, y: exit.y + 0.5 });
      };
      const lose = () => {
        g.over = true; g.won = false; g.endT = 0; g.target = null;
        g.parts.burst(g.pos.x + 0.5, g.pos.y + 0.5, 22, { speed: 1.6, speedMin: 0.3, life: 1.2, size: 0.07, color: ['#ffcf8a', '#c9823a'], drag: 2, gravity: 0.6 });
      };

      g.resize = function (W, H) {
        g.W = W; g.H = H;
        g.cell = Math.max(6, Math.min(W * 0.9 / MW, H * 0.86 / MH));
        g.bx = (W - g.cell * MW) / 2;
        g.by = H * 0.49 - g.cell * MH / 2;
        if (g.bx < 370 && g.by + g.cell * MH > H - 104) { // keep clear of the shell HUD box (bottom-left)
          const top = H * 0.04, bottom = H - 104;
          g.cell = Math.max(6, Math.min(W * 0.9 / MW, (bottom - top) / MH));
          g.bx = (W - g.cell * MW) / 2;
          g.by = (top + bottom) / 2 - g.cell * MH / 2;
        }
      };

      const enterFloor = () => {
        look();
        g.visT[start.y * MW + start.x] = g.t; g.visAnim.push({ c: start.y * MW + start.x, t0: g.t });
      };
      enterFloor();

      const ipg = () => [[[g], ['vx', 'vy'], 3], [[g], ['t', 'phT'], 0, 't'], [g.rings, ['t'], 0, 't']];
      g.step = function (dt) {
        IP.snap(ipg());
        g.t += dt;
        g.parts.update(dt);
        for (const r of g.rings) r.t += dt;
        g.rings = g.rings.filter(r => r.t < 1.4);
        // follower for smooth lantern motion
        const tx = (g.target ? g.pos.x + (g.target.x - g.pos.x) * g.m : g.pos.x) + 0.5;
        const ty = (g.target ? g.pos.y + (g.target.y - g.pos.y) * g.m : g.pos.y) + 0.5;
        const k = 1 - Math.exp(-dt * 20);
        g.vx += (tx - g.vx) * k; g.vy += (ty - g.vy) * k;
        g.trail.push(g.vx, g.vy, g.t);
        while (g.trail.length > 3 && g.t - g.trail[2] > 2.6) g.trail.splice(0, 3);
        // lantern embers
        if (!g.over || g.won) if (Math.random() < dt * 14) g.parts.burst(g.vx, g.vy, 1, { speed: 0.5, speedMin: 0.1, life: 1.1, size: 0.05, color: ['#ffd9a0', '#ffb86b'], angle: -Math.PI / 2, spread: 1.2, drag: 1 });

        if (g.over) { g.endT += dt; return; }
        g.flare = Math.max(0, g.flare - dt * 0.9);
        if (g.phase !== 'play') {
          // floor-clear sequence: flare + light-up (1.3 s), zoom into the stairs (0.7 s), next floor fades in (0.5 s)
          g.phT += dt;
          if (g.phase === 'clear' && g.phT > 1.3) { g.phase = 'zoom'; g.phT = 0; }
          else if (g.phase === 'zoom' && g.phT > 0.7) {
            loadFloor(g.floor + 1); g.resize(g.W, g.H); enterFloor();
            g.phase = 'fadein'; g.phT = 0; g.t0 = g.t;
          } else if (g.phase === 'fadein' && g.phT > 0.5) { g.phase = 'play'; g.phT = 0; g.floorT = g.t; }
          return;
        }
        if (g.t < START_DELAY && g.floor === 0) return;
        g.clock += dt;
        if (g.clock >= TIME_LIMIT) { lose(); return; }

        let rem = dt, guard = 0;
        while (rem > 0 && !g.over && guard++ < 6) {
          if (!g.target) {
            g.route = MazeAI.plan(view);
            if (!g.route.length) return;
            const n = g.route[0];
            for (let d = 0; d < 4; d++) if (g.pos.x + DX[d] === n.x && g.pos.y + DY[d] === n.y) g.heading = d;
            g.target = n; g.m = 0;
          }
          const need = (1 - g.m) / SPEED;
          if (rem >= need) { rem -= need; arrive(); }
          else { g.m += rem * SPEED; rem = 0; }
        }
      };

      // ----- drawing
      const COL_WALL = 'rgba(238,186,100,0.74)';
      const drawRaw = function (ctx, W, H) {
        if (g.W !== W || g.H !== H) g.resize(W, H);
        const { cell, t } = g;
        // background
        // static backdrop cached on an offscreen canvas (one blit instead of two full-screen fills)
        const sc = Math.min(2, (ctx.getTransform ? ctx.getTransform().a : 1) || 1);
        if (!g.bgC || g.bgC.W !== W || g.bgC.H !== H || g.bgC.sc !== sc) {
          const c = document.createElement('canvas'); c.width = Math.ceil(W * sc); c.height = Math.ceil(H * sc);
          const x = c.getContext('2d'); x.scale(sc, sc);
          x.fillStyle = '#0a1426'; x.fillRect(0, 0, W, H);
          const bgG = x.createRadialGradient(W * 0.5, H * 0.45, 0, W * 0.5, H * 0.5, Math.hypot(W, H) * 0.6);
          bgG.addColorStop(0, 'rgba(36,58,100,0.55)'); bgG.addColorStop(1, 'rgba(4,8,18,0.6)');
          x.fillStyle = bgG; x.fillRect(0, 0, W, H);
          g.bgC = { c, W, H, sc };
        }
        ctx.drawImage(g.bgC.c, 0, 0, W, H);
        ctx.save();
        ctx.globalAlpha = 0.9;
        ctx.fillStyle = ctx.createPattern(grain, 'repeat');
        ctx.translate((t * 3) % 192, (t * 2) % 192); ctx.translate(-192, -192);
        ctx.fillRect(0, 0, W + 192, H + 192);
        ctx.restore();
        // dust motes
        ctx.save(); ctx.globalCompositeOperation = 'lighter';
        for (const d of g.dust) {
          const x = (d.x + Math.sin(t * d.sp * 6 + d.ph) * 0.03) * W, y = ((d.y + t * d.sp * 0.5) % 1) * H;
          ctx.globalAlpha = 0.18 + 0.14 * Math.sin(t * 0.8 + d.ph);
          ctx.fillStyle = '#a9bfff';
          ctx.beginPath(); ctx.arc(x, y, 1.2 * d.r, 0, TAUV); ctx.fill();
        }
        ctx.restore();

        const lightK = g.over && !g.won ? Math.max(0, 1 - g.endT / 1.6) : 1;
        const flick = 1 + 0.04 * Math.sin(t * 9) + 0.03 * Math.sin(t * 13.7 + 1);

        ctx.save();
        if (g.phase === 'zoom') {
          const z = 1 + 2.4 * ease.inOutCubic(g.phT / 0.7), sx = g.bx + (exit.x + 0.5) * cell, sy = g.by + (exit.y + 0.5) * cell;
          ctx.translate(sx, sy); ctx.scale(z, z); ctx.translate(-sx, -sy);
        }
        // gentle parallax drift
        const px = -(g.vx - MW / 2) * cell * 0.006 + Math.sin(t * 0.21) * 2.5, py = -(g.vy - MH / 2) * cell * 0.006 + Math.cos(t * 0.17) * 2;
        ctx.translate(g.bx + px, g.by + py); ctx.scale(cell, cell);
        const px1 = 1 / cell;

        // board panel
        roundRect(ctx, -0.25, -0.25, MW + 0.5, MH + 0.5, 0.4);
        ctx.fillStyle = 'rgba(14,26,52,0.7)'; ctx.fill();
        ctx.strokeStyle = 'rgba(120,150,210,0.10)'; ctx.lineWidth = px1; ctx.stroke();

        // unseen dotted grid
        let visibleSeen = 0;
        for (let c = 0; c < N; c++) if (g.seenT[c] >= 0 && g.seenT[c] <= t) visibleSeen++;
        if (visibleSeen !== g.dotsKey) {
          g.dotsKey = visibleSeen;
          const p = new Path2D();
          for (let c = 0; c < N; c++) if (!(g.seenT[c] >= 0 && g.seenT[c] <= t)) { const x = (c % MW) + 0.5, y = ((c / MW) | 0) + 0.5; p.moveTo(x + 0.05, y); p.arc(x, y, 0.05, 0, TAUV); }
          g.dots = p;
        }
        ctx.fillStyle = 'rgba(130,155,215,0.28)'; ctx.fill(g.dots);

        // floor washes (seen = faint cool, visited = warm)
        const layer = (anim, path, fill, dur) => {
          for (let i = anim.length - 1; i >= 0; i--) {
            const it = anim[i], age = t - it.t0;
            if (age >= dur) { path.rect(it.c % MW, (it.c / MW) | 0, 1, 1); anim.splice(i, 1); }
          }
          ctx.fillStyle = fill; ctx.fill(path);
          for (const it of anim) {
            const age = t - it.t0; if (age <= 0) continue;
            ctx.globalAlpha = age / dur; ctx.fillRect(it.c % MW, (it.c / MW) | 0, 1, 1);
          }
          ctx.globalAlpha = 1;
        };
        layer(g.seenAnim, g.seenPath, 'rgba(110,140,205,0.055)', 0.5);
        layer(g.visAnim, g.visPath, 'rgba(255,184,96,0.17)', 0.8);

        // outer border (always visible)
        ctx.lineCap = 'round'; ctx.lineJoin = 'round';
        ctx.strokeStyle = 'rgba(238,186,100,0.38)'; ctx.lineWidth = 0.07;
        ctx.strokeRect(0, 0, MW, MH);

        // planned route
        if (g.route.length && !g.over) {
          ctx.save();
          ctx.setLineDash([0.14, 0.2]); ctx.lineDashOffset = -t * 0.9;
          ctx.strokeStyle = 'rgba(170,225,255,0.34)'; ctx.lineWidth = 0.055;
          ctx.beginPath(); ctx.moveTo(g.vx, g.vy);
          for (const r of g.route) ctx.lineTo(r.x + 0.5, r.y + 0.5);
          ctx.stroke(); ctx.restore();
        }

        // trail
        if (g.trail.length > 6) {
          ctx.save();
          for (let i = 3; i < g.trail.length; i += 3) {
            const age = t - g.trail[i + 2], a = Math.max(0, 1 - age / 2.6);
            ctx.strokeStyle = `rgba(255,190,110,${0.5 * a * a * lightK})`;
            ctx.lineWidth = 0.12 * (0.3 + 0.7 * a);
            ctx.beginPath(); ctx.moveTo(g.trail[i - 3], g.trail[i - 2]); ctx.lineTo(g.trail[i], g.trail[i + 1]); ctx.stroke();
          }
          ctx.restore();
        }

        // walls: settled ones live in one Path2D; fresh ones draw in
        for (let i = g.wallAnim.length - 1; i >= 0; i--) {
          const w = g.wallAnim[i];
          if (t - w.t0 >= 0.5) { g.wallPath.moveTo(w.a[0], w.a[1]); g.wallPath.lineTo(w.a[2], w.a[3]); g.wallAnim.splice(i, 1); }
        }
        ctx.strokeStyle = 'rgba(255,170,70,0.10)'; ctx.lineWidth = 0.2; ctx.stroke(g.wallPath);
        ctx.strokeStyle = COL_WALL; ctx.lineWidth = 0.06; ctx.stroke(g.wallPath);
        for (const w of g.wallAnim) {
          const age = t - w.t0; if (age <= 0) continue;
          const k = ease.outCubic(Math.min(1, age / 0.5));
          const mx = (w.a[0] + w.a[2]) / 2, my = (w.a[1] + w.a[3]) / 2;
          const hx = (w.a[2] - w.a[0]) / 2 * k, hy = (w.a[3] - w.a[1]) / 2 * k;
          ctx.strokeStyle = `rgba(255,228,160,${0.95 - 0.2 * k})`; ctx.lineWidth = 0.06 + 0.05 * (1 - k);
          ctx.beginPath(); ctx.moveTo(mx - hx, my - hy); ctx.lineTo(mx + hx, my + hy); ctx.stroke();
          ctx.strokeStyle = `rgba(255,170,70,${0.25 * (1 - k)})`; ctx.lineWidth = 0.22;
          ctx.stroke();
        }

        // lantern light: warm glow + brighter walls inside the radius
        const lr = (g.won || !g.over ? 4.6 : 4.6 * lightK + 0.6) * flick;
        if (lightK > 0.01) {
          ctx.save();
          ctx.beginPath(); ctx.arc(g.vx, g.vy, lr * 0.62, 0, TAUV); ctx.clip();
          ctx.strokeStyle = `rgba(255,232,170,${0.55 * lightK})`; ctx.lineWidth = 0.07; ctx.stroke(g.wallPath);
          ctx.restore();
          ctx.save(); ctx.globalCompositeOperation = 'lighter'; ctx.globalAlpha = lightK;
          ctx.drawImage(lampSprite, g.vx - lr, g.vy - lr, lr * 2, lr * 2);
          ctx.restore();
        }

        // exit beacon
        const ex = exit.x + 0.5, ey = exit.y + 0.5;
        const left = clamp(1 - g.clock / TIME_LIMIT, 0, 1);
        const pulse = 0.5 + 0.5 * Math.sin(t * 3);
        const br = (2.6 + 0.5 * pulse + 3 * g.flare) * (g.over && !g.won ? 0.6 + 0.4 * Math.max(0, 1 - g.endT) : 1);
        ctx.save(); ctx.globalCompositeOperation = 'lighter';
        ctx.globalAlpha = 0.8 + 0.2 * pulse;
        ctx.drawImage(tealSprite, ex - br, ey - br, br * 2, br * 2);
        ctx.globalCompositeOperation = 'source-over';
        for (let i = 0; i < 2; i++) {
          const ph = ((t * 0.5 + i * 0.5) % 1);
          ctx.strokeStyle = `rgba(110,255,235,${0.35 * (1 - ph)})`; ctx.lineWidth = 0.05;
          ctx.beginPath(); ctx.arc(ex, ey, 0.3 + ph * 1.3, 0, TAUV); ctx.stroke();
        }
        // time ring
        ctx.lineWidth = 0.07;
        ctx.strokeStyle = 'rgba(120,255,235,0.12)';
        ctx.beginPath(); ctx.arc(ex, ey, 0.62, 0, TAUV); ctx.stroke();
        const hue = left > 0.4 ? 172 : left > 0.18 ? 40 + (left - 0.18) * 400 : 8 + left * 150;
        ctx.strokeStyle = `hsla(${hue},85%,66%,0.85)`;
        ctx.beginPath(); ctx.arc(ex, ey, 0.62, -Math.PI / 2, -Math.PI / 2 + TAUV * left); ctx.stroke();
        // core
        const cr = 0.2 + 0.04 * pulse;
        const cg = ctx.createRadialGradient(ex, ey, 0, ex, ey, cr * 1.6);
        cg.addColorStop(0, '#f2fffd'); cg.addColorStop(0.5, '#79f5e4'); cg.addColorStop(1, 'rgba(40,200,190,0)');
        ctx.fillStyle = cg; ctx.beginPath(); ctx.arc(ex, ey, cr * 1.6, 0, TAUV); ctx.fill();
        ctx.restore();

        // win rings
        for (const r of g.rings) {
          if (r.t < 0) continue;
          const k = ease.outCubic(r.t / 1.4);
          ctx.strokeStyle = `rgba(130,255,238,${0.7 * (1 - k)})`; ctx.lineWidth = 0.12 * (1 - k) + 0.02;
          ctx.beginPath(); ctx.arc(r.x, r.y, 0.5 + k * 9, 0, TAUV); ctx.stroke();
        }

        // explorer orb
        const orbA = g.over && !g.won ? Math.max(0, 1 - g.endT / 1.2) * (0.6 + 0.4 * Math.sin(g.endT * 30)) : 1;
        if (orbA > 0.01) {
          const orr = 0.42 * flick;
          ctx.save(); ctx.globalCompositeOperation = 'lighter'; ctx.globalAlpha = orbA;
          ctx.drawImage(lampSprite, g.vx - 1.6, g.vy - 1.6, 3.2, 3.2);
          ctx.restore();
          ctx.globalAlpha = orbA;
          const og = ctx.createRadialGradient(g.vx, g.vy, 0, g.vx, g.vy, orr);
          og.addColorStop(0, '#fffbe8'); og.addColorStop(0.45, '#ffd98a'); og.addColorStop(1, 'rgba(255,170,70,0)');
          ctx.fillStyle = og; ctx.beginPath(); ctx.arc(g.vx, g.vy, orr, 0, TAUV); ctx.fill();
          ctx.fillStyle = '#fffdf2'; ctx.beginPath(); ctx.arc(g.vx, g.vy, 0.11, 0, TAUV); ctx.fill();
          ctx.globalAlpha = 1;
        }

        g.parts.draw(ctx, 1);
        ctx.restore();

        // fog closing in on a loss, vignette always
        const vg = ctx.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.4, W / 2, H / 2, Math.hypot(W, H) * 0.56);
        vg.addColorStop(0, 'rgba(0,0,0,0)'); vg.addColorStop(1, 'rgba(2,5,12,0.6)');
        ctx.fillStyle = vg; ctx.fillRect(0, 0, W, H);
        if (g.over && !g.won) {
          ctx.fillStyle = `rgba(4,8,18,${0.4 * (1 - lightK)})`; ctx.fillRect(0, 0, W, H);
        }
        // floor transition fades + floor label
        let fadeA = 0;
        if (g.phase === 'zoom') fadeA = Math.pow(g.phT / 0.7, 1.6);
        else if (g.phase === 'fadein') fadeA = 1 - ease.outQuad(g.phT / 0.5);
        if (fadeA > 0.001) { ctx.fillStyle = `rgba(5,10,20,${fadeA})`; ctx.fillRect(0, 0, W, H); }
        if (g.phase === 'clear') { ctx.fillStyle = `rgba(150,255,240,${0.10 * g.flare})`; ctx.fillRect(0, 0, W, H); }
        {
          const la = g.phase === 'fadein' ? 1 : g.phase === 'play' ? clamp(1 - (t - (g.floorT || 0) - 2.5) / 1.5, 0.35, 1) : 0;
          if (la > 0 && !g.over) {
            ctx.globalAlpha = la * 0.8; ctx.fillStyle = '#e8c98a'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
            ctx.font = `600 ${Math.max(11, H * 0.022) | 0}px "IBM Plex Mono", monospace`;
            ctx.fillText(`FLOOR ${g.floor + 1} / ${FLOORS.length}`, W / 2, Math.max(14, g.by * 0.5 + py));
            ctx.globalAlpha = 1;
          }
        }
        if (g.won) {
          const k = clamp(g.endT / 0.8, 0, 1);
          ctx.fillStyle = `rgba(150,255,240,${0.12 * Math.sin(k * Math.PI)})`; ctx.fillRect(0, 0, W, H);
        }
      };

      g.draw = function (ctx, W, H) { const a = IP.alpha(), st = IP.push(ipg(), a); try { return drawRaw.call(g, ctx, W, H); } finally { IP.pop(st); } };
      g.style = style;
      g.hud = () => ({
        score: g.over && g.won ? 'All floors cleared' : `${Math.max(0, Math.ceil(TIME_LIMIT - g.clock))} s left`,
        detail: `Floor ${g.floor + 1}/${FLOORS.length} · ${g.steps} steps`,
      });
      g.result = () => g.won
        ? `Cleared all ${FLOORS.length} floors in ${g.clock.toFixed(0)} s, ${g.steps} steps (${style})`
        : `Lantern ran dry on floor ${g.floor + 1} of ${FLOORS.length} (${style})`;
      return g;
    },
  });
})();
