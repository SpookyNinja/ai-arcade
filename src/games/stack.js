// stack.js — Skyline Stack (isometric stacking-timing game).
// A slab slides back and forth over the tower; tap to drop it, the overhang is cut off.
// The AI (see "THE AI") only sees the moving slab's position and the slab below it, and taps with
// honest human timing noise (Gaussian, sigma = 14 ms).
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


  const WIN_FLOORS = 80;
  const RANGE = 1.3;            // slab travels +-RANGE around the centre of the slab below
  const START_SPEED = 1.1, SPEED_STEP = 0.036;
  const PERFECT_EPS = 0.025;
  const HF = 0.2;               // slab thickness in world units
  const CAP_SECONDS = 360;
  const FONT = '600 22px Fredoka, "Trebuchet MS", sans-serif';

  const hueOf = f => (205 + f * 6.5) % 360;

  // =====================================================================================
  // THE AI. obs = { sinceSpawn, rel, prevRel } where rel is the moving slab's centre offset from the
  // centre of the slab below, along its sliding axis (both visible on screen). Speed is estimated from
  // two successive observations. The AI schedules a tap for the moment the slab centre crosses the
  // tower centre, with Gaussian motor-timing error (sigma 14 ms). Nothing else is known.
  // =====================================================================================
  const SIGMA_T = 0.014, MIN_WATCH = 1.0;
  // Styles differ in motor-noise profile and in how early the tap is released relative to the crossing.
  const STYLES = {
    'Metronome': { sigma: 0.014, bias: 0, watch: 1.0 },
    'Anticipator': { sigma: 0.0135, bias: 0.002, watch: 0.7 },
    'Patient hand': { sigma: 0.011, bias: -0.004, watch: 1.6 },
  };
  const AI = {
    st: STYLES['Metronome'],
    reset() { this.tapAt = null; this.v = 0; this.prev = null; },
    // returns the absolute game time at which to tap, or null for "not yet"
    plan(obs, t, dt) {
      if (this.tapAt != null) return this.tapAt;
      if (this.prev == null) { this.prev = obs.rel; return null; }
      const dv = obs.rel - this.prev; this.prev = obs.rel;
      if (Math.abs(obs.rel) < RANGE - 0.15) this.v = Math.abs(dv) / dt;
      if (this.v < 0.2) return null;
      const dir = dv >= 0 ? 1 : -1;
      // time until the slab centre crosses the tower centre, bouncing at +-RANGE
      let tau;
      if (dir * obs.rel < 0) tau = -obs.rel * dir / this.v;               // heading toward the centre
      else tau = ((RANGE - Math.abs(obs.rel)) + RANGE) / this.v;          // goes out to the end and back
      const period = 2 * RANGE / this.v;
      // a human watches the slab a moment before committing: take the first crossing after MIN_WATCH
      while (obs.sinceSpawn + tau < this.st.watch) tau += period;
      this.tapAt = t + Math.max(0, tau - this.st.bias + rnd.gauss() * this.st.sigma);
      return this.tapAt;
    },
  };

  function create(opts = {}) {
    const superAI = !!opts.superAI;
    // Super AI: no motor-timing error, no bias, no "watch first" delay; taps at the exact crossing time
    const style = superAI ? 'Super AI' : rnd.pick(Object.keys(STYLES));
    AI.st = superAI ? { sigma: 0, bias: 0, watch: 0 } : STYLES[style];
    let W = 800, H = 600, S = 200;
    const slabs = [];             // {cx, cz, wx, wz, drop (anim t0), perfect}
    const debris = [];
    const rings = [];
    const texts = [];
    const P = new Particles();
    const clouds = [];
    for (let i = 0; i < 7; i++) clouds.push({ x: Math.random(), y: Math.random(), s: rnd.float(0.6, 1.4), v: rnd.float(0.004, 0.012), a: rnd.float(0.05, 0.11) });
    const g = { over: false, won: false, t: 0, endT: 0, streak: 0, best: 0, perfects: 0, floors: 0, reason: '', lossFloor: 0 };
    let cam = { y: 0, x: 0, z: 0, zoom: 1 };
    let mv = null;                // moving slab
    let tapReq = null;            // scheduled tap time
    let shake = 0, bgHue = hueOf(0);

    function speedFor(n) { return START_SPEED + SPEED_STEP * n; }
    // starting slab (floor 0)
    slabs.push({ cx: 0, cz: 0, wx: 1, wz: 1, dropT: -9 });
    cam.y = HF;

    function spawn() {
      const n = slabs.length;                // floor index of the new slab
      const top = slabs[n - 1];
      const axis = n % 2 === 1 ? 'x' : 'z';
      const side = Math.random() < 0.5 ? -1 : 1;
      mv = { axis, pos: side * RANGE, dir: -side, w: axis === 'x' ? top.wx : top.wz, d: axis === 'x' ? top.wz : top.wx, floor: n, born: g.t, delay: 0.42 };
      AI.reset(); tapReq = null;
    }
    spawn();

    // --- projection ---
    const proj = (x, y, z) => [W / 2 + ((x - cam.x) - (z - cam.z)) * 0.866 * S * cam.zoom, H * 0.47 + (((x - cam.x) + (z - cam.z)) * 0.5 * S - (y - cam.y) * S) * cam.zoom];

    function place(tTap) {
      const n = slabs.length, top = slabs[n - 1];
      const ax = mv.axis;
      // slab position at the exact moment of the tap (taps are continuous in time, not tick-quantised)
      let delta = mv.pos - mv.dir * speedFor(g.floors) * (g.t - tTap);
      delta = clamp(delta, -RANGE, RANGE);
      const topC = ax === 'x' ? top.cx : top.cz, topW = ax === 'x' ? top.wx : top.wz;
      let newW = topW, center = topC;
      let perfect = Math.abs(delta) < PERFECT_EPS;
      const nsl = { cx: top.cx, cz: top.cz, wx: top.wx, wz: top.wz, dropT: g.t, perfect };
      const y0 = n * HF;
      if (!perfect) {
        const overlap = topW - Math.abs(delta);
        if (overlap <= 0) {
          // complete miss: the slab falls away
          g.over = true; g.won = false; g.lossFloor = g.floors; g.reason = 'Missed the tower'; g.endT = 0;
          const slabC = topC + delta;
          addDebris(ax === 'x' ? slabC : top.cx, ax === 'z' ? slabC : top.cz, ax === 'x' ? topW : top.wx, ax === 'z' ? topW : top.wz, y0, n, Math.sign(delta) || 1, ax);
          shake = 1;
          mv = null; return;
        }
        center = topC + delta / 2;
        newW = overlap;
        // overhang piece
        const cutW = Math.abs(delta);
        const cutC = delta > 0 ? topC + topW / 2 + cutW / 2 : topC - topW / 2 - cutW / 2;
        addDebris(ax === 'x' ? cutC : top.cx, ax === 'z' ? cutC : top.cz, ax === 'x' ? cutW : top.wx, ax === 'z' ? cutW : top.wz, y0, n, Math.sign(delta), ax);
        g.streak = 0;
        shake = Math.max(shake, 0.35);
      } else {
        g.streak++; g.perfects++; if (g.streak > g.best) g.best = g.streak;
        center = topC;
        if (g.streak % 5 === 0) {
          nsl.wx = Math.min(1, nsl.wx + 0.05); nsl.wz = Math.min(1, nsl.wz + 0.05);
          if (ax === 'x') newW = nsl.wx; else newW = nsl.wz;
          nsl.grown = true;
        }
        const ring = { n, t0: g.t, dur: 0.8, streak: g.streak };
        rings.push(ring); rings.push({ n, t0: g.t + 0.12, dur: 0.8, streak: g.streak });
        const hy = n * HF + HF;
        texts.push({ x: nsl.cx, z: nsl.cz, y: hy + 0.1, t0: g.t, text: g.streak >= 2 ? `PERFECT x${g.streak}` : 'PERFECT', hue: hueOf(n) });
        sparkle(nsl.cx, hy, nsl.cz, 14 + Math.min(20, g.streak * 2), n);
      }
      if (ax === 'x') { nsl.cx = center; nsl.wx = newW; }
      else { nsl.cz = center; nsl.wz = newW; }
      slabs.push(nsl);
      g.floors = slabs.length - 1;
      dust(nsl, n);
      if (g.floors >= WIN_FLOORS) { g.over = true; g.won = true; g.endT = 0; mv = null; celebrate(); return; }
      spawn();
    }

    function wp(x, y, z) { // world point -> "world px" (unzoomed, relative to camera origin) for particle space
      return [((x) - (z)) * 0.866 * S, ((x) + (z)) * 0.5 * S - y * S];
    }
    function sparkle(x, y, z, n, floor) {
      const [px, py] = wp(x, y, z);
      P.burst(px, py, n, { speed: S * 1.1, speedMin: S * 0.2, life: 1.0, size: S * 0.03, color: ['#ffffff', `hsl(${hueOf(floor)},90%,85%)`, '#fff3c4'], drag: 2.2, gravity: S * 0.5 });
    }
    function dust(sl, n) {
      const y = n * HF + HF * 0.5;
      for (const [x, z] of [[sl.cx + sl.wx / 2, sl.cz], [sl.cx - sl.wx / 2, sl.cz], [sl.cx, sl.cz + sl.wz / 2], [sl.cx, sl.cz - sl.wz / 2]]) {
        const [px, py] = wp(x, y, z);
        P.burst(px, py, 2, { speed: S * 0.35, speedMin: S * 0.1, life: 0.55, size: S * 0.035, color: `hsla(${hueOf(n)},60%,88%,0.8)`, drag: 3 });
      }
    }
    function celebrate() {
      const top = slabs[slabs.length - 1];
      const hy = slabs.length * HF;
      for (let k = 0; k < 6; k++) sparkle(top.cx + rnd.float(-1, 1), hy + rnd.float(0, 1.2), top.cz + rnd.float(-1, 1), 30, rnd.int(80));
    }
    function addDebris(cx, cz, wx, wz, y0, n, sgn, ax) {
      debris.push({
        cx, cz, wx, wz, y: y0, vy: 0.2, vx: ax === 'x' ? sgn * 0.5 : 0, vz: ax === 'z' ? sgn * 0.5 : 0,
        rot: 0, vr: sgn * rnd.float(0.6, 1.4) * (Math.random() < 0.5 ? 1 : -1), t0: g.t, hue: hueOf(n), n,
      });
    }

    // ---------------- drawing ----------------
    function face(ctx, pts, fill) {
      ctx.beginPath(); ctx.moveTo(pts[0][0], pts[0][1]);
      for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
      ctx.closePath(); ctx.fillStyle = fill; ctx.fill();
    }
    function box(ctx, cx, cz, wx, wz, y0, y1, hue, alpha, opt = {}) {
      const x0 = cx - wx / 2, x1 = cx + wx / 2, z0 = cz - wz / 2, z1 = cz + wz / 2;
      const a = proj(x0, y1, z0), b = proj(x1, y1, z0), c = proj(x1, y1, z1), d = proj(x0, y1, z1);
      const e = proj(x0, y0, z1), f = proj(x1, y0, z1), gg = proj(x1, y0, z0);
      const sat = opt.sat ?? 55;
      ctx.globalAlpha = alpha;
      // left face (+z side)
      face(ctx, [d, c, f, e], `hsl(${hue},${sat - 8}%,${opt.l ?? 66}%)`);
      // right face (+x side)
      face(ctx, [c, b, gg, f], `hsl(${hue},${sat - 12}%,${(opt.l ?? 66) - 13}%)`);
      // top
      face(ctx, [a, b, c, d], `hsl(${hue},${sat + 6}%,${(opt.l ?? 66) + 13}%)`);
      // crisp edges
      ctx.lineWidth = Math.max(1, S * 0.008); ctx.strokeStyle = 'rgba(255,255,255,0.35)';
      ctx.beginPath(); ctx.moveTo(d[0], d[1]); ctx.lineTo(c[0], c[1]); ctx.lineTo(b[0], b[1]); ctx.stroke();
      ctx.strokeStyle = 'rgba(0,0,0,0.12)';
      ctx.beginPath(); ctx.moveTo(c[0], c[1]); ctx.lineTo(f[0], f[1]); ctx.stroke();
      ctx.globalAlpha = 1;
    }

    function draw(ctx, w, h) {
      const z = cam.zoom;
      const topF = slabs.length - 1;
      const hf = cam.y / HF;                         // camera floor (float)
      const hue = (hueOf(hf) + 360) % 360;
      // --- background
      liveLayer(ctx, 'bg', W, H, 8, (x, W, H) => { // smooth gradients: repainted at 1/8 resolution
        const g1 = x.createLinearGradient(0, 0, 0, H);
        g1.addColorStop(0, `hsl(${hue + 18},38%,33%)`); g1.addColorStop(0.55, `hsl(${hue},34%,25%)`); g1.addColorStop(1, `hsl(${hue - 14},30%,15%)`);
        x.fillStyle = g1; x.fillRect(0, 0, W, H);
        const glow = x.createRadialGradient(W / 2, H * 0.3, 0, W / 2, H * 0.3, Math.max(W, H) * 0.7);
        glow.addColorStop(0, `hsla(${hue + 25},60%,60%,0.16)`); glow.addColorStop(1, `hsla(${hue},50%,40%,0)`);
        x.fillStyle = glow; x.fillRect(0, 0, W, H);
      });
      // clouds (parallax with camera height)
      for (const c of clouds) {
        const cx = ((c.x * 1.4 - 0.2) * W), cy = ((c.y + hf * 0.0035 * c.s) % 1.2 - 0.1) * H;
        const r = S * 0.55 * c.s;
        ctx.fillStyle = `rgba(255,255,255,${c.a})`;
        ctx.beginPath();
        for (const [dx, dy, rx, ry] of [[0, 0, 1.5, 0.4], [-0.7, 0.1, 1, 0.32], [0.8, 0.12, 0.9, 0.3], [0.1, -0.12, 0.8, 0.3]]) {
          ctx.moveTo(cx + dx * r + r * rx, cy + dy * r); ctx.ellipse(cx + dx * r, cy + dy * r, r * rx, r * ry, 0, 0, TAU);
        }
        ctx.fill();
      }
      ctx.save();
      if (shake > 0) { const a = shake * shake * 5; ctx.translate(Math.sin(g.t * 85) * a, Math.cos(g.t * 70) * a); }

      // --- tower, bottom to top
      const lowF = Math.max(0, Math.floor(hf - (H * 0.6) / (HF * S * z) - 2));
      // pedestal under floor 0
      if (lowF === 0) {
        const s0 = slabs[0];
        box(ctx, s0.cx, s0.cz, s0.wx, s0.wz, -40 * HF, 0, 215, 1, { sat: 18, l: 40 });
      }
      for (let f = lowF; f <= topF; f++) {
        const sl = slabs[f];
        let lift = 0;
        const e = g.t - sl.dropT;
        if (f > 0 && e < 0.2) lift = (1 - ease.outCubic(e / 0.2)) * HF * 0.55;
        box(ctx, sl.cx, sl.cz, sl.wx, sl.wz, f * HF + lift, (f + 1) * HF + lift, hueOf(f), 1);
      }
      // faint footprint guide on top of the tower (shows what the slab must align with)
      if (mv) {
        const top = slabs[topF];
        const y = (topF + 1) * HF;
        const a = proj(top.cx - top.wx / 2, y, top.cz - top.wz / 2), b = proj(top.cx + top.wx / 2, y, top.cz - top.wz / 2), c = proj(top.cx + top.wx / 2, y, top.cz + top.wz / 2), d = proj(top.cx - top.wx / 2, y, top.cz + top.wz / 2);
        ctx.setLineDash([6, 6]); ctx.strokeStyle = 'rgba(255,255,255,0.28)'; ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.lineTo(c[0], c[1]); ctx.lineTo(d[0], d[1]); ctx.closePath(); ctx.stroke(); ctx.setLineDash([]);
      }
      // perfect rings
      for (const r of rings) {
        const k = (g.t - r.t0) / r.dur; if (k < 0 || k > 1) continue;
        const sl = slabs[r.n]; if (!sl) continue;
        const y = (r.n + 1) * HF, ex = 0.04 + 0.34 * ease.outCubic(k);
        const a = proj(sl.cx - sl.wx / 2 - ex, y, sl.cz - sl.wz / 2 - ex), b = proj(sl.cx + sl.wx / 2 + ex, y, sl.cz - sl.wz / 2 - ex), c = proj(sl.cx + sl.wx / 2 + ex, y, sl.cz + sl.wz / 2 + ex), d = proj(sl.cx - sl.wx / 2 - ex, y, sl.cz + sl.wz / 2 + ex);
        ctx.strokeStyle = `rgba(255,255,255,${(1 - k) * 0.9})`; ctx.lineWidth = Math.max(2, S * 0.02) * (1 - k * 0.5); ctx.lineJoin = 'round';
        ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.lineTo(c[0], c[1]); ctx.lineTo(d[0], d[1]); ctx.closePath(); ctx.stroke();
      }
      // moving slab
      if (mv) {
        const top = slabs[topF], fl = mv.floor;
        const cx = mv.axis === 'x' ? top.cx + mv.pos : top.cx, cz = mv.axis === 'z' ? top.cz + mv.pos : top.cz;
        const wx = mv.axis === 'x' ? mv.w : mv.d, wz = mv.axis === 'z' ? mv.w : mv.d;
        const a = Math.min(1, (g.t - mv.born) / 0.3);
        box(ctx, cx, cz, wx, wz, fl * HF, (fl + 1) * HF, hueOf(fl), a, { l: 70 });
      }
      // debris
      for (const d of debris) {
        const e = g.t - d.t0, al = Math.max(0, 1 - e / 1.5);
        if (al <= 0) continue;
        const cxp = d.cx + d.vx * e, czp = d.cz + d.vz * e, yp = d.y + d.vy * e - 2.2 * e * e;
        const [sx, sy] = proj(cxp, yp + HF / 2, czp);
        ctx.save(); ctx.translate(sx, sy); ctx.rotate(d.rot + d.vr * e); ctx.translate(-sx, -sy);
        box(ctx, cxp, czp, d.wx, d.wz, yp, yp + HF, d.hue, al);
        ctx.restore();
      }
      // particles & texts (world px space relative to camera)
      ctx.save();
      ctx.translate(W / 2 - (cam.x - cam.z) * 0.866 * S * z, H * 0.47 - (((cam.x + cam.z) * 0.5 * S) + (-cam.y * S)) * z);
      ctx.scale(z, z);
      P.draw(ctx, 1);
      ctx.restore();
      for (const tx of texts) {
        const k = (g.t - tx.t0) / 1.2; if (k < 0 || k > 1) continue;
        const [sx, sy] = proj(tx.x, tx.y, tx.z);
        const y = sy - S * 0.25 - ease.outCubic(k) * S * 0.45;
        ctx.globalAlpha = k < 0.7 ? Math.min(1, k * 8) : 1 - (k - 0.7) / 0.3;
        ctx.font = `600 ${Math.round(S * 0.12)}px Fredoka, "Trebuchet MS", sans-serif`;
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.lineWidth = S * 0.025; ctx.strokeStyle = `hsla(${tx.hue},40%,20%,0.5)`; ctx.lineJoin = 'round';
        ctx.strokeText(tx.text, sx, y); ctx.fillStyle = '#ffffff'; ctx.fillText(tx.text, sx, y);
        ctx.globalAlpha = 1;
      }
      ctx.restore();
      // fog toward the bottom keeps the tower floating in the sky
      const fg = ctx.createLinearGradient(0, H * 0.62, 0, H);
      fg.addColorStop(0, `hsla(${hue - 14},30%,15%,0)`); fg.addColorStop(1, `hsla(${hue - 14},30%,15%,0.92)`);
      ctx.fillStyle = fg; ctx.fillRect(0, H * 0.62, W, H * 0.38);
      // vignette
      staticLayer(ctx, 'vg', W, H, (x, W, H) => {
        const vg = x.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.4, W / 2, H / 2, Math.max(W, H) * 0.8);
        vg.addColorStop(0, 'rgba(0,0,0,0)'); vg.addColorStop(1, 'rgba(0,0,0,0.35)');
        x.fillStyle = vg; x.fillRect(0, 0, W, H);
      });
      // streak chip
      if (g.streak >= 2 && !g.over) {
        const k = Math.min(1, g.streak / 5);
        ctx.font = `600 ${Math.round(S * 0.1)}px Fredoka, "Trebuchet MS", sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillStyle = `rgba(255,255,255,${0.35 + 0.35 * k})`; ctx.fillText(`streak ${g.streak}`, W / 2, H * 0.12);
      }
      void FONT;
    }

    const ipg = () => [[mv ? [mv] : [], ['pos'], 3], [[cam], ['x', 'y', 'z', 'zoom'], 50], [clouds, ['x'], 0.5], [[g], ['t'], 0, 't']];
    function drawI(ctx, w, h) {
      const a = IP.alpha(), st = IP.push(ipg(), a);
      try { draw(ctx, w, h); } finally { IP.pop(st); }
    }

    return {
      style, superAI,
      get over() { return g.over; }, get won() { return g.won; },
      resize(w, h) { W = w; H = h; S = Math.min(W, H) * 0.2; if (W / H < 1.2) S = Math.min(W / 5.4, H * 0.2); },
      step(dt) {
        IP.snap(ipg());
        g.t += dt;
        const t = g.t;
        P.update(dt);
        for (const c of clouds) { c.x += c.v * dt * 0.6; if (c.x > 1.2) c.x = -0.2; }
        shake = Math.max(0, shake - dt * 2.5);
        for (let i = debris.length - 1; i >= 0; i--) if (t - debris[i].t0 > 1.6) debris.splice(i, 1);
        for (let i = rings.length - 1; i >= 0; i--) if (t - rings[i].t0 > rings[i].dur) rings.splice(i, 1);
        for (let i = texts.length - 1; i >= 0; i--) if (t - texts[i].t0 > 1.3) texts.splice(i, 1);
        // camera easing toward the newest slab
        const top = slabs[slabs.length - 1];
        const k = 1 - Math.exp(-dt * 4.5);
        const ty = Math.max(slabs.length, 4) * HF;
        cam.y += (ty - cam.y) * k; cam.x += (top.cx - cam.x) * (1 - Math.exp(-dt * 3)); cam.z += (top.cz - cam.z) * (1 - Math.exp(-dt * 3));
        if (g.over) {
          g.endT += dt;
          if (g.won) { cam.zoom += (0.55 - cam.zoom) * (1 - Math.exp(-dt * 1.4)); if (Math.random() < dt * 8 && g.endT < 3) sparkle(top.cx + rnd.float(-1.2, 1.2), slabs.length * HF + rnd.float(0, 1.5), top.cz + rnd.float(-1.2, 1.2), 22, rnd.int(90)); }
          return;
        }
        if (t > CAP_SECONDS) { g.over = true; g.won = false; g.reason = 'Out of time'; g.lossFloor = g.floors; return; }
        if (!mv) return;
        const sp = speedFor(g.floors);
        if (mv.delay > 0) mv.delay -= dt;
        else {
          mv.pos += mv.dir * sp * dt;
          if (mv.pos > RANGE) { mv.pos = 2 * RANGE - mv.pos; mv.dir = -1; }
          else if (mv.pos < -RANGE) { mv.pos = -2 * RANGE - mv.pos; mv.dir = 1; }
        }
        // ---- AI
        if (mv.delay <= 0) {
          const tp = AI.plan({ sinceSpawn: t - mv.born, rel: mv.pos }, t, dt);
          if (tp != null && t >= tp) place(tp);
        }
      },
      draw: drawI,
      hud() {
        return { score: `Floor ${g.floors} / ${WIN_FLOORS}`, detail: `Streak ${g.streak} · best ${g.best} · speed ${speedFor(g.floors).toFixed(2)}` };
      },
      result() {
        if (g.won) return `Topped out at ${WIN_FLOORS} floors with ${g.perfects} perfect drops (${style})`;
        if (g.reason === 'Out of time') return 'Out of time';
        return `Missed the slab at floor ${g.lossFloor + 1} · ${g.perfects} perfect drops (${style})`;
      },
    };
  }

  Arcade.register({
    id: 'stack', name: 'Skyline Stack', genre: 'Stacking timing', bg: '#1d2b3a', accent: '#ffb3c7',
    aiNote: "Sees only the moving slab and the one below it, and times each tap with about 14 ms of human jitter.",
    blurb: 'Pastel slabs, perfect timing, an 80-floor tower.',
    create,
  });
})();
