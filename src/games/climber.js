// climber.js — Dawn Ascent (endless jumper). See DESIGN.md 8.5 #5.
// A round little climber auto-bounces up through a pastel sunrise that slowly turns to dusk and stars.
// The AI (see "THE AI") steers left/right only; it sees the platforms, hazards and pick-ups on screen.
(() => {
  'use strict';

  // ---------------------------------------------------------------- helpers
  const alphaNow = () => { const a = Arcade.alpha; return a === undefined ? 1 : a < 0 ? 0 : a > 1 ? 1 : a; };
  const _layers = {};
  function liveLayer(ctx, key, W, H, div, paint) {
    const sc = Math.min(2, (ctx.getTransform ? ctx.getTransform().a : 1) || 1) / div;
    let l = _layers[key];
    if (!l || l.W !== W || l.H !== H || l.sc !== sc) {
      const c = document.createElement('canvas'); c.width = Math.max(1, Math.ceil(W * sc)); c.height = Math.max(1, Math.ceil(H * sc));
      l = _layers[key] = { c, x: c.getContext('2d'), W, H, sc };
    }
    l.x.setTransform(l.sc, 0, 0, l.sc, 0, 0); l.x.clearRect(0, 0, W, H); paint(l.x, W, H);
    ctx.drawImage(l.c, 0, 0, W, H);
  }
  const mix = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
  const rgb = (c, al = 1) => `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${al})`;
  const fmt = n => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  const mod = (a, n) => ((a % n) + n) % n;

  // ---------------------------------------------------------------- constants
  const WW = 520, VH = 800;                 // world width (wraps), nominal visible height
  const G = 1500, V_JUMP = 840, V_SPRING = 1380, V_STOMP = 780, V_PROP = 950;
  const PR = 15, BODY_H = 20;                // hit radius, body-centre height above the feet
  const A_CTRL = 2200, D_CTRL = 6, A_ICE = 950, D_ICE = 1.6, VX_CAP = 460;
  const PROP_TIME = 1.7;
  const CAP_SECONDS = 900;
  const DIFF_H = 38000;                      // height at which difficulty "d" reaches 1
  const ALT_H = 52000;                       // height of full night
  const PAR_SCORE = 3000;
  const TWISTS = [
    { key: 'gust', name: 'Gusty wind', desc: 'Sudden gusts shove the climber sideways.' },
    { key: 'ice', name: 'Slippery clouds', desc: 'Icy platforms make steering slide and drift.' },
  ];
  const wrapDelta = (a, b) => { const d = b - a; return d - WW * Math.round(d / WW); };
  const reach = h => { // how far sideways a jump can travel before it falls back through height h (conservative)
    const s = V_JUMP * V_JUMP - 2 * G * h; if (s <= 0) return 40;
    return Math.max(40, 366 * (V_JUMP + Math.sqrt(s)) / G - 70);
  };

  // sky keyframes by altitude 0..1: top colour, bottom colour, cloud colour, cloud alpha
  const SKY = [
    [0.00, [118, 170, 232], [255, 216, 190], [255, 248, 240], 0.78],
    [0.22, [108, 148, 226], [255, 186, 202], [255, 236, 236], 0.74],
    [0.45, [92, 90, 188], [246, 150, 172], [250, 206, 226], 0.62],
    [0.70, [48, 42, 118], [150, 98, 172], [196, 168, 220], 0.44],
    [1.00, [9, 12, 38], [36, 34, 94], [112, 110, 178], 0.30],
  ];
  function skyAt(a) {
    let i = 0; while (i < SKY.length - 2 && a > SKY[i + 1][0]) i++;
    const k = SKY[i], n = SKY[i + 1], t = Math.max(0, Math.min(1, (a - k[0]) / (n[0] - k[0])));
    const e = t * t * (3 - 2 * t);
    return { top: mix(k[1], n[1], e), bot: mix(k[2], n[2], e), cloud: mix(k[3], n[3], e), calpha: k[4] + (n[4] - k[4]) * e };
  }

  // ======================================================================================
  // THE AI.  It only ever receives an `ob` snapshot built by observe(): the player's own position/velocity,
  // and the platforms, hazards and pick-ups currently inside the visible window (nothing above the top of
  // the screen, no hidden state, no RNG). It knows the physics (a skilled player learns them), estimates
  // the motion of moving things from successive snapshots, and acts only by choosing LEFT / NONE / RIGHT.
  // Each plan rolls out ~70 candidate steering policies through the known physics (landing on platforms,
  // stomping or hitting hazards, grabbing pick-ups) and picks the best; key changes are rate limited.
  // ======================================================================================
  const STYLES = {
    'Steady climber': { margin: 26, mPen: 14, cPen: 6, spring: 40, item: 0, stomp: 10, safe: 8, nextW: 1, age: 0.12, react: 0.12 },
    'Spring chaser': { margin: 22, mPen: 10, cPen: 4, spring: 170, item: 250, stomp: 0, safe: 8, nextW: 0.9, age: 0.12, react: 0.12 },
    'Cautious hopper': { margin: 60, mPen: 55, cPen: 28, spring: 10, item: 0, stomp: -30, safe: 17, nextW: 1.4, age: 0.12, react: 0.12 },
    'Bird stomper': { margin: 24, mPen: 14, cPen: 6, spring: 40, item: 60, stomp: 110, safe: 8, nextW: 1, age: 0.12, react: 0.12 },
  };
  const SUPER_CFG = { margin: 30, mPen: 0, cPen: 0, spring: 120, item: 100, stomp: 30, safe: 3, nextW: 1.2, age: 0, react: 0 };

  function makeAI(cfg, sup) {
    const mem = new Map();
    let dir = 0, lastChange = -9, nextPlan = 0, now = 0, peakSeen = 0, bounces = 0, lastVy = 0, peakT = 0, relaxed = false;
    const DT = sup ? 1 / 60 : 1 / 30;   // the super AI integrates exactly like the game; humans eyeball it
    const fold = (pos, lo, hi) => {
      const r = hi - lo; if (r <= 0) return lo;
      const u = mod(pos - lo, 2 * r); return lo + (u > r ? 2 * r - u : u);
    };
    function track(ob) {
      for (const q of ob.plats) trackOne(q, q.w / 2 + 6, WW - q.w / 2 - 6, ob.t);
      for (const q of ob.enemies) trackOne(q, q.r, WW - q.r, ob.t);
    }
    function trackOne(q, wl, wh, t) {
      let m = mem.get(q.id);
      if (!m) { m = { x: q.x, vx: 0, first: t, lo: null, hi: null, spd: 0, dir: 0, wl, wh }; mem.set(q.id, m); }
      else {
        // things that patrol move at a constant speed and bounce: watch the direction each tick, remember the speed and the turning points
        const d1 = q.x - m.x;
        if (Math.abs(d1) > 0.05) {
          const dn = d1 > 0 ? 1 : -1;
          m.spd = Math.max(m.spd, Math.abs(d1) * 60);
          if (m.dir && dn !== m.dir) { if (m.dir > 0) m.hi = q.x; else m.lo = q.x; }
          m.dir = dn;
          m.vx = dn * m.spd;
        }
        m.x = q.x;
      }
      m.seen = t;
      q.m = m;
    }
    const xAt = (q, t) => (q.vx === 0 ? q.x : fold(q.x + q.vx * t, q.lo, q.hi));

    function plan(ob) {
      const P = ob.p, wind = ob.wind, ice = ob.ice;
      const A = ice ? A_ICE : A_CTRL, D = ice ? D_ICE : D_CTRL;
      // perceived objects (a human notices new things after a moment, and misjudges positions by a few units)
      const nz = sup ? 0 : 2.5;
      const pl = [];
      const rise = P.vy > 0 ? P.vy * P.vy / (2 * G) : 0;
      const yHi = P.y + rise + (P.boost > 0 ? 1200 : 30), yLo = P.y - 330;
      for (const q of ob.plats) {
        if (q.y > yHi || q.y < yLo) continue;
        const m = q.m; if (!m || ob.t - m.first < cfg.age) continue;
        const moving = q.type === 'm';
        pl.push({ id: q.id, type: q.type, y: q.y, w: q.w, spring: q.spring, cr: q.crumbling,
          x: q.x + (nz ? rnd.gauss() * nz : 0), vx: moving ? m.vx : 0,
          lo: moving ? (m.lo != null ? m.lo : m.wl) : 0, hi: moving ? (m.hi != null ? m.hi : m.wh) : 0 });
      }
      const en = [];
      for (const q of ob.enemies) {
        const m = q.m; if (!m || ob.t - m.first < cfg.age) continue;
        en.push({ type: q.type, x: q.x, y: q.y, r: q.r, vx: q.type === 'bird' ? m.vx : 0, lo: q.r, hi: WW - q.r });
      }
      const items = ob.items;
      allPl = ob.plats; curEn = en; curA = A; curD = D; curWind = wind;
      const lowY = ob.camY - 60;
      const fallT = (P.vy + Math.sqrt(P.vy * P.vy + 2 * G * Math.max(0, P.y - lowY))) / G;
      const maxT = Math.min(3.4, fallT + 0.15);

      // ---- candidate policies
      const pols = [];
      for (const a of [-1, 0, 1]) pols.push({ k: 0, a });
      const t1s = sup ? [0.08, 0.16, 0.26, 0.38, 0.52, 0.7, 0.95] : [0.12, 0.25, 0.4, 0.6];
      for (const a of [-1, 0, 1]) for (const b of [-1, 0, 1]) if (a !== b) for (const t1 of t1s) pols.push({ k: 1, a, b, t1 });
      // seek policies: aim at a platform (or its spring) where the current arc will cross its top
      const seekT = (y) => { // time at which the free-fall arc is falling through height y (null if never)
        const s = P.vy * P.vy - 2 * G * (y - P.y); if (s < 0) return null;
        return (P.vy + Math.sqrt(s)) / G;
      };
      if (P.boost <= 0) {
        for (const q of pl) {
          const T = seekT(q.y); if (T == null) continue;
          if (q.cr === 2) continue;
          const cx = xAt(q, T);
          pols.push({ k: 2, tx: cx, T });
          if (q.spring != null) pols.push({ k: 2, tx: cx + q.spring, T });
          if (q.w > 60) { pols.push({ k: 2, tx: cx - q.w * 0.25, T }); pols.push({ k: 2, tx: cx + q.w * 0.25, T }); }
        }
        for (const it of items) { const T = seekT(it.y); if (T != null) pols.push({ k: 2, tx: it.x, T, item: true }); }
      } else {
        pols.push({ k: 2, tx: P.x, T: 0 });
      }

      const lead = ice ? 0.55 : 0.17, dead = 6;
      let bestU = -1e12, bestPol = null, tieBreak = 0;
      for (const pol of pols) {
        const U = rollout(P, pol, pl, en, items, ob, A, D, wind, lead, dead, maxT, lowY);
        const u = U + Math.random() * 0.5;
        if (u > bestU) { bestU = u; bestPol = pol; }
      }
      void tieBreak;
      if (!bestPol) return 0;
      if (bestPol.k === 0) return bestPol.a;
      if (bestPol.k === 1) return bestPol.a;
      const e = wrapDelta(P.x, bestPol.tx), u = e - P.vx * lead;
      return u > dead ? 1 : u < -dead ? -1 : 0;
    }

    function rollout(P, pol, pl, en, items, ob, A, D, wind, lead, dead, maxT, lowY) {
      let x = P.x, y = P.y, vx = P.vx, vy = P.vy, bt = P.boost || 0, t = 0, d = 0;
      while (t < maxT) {
        if (pol.k === 0) d = pol.a;
        else if (pol.k === 1) d = t < pol.t1 ? pol.a : pol.b;
        else { const u = wrapDelta(x, pol.tx) - vx * lead; d = u > dead ? 1 : u < -dead ? -1 : 0; }
        vx += (d * A - D * vx + wind) * DT;
        vx = vx > VX_CAP ? VX_CAP : vx < -VX_CAP ? -VX_CAP : vx;
        x += vx * DT; if (x < 0) x += WW; else if (x >= WW) x -= WW;
        const py = y;
        if (bt > 0) { vy += (V_PROP - vy) * Math.min(1, DT * 8); bt -= DT; } else vy -= G * DT;
        y += vy * DT; t += DT;
        if (y < lowY) return -1e5 + y * 0.01 + t;
        if (bt <= 0) {
          for (let i = 0; i < en.length; i++) {
            const e = en[i];
            const ex = e.vx ? fold(e.x + e.vx * t, e.lo, e.hi) : e.x;
            const dx = wrapDelta(ex, x), dy = y + BODY_H - e.y, d2 = dx * dx + dy * dy, rr = PR + e.r * 0.88 + cfg.safe, rs = PR + e.r * 0.8;
            if (e.type === 'bird' && vy < 0 && y >= e.y + 4 && d2 < rs * rs) return e.y + V_STOMP * V_STOMP / (2 * G) + cfg.stomp;
            if (d2 < rr * rr && !(e.type === 'bird' && vy < 0 && y >= e.y + 6)) return (relaxed ? -300 : -1e6) + t * 1000;
          }
          if (vy < 0) {
            for (let i = 0; i < pl.length; i++) {
              const q = pl[i];
              if (py < q.y || y > q.y) continue;
              const qx = q.vx ? fold(q.x + q.vx * t, q.lo, q.hi) : q.x;
              const dx = wrapDelta(qx, x);
              const adx = Math.abs(dx);
              if (adx > q.w / 2 + 16) continue;
              if (adx > q.w / 2 + 7) return -2e4 + y;      // right at the rim: could go either way, don't plan on it
              return landed(q, dx, qx, x, pl, vx, t, d);
            }
          }
        }
        for (let i = 0; i < items.length; i++) {
          const it = items[i], dx = wrapDelta(it.x, x), dy = y + BODY_H - it.y;
          if (dx * dx + dy * dy < 30 * 30) return y + 1700 + cfg.item;
        }
      }
      return -5e4 + y;
    }

    let allPl = [];
    // can it climb out of the bounce without running into a hazard? (tries a few steering patterns for the ascent)
    const ESC = [[0, 0, 0], [-1, -1, 0], [1, 1, 0], [-1, 0, 0.22], [1, 0, 0.22], [0, -1, 0.15], [0, 1, 0.15], [-1, 1, 0.3], [1, -1, 0.3]];
    function escapes(qx, vx0, v, qy, t0, dL) {
      if (!curEn.length) return true;
      const T = v / G + 0.05;
      for (const [a, b, t1] of ESC) {
        let x = qx, vx = vx0, s = 0, ok = true;
        while (s < T) {
          const d = s < cfg.react ? dL : s < cfg.react + t1 ? a : b;
          vx += (d * curA - curD * vx + curWind) * DT; vx = vx > VX_CAP ? VX_CAP : vx < -VX_CAP ? -VX_CAP : vx;
          x += vx * DT; s += DT;
          const y = qy + v * s - 0.5 * G * s * s;
          for (let i = 0; i < curEn.length; i++) {
            const e = curEn[i]; if (e.y < y - 60 || e.y > y + 80) continue;
            const ex = e.vx ? fold(e.x + e.vx * (t0 + s), e.lo, e.hi) : e.x;
            const dx = wrapDelta(ex, x), dy = y + BODY_H - e.y, rr = PR + e.r * 0.88 + cfg.safe;
            if (dx * dx + dy * dy < rr * rr) { ok = false; break; }
          }
          if (!ok) break;
        }
        if (ok) return true;
      }
      return false;
    }
    let curEn = [], curA = 0, curD = 0, curWind = 0;
    function landed(q, dx, qx, x, pl, vxl, tl, dL) {
      let v = V_JUMP, bonus = 0;
      if (q.spring != null && Math.abs(wrapDelta(qx + q.spring, x)) < 14) { v = V_SPRING; bonus += cfg.spring; }
      let U = q.y + v * v / (2 * G) + bonus;
      if (!escapes(x, vxl, v, q.y, tl, dL)) U -= (relaxed ? 100 : 600);
      const mf = 1 - Math.abs(dx) / (q.w / 2);
      U += cfg.margin * Math.min(mf, 0.6) / 0.6;
      if (q.type === 'm') U -= cfg.mPen;
      if (q.type === 'c') U -= cfg.cPen;
      // is there something to jump to from there? (only judged against what is visible)
      let opts = 0, bestH = 0;
      for (let i = 0; i < allPl.length; i++) {
        const r = allPl[i]; if (r.y === q.y && r.type === q.type) continue;
        const h = r.y - q.y; if (h < 12 || h > 222) continue;
        const rx = r.type === 'm' ? r.x : r.x;
        if (Math.abs(wrapDelta(rx, qx)) <= reach(h) * 0.85 + r.w / 2 - (r.type === 'm' ? 50 : 0)) { opts++; if (h > bestH) bestH = h; }
      }
      if (opts === 0) { if (q.y + 215 < ob_top) U -= (relaxed ? 20 : 150); }
      else U += cfg.nextW * (Math.min(opts, 3) * 12 + bestH * 0.1);
      return U;
    }
    let ob_top = 0;

    return {
      cfg,
      decide(ob, t) {
        now = t; ob_top = ob.camY + ob.viewH;
        track(ob);
        if (ob.p.y > peakSeen + 4) { peakSeen = ob.p.y; bounces = 0; peakT = t; }
        relaxed = bounces > 3 || t - peakT > 2.5;   // not getting anywhere: stop being so choosy
        if (lastVy < 0 && ob.p.vy > 0) bounces++;   // it noticed it has landed again without getting higher
        lastVy = ob.p.vy;
        const interval = sup ? 0 : 0.1;
        if (now >= nextPlan) {
          nextPlan = now + interval;
          const nd = plan(ob);
          // human thumbs: don't flip the key faster than ~13 Hz; super AI has no such limit
          if (nd !== dir && (sup || now - lastChange >= 0.075)) { dir = nd; lastChange = now; }
        }
        if (mem.size > 120) for (const [k, m] of mem) if (now - m.seen > 1) mem.delete(k);
        return dir;
      },
    };
  }

  // ======================================================================================
  function create(opts = {}) {
    const superAI = !!opts.superAI;
    const styleNames = Object.keys(STYLES);
    const style = superAI ? 'Super AI' : rnd.pick(styleNames);
    const ai = makeAI(superAI ? SUPER_CFG : STYLES[style], superAI);
    let twist = null;
    if (opts.twist) twist = (typeof opts.twist === 'string' && TWISTS.find(t => t.key === opts.twist)) || rnd.pick(TWISTS);
    const ice = !!(twist && twist.key === 'ice'), gusty = !!(twist && twist.key === 'gust');
    const par = opts.best || PAR_SCORE;

    let W = 800, H = 600, S = 1, X0 = 0, viewH = VH;
    const plats = [], enemies = [], items = [];
    let idc = 1;
    const g = { t: 0, over: false, won: false, endT: 0, peak: 0, score: 0, reason: '', stomps: 0, springs: 0, props: 0,
      lastGain: 0, mist: -160, wind: 0, windT: 0, windDir: 1, nextGust: rnd.float(7, 12), shake: 0, beaten: false, miles: 0, deathKind: '' };
    const gen = { prevC: 0, y: 0, x: WW / 2, n: 0, lastHaz: 0, nextProp: rnd.float(3800, 5200) };
    const p = {
      x: WW / 2, y: 0, vx: 0, vy: V_JUMP, x0: WW / 2, y0: 0, face: 1, squash: 0, boost: 0, grace: 0, blink: 2, dead: false, rot: 0, vr: 0, sucked: null, scale: 1,
      scarf: [], trail: [],
    };
    for (let i = 0; i < 8; i++) p.scarf.push({ x: p.x, y: p.y + BODY_H });
    const cam = { y: -90, y0: -90, t: -90 };
    const parts = [], texts = [], banners = [];
    // ambient scenery
    const clouds = [], birds = [], stars = [], leaves = [];
    for (let L = 0; L < 3; L++) for (let i = 0; i < 6 + L * 2; i++) clouds.push({ L, x: Math.random(), y: Math.random(), s: rnd.float(0.7, 1.3), v: rnd.float(0.004, 0.012) * (L + 1) });
    for (let i = 0; i < 4; i++) birds.push({ x: Math.random(), y: Math.random(), n: 3 + rnd.int(3), v: rnd.float(0.012, 0.03), ph: Math.random() * 6 });
    for (let i = 0; i < 150; i++) stars.push({ x: Math.random(), y: Math.random(), r: rnd.float(0.5, 1.7), ph: Math.random() * 6.3, tw: rnd.float(0.8, 2.4) });
    for (let i = 0; i < 26; i++) leaves.push({ x: Math.random(), y: Math.random(), s: rnd.float(0.6, 1.2) });

    // ---------------------------------------------------------------- level generation
    const dOf = y => Math.min(2, Math.max(0, y / DIFF_H));
    function addPlat(type, x, y, w) {
      const pl = { id: idc++, type, x, y, w, x0: x, spring: null, sq: 0, cr: -1, broken: false, hit: 0, seed: Math.random(), bx: x, R: 0, dir: 1, v: 0 };
      plats.push(pl); return pl;
    }
    addPlat('g', WW / 2, 0, WW + 40);
    gen.x = WW / 2;
    function genOne() {
      const last = gen.y, n = ++gen.n;
      const d = dOf(last), dd = Math.min(d, 1.15);
      const early = n < 7;
      let gmin = 62 + 40 * dd, gmax = Math.min(205, 112 + 98 * dd);
      if (early) { gmin = 70; gmax = 105; }
      const u = Math.pow(Math.random(), 1 - 0.45 * Math.min(1, d));
      let gap = gmin + (gmax - gmin) * u;
      if (gen.prevC) gap = Math.min(gap, Math.max(40, 200 - gen.prevC));
      let w = (96 - 38 * Math.min(1, d)) * rnd.float(0.92, 1.1);
      if (d > 1) w = Math.max(48, w - 6 * (d - 1) * 4);
      let type = 'n';
      if (!early) {
        const r = Math.random(), pc = 0.05 + 0.30 * Math.min(d, 1), pm = 0.08 + 0.30 * Math.min(d, 1);
        if (r < pc) type = 'c'; else if (r < pc + pm) type = 'm';
      }
      // a crumbling slab must never be the only way up: the platform after it stays within reach of the one before it
      if (type === 'c' && (gen.prevC || gap > 130)) type = 'n';
      let R = 0, speed = 0;
      if (type === 'm') { R = 55 + 45 * Math.min(1, d); speed = 55 + 90 * Math.min(1, d); }
      const dxm = Math.max(30, reach(gap) * (0.6 + 0.26 * Math.min(1, d)) - R * 0.8);
      let x = gen.x + rnd.float(-1, 1) * dxm;
      x = mod(x, WW);
      const lo = w / 2 + 6 + R, hi = WW - w / 2 - 6 - R;
      x = Math.max(lo, Math.min(hi, x));
      const y = last + gap;
      const pl = addPlat(type, x, y, w);
      if (type === 'm') { pl.R = R; pl.v = speed; pl.dir = Math.random() < 0.5 ? 1 : -1; pl.x += rnd.float(-R, R); pl.x0 = pl.x; }
      if (type === 'n' && !early && Math.random() < 0.10 - 0.04 * Math.min(d, 1)) pl.spring = { ox: rnd.float(-1, 1) * (w / 2 - 18) };
      // hazards between the previous platform and this one
      if (!early && last > 3000 && gap >= 125 && last - gen.lastHaz > 170) {
        const ph = Math.min(0.62, 0.10 + 0.34 * d);
        if (Math.random() < ph) {
          const ws = [['bird', 1], ['storm', d > 0.2 ? 0.8 : 0], ['hole', d > 0.5 ? 0.6 : 0]];
          let tot = 0; for (const a of ws) tot += a[1];
          let r = Math.random() * tot, kind = 'bird'; for (const a of ws) { if (r < a[1]) { kind = a[0]; break; } r -= a[1]; }
          const hy = last + rnd.float(58, gap - 58);
          let hx = rnd.float(40, WW - 40);
          if (kind !== 'bird') { // static hazards never sit in the corridor between the two platforms (birds sweep and can be waited out)
            const prevX = gen.x, mid = prevX + wrapDelta(prevX, x) / 2;
            for (let tries = 0; tries < 12; tries++) {
              if (Math.abs(wrapDelta(hx, prevX)) > 90 && Math.abs(wrapDelta(hx, x)) > 90 && Math.abs(wrapDelta(hx, mid)) > 90) break;
              hx = rnd.float(40, WW - 40);
            }
          }
          const e = { id: idc++, type: kind, x: hx, y: hy, x0: hx, y0: hy, by: hy, r: kind === 'bird' ? 17 : 30, vx: 0, ph: Math.random() * 6 };
          if (kind === 'bird') e.vx = (Math.random() < 0.5 ? -1 : 1) * (55 + 55 * Math.min(1.3, d));
          enemies.push(e); gen.lastHaz = hy;
        }
      }
      if (last > 2500 && last >= gen.nextProp && type === 'n') {
        items.push({ id: idc++, x: x, y: y + 40, ph: Math.random() * 6 });
        gen.nextProp = last + rnd.float(4200, 7000);
      }
      gen.prevC = type === 'c' ? gap : 0;
      gen.y = y; gen.x = x;
    }
    function genUntil(top) { while (gen.y < top) genOne(); }

    // ---------------------------------------------------------------- particles & texts
    function emit(o) { if (parts.length < 650) parts.push(o); }
    function puff(x, y, n, col, sp = 60, r = 7, life = 0.6, up = 0) {
      for (let i = 0; i < n; i++) { const a = Math.random() * TAU; emit({ x, y, vx: Math.cos(a) * sp * rnd.float(0.3, 1), vy: Math.sin(a) * sp * rnd.float(0.2, 0.8) + up, life: 0, max: life * rnd.float(0.7, 1.2), r: r * rnd.float(0.6, 1.2), col, kind: 2, g: 0, drag: 3, add: false }); }
    }
    function sparks(x, y, n, cols, sp = 260, life = 0.9, kind = 1, grav = -600) {
      for (let i = 0; i < n; i++) { const a = Math.random() * TAU, s = rnd.float(0.2, 1) * sp; emit({ x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, life: 0, max: life * rnd.float(0.6, 1.1), r: rnd.float(2.5, 5.5), col: rnd.pick(cols), kind, g: grav, drag: 1.6, add: true, rot: Math.random() * 6, vr: rnd.float(-6, 6) }); }
    }
    function shards(x, y, n, cols) {
      for (let i = 0; i < n; i++) emit({ x: x + rnd.float(-20, 20), y, vx: rnd.float(-90, 90), vy: rnd.float(20, 160), life: 0, max: rnd.float(0.7, 1.1), r: rnd.float(3, 6), col: rnd.pick(cols), kind: 3, g: -1500, drag: 0.4, add: false, rot: Math.random() * 6, vr: rnd.float(-9, 9) });
    }
    function say(x, y, txt, col, size = 1) { texts.push({ x, y, t: 0, max: 1.1, txt, col: col || '#fff', size }); }
    function banner(txt, sub, col) { banners.push({ txt, sub, col, t: 0, max: 3.2 }); }

    // ---------------------------------------------------------------- observation (what is on screen)
    function observe() {
      const top = cam.y + viewH + 10, bot = cam.y - 40;
      const ob = { t: g.t, camY: cam.y, viewH, wind: g.wind, ice, plats: [], enemies: [], items: [],
        p: { x: p.x, y: p.y, vx: p.vx, vy: p.vy, boost: p.boost } };
      for (const q of plats) {
        if (q.broken || q.y < bot || q.y > top) continue;
        ob.plats.push({ id: q.id, type: q.type, x: q.x, y: q.y, w: q.w, spring: q.spring ? q.spring.ox : null, crumbling: q.cr >= 0 ? (q.cr < 0.14 ? 2 : 1) : 0 });
      }
      for (const e of enemies) if (!e.dead && e.y > bot && e.y < top) ob.enemies.push({ id: e.id, type: e.type, x: e.x, y: e.y, r: e.r });
      for (const it of items) if (!it.taken && it.y > bot && it.y < top) ob.items.push({ id: it.id, x: it.x, y: it.y });
      return ob;
    }

    // ---------------------------------------------------------------- simulation step
    function die(kind, ex) {
      g.over = true; g.endT = 0; g.deathKind = kind; g.shake = 1;
      p.dead = true;
      if (kind === 'hole') { p.sucked = { x: ex.x, y: ex.y - BODY_H, t: 0 }; }
      else if (kind !== 'fall') {
        p.vy = 520; p.vx = (Math.random() < 0.5 ? -1 : 1) * 140; p.vr = rnd.float(-9, 9);
        sparks(p.x, p.y + BODY_H, 22, ['#fff', '#ffe28a', '#ff9a76'], 320, 0.8);
      }
    }
    function land(pl) {
      let v = V_JUMP;
      pl.hit = 1;
      if (pl.spring && Math.abs(wrapDelta(pl.x + pl.spring.ox, p.x)) < 15) {
        v = V_SPRING; pl.spring.sq = 1; g.springs++;
        say(p.x, p.y + 60, 'BOING!', '#ffe28a');
        sparks(p.x, p.y, 16, ['#fff7c2', '#ffd36e', '#ffb3c7'], 280, 0.9);
      }
      p.vy = v; p.squash = 1;
      puff(p.x, p.y, 7, pl.type === 'c' ? 'rgba(255,224,190,0.7)' : 'rgba(255,255,255,0.7)', 70, 6, 0.5, 20);
      if (pl.type === 'c') pl.cr = 0.3;
      if (ice) sparks(p.x, p.y, 6, ['#ffffff', '#bfeaff'], 160, 0.6);
    }

    function stepWorld(dt) {
      // wind
      if (gusty && !g.over) {
        if (g.windT > 0) { g.windT -= dt; if (g.windT <= 0) { g.wind = 0; g.nextGust = g.t + rnd.float(5, 9); } }
        else if (g.t >= g.nextGust) {
          g.windDir = Math.random() < 0.5 ? -1 : 1; g.windT = rnd.float(2.4, 3.4); g.wind = g.windDir * rnd.float(1500, 1900);
          banner(g.windDir > 0 ? 'GUST  →' : '←  GUST', 'hold on!', '#9fe3ff');
        }
      }
      // platforms
      for (const q of plats) {
        q.x0 = q.x; q.hit = Math.max(0, q.hit - dt * 4);
        if (q.spring) q.spring.sq = Math.max(0, (q.spring.sq || 0) - dt * 3);
        if (q.type === 'm') {
          q.x += q.dir * q.v * dt;
          const hi = q.bx + q.R, lo = q.bx - q.R;
          if (q.x > hi) { q.x = 2 * hi - q.x; q.dir = -1; } else if (q.x < lo) { q.x = 2 * lo - q.x; q.dir = 1; }
        }
        if (q.cr >= 0 && !q.broken) { q.cr -= dt; if (q.cr < 0) { q.broken = true; q.cr = -1; shards(q.x, q.y, 10, ['#f2c6a8', '#ffcf9a', '#d9a083']); puff(q.x, q.y, 6, 'rgba(255,230,200,0.6)', 60, 8, 0.7); } }
      }
      // enemies
      for (const e of enemies) {
        e.x0 = e.x; e.y0 = e.y;
        if (e.type === 'bird') { e.x += e.vx * dt; if (e.x > WW - e.r) { e.x = 2 * (WW - e.r) - e.x; e.vx = -Math.abs(e.vx); } else if (e.x < e.r) { e.x = 2 * e.r - e.x; e.vx = Math.abs(e.vx); } }
        else if (e.type === 'storm') { e.y = e.by + Math.sin(g.t * 1.6 + e.ph) * 6; }
        if (e.dying != null) { e.dying += dt; if (e.dying > 0.5) e.dead = true; }
        if (e.type === 'hole' && !e.dead && Math.random() < dt * 5 && e.y > cam.y && e.y < cam.y + viewH) {
          const a = Math.random() * TAU; emit({ x: e.x + Math.cos(a) * 70, y: e.y + Math.sin(a) * 70, vx: -Math.cos(a) * 80, vy: -Math.sin(a) * 80, life: 0, max: 0.8, r: 2.5, col: '#c9a2ff', kind: 1, g: 0, drag: 0, add: true, rot: 0, vr: 3 });
        }
      }
      for (let i = enemies.length - 1; i >= 0; i--) if (enemies[i].dead || enemies[i].y < cam.y - 300) enemies.splice(i, 1);
      for (let i = items.length - 1; i >= 0; i--) if (items[i].taken || items[i].y < cam.y - 300) items.splice(i, 1);
      while (plats.length && plats[0].y < cam.y - 260) plats.shift();
    }

    function stepPlayer(dt) {
      p.x0 = p.x; p.y0 = p.y;
      const dir = ai.decide(observe(), g.t);
      const A = ice ? A_ICE : A_CTRL, D = ice ? D_ICE : D_CTRL;
      p.vx += (dir * A - D * p.vx + g.wind) * dt;
      p.vx = Math.max(-VX_CAP, Math.min(VX_CAP, p.vx));
      p.x += p.vx * dt;
      if (p.x < 0) { p.x += WW; for (const s of p.scarf) s.x += WW; p.x0 += WW; } else if (p.x >= WW) { p.x -= WW; for (const s of p.scarf) s.x -= WW; p.x0 -= WW; }
      if (Math.abs(p.vx) > 25) p.face = Math.sign(p.vx);
      const py = p.y;
      if (p.boost > 0) {
        p.boost -= dt; p.vy += (V_PROP - p.vy) * Math.min(1, dt * 8); p.grace = 0.6;
        if (Math.random() < 0.8) emit({ x: p.x + rnd.float(-5, 5), y: p.y + BODY_H + 6, vx: rnd.float(-20, 20), vy: -80, life: 0, max: 0.35, r: 4, col: 'rgba(255,255,255,0.8)', kind: 2, g: 0, drag: 1, add: false });
      } else p.vy -= G * dt;
      p.y += p.vy * dt;
      p.grace = Math.max(0, p.grace - dt);
      if (p.y > g.peak + 4) g.lastGain = g.t;
      if (p.y > g.peak) {
        g.peak = p.y;
        const sc = Math.floor(g.peak / 10);
        if (sc > g.score) g.score = sc;
        const m = Math.floor(g.score / 250);
        if (m > g.miles) { g.miles = m; say(p.x, p.y + 90, `${fmt(m * 250)} m`, '#fff', 1.15); sparks(p.x, p.y + 30, 18, ['#fff', '#ffe28a', '#ffb3c7', '#9fe3ff'], 300, 1.1); }
        if (!g.beaten && g.score > par) { g.beaten = true; say(p.x, p.y + 130, 'NEW BEST!', '#ffe28a', 1.4); for (let k = 0; k < 4; k++) sparks(p.x + rnd.float(-90, 90), p.y + rnd.float(0, 120), 20, ['#fff', '#ffd36e', '#ff9a76', '#9fe3ff'], 380, 1.4); }
      }
      // platforms
      if (p.vy < 0 && p.boost <= 0) {
        for (const q of plats) {
          if (q.broken || q.cr >= 0 && q.cr < 0.04) continue;
          if (py >= q.y - 0.01 && p.y <= q.y && Math.abs(wrapDelta(q.x, p.x)) <= q.w / 2 + 8) { p.y = q.y; land(q); break; }
        }
      }
      // enemies
      if (p.boost <= 0 && p.grace <= 0) {
        for (const e of enemies) {
          if (e.dead || e.dying != null) continue;
          const dx = wrapDelta(e.x, p.x), dy = p.y + BODY_H - e.y, rr = PR + e.r * 0.8;
          if (dx * dx + dy * dy < rr * rr) {
            if (e.type === 'bird' && p.vy < 0 && p.y >= e.y - 2) {
              e.dying = 0; p.vy = V_STOMP; p.squash = 1; g.stomps++;
              say(e.x, e.y + 40, 'STOMP!', '#ffe28a'); sparks(e.x, e.y, 16, ['#fff', '#c9a2ff', '#ffd36e'], 260, 0.8);
            } else { die(e.type, e); break; }
          }
        }
      }
      for (const it of items) {
        if (it.taken) continue;
        const dx = wrapDelta(it.x, p.x), dy = p.y + BODY_H - it.y;
        if (dx * dx + dy * dy < 30 * 30) { it.taken = true; p.boost = PROP_TIME; g.props++; say(p.x, p.y + 70, 'PROPELLER!', '#7ef0d8'); sparks(it.x, it.y, 18, ['#fff', '#7ef0d8', '#ffe28a'], 300, 0.9); }
      }
      // rising mist: only creeps up when the climber has stopped gaining height (visible, fair, ends any stall)
      const stall = g.t - g.lastGain;
      if (stall > 4) g.mist += Math.min(110, 18 + 9 * (stall - 4)) * dt;
      else g.mist = Math.max(g.mist - 220 * dt, cam.y - 160);
      if (g.mist < cam.y - 160) g.mist = cam.y - 160;
      if (p.boost <= 0 && p.y < g.mist) die('mist');
      if (p.y + BODY_H < cam.y - 40) { die('fall'); }
      // squash / blink / scarf / trail
      p.squash = Math.max(0, p.squash - dt * 5.5);
      p.blink -= dt; if (p.blink < -0.12) p.blink = rnd.float(2, 4.5);
      const sc = p.scarf;
      sc[0].x = p.x - p.face * 6; sc[0].y = p.y + BODY_H - 3;
      for (let i = 1; i < sc.length; i++) {
        const a = sc[i - 1], b = sc[i];
        b.x += (a.x - b.x) * 0.38 - (p.vx * 0.012 + g.wind * 0.004 + (-p.face) * 0.2) * 0.5;
        b.y += (a.y - b.y) * 0.38 - 70 * dt - p.vy * dt * 0.1;
        const ddx = b.x - a.x, ddy = b.y - a.y, dl = Math.hypot(ddx, ddy);
        if (dl > 8) { b.x = a.x + ddx / dl * 8; b.y = a.y + ddy / dl * 8; }
      }
      if (p.vy > 900 || p.boost > 0) { p.trail.push({ x: p.x, y: p.y, a: 1 }); }
      for (let i = p.trail.length - 1; i >= 0; i--) { p.trail[i].a -= dt * 4; if (p.trail[i].a <= 0) p.trail.splice(i, 1); }
    }

    function stepDead(dt) {
      g.endT += dt;
      if (p.sucked) {
        const s = p.sucked; s.t += dt; const k = Math.min(1, s.t / 0.7);
        p.x += (s.x - p.x) * Math.min(1, dt * 8); p.y += (s.y - BODY_H - p.y) * Math.min(1, dt * 8);
        p.scale = 1 - k; p.rot += dt * 12;
        if (k >= 1 && !s.done) { s.done = true; sparks(s.x, s.y, 20, ['#c9a2ff', '#fff', '#7a5cff'], 240, 0.9); }
        return;
      }
      p.x0 = p.x; p.y0 = p.y;
      p.vy -= G * dt; p.y += p.vy * dt; p.x += p.vx * dt; p.rot += p.vr * dt;
      if (p.x < 0) { p.x += WW; p.x0 += WW; } else if (p.x >= WW) { p.x -= WW; p.x0 -= WW; }
    }

    function stepAmbient(dt) {
      for (const c of clouds) { c.x += c.v * dt * 0.5; if (c.x > 1.15) c.x = -0.15; }
      for (const b of birds) { b.x += b.v * dt; if (b.x > 1.1) b.x = -0.1; }
      for (const q of texts) q.t += dt;
      for (let i = texts.length - 1; i >= 0; i--) if (texts[i].t > texts[i].max) texts.splice(i, 1);
      for (const q of banners) q.t += dt;
      for (let i = banners.length - 1; i >= 0; i--) if (banners[i].t > banners[i].max) banners.splice(i, 1);
      // particles
      for (let i = parts.length - 1; i >= 0; i--) {
        const q = parts[i]; q.life += dt;
        if (q.life >= q.max) { parts[i] = parts[parts.length - 1]; parts.pop(); continue; }
        const dm = Math.exp(-q.drag * dt); q.vx *= dm; q.vy = q.vy * dm + q.g * dt; q.x += q.vx * dt; q.y += q.vy * dt;
        if (q.rot !== undefined) q.rot += q.vr * dt;
      }
      g.shake = Math.max(0, g.shake - dt * 2.5);
      if (gusty && g.wind) for (let i = 0; i < 2; i++) if (Math.random() < 0.5) emit({ x: Math.random() * WW, y: cam.y + Math.random() * viewH, vx: g.wind * 0.9, vy: rnd.float(-20, 20), life: 0, max: 0.7, r: 2, col: 'rgba(255,255,255,0.7)', kind: 4, g: 0, drag: 0, add: false });
    }

    function stepCam(dt) {
      cam.y0 = cam.y;
      cam.t = Math.max(cam.t, p.y - viewH * 0.5);
      cam.y += (cam.t - cam.y) * (1 - Math.exp(-dt * 6));
      if (cam.y < p.y - (viewH - 110)) cam.y = p.y - (viewH - 110);
      if (g.over && (g.deathKind !== 'fall')) { /* camera holds */ }
    }

    function step(dt) {
      g.t += dt;
      if (!g.over) {
        if (g.t > CAP_SECONDS) { g.over = true; g.reason = 'time'; g.endT = 0; }
        else {
          stepWorld(dt); stepPlayer(dt); stepCam(dt); genUntil(cam.y + viewH + 700);
        }
      } else {
        stepWorld(dt); stepDead(dt); cam.y0 = cam.y;
      }
      stepAmbient(dt);
    }

    // ---------------------------------------------------------------- drawing
    const sx = x => X0 + x * S;
    const sy = y => H - (y - cam.dy) * S;

    function drawSky(ctx, a, tt) {
      const sk = skyAt(a);
      liveLayer(ctx, 'sky', W, H, 8, (x, W, H) => {
        const gr = x.createLinearGradient(0, 0, 0, H);
        gr.addColorStop(0, rgb(sk.top)); gr.addColorStop(1, rgb(sk.bot));
        x.fillStyle = gr; x.fillRect(0, 0, W, H);
        const sunY = H * (0.80 + 0.9 * a), r = Math.max(W, H) * 0.7;
        const gl = x.createRadialGradient(W * 0.72, sunY, 0, W * 0.72, sunY, r);
        gl.addColorStop(0, `rgba(255,214,160,${0.55 * (1 - a * 1.4 > 0 ? 1 - a * 1.4 : 0)})`); gl.addColorStop(1, 'rgba(255,200,160,0)');
        x.fillStyle = gl; x.fillRect(0, 0, W, H);
      });
      // sun disc
      const sunA = 1 - a * 2.2;
      if (sunA > 0) {
        const sxp = W * 0.72, syp = H * (0.80 + 0.9 * a);
        ctx.fillStyle = `rgba(255,236,196,${0.85 * sunA})`; ctx.beginPath(); ctx.arc(sxp, syp, Math.min(W, H) * 0.07, 0, TAU); ctx.fill();
        ctx.fillStyle = `rgba(255,246,222,${0.9 * sunA})`; ctx.beginPath(); ctx.arc(sxp, syp, Math.min(W, H) * 0.05, 0, TAU); ctx.fill();
      }
      // stars
      const stA = Math.max(0, Math.min(1, (a - 0.5) * 2.2));
      if (stA > 0) {
        for (const s of stars) {
          const tw = 0.55 + 0.45 * Math.sin(tt * s.tw + s.ph);
          const yy = mod(s.y * H + cam.dy * S * 0.03, H);
          ctx.fillStyle = `rgba(255,248,230,${stA * tw})`;
          ctx.beginPath(); ctx.arc(s.x * W, yy, s.r * Math.max(0.7, H / 700), 0, TAU); ctx.fill();
        }
        // moon
        const mA = Math.max(0, Math.min(1, (a - 0.55) * 2.4));
        const mx = W * 0.2, my = H * (0.42 - 0.12 * (a - 0.55)), mr = Math.min(W, H) * 0.055;
        const gl = ctx.createRadialGradient(mx, my, mr * 0.5, mx, my, mr * 4);
        gl.addColorStop(0, `rgba(210,220,255,${0.28 * mA})`); gl.addColorStop(1, 'rgba(210,220,255,0)');
        ctx.fillStyle = gl; ctx.fillRect(mx - mr * 4, my - mr * 4, mr * 8, mr * 8);
        ctx.fillStyle = `rgba(238,240,255,${0.95 * mA})`; ctx.beginPath(); ctx.arc(mx, my, mr, 0, TAU); ctx.fill();
        ctx.fillStyle = `rgba(190,196,228,${0.5 * mA})`;
        for (const [dx, dy, rr] of [[-0.3, -0.2, 0.22], [0.25, 0.1, 0.17], [-0.05, 0.4, 0.13]]) { ctx.beginPath(); ctx.arc(mx + dx * mr, my + dy * mr, rr * mr, 0, TAU); ctx.fill(); }
      }
      // aurora
      const auA = Math.max(0, (a - 0.72) * 3.5);
      if (auA > 0) {
        ctx.save(); ctx.globalCompositeOperation = 'lighter';
        for (let k = 0; k < 3; k++) {
          const baseY = H * (0.22 + k * 0.1), hgt = H * 0.3;
          const gr = ctx.createLinearGradient(0, baseY - hgt * 0.5, 0, baseY + hgt);
          const hue = [160, 190, 280][k];
          gr.addColorStop(0, `hsla(${hue},80%,60%,0)`); gr.addColorStop(0.35, `hsla(${hue},80%,62%,${0.16 * auA})`); gr.addColorStop(1, `hsla(${hue},80%,60%,0)`);
          ctx.fillStyle = gr; ctx.beginPath(); ctx.moveTo(0, H);
          const N = 28;
          for (let i = 0; i <= N; i++) { const xx = W * i / N; ctx.lineTo(xx, baseY + Math.sin(i * 0.5 + tt * (0.25 + k * 0.1) + k) * hgt * 0.22 + Math.sin(i * 0.23 - tt * 0.17) * hgt * 0.12); }
          ctx.lineTo(W, H); ctx.closePath(); ctx.fill();
        }
        ctx.restore();
      }
      return sk;
    }

    function cloudShape(ctx, cx, cy, r) {
      ctx.beginPath();
      ctx.ellipse(cx, cy, r * 1.6, r * 0.42, 0, 0, TAU);
      ctx.moveTo(cx - r * 0.5 + r * 0.7, cy - r * 0.3); ctx.ellipse(cx - r * 0.5, cy - r * 0.3, r * 0.7, r * 0.55, 0, 0, TAU);
      ctx.moveTo(cx + r * 0.35 + r * 0.9, cy - r * 0.4); ctx.ellipse(cx + r * 0.35, cy - r * 0.4, r * 0.9, r * 0.7, 0, 0, TAU);
      ctx.moveTo(cx + r * 1.0 + r * 0.55, cy - r * 0.1); ctx.ellipse(cx + r * 1.0, cy - r * 0.1, r * 0.55, r * 0.4, 0, 0, TAU);
      ctx.fill();
    }
    const LAYER = [{ f: 0.10, a: 0.55, r: 0.04 }, { f: 0.24, a: 0.8, r: 0.056 }, { f: 0.45, a: 1, r: 0.075 }];
    function drawClouds(ctx, sk, tt) {
      const span = H * 1.4;
      for (const c of clouds) {
        const Ld = LAYER[c.L];
        const yy = mod(c.y * span + cam.dy * S * Ld.f - H * 0.2, span) - H * 0.2;
        const xx = c.x * (W + 300) - 150;
        const r = Math.min(W, H) * Ld.r * c.s;
        ctx.fillStyle = rgb(sk.cloud, sk.calpha * Ld.a * 0.8);
        cloudShape(ctx, xx, yy, r);
        ctx.fillStyle = rgb(mix(sk.cloud, sk.bot, 0.5), sk.calpha * Ld.a * 0.35);
        ctx.beginPath(); ctx.ellipse(xx, yy + r * 0.2, r * 1.5, r * 0.2, 0, 0, TAU); ctx.fill();
      }
    }
    function drawBirds(ctx, a, tt) {
      const al = Math.max(0, 0.7 - a * 1.5); if (al <= 0) return;
      ctx.strokeStyle = `rgba(80,66,120,${al})`; ctx.lineWidth = Math.max(1.5, H * 0.0028); ctx.lineCap = 'round';
      const span = H * 1.2;
      for (const b of birds) {
        const yy = mod(b.y * span + cam.dy * S * 0.3, span) - H * 0.1, bx = b.x * (W + 200) - 100;
        for (let i = 0; i < b.n; i++) {
          const ox = bx + i * H * 0.03 - (i % 2) * H * 0.012, oy = yy + (i % 3) * H * 0.014;
          const fl = Math.sin(tt * 7 + b.ph + i) * H * 0.008, w = H * 0.012;
          ctx.beginPath(); ctx.moveTo(ox - w, oy + fl * 0.4); ctx.quadraticCurveTo(ox - w * 0.4, oy - fl - w * 0.3, ox, oy); ctx.quadraticCurveTo(ox + w * 0.4, oy - fl - w * 0.3, ox + w, oy + fl * 0.4); ctx.stroke();
        }
      }
    }
    function ridge(ctx, base, amp, seed, col, step) {
      ctx.fillStyle = col; ctx.beginPath(); ctx.moveTo(0, H + 10); ctx.lineTo(0, base);
      for (let x = 0; x <= W + step; x += step) ctx.lineTo(x, base - (Math.sin(x * 0.004 + seed) * 0.5 + Math.sin(x * 0.011 + seed * 2.3) * 0.3 + 0.8) * amp);
      ctx.lineTo(W, H + 10); ctx.closePath(); ctx.fill();
    }
    function drawGround(ctx, sk, a, tt) {
      const gy = sy(0);
      if (gy > H + 600 * S) return;
      const fade = Math.max(0, 1 - a * 1.6);
      const farCol = mix(sk.bot, [120, 100, 170], 0.5);
      // mountains with parallax (they slide away slowly)
      for (const [f, amp, mixk, seed] of [[0.10, H * 0.20, 0.35, 1.1], [0.2, H * 0.14, 0.55, 3.3], [0.34, H * 0.09, 0.75, 5.7]]) {
        const base = H * 0.84 + cam.dy * S * f;
        if (base > H * 1.5) continue;
        ctx.globalAlpha = Math.max(0.35, fade);
        ridge(ctx, base, amp, seed, rgb(mix(sk.bot, mix(farCol, [60, 50, 110], mixk), 0.7 + 0.3 * mixk)), 12);
      }
      ctx.globalAlpha = 1;
      // hill foreground at world y=0
      ctx.fillStyle = rgb(mix([120, 205, 160], [40, 60, 90], a));
      ctx.beginPath(); ctx.moveTo(0, H + 20); ctx.lineTo(0, gy);
      for (let x = 0; x <= W; x += 14) ctx.lineTo(x, gy - Math.sin(x * 0.008 + 0.6) * 9 * S - Math.sin(x * 0.021) * 4 * S);
      ctx.lineTo(W, H + 20); ctx.closePath(); ctx.fill();
      ctx.fillStyle = rgb(mix([86, 176, 134], [30, 44, 72], a));
      ctx.fillRect(0, gy + 14 * S, W, H);
      // little round trees
      for (let i = 0; i < 9; i++) {
        const tx = (i * 0.137 + 0.04) * W, th = (20 + (i * 37) % 22) * S;
        const ty = gy - Math.sin(tx * 0.008 + 0.6) * 9 * S - Math.sin(tx * 0.021) * 4 * S + 2;
        if (tx > X0 - 20 * S && tx < X0 + WW * S + 20 * S) continue;
        ctx.fillStyle = rgb(mix([70, 140, 110], [26, 40, 64], a)); ctx.fillRect(tx - 2 * S, ty - th * 0.5, 4 * S, th * 0.5);
        ctx.fillStyle = rgb(mix([96, 190, 140], [34, 56, 84], a)); ctx.beginPath(); ctx.arc(tx, ty - th * 0.8, th * 0.55, 0, TAU); ctx.fill();
      }
    }

    function drawPlat(ctx, q, a, tt, ac) {
      if (q.type === 'g') return;
      let x = q.x0 + (q.x - q.x0) * ac;
      const dip = q.hit > 0 ? Math.sin(q.hit * Math.PI) * 5 * S : 0;
      let shake = 0;
      if (q.cr >= 0) shake = Math.sin(tt * 90) * 1.6 * S * (1 - q.cr / 0.3);
      const w = q.w * S, h = 14 * S, cx = sx(x) + shake, top = sy(q.y) + dip;
      if (cx + w / 2 < X0 - 20 || cx - w / 2 > X0 + WW * S + 20) return;
      // soft glow under the slab grows toward night
      if (a > 0.25) { ctx.fillStyle = `rgba(255,214,190,${0.12 * a})`; ctx.beginPath(); ctx.ellipse(cx, top + h * 0.8, w * 0.65, h * 1.1, 0, 0, TAU); ctx.fill(); }
      let cap, capHi, b0, b1;
      if (ice) { cap = '#bfeaff'; capHi = '#f2fdff'; b0 = '#cfeaff'; b1 = '#8fbbe6'; }
      else if (q.type === 'n') { cap = '#7fdcab'; capHi = '#c9f7d9'; b0 = '#fff4e8'; b1 = '#dccaf0'; }
      else if (q.type === 'm') { cap = '#7ec9ff'; capHi = '#d2eeff'; b0 = '#f2f3ff'; b1 = '#c3d0f4'; }
      else { cap = '#ffc891'; capHi = '#ffe6c4'; b0 = '#f6d2b6'; b1 = '#d3977d'; }
      // body
      const gr = ctx.createLinearGradient(0, top, 0, top + h);
      gr.addColorStop(0, b0); gr.addColorStop(1, b1);
      ctx.fillStyle = gr; roundRect(ctx, cx - w / 2, top, w, h, h * 0.5); ctx.fill();
      // cap
      ctx.fillStyle = cap; roundRect(ctx, cx - w / 2, top - 1 * S, w, h * 0.5, h * 0.3); ctx.fill();
      ctx.fillStyle = capHi; roundRect(ctx, cx - w / 2 + 3 * S, top, w - 6 * S, h * 0.16, h * 0.08); ctx.fill();
      // decoration
      if (q.type === 'n' && !ice) {
        ctx.fillStyle = cap;
        for (let i = 0; i < 4; i++) { const tx = cx - w / 2 + (0.15 + 0.7 * ((q.seed * 7 + i * 0.27) % 1)) * w; ctx.beginPath(); ctx.moveTo(tx - 3 * S, top); ctx.lineTo(tx, top - 5.5 * S); ctx.lineTo(tx + 3 * S, top); ctx.fill(); }
      } else if (q.type === 'm') {
        ctx.strokeStyle = 'rgba(70,120,200,0.7)'; ctx.lineWidth = 2 * S; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
        const pulse = 0.5 + 0.5 * Math.sin(tt * 5 + q.seed * 6);
        for (const sgn of [-1, 1]) { const ax = cx + sgn * w * 0.25; ctx.beginPath(); ctx.moveTo(ax - sgn * 3 * S, top + h * 0.33); ctx.lineTo(ax + sgn * 2 * S, top + h * 0.65); ctx.lineTo(ax - sgn * 3 * S, top + h * 0.97); ctx.globalAlpha = 0.5 + 0.5 * pulse; ctx.stroke(); ctx.globalAlpha = 1; }
        ctx.fillStyle = `rgba(160,220,255,${0.5 + 0.4 * pulse})`; ctx.beginPath(); ctx.arc(cx, top + h * 0.7, 2.2 * S, 0, TAU); ctx.fill();
      } else if (q.type === 'c') {
        ctx.strokeStyle = 'rgba(120,70,50,0.55)'; ctx.lineWidth = 1.4 * S; ctx.beginPath();
        ctx.moveTo(cx - w * 0.2, top + h * 0.1); ctx.lineTo(cx - w * 0.12, top + h * 0.5); ctx.lineTo(cx - w * 0.24, top + h * 0.95);
        ctx.moveTo(cx + w * 0.15, top + h * 0.1); ctx.lineTo(cx + w * 0.22, top + h * 0.55); ctx.lineTo(cx + w * 0.12, top + h * 0.95); ctx.stroke();
      }
      if (ice) {
        const tw = 0.5 + 0.5 * Math.sin(tt * 3 + q.seed * 9);
        ctx.fillStyle = `rgba(255,255,255,${0.5 + 0.5 * tw})`; const ix = cx + (q.seed - 0.5) * w * 0.7;
        ctx.beginPath(); ctx.moveTo(ix, top - 3 * S); ctx.lineTo(ix + 1.5 * S, top + 2 * S); ctx.lineTo(ix, top + 6 * S); ctx.lineTo(ix - 1.5 * S, top + 2 * S); ctx.fill();
      }
      // spring
      if (q.spring) {
        const bx = sx(x) + q.spring.ox * S + shake, sq = q.spring.sq || 0, hh = (13 - 7 * Math.sin(sq * Math.PI * 0.5 * (sq > 0.5 ? 1 : 1))) * S * (sq > 0.01 ? 1 : 1);
        const ext = sq > 0.01 ? (1 + 0.9 * Math.sin(Math.min(1, (1 - sq) * 2) * Math.PI * 0.5) * (sq < 0.7 ? 1 : 0)) : 1;
        const hgt = 13 * S * (sq > 0.7 ? 0.5 : ext);
        void hh;
        ctx.strokeStyle = '#c99a3c'; ctx.lineWidth = 2.4 * S; ctx.lineJoin = 'round'; ctx.beginPath();
        const coils = 4;
        ctx.moveTo(bx - 6 * S, top);
        for (let i = 0; i < coils; i++) { const yy = top - (i + 0.5) * hgt / coils; ctx.lineTo(bx + (i % 2 ? -6 : 6) * S, yy); }
        ctx.lineTo(bx, top - hgt); ctx.stroke();
        ctx.fillStyle = '#ff6f7e'; roundRect(ctx, bx - 8 * S, top - hgt - 3.5 * S, 16 * S, 4.5 * S, 2 * S); ctx.fill();
        ctx.fillStyle = 'rgba(255,255,255,0.55)'; roundRect(ctx, bx - 6 * S, top - hgt - 3 * S, 8 * S, 1.4 * S, 1 * S); ctx.fill();
      }
    }

    function drawEnemy(ctx, e, tt, ac) {
      const x = sx(e.x0 + (e.x - e.x0) * ac), y = sy(e.y0 + (e.y - e.y0) * ac), r = e.r * S;
      let al = 1; if (e.dying != null) al = Math.max(0, 1 - e.dying * 2);
      ctx.globalAlpha = al;
      if (e.type === 'bird') {
        const dirv = e.vx >= 0 ? 1 : -1, fl = Math.sin(tt * 14 + e.ph);
        ctx.save(); ctx.translate(x, y); ctx.scale(dirv, 1); if (e.dying != null) ctx.rotate(e.dying * 8);
        ctx.fillStyle = '#6d4fa8'; ctx.beginPath(); ctx.ellipse(0, 0, r * 1.05, r * 0.78, 0, 0, TAU); ctx.fill();
        ctx.fillStyle = '#f0dcff'; ctx.beginPath(); ctx.ellipse(r * 0.1, r * 0.2, r * 0.7, r * 0.42, 0, 0, TAU); ctx.fill();
        ctx.fillStyle = '#5a3d94'; ctx.beginPath(); ctx.moveTo(-r * 0.2, -r * 0.1); ctx.quadraticCurveTo(-r * 0.7, -r * (0.9 + fl * 0.9), -r * 1.2, -r * (0.3 + fl * 0.8)); ctx.quadraticCurveTo(-r * 0.7, -r * 0.2, -r * 0.2, r * 0.2); ctx.fill();
        ctx.fillStyle = '#ffb347'; ctx.beginPath(); ctx.moveTo(r * 0.95, -r * 0.1); ctx.lineTo(r * 1.55, r * 0.12); ctx.lineTo(r * 0.95, r * 0.3); ctx.fill();
        ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(r * 0.5, -r * 0.22, r * 0.24, 0, TAU); ctx.fill();
        ctx.fillStyle = '#2a1b4a'; ctx.beginPath(); ctx.arc(r * 0.56, -r * 0.2, r * 0.12, 0, TAU); ctx.fill();
        ctx.strokeStyle = '#2a1b4a'; ctx.lineWidth = r * 0.12; ctx.beginPath(); ctx.moveTo(r * 0.25, -r * 0.55); ctx.lineTo(r * 0.75, -r * 0.42); ctx.stroke();
        ctx.restore();
      } else if (e.type === 'storm') {
        const bob = Math.sin(tt * 2 + e.ph) * r * 0.04;
        ctx.fillStyle = '#4b4a78'; cloudShape(ctx, x, y + bob, r * 0.62);
        ctx.fillStyle = '#6a68a0'; cloudShape(ctx, x, y - r * 0.12 + bob, r * 0.56);
        ctx.fillStyle = '#fff'; for (const sg of [-1, 1]) { ctx.beginPath(); ctx.arc(x + sg * r * 0.3, y - r * 0.08, r * 0.15, 0, TAU); ctx.fill(); }
        ctx.fillStyle = '#251f45'; for (const sg of [-1, 1]) { ctx.beginPath(); ctx.arc(x + sg * r * 0.3, y - r * 0.04, r * 0.07, 0, TAU); ctx.fill(); }
        ctx.strokeStyle = '#251f45'; ctx.lineWidth = r * 0.07; ctx.lineCap = 'round';
        for (const sg of [-1, 1]) { ctx.beginPath(); ctx.moveTo(x + sg * r * 0.12, y - r * 0.3); ctx.lineTo(x + sg * r * 0.45, y - r * 0.2); ctx.stroke(); }
        const fz = (tt * 1.3 + e.ph) % 2.4;
        if (fz < 0.22) {
          ctx.save(); ctx.globalCompositeOperation = 'lighter'; ctx.strokeStyle = '#fff3a0'; ctx.lineWidth = r * 0.12; ctx.lineJoin = 'round';
          ctx.beginPath(); ctx.moveTo(x + r * 0.1, y + r * 0.35); ctx.lineTo(x - r * 0.15, y + r * 0.75); ctx.lineTo(x + r * 0.1, y + r * 0.75); ctx.lineTo(x - r * 0.2, y + r * 1.25); ctx.stroke();
          const lg = ctx.createRadialGradient(x, y, 0, x, y, r * 1.5); lg.addColorStop(0, 'rgba(255,240,150,0.28)'); lg.addColorStop(1, 'rgba(255,240,150,0)'); ctx.fillStyle = lg; ctx.beginPath(); ctx.arc(x, y, r * 1.5, 0, TAU); ctx.fill(); ctx.restore();
        }
        ctx.strokeStyle = 'rgba(190,210,255,0.55)'; ctx.lineWidth = r * 0.05;
        for (let i = 0; i < 4; i++) { const rx = x + (i - 1.5) * r * 0.32, ry = y + r * 0.45 + ((tt * 1.4 + i * 0.27) % 1) * r * 0.9; ctx.beginPath(); ctx.moveTo(rx, ry); ctx.lineTo(rx - r * 0.06, ry + r * 0.2); ctx.stroke(); }
      } else { // black hole
        const rot = tt * 2.2;
        const gl = ctx.createRadialGradient(x, y, r * 0.3, x, y, r * 2.2);
        gl.addColorStop(0, 'rgba(150,100,255,0.55)'); gl.addColorStop(1, 'rgba(150,100,255,0)');
        ctx.fillStyle = gl; ctx.beginPath(); ctx.arc(x, y, r * 2.2, 0, TAU); ctx.fill();
        ctx.save(); ctx.translate(x, y); ctx.rotate(rot);
        for (let k = 0; k < 4; k++) {
          ctx.strokeStyle = `rgba(${k % 2 ? '120,200,255' : '190,140,255'},${0.7 - k * 0.1})`; ctx.lineWidth = r * 0.12;
          ctx.beginPath();
          for (let i = 0; i <= 20; i++) { const u = i / 20, aa = k * TAU / 4 + u * 3.6, rr = r * (1.35 - u * 1.0); const px = Math.cos(aa) * rr, py = Math.sin(aa) * rr; if (i) ctx.lineTo(px, py); else ctx.moveTo(px, py); }
          ctx.stroke();
        }
        ctx.restore();
        ctx.fillStyle = '#05030f'; ctx.beginPath(); ctx.arc(x, y, r * 0.62, 0, TAU); ctx.fill();
        ctx.strokeStyle = 'rgba(210,180,255,0.9)'; ctx.lineWidth = r * 0.07; ctx.beginPath(); ctx.arc(x, y, r * 0.64, 0, TAU); ctx.stroke();
      }
      ctx.globalAlpha = 1;
    }

    function drawItem(ctx, it, tt) {
      const x = sx(it.x), y = sy(it.y + Math.sin(tt * 3 + it.ph) * 4), r = 16 * S;
      const gl = ctx.createRadialGradient(x, y, 0, x, y, r * 2.2); gl.addColorStop(0, 'rgba(126,240,216,0.5)'); gl.addColorStop(1, 'rgba(126,240,216,0)');
      ctx.fillStyle = gl; ctx.beginPath(); ctx.arc(x, y, r * 2.2, 0, TAU); ctx.fill();
      ctx.fillStyle = '#4fd1c5'; ctx.beginPath(); ctx.arc(x, y + r * 0.25, r * 0.85, Math.PI, TAU); ctx.fill();
      ctx.fillStyle = '#ffd36e'; ctx.fillRect(x - r * 0.9, y + r * 0.2, r * 1.8, r * 0.28);
      ctx.fillStyle = '#ff7a8a'; ctx.beginPath(); ctx.arc(x, y - r * 0.6, r * 0.2, 0, TAU); ctx.fill();
      const bw = Math.abs(Math.cos(tt * 16 + it.ph)) * r * 1.3 + r * 0.12;
      ctx.fillStyle = '#ffe28a'; ctx.beginPath(); ctx.ellipse(x, y - r * 0.82, bw, r * 0.11, 0, 0, TAU); ctx.fill();
    }

    function drawPip(ctx, X, Y, tt, ghost) {
      // X,Y: screen position of the feet
      const R = 17 * S * p.scale;
      const sq = p.squash > 0 ? Math.sin(p.squash * Math.PI) * 0.0 + p.squash : 0;
      const stretch = Math.max(-0.2, Math.min(0.22, p.vy / 5200));
      const sxs = 1 - stretch * 0.8 + (sq > 0.55 ? (sq - 0.55) * 0.9 : 0), sys = 1 + stretch - (sq > 0.55 ? (sq - 0.55) * 0.8 : 0);
      ctx.save(); ctx.translate(X, Y - BODY_H * S * p.scale); if (p.dead) ctx.rotate(p.rot);
      if (ghost) ctx.globalAlpha = ghost;
      // scarf (drawn in world coordinates relative to body)
      ctx.restore();
      ctx.save();
      if (!ghost) {
        ctx.strokeStyle = '#3fc1b0'; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
        const sc = p.scarf, ox = X - sx(p.x), oy = 0;
        for (let i = 1; i < sc.length; i++) {
          ctx.lineWidth = Math.max(1.5, (7.5 - i * 0.8)) * S;
          ctx.beginPath(); ctx.moveTo(sx(sc[i - 1].x) + ox, sy(sc[i - 1].y) + oy); ctx.lineTo(sx(sc[i].x) + ox, sy(sc[i].y) + oy); ctx.stroke();
        }
        ctx.strokeStyle = 'rgba(255,255,255,0.35)'; ctx.lineWidth = 1.5 * S;
        ctx.beginPath(); for (let i = 0; i < 4; i++) { const q = sc[i]; if (i) ctx.lineTo(sx(q.x) + ox, sy(q.y) - 1.5 * S); else ctx.moveTo(sx(q.x) + ox, sy(q.y) - 1.5 * S); } ctx.stroke();
      }
      ctx.translate(X, Y - BODY_H * S * p.scale); if (p.dead) ctx.rotate(p.rot);
      if (ghost) ctx.globalAlpha = ghost;
      ctx.scale(sxs, sys);
      // legs
      const ext = p.vy < 0 ? 3 : -1;
      ctx.fillStyle = '#e8587a';
      for (const sg of [-1, 1]) { ctx.beginPath(); ctx.ellipse(sg * R * 0.38, R * 0.95 + ext * S * 0.6, R * 0.26, R * 0.2, 0, 0, TAU); ctx.fill(); }
      // antenna leaf
      const sw = Math.sin(tt * 3) * 3 - p.vx * 0.01 - p.vy * 0.003;
      ctx.strokeStyle = '#59c98d'; ctx.lineWidth = 2 * S; ctx.lineCap = 'round';
      ctx.beginPath(); ctx.moveTo(0, -R * 0.92); ctx.quadraticCurveTo(sw * S, -R * 1.35, sw * S * 1.6, -R * 1.5); ctx.stroke();
      ctx.fillStyle = '#7fe2a6'; ctx.beginPath(); ctx.ellipse(sw * S * 1.6 + 3 * S, -R * 1.52, 5 * S, 2.6 * S, -0.5, 0, TAU); ctx.fill();
      // body
      const bg = ctx.createRadialGradient(-R * 0.35, -R * 0.4, R * 0.1, 0, 0, R * 1.1);
      bg.addColorStop(0, '#ffd9b8'); bg.addColorStop(0.55, '#ff9a7e'); bg.addColorStop(1, '#ec6788');
      ctx.fillStyle = bg; ctx.beginPath(); ctx.arc(0, 0, R, 0, TAU); ctx.fill();
      ctx.fillStyle = 'rgba(255,244,226,0.9)'; ctx.beginPath(); ctx.ellipse(0, R * 0.42, R * 0.55, R * 0.4, 0, 0, TAU); ctx.fill();
      // face
      const lookX = Math.max(-1, Math.min(1, p.vx / 300)) * R * 0.1, lookY = -Math.max(-1, Math.min(1, p.vy / 900)) * R * 0.07;
      const blink = p.blink < 0 && p.blink > -0.12;
      for (const sg of [-1, 1]) {
        const ex = sg * R * 0.36 + lookX * 0.5, ey = -R * 0.12;
        if (blink || p.dead) {
          ctx.strokeStyle = '#3a2147'; ctx.lineWidth = 1.8 * S; ctx.beginPath();
          if (p.dead) { ctx.moveTo(ex - 3 * S, ey - 3 * S); ctx.lineTo(ex + 3 * S, ey + 3 * S); ctx.moveTo(ex + 3 * S, ey - 3 * S); ctx.lineTo(ex - 3 * S, ey + 3 * S); }
          else { ctx.moveTo(ex - 3.5 * S, ey); ctx.lineTo(ex + 3.5 * S, ey); }
          ctx.stroke();
        } else {
          ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.ellipse(ex, ey, R * 0.2, R * 0.25, 0, 0, TAU); ctx.fill();
          ctx.fillStyle = '#3a2147'; ctx.beginPath(); ctx.arc(ex + lookX, ey + lookY, R * 0.12, 0, TAU); ctx.fill();
          ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(ex + lookX - R * 0.04, ey + lookY - R * 0.05, R * 0.04, 0, TAU); ctx.fill();
        }
      }
      ctx.fillStyle = 'rgba(255,120,150,0.5)';
      for (const sg of [-1, 1]) { ctx.beginPath(); ctx.ellipse(sg * R * 0.62, R * 0.14, R * 0.15, R * 0.1, 0, 0, TAU); ctx.fill(); }
      ctx.strokeStyle = '#3a2147'; ctx.lineWidth = 1.6 * S; ctx.lineCap = 'round'; ctx.beginPath();
      if (p.dead) ctx.arc(0, R * 0.38, R * 0.1, Math.PI, TAU); else if (p.vy < -300) ctx.arc(0, R * 0.2, R * 0.12, 0, TAU); else ctx.arc(0, R * 0.05, R * 0.17, 0.15, Math.PI - 0.15);
      ctx.stroke();
      // propeller beanie
      if (p.boost > 0 && !p.dead) {
        ctx.fillStyle = '#4fd1c5'; ctx.beginPath(); ctx.arc(0, -R * 0.55, R * 0.72, Math.PI * 1.05, Math.PI * 1.95); ctx.fill();
        ctx.fillStyle = '#ffd36e'; ctx.fillRect(-R * 0.72, -R * 0.62, R * 1.44, R * 0.18);
        ctx.fillStyle = '#ff7a8a'; ctx.beginPath(); ctx.arc(0, -R * 1.27, R * 0.13, 0, TAU); ctx.fill();
        const bw = Math.abs(Math.cos(tt * 24)) * R * 1.5 + R * 0.15;
        ctx.fillStyle = 'rgba(255,226,138,0.85)'; ctx.beginPath(); ctx.ellipse(0, -R * 1.4, bw, R * 0.1, 0, 0, TAU); ctx.fill();
        ctx.fillStyle = 'rgba(255,255,255,0.15)'; ctx.beginPath(); ctx.ellipse(0, -R * 1.4, R * 1.6, R * 0.2, 0, 0, TAU); ctx.fill();
      }
      ctx.restore();
    }

    function drawParticles(ctx) {
      for (let pass = 0; pass < 2; pass++) {
        ctx.save(); if (pass) ctx.globalCompositeOperation = 'lighter';
        for (const q of parts) {
          if (!!q.add !== !!pass) continue;
          const k = 1 - q.life / q.max, x = sx(q.x), y = sy(q.y);
          if (x < -20 || x > W + 20) continue;
          if (q.kind === 2) { ctx.globalAlpha = k * 0.7; ctx.fillStyle = q.col; ctx.beginPath(); ctx.arc(x, y, q.r * S * (1.6 - k * 0.6), 0, TAU); ctx.fill(); }
          else if (q.kind === 1) {
            ctx.globalAlpha = Math.min(1, k * 1.6); ctx.fillStyle = q.col; const r = q.r * S * (0.5 + k);
            ctx.save(); ctx.translate(x, y); ctx.rotate(q.rot || 0); ctx.beginPath();
            ctx.moveTo(0, -r * 1.6); ctx.quadraticCurveTo(0, 0, r * 1.6, 0); ctx.quadraticCurveTo(0, 0, 0, r * 1.6); ctx.quadraticCurveTo(0, 0, -r * 1.6, 0); ctx.quadraticCurveTo(0, 0, 0, -r * 1.6); ctx.fill(); ctx.restore();
          } else if (q.kind === 3) {
            ctx.globalAlpha = Math.min(1, k * 2); ctx.fillStyle = q.col; ctx.save(); ctx.translate(x, y); ctx.rotate(q.rot); ctx.fillRect(-q.r * S, -q.r * S * 0.5, q.r * 2 * S, q.r * S); ctx.restore();
          } else if (q.kind === 4) {
            ctx.globalAlpha = k * 0.6; ctx.strokeStyle = q.col; ctx.lineWidth = 1.5 * S; ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x - q.vx * 0.06 * S, y - q.vy * 0.06 * S); ctx.stroke();
          } else { ctx.globalAlpha = k; ctx.fillStyle = q.col; ctx.beginPath(); ctx.arc(x, y, q.r * S, 0, TAU); ctx.fill(); }
        }
        ctx.restore();
      }
    }

    function draw(ctx, w, h) {
      const ac = alphaNow();
      const tt = g.t + ac / 60;
      cam.dy = cam.y0 + (cam.y - cam.y0) * ac;
      const a = Math.max(0, Math.min(1, cam.dy / ALT_H));
      ctx.save();
      const sk = drawSky(ctx, a, tt);
      drawClouds(ctx, sk, tt);
      drawBirds(ctx, a, tt);
      drawGround(ctx, sk, a, tt);
      // shake
      if (g.shake > 0) ctx.translate(Math.sin(g.t * 80) * g.shake * g.shake * 6, Math.cos(g.t * 63) * g.shake * g.shake * 6);
      // play column
      const cw = WW * S;
      ctx.fillStyle = 'rgba(255,255,255,0.045)'; ctx.fillRect(X0, 0, cw, H);
      for (const sgn of [0, 1]) {
        const ex = sgn ? X0 + cw : X0, gr = ctx.createLinearGradient(ex, 0, ex + (sgn ? -1 : 1) * 30 * S, 0);
        gr.addColorStop(0, 'rgba(255,255,255,0.16)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
        ctx.fillStyle = gr; ctx.fillRect(sgn ? ex - 30 * S : ex, 0, 30 * S, H);
      }
      // wind streaks, ambient leaves
      for (const l of leaves) {
        const yy = mod(l.y * H * 1.2 + cam.dy * S * 0.6 + tt * 14 * l.s, H * 1.2) - H * 0.1;
        const xx = X0 + mod(l.x * cw * 1.3 + Math.sin(tt * 0.6 + l.y * 9) * 22 * S + tt * (g.wind * 0.05 + 6), cw);
        ctx.fillStyle = `rgba(255,255,255,${0.16 * (1 - a * 0.5)})`;
        ctx.beginPath(); ctx.ellipse(xx, yy, 3 * S * l.s, 1.5 * S * l.s, tt + l.x * 6, 0, TAU); ctx.fill();
      }
      ctx.save();
      ctx.beginPath(); ctx.rect(X0, 0, cw, H); ctx.clip();
      // best line + milestones
      const bestY = par * 10;
      if (bestY > cam.dy - 40 && bestY < cam.dy + viewH + 40) {
        const yy = sy(bestY);
        ctx.setLineDash([10 * S, 8 * S]); ctx.strokeStyle = 'rgba(255,226,138,0.85)'; ctx.lineWidth = 2 * S;
        ctx.beginPath(); ctx.moveTo(X0, yy); ctx.lineTo(X0 + cw, yy); ctx.stroke(); ctx.setLineDash([]);
        ctx.font = `600 ${Math.round(14 * S)}px Fredoka, sans-serif`; ctx.textAlign = 'left'; ctx.fillStyle = 'rgba(255,236,170,0.95)';
        ctx.fillText(`BEST ${fmt(par)}`, X0 + 10 * S, yy - 6 * S);
      }
      const m0 = Math.floor(cam.dy / 1000) + 1;
      ctx.font = `500 ${Math.round(12 * S)}px "IBM Plex Mono", monospace`; ctx.textAlign = 'right'; ctx.fillStyle = 'rgba(255,255,255,0.4)';
      for (let m = m0; m * 1000 < cam.dy + viewH; m++) {
        if (m % 5 === 0) continue;
        const yy = sy(m * 1000); ctx.fillRect(X0 + cw - 26 * S, yy, 26 * S, 1.5 * S); ctx.fillText(`${m * 100}`, X0 + cw - 30 * S, yy + 4 * S);
      }
      // world things
      for (const q of plats) { if (q.y > cam.dy - 40 && q.y < cam.dy + viewH + 40) drawPlat(ctx, q, a, tt, ac); }
      for (const it of items) if (!it.taken) drawItem(ctx, it, tt);
      for (const e of enemies) if (!e.dead) drawEnemy(ctx, e, tt, ac);
      // player
      if (p.trail.length) for (const tr of p.trail) { ctx.globalAlpha = tr.a * 0.22; drawGhost(ctx, tr, tt); }
      ctx.globalAlpha = 1;
      const px = p.x0 + (p.x - p.x0) * ac, py = p.y0 + (p.y - p.y0) * ac;
      if (!(p.sucked && p.scale <= 0.01)) {
        const bx = sx(px), by = sy(py);
        drawPip(ctx, bx, by, tt, 0);
        if (px < 30) drawPip(ctx, sx(px + WW), by, tt, 0); else if (px > WW - 30) drawPip(ctx, sx(px - WW), by, tt, 0);
      }
      drawParticles(ctx);
      for (const t of texts) {
        const k = t.t / t.max, e = ease.outCubic(Math.min(1, t.t / 0.6));
        ctx.globalAlpha = k < 0.15 ? k / 0.15 : k > 0.7 ? 1 - (k - 0.7) / 0.3 : 1;
        ctx.font = `600 ${Math.round(22 * S * t.size)}px Fredoka, sans-serif`; ctx.textAlign = 'center'; ctx.lineJoin = 'round';
        const yy = sy(t.y + e * 50), xx = Math.max(X0 + 50 * S, Math.min(X0 + cw - 50 * S, sx(t.x)));
        ctx.lineWidth = 5 * S; ctx.strokeStyle = 'rgba(40,30,80,0.45)'; ctx.strokeText(t.txt, xx, yy); ctx.fillStyle = t.col; ctx.fillText(t.txt, xx, yy);
      }
      ctx.globalAlpha = 1;
      ctx.restore();
      // wind streaks across the column
      if (gusty && g.wind) {
        const al = Math.min(1, Math.abs(g.wind) / 400);
        ctx.strokeStyle = `rgba(255,255,255,${0.22 * al})`; ctx.lineWidth = 2 * S; ctx.lineCap = 'round';
        for (let i = 0; i < 14; i++) {
          const yy = mod(i * 0.173 * H + cam.dy * S * 0.2, H), len = (60 + (i % 4) * 30) * S;
          const xx = mod((i * 0.37 + tt * Math.sign(g.wind) * (0.8 + (i % 3) * 0.3)) * (W + len) , W + len) - len;
          ctx.beginPath(); ctx.moveTo(xx, yy); ctx.lineTo(xx + len, yy); ctx.stroke();
        }
      }
      if (ice) { // frosty edge vignette
        const gr = ctx.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.45, W / 2, H / 2, Math.max(W, H) * 0.8);
        gr.addColorStop(0, 'rgba(190,230,255,0)'); gr.addColorStop(1, 'rgba(190,230,255,0.16)'); ctx.fillStyle = gr; ctx.fillRect(0, 0, W, H);
      }
      if (g.mist > cam.dy - 100) {
        const my = sy(g.mist), al = Math.min(1, (g.mist - (cam.dy - 160)) / 120);
        const mg = ctx.createLinearGradient(0, my - 40 * S, 0, my + 120 * S);
        mg.addColorStop(0, 'rgba(235,225,255,0)'); mg.addColorStop(0.35, `rgba(235,225,255,${0.55 * al})`); mg.addColorStop(1, `rgba(215,200,245,${0.85 * al})`);
        ctx.fillStyle = mg; ctx.beginPath(); ctx.moveTo(0, H);
        for (let x = 0; x <= W + 20; x += 20) ctx.lineTo(x, my - 14 * S + Math.sin(x * 0.012 + tt * 1.3) * 8 * S + Math.sin(x * 0.03 - tt * 0.8) * 4 * S);
        ctx.lineTo(W, H); ctx.closePath(); ctx.fill();
      }
      // vignette
      const vg = ctx.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.5, W / 2, H / 2, Math.max(W, H) * 0.85);
      vg.addColorStop(0, 'rgba(0,0,20,0)'); vg.addColorStop(1, `rgba(0,0,20,${0.28 + 0.15 * a})`); ctx.fillStyle = vg; ctx.fillRect(0, 0, W, H);
      // score pill
      {
        const fs = Math.max(16, Math.min(40, H * 0.04)), cx = X0 + cw / 2, cy = H * 0.055;
        const txt = fmt(g.score) + ' m';
        ctx.font = `600 ${Math.round(fs)}px Fredoka, sans-serif`; const tw = ctx.measureText(txt).width + fs * 1.4;
        ctx.fillStyle = 'rgba(30,24,70,0.38)'; roundRect(ctx, cx - tw / 2, cy - fs * 0.75, tw, fs * 1.5, fs * 0.75); ctx.fill();
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillStyle = '#fff'; ctx.fillText(txt, cx, cy + 1); ctx.textBaseline = 'alphabetic';
      }
      // banners
      for (const b of banners) {
        const k = b.t / b.max, e = ease.outBack(Math.min(1, b.t / 0.4)), al = k > 0.8 ? 1 - (k - 0.8) / 0.2 : 1;
        const fs = Math.max(26, Math.min(70, H * 0.075)) * e;
        ctx.globalAlpha = al; ctx.textAlign = 'center'; ctx.lineJoin = 'round';
        ctx.font = `600 ${Math.round(fs)}px Fredoka, sans-serif`;
        const bx = X0 + cw / 2, by = H * 0.25;
        ctx.lineWidth = fs * 0.14; ctx.strokeStyle = 'rgba(30,30,90,0.5)'; ctx.strokeText(b.txt, bx, by); ctx.fillStyle = b.col; ctx.fillText(b.txt, bx, by);
        ctx.font = `500 ${Math.round(fs * 0.36)}px Fredoka, sans-serif`; ctx.fillStyle = 'rgba(255,255,255,0.9)'; ctx.fillText(b.sub, bx, by + fs * 0.5);
        ctx.globalAlpha = 1;
      }
      if (g.over && g.deathKind === 'fall') { ctx.fillStyle = `rgba(20,10,50,${Math.min(0.35, g.endT * 0.3)})`; ctx.fillRect(0, 0, W, H); }
      ctx.restore();
    }
    function drawGhost(ctx, tr) {
      const x = sx(tr.x), y = sy(tr.y) - BODY_H * S;
      ctx.fillStyle = '#ffb3a0'; ctx.beginPath(); ctx.arc(x, y, 15 * S, 0, TAU); ctx.fill();
    }

    return {
      style, superAI, twist,
      get over() { return g.over; }, get won() { return g.won; }, get score() { return g.score; },
      resize(w, h) {
        W = w; H = h;
        S = Math.min(H / VH, W * 0.92 / WW); X0 = (W - WW * S) / 2; viewH = H / S;
        cam.dy = cam.y; genUntil(cam.y + viewH + 700);
      },
      step, draw,
      hud() { return { score: fmt(g.score) + ' m', detail: `${g.stomps} stomps · ${g.springs} springs` }; },
      result() {
        const m = fmt(g.score);
        const why = { mist: 'was swallowed by the rising mist', fall: 'fell past the last cloud', bird: 'collided with a bird', storm: 'ran into a storm cloud', hole: 'was swallowed by a black hole' }[g.deathKind];
        if (g.reason === 'time') return `Still climbing at ${m} m when time ran out (${style})`;
        return `Climbed ${m} m, then ${why} (${style})`;
      },
    };
  }

  Arcade.register({
    id: 'climber', name: 'Dawn Ascent', genre: 'Endless jumper',
    aiNote: 'Sees only the platforms and hazards on screen and steers left or right with human-speed key presses; it cannot see what is above the top edge.',
    blurb: 'Bounce from sunrise to starlight, as high as it goes.',
    bg: '#5a5fc0', accent: '#ff9a76',
    endless: true, parScore: PAR_SCORE,
    twists: TWISTS,
    create,
  });
})();
