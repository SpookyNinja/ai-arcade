// racing.js — Slipstream (top-down night-city racing). Autopilot (amber) vs 5 rivals, 3 laps.
(() => {
  'use strict';

  // ------------------------------------------------------------------ constants
  const LAPS = 3;
  const HW = 80;               // half road width
  const KERB = 12;             // kerb strip width (driveable)
  const GRASS = 62;            // grass strip beyond the kerb, then the barrier
  const BAR = HW + KERB + GRASS;
  const CAR_L = 46, CAR_W = 22, WB = 30;
  const VMAX = 290, ENG = 182, BRAKE = 414, GRIP = 122;
  const GO_T = 3.6;            // countdown length (s)
  const CAP_T = 360;
  const CH = 20;               // samples per drawing chunk
  const PI = Math.PI;
  const wrapA = a => { a %= TAU; if (a > PI) a -= TAU; else if (a < -PI) a += TAU; return a; };
  const lerpA = (a, b, t) => a + wrapA(b - a) * t;
  const fmtTime = s => { const m = Math.floor(s / 60); return m + ':' + (s - m * 60).toFixed(1).padStart(4, '0'); };
  const ordinal = n => n + (['th', 'st', 'nd', 'rd'][(n % 100 > 10 && n % 100 < 14) ? 0 : (n % 10 < 4 ? n % 10 : 0)]);
  const steerMax = v => 0.55 / (1 + (v / 180) * (v / 180));   // physics a driver learns: max front-wheel angle vs speed

  // ------------------------------------------------------------------ tracks (superellipse + harmonics, star-shaped)
  const TRACKS = [
    { name: 'Harbour Loop', rx: 1963, ry: 739, n: 2.88, h: [[2, 0.069, 3.15], [5, 0.052, 4.73], [3, 0.162, 5.65], [4, 0.139, 6.14]] },
    { name: 'Neon Bend', rx: 1398, ry: 1236, n: 3.0, h: [[6, 0.074, 2.67], [2, 0.135, 5.83], [3, 0.175, 0.71], [5, 0.073, 3.41]] },
    { name: 'Gasworks Sprint', rx: 1718, ry: 855, n: 2.69, h: [[3, 0.171, 0.25], [5, 0.165, 2.87], [2, 0.145, 0.96], [6, 0.042, 3.9]] },
  ];

  function superPoint(def, th) {
    const c = Math.cos(th), s = Math.sin(th), p = 2 / def.n;
    let k = 1;
    for (const h of def.h) k += h[1] * Math.cos(h[0] * th + h[2]);
    return [def.rx * Math.sign(c) * Math.pow(Math.abs(c), p) * k, def.ry * Math.sign(s) * Math.pow(Math.abs(s), p) * k];
  }

  function buildTrack(def, reverse) {
    const K = 7000;
    let px = new Float64Array(K), py = new Float64Array(K), cum = new Float64Array(K + 1);
    for (let k = 0; k < K; k++) { const p = superPoint(def, k / K * TAU); px[k] = p[0]; py[k] = p[1]; }
    for (let k = 0; k < K; k++) { const j = (k + 1) % K; cum[k + 1] = cum[k] + Math.hypot(px[j] - px[k], py[j] - py[k]); }
    const L = cum[K];
    const N = 20 * Math.max(30, Math.round(L / 200));
    const ds = L / N;
    let cx = new Float64Array(N), cy = new Float64Array(N);
    let k = 0;
    for (let i = 0; i < N; i++) {
      const s = i * ds;
      while (k < K - 1 && cum[k + 1] < s) k++;
      const j = (k + 1) % K, f = (s - cum[k]) / Math.max(1e-6, cum[k + 1] - cum[k]);
      cx[i] = px[k] + (px[j] - px[k]) * f; cy[i] = py[k] + (py[j] - py[k]) * f;
    }
    if (reverse) { cx = cx.reverse(); cy = cy.reverse(); }
    const geom = () => {
      const tx = new Float64Array(N), ty = new Float64Array(N), kap = new Float64Array(N);
      for (let i = 0; i < N; i++) {
        const a = (i + N - 1) % N, b = (i + 1) % N;
        const dx = cx[b] - cx[a], dy = cy[b] - cy[a], l = Math.hypot(dx, dy);
        tx[i] = dx / l; ty[i] = dy / l;
      }
      for (let i = 0; i < N; i++) {
        const a = (i + N - 3) % N, b = (i + 3) % N;
        kap[i] = wrapA(Math.atan2(ty[b], tx[b]) - Math.atan2(ty[a], tx[a])) / (6 * ds);
      }
      return { tx, ty, kap };
    };
    let g = geom();
    // rotate so that the start/finish line sits in the straightest stretch
    let best = 0, bs = 1e9;
    for (let i = 0; i < N; i++) {
      let s = 0;
      for (let j = -20; j < 40; j++) s += Math.abs(g.kap[(i + j + N) % N]);
      if (s < bs) { bs = s; best = i; }
    }
    const shift = (best + 0) % N;
    const rc = new Float64Array(N), rcy = new Float64Array(N);
    for (let i = 0; i < N; i++) { rc[i] = cx[(i + shift) % N]; rcy[i] = cy[(i + shift) % N]; }
    cx = rc; cy = rcy;
    g = geom();
    const nx = new Float64Array(N), ny = new Float64Array(N);
    for (let i = 0; i < N; i++) { nx[i] = -g.ty[i]; ny[i] = g.tx[i]; }
    // smooth kappa for use by drivers/visuals
    const kap = new Float64Array(N);
    for (let i = 0; i < N; i++) { let s = 0; for (let j = -3; j <= 3; j++) s += g.kap[(i + j + N) % N]; kap[i] = s / 7; }
    let minX = 1e9, maxX = -1e9, minY = 1e9, maxY = -1e9;
    for (let i = 0; i < N; i++) { minX = Math.min(minX, cx[i]); maxX = Math.max(maxX, cx[i]); minY = Math.min(minY, cy[i]); maxY = Math.max(maxY, cy[i]); }
    const T = { name: def.name, N, ds, L, cx, cy, tx: g.tx, ty: g.ty, nx, ny, kap, minX, maxX, minY, maxY };
    buildChunks(T);
    buildLamps(T);
    return T;
  }

  function buildChunks(T) {
    const { N, cx, cy, nx, ny } = T;
    const edge = (path, i, off, first) => { const j = i % N; const x = cx[j] + nx[j] * off, y = cy[j] + ny[j] * off; first ? path.moveTo(x, y) : path.lineTo(x, y); };
    const chunks = [];
    let len = 0;
    for (let i = 0; i < CH; i++) len += Math.hypot(cx[(i + 1) % N] - cx[i], cy[(i + 1) % N] - cy[i]);
    T.dashP = len / Math.max(1, Math.round(len / 62));
    for (let a = 0; a < N; a += CH) {
      const ch = { a, x: cx[(a + CH / 2) % N], y: cy[(a + CH / 2) % N], r: CH * T.ds * 0.5 + BAR + 20 };
      const poly = (off) => {
        const p = new Path2D();
        for (let i = 0; i <= CH + 1; i++) edge(p, a + i, off, i === 0);
        for (let i = CH + 1; i >= 0; i--) edge(p, a + i, -off, false);
        p.closePath(); return p;
      };
      ch.asphalt = poly(HW);
      ch.grass = poly(BAR);
      ch.kerbR = new Path2D(); ch.kerbW = new Path2D();
      for (let i = 0; i < CH; i += 2) {
        const P = (((a + i) >> 1) & 1) ? ch.kerbW : ch.kerbR;
        for (const s of [1, -1]) {
          const o1 = s * HW, o2 = s * (HW + KERB);
          edge(P, a + i, o1, true); edge(P, a + i + 2, o1, false); edge(P, a + i + 2, o2, false); edge(P, a + i, o2, false); P.closePath();
        }
      }
      ch.barrier = new Path2D(); ch.edges = new Path2D(); ch.center = new Path2D();
      for (const s of [1, -1]) {
        for (let i = 0; i <= CH; i++) { edge(ch.barrier, a + i, s * BAR, i === 0); }
        for (let i = 0; i <= CH; i++) { edge(ch.edges, a + i, s * (HW - 6), i === 0); }
      }
      for (let i = 0; i <= CH; i++) edge(ch.center, a + i, 0, i === 0);
      chunks.push(ch);
    }
    T.chunks = chunks;
  }

  function buildLamps(T) {
    const lamps = [];
    const step = Math.max(1, Math.round(235 / T.ds));
    const cols = ['#ffb25a', '#bfe4ff', '#ffb25a', '#ff7ab8', '#bfe4ff', '#7fe3ff'];
    for (let i = 5, n = 0; i < T.N; i += step, n++) {
      const s = n % 2 ? 1 : -1, c = cols[(n * 7 + 3) % cols.length];
      const lo = BAR + 22, bo = s * HW * 0.34;
      lamps.push({
        x: T.cx[i] + T.nx[i] * s * lo, y: T.cy[i] + T.ny[i] * s * lo,
        bx: T.cx[i] + T.nx[i] * bo, by: T.cy[i] + T.ny[i] * bo, ang: Math.atan2(T.ty[i], T.tx[i]), col: c,
      });
    }
    T.lamps = lamps;
    // grandstand next to the start line
    const crowd = [];
    for (let k = 0; k < 160; k++) crowd.push([Math.random() * 380 - 190, Math.random() * 56 - 28, ['#ff9d5c', '#7fe3ff', '#ffd36b', '#ff7ab8', '#e8e8f5'][k % 5], 1 + Math.random() * 1.2]);
    T.crowd = crowd;
  }

  function locate(T, x, y, hint, out) {
    const N = T.N, cx = T.cx, cy = T.cy;
    let best = 0, bd = 1e18;
    if (hint < 0) {
      for (let i = 0; i < N; i++) { const dx = x - cx[i], dy = y - cy[i], d = dx * dx + dy * dy; if (d < bd) { bd = d; best = i; } }
    } else {
      for (let k = -14; k <= 14; k++) { const i = (hint + k + N) % N, dx = x - cx[i], dy = y - cy[i], d = dx * dx + dy * dy; if (d < bd) { bd = d; best = i; } }
    }
    const dx = x - cx[best], dy = y - cy[best];
    out.i = best; out.fi = best + clamp((dx * T.tx[best] + dy * T.ty[best]) / T.ds, -1, 1); out.d = dx * T.nx[best] + dy * T.ny[best];
    return out;
  }
  const wrapIdx = (d, N) => { d = ((d % N) + N) % N; return d > N / 2 ? d - N : d; };

  // ------------------------------------------------------------------ racing line (computed from track geometry only)
  // Coordinate descent on lateral offsets minimising sum(segment length / corner-speed limit): a "minimum lap time"
  // line: wide entry, late apex, wide exit.
  function buildRaceLine(T) {
    const N = T.N, lim = HW - 26;
    const o = new Float64Array(N), lx = new Float64Array(N), ly = new Float64Array(N);
    const place = i => { lx[i] = T.cx[i] + T.nx[i] * o[i]; ly[i] = T.cy[i] + T.ny[i] * o[i]; };
    for (let i = 0; i < N; i++) place(i);
    const B = 3;
    const costRange = (lo, hi) => {
      let c = 0;
      for (let j = lo; j <= hi; j++) {
        const a = (j - B + N * 4) % N, b = (j + N * 4) % N, d = (j + B + N * 4) % N;
        const abx = lx[b] - lx[a], aby = ly[b] - ly[a], bcx = lx[d] - lx[b], bcy = ly[d] - ly[b];
        const cr = Math.abs(abx * bcy - aby * bcx), la = Math.hypot(abx, aby), lb = Math.hypot(bcx, bcy);
        const lc = Math.hypot(lx[d] - lx[a], ly[d] - ly[a]);
        const k = 2 * cr / (la * lb * lc + 1e-9);
        const v = Math.min(VMAX, Math.sqrt(GRIP * 0.9 / Math.max(k, 1e-4)));
        c += lb / v;
      }
      return c;
    };
    const saved = new Float64Array(64);
    // smooth "bump" moves of the offsets, accepted when they reduce the estimated lap time
    for (let sweep = 0; sweep < 70; sweep++) {
      const Wd = sweep < 20 ? 16 : sweep < 45 ? 8 : 4, stepSz = sweep < 20 ? 6 : sweep < 45 ? 4 : 2;
      const stride = Math.max(2, Wd >> 1);
      const off0 = (sweep * 3) % stride;
      for (let i = off0; i < N; i += stride) {
        const lo = i - Wd - B - 2, hi = i + Wd + B + 2;
        const c0 = costRange(lo, hi);
        let bestS = 0, bc = c0;
        for (const sg of [-1, 1]) {
          for (let k = -Wd; k <= Wd; k++) { const q = (i + k + N) % N; saved[k + Wd] = o[q]; o[q] = clamp(o[q] + sg * stepSz * (1 - Math.abs(k) / (Wd + 1)), -lim, lim); place(q); }
          const c = costRange(lo, hi);
          for (let k = -Wd; k <= Wd; k++) { const q = (i + k + N) % N; o[q] = saved[k + Wd]; place(q); }
          if (c < bc - 1e-9) { bc = c; bestS = sg; }
        }
        if (bestS) for (let k = -Wd; k <= Wd; k++) { const q = (i + k + N) % N; o[q] = clamp(o[q] + bestS * stepSz * (1 - Math.abs(k) / (Wd + 1)), -lim, lim); place(q); }
      }
    }
    const seg = new Float64Array(N), kap = new Float64Array(N);
    for (let i = 0; i < N; i++) { const j = (i + 1) % N; seg[i] = Math.hypot(lx[j] - lx[i], ly[j] - ly[i]); }
    const raw = new Float64Array(N);
    for (let i = 0; i < N; i++) {
      const a = (i + N - 4) % N, d = (i + 4) % N;
      const t1 = Math.atan2(ly[i] - ly[a], lx[i] - lx[a]), t2 = Math.atan2(ly[d] - ly[i], lx[d] - lx[i]);
      raw[i] = Math.abs(wrapA(t2 - t1)) / Math.max(1, (seg[a] + seg[(a + 1) % N] + seg[(a + 2) % N] + seg[(a + 3) % N]));
    }
    for (let i = 0; i < N; i++) { let s = 0; for (let j = -3; j <= 3; j++) s += raw[(i + j + N) % N]; kap[i] = s / 7; }
    return { o, lx, ly, seg, kap, lim };
  }

  // speed profile along the line: corner limit (grip * margin), then braking-distance and acceleration limits
  function buildProfile(T, line, margin, brakeK) {
    const N = T.N, v = new Float64Array(N);
    const G = GRIP * margin;
    for (let i = 0; i < N; i++) v[i] = Math.min(VMAX * 1.02, Math.sqrt(G / Math.max(line.kap[i], 1 / 3000)));
    const B = BRAKE * brakeK;
    for (let pass = 0; pass < 2; pass++) {
      for (let i = N - 1; i >= 0; i--) { const j = (i + 1) % N; v[i] = Math.min(v[i], Math.sqrt(v[j] * v[j] + 2 * B * line.seg[i])); }
    }
    const A = ENG * 0.5;
    for (let pass = 0; pass < 2; pass++) {
      for (let i = 0; i < N; i++) { const j = (i + 1) % N; v[j] = Math.min(v[j], Math.sqrt(v[i] * v[i] + 2 * A * line.seg[i])); }
    }
    return v;
  }

  // ------------------------------------------------------------------ driver
  // One driving brain used by the Autopilot AND the rivals. It is only ever handed what a driver can see:
  // the track (static geometry), its own car's position/heading/speed, and the other cars' positions/headings
  // (their speed is estimated from successive positions). It outputs wheel, throttle and brake — nothing else.
  // The Autopilot additionally sees the other cars through a ~70 ms reaction delay (see AutopilotAI below).
  class Driver {
    constructor(T, line, o) {
      this.T = T; this.line = line;
      this.margin = o.margin; this.fm = 1;
      this.prof = buildProfile(T, line, o.margin, o.brakeK || 0.62);
      this.bias = o.bias || 0;           // personal lateral preference (m of imperfect line)
      this.lookK = o.lookK || 1;
      this.passGap = o.passGap || 46; this.followD = o.followD || 52;
      this.mistakes = !!o.mistakes; this.patient = !!o.patient; this.inside = !!o.inside;
      this.mTimer = rnd.float(15, 40); this.mLeft = 0; this.mDir = 1;
      this.j = -1; this.ofs = 0; this.loc = { i: 0, fi: 0, d: 0 };
      this.others = new Map();           // per-car tracked info: last position, velocity estimate, track index
      this.steerOut = 0; this.side = 1; this.sideId = null; this.sideT = 0;
    }
    // does a car seen at track-distance s (ahead +) with lateral m.loc.d get in the way of lateral position `pl`?
    // Its lateral position is extrapolated: it keeps its current deviation from the racing line, which swings across the road.
    clash(m, s, pl, need) {
      if (Math.abs(pl - m.loc.d) < need) return true;
      const o = this.line.o, N = this.T.N, dev = m.loc.d - o[m.loc.i];
      const q = (m.loc.i + 9) % N;
      const lat2 = clamp(o[q] + dev, -HW, HW);
      const mine2 = clamp(pl + (o[(this.j + Math.round(s / this.T.ds) + 9) % N] - o[(this.j + Math.round(s / this.T.ds)) % N]) * 0, -HW, HW);
      return s > -10 && Math.abs(lat2 - mine2) < need * 0.9;
    }
    // me: {x,y,th,vx,vy,steer}; others: [{id,x,y,th}]
    decide(me, others, dt, state) {
      const T = this.T, line = this.line, N = T.N, ds = T.ds;
      locate(T, me.x, me.y, this.j, this.loc);
      this.j = this.loc.i;
      const j = this.j, v = Math.hypot(me.vx, me.vy);
      const cs = Math.cos(me.th), sn = Math.sin(me.th);
      const vf = me.vx * cs + me.vy * sn, vl = -me.vx * sn + me.vy * cs;
      // ---- track the other cars (index on the track + velocity estimate)
      for (const c of others) {
        let m = this.others.get(c.id);
        if (!m) { m = { x: c.x, y: c.y, vx: 0, vy: 0, loc: { i: 0, fi: 0, d: 0 }, init: false }; this.others.set(c.id, m); }
        m.vx += ((c.x - m.x) / dt - m.vx) * 0.35; m.vy += ((c.y - m.y) / dt - m.vy) * 0.35;
        m.x = c.x; m.y = c.y; m.th = c.th;
        locate(T, c.x, c.y, m.init ? m.loc.i : -1, m.loc); m.init = true;
        m.speed = Math.hypot(m.vx, m.vy);
      }
      // ---- slow form drift + occasional lapses (rivals only)
      this.fm = clamp(this.fm + rnd.gauss() * 0.0009, 0.965, 1.015);
      if (this.mistakes) {
        if (this.mLeft > 0) this.mLeft -= dt;
        else { this.mTimer -= dt; if (this.mTimer < 0) { this.mTimer = rnd.float(14, 34); this.mLeft = rnd.float(0.8, 1.5); this.mDir = Math.random() < 0.5 ? -1 : 1; } }
      }
      // ---- traffic: choose lateral offset from the racing line and a speed cap
      const lim = HW - 22;
      const latAt = (k) => clamp(line.o[(j + k) % N] + this.bias, -lim, lim);
      let want = 0, vcap = 1e9;
      const thr = [];
      for (const [id, m] of this.others) {
        const s = wrapIdx(m.loc.i - j, N) * ds;
        if (s > -50 && s < 135) thr.push([s, m]);
      }
      if (this.sideT > 0) this.sideT -= dt;
      let prim = null;
      for (const [s, m] of thr) if (!prim || (s > -50 && (prim[0] <= -50 || s < prim[0]))) { if (s < 95 && s > -50) prim = [s, m]; }
      if (prim) {
        // Shadow the nearest car: pick a side (kept ~2.5 s), run alongside it at a safe lateral gap, then release.
        const [s, m] = prim, o = this.line.o;
        const dev = m.loc.d - o[m.loc.i];
        const lp = m.loc.d * 0.5 + clamp(o[(m.loc.i + 8) % N] + dev, -HW, HW) * 0.5;
        const gap = this.passGap;
        if (this.sideT <= 0 || this.sideId !== m.id) {
          const roomR = lim - lp, roomL = lp + lim;
          this.side = roomR > roomL + (this.side > 0 ? -12 : 12) ? 1 : -1;
          if (this.sideId !== m.id) this.side = roomR >= roomL ? 1 : -1;
          if (this.inside) { const oa = line.o[(j + Math.round(90 / ds)) % N]; if (Math.abs(oa - lp) > 8 && Math.abs(lp + Math.sign(oa - lp) * gap) <= lim) this.side = Math.sign(oa - lp); }
          this.sideId = m.id; this.sideT = 2.5;
        }
        let tgt = lp + this.side * gap;
        // Patient drafter: tuck in behind (slipstream) while a corner is coming, pass on the straights
        const cornerAhead = this.patient && s > 0 && this.prof[(j + Math.round(120 / ds)) % N] < 0.7 * Math.max(v, 150);
        if (cornerAhead) { tgt = lp; this.sideT = 0.8; }
        if (Math.abs(tgt) > lim) { const alt = lp - this.side * gap; if (Math.abs(alt) <= lim) { this.side = -this.side; tgt = alt; } else tgt = clamp(tgt, -lim, lim); }
        want = tgt - latAt(Math.max(1, Math.round(clamp(30 + 0.2 * v * this.lookK, 32, 125) / ds)));
        if ((Math.abs(tgt - lp) < gap * 0.8 || cornerAhead) && s > 0) vcap = Math.min(vcap, m.speed + (s - this.followD) * 2.2);
      }
      // any other car right in our path (not the one we are shadowing): don't ram it
      for (const [s, m] of thr) {
        if (prim && m === prim[1]) continue;
        if (s > 0 && s < 80 && Math.abs(m.loc.d - this.loc.d) < 30) vcap = Math.min(vcap, m.speed + (s - this.followD) * 2.2);
      }
      const rate = prim ? 110 : 45;
      this.ofs += clamp(want - this.ofs, -rate * dt, rate * dt);
      // ---- steering: pure pursuit toward a point ahead on the (offset) line
      const Ld = clamp(30 + 0.2 * v * this.lookK, 32, 125);
      const kk = Math.max(1, Math.round(Ld / ds));
      const jt = (j + kk) % N;
      const lat = clamp(line.o[jt] + this.bias + this.ofs, -lim, lim);
      const tx = T.cx[jt] + T.nx[jt] * lat, ty = T.cy[jt] + T.ny[jt] * lat;
      const dx = tx - me.x, dy = ty - me.y;
      const lxp = dx * cs + dy * sn, lyp = -dx * sn + dy * cs;
      const alpha = Math.atan2(lyp, lxp);
      const dist = Math.hypot(dx, dy);
      const delta = Math.atan2(2 * WB * Math.sin(alpha), Math.max(dist, 12));
      let sc = clamp(delta / steerMax(Math.max(vf, 0)), -1, 1);
      if (this.mLeft > 0) sc = clamp(sc + this.mDir * 0.22, -1, 1);
      // ---- speed
      const kv = Math.max(1, Math.round((v * 0.1 + 6) / ds));
      let vt = this.prof[(j + kv) % N] * this.fm;
      const errLat = Math.abs(this.loc.d - (line.o[j] + this.bias + this.ofs));
      if (errLat > 22) vt *= clamp(1 - (errLat - 22) / 90, 0.6, 1);
      if (this.mLeft > 0) vt *= 1.1;
      if (state.cool) vt = Math.min(vt, 150);
      vt = Math.min(vt, vcap);
      let thrOut = 0, brk = 0;
      const e = vt - v;
      if (e > 0) thrOut = clamp(e / 11, 0, 1); else brk = clamp(-e / 17 - 0.04, 0, 1);
      if (Math.abs(vl) > 20 && brk === 0) thrOut *= 0.35;
      if (Math.abs(this.loc.d) > HW + KERB) { thrOut = Math.min(thrOut, 0.7); }
      if (!state.racing) { thrOut = 0; brk = 1; }
      this.out = this.out || { steer: 0, thr: 0, brk: 0 };
      this.out.steer = sc; this.out.thr = thrOut; this.out.brk = brk;
      return this.out;
    }
  }

  // ------------------------------------------------------------------ AUTOPILOT AI
  // The Autopilot only reads an observe() snapshot, exactly what a driver sees on screen: the track layout, its own
  // car (position, heading, velocity, wheel angle) and the other cars' positions and headings. No rival internals
  // (skill, line, lapse timers) are visible. The other cars are seen ~70 ms late (reaction time), its wheel
  // moves at the same limited rate as everyone's, and it acts only through steering, throttle and brake.
  const RACE_STYLES = [
    { name: 'Aggressive overtaker', o: { margin: 1.01, passGap: 33, followD: 36 } },
    { name: 'Patient drafter', o: { passGap: 41, followD: 34, patient: true } },
    { name: 'Inside diver', o: { lookK: 0.9, passGap: 36, followD: 40, inside: true } },
  ];
  class AutopilotAI {
    // Styles (picked per race): different overtaking / line tactics, all with the same car limits.
    constructor(T, line, sty) {
      this.driver = new Driver(T, line, Object.assign({ margin: 1.0, brakeK: 0.7, lookK: 1.0, passGap: 37, followD: 42, bias: rnd.float(-2, 2) }, sty.o));
      this.buf = [];
    }
    observe(game) {
      const me = game.cars[game.aiIndex];
      return {
        racing: game.t >= GO_T, finished: me.finished,
        me: { x: me.x, y: me.y, th: me.th, vx: me.vx, vy: me.vy, steer: me.steer },
        others: game.cars.filter(c => c !== me).map(c => ({ id: c.id, x: c.x, y: c.y, th: c.th })),
      };
    }
    act(game, dt) {
      const obs = this.observe(game);
      this.buf.push(obs.others); if (this.buf.length > 5) this.buf.shift();
      const seen = this.buf[0];       // ~4 ticks (≈67 ms) old
      return this.driver.decide(obs.me, seen, dt, { racing: obs.racing, cool: obs.finished });
    }
  }

  // ------------------------------------------------------------------ assets (shared, created once)
  let ASSETS = null;
  function mk(w, h) { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; }
  function makeAssets() {
    const A = {};
    // asphalt tile
    let c = mk(256, 256), x = c.getContext('2d');
    x.fillStyle = '#161a26'; x.fillRect(0, 0, 256, 256);
    for (let i = 0; i < 2600; i++) { x.fillStyle = Math.random() < 0.5 ? 'rgba(255,255,255,0.035)' : 'rgba(0,0,0,0.16)'; x.fillRect(Math.random() * 256, Math.random() * 256, 1 + Math.random() * 1.5, 1 + Math.random() * 1.5); }
    x.strokeStyle = 'rgba(0,0,0,0.25)'; x.lineWidth = 1;
    for (let i = 0; i < 4; i++) { x.beginPath(); let px = Math.random() * 256, py = Math.random() * 256; x.moveTo(px, py); for (let k = 0; k < 5; k++) { px += rnd.float(-22, 22); py += rnd.float(-22, 22); x.lineTo(px, py); } x.stroke(); }
    A.asphalt = c;
    // grass tile
    c = mk(256, 256); x = c.getContext('2d');
    x.fillStyle = '#0d2219'; x.fillRect(0, 0, 256, 256);
    for (let i = 0; i < 1400; i++) { x.strokeStyle = Math.random() < 0.5 ? 'rgba(110,200,140,0.06)' : 'rgba(0,0,0,0.16)'; x.lineWidth = 1; const px = Math.random() * 256, py = Math.random() * 256; x.beginPath(); x.moveTo(px, py); x.lineTo(px + rnd.float(-2, 2), py - rnd.float(2, 6)); x.stroke(); }
    A.grass = c;
    // city ground tile
    c = mk(768, 768); x = c.getContext('2d');
    x.fillStyle = '#080c16'; x.fillRect(0, 0, 768, 768);
    for (let i = 0; i < 38; i++) {
      const w = rnd.float(40, 150), h = rnd.float(40, 120), px = Math.random() * 768, py = Math.random() * 768;
      x.fillStyle = 'rgba(20,28,46,0.9)'; x.fillRect(px, py, w, h);
      x.fillStyle = 'rgba(8,12,22,0.9)'; x.fillRect(px + 4, py + 4, w - 8, h - 8);
      for (let k = 0; k < w * h / 220; k++) { x.fillStyle = ['rgba(255,200,120,0.45)', 'rgba(150,210,255,0.35)', 'rgba(255,150,190,0.28)'][k % 3]; x.fillRect(px + 7 + Math.random() * (w - 16), py + 7 + Math.random() * (h - 16), 2, 2); }
    }
    A.ground = c;
    // blooms
    A.bloom = {};
    for (const col of ['#ffb25a', '#bfe4ff', '#ff7ab8', '#7fe3ff', '#ff4b4b', '#ffffff']) {
      c = mk(128, 128); x = c.getContext('2d');
      const g = x.createRadialGradient(64, 64, 0, 64, 64, 64);
      g.addColorStop(0, col); g.addColorStop(0.25, col + '88'); g.addColorStop(1, col + '00');
      x.fillStyle = g; x.fillRect(0, 0, 128, 128); A.bloom[col] = c;
    }
    // headlight cone (points along +x, origin at (0, 80))
    c = mk(230, 160); x = c.getContext('2d');
    const g = x.createRadialGradient(0, 80, 6, 0, 80, 230);
    g.addColorStop(0, 'rgba(255,246,222,0.55)'); g.addColorStop(0.5, 'rgba(255,240,205,0.16)'); g.addColorStop(1, 'rgba(255,240,205,0)');
    x.fillStyle = g; x.beginPath(); x.moveTo(0, 80); x.arc(0, 80, 230, -0.36, 0.36); x.closePath(); x.fill();
    A.cone = c;
    A.car = {};
    return A;
  }
  function carSprite(color) {
    if (ASSETS.car[color]) return ASSETS.car[color];
    const S = 3, w = 64, h = 36;
    const c = mk(w * S, h * S), x = c.getContext('2d');
    x.scale(S, S); x.translate(w / 2, h / 2);
    const body = new Path2D();
    body.moveTo(23, 0);
    body.bezierCurveTo(22, -5, 16, -8, 8, -9);
    body.bezierCurveTo(0, -10.5, -10, -11.5, -18, -10);
    body.bezierCurveTo(-21, -9.5, -23, -7, -23, -4);
    body.lineTo(-23, 4);
    body.bezierCurveTo(-23, 7, -21, 9.5, -18, 10);
    body.bezierCurveTo(-10, 11.5, 0, 10.5, 8, 9);
    body.bezierCurveTo(16, 8, 22, 5, 23, 0);
    body.closePath();
    // wheels
    x.fillStyle = '#05070b';
    for (const [wx, wy, ww] of [[12, -11.4, 8], [12, 11.4, 8], [-14, -11.8, 9], [-14, 11.8, 9]]) { roundRect(x, wx - ww / 2, wy - 2.6, ww, 5.2, 1.8); x.fill(); }
    // wings
    x.fillStyle = '#0a0d14'; roundRect(x, -26, -12.5, 5.5, 25, 1.6); x.fill(); roundRect(x, 19.5, -10.5, 4.5, 21, 1.5); x.fill();
    const gr = x.createLinearGradient(0, -11, 0, 11);
    gr.addColorStop(0, shade(color, -0.35)); gr.addColorStop(0.35, color); gr.addColorStop(0.5, shade(color, 0.28)); gr.addColorStop(0.65, color); gr.addColorStop(1, shade(color, -0.35));
    x.fillStyle = gr; x.fill(body);
    x.strokeStyle = 'rgba(255,255,255,0.28)'; x.lineWidth = 0.6; x.stroke(body);
    // stripe
    x.strokeStyle = 'rgba(255,255,255,0.55)'; x.lineWidth = 2; x.beginPath(); x.moveTo(22, 0); x.lineTo(-3, 0); x.stroke();
    // cockpit
    const cg = x.createLinearGradient(-6, -5, 6, 5); cg.addColorStop(0, '#1b2538'); cg.addColorStop(1, '#05080f');
    x.fillStyle = cg; x.beginPath(); x.ellipse(-2, 0, 7.5, 5.2, 0, 0, TAU); x.fill();
    x.fillStyle = 'rgba(160,200,255,0.35)'; x.beginPath(); x.ellipse(-0.5, -1.6, 3.6, 1.6, -0.2, 0, TAU); x.fill();
    // lights
    x.fillStyle = '#fff7da'; x.fillRect(20.5, -5.2, 1.8, 2.2); x.fillRect(20.5, 3, 1.8, 2.2);
    x.fillStyle = '#ff3b3b'; x.fillRect(-23.2, -8, 1.8, 3); x.fillRect(-23.2, 5, 1.8, 3);
    ASSETS.car[color] = c;
    return c;
  }
  function shade(hex, f) {
    const n = parseInt(hex.slice(1), 16); let r = n >> 16, g = (n >> 8) & 255, b = n & 255;
    const t = f < 0 ? 0 : 255, p = Math.abs(f);
    r = Math.round((t - r) * p + r); g = Math.round((t - g) * p + g); b = Math.round((t - b) * p + b);
    return '#' + ((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1);
  }

  // ------------------------------------------------------------------ the game
  const RIVALS = [
    { name: 'VEGA', color: '#ff4d5e' }, { name: 'ROOK', color: '#35d0ff' }, { name: 'JUNO', color: '#44d9a0' },
    { name: 'KITE', color: '#a98bff' }, { name: 'MAKO', color: '#ff8ad8' },
  ];
  const AI_COLOR = '#ffb02e';

  class RacingGame {
    constructor() {
      if (!ASSETS) ASSETS = makeAssets();
      this.W = 1600; this.H = 900;
      const def = rnd.pick(TRACKS);
      this.T = buildTrack(def, Math.random() < 0.5);
      this.line = buildRaceLine(this.T);
      this.t = 0; this.over = false; this.won = false; this.overT = 0;
      this.particles = new Particles();
      this.marks = new Float32Array(1400 * 5); this.markN = 0; this.markHead = 0;
      this.finishCount = 0; this.winnerT = 0; this.aiPlace = 0;
      this._res = ''; this.rainSeed = [];
      for (let i = 0; i < 110; i++) this.rainSeed.push([Math.random(), Math.random(), 0.6 + Math.random() * 0.8]);
      this.cars = [];
      const names = rnd.shuffle(RIVALS.slice());
      // qualifying: the grid is ordered by pace plus noise (the Autopilot is usually, not always, near the front)
      const entries = [{ isAI: true, key: 0.9 + rnd.gauss() * 0.28 }];
      for (let r = 0; r < 5; r++) { const skill = rnd.float(0, 1); entries.push({ isAI: false, skill, key: skill * 0.9 + rnd.gauss() * 0.28, r }); }
      entries.sort((p, q) => q.key - p.key);
      const T = this.T;
      for (let s = 0; s < 6; s++) {
        const e = entries[s], isAI = e.isAI;
        if (isAI) this.aiIndex = s;
        const row = s >> 1, side = (s & 1) ? 1 : -1;
        const back = 40 + row * 62 + (side > 0 ? 24 : 0);
        const idx = (T.N - Math.round(back / T.ds) + T.N) % T.N;
        const x = T.cx[idx] + T.nx[idx] * side * 30, y = T.cy[idx] + T.ny[idx] * side * 30;
        const nm = isAI ? null : names[e.r];
        const car = {
          id: isAI ? 'ai' : nm.name, name: isAI ? 'AUTOPILOT' : nm.name, color: isAI ? AI_COLOR : nm.color, isAI,
          x, y, px: x, py: y, th: Math.atan2(T.ty[idx], T.tx[idx]), pth: 0, vx: 0, vy: 0, steer: 0, thr: 0, brk: 0, steerCmd: 0,
          loc: { i: idx, fi: idx, d: 0 }, prog: 0, finished: false, finishT: 0, draft: 0, wake: 0,
          slip: 0, grass: false, wl: null, bump: 0, rank: 1, hitT: 0,
        };
        car.pth = car.th;
        locate(T, x, y, -1, car.loc); car.lastFi = car.loc.fi;
        car.prog = (car.loc.fi > T.N / 2 ? car.loc.fi - T.N : car.loc.fi) * T.ds;
        if (!isAI) {
          const skill = e.skill;
          car.driver = new Driver(T, this.line, {
            margin: 0.5 + skill * 0.26, brakeK: 0.5 + skill * 0.1, lookK: rnd.float(0.9, 1.2),
            bias: rnd.float(-10, 10), passGap: rnd.float(42, 52), followD: rnd.float(48, 60), mistakes: true,
          });
          car.skill = skill;
        }
        this.cars.push(car);
      }
      this.styleDef = rnd.pick(RACE_STYLES); this.style = this.styleDef.name;
      this.ai = new AutopilotAI(T, this.line, this.styleDef);
      this.me = this.cars[this.aiIndex];
      // camera
      const a0 = Math.atan2(T.ty[this.me.loc.i], T.tx[this.me.loc.i]);
      this.cam = { x: this.me.x, y: this.me.y, a: a0, px: this.me.x, py: this.me.y, pa: a0 };
      this.zk = 0.85; this.pzk = 0.85;
      this.light = 0;
      this.resize(1600, 900);
    }

    resize(W, H) {
      this.W = W; this.H = H;
      this.baseZoom = Math.min(H / 940, W / 1500);
      // minimap
      const T = this.T;
      const mw = clamp(Math.min(W * 0.24, H * 0.36), 150, 420), bw = T.maxX - T.minX, bh = T.maxY - T.minY;
      const pad = 14, sc = Math.min((mw - pad * 2) / bw, (mw * 0.75 - pad * 2) / bh);
      const mh = bh * sc + pad * 2, mwd = bw * sc + pad * 2;
      this.mini = { w: mwd, h: mh, sc, ox: pad - T.minX * sc, oy: pad - T.minY * sc, path: new Path2D() };
      const p = this.mini.path;
      for (let i = 0; i <= T.N; i += 4) { const k = i % T.N; const x = T.cx[k] * sc + this.mini.ox, y = T.cy[k] * sc + this.mini.oy; i === 0 ? p.moveTo(x, y) : p.lineTo(x, y); }
      p.closePath();
      this.snapCam();
    }

    snapCam() {
      const m = this.me, T = this.T;
      const a = this.camTargetAngle();
      this.cam.a = this.cam.pa = a;
      const sp = Math.hypot(m.vx, m.vy);
      this.cam.x = this.cam.px = m.x + Math.cos(a) * sp * 0.3; this.cam.y = this.cam.py = m.y + Math.sin(a) * sp * 0.3;
    }
    camTargetAngle() {
      const m = this.me, T = this.T, i = (m.loc.i + 14) % T.N;
      const tr = Math.atan2(T.ty[i], T.tx[i]);
      return lerpA(m.th, tr, 0.55);
    }

    // ---------------------------------------------------------------- simulation
    step(dt) {
      this.t += dt;
      const T = this.T, cars = this.cars, racing = this.t >= GO_T;
      this.pzk = this.zk; this.zk = 0.85 + 0.15 * ease.outCubic(Math.min(1, this.t / GO_T));
      this.light = this.t < 0.8 ? 0 : this.t < GO_T ? Math.min(3, Math.floor((this.t - 0.8) / 0.9) + 1) : 4;
      for (const c of cars) { c.px = c.x; c.py = c.y; c.pth = c.th; c.pwl = c.wl; }
      this.cam.px = this.cam.x; this.cam.py = this.cam.y; this.cam.pa = this.cam.a;
      // drivers
      const snapOthers = (self) => cars.filter(o => o !== self).map(o => ({ id: o.id, x: o.x, y: o.y, th: o.th }));
      for (const c of cars) {
        let ctl;
        if (c.isAI) ctl = this.ai.act(this, dt);
        else ctl = c.driver.decide(c, snapOthers(c), dt, { racing, cool: c.finished });
        c.steerCmd = ctl.steer; c.thr = ctl.thr; c.brk = ctl.brk;
      }
      // physics (2 substeps)
      for (let s = 0; s < 2; s++) {
        for (const c of cars) this.physics(c, dt / 2, racing);
        this.collide();
      }
      // progress / draft / ranks
      const raceT = Math.max(0, this.t - GO_T);
      for (const c of cars) {
        locate(T, c.x, c.y, c.loc.i, c.loc);
        c.prog += wrapIdx(c.loc.fi - c.lastFi, T.N) * T.ds; c.lastFi = c.loc.fi;
        c.grass = Math.abs(c.loc.d) > HW + KERB;
        if (!c.finished && c.prog >= LAPS * T.L) {
          c.finished = true; c.finishT = raceT; this.finishCount++; c.place = this.finishCount;
          if (c.place === 1) this.winnerT = raceT;
          if (c.isAI && !this.over) {
            this.over = true; this.aiPlace = c.place; this.won = c.place === 1; this.finishAt = raceT;
          }
        }
      }
      this.updateDraft(dt);
      this.updateRanks();
      this.updateMarksAndFx(dt, racing);
      this.particles.update(dt);
      if (this.particles.list.length > 320) this.particles.list.length = 320;
      // camera
      const m = this.me, sp = Math.hypot(m.vx, m.vy);
      const ta = this.camTargetAngle();
      this.cam.a = lerpA(this.cam.a, ta, 1 - Math.exp(-dt / 0.55));
      const tx = m.x + Math.cos(this.cam.a) * sp * 0.3, ty = m.y + Math.sin(this.cam.a) * sp * 0.3;
      const kx = 1 - Math.exp(-dt / 0.14);
      this.cam.x += (tx - this.cam.x) * kx; this.cam.y += (ty - this.cam.y) * kx;
      if (this.over) this.overT += dt;
      if (!this.over && this.t > CAP_T) { this.over = true; this.won = false; this.aiPlace = 0; this.timeout = true; }
    }

    physics(c, dt, racing) {
      const T = this.T;
      // wheel: rate limited (same for every car)
      c.steer += clamp(c.steerCmd - c.steer, -5.5 * dt, 5.5 * dt);
      const d = Math.abs(c.loc.d);
      const onGrass = d > HW + KERB, onKerb = !onGrass && d > HW;
      let cs = Math.cos(c.th), sn = Math.sin(c.th);
      let vf = c.vx * cs + c.vy * sn, vl = -c.vx * sn + c.vy * cs;
      if (!racing) { c.vx = c.vy = 0; return; }
      // yaw
      let om = (Math.max(vf, 0) / WB) * Math.tan(c.steer * steerMax(Math.max(vf, 0)));
      const slipR = Math.abs(vl) / (Math.abs(vf) + 20);
      if (slipR > 0.15) om *= Math.max(0.25, 1 - (slipR - 0.15) * 3);
      c.th += om * dt;
      cs = Math.cos(c.th); sn = Math.sin(c.th);
      vf = c.vx * cs + c.vy * sn; vl = -c.vx * sn + c.vy * cs;
      // longitudinal
      const vmx = VMAX * (1 + 0.05 * c.draft) * (onGrass ? 0.6 : 1);
      let acc = 0;
      if (c.thr > 0) acc += ENG * (1 + 0.38 * c.draft) * c.thr * (1 - Math.pow(clamp(vf / vmx, 0, 1.3), 2.5)) * (onGrass ? 0.7 : 1);
      if (c.brk > 0 && vf > 0) acc -= BRAKE * c.brk;
      acc -= 0.05 * vf + 0.00012 * vf * Math.abs(vf);
      if (onGrass) acc -= vf * 1.0;
      vf += acc * dt;
      if (vf < -20) vf = -20;
      // lateral grip
      let G = GRIP * (onGrass ? 0.55 : onKerb ? 0.92 : 1) * (1 - 0.3 * c.brk) * (1 - 0.18 * c.thr);
      const sat = Math.abs(vl) > G * dt;
      c.slip = Math.abs(vl);
      if (sat) { vl -= Math.sign(vl) * G * dt; vf *= 1 - 0.5 * dt; } else vl = 0;
      c.vx = vf * cs - vl * sn; c.vy = vf * sn + vl * cs;
      c.x += c.vx * dt; c.y += c.vy * dt;
      // barrier
      locate(T, c.x, c.y, c.loc.i, c.loc);
      const lim = BAR - 13;
      if (Math.abs(c.loc.d) > lim) {
        const s = Math.sign(c.loc.d), ex = Math.abs(c.loc.d) - lim, i = c.loc.i;
        c.x -= T.nx[i] * s * ex; c.y -= T.ny[i] * s * ex;
        const vn = c.vx * T.nx[i] * s + c.vy * T.ny[i] * s;
        if (vn > 0) { c.vx -= T.nx[i] * s * vn * 1.3; c.vy -= T.ny[i] * s * vn * 1.3; c.vx *= 0.8; c.vy *= 0.8; if (vn > 40) this.sparks(c.x + T.nx[i] * s * 12, c.y + T.ny[i] * s * 12, Math.min(10, vn / 15)); }
      }
    }

    collide() {
      const cars = this.cars, off = [-14, 0, 14], R = 11.2;
      for (let a = 0; a < cars.length; a++) for (let b = a + 1; b < cars.length; b++) {
        const A = cars[a], B = cars[b];
        if (Math.abs(A.x - B.x) > 70 || Math.abs(A.y - B.y) > 70) continue;
        const ca = Math.cos(A.th), sa = Math.sin(A.th), cb = Math.cos(B.th), sb = Math.sin(B.th);
        let done = false;
        for (let i = 0; i < 3 && !done; i++) for (let j = 0; j < 3; j++) {
          const ax = A.x + ca * off[i], ay = A.y + sa * off[i], bx = B.x + cb * off[j], by = B.y + sb * off[j];
          let dx = ax - bx, dy = ay - by; const d = Math.hypot(dx, dy);
          if (d < R * 2 && d > 1e-4) {
            dx /= d; dy /= d; const ov = (R * 2 - d) * 0.5;
            A.x += dx * ov; A.y += dy * ov; B.x -= dx * ov; B.y -= dy * ov;
            const vn = (A.vx - B.vx) * dx + (A.vy - B.vy) * dy;
            if (vn < 0) {
              const jn = -(1 + 0.25) * vn * 0.5;
              A.vx += dx * jn; A.vy += dy * jn; B.vx -= dx * jn; B.vy -= dy * jn;
              A.vx *= 0.995; A.vy *= 0.995; B.vx *= 0.995; B.vy *= 0.995;
              if (-vn > 30) this.sparks((ax + bx) / 2, (ay + by) / 2, Math.min(9, -vn / 14));
            }
            done = true; break;
          }
        }
      }
    }

    sparks(x, y, n) {
      if (this.particles.list.length > 260) return;
      this.particles.burst(x, y, Math.max(2, n | 0), { speed: 240, speedMin: 60, life: 0.45, size: 2.4, color: ['#ffd27a', '#ff9d4a', '#fff1c8'], drag: 3 });
    }

    updateDraft(dt) {
      const cars = this.cars;
      for (const c of cars) { c.wakeT = 0; }
      for (const c of cars) {
        let tgt = 0;
        const cs = Math.cos(c.th), sn = Math.sin(c.th);
        for (const o of cars) {
          if (o === c) continue;
          const dx = o.x - c.x, dy = o.y - c.y, f = dx * cs + dy * sn, l = -dx * sn + dy * cs;
          if (f > 22 && f < 170 && Math.abs(l) < 20 && Math.hypot(o.vx, o.vy) > 110) {
            const q = (1 - (f - 22) / 148) * (1 - Math.abs(l) / 24);
            if (q > tgt) tgt = q;
            o.wakeT = Math.max(o.wakeT, q);
          }
        }
        c.draft += (tgt - c.draft) * Math.min(1, dt * 5);
      }
      for (const c of cars) c.wake += (c.wakeT - c.wake) * Math.min(1, dt * 5);
    }

    updateRanks() {
      const arr = this.cars.slice().sort((a, b) => {
        if (a.finished !== b.finished) return a.finished ? -1 : 1;
        if (a.finished) return a.place - b.place;
        return b.prog - a.prog;
      });
      arr.forEach((c, i) => c.rank = i + 1);
      this.order = arr;
    }

    updateMarksAndFx(dt, racing) {
      const T = this.T;
      for (const c of this.cars) {
        const cs = Math.cos(c.th), sn = Math.sin(c.th);
        const rx = c.x - cs * 15, ry = c.y - sn * 15;
        const w = [rx - sn * 8, ry + cs * 8, rx + sn * 8, ry - cs * 8];
        const skid = racing && !c.grass && (c.slip > 26 || (c.brk > 0.85 && Math.hypot(c.vx, c.vy) > 195));
        if (skid && c.wl) {
          for (let k = 0; k < 2; k++) {
            const o = this.markHead * 5; this.markHead = (this.markHead + 1) % 1400; this.markN = Math.min(1400, this.markN + 1);
            const m = this.marks; m[o] = c.wl[k * 2]; m[o + 1] = c.wl[k * 2 + 1]; m[o + 2] = w[k * 2]; m[o + 3] = w[k * 2 + 1]; m[o + 4] = this.t;
          }
        }
        c.wl = w;
        const sp = Math.hypot(c.vx, c.vy);
        if (c.grass && sp > 90 && this.particles.list.length < 200 && Math.random() < 0.7) {
          this.particles.burst(rx, ry, 1, { speed: 60, speedMin: 20, life: 0.5, size: 3, color: ['#2e6a45', '#3a8456', '#6b5b3c'], drag: 2 });
        }
        if (skid && Math.random() < 0.3 && this.particles.list.length < 200) this.particles.burst(rx, ry, 1, { speed: 25, speedMin: 5, life: 0.6, size: 4, color: 'rgba(210,215,235,0.35)', drag: 2 });
      }
    }

    // ---------------------------------------------------------------- hud / result
    hud() {
      const m = this.me;
      const rt = Math.max(0, (this.over ? (this.finishAt ?? this.t - GO_T) : this.t - GO_T));
      const lap = Math.min(LAPS, Math.max(1, Math.floor(Math.max(0, m.prog) / this.T.L) + 1));
      const place = this.over && this.aiPlace ? this.aiPlace : m.rank;
      return { score: 'P' + place + ' / 6', detail: this.t < GO_T ? 'On the grid' : 'Lap ' + lap + '/' + LAPS + ' · ' + fmtTime(rt) };
    }
    result() { return this.result0() + ' (' + this.style + ')'; }
    result0() {
      if (this.timeout || !this.aiPlace) return 'Out of time on the ' + this.T.name;
      const t = fmtTime(this.finishAt);
      if (this.aiPlace === 1) return 'Won the ' + LAPS + '-lap race at ' + this.T.name + ' in ' + t;
      const gap = Math.max(0, this.finishAt - this.winnerT).toFixed(1);
      return 'Finished ' + ordinal(this.aiPlace) + ' of 6, ' + gap + ' s behind the winner';
    }

    // ---------------------------------------------------------------- drawing
    draw(ctx, W, H) {
      const a = Arcade.alpha === undefined ? 1 : clamp(Arcade.alpha, 0, 1);
      const T = this.T, cam = this.cam;
      const cx = lerp(cam.px, cam.x, a), cy = lerp(cam.py, cam.y, a), ca = lerpA(cam.pa, cam.a, a);
      const zoom = this.baseZoom * lerp(this.pzk, this.zk, a);
      const tNow = this.t + a / 60;
      ctx.fillStyle = '#070b14'; ctx.fillRect(0, 0, W, H);
      const fx = Math.cos(ca), fy = Math.sin(ca);
      const viewR = Math.hypot(W, H) / (2 * zoom) + 0.12 * H / zoom + 60;
      const vcx = cx + fx * 0.1 * H / zoom, vcy = cy + fy * 0.1 * H / zoom;
      ctx.save();
      ctx.translate(W / 2, H * 0.58); ctx.scale(zoom, zoom); ctx.rotate(-PI / 2 - ca); ctx.translate(-cx, -cy);
      // ground (city blocks beyond the circuit)
      ctx.fillStyle = ctx.createPattern(ASSETS.ground, 'repeat');
      ctx.fillRect(vcx - viewR, vcy - viewR, viewR * 2, viewR * 2);
      // visible chunks
      const vis = [];
      for (const ch of T.chunks) { const dx = ch.x - vcx, dy = ch.y - vcy, r = viewR + ch.r; if (dx * dx + dy * dy < r * r) vis.push(ch); }
      if (!this.pats) this.pats = { grass: ctx.createPattern(ASSETS.grass, 'repeat'), asphalt: ctx.createPattern(ASSETS.asphalt, 'repeat') };
      ctx.fillStyle = this.pats.grass; for (const ch of vis) ctx.fill(ch.grass);
      // barrier
      ctx.lineJoin = 'round'; ctx.lineCap = 'round';
      ctx.strokeStyle = '#1b2437'; ctx.lineWidth = 11; for (const ch of vis) ctx.stroke(ch.barrier);
      ctx.strokeStyle = 'rgba(225,232,250,0.55)'; ctx.lineWidth = 6; ctx.setLineDash([10, 10]); for (const ch of vis) ctx.stroke(ch.barrier);
      ctx.setLineDash([]);
      ctx.strokeStyle = 'rgba(120,170,255,0.18)'; ctx.lineWidth = 20; for (const ch of vis) ctx.stroke(ch.barrier);
      // kerbs
      ctx.fillStyle = '#d83a3f'; for (const ch of vis) ctx.fill(ch.kerbR);
      ctx.fillStyle = '#ecebe8'; for (const ch of vis) ctx.fill(ch.kerbW);
      // asphalt
      ctx.fillStyle = this.pats.asphalt; for (const ch of vis) ctx.fill(ch.asphalt);
      ctx.lineCap = 'butt'; ctx.lineJoin = 'round';
      // wet sheen along the driving lane
      ctx.strokeStyle = 'rgba(110,140,200,0.045)'; ctx.lineWidth = HW * 1.1; for (const ch of vis) ctx.stroke(ch.center);
      // lamp reflections on the road
      ctx.globalCompositeOperation = 'lighter';
      for (const l of T.lamps) {
        const dx = l.bx - vcx, dy = l.by - vcy; if (dx * dx + dy * dy > (viewR + 200) * (viewR + 200)) continue;
        const sp = ASSETS.bloom[l.col];
        ctx.save(); ctx.translate(l.bx, l.by); ctx.rotate(l.ang); ctx.globalAlpha = 0.5; ctx.scale(1.7, 1); ctx.drawImage(sp, -105, -105, 210, 210); ctx.restore();
      }
      ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
      // lane markings
      ctx.strokeStyle = 'rgba(190,225,255,0.07)'; ctx.lineWidth = 10; for (const ch of vis) ctx.stroke(ch.edges);
      ctx.strokeStyle = 'rgba(235,242,255,0.8)'; ctx.lineWidth = 2.6; for (const ch of vis) ctx.stroke(ch.edges);
      ctx.setLineDash([T.dashP * 0.42, T.dashP * 0.58]);
      ctx.strokeStyle = 'rgba(120,230,255,0.16)'; ctx.lineWidth = 8; for (const ch of vis) ctx.stroke(ch.center);
      ctx.strokeStyle = 'rgba(150,235,255,0.55)'; ctx.lineWidth = 2.4; for (const ch of vis) ctx.stroke(ch.center);
      ctx.setLineDash([]);
      this.drawStart(ctx, T);
      this.drawMarks(ctx, vcx, vcy, viewR, tNow);
      // cars
      const order = this.cars.slice().sort((p, q) => (p.isAI ? 1 : 0) - (q.isAI ? 1 : 0));
      for (const c of order) this.drawCar(ctx, c, a, tNow);
      this.particles.draw(ctx, 1);
      // overhead lamps
      ctx.globalCompositeOperation = 'lighter';
      for (const l of T.lamps) {
        const dx = l.x - vcx, dy = l.y - vcy; if (dx * dx + dy * dy > (viewR + 120) * (viewR + 120)) continue;
        const sp = ASSETS.bloom[l.col];
        ctx.globalAlpha = 0.9; ctx.drawImage(sp, l.x - 60, l.y - 60, 120, 120);
        ctx.globalAlpha = 1; ctx.drawImage(ASSETS.bloom['#ffffff'], l.x - 11, l.y - 11, 22, 22);
      }
      ctx.globalCompositeOperation = 'source-over';
      ctx.restore();
      this.drawScreenFx(ctx, W, H, tNow);
      this.drawUI(ctx, W, H, a, tNow);
    }

    drawStart(ctx, T) {
      const x0 = T.cx[0], y0 = T.cy[0], th = Math.atan2(T.ty[0], T.tx[0]);
      ctx.save(); ctx.translate(x0, y0); ctx.rotate(th);
      // checkered line
      const cell = 8, rows = 2, cols = Math.round(2 * HW / cell);
      for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) { ctx.fillStyle = (r + c) & 1 ? '#f2f4fa' : '#10131c'; ctx.fillRect(-rows * cell / 2 + r * cell, -HW + c * cell, cell, cell); }
      // gantry
      ctx.fillStyle = 'rgba(0,0,0,0.35)'; ctx.fillRect(-16, -HW - KERB - 18, 22, 2 * (HW + KERB + 18));
      ctx.fillStyle = '#222b3f'; ctx.fillRect(-20, -HW - KERB - 14, 14, 2 * (HW + KERB + 14));
      ctx.fillStyle = '#394764'; ctx.fillRect(-20, -HW - KERB - 14, 3, 2 * (HW + KERB + 14));
      // lights
      for (let k = 0; k < 3; k++) {
        const on = this.light > k, go = this.light >= 4;
        const col = go ? '#4dffa6' : '#ff3a3a';
        ctx.fillStyle = on || go ? col : '#2b1a1f';
        for (const sy of [-1, 1]) { ctx.beginPath(); ctx.arc(-13, sy * (22 + k * 22) , 6, 0, TAU); ctx.fill(); }
        if (on || go) {
          ctx.globalCompositeOperation = 'lighter'; ctx.globalAlpha = 0.9;
          for (const sy of [-1, 1]) ctx.drawImage(ASSETS.bloom[go ? '#7fe3ff' : '#ff4b4b'], -13 - 28, sy * (22 + k * 22) - 28, 56, 56);
          ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
        }
      }
      // grandstand
      const gs = HW + BAR + 4;
      ctx.fillStyle = '#10141f'; roundRect(ctx, -190, gs, 380, 70, 6); ctx.fill();
      ctx.fillStyle = '#1b2234'; roundRect(ctx, -190, gs + 6, 380, 58, 4); ctx.fill();
      for (const p of T.crowd) { ctx.fillStyle = p[2]; ctx.globalAlpha = 0.75; ctx.fillRect(p[0], gs + 35 + p[1], p[3], p[3]); }
      ctx.globalAlpha = 1;
      ctx.restore();
    }

    drawMarks(ctx, vcx, vcy, viewR, tNow) {
      if (!this.markN) return;
      const m = this.marks, R2 = viewR * viewR;
      ctx.lineCap = 'round'; ctx.lineWidth = 2.6;
      const levels = [[4, 0.5], [9, 0.3], [15, 0.14]];
      let lo = -1;
      for (const [maxAge, al] of levels) {
        ctx.strokeStyle = `rgba(4,6,10,${al})`; ctx.beginPath();
        let any = false;
        for (let k = 0; k < this.markN; k++) {
          const o = k * 5, age = tNow - m[o + 4];
          if (age < 0 || age >= maxAge || age < lo) continue;
          const dx = m[o] - vcx, dy = m[o + 1] - vcy; if (dx * dx + dy * dy > R2) continue;
          ctx.moveTo(m[o], m[o + 1]); ctx.lineTo(m[o + 2], m[o + 3]); any = true;
        }
        if (any) ctx.stroke();
        lo = maxAge;
      }
    }

    drawCar(ctx, c, a, tNow) {
      const x = lerp(c.px, c.x, a), y = lerp(c.py, c.y, a), th = lerpA(c.pth, c.th, a);
      const sp = Math.hypot(c.vx, c.vy);
      ctx.save(); ctx.translate(x, y); ctx.rotate(th);
      // shadow
      ctx.fillStyle = 'rgba(0,0,0,0.38)'; roundRect(ctx, -22, -11 + 4, 46, 24, 10); ctx.fill();
      // slipstream wake
      if (c.wake > 0.05) {
        ctx.strokeStyle = `rgba(210,235,255,${0.35 * c.wake})`; ctx.lineWidth = 1.6; ctx.lineCap = 'round'; ctx.beginPath();
        for (let k = -1; k <= 1; k++) { const w = Math.sin(tNow * 9 + k * 2) * 2; ctx.moveTo(-26, k * 7 + w); ctx.lineTo(-26 - 70 * c.wake - 20, k * 7 + w * 2); }
        ctx.stroke();
      }
      ctx.globalCompositeOperation = 'lighter';
      // headlight cone
      ctx.globalAlpha = c.isAI ? 0.85 : 0.6; ctx.drawImage(ASSETS.cone, 18, -80, 230, 160);
      // tail lights / brake lights
      const br = 0.45 + c.brk * 0.9;
      ctx.globalAlpha = Math.min(1, br);
      ctx.drawImage(ASSETS.bloom['#ff4b4b'], -37, -22, 28, 28); ctx.drawImage(ASSETS.bloom['#ff4b4b'], -37, -6, 28, 28);
      ctx.globalAlpha = 0.28 + c.brk * 0.3; ctx.strokeStyle = '#ff4b4b'; ctx.lineWidth = 2.4; ctx.lineCap = 'round';
      ctx.beginPath(); const tl = 8 + sp * 0.06; for (const sy of [-6.5, 6.5]) { ctx.moveTo(-24, sy); ctx.lineTo(-24 - tl, sy); } ctx.stroke();
      if (c.isAI) { ctx.globalAlpha = 0.28 + 0.07 * Math.sin(tNow * 3); ctx.drawImage(ASSETS.bloom['#ffb25a'], -42, -42, 84, 84); }
      ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
      const spr = carSprite(c.color);
      ctx.drawImage(spr, -32, -18, 64, 36);
      ctx.restore();
    }

    drawScreenFx(ctx, W, H, tNow) {
      // rain
      ctx.strokeStyle = 'rgba(175,205,255,0.13)'; ctx.lineWidth = 1; ctx.beginPath();
      const len = 14 * Math.max(0.6, H / 900);
      for (const r of this.rainSeed) {
        const x = ((r[0] * W * 1.2 + tNow * 90 * r[2]) % (W * 1.2)) - W * 0.1;
        const y = ((r[1] * H + tNow * 760 * r[2]) % (H + 40)) - 20;
        ctx.moveTo(x, y); ctx.lineTo(x - len * 0.12, y + len);
      }
      ctx.stroke();
      // vignette
      const g = ctx.createRadialGradient(W / 2, H * 0.55, Math.min(W, H) * 0.35, W / 2, H * 0.55, Math.hypot(W, H) * 0.62);
      g.addColorStop(0, 'rgba(3,5,10,0)'); g.addColorStop(1, 'rgba(3,5,10,0.62)');
      ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
    }

    drawUI(ctx, W, H, a, tNow) {
      const u = clamp(Math.min(W, H) / 900, 0.7, 1.7), m = this.me, T = this.T;
      const FONT = '"IBM Plex Mono", monospace', DISP = '"Big Shoulders Display", Impact, sans-serif';
      ctx.save();
      ctx.textBaseline = 'middle';
      // standings (top-left)
      const px = 18 * u, py = 18 * u, rh = 25 * u, pw = 168 * u;
      ctx.fillStyle = 'rgba(7,10,18,0.58)'; roundRect(ctx, px, py, pw, rh * 6 + 12 * u, 10 * u); ctx.fill();
      const ord = this.order || this.cars;
      ord.forEach((c, i) => {
        const y = py + 6 * u + rh * i + rh / 2;
        if (c.isAI) { ctx.fillStyle = 'rgba(255,176,46,0.16)'; roundRect(ctx, px + 4 * u, y - rh / 2 + 1, pw - 8 * u, rh - 2, 6 * u); ctx.fill(); }
        ctx.fillStyle = 'rgba(235,238,248,0.7)'; ctx.font = `600 ${13 * u}px ${FONT}`; ctx.textAlign = 'left';
        ctx.fillText(String(i + 1), px + 12 * u, y);
        ctx.fillStyle = c.color; roundRect(ctx, px + 30 * u, y - 5 * u, 16 * u, 10 * u, 4 * u); ctx.fill();
        ctx.fillStyle = c.isAI ? '#ffd48a' : 'rgba(235,238,248,0.88)'; ctx.font = `800 ${15 * u}px ${DISP}`;
        ctx.fillText(c.name, px + 54 * u, y + 1);
        if (c.finished) { ctx.textAlign = 'right'; ctx.font = `600 ${11 * u}px ${FONT}`; ctx.fillStyle = 'rgba(235,238,248,0.6)'; ctx.fillText(c.place === 1 ? fmtTime(c.finishT) : '+' + Math.max(0, c.finishT - this.winnerT).toFixed(1), px + pw - 10 * u, y); }
      });
      // lap counter (top center)
      const lap = Math.min(LAPS, Math.max(1, Math.floor(Math.max(0, m.prog) / T.L) + 1));
      ctx.textAlign = 'center';
      ctx.fillStyle = 'rgba(7,10,18,0.5)'; roundRect(ctx, W / 2 - 78 * u, 16 * u, 156 * u, 40 * u, 12 * u); ctx.fill();
      ctx.fillStyle = 'rgba(240,243,250,0.92)'; ctx.font = `800 ${24 * u}px ${DISP}`;
      ctx.fillText('LAP ' + lap + ' / ' + LAPS, W / 2, 37 * u);
      // minimap (bottom-right)
      const mn = this.mini, mx = W - mn.w - 20 * u, my = H - mn.h - 20 * u;
      ctx.fillStyle = 'rgba(7,10,18,0.62)'; roundRect(ctx, mx - 6 * u, my - 6 * u, mn.w + 12 * u, mn.h + 12 * u, 12 * u); ctx.fill();
      ctx.translate(mx, my);
      ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      ctx.strokeStyle = '#2a3550'; ctx.lineWidth = 7; ctx.stroke(mn.path);
      ctx.strokeStyle = '#6f7fa6'; ctx.lineWidth = 2.2; ctx.stroke(mn.path);
      const sx = T.cx[0] * mn.sc + mn.ox, sy = T.cy[0] * mn.sc + mn.oy;
      ctx.fillStyle = '#fff'; ctx.fillRect(sx - 1.5, sy - 5, 3, 10);
      for (const c of this.cars) {
        if (c.isAI) continue;
        ctx.fillStyle = c.color; ctx.beginPath(); ctx.arc(lerp(c.px, c.x, a) * mn.sc + mn.ox, lerp(c.py, c.y, a) * mn.sc + mn.oy, 3.4, 0, TAU); ctx.fill();
      }
      const ax = lerp(m.px, m.x, a) * mn.sc + mn.ox, ay = lerp(m.py, m.y, a) * mn.sc + mn.oy;
      ctx.fillStyle = 'rgba(255,176,46,0.3)'; ctx.beginPath(); ctx.arc(ax, ay, 8 + Math.sin(tNow * 4) * 1.2, 0, TAU); ctx.fill();
      ctx.fillStyle = AI_COLOR; ctx.beginPath(); ctx.arc(ax, ay, 4.6, 0, TAU); ctx.fill();
      ctx.translate(-mx, -my);
      // telemetry (bottom center)
      const sp = Math.hypot(m.vx, m.vy), kmh = Math.round(sp * 0.8);
      const tw = 190 * u, tx = W / 2 - tw / 2, ty = H - 66 * u;
      ctx.fillStyle = 'rgba(7,10,18,0.5)'; roundRect(ctx, tx, ty, tw, 50 * u, 12 * u); ctx.fill();
      ctx.textAlign = 'left'; ctx.fillStyle = 'rgba(245,247,252,0.95)'; ctx.font = `600 ${26 * u}px ${FONT}`;
      ctx.fillText(String(kmh).padStart(3, ' '), tx + 12 * u, ty + 22 * u);
      ctx.fillStyle = 'rgba(200,208,226,0.6)'; ctx.font = `600 ${11 * u}px ${FONT}`; ctx.fillText('KM/H', tx + 66 * u, ty + 24 * u);
      const bx = tx + 108 * u, bw = 70 * u;
      ctx.fillStyle = 'rgba(255,255,255,0.1)'; ctx.fillRect(bx, ty + 12 * u, bw, 5 * u); ctx.fillRect(bx, ty + 22 * u, bw, 5 * u); ctx.fillRect(bx, ty + 33 * u, bw, 5 * u);
      ctx.fillStyle = '#7ee0a8'; ctx.fillRect(bx, ty + 12 * u, bw * m.thr, 5 * u);
      ctx.fillStyle = '#ff6b6b'; ctx.fillRect(bx, ty + 22 * u, bw * m.brk, 5 * u);
      ctx.fillStyle = '#ffb02e'; const sv = m.steer; ctx.fillRect(bx + bw / 2, ty + 33 * u, bw / 2 * sv, 5 * u);
      // countdown / go
      if (this.t < GO_T + 0.9) {
        const k = this.t < GO_T ? 3 - Math.min(2, Math.floor((this.t - 0.8) / 0.9)) : 0;
        let txt = '', al = 1;
        if (this.t < 0.8) txt = '';
        else if (this.t < GO_T) { txt = String(k); al = 1 - ((this.t - 0.8) % 0.9) / 0.9 * 0.4; }
        else { txt = 'GO'; al = 1 - (this.t - GO_T) / 0.9; }
        if (txt) {
          ctx.globalAlpha = Math.max(0, al); ctx.fillStyle = this.t >= GO_T ? '#6dffb0' : '#f5f7fc'; ctx.font = `800 ${130 * u}px ${DISP}`; ctx.textAlign = 'center';
          ctx.fillText(txt, W / 2, H * 0.3); ctx.globalAlpha = 1;
        }
      }
      // finish banner
      if (this.over && this.aiPlace) {
        const k = ease.outBack(Math.min(1, this.overT / 0.6));
        ctx.globalAlpha = Math.min(1, this.overT * 3); ctx.textAlign = 'center';
        ctx.save(); ctx.translate(W / 2, H * 0.3); ctx.scale(0.6 + 0.4 * k, 0.6 + 0.4 * k);
        ctx.fillStyle = this.aiPlace === 1 ? '#ffd27a' : '#e6e9f4'; ctx.font = `800 ${120 * u}px ${DISP}`; ctx.fillText(this.aiPlace === 1 ? 'WINNER' : 'P' + this.aiPlace, 0, 0);
        ctx.font = `600 ${22 * u}px ${FONT}`; ctx.fillStyle = 'rgba(235,240,255,0.8)'; ctx.fillText(fmtTime(this.finishAt), 0, 70 * u);
        ctx.restore(); ctx.globalAlpha = 1;
      }
      ctx.restore();
    }
  }

  Arcade.register({
    id: 'racing',
    name: 'Slipstream',
    genre: 'Top-down racing',
    aiNote: 'Drives a racing line it works out from the track, steering a rate-limited wheel within tyre grip, and passes by shifting the line.',
    blurb: 'Six cars, three laps of a rain-slick night circuit. Tuck into the slipstream, then pull out and pass.',
    bg: '#0b1020',
    accent: '#ffb02e',
    create() { return new RacingGame(); },
  });
})();
