// runner.js — Canyon Runner (auto runner). Golden-hour desert canyon, courier fox.
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

  // ------------------------------------------------------------------ constants
  const DT = 1 / 60;
  const M2U = 32.4;                 // world units per metre
  const GOAL_M = 3000;
  const GOALX = GOAL_M * M2U;
  const V_START = 360, V_END = 720;
  const CAP_TIME = 360;

  const RW = 14;                    // runner half width (hitbox)
  const STAND_H = 68, SLIDE_H = 32;
  const SLIDE_TICKS = 36;           // 0.6 s
  const HOLD_MAX = 15;              // 0.25 s
  const JV = 700, G_LO = 1400, G_HI = 2800;
  const HAWK_VX = -90;

  const speedAt = x => V_START + (V_END - V_START) * clamp(x / GOALX, 0, 1);

  // ------------------------------------------------------------------ jump physics (shared by game + planner)
  // JUMP[H][k] = height of the runner k ticks after take-off if the jump button is held for H ticks.
  const JUMP = [];
  for (let H = 1; H <= HOLD_MAX; H++) {
    let y = 0, vy = JV; const arr = [];
    for (let k = 0; k < 200; k++) {
      const held = k < H && k * DT < 0.25;
      vy -= (held && vy > 0 ? G_LO : G_HI) * DT;
      y += vy * DT;
      if (y <= 0) break;
      arr.push(y);
    }
    JUMP[H] = arr;
  }

  // Collision predicate shared by game and planner. x0 = left edge of hazard relative to the runner's centre.
  function hit(h, x0, y, hgt) {
    const x1 = x0 + h.w;
    if (x0 >= RW || x1 <= -RW) return false;
    if (h.gap) return y <= 1 && x0 + 6 < 0 && x1 - 6 > 0;
    return y + hgt > h.y0 + 3 && y < h.y1 - 3;
  }

  // ------------------------------------------------------------------ planner (pure; used by the AI and by the course generator to validate spacing)
  // haz: [{rel, w, y0, y1, gap, vw}] positions relative to the runner (units), vw = world velocity.
  // acts: [{t:0 jump|1 slide, n: start tick, h: hold ticks}]
  let BIAS = 0.5, SLIDE_PREF = 0, COOL = 6, NOISE = 0.02;   // AI style knobs (set only while the AI plans; 0.5 / 0 = neutral)
  const ACTS = [];
  for (const h of [3, 5, 7, 9, 11, 13, 15]) ACTS.push({ t: 0, h });
  ACTS.push({ t: 1, h: 0 });
  const actDur = a => (a.t === 0 ? JUMP[a.h].length : SLIDE_TICKS);

  function firstHit(haz, v, acts, from, to) {
    for (let k = from; k <= to; k++) {
      let y = 0, hgt = STAND_H;
      for (let i = 0; i < acts.length; i++) {
        const a = acts[i], d = k - a.n;
        if (d < 0) continue;
        if (a.t === 0) { const arr = JUMP[a.h]; if (d < arr.length) y = arr[d]; }
        else if (d < SLIDE_TICKS) hgt = SLIDE_H;
      }
      const dk = k * DT;
      for (let i = 0; i < haz.length; i++) {
        const h = haz[i];
        if (hit(h, h.rel + (h.vw - v) * dk, y, hgt)) return k;
      }
    }
    return -1;
  }

  function spanHit(haz, v, a, n, dur) {
    const arr = a.t === 0 ? JUMP[a.h] : null;
    for (let k = n; k <= n + dur; k++) {
      const d = k - n;
      let y = 0, hgt = STAND_H;
      if (arr) { if (d < arr.length) y = arr[d]; } else if (d < SLIDE_TICKS) hgt = SLIDE_H;
      const dk = k * DT;
      for (let i = 0; i < haz.length; i++) {
        const h = haz[i];
        if (hit(h, h.rel + (h.vw - v) * dk, y, hgt)) return true;
      }
    }
    return false;
  }

  // Depth-first plan of up to `depth` actions that makes the whole timeline collision free.
  // Returns {acts, m} where m = worst timing margin (ticks, half window width) or null.
  function solve(haz, v, acts, e, depth, hz) {
    const kc = firstHit(haz, v, acts, 0, hz);
    if (kc < 0) return { acts, m: 99 };
    if (depth === 0) return null;
    const cands = [];
    for (let ci = 0; ci < ACTS.length; ci++) {
      const a = ACTS[ci], dur = actDur(a);
      const nlo = Math.max(e, kc - dur);
      let s = -1;
      for (let n = nlo; n <= kc + 1; n++) {
        const ok = n <= kc && !spanHit(haz, v, a, n, dur);
        if (ok) { if (s < 0) s = n; }
        else if (s >= 0) {
          const t = n - 1;
          cands.push({ a, dur, n: s + Math.round((t - s) * BIAS), m: (t - s) / 2 * (BIAS === 0.5 ? 1 : 1 - Math.abs(BIAS - 0.5) * 1.2) });
          s = -1;
        }
      }
    }
    if (!cands.length) return null;
    const score = c => Math.min(c.m, 5) - 0.04 * c.dur + (c.a.t === 1 ? SLIDE_PREF : 0) + Math.random() * NOISE;
    cands.sort((p, q) => score(q) - score(p));
    let best = null, bestSc = -1e9, tried = 0;
    const lim = depth >= 3 ? 12 : 99;
    for (const c of cands) {
      if (tried >= lim) break;
      tried++;
      const na = { t: c.a.t, h: c.a.h, n: c.n };
      const res = solve(haz, v, acts.concat([na]), Math.max(c.n + c.dur + 1, c.n + COOL), depth - 1, hz);
      if (!res) continue;
      const m = Math.min(c.m, res.m);
      const sc = Math.min(m, 5) - 0.04 * c.dur + (c.a.t === 1 ? SLIDE_PREF : 0) + Math.random() * NOISE;
      if (sc > bestSc) { bestSc = sc; best = { acts: res.acts, m }; }
    }
    return best;
  }

  // ------------------------------------------------------------------ scenery helpers
  function mulberry(seed) {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6D2B79F5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  const hash1 = n => { const s = Math.sin(n * 127.1 + 311.7) * 43758.5453; return s - Math.floor(s); };

  const LAYERS = [
    { par: 0.04, P: 2800, n: 7, hMin: 120, hMax: 230, wMin: 240, wMax: 420, col: '#8d779f', lit: '#b99bb4', haze: 0.5, strata: false },
    { par: 0.10, P: 2400, n: 8, hMin: 90, hMax: 200, wMin: 200, wMax: 360, col: '#c28650', lit: '#e8ad6c', haze: 0.34, strata: false },
    { par: 0.22, P: 2200, n: 8, hMin: 70, hMax: 160, wMin: 180, wMax: 330, col: '#a24f38', lit: '#cf7650', haze: 0.2, strata: true },
    { par: 0.42, P: 2000, n: 7, hMin: 38, hMax: 100, wMin: 170, wMax: 300, col: '#7a3424', lit: '#a5502f', haze: 0, strata: true },
  ];

  function makeLayer(rng, L) {
    const mesas = [];
    for (let i = 0; i < L.n; i++) {
      const w = L.wMin + rng() * (L.wMax - L.wMin);
      const h = L.hMin + rng() * (L.hMax - L.hMin);
      const nT = 1 + Math.floor(rng() * 3);
      const pts = [];                         // left side, bottom -> top, [dx(negative), height]
      let hb = w / 2, yPrev = 0;
      pts.push([-hb - 12 - rng() * 18, 0]);
      for (let t = 0; t < nT; t++) {
        const yTop = h * (t + 1) / nT * (0.92 + rng() * 0.16);
        const ht = hb * (0.9 + rng() * 0.07);
        pts.push([-hb, yPrev + (yTop - yPrev) * 0.12]);
        pts.push([-ht, yTop]);
        yPrev = yTop;
        hb = ht * (0.5 + rng() * 0.3);
        if (t < nT - 1) pts.push([-hb, yTop]);
      }
      mesas.push({ x: (i + rng() * 0.7) * (L.P / L.n), w, h: yPrev, pts, strata: [rng(), rng(), rng(), rng()] });
    }
    return mesas;
  }

  // ------------------------------------------------------------------ hazard prototypes & course generator
  const HAWK_Y0 = 34, HAWK_Y1 = 86;

  class Course {
    constructor() {
      this.list = [];
      this.lastEnd = 900;
      this.prevType = '';
      this.prevPrev = '';
      this.nextId = 1;
      this.lastTight = false;
    }

    proto(type, v, pg) {
      if (type === 'cactus') {
        const n = rnd.pick([1, 1, 1, 2, 2, 3]);
        const stems = []; let x = 0;
        const hMax = 68 + pg * 36;
        for (let i = 0; i < n; i++) {
          const sw = rnd.float(20, 27);
          stems.push({ dx: x, w: sw, h: rnd.float(50, hMax) * (i === 0 ? 1 : rnd.float(0.7, 1)), arm: rnd.float() < 0.55, side: rnd.pick([-1, 1]), flower: rnd.float() < 0.3 });
          x += sw + rnd.float(2, 9);
        }
        const w = x;
        return { type, w, y0: 0, y1: Math.max(...stems.map(s => s.h)), stems };
      }
      if (type === 'gap') {
        const w = rnd.float(95, 0.5 * v * 0.72 + 55);
        return { type, w, y0: 0, y1: 0, gap: true, seed: rnd.float(0, 100) };
      }
      if (type === 'arch') return { type, w: rnd.float(110, clamp(0.5 * v - 32, 130, 190)), y0: 52, y1: 420, seed: rnd.float(0, 100) };
      return { type: 'hawk', w: 50, y0: HAWK_Y0, y1: HAWK_Y1, vw: HAWK_VX, seed: rnd.float(0, 100) };
    }

    // Validate that a cluster ending in `cand` can be cleared with at least `mreq` ticks of timing margin.
    valid(cand, mreq) {
      const v = speedAt(cand.px);
      const group = [];
      for (let i = this.list.length - 1; i >= 0 && group.length < 2; i--) {
        const h = this.list[i];
        if (cand.px - h.px > v * 2.4) break;
        group.unshift(h);
      }
      group.push(cand);
      const xr = group[0].px - v * 1.1;
      const haz = group.map(h => {
        const d = h.px - xr;
        const mv = h.vw ? 1 + (-h.vw) / v : 1;
        return { rel: d * mv, w: h.w, y0: h.y0, y1: h.y1, gap: !!h.gap, vw: h.vw || 0 };
      });
      const res = solve(haz, v, [], 6, 3, 190);
      return res && res.m >= mreq;
    }

    pickType(pg) {
      const w = { cactus: 0.5, gap: 0.16 + pg * 0.04, arch: 0.17, hawk: 0.17 };
      if (this.prevType === this.prevPrev) w[this.prevType] = 0.02;
      w[this.prevType] *= 0.45;
      let r = Math.random() * Object.values(w).reduce((a, b) => a + b, 0);
      for (const k in w) { r -= w[k]; if (r <= 0) return k; }
      return 'cactus';
    }

    spawn(dist) {
      const pg = clamp(this.lastEnd / GOALX, 0, 1);
      const v = speedAt(this.lastEnd);
      const pTight = pg < 0.25 ? 0 : 0.006 + 0.02 * pg;
      const tight = !this.lastTight && Math.random() < pTight;
      let chosen = null;
      for (let attempt = 0; attempt < 6 && !chosen; attempt++) {
        const type = attempt < 4 ? this.pickType(pg) : 'cactus';
        const cand = this.proto(type, v, pg * (attempt < 4 ? 1 : 0.2));
        let T = tight ? 0.2 : lerp(1.45, 0.85, pg) + rnd.float(0, 0.5);
        const mreq = tight ? 0 : 2.5;
        for (let k = 0; k < 22; k++) {
          cand.px = this.lastEnd + Math.max(60, T * v);
          if (this.valid(cand, mreq)) { chosen = cand; break; }
          T += tight ? 0.04 : 0.09;
        }
      }
      if (!chosen) {
        chosen = this.proto('cactus', v, 0);
        chosen.px = this.lastEnd + 1.6 * v;
      }
      const h = chosen;
      h.id = this.nextId++;
      h.passed = false;
      h.tight = tight;
      h.x = h.px;
      if (h.type === 'hawk') {
        // starts further out and flies towards the runner, arriving at px together with it
        let T = 0, x = dist; const stepsN = 24, dx = (h.px - dist) / stepsN;
        if (dx > 0) for (let i = 0; i < stepsN; i++) { T += dx / speedAt(x + dx / 2); x += dx; }
        h.x = h.px - HAWK_VX * T;
      }
      this.lastTight = tight;
      this.prevPrev = this.prevType; this.prevType = h.type;
      this.lastEnd = h.px + h.w;
      this.list.push(h);
    }
  }

  // ------------------------------------------------------------------ the AI
  // What the AI can see (observe()): the scroll speed, the runner's own state, and for every obstacle currently
  // on screen: type, size and its position relative to the runner. It never sees obstacles beyond the right
  // screen edge, and it learns the world only through that snapshot delayed by its reaction time (80 ms ±15 ms
  // Gaussian, re-rolled per decision; the AI assumes a nominal 5 ticks, so the jitter becomes timing error
  // that grows with speed). It acts only through the jump button (hold) and the slide button.
  class RunnerAI {
    constructor(sup) {
      this.sup = !!sup;
      this.hist = [];
      this.acts = [];          // absolute ticks: {t,h,n(abs),started}
      this.heldUntil = 0;
      this.lastPress = -99;
      // Styles: Early jumper / Late jumper aim for the early / late part of the safe timing window,
      // Slider prefers sliding under things when both a slide and a jump would clear them.
      this.style = ['Early jumper', 'Late jumper', 'Slider'][Math.floor(Math.random() * 3)];
      this.bias = this.style === 'Early jumper' ? 0.3 : this.style === 'Late jumper' ? 0.7 : 0.5;
      this.slidePref = this.style === 'Slider' ? 1.5 : 0;
      // Super AI: no latency, no timing jitter, no hold noise, button re-press limit of 1 tick, no style bias
      if (sup) { this.style = 'Super AI'; this.bias = 0.5; this.slidePref = 0; }
    }

    think(obs, ctrl) {
      const cur = obs.tick + 1;
      this.hist.push(obs);
      if (this.hist.length > 12) this.hist.shift();
      // 80 ms reaction latency: it works from the picture of 5 ticks ago and schedules ahead to compensate;
      // what it cannot control is the +-15 ms jitter of its own button timing (applied per action below).
      const S = this.hist[Math.max(0, this.hist.length - 1 - (this.sup ? 0 : 5))];
      const base = S.tick;

      if (S.hazards.length) {
        const haz = S.hazards.map(h => ({ rel: h.rel, w: h.w, y0: h.y0, y1: h.y1, gap: h.type === 'gap', vw: h.type === 'hawk' ? HAWK_VX : 0 }));
        const v = S.speed;
        const rel = this.acts.map(a => ({ t: a.t, h: a.h, n: a.n - base }));
        const kc = firstHit(haz, v, rel, 0, 52);
        if (kc >= 0) {
          const fixed = rel.filter((a, i) => this.acts[i].started);
          const cool = this.sup ? 1 : 6;
          let e = cool;
          for (const a of fixed) e = Math.max(e, a.n + actDur(a) + 1, a.n + cool);
          BIAS = this.bias; SLIDE_PREF = this.slidePref; COOL = cool; NOISE = this.sup ? 0 : 0.02;
          let res = solve(haz, v, fixed, e, 3, 170);
          if (!res) res = solve(haz, v, fixed, e, 1, 170);
          BIAS = 0.5; SLIDE_PREF = 0; COOL = 6; NOISE = 0.02;
          if (res) {
            const kept = this.acts.filter(a => a.started);
            for (const a of res.acts) {
              if (fixed.some(f => f.n === a.n && f.t === a.t)) continue;
              kept.push({ t: a.t, h: a.t === 0 ? (this.sup ? a.h : clamp(a.h + Math.round(0.6 * rnd.gauss()), 3, HOLD_MAX)) : 0, n: a.n + base, jit: this.sup ? 0 : Math.round(0.9 * rnd.gauss()), started: false });
            }
            this.acts = kept;
          } else if (!this.acts.some(a => !a.started)) {
            // nothing works (should not happen): brace with the most useful reflex
            const b = haz.find(h => h.rel > -RW);
            const slideType = b && (b.y0 > 0 && !b.gap);
            this.acts.push({ t: slideType ? 1 : 0, h: 15, n: cur + 2, jit: 0, started: false });
          }
        }
      }

      // execute
      ctrl.slide = false;
      for (const a of this.acts) {
        if (a.started || a.n + (a.jit || 0) > cur) continue;
        const cd = this.sup ? 1 : 6;
        if (cur - this.lastPress < cd) { a.n = this.lastPress + cd - (a.jit || 0); continue; }
        a.started = true; a.n = cur; this.lastPress = cur;
        if (a.t === 0) this.heldUntil = cur + a.h; else ctrl.slide = true;
      }
      ctrl.jump = cur < this.heldUntil;
      this.acts = this.acts.filter(a => !(a.started && cur > a.n + 70));
    }
  }

  // ------------------------------------------------------------------ drawing helpers
  function pathMesa(ctx, m, cx, base) {
    const p = m.pts;
    ctx.beginPath();
    ctx.moveTo(cx + p[0][0], base - p[0][1]);
    for (let i = 1; i < p.length; i++) ctx.lineTo(cx + p[i][0], base - p[i][1]);
    for (let i = p.length - 1; i >= 0; i--) ctx.lineTo(cx - p[i][0], base - p[i][1]);
    ctx.closePath();
  }

  const CLOUD_SEEDS = [[0.1, 0.12, 300, 12], [0.4, 0.2, 380, 14], [0.7, 0.1, 260, 10], [0.9, 0.27, 340, 13], [0.25, 0.32, 220, 9]];

  // ------------------------------------------------------------------ the game
  class RunnerGame {
    constructor(opts = {}) {
      this.superAI = !!opts.superAI;
      this.over = false; this.won = false;
      this.tick = 0; this.time = 0; this.T = 0;
      this.dist = 0;
      this.runK = 1;
      this.v = V_START;
      this.y = 0; this.vy = 0; this.grounded = true; this.jumpK = 0; this.slideT = 0;
      this.ph = 0; this.air = 0; this.sl = 0;
      this.ctrl = { jump: false, slide: false };
      this.prevJump = false;
      this.cleared = 0; this.jumps = 0; this.slides = 0;
      this.course = new Course();
      this.ai = new RunnerAI(this.superAI); this.style = this.ai.style;
      this.fx = new Particles();
      this.puffs = [];
      this.lines = [];
      for (let i = 0; i < 16; i++) this.lines.push({ x: Math.random(), y: Math.random(), l: 0.05 + Math.random() * 0.1, s: 0.8 + Math.random() * 0.8 });
      this.weeds = [];
      this.weedT = 2;
      this.dead = null;
      this.endT = 0;
      this.ribbon = false;
      this.cause = '';
      this.shake = 0;
      this.footT = 0;
      this.flash = 0;
      this.sign = null;
      const rng = mulberry((Math.random() * 1e9) | 0);
      this.layers = LAYERS.map(L => makeLayer(rng, L));
      this.clouds = CLOUD_SEEDS.map(c => ({ fx: c[0], fy: c[1], w: c[2], h: c[3], sp: 4 + Math.random() * 6 }));
      this.stars = [];
      for (let i = 0; i < 40; i++) this.stars.push({ x: Math.random(), y: Math.random() * 0.4, p: Math.random() * 6 });
      this.resize(1600, 900);
      this.course.spawn(0);
      this.course.spawn(0);
    }

    resize(W, H) {
      this.W = W; this.H = H;
      this.s = Math.min(W / 900, H / 600);
      this.Wl = W / this.s; this.Hl = H / this.s;
      this.yG = Math.round(this.Hl * 0.72);
      this.rsx = this.Wl * 0.22;
    }

    // ---- what a human sees on screen right now (the AI's only window onto the world)
    observe() {
      const hz = [];
      for (const h of this.course.list) {
        const rel = h.x - this.dist;
        if (this.rsx + rel > this.Wl) continue;
        if (rel + h.w < -RW - 6) continue;
        hz.push({ id: h.id, type: h.type, rel, w: h.w, y0: h.y0, y1: h.y1 });
      }
      return { tick: this.tick, speed: this.v, hazards: hz, runner: { grounded: this.grounded, sliding: this.slideT > 0 } };
    }

    puff(x, y, n, o = {}) {
      for (let i = 0; i < n; i++) {
        this.puffs.push({
          x, y, vx: rnd.float(-1, 1) * (o.vx ?? 50) + (o.bx ?? 0), vy: -rnd.float(0.2, 1) * (o.vy ?? 45),
          r: rnd.float(0.6, 1) * (o.r ?? 7), g: o.g ?? 22, life: 0, max: rnd.float(0.5, 1) * (o.life ?? 0.6), a: o.a ?? 0.5,
        });
      }
    }

    _ipg() { return [[[this], ['dist', 'y'], 400], this.course ? [this.course.list.filter(h => h.vw), ['x'], 400] : [[], [], 0]]; }

    step(dt) {

      IP.snap(this._ipg());
      this.T += dt;
      const alive = !this.over;
      if (alive) {
        this.tick++; this.time += DT;
        if (this.time > CAP_TIME) { this.finish(false, 'Out of time'); }
      } else {
        this.endT += DT;
      }
      // speed
      if (this.over) {
        if (this.won) this.runK = Math.max(0, this.runK - DT / 2.2);
        else this.runK *= 0.935;
        if (this.runK < 0.004) this.runK = 0;
      }
      const vBase = speedAt(this.dist);
      this.v = vBase * this.runK;
      const v = this.v;

      if (alive) {
        const obs = this.observe();
        this.ai.think(obs, this.ctrl);
        this.runnerStep();
      } else if (this.dead) {
        this.deadStep();
      } else if (this.won) {
        this.winStep();
      }

      // world advance
      this.dist += v * DT;
      const hzs = this.course.list;
      for (const h of hzs) {
        if (h.vw) h.x += h.vw * DT * (this.over ? 0.5 : 1);
        if (!h.passed && h.x + h.w < this.dist - RW) { h.passed = true; this.cleared++; }
      }
      if (alive) this.checkCollisions();
      // generate / cull
      const c = this.course;
      while (c.lastEnd < this.dist + this.Wl + 1300 && c.lastEnd < GOALX - 80 * M2U) c.spawn(this.dist);
      while (hzs.length && hzs[0].x + hzs[0].w < this.dist - 500 && hzs[0].px + hzs[0].w < this.dist - 500) hzs.shift();

      // win
      if (alive && !this.over && this.dist >= GOALX) this.finish(true, '');

      // ambient
      this.ph += v * DT / 22;
      for (const p of this.puffs) {
        p.life += DT; p.x += (p.vx - v) * DT; p.y += p.vy * DT; p.vy += p.g * DT * 0.2; p.vx *= 0.97;
      }
      this.puffs = this.puffs.filter(p => p.life < p.max);
      this.fx.update(DT);
      for (const l of this.lines) { l.x -= (v / 720) * l.s * DT * 2.4; if (l.x < -0.2) { l.x += 1.3; l.y = Math.random(); } }
      for (const cl of this.clouds) { cl.fx -= (cl.sp + v * 0.01) * DT / this.Wl; if (cl.fx < -0.5) cl.fx += 1.8; }
      this.weedT -= DT;
      if (this.weedT < 0 && this.weeds.length < 3) {
        this.weedT = rnd.float(3, 8);
        this.weeds.push({ x: this.Wl + 60, y: this.yG + rnd.float(34, 110), r: rnd.float(14, 24), rot: 0, sp: rnd.float(60, 160), hop: rnd.float(0, 6) });
      }
      for (const w of this.weeds) { w.x -= (v * 1.1 + w.sp) * DT; w.rot -= ((v * 1.1 + w.sp) / w.r) * DT; w.hop += DT * 6; }
      this.weeds = this.weeds.filter(w => w.x > -80);
      if (this.shake > 0) this.shake = Math.max(0, this.shake - DT * 2.2);
      if (this.flash > 0) this.flash = Math.max(0, this.flash - DT * 2);
      // pose smoothing
      const airT = this.grounded ? 0 : 1;
      this.air += (airT - this.air) * Math.min(1, DT * 16);
      const slT = this.slideT > 0 ? 1 : 0;
      this.sl += (slT - this.sl) * Math.min(1, DT * 18);
    }

    runnerStep() {
      const c = this.ctrl;
      // input
      if (c.jump && !this.prevJump && this.grounded) {
        this.grounded = false; this.vy = JV; this.jumpK = 0; this.slideT = 0; this.jumps++;
        this.puff(this.rsx - 6, this.yG, 5, { vx: 30, bx: -40, vy: 30, r: 6, life: 0.45 });
      }
      this.prevJump = c.jump;
      if (c.slide && this.grounded && this.slideT <= 0) { this.slideT = SLIDE_TICKS + 1; this.slides++; }
      // physics
      if (!this.grounded) {
        const held = c.jump && this.jumpK * DT < 0.25;
        this.vy -= (held && this.vy > 0 ? G_LO : G_HI) * DT;
        this.y += this.vy * DT;
        this.jumpK++;
        if (this.y <= 0 && !this.overGap()) {
          this.y = 0; this.vy = 0; this.grounded = true;
          this.puff(this.rsx, this.yG, 9, { vx: 70, bx: -20, vy: 40, r: 9, life: 0.7 });
          this.landSq = 1;
        }
      } else {
        this.y = 0;
        if (this.overGapFoot()) { /* handled by collision */ }
      }
      if (this.slideT > 0) {
        this.slideT--;
        if (this.grounded && this.tick % 3 === 0) this.puff(this.rsx - 16, this.yG, 1, { vx: 20, bx: -60, vy: 20, r: 7, life: 0.5 });
      }
      // footfall dust
      if (this.grounded && this.slideT <= 0) {
        this.footT -= DT;
        if (this.footT <= 0) { this.footT = 0.22 - 0.1 * (this.v - 360) / 360; this.puff(this.rsx - 14, this.yG, 1, { vx: 20, bx: -30, vy: 22, r: 4, life: 0.4, a: 0.35 }); }
      }
      if (this.landSq > 0) this.landSq = Math.max(0, this.landSq - DT * 5);
    }

    overGap() {
      for (const h of this.course.list) {
        if (!h.gap) continue;
        const x0 = h.x - this.dist;
        if (x0 + 6 < 0 && x0 + h.w - 6 > 0) return true;
      }
      return false;
    }
    overGapFoot() { return this.overGap(); }

    checkCollisions() {
      const hgt = this.slideT > 0 ? SLIDE_H : STAND_H;
      for (const h of this.course.list) {
        const x0 = h.x - this.dist;
        if (x0 > RW + 5 || x0 + h.w < -RW - 5) continue;
        if (hit(h, x0, this.y, hgt)) { this.die(h); return; }
      }
    }

    die(h) {
      const names = { cactus: 'Clipped a cactus', gap: 'Fell into a gap', arch: 'Hit a rock arch', hawk: 'Caught by a hawk' };
      this.cause = names[h.type];
      this.finish(false, this.cause);
      const fall = h.type === 'gap';
      this.dead = { fall, dx: 0, dy: 0, vx: fall ? 0 : -150, vy: fall ? Math.min(this.vy, 0) : 420, rot: 0, rv: fall ? 2.5 : -9, h, t: 0 };
      this.shake = fall ? 0.5 : 1;
      if (!fall) {
        this.fx.burst(this.rsx + 14, this.yG - Math.max(30, this.y + 30), 22, { color: ['#ffd9a0', '#ff9a4a', '#fff2cf'], speed: 300, life: 0.8, size: 3.5, gravity: 600 });
        this.puff(this.rsx, this.yG, 10, { vx: 90, vy: 70, r: 12, life: 0.9 });
        if (h.type === 'hawk') h.x += 80;
      } else {
        this.puff(this.rsx, this.yG, 14, { vx: 80, vy: 50, r: 10, life: 0.9 });
      }
    }

    deadStep() {
      const d = this.dead; d.t += DT;
      if (d.fall) {
        d.vy -= 2400 * DT; d.dy += d.vy * DT; d.rot += d.rv * DT;
        d.dx -= this.v * DT * 0.0;
      } else {
        d.vy -= 1500 * DT; d.dy += d.vy * DT; d.dx += d.vx * DT; d.rot += d.rv * DT; d.vx *= 0.985;
        if (d.dy <= 0) {
          d.dy = 0;
          if (Math.abs(d.vy) > 120) { d.vy = -d.vy * 0.32; d.rv *= 0.55; this.puff(this.rsx + d.dx, this.yG, 5, { vx: 60, vy: 30, r: 8, life: 0.6 }); }
          else { d.vy = 0; d.rv *= 0.9; d.vx *= 0.9; }
        }
      }
    }

    winStep() {
      // victory hops once the runner has passed the finish line
      if (this.grounded && this.endT > 0.5 && this.winHops < 3 && this.runK < 0.55) {
        this.grounded = false; this.vy = 560; this.winHops++;
        this.fx.burst(this.rsx + 20, this.yG - 120, 26, { color: ['#ffd36b', '#ff7a3d', '#fff0c0', '#7fe0d0'], speed: 300, life: 1.2, size: 4, gravity: 400 });
      }
      if (!this.grounded) {
        this.vy -= 2200 * DT; this.y += this.vy * DT;
        if (this.y <= 0) { this.y = 0; this.vy = 0; this.grounded = true; this.puff(this.rsx, this.yG, 6, { vx: 60, vy: 30, r: 8, life: 0.6 }); }
      }
    }

    finish(won, why) {
      if (this.over) return;
      this.over = true; this.won = won; this.endT = 0; this.winHops = 0;
      this.ctrl.jump = false; this.ctrl.slide = false;
      if (won) {
        this.ribbon = true;
        this.cause = '';
        this.flash = 1;
        for (let i = 0; i < 4; i++) {
          this.fx.burst(this.rsx + 40 + i * 14, this.yG - 150 + i * 8, 28, { color: ['#ffd36b', '#ff7a3d', '#fff0c0', '#7fe0d0', '#ff8fa3'], speed: 380, life: 1.6, size: 4, gravity: 360 });
        }
      } else if (why) this.cause = why;
    }

    hud() {
      const m = Math.min(GOAL_M, Math.floor(this.dist / M2U));
      return { score: `${m} m`, detail: `${Math.round(this.v / M2U * 3.6)} km/h · ${this.cleared} cleared` };
    }

    result() {
      const m = Math.min(GOAL_M, Math.floor(this.dist / M2U));
      const mm = Math.floor(this.time / 60), ss = String(Math.floor(this.time % 60)).padStart(2, '0');
      if (this.won) return `Ran the full ${GOAL_M} m in ${mm}:${ss}, ${this.cleared} obstacles cleared (${this.style})`;
      return `${this.cause} at ${m} m after ${mm}:${ss} (${this.style})`;
    }

    // =================================================================== drawing
    draw(ctx, W, H) {
      const a = IP.alpha();
      const st = IP.push(this._ipg(), a);
      try { this._draw(ctx, W, H); } finally { IP.pop(st); }
    }
    _draw(ctx, W, H) {
      const s = this.s, Wl = this.Wl, Hl = this.Hl, yG = this.yG;
      ctx.save();
      ctx.scale(s, s);
      if (this.shake > 0) {
        const a = this.shake * this.shake * 7;
        ctx.translate(Math.sin(this.T * 90) * a, Math.cos(this.T * 77) * a * 0.7);
      }
      this.drawSky(ctx, Wl, Hl, yG);
      for (let i = 0; i < LAYERS.length; i++) {
        this.drawLayer(ctx, i, Wl, yG);
        if (i === 1) this.drawHeat(ctx, Wl, yG);
      }
      this.drawGround(ctx, Wl, Hl, yG);
      this.drawSigns(ctx, yG);
      this.drawHazards(ctx, Wl, Hl, yG);
      this.drawFinish(ctx, yG);
      this.drawRunner(ctx, yG);
      this.drawDust(ctx);
      this.drawForeground(ctx, Wl, Hl, yG);
      this.fx.draw(ctx, 1);
      this.drawSpeedLines(ctx, Wl, yG);
      // sun-glow overlay + vignette
      const vg = ctx.createRadialGradient(Wl * 0.5, Hl * 0.55, Hl * 0.45, Wl * 0.5, Hl * 0.55, Math.max(Wl, Hl) * 0.8);
      vg.addColorStop(0, 'rgba(20,6,20,0)'); vg.addColorStop(1, 'rgba(20,6,20,0.5)');
      ctx.fillStyle = vg; ctx.fillRect(-10, -10, Wl + 20, Hl + 20);
      if (this.flash > 0) { ctx.fillStyle = `rgba(255,236,190,${this.flash * 0.35})`; ctx.fillRect(-10, -10, Wl + 20, Hl + 20); }
      ctx.restore();
    }

    drawSky(ctx, Wl, Hl, yG) {
      const g = ctx.createLinearGradient(0, 0, 0, yG);
      g.addColorStop(0, '#1d1538'); g.addColorStop(0.3, '#4c2a58'); g.addColorStop(0.58, '#b3546a');
      g.addColorStop(0.82, '#f08a5e'); g.addColorStop(1, '#ffc880');
      ctx.fillStyle = g; ctx.fillRect(-10, -10, Wl + 20, yG + 20);
      // stars
      for (const st of this.stars) {
        const tw = 0.5 + 0.5 * Math.sin(this.T * 1.3 + st.p);
        ctx.fillStyle = `rgba(255,235,220,${0.12 + 0.25 * tw})`;
        ctx.fillRect(st.x * Wl, st.y * yG, 1.5, 1.5);
      }
      // sun
      const sx = Wl * 0.72, sy = yG - 78, r = 100;
      let g2 = ctx.createRadialGradient(sx, sy, r * 0.6, sx, sy, r * 4.2);
      g2.addColorStop(0, 'rgba(255,214,140,0.55)'); g2.addColorStop(0.35, 'rgba(255,150,90,0.22)'); g2.addColorStop(1, 'rgba(255,120,80,0)');
      ctx.fillStyle = g2; ctx.fillRect(sx - r * 4.2, sy - r * 4.2, r * 8.4, r * 8.4);
      const sg = ctx.createLinearGradient(0, sy - r, 0, sy + r);
      sg.addColorStop(0, '#fff6d2'); sg.addColorStop(0.55, '#ffd989'); sg.addColorStop(1, '#ffa05c');
      ctx.fillStyle = sg;
      const band = 3;
      for (let y = -r; y < r; y += band) {
        const frac = (y + r) / (2 * r);
        if (frac > 0.62 && Math.floor(y / band) % Math.max(2, Math.round(7 - (frac - 0.62) * 14)) === 0) continue; // retro cut bands
        const hw = Math.sqrt(Math.max(0, r * r - (y + band / 2) * (y + band / 2)));
        const off = Math.sin(this.T * 1.7 + y * 0.12) * 2.2 * (0.4 + frac);
        ctx.fillRect(sx - hw + off, sy + y, hw * 2, band + 0.5);
      }
      // clouds
      for (const c of this.clouds) {
        const cx = c.fx * Wl, cy = c.fy * yG;
        const cg = ctx.createLinearGradient(0, cy - c.h, 0, cy + c.h);
        cg.addColorStop(0, 'rgba(255,196,170,0)'); cg.addColorStop(0.5, 'rgba(255,190,160,0.28)'); cg.addColorStop(1, 'rgba(255,196,170,0)');
        ctx.fillStyle = cg;
        ctx.beginPath(); ctx.ellipse(cx, cy, c.w / 2, c.h, 0, 0, TAU); ctx.fill();
        ctx.beginPath(); ctx.ellipse(cx + c.w * 0.22, cy - c.h * 0.5, c.w * 0.28, c.h * 0.6, 0, 0, TAU); ctx.fill();
      }
    }

    drawHeat(ctx, Wl, yG) {
      // wobbling heat-haze streaks above the horizon
      ctx.save();
      ctx.lineWidth = 1.5;
      for (let i = 0; i < 4; i++) {
        const y = yG - 20 - i * 17;
        ctx.strokeStyle = `rgba(255,224,170,${0.1 - i * 0.015})`;
        ctx.beginPath();
        for (let x = -10; x <= Wl + 10; x += 16) {
          const yy = y + Math.sin(x * 0.03 + this.T * (1.4 + i * 0.3) + i * 2) * (2 + i);
          if (x === -10) ctx.moveTo(x, yy); else ctx.lineTo(x, yy);
        }
        ctx.stroke();
      }
      ctx.restore();
    }

    drawLayer(ctx, li, Wl, yG) {
      const L = LAYERS[li], mesas = this.layers[li];
      const off = this.dist * L.par;
      const t0 = Math.floor((off - 450) / L.P);
      const base = yG + 2;
      for (let t = t0; t * L.P - off < Wl + 450; t++) {
        for (const m of mesas) {
          const cx = t * L.P + m.x - off;
          if (cx + m.w < -80 || cx - m.w > Wl + 80) continue;
          pathMesa(ctx, m, cx, base);
          const g = ctx.createLinearGradient(cx - m.w / 2, 0, cx + m.w / 2, 0);
          g.addColorStop(0, L.col); g.addColorStop(0.55, L.col); g.addColorStop(1, L.lit);
          ctx.fillStyle = g; ctx.fill();
          if (L.strata) {
            ctx.save(); ctx.clip();
            ctx.strokeStyle = 'rgba(30,8,10,0.16)'; ctx.lineWidth = 1.5;
            for (let k = 0; k < 4; k++) {
              const yy = base - m.h * (0.18 + 0.2 * k + m.strata[k] * 0.1);
              ctx.beginPath(); ctx.moveTo(cx - m.w, yy); ctx.lineTo(cx + m.w, yy); ctx.stroke();
            }
            ctx.fillStyle = 'rgba(255,190,120,0.1)';
            ctx.fillRect(cx + m.w * 0.22, base - m.h - 4, m.w * 0.4, m.h + 4);
            ctx.restore();
          }
        }
      }
      if (L.haze > 0) {
        const hg = ctx.createLinearGradient(0, yG - 240, 0, yG + 2);
        hg.addColorStop(0, 'rgba(255,170,130,0)'); hg.addColorStop(1, `rgba(255,178,128,${L.haze})`);
        ctx.fillStyle = hg; ctx.fillRect(-10, yG - 240, Wl + 20, 242);
      }
    }

    drawGround(ctx, Wl, Hl, yG) {
      const g = ctx.createLinearGradient(0, yG, 0, Hl);
      g.addColorStop(0, '#b8774a'); g.addColorStop(0.18, '#8f4d30'); g.addColorStop(0.6, '#5b2a1d'); g.addColorStop(1, '#341710');
      ctx.fillStyle = g; ctx.fillRect(-10, yG, Wl + 20, Hl - yG + 10);
      // moving strata, nearer rows scroll faster
      const rows = 5;
      for (let r = 0; r < rows; r++) {
        const y = yG + 8 + r * r * 5.5 + r * 9;
        const sp = 1 + r * 0.38;
        const cell = 120 + r * 30;
        const off = this.dist * sp;
        const c0 = Math.floor(off / cell);
        ctx.fillStyle = r % 2 ? 'rgba(40,14,8,0.28)' : 'rgba(255,200,140,0.1)';
        for (let c = c0; c * cell - off < Wl + cell; c++) {
          const hv = hash1(c * 7.3 + r * 31.7);
          if (hv < 0.3) continue;
          const len = 30 + hv * 70 + r * 12;
          ctx.fillRect(c * cell - off + hv * 40, y, len, 1.5 + r * 0.45);
        }
      }
      // pebbles
      const pOff = this.dist * 1.0;
      for (let c = Math.floor(pOff / 90); c * 90 - pOff < Wl + 90; c++) {
        const hv = hash1(c * 3.1 + 9.2);
        if (hv < 0.45) continue;
        const px = c * 90 - pOff + hv * 70, py = yG + 18 + hash1(c * 5.7) * 44, pr = 2 + hv * 4;
        ctx.fillStyle = 'rgba(60,24,14,0.5)';
        ctx.beginPath(); ctx.ellipse(px, py, pr * 1.5, pr * 0.8, 0, 0, TAU); ctx.fill();
        ctx.fillStyle = 'rgba(255,205,150,0.18)';
        ctx.beginPath(); ctx.ellipse(px - 0.5, py - 1, pr * 1.2, pr * 0.5, 0, 0, TAU); ctx.fill();
      }
      // gaps (chasms) cut into the ground
      for (const h of this.course.list) {
        if (!h.gap) continue;
        const sx = this.rsx + (h.x - this.dist);
        if (sx > Wl + 20 || sx + h.w < -20) continue;
        this.drawChasm(ctx, sx, h.w, yG, Hl, h.seed);
      }
      // lit lip on top of the ground
      ctx.fillStyle = '#f0c488'; ctx.fillRect(-10, yG - 1, Wl + 20, 3);
      ctx.fillStyle = 'rgba(255,230,180,0.35)'; ctx.fillRect(-10, yG + 2, Wl + 20, 2);
    }

    drawChasm(ctx, sx, w, yG, Hl, seed) {
      // erase ground in the gap with the sky/haze behind, then dark chasm
      const g = ctx.createLinearGradient(0, yG, 0, Hl);
      g.addColorStop(0, '#2a0f14'); g.addColorStop(0.5, '#150610'); g.addColorStop(1, '#07030a');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.moveTo(sx - 3, yG - 2);
      const n = 6;
      for (let i = 0; i <= n; i++) ctx.lineTo(sx + 2 + hash1(seed + i) * 6 - (i / n) * 0, yG + 20 + (i / n) * (Hl - yG));
      ctx.lineTo(sx + w - 2, Hl);
      for (let i = n; i >= 0; i--) ctx.lineTo(sx + w - 2 - hash1(seed + i + 9) * 6, yG + 20 + (i / n) * (Hl - yG));
      ctx.lineTo(sx + w + 3, yG - 2);
      ctx.closePath(); ctx.fill();
      ctx.fillRect(sx, yG - 2, w, Hl - yG + 4);
      // far wall glow (reddish) and rock layers
      const wg = ctx.createLinearGradient(sx, 0, sx + w, 0);
      wg.addColorStop(0, 'rgba(160,70,40,0.55)'); wg.addColorStop(0.18, 'rgba(120,50,36,0.15)'); wg.addColorStop(1, 'rgba(90,30,30,0)');
      ctx.fillStyle = wg; ctx.fillRect(sx, yG, w, Hl - yG);
      ctx.strokeStyle = 'rgba(210,120,80,0.22)'; ctx.lineWidth = 1.5;
      for (let i = 1; i < 6; i++) {
        const yy = yG + 8 + i * i * 4;
        ctx.beginPath(); ctx.moveTo(sx + 1, yy); ctx.lineTo(sx + w * 0.4, yy + 2); ctx.stroke();
      }
      // lip highlights
      ctx.fillStyle = '#e8b57c'; ctx.fillRect(sx - 3, yG - 1, 5, 4);
      ctx.fillStyle = '#c98d58'; ctx.fillRect(sx + w - 2, yG - 1, 5, 4);
      // rising mist
      const mg = ctx.createLinearGradient(0, yG, 0, yG - 28);
      mg.addColorStop(0, 'rgba(255,170,120,0.22)'); mg.addColorStop(1, 'rgba(255,170,120,0)');
      ctx.fillStyle = mg; ctx.fillRect(sx, yG - 28, w, 28);
    }

    drawSigns(ctx, yG) {
      const k0 = Math.max(1, Math.floor((this.dist - 400) / (250 * M2U)) + 1);
      for (let k = k0; k < 12; k++) {
        const wx = k * 250 * M2U;
        const sx = this.rsx + (wx - this.dist);
        if (sx < -80) continue;
        if (sx > this.Wl + 80) break;
        const y = yG - 2;
        ctx.fillStyle = '#4d2616'; ctx.fillRect(sx - 3, y - 52, 6, 52);
        ctx.fillStyle = 'rgba(0,0,0,0.25)'; ctx.beginPath(); ctx.ellipse(sx + 6, y + 1, 16, 3, 0, 0, TAU); ctx.fill();
        roundRect(ctx, sx - 34, y - 78, 68, 30, 5); ctx.fillStyle = '#e1b27a'; ctx.fill();
        ctx.strokeStyle = '#5a2c18'; ctx.lineWidth = 2; ctx.stroke();
        ctx.fillStyle = '#4a2012'; ctx.font = '600 17px Fredoka, "Trebuchet MS", sans-serif';
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText(`${k * 250} m`, sx, y - 62);
      }
    }

    drawFinish(ctx, yG) {
      const sx = this.rsx + (GOALX - this.dist);
      if (sx < -200 || sx > this.Wl + 200) return;
      const a = sx - 70, b = sx + 70;
      // posts
      for (const px of [a, b]) {
        ctx.fillStyle = '#3d1c12'; ctx.fillRect(px - 5, yG - 190, 10, 192);
        ctx.fillStyle = '#e8b86c'; ctx.fillRect(px - 5, yG - 190, 3, 192);
      }
      // checker banner
      const bw = b - a, by = yG - 200, bh = 34;
      ctx.save();
      roundRect(ctx, a - 10, by, bw + 20, bh, 6); ctx.clip();
      const cs = 11;
      for (let i = 0; i * cs < bw + 20; i++) for (let j = 0; j * cs < bh; j++) {
        ctx.fillStyle = (i + j) % 2 ? '#fdf2dc' : '#2c1510';
        ctx.fillRect(a - 10 + i * cs, by + j * cs, cs, cs);
      }
      ctx.restore();
      ctx.strokeStyle = '#3d1c12'; ctx.lineWidth = 2; roundRect(ctx, a - 10, by, bw + 20, bh, 6); ctx.stroke();
      // ribbon
      ctx.strokeStyle = '#ff5a4a'; ctx.lineWidth = 3;
      ctx.beginPath();
      if (!this.ribbon) { ctx.moveTo(a, yG - 46); ctx.quadraticCurveTo(a + 20, yG - 40 + Math.sin(this.T * 6) * 3, a + 38, yG - 22); ctx.moveTo(b, yG - 46); ctx.quadraticCurveTo(b - 20, yG - 40 + Math.sin(this.T * 6 + 1) * 3, b - 38, yG - 22); }
      else { ctx.moveTo(a, yG - 46); ctx.lineTo(b, yG - 46); }
      ctx.stroke();
      if (this.ribbon && this.dist >= GOALX) this.ribbon = false;
    }

    drawHazards(ctx, Wl, Hl, yG) {
      for (const h of this.course.list) {
        const sx = this.rsx + (h.x - this.dist);
        if (sx > Wl + 100 || sx + h.w < -100) continue;
        if (h.type === 'cactus') this.drawCactus(ctx, h, sx, yG);
        else if (h.type === 'arch') this.drawArch(ctx, h, sx, yG);
        else if (h.type === 'hawk') this.drawHawk(ctx, h, sx, yG);
      }
    }

    drawCactus(ctx, h, sx, yG) {
      ctx.fillStyle = 'rgba(0,0,0,0.25)';
      ctx.beginPath(); ctx.ellipse(sx + h.w / 2 + 8, yG + 3, h.w / 2 + 12, 4, 0, 0, TAU); ctx.fill();
      for (const st of h.stems) {
        const x = sx + st.dx, w = st.w, top = yG - st.h;
        const draw = (inset, c0, c1) => {
          const g = ctx.createLinearGradient(x, 0, x + w, 0);
          g.addColorStop(0, c0); g.addColorStop(1, c1);
          ctx.fillStyle = g;
          roundRect(ctx, x + inset, top + inset, w - inset * 2, st.h - inset, (w - inset * 2) / 2); ctx.fill();
        };
        // arm
        if (st.arm && st.h > 52) {
          const ay = yG - st.h * 0.52, ax = x + (st.side > 0 ? w : 0), len = 15 + (st.h % 7), ah = 18 + (st.h % 9);
          ctx.lineCap = 'round'; ctx.lineJoin = 'round';
          ctx.strokeStyle = '#2d4a29'; ctx.lineWidth = 12;
          ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(ax + st.side * len, ay); ctx.lineTo(ax + st.side * len, ay - ah); ctx.stroke();
          ctx.strokeStyle = '#5b8f3f'; ctx.lineWidth = 9;
          ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(ax + st.side * len, ay); ctx.lineTo(ax + st.side * len, ay - ah); ctx.stroke();
          ctx.strokeStyle = 'rgba(240,226,130,0.45)'; ctx.lineWidth = 2;
          ctx.beginPath(); ctx.moveTo(ax + st.side * len + 3, ay - 2); ctx.lineTo(ax + st.side * len + 3, ay - ah); ctx.stroke();
        }
        draw(-1.5, '#27431f', '#27431f');
        draw(0, '#3c6a2e', '#74a54b');
        ctx.strokeStyle = 'rgba(20,50,20,0.35)'; ctx.lineWidth = 1.2;
        for (const f of [0.33, 0.66]) { ctx.beginPath(); ctx.moveTo(x + w * f, top + w / 2); ctx.lineTo(x + w * f, yG - 2); ctx.stroke(); }
        ctx.strokeStyle = 'rgba(246,230,140,0.55)'; ctx.lineWidth = 1.8;
        ctx.beginPath(); ctx.moveTo(x + w - 2.5, top + w / 2); ctx.lineTo(x + w - 2.5, yG - 3); ctx.stroke();
        if (st.flower) { ctx.fillStyle = '#ff7aa2'; ctx.beginPath(); ctx.arc(x + w / 2, top + 1, 4, 0, TAU); ctx.fill(); ctx.fillStyle = '#ffe28a'; ctx.beginPath(); ctx.arc(x + w / 2, top + 1, 1.6, 0, TAU); ctx.fill(); }
      }
    }

    drawArch(ctx, h, sx, yG) {
      const w = h.w, x = sx;
      // pillars sit behind the lane
      for (const px of [x - 4, x + w - 34]) {
        const g = ctx.createLinearGradient(px, 0, px + 38, 0);
        g.addColorStop(0, '#5e2a22'); g.addColorStop(1, '#8d4a35');
        ctx.fillStyle = g;
        ctx.beginPath(); ctx.moveTo(px - 6, yG - 10); ctx.lineTo(px + 4, yG - 150); ctx.lineTo(px + 34, yG - 150); ctx.lineTo(px + 44, yG - 10); ctx.closePath(); ctx.fill();
      }
      ctx.fillStyle = 'rgba(0,0,0,0.22)'; ctx.fillRect(x, yG + 1, w, 4);
      // inner dark opening glow
      const og = ctx.createLinearGradient(0, yG - 52, 0, yG);
      og.addColorStop(0, 'rgba(255,170,100,0.0)'); og.addColorStop(1, 'rgba(255,190,120,0.1)');
      ctx.fillStyle = og; ctx.fillRect(x + 20, yG - 52, w - 40, 52);
      // slab
      const top = yG - 164, bot = yG - 52;
      const g = ctx.createLinearGradient(x, 0, x + w, 0);
      g.addColorStop(0, '#7e3828'); g.addColorStop(0.6, '#b25b3c'); g.addColorStop(1, '#dd8a54');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.moveTo(x - 8, bot);
      ctx.lineTo(x - 4, top + 34);
      const n = 7;
      for (let i = 0; i <= n; i++) ctx.lineTo(x - 4 + (w + 8) * i / n, top + 12 * Math.sin(h.seed + i * 1.7) + (i === 0 || i === n ? 18 : 0));
      ctx.lineTo(x + w + 4, top + 34);
      ctx.lineTo(x + w + 8, bot);
      // underside slightly arched
      ctx.quadraticCurveTo(x + w * 0.5, bot - 22, x - 8, bot);
      ctx.closePath(); ctx.fill();
      ctx.strokeStyle = 'rgba(40,10,10,0.5)'; ctx.lineWidth = 2; ctx.stroke();
      ctx.strokeStyle = 'rgba(40,10,10,0.18)'; ctx.lineWidth = 1.5;
      for (let i = 1; i < 4; i++) { const yy = top + 20 + i * 20; ctx.beginPath(); ctx.moveTo(x, yy); ctx.lineTo(x + w, yy + 3); ctx.stroke(); }
      ctx.fillStyle = 'rgba(255,214,150,0.4)'; ctx.fillRect(x + w * 0.55, top + 4, w * 0.4, 3);
    }

    drawHawk(ctx, h, sx, yG) {
      const cy = yG - (h.y0 + h.y1) / 2 + Math.sin(this.T * 4 + h.seed) * 2;
      const cx = sx + h.w / 2;
      ctx.fillStyle = 'rgba(0,0,0,0.18)';
      ctx.beginPath(); ctx.ellipse(cx, yG + 3, 26, 3.5, 0, 0, TAU); ctx.fill();
      const flap = Math.sin(this.T * 11 + h.seed * 3);
      ctx.save(); ctx.translate(cx, cy);
      // far wing
      ctx.fillStyle = '#4a2a1c';
      ctx.beginPath(); ctx.moveTo(-4, -4); ctx.quadraticCurveTo(4, -34 * (0.6 + 0.4 * flap) - 6, 22, -38 * flap - 4); ctx.quadraticCurveTo(10, -10, 8, 0); ctx.closePath(); ctx.fill();
      // tail
      ctx.fillStyle = '#6b3b22';
      ctx.beginPath(); ctx.moveTo(14, -2); ctx.lineTo(34, -8); ctx.lineTo(36, 2); ctx.lineTo(14, 6); ctx.closePath(); ctx.fill();
      ctx.fillStyle = '#f0dcb4'; ctx.fillRect(30, -7, 5, 9);
      // body
      const bg = ctx.createLinearGradient(0, -14, 0, 14);
      bg.addColorStop(0, '#4b2a1a'); bg.addColorStop(0.55, '#7c4a2a'); bg.addColorStop(1, '#f2d9ab');
      ctx.fillStyle = bg;
      ctx.beginPath(); ctx.ellipse(2, 0, 20, 11, -0.05, 0, TAU); ctx.fill();
      ctx.strokeStyle = 'rgba(30,10,5,0.55)'; ctx.lineWidth = 1.4; ctx.stroke();
      // head
      ctx.fillStyle = '#5a3320';
      ctx.beginPath(); ctx.arc(-17, -3, 8.5, 0, TAU); ctx.fill();
      ctx.fillStyle = '#f2d9ab'; ctx.beginPath(); ctx.arc(-18, 0, 5, 0, Math.PI); ctx.fill();
      ctx.fillStyle = '#ffcf4a';
      ctx.beginPath(); ctx.moveTo(-24, -4); ctx.quadraticCurveTo(-34, -2, -30, 6); ctx.quadraticCurveTo(-27, 1, -22, 1); ctx.closePath(); ctx.fill();
      ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(-20, -5, 2.4, 0, TAU); ctx.fill();
      ctx.fillStyle = '#1b0c06'; ctx.beginPath(); ctx.arc(-20.6, -5, 1.2, 0, TAU); ctx.fill();
      ctx.strokeStyle = '#2b140a'; ctx.lineWidth = 1.6; ctx.beginPath(); ctx.moveTo(-24, -8); ctx.lineTo(-17, -6); ctx.stroke();
      // near wing
      const wg = ctx.createLinearGradient(0, -40, 0, 8);
      wg.addColorStop(0, '#3a2012'); wg.addColorStop(1, '#8a5632');
      ctx.fillStyle = wg;
      ctx.beginPath(); ctx.moveTo(-8, -2); ctx.quadraticCurveTo(0, 38 * (0.5 + 0.5 * flap) * (flap > 0 ? -1 : 1) - 6, 24, 38 * flap * -1 + 2); ctx.quadraticCurveTo(10, 4, 12, 2); ctx.closePath(); ctx.fill();
      ctx.strokeStyle = 'rgba(240,215,170,0.55)'; ctx.lineWidth = 1.2; ctx.stroke();
      ctx.restore();
    }

    // ---- runner (courier fox)
    drawRunner(ctx, yG) {
      const d = this.dead;
      let x = this.rsx, y = yG - this.y, rot = 0, sl = this.sl, ar = this.air;
      let clip = false;
      if (d) {
        x += d.dx; y = yG - d.dy; rot = d.rot; sl = 0; ar = 1;
        if (d.fall) {
          clip = true;
          const h = d.h; const gx = this.rsx + (h.x - this.dist);
          ctx.save();
          ctx.beginPath(); ctx.rect(-50, -50, this.Wl + 100, yG + 50); ctx.rect(gx, yG, h.w, this.Hl - yG + 20); ctx.clip();
          y = yG - d.dy;
        }
      } else if (this.won && this.over) {
        ar = this.grounded ? 0 : 1;
      }
      // shadow
      if (!d || !d.fall) {
        const sh = clamp(1 - (this.y || 0) / 220, 0.3, 1);
        ctx.fillStyle = `rgba(20,6,6,${0.3 * sh})`;
        ctx.beginPath(); ctx.ellipse(x - 2, yG + 3, 28 * sh * (1 + sl * 0.4), 4.5 * sh, 0, 0, TAU); ctx.fill();
      }
      const land = this.landSq || 0;
      const sq = 1 - land * 0.1;
      const stride = this.runK > 0.02 || !this.over ? this.ph : this.ph;
      const idle = this.over && !this.dead && this.runK < 0.3;
      this.drawFox(ctx, x, y, { ph: idle ? 0 : stride, sl, ar, rot, vy: d ? 0 : this.vy, t: this.T, sq, dead: !!d, idle });
      if (clip) ctx.restore();
    }

    drawFox(ctx, x, y, f) {
      const { ph, sl, ar, t } = f;
      ctx.save();
      ctx.translate(x, y);
      if (f.rot) { ctx.translate(0, -34); ctx.rotate(f.rot); ctx.translate(0, 34); }
      ctx.scale(1, f.sq || 1);
      const OUT = 'rgba(40,14,8,0.6)';
      const bob = f.idle ? Math.sin(t * 3) * 0.8 : (1 - ar) * (1 - sl) * -Math.abs(Math.sin(ph)) * 3.2;
      const by = lerp(-35, -17, sl) + bob;
      const tilt = clamp(-f.vy * 0.0006, -0.4, 0.35) * ar;
      const hipX = -15, shX = 14;
      ctx.translate(0, by); ctx.rotate(tilt - sl * 0.04); ctx.translate(0, -by);

      const leg = (rx, p, far) => {
        const side = rx > 0 ? 1 : -1;
        const sw = Math.sin(p), lf = Math.max(0, Math.cos(p));
        let fx = rx + sw * 17, fy = -lf * 11;
        const airX = rx + side * 15, airY = by + (side > 0 ? 8 : 16) + (far ? 3 : 0);
        fx = lerp(fx, airX, ar); fy = lerp(fy, airY, ar);
        const slX = rx + (side > 0 ? 26 : 12) + (far ? 4 : 0), slY = -2;
        fx = lerp(fx, slX, sl); fy = lerp(fy, slY, sl);
        const ry = by + 5;
        const dx = fx - rx, dy = fy - ry, dd = Math.min(Math.hypot(dx, dy), 37.5);
        const ux = dx / (Math.hypot(dx, dy) || 1), uy = dy / (Math.hypot(dx, dy) || 1);
        const hgt = Math.sqrt(Math.max(0, 19 * 19 - (dd / 2) * (dd / 2)));
        let px = -uy, py = ux; if (px * -side < 0) { px = -px; py = -py; }   // front knees bend back, hind knees forward
        if (side < 0) { px = -px; py = -py; }
        const mx = rx + ux * dd / 2 + px * hgt, my = ry + uy * dd / 2 + py * hgt;
        ctx.lineCap = 'round'; ctx.lineJoin = 'round';
        ctx.strokeStyle = far ? '#5a2b17' : '#e5611f'; ctx.lineWidth = far ? 7 : 9;
        ctx.beginPath(); ctx.moveTo(rx, ry); ctx.lineTo(mx, my); ctx.stroke();
        ctx.strokeStyle = far ? '#2d140b' : '#3b1a0e'; ctx.lineWidth = far ? 5.5 : 6.5;
        ctx.beginPath(); ctx.moveTo(mx, my); ctx.lineTo(fx, fy); ctx.stroke();
        ctx.fillStyle = '#26110a'; ctx.beginPath(); ctx.arc(fx + 1.5, fy, 3.4, 0, TAU); ctx.fill();
      };
      const fast = f.idle ? 0 : 1;
      // far legs
      leg(hipX + 4, ph + Math.PI * 0.9, true);
      leg(shX - 3, ph + 0.5 + Math.PI * 0.9, true);

      // tail
      const wave = Math.sin(t * 7 + ph) * 4 * fast + Math.sin(t * 2) * 1.5;
      const tl = lerp(1, 0.9, sl);
      const tx0 = hipX - 6, ty0 = by - 3;
      const tx1 = tx0 - 22 * tl, ty1 = ty0 - 10 + wave - ar * 6 + sl * 8;
      const tx2 = tx0 - 46 * tl, ty2 = ty0 - 11 - wave * 1.4 - ar * 8 + sl * 8 + (f.idle ? -10 : 0);
      ctx.lineCap = 'round';
      ctx.strokeStyle = OUT; ctx.lineWidth = 15;
      ctx.beginPath(); ctx.moveTo(tx0, ty0); ctx.quadraticCurveTo(tx1, ty1, tx2, ty2); ctx.stroke();
      ctx.strokeStyle = '#ee6a22'; ctx.lineWidth = 12.5;
      ctx.beginPath(); ctx.moveTo(tx0, ty0); ctx.quadraticCurveTo(tx1, ty1, tx2, ty2); ctx.stroke();
      ctx.strokeStyle = '#fff3dc'; ctx.lineWidth = 11;
      ctx.beginPath(); ctx.moveTo(tx2 + 7 * tl, ty2 + (ty1 - ty2) * 0.18); ctx.lineTo(tx2, ty2); ctx.stroke();

      // body
      const bg = ctx.createLinearGradient(0, by - 13, 0, by + 12);
      bg.addColorStop(0, '#ff8a3a'); bg.addColorStop(0.55, '#ea6420'); bg.addColorStop(1, '#fbe3bf');
      ctx.fillStyle = bg;
      ctx.beginPath();
      ctx.moveTo(hipX, by - 11);
      ctx.quadraticCurveTo(0, by - 15, shX, by - 11);
      ctx.quadraticCurveTo(shX + 12, by - 6, shX + 9, by + 5);
      ctx.quadraticCurveTo(0, by + 14, hipX - 2, by + 8);
      ctx.quadraticCurveTo(hipX - 12, by, hipX, by - 11);
      ctx.fill();
      ctx.strokeStyle = OUT; ctx.lineWidth = 1.6; ctx.stroke();
      // satchel + strap
      ctx.strokeStyle = '#7a4a24'; ctx.lineWidth = 3;
      ctx.beginPath(); ctx.moveTo(shX - 5, by - 12); ctx.lineTo(hipX + 3, by + 7); ctx.stroke();
      roundRect(ctx, hipX - 4, by + 1, 17, 12, 3.5); ctx.fillStyle = '#2f9a8e'; ctx.fill();
      ctx.strokeStyle = '#13564f'; ctx.lineWidth = 1.5; ctx.stroke();
      ctx.fillStyle = '#ffe08a'; ctx.beginPath(); ctx.arc(hipX + 4.5, by + 7, 1.6, 0, TAU); ctx.fill();

      // scarf streamer
      const sx0 = shX + 1, sy0 = by - 9;
      const sw1 = Math.sin(t * 12 + ph * 1.5) * 3 * fast;
      ctx.strokeStyle = '#e8443a'; ctx.lineWidth = 5;
      ctx.beginPath(); ctx.moveTo(sx0, sy0); ctx.quadraticCurveTo(sx0 - 14, sy0 - 3 + sw1, sx0 - 28 + sl * 4, sy0 + 1 - sw1 - ar * 6 + sl * 5); ctx.stroke();
      ctx.strokeStyle = '#ffb199'; ctx.lineWidth = 1.4;
      ctx.beginPath(); ctx.moveTo(sx0 - 3, sy0 - 1); ctx.quadraticCurveTo(sx0 - 14, sy0 - 4 + sw1, sx0 - 26 + sl * 4, sy0 - 0.5 - sw1 - ar * 6 + sl * 5); ctx.stroke();

      // near legs
      leg(hipX + 2, ph, false);
      leg(shX - 1, ph + 0.5, false);

      // head
      const hx = shX + 12 + sl * 5, hy = by - 12 + sl * 5 - ar * 1.5 + bob * 0.4;
      ctx.fillStyle = '#ee6a22';
      // ears
      ctx.beginPath(); ctx.moveTo(hx - 8, hy - 5); ctx.lineTo(hx - 7, hy - 20); ctx.lineTo(hx + 1, hy - 8); ctx.closePath(); ctx.fill();
      ctx.beginPath(); ctx.moveTo(hx - 1, hy - 8); ctx.lineTo(hx + 4, hy - 21); ctx.lineTo(hx + 8, hy - 5); ctx.closePath(); ctx.fill();
      ctx.strokeStyle = OUT; ctx.lineWidth = 1.4; ctx.stroke();
      ctx.fillStyle = '#2d140b';
      ctx.beginPath(); ctx.moveTo(hx - 7.4, hy - 13); ctx.lineTo(hx - 7, hy - 20); ctx.lineTo(hx - 2.5, hy - 13.5); ctx.closePath(); ctx.fill();
      ctx.beginPath(); ctx.moveTo(hx + 1.8, hy - 14.5); ctx.lineTo(hx + 4, hy - 21); ctx.lineTo(hx + 6.2, hy - 12); ctx.closePath(); ctx.fill();
      // head shape
      ctx.fillStyle = '#f26f24';
      ctx.beginPath(); ctx.ellipse(hx, hy, 11, 10, 0, 0, TAU); ctx.fill();
      ctx.strokeStyle = OUT; ctx.lineWidth = 1.4; ctx.stroke();
      // snout
      ctx.fillStyle = '#fff1d6';
      ctx.beginPath(); ctx.moveTo(hx + 3, hy - 1); ctx.quadraticCurveTo(hx + 14, hy - 1, hx + 20, hy + 4); ctx.quadraticCurveTo(hx + 13, hy + 9, hx + 2, hy + 8); ctx.closePath(); ctx.fill();
      ctx.strokeStyle = OUT; ctx.lineWidth = 1.2; ctx.stroke();
      ctx.fillStyle = '#1e0c07'; ctx.beginPath(); ctx.arc(hx + 19, hy + 3.5, 2.3, 0, TAU); ctx.fill();
      // eye
      const blink = (Math.sin(t * 0.9) > 0.985) || f.dead;
      if (f.dead) { ctx.strokeStyle = '#1e0c07'; ctx.lineWidth = 1.6; ctx.beginPath(); ctx.moveTo(hx + 1, hy - 4); ctx.lineTo(hx + 7, hy + 1); ctx.moveTo(hx + 7, hy - 4); ctx.lineTo(hx + 1, hy + 1); ctx.stroke(); }
      else if (!blink) { ctx.fillStyle = '#1e0c07'; ctx.beginPath(); ctx.ellipse(hx + 6, hy - 2, 2.2, 2.9, 0, 0, TAU); ctx.fill(); ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(hx + 6.6, hy - 3.2, 0.9, 0, TAU); ctx.fill(); }
      // cheek
      ctx.fillStyle = 'rgba(255,240,220,0.9)';
      ctx.beginPath(); ctx.moveTo(hx - 6, hy + 3); ctx.quadraticCurveTo(hx - 1, hy + 11, hx + 6, hy + 8); ctx.quadraticCurveTo(hx, hy + 4, hx - 6, hy + 3); ctx.fill();
      // goggles on forehead (courier)
      ctx.strokeStyle = '#2f9a8e'; ctx.lineWidth = 2.2;
      ctx.beginPath(); ctx.moveTo(hx - 9, hy - 5); ctx.quadraticCurveTo(hx - 2, hy - 10.5, hx + 9, hy - 6); ctx.stroke();
      ctx.restore();
    }

    drawDust(ctx) {
      for (const p of this.puffs) {
        const k = p.life / p.max, r = p.r * (1 + k * 1.6);
        ctx.fillStyle = `rgba(228,178,120,${p.a * (1 - k) * (1 - k * 0.3)})`;
        ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, TAU); ctx.fill();
      }
    }

    drawForeground(ctx, Wl, Hl, yG) {
      // tumbleweeds rolling along the near ground
      for (const w of this.weeds) {
        const hop = Math.abs(Math.sin(w.hop)) * 7;
        const y = w.y - hop;
        ctx.save(); ctx.translate(w.x, y); ctx.rotate(w.rot);
        ctx.strokeStyle = 'rgba(70,32,16,0.9)'; ctx.lineWidth = 1.5;
        for (let i = 0; i < 9; i++) {
          const a = i * 0.7;
          ctx.beginPath(); ctx.ellipse(0, 0, w.r * (0.5 + 0.5 * hash1(i + w.r)), w.r * 0.9, a, 0, TAU); ctx.stroke();
        }
        ctx.strokeStyle = 'rgba(190,130,70,0.7)'; ctx.lineWidth = 1;
        for (let i = 0; i < 6; i++) { ctx.beginPath(); ctx.ellipse(0, 0, w.r * 0.8, w.r * 0.4, i * 0.55 + 0.3, 0, TAU); ctx.stroke(); }
        ctx.restore();
        ctx.fillStyle = 'rgba(20,6,6,0.25)'; ctx.beginPath(); ctx.ellipse(w.x, w.y + w.r * 0.8, w.r * 0.8, 3, 0, 0, TAU); ctx.fill();
      }
      // dark foreground rocks, fast parallax
      const off = this.dist * 1.6;
      for (let c = Math.floor(off / 420); c * 420 - off < Wl + 420; c++) {
        const hv = hash1(c * 2.3 + 1.1);
        if (hv < 0.55) continue;
        const rx = c * 420 - off + hv * 200, rw = 50 + hv * 90, rh = 18 + hv * 36;
        ctx.fillStyle = '#240d09';
        ctx.beginPath(); ctx.moveTo(rx - rw / 2, Hl + 2); ctx.quadraticCurveTo(rx - rw * 0.4, Hl - rh, rx - rw * 0.1, Hl - rh * 1.05); ctx.quadraticCurveTo(rx + rw * 0.3, Hl - rh * 1.2, rx + rw / 2, Hl + 2); ctx.closePath(); ctx.fill();
        ctx.fillStyle = 'rgba(255,160,90,0.18)';
        ctx.beginPath(); ctx.moveTo(rx + rw * 0.1, Hl - rh * 1.1); ctx.quadraticCurveTo(rx + rw * 0.32, Hl - rh * 1.2, rx + rw * 0.5, Hl + 2); ctx.lineTo(rx + rw * 0.4, Hl + 2); ctx.closePath(); ctx.fill();
      }
    }

    drawSpeedLines(ctx, Wl, yG) {
      const k = clamp((this.v - 470) / 250, 0, 1);
      if (k <= 0) return;
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.lineCap = 'round';
      for (const l of this.lines) {
        const x = l.x * Wl, y = 30 + l.y * (this.Hl - 60);
        const len = l.l * Wl * (0.6 + k);
        ctx.strokeStyle = `rgba(255,214,170,${0.16 * k})`;
        ctx.lineWidth = 1.6;
        ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + len, y); ctx.stroke();
      }
      ctx.restore();
    }
  }

  Arcade.register({
    id: 'runner',
    name: 'Canyon Runner',
    genre: 'Auto runner',
    aiNote: "Sees only obstacles on screen through an 80 ms reaction delay, so its jump timing gets looser as the canyon speeds up.",
    blurb: 'A courier fox sprints through a golden canyon, leaping gaps and ducking hawks.',
    bg: '#2d1a2f',
    accent: '#f07a2c',
    create(opts = {}) { return new RunnerGame(opts); },
  });
})();
