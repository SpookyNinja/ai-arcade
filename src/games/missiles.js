// missiles.js — Afterglow Command (missile defense). See DESIGN.md 8.5 #3.
(() => {
'use strict';

// ---------------------------------------------------------------------------
// Afterglow Command. Endless Missile Command in a neon synthwave dusk.
// World is a fixed 1200x700 box scaled to fit; the background fills the canvas.
// ---------------------------------------------------------------------------
const WW = 1200, WH = 700, GY = 610;
const BASE_X = [92, 600, 1108];
const CITY_X = [232, 346, 460, 740, 854, 968];
const IV = 640;                 // interceptor speed (u/s) — a rule of the game
const AMMO = 10, TIME_CAP = 900, VCAP = 118, CITY_BONUS = 10000;
const PAR = 22000;
const BL = {
  int:    { R: 64, g: 0.32, h: 0.85, L: 1.35 },
  chain:  { R: 46, g: 0.22, h: 0.60, L: 1.00 },
  ground: { R: 42, g: 0.25, h: 0.45, L: 0.95 },
};
function blastR(kind, t) {
  const b = BL[kind];
  if (t <= 0 || t >= b.L) return 0;
  if (t < b.g) return b.R * ease.outCubic(t / b.g);
  if (t < b.h) return b.R;
  const u = (t - b.h) / (b.L - b.h);
  return b.R * (1 - u * u);
}
const TWISTS = [
  { key: 'mirv', name: 'MIRV storm', desc: 'Salvos of splitting warheads interrupt every wave.' },
  { key: 'smart', name: 'Smart bombs', desc: 'Many warheads sidestep your growing blasts.' },
];
const fmt = n => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
const hash = (a, b) => { let h = (a * 374761393 + b * 668265263) | 0; h = Math.imul(h ^ (h >>> 13), 1274126177); return ((h ^ (h >>> 16)) >>> 0) / 4294967295; };
const alphaNow = () => { const a = Arcade.alpha; return a === undefined ? 1 : clamp(a, 0, 1); };

// ---- offscreen helpers ------------------------------------------------------
const _layers = {};
function staticLayer(ctx, key, W, H, paint) {
  const sc = Math.min(2, (ctx.getTransform ? ctx.getTransform().a : 1) || 1);
  let l = _layers[key];
  if (!l || l.W !== W || l.H !== H || l.sc !== sc) {
    const c = document.createElement('canvas'); c.width = Math.max(1, Math.ceil(W * sc)); c.height = Math.max(1, Math.ceil(H * sc));
    l = _layers[key] = { c, W, H, sc };
    const x = c.getContext('2d'); x.setTransform(sc, 0, 0, sc, 0, 0); paint(x, W, H);
  }
  ctx.drawImage(l.c, 0, 0, W, H);
}
const SPR = {};
function glow(name, r, g, b) {
  if (SPR[name]) return SPR[name];
  const cv = document.createElement('canvas'); cv.width = cv.height = 96;
  const x = cv.getContext('2d'), gr = x.createRadialGradient(48, 48, 0, 48, 48, 48);
  gr.addColorStop(0, `rgba(${r},${g},${b},0.95)`); gr.addColorStop(0.28, `rgba(${r},${g},${b},0.4)`); gr.addColorStop(1, `rgba(${r},${g},${b},0)`);
  x.fillStyle = gr; x.fillRect(0, 0, 96, 96);
  return (SPR[name] = cv);
}
const G_PINK = () => glow('pink', 255, 70, 140), G_CYAN = () => glow('cyan', 70, 230, 255), G_ORG = () => glow('org', 255, 150, 50),
  G_WHITE = () => glow('white', 255, 255, 255), G_RED = () => glow('red', 255, 60, 50), G_GOLD = () => glow('gold', 255, 210, 90), G_VIO = () => glow('vio', 160, 90, 255);

// ---------------------------------------------------------------------------
// STYLES (AI tactics). wait: only fire at a threat when its slack is below this (seconds), or when
// the shot is worth minCover. ammoK scales how stingy it is. late<0 prefers waiting for clusters.
// ---------------------------------------------------------------------------
const STYLES = [
  { name: 'Early bird',     wait: 99,  minCover: 99, ammoK: 0.7, late: 1.0 },
  { name: 'Conservator',    wait: 2.6, minCover: 99, ammoK: 1.2, late: 0.2 },
  { name: 'Cluster hunter', wait: 2.6, minCover: 2.3, ammoK: 0.9, late: -0.6 },
];

// ---------------------------------------------------------------------------
// AI. Sees only what is on screen: warheads (position + trail origin; velocity is estimated from
// their last observed positions), bombers, interceptors in flight with their target marks, live blasts,
// cities, bases with ammo, and its own crosshair. It does NOT know spawn schedules, MIRV split heights
// or where a warhead will go beyond extending its straight line. It acts only by moving a crosshair
// (speed/accel-limited, like a hand) and clicking (one click per ~0.17 s, 0.06 s after settling).
// ---------------------------------------------------------------------------
function makeAI(sup, S) {
  const Vc = sup ? 7500 : 1750;
  const REACT = sup ? 0 : 0.06;
  const TOL = sup ? 4 : 12;
  const TAUS = [0.35, 0.5, 0.65, 0.8, 0.95, 1.1];
  const hist = new Map(), noise = new Map();
  let speedAvg = 85, reactT = 0, tickN = 0, last = { mx: WW / 2, my: 280, click: -1 }, lastPrim = -1;
  let cur = { x: WW / 2, y: 280 }, o = null;

  const lat = (px, py) => {
    const d = Math.hypot(px - cur.x, py - cur.y);
    return (d > TOL ? d / Vc * 1.08 + (sup ? 0 : 0.1) : 0) + REACT + Math.max(0, o.fireCd);
  };
  function bestBase(px, py) {
    let best = null;
    for (let i = 0; i < o.bases.length; i++) {
      const b = o.bases[i]; if (!b.alive || b.ammo <= 0) continue;
      const fl = Math.hypot(b.x - px, GY - 34 - py) / IV;
      const cost = fl + (b.ammo <= 2 ? 0.35 : b.ammo <= 4 ? 0.1 : 0);
      if (!best || cost < best.cost) best = { i, fl, cost };
    }
    return best;
  }
  const winCover = (th, cx, cy, Tb, m) => {
    for (let i = 0; i < TAUS.length; i++) {
      const tau = TAUS[i]; if (th.kind === 'smart' && tau < 0.75) continue;
      const s = Tb + tau; if (s >= th.simp) return false;
      const r = blastR('int', tau) - m; if (r <= 0) continue;
      const dx = th.x + th.vx * s - cx, dy = th.y + th.vy * s - cy;
      if (dx * dx + dy * dy < r * r) return true;
    }
    return false;
  };
  const liveCover = (th, b) => {
    for (const tau of [0.05, 0.2, 0.4, 0.6, 0.8]) {
      const age = b.age + tau, r = blastR(b.kind, age) - 4; if (r <= 0) return false;
      if (th.kind === 'smart' && age < 0.6) continue;
      if (tau >= th.simp) return false;
      const dx = th.x + th.vx * tau - b.x, dy = th.y + th.vy * tau - b.y;
      if (dx * dx + dy * dy < r * r) return true;
    }
    return false;
  };
  function isDoomed(th) {
    for (const it of o.interceptors) if (winCover(th, it.tx, it.ty, Math.hypot(it.tx - it.x, it.ty - it.y) / IV, sup ? 3 : 6)) return true;
    for (const b of o.blasts) if (b.kind !== 'ground' && liveCover(th, b)) return true;
    return false;
  }
  function buildThreats() {
    const out = [], ids = new Set(), now = o.t;
    for (const w of o.warheads) {
      ids.add(w.id);
      let h = hist.get(w.id); if (!h) { h = []; hist.set(w.id, h); }
      const lh = h[h.length - 1];
      if (!lh || now - lh.t >= 0.04) h.push({ t: now, x: w.x, y: w.y });
      const win = w.kind === 'smart' ? 0.2 : 0.4;
      while (h.length > 2 && now - h[0].t > win) h.shift();
      const a = h[0], n = h[h.length - 1];
      let vx, vy;
      if (n.t - a.t >= 0.1) { vx = (n.x - a.x) / (n.t - a.t); vy = (n.y - a.y) / (n.t - a.t); speedAvg = speedAvg * 0.99 + Math.hypot(vx, vy) * 0.01; }
      else { const dx = w.x - w.sx, dy = w.y - w.sy, d = Math.hypot(dx, dy) || 1; vx = dx / d * speedAvg; vy = dy / d * speedAvg; }
      if (!sup) { let f = noise.get(w.id); if (f === undefined) { f = 1 + 0.025 * rnd.gauss(); noise.set(w.id, f); } vx *= f; vy *= f; }
      if (vy <= 1) continue;
      const simp = (GY - 6 - w.y) / vy; if (simp < 0.3) continue;
      const xi = w.x + vx * simp;
      let val = 0;
      for (const c of o.cities) if (c.alive && Math.abs(c.x - xi) < 44) val = 1.0;
      if (!val) for (const b of o.bases) if (b.alive && Math.abs(b.x - xi) < 44) val = 0.45 + 0.04 * b.ammo;
      if (w.kind === 'mirv') val = 1.9;
      if (w.kind === 'smart') val *= 1.25;
      if (val <= 0) continue;
      out.push({ id: w.id, kind: w.kind, x: w.x, y: w.y, vx, vy, simp, val });
    }
    for (const p of o.planes) {
      const simp = p.vx > 0 ? (WW + 40 - p.x) / p.vx : (p.x + 40) / -p.vx;
      ids.add(p.id);
      out.push({ id: p.id, kind: 'plane', x: p.x, y: p.y, vx: p.vx, vy: 0, simp, val: 1.9 });
    }
    if (hist.size > ids.size + 8) for (const k of hist.keys()) if (!ids.has(k)) { hist.delete(k); noise.delete(k); }
    return out;
  }
  function solve(th) {
    const tau0 = th.kind === 'smart' ? 0.85 : 0.5;
    let s = 0.6, b = null, px = 0, py = 0;
    for (let it = 0; it < 4; it++) {
      px = th.x + th.vx * s; py = th.y + th.vy * s;
      b = bestBase(px, py); if (!b) return null;
      s = lat(px, py) + b.fl + tau0;
    }
    px = th.x + th.vx * s; py = th.y + th.vy * s;
    if (s > th.simp - 0.15 || py < 28 || py > GY - 70 || px < 10 || px > WW - 10) return null;
    return { s, px, py };
  }
  function evalCand(px, py, ths, primary) {
    const b = bestBase(px, py); if (!b) return null;
    const Tb = lat(px, py) + b.fl, m = sup ? 3 : 6;
    let cover = 0, hit = false;
    for (const th of ths) if (winCover(th, px, py, Tb, m)) { cover += th.val; if (th === primary) hit = true; }
    return hit ? { cover, base: b.i, px, py } : null;
  }
  function decide() {
    const all = buildThreats(), und = [];
    for (const th of all) if (!isDoomed(th)) und.push(th);
    const sols = [];
    for (const th of und) { const sol = solve(th); if (sol) { th.sol = sol; th.slack = th.simp - 0.35 - sol.s; sols.push(th); } }
    if (!sols.length) { lastPrim = -1; return { mx: WW / 2 + 220 * Math.sin(o.t * 0.31), my: 290 + 40 * Math.sin(o.t * 0.23), click: -1 }; }
    let prim = sols[0];
    for (const th of sols) if (th.slack < prim.slack) prim = th;
    const keep = sols.find(t => t.id === lastPrim);
    if (keep && keep.slack <= prim.slack + 0.4) prim = keep;
    lastPrim = prim.id;
    const sol = prim.sol;
    const cands = [];
    const add = (px, py, s) => { const c = evalCand(px, py, und, prim); if (c) { c.s = s; c.score = c.cover - S.late * 0.06 * (s - sol.s); cands.push(c); } };
    add(sol.px, sol.py, sol.s);
    for (const d of sup ? [0.4, 0.8, 1.3] : [0.5, 1.1]) {
      const s2 = sol.s + d; if (s2 < prim.simp - 0.3) add(prim.x + prim.vx * s2, prim.y + prim.vy * s2, s2);
    }
    const near = sols.filter(t => t !== prim && t.kind !== 'plane' && prim.kind !== 'plane')
      .map(t => ({ t, d: Math.hypot(t.x + t.vx * sol.s - sol.px, t.y + t.vy * sol.s - sol.py) })).sort((a, b) => a.d - b.d).slice(0, sup ? 9 : 5);
    for (const { t } of near) for (const d of sup ? [0, 0.4, 0.8, 1.2] : [0, 0.5, 1.0]) {
      const s = sol.s + d; if (s > prim.simp - 0.3) continue;
      const ax = prim.x + prim.vx * s, ay = prim.y + prim.vy * s, bx = t.x + t.vx * s, by = t.y + t.vy * s;
      if (Math.hypot(ax - bx, ay - by) < 108) { const px = (ax + bx) / 2, py = (ay + by) / 2; if (py > 28 && py < GY - 70) add(px, py, s); }
    }
    if (!cands.length) return { mx: sol.px, my: sol.py, click: -1 };
    let best = cands[0]; for (const c of cands) if (c.score > best.score) best = c;
    // gating: stingy / patient styles wait until the shot is urgent or really worth it
    let ammo = 0; for (const b of o.bases) if (b.alive) ammo += b.ammo;
    const cost = S.ammoK * (ammo < 6 ? 0.9 : ammo < 12 ? 0.55 : 0.3);
    const urgent = prim.slack <= S.wait;
    const worth = best.cover >= S.minCover;
    if ((!urgent && !worth) || (best.cover < cost && prim.slack > 0.5)) return { mx: sol.px, my: sol.py, click: -1 };
    const d = Math.hypot(best.px - cur.x, best.py - cur.y);
    let click = -1;
    if (d < TOL) { reactT -= 0.05; if (reactT <= 0 && o.fireCd <= 0 && o.bases[best.base].cd <= 0) { click = best.base; reactT = REACT; } }
    else reactT = REACT;
    return { mx: best.px, my: best.py, click };
  }
  return {
    tick(dt, obs) {
      o = obs; cur = obs.cursor; tickN++;
      if (!sup && tickN % 3) return { mx: last.mx, my: last.my, click: -1 };
      last = decide();
      return last;
    },
  };
}

// ---------------------------------------------------------------------------
function create(opts = {}) {
  const sup = !!opts.superAI;
  const S = sup ? { name: 'Super AI', wait: 99, minCover: 99, ammoK: 0.8, late: -0.5 } : rnd.pick(STYLES);
  const ai = makeAI(sup, S);
  let twist = null;
  if (opts.twist) { twist = typeof opts.twist === 'string' ? (TWISTS.find(t => t.key === opts.twist) || rnd.pick(TWISTS)) : rnd.pick(TWISTS); }
  const parts = new Particles();
  const best = opts.best || PAR;
  const inst = {
    over: false, won: false, style: S.name, superAI: sup, twist: twist ? { key: twist.key, name: twist.name, desc: twist.desc } : undefined,
    score: 0, t: 0, W: 800, H: 600, L: null,
  };
  const G = {
    wave: 0, phase: 'wave', q: [], waveT: 0, between: 0, mult: 1, spec: null,
    warheads: [], planes: [], ints: [], blasts: [], ghosts: [], floaters: [], banners: [],
    cities: CITY_X.map(x => ({ x, alive: true, rise: 1, ember: Math.random() * 6 })),
    bases: BASE_X.map(x => ({ x, alive: true, ammo: AMMO, cd: 0, flash: 0, aim: -Math.PI / 2, pips: 1 })),
    nextBonus: CITY_BONUS, pending: 0, id: 1, fireCd: 0, shake: 0, flash: 0, overT: 0, kills: 0, shots: 0,
    cursor: { x: WW / 2, y: 280, px: WW / 2, py: 280, vx: 0, vy: 0, tx: WW / 2, ty: 280, click: 0 },
    stormT: -1, introduced: {}, msg: '', smartSeen: false,
  };
  inst.G = G;
  const stars = []; for (let i = 0; i < 110; i++) stars.push({ u: Math.random(), v: Math.pow(Math.random(), 1.4) * 0.8, s: 0.6 + Math.random() * 1.4, ph: Math.random() * 6.28, sp: 0.5 + Math.random() * 2 });
  let shoot = { t: -1 };

  const aliveCities = () => G.cities.reduce((a, c) => a + (c.alive ? 1 : 0), 0);
  const totalAmmo = () => G.bases.reduce((a, b) => a + (b.alive ? b.ammo : 0), 0);
  function addScore(p) {
    G.mult = G.mult || 1;
    inst.score += p;
    while (inst.score >= G.nextBonus) { G.nextBonus += CITY_BONUS; G.pending = Math.min(6, G.pending + 1); }
  }
  function banner(txt, sub, kind, dur) { G.banners.push({ txt, sub, kind: kind || 'pink', t: 0, dur: dur || 2.4 }); if (G.banners.length > 4) G.banners.shift(); }
  function floater(txt, x, y, col, big) { if (G.floaters.length < 40) G.floaters.push({ txt, x, y, col: col || '#fff', t: 0, big: !!big }); }
  function burst(x, y, n, o2) { if (parts.list.length < 650) parts.burst(x, y, n, o2); }

  // ---- waves ----------------------------------------------------------------
  function waveSpec(w) {
    const tw = twist && twist.key;
    return {
      mult: Math.min(6, 1 + ((w - 1) >> 1)),
      speed: Math.min(VCAP, 56 + 4 * w),
      n: Math.round(6 + 2.2 * w + Math.max(0, w - 7) * 1.1),
      pm: w >= 3 ? Math.min(0.38, 0.07 * (w - 2)) : 0,
      ps: tw === 'smart' ? Math.min(0.28, 0.08 + 0.012 * w) : w >= 7 ? Math.min(0.3, 0.05 * (w - 6)) : 0,
      planes: w >= 5 ? 1 + ((w - 5) / 4 | 0) : 0,
      split: 2 + (w >= 8 ? 1 : 0) + (w >= 12 ? 1 : 0),
      gap: Math.max(0.9, 3.0 - 0.14 * w),
    };
  }
  function pickTarget() {
    const opts2 = [];
    for (const c of G.cities) if (c.alive) opts2.push([c.x, 3]);
    for (const b of G.bases) if (b.alive) opts2.push([b.x, 1.4]);
    if (!opts2.length) return rnd.pick(CITY_X);
    let tot = 0; for (const o2 of opts2) tot += o2[1];
    let r = Math.random() * tot; for (const o2 of opts2) { r -= o2[1]; if (r <= 0) return o2[0]; }
    return opts2[0][0];
  }
  function startWave(w) {
    G.wave = w; G.phase = 'wave'; G.waveT = 0;
    const sp = G.spec = waveSpec(w); G.mult = sp.mult;
    for (const b of G.bases) { b.alive = true; b.ammo = AMMO; b.pips = 0; }
    G.q = [];
    let tt = 1.4, left = sp.n;
    while (left > 0) {
      const k = Math.min(left, 1 + rnd.int(1 + Math.floor(w / 2.5)), 6);
      const tx0 = pickTarget(), x0 = rnd.float(60, WW - 60), clustered = Math.random() < 0.5;
      for (let i = 0; i < k; i++) {
        let kind = 'w';
        const r = Math.random();
        if (r < sp.pm) kind = 'mirv'; else if (r < sp.pm + sp.ps) kind = 'smart';
        G.q.push({ t: tt + i * rnd.float(0.1, 0.3), kind, x0: clustered ? clamp(x0 + rnd.float(-60, 60), 20, WW - 20) : rnd.float(40, WW - 40), tx: clustered ? tx0 + rnd.float(-30, 30) : pickTarget() });
      }
      left -= k; tt += sp.gap * rnd.float(0.7, 1.3);
    }
    for (let i = 0; i < sp.planes; i++) G.q.push({ t: rnd.float(3, 11), kind: 'plane' });
    G.stormT = twist && twist.key === 'mirv' && w >= 2 ? rnd.float(4, 9) : -1;
    G.q.sort((a, b) => a.t - b.t);
    banner('WAVE ' + w, w === 3 && !G.introduced.m ? 'MIRV warheads split in two' : w === 5 && !G.introduced.p ? 'Bombers overhead' : w === 7 && !G.introduced.s && !(twist && twist.key === 'smart') ? 'Smart bombs dodge growing blasts' : '×' + sp.mult + ' points', 'pink', 2.0);
    if (w === 3) G.introduced.m = 1; if (w === 5) G.introduced.p = 1; if (w === 7) G.introduced.s = 1;
    if (twist && twist.key === 'smart' && w === 1) banner('SMART BOMBS', 'They sidestep growing blasts', 'red', 2.6);
  }
  function spawnHead(kind, x0, tx, speed, y0, pos) {
    const sx = pos ? pos.x : x0, sy = pos ? pos.y : (y0 === undefined ? -50 : y0), ty = GY - 6;
    const dx = tx - sx, dy = ty - sy, d = Math.hypot(dx, dy);
    const sp = speed * (kind === 'smart' ? 1.08 : 1) * rnd.float(0.9, 1.1);
    const w = { id: G.id++, kind, x: sx, y: sy, px: sx, py: sy, sx, sy, vx: dx / d * sp, vy: dy / d * sp, speed: sp, tx, ty,
      splitY: kind === 'mirv' ? rnd.float(190, 330) : 0, dodges: 0, dodge: null, pts: [{ x: sx, y: sy }], age: 0 };
    G.warheads.push(w); return w;
  }
  function spawnPlane() {
    const dir = Math.random() < 0.5 ? 1 : -1, sp = rnd.float(105, 125);
    const p = { id: G.id++, x: dir > 0 ? -40 : WW + 40, y: rnd.float(70, 170), px: 0, py: 0, vx: dir * sp, drops: 3 + Math.floor(G.wave / 5), nextDrop: rnd.float(2.2, 3.4) };
    p.px = p.x; p.py = p.y; G.planes.push(p);
  }
  function doSpawns(dt) {
    G.waveT += dt;
    while (G.q.length && G.q[0].t <= G.waveT) {
      const e = G.q.shift();
      if (e.kind === 'plane') spawnPlane(); else spawnHead(e.kind, e.x0, e.tx, G.spec.speed);
    }
    if (G.stormT >= 0 && G.waveT >= G.stormT) {
      G.stormT = -1; banner('MIRV STORM', 'Splitting warheads incoming', 'red', 2.4); G.shake = Math.max(G.shake, 0.6);
      const n = 3 + Math.floor(G.wave / 4);
      for (let i = 0; i < n; i++) G.q.push({ t: G.waveT + 0.4 + i * 0.35, kind: 'mirv', x0: rnd.float(60, WW - 60), tx: pickTarget() });
      G.q.sort((a, b) => a.t - b.t);
    }
  }

  // ---- blasts / kills ---------------------------------------------------------
  function addBlast(kind, x, y, root) {
    const b = { kind, x, y, t: 0, root: root || null, total: 0, seed: Math.random() * 6 };
    if (!b.root && kind !== 'ground') b.root = b;
    G.blasts.push(b); return b;
  }
  const PTS = { w: 25, bomb: 25, mirv: 50, smart: 75, plane: 100 };
  function killHead(w, b) {
    w.dead = true;
    G.kills++;
    const pts = (PTS[w.kind] || 25) * G.mult; addScore(pts);
    floater('+' + pts, w.x, w.y - 8, w.kind === 'smart' ? '#7dffb0' : '#ffe08a');
    burst(w.x, w.y, 6, { speed: 150, life: 0.7, size: 2.4, color: ['#ff9ad0', '#ffd36e', '#fff'], drag: 3 });
    G.ghosts.push({ pts: w.pts.concat([{ x: w.x, y: w.y }]), col: 'pink', t: 0, life: 0.9 });
    const root = b.root || b;
    root.total++;
    if (root.total === 3 || root.total === 5 || root.total === 8) floater('CHAIN ×' + root.total, w.x, w.y - 30, '#7df9ff', true);
    addBlast('chain', w.x, w.y, root);
  }
  function destroyCity(c) {
    c.alive = false; c.ruinT = 0;
    burst(c.x, GY - 14, 26, { speed: 220, life: 1.3, size: 3.2, color: ['#ff7a3d', '#ffd36e', '#ff4f9a', '#fff'], gravity: 260, angle: -Math.PI / 2, spread: 1.3 });
    if (aliveCities() === 0) finish();
  }
  function groundHit(w) {
    addBlast('ground', w.x, GY - 4);
    G.shake = Math.max(G.shake, 0.9); G.flash = Math.max(G.flash, 0.25);
    burst(w.x, GY - 4, 16, { speed: 200, life: 0.9, size: 2.8, color: ['#ff5a3c', '#ffb347', '#fff'], gravity: 300, angle: -Math.PI / 2, spread: 1.2 });
    for (const c of G.cities) if (c.alive && Math.abs(c.x - w.x) < 40) destroyCity(c);
    for (const b of G.bases) if (b.alive && Math.abs(b.x - w.x) < 44) { b.alive = false; b.ammo = 0; burst(b.x, GY - 16, 18, { speed: 200, life: 1.1, size: 3, color: ['#7df9ff', '#ff9ad0', '#fff'], gravity: 260, angle: -Math.PI / 2, spread: 1.3 }); }
  }
  function finish(msg) {
    if (inst.over) return;
    inst.over = true; inst.won = false; G.overT = 0; G.flash = 1; G.shake = 2;
    G.msg = msg || '';
  }

  // ---- stepping -----------------------------------------------------------------
  function observe() {
    return {
      t: inst.t, wave: G.wave, fireCd: G.fireCd,
      cursor: { x: G.cursor.x, y: G.cursor.y },
      warheads: G.warheads.map(w => ({ id: w.id, x: w.x, y: w.y, sx: w.sx, sy: w.sy, kind: w.kind })),
      planes: G.planes.map(p => ({ id: p.id, x: p.x, y: p.y, vx: p.vx })),
      interceptors: G.ints.map(i => ({ x: i.x, y: i.y, tx: i.tx, ty: i.ty })),
      blasts: G.blasts.map(b => ({ kind: b.kind, x: b.x, y: b.y, age: b.t })),
      cities: G.cities.map(c => ({ x: c.x, alive: c.alive })),
      bases: G.bases.map(b => ({ x: b.x, alive: b.alive, ammo: b.ammo, cd: b.cd })),
    };
  }
  function tryFire(bi) {
    const b = G.bases[bi], c = G.cursor;
    if (!b || !b.alive || b.ammo <= 0 || b.cd > 0 || G.fireCd > 0) return;
    b.ammo--; b.cd = 0.22; b.flash = 1; G.fireCd = sup ? 0.02 : 0.17; c.click = 1; G.shots++;
    const tx = clamp(c.x, 10, WW - 10), ty = clamp(c.y, 30, GY - 70);
    const sx = b.x, sy = GY - 34, d = Math.hypot(tx - sx, ty - sy) || 1;
    G.ints.push({ x: sx, y: sy, px: sx, py: sy, sx, sy, tx, ty, vx: (tx - sx) / d * IV, vy: (ty - sy) / d * IV, base: bi });
    burst(sx, sy, 4, { speed: 90, life: 0.4, size: 2, color: ['#7df9ff', '#fff'] });
  }
  function moveCursor(dt) {
    const c = G.cursor, maxV = sup ? 7500 : 1750, A = sup ? 250000 : 16000, gain = sup ? 40 : 13;
    c.px = c.x; c.py = c.y;
    const dx = c.tx - c.x, dy = c.ty - c.y, d = Math.hypot(dx, dy);
    let dvx = 0, dvy = 0;
    if (d > 0.01) { const sp = Math.min(maxV, d * gain); dvx = dx / d * sp; dvy = dy / d * sp; }
    let ax = dvx - c.vx, ay = dvy - c.vy; const al = Math.hypot(ax, ay), lim = A * dt;
    if (al > lim) { ax *= lim / al; ay *= lim / al; }
    c.vx += ax; c.vy += ay; c.x = clamp(c.x + c.vx * dt, 0, WW); c.y = clamp(c.y + c.vy * dt, 20, GY - 20);
    c.click = Math.max(0, c.click - dt * 5);
  }

  inst.step = dt => {
    inst.t += dt;
    parts.update(dt);
    G.shake *= Math.exp(-dt * 6); G.flash *= Math.exp(-dt * 4);
    G.fireCd = Math.max(0, G.fireCd - dt);
    for (const f of G.floaters) f.t += dt; G.floaters = G.floaters.filter(f => f.t < 1.4);
    for (const b of G.banners) b.t += dt; G.banners = G.banners.filter(b => b.t < b.dur);
    for (const g of G.ghosts) g.t += dt; G.ghosts = G.ghosts.filter(g => g.t < g.life);
    for (const b of G.bases) { b.cd = Math.max(0, b.cd - dt); b.flash = Math.max(0, b.flash - dt * 6); if (b.pips < 1) b.pips = Math.min(1, b.pips + dt * 0.7); }
    for (const c of G.cities) { if (c.rise < 1) c.rise = Math.min(1, c.rise + dt * 0.8); if (!c.alive) { c.ruinT = (c.ruinT || 0) + dt; if (Math.random() < dt * 1.6) burst(c.x + rnd.float(-18, 18), GY - 6, 1, { speed: 24, speedMin: 8, life: 1.8, size: 3, color: ['#6a3a8a', '#ff7a3d'], gravity: -30, angle: -Math.PI / 2, spread: 0.5, drag: 0.6 }); } }
    if (shoot.t < 0 && Math.random() < dt * 0.05) shoot = { t: 0, u: Math.random() * 0.6 + 0.1, v: Math.random() * 0.25 };
    if (shoot.t >= 0) { shoot.t += dt; if (shoot.t > 0.9) shoot.t = -1; }
    if (inst.over) G.overT += dt;
    else if (inst.t > TIME_CAP) finish('Out of time');

    // ---- the AI plays
    if (!inst.over) {
      const a = ai.tick(dt, observe());
      G.cursor.tx = a.mx; G.cursor.ty = a.my;
      moveCursor(dt);
      if (a.click >= 0) tryFire(a.click);
    } else moveCursor(dt);

    // ---- wave flow
    if (!inst.over) {
      if (G.wave === 0) startWave(1);
      if (G.phase === 'wave') {
        doSpawns(dt);
        if (!G.q.length && !G.warheads.length && !G.planes.length && G.waveT > 2 && G.stormT < 0) {
          G.phase = 'between'; G.between = 0; G.bonusDone = false;
          const alive = aliveCities(), ammo = totalAmmo(), bonus = (alive * 100 + ammo * 5) * G.mult;
          addScore(bonus);
          banner('WAVE ' + G.wave + ' CLEARED', `Cities ${alive * 100 * G.mult} · Ammo ${ammo * 5 * G.mult}`, 'cyan', 2.8);
        }
      } else {
        G.between += dt;
        if (!G.bonusDone && G.between > 1.6) {
          G.bonusDone = true;
          while (G.pending > 0) {
            const dead = G.cities.find(c => !c.alive);
            if (!dead) break;
            dead.alive = true; dead.rise = 0; G.pending--;
            burst(dead.x, GY - 20, 22, { speed: 160, life: 1, size: 3, color: ['#7df9ff', '#ffd36e', '#fff'], angle: -Math.PI / 2, spread: 1.4, gravity: 100 });
            banner('BONUS CITY', 'Rebuilt by 10 000 points', 'gold', 2.0);
          }
        }
        if (G.between > 3.2) startWave(G.wave + 1);
      }
    }

    // ---- bombers
    for (const p of G.planes) {
      p.px = p.x; p.py = p.y; p.x += p.vx * dt;
      if (!inst.over && p.drops > 0) {
        p.nextDrop -= dt;
        if (p.nextDrop <= 0 && p.x > 60 && p.x < WW - 60) {
          p.drops--; p.nextDrop = rnd.float(0.8, 1.3);
          let tx = pickTarget(); const near = G.cities.filter(c => c.alive && Math.abs(c.x - p.x) < 380); if (near.length && Math.random() < 0.7) tx = rnd.pick(near).x;
          spawnHead('bomb', 0, tx, Math.min(150, G.spec.speed * 1.2), 0, { x: p.x, y: p.y + 6 });
        }
      }
      if (p.x < -80 || p.x > WW + 80) p.gone = true;
    }
    // ---- warheads
    for (const w of G.warheads) {
      w.px = w.x; w.py = w.y; w.age += dt;
      if (w.kind === 'smart' && w.dodges < 1 && !w.dodge) {
        for (const b of G.blasts) {
          if (b.kind === 'ground' || b.t > 0.45) continue;
          const d = Math.hypot(w.x - b.x, w.y - b.y);
          if (d < blastR(b.kind, b.t) + 42) {
            const L = Math.hypot(w.vx, w.vy) || 1, nx = -w.vy / L, ny = w.vx / L;
            const side = ((w.x - b.x) * nx + (w.y - b.y) * ny) >= 0 ? 1 : -1;
            w.dodge = { t: 0, nx: nx * side, ny: ny * side }; w.dodges++;
            w.pts.push({ x: w.x, y: w.y });
            burst(w.x, w.y, 8, { speed: 120, life: 0.5, size: 2.2, color: ['#7dffb0', '#fff'] });
            floater('!', w.x, w.y - 14, '#7dffb0', true);
            break;
          }
        }
      }
      if (w.dodge) {
        w.dodge.t += dt; w.x += w.dodge.nx * 230 * dt; w.y += w.dodge.ny * 230 * dt;
        if (w.dodge.t >= 0.3) {
          w.dodge = null;
          const dx = w.tx - w.x, dy = w.ty - w.y, d = Math.hypot(dx, dy) || 1;
          w.vx = dx / d * w.speed; w.vy = dy / d * w.speed; w.sx = w.x; w.sy = w.y; w.pts.push({ x: w.x, y: w.y });
        }
      }
      w.x += w.vx * dt; w.y += w.vy * dt;
      if (w.kind === 'mirv' && w.y >= w.splitY) {
        w.dead = true; w.split = true;
        const k = G.spec ? G.spec.split : 2;
        G.ghosts.push({ pts: w.pts.concat([{ x: w.x, y: w.y }]), col: 'org', t: 0, life: 0.2 });
        for (let i = 0; i < k; i++) {
          const h = spawnHead('w', 0, pickTarget() + rnd.float(-20, 20), w.speed * 1.0, 0, { x: w.x, y: w.y });
          h.pts = [{ x: w.x, y: w.y }]; h.mirvChild = true;
        }
        burst(w.x, w.y, 14, { speed: 160, life: 0.7, size: 2.6, color: ['#ffb347', '#fff', '#ff4f9a'] });
        G.blasts.push({ kind: 'ground', x: w.x, y: w.y, t: 0.3, root: null, total: 0, seed: 0, fx: true });
      } else if (w.y >= GY - 6 && !inst.over || (inst.over && w.y >= GY - 6)) {
        w.dead = true; groundHit(w);
        G.ghosts.push({ pts: w.pts.concat([{ x: w.x, y: w.y }]), col: 'pink', t: 0, life: 0.7 });
      }
    }
    // ---- interceptors
    for (const it of G.ints) {
      it.px = it.x; it.py = it.y;
      const rem = Math.hypot(it.tx - it.x, it.ty - it.y), stp = IV * dt;
      if (rem <= stp) { it.x = it.tx; it.y = it.ty; it.done = true; }
      else { it.x += it.vx * dt; it.y += it.vy * dt; }
      if (it.done) {
        const b = addBlast('int', it.tx, it.ty);
        G.ghosts.push({ pts: [{ x: it.sx, y: it.sy }, { x: it.tx, y: it.ty }], col: 'cyan', t: 0, life: 0.8 });
        burst(it.tx, it.ty, 10, { speed: 140, life: 0.7, size: 2.2, color: ['#7df9ff', '#fff', '#ff9ad0'] });
        b.t = 0;
      }
    }
    // ---- blasts: age + kills
    for (const b of G.blasts) {
      b.t += dt;
      if (b.kind === 'ground' || b.fx) continue;
      const r = blastR(b.kind, b.t);
      if (r > 0) {
        for (const w of G.warheads) {
          if (w.dead) continue;
          if (Math.hypot(w.x - b.x, w.y - b.y) < r + 3) killHead(w, b);
        }
        for (const p of G.planes) {
          if (p.gone) continue;
          if (Math.hypot(p.x - b.x, p.y - b.y) < r + 8) {
            p.gone = true; addScore(100 * G.mult); floater('+' + 100 * G.mult, p.x, p.y - 10, '#ffe08a', true);
            burst(p.x, p.y, 22, { speed: 220, life: 1, size: 3, color: ['#ffb347', '#ff4f9a', '#fff'], gravity: 160 });
            addBlast('chain', p.x, p.y, b.root || b);
          }
        }
      }
    }
    G.warheads = G.warheads.filter(w => !w.dead);
    G.planes = G.planes.filter(p => !p.gone);
    G.ints = G.ints.filter(i => !i.done);
    G.blasts = G.blasts.filter(b => b.t < BL[b.kind].L);
  };

  // ---------------------------------------------------------------------------- layout & drawing
  inst.resize = (W, H) => {
    inst.W = W; inst.H = H;
    const S2 = Math.min(W * 0.97 / WW, H * 0.97 / WH);
    const ox = (W - WW * S2) / 2, oy = (H - WH * S2) / 2;
    inst.L = { S: S2, ox, oy, hy: oy + GY * S2 };
  };
  const skyStops = [[0, '#06021a'], [0.4, '#180837'], [0.72, '#4c0f5e'], [0.9, '#a8205e'], [1, '#ff5a78']];

  function drawBg(ctx, W, H) {
    const L = inst.L, hy = L.hy, t = inst.t;
    staticLayer(ctx, 'mbg', W, H, (x, W, H) => {
      const sky = x.createLinearGradient(0, 0, 0, hy);
      for (const [p, c] of skyStops) sky.addColorStop(p, c);
      x.fillStyle = sky; x.fillRect(0, 0, W, hy + 1);
      const fl = x.createLinearGradient(0, hy, 0, H);
      fl.addColorStop(0, '#2a0a45'); fl.addColorStop(0.12, '#150524'); fl.addColorStop(1, '#06020d');
      x.fillStyle = fl; x.fillRect(0, hy, W, H - hy);
      // vignette
      const vg = x.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.4, W / 2, H / 2, Math.max(W, H) * 0.8);
      vg.addColorStop(0, 'rgba(0,0,0,0)'); vg.addColorStop(1, 'rgba(0,0,0,0.5)');
      x.fillStyle = vg; x.fillRect(0, 0, W, H);
    });
    // sun (behind mountains is faked: drawn before them via clip, then ridge re-overlay is skipped; sun sits in front of far sky only)
    const sr = Math.min(W, H) * 0.19, scx = W * 0.5, scy = hy - sr * 0.28;
    ctx.save();
    ctx.beginPath(); ctx.rect(0, 0, W, hy - Math.min(W, H) * 0.012); ctx.clip();
    ctx.globalCompositeOperation = 'lighter'; ctx.globalAlpha = 0.5;
    ctx.drawImage(G_PINK(), scx - sr * 2.4, scy - sr * 2.4, sr * 4.8, sr * 4.8);
    ctx.globalCompositeOperation = 'source-over'; ctx.globalAlpha = 0.9;
    const sg = ctx.createLinearGradient(0, scy - sr, 0, scy + sr);
    sg.addColorStop(0, '#ffe27a'); sg.addColorStop(0.5, '#ff7a6a'); sg.addColorStop(1, '#e0268f');
    ctx.fillStyle = sg; ctx.beginPath(); ctx.arc(scx, scy, sr, 0, TAU); ctx.fill();
    // slits
    ctx.globalAlpha = 1;
    const sky = ctx.createLinearGradient(0, 0, 0, hy); for (const [p, c] of skyStops) sky.addColorStop(p, c);
    ctx.fillStyle = sky;
    const ph = (t * 0.06) % 1;
    for (let i = 0; i < 7; i++) {
      const f = (i + ph) / 7, y = scy + sr * (0.05 + f * 0.95), th = sr * (0.01 + 0.07 * f);
      ctx.fillRect(scx - sr, y, sr * 2, th);
    }
    ctx.restore();
    staticLayer(ctx, 'mbg2', W, H, (x, W, H) => {
      // mountains
      const mh = Math.min(W, H) * 0.085;
      const ridge = (seed, amp, col, edge, base) => {
        x.beginPath(); x.moveTo(0, hy);
        for (let px = 0; px <= W + 8; px += 8) {
          const u = px / W * 9;
          const y = hy - base - amp * (0.55 * Math.sin(u * 1.3 + seed) + 0.3 * Math.sin(u * 2.9 + seed * 2.1) + 0.15 * Math.sin(u * 6.1 + seed * 3.3) + 1.05);
          x.lineTo(px, y);
        }
        x.lineTo(W, hy); x.closePath(); x.fillStyle = col; x.fill();
        if (edge) { x.strokeStyle = edge; x.lineWidth = 1.2; x.stroke(); }
      };
      ridge(1.2, mh * 0.9, '#35104f', 'rgba(255,90,170,0.35)', 0);
      ridge(4.7, mh * 0.55, '#1a0733', 'rgba(110,240,255,0.30)', 0);
      // horizon glow line
      const hg = x.createLinearGradient(0, hy - 3, 0, hy + 3);
      hg.addColorStop(0, 'rgba(255,120,170,0)'); hg.addColorStop(0.5, 'rgba(255,120,190,0.9)'); hg.addColorStop(1, 'rgba(255,120,170,0)');
      x.fillStyle = hg; x.fillRect(0, hy - 3, W, 6);
    });
    // re-lay the ridges over the sun with the static layer's silhouette is not possible per-frame; instead draw a low haze
    // stars
    ctx.save();
    for (const s of stars) {
      const y = s.v * hy * 0.85; const a = 0.35 + 0.65 * (0.5 + 0.5 * Math.sin(t * s.sp + s.ph));
      ctx.globalAlpha = a * (1 - s.v * 0.7); ctx.fillStyle = '#fff'; ctx.fillRect(s.u * W, y, s.s, s.s);
    }
    if (shoot.t >= 0) {
      const u = shoot.t / 0.9, x0 = (shoot.u + u * 0.22) * W, y0 = (shoot.v + u * 0.1) * hy;
      const g = ctx.createLinearGradient(x0 - 80, y0 - 36, x0, y0); g.addColorStop(0, 'rgba(255,255,255,0)'); g.addColorStop(1, 'rgba(255,255,255,0.9)');
      ctx.globalAlpha = 1 - u * u; ctx.strokeStyle = g; ctx.lineWidth = 1.6; ctx.beginPath(); ctx.moveTo(x0 - 80, y0 - 36); ctx.lineTo(x0, y0); ctx.stroke();
    }
    ctx.restore();
    // neon floor grid
    const fh = H - hy;
    if (fh > 4) {
      ctx.save(); ctx.beginPath(); ctx.rect(0, hy, W, fh); ctx.clip();
      ctx.lineWidth = 1;
      const n = 9, sc = (t * 0.12) % 1;
      for (let i = 0; i < n; i++) {
        const f = (i + sc) / n, y = hy + fh * f * f;
        ctx.strokeStyle = `rgba(255,80,190,${0.12 + 0.45 * f})`; ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
      }
      ctx.strokeStyle = 'rgba(110,240,255,0.22)'; ctx.beginPath();
      const vx = W / 2, spread = Math.max(W, H) * 0.09;
      for (let i = -22; i <= 22; i++) { ctx.moveTo(vx + i * spread * 0.12, hy); ctx.lineTo(vx + i * spread, H); }
      ctx.stroke(); ctx.restore();
    }
  }

  function drawCity(ctx, c, i) {
    const x = c.x, t = inst.t;
    if (!c.alive) {
      ctx.fillStyle = '#12051f'; ctx.beginPath(); ctx.moveTo(x - 30, GY);
      const pts = [[-28, -6], [-20, -14], [-12, -7], [-4, -18], [5, -8], [13, -15], [22, -6], [30, 0]];
      for (const [dx, dy] of pts) ctx.lineTo(x + dx, GY + dy); ctx.closePath(); ctx.fill();
      ctx.strokeStyle = 'rgba(255,90,60,0.45)'; ctx.lineWidth = 1.2; ctx.stroke();
      ctx.save(); ctx.globalCompositeOperation = 'lighter';
      const fl = 0.5 + 0.5 * Math.sin(t * 5 + c.ember);
      ctx.globalAlpha = 0.35 + 0.35 * fl; ctx.drawImage(G_ORG(), x - 18, GY - 30, 36, 36); ctx.restore();
      return;
    }
    const towers = [[-27, 13, 30 + hash(i, 1) * 14], [-13, 16, 46 + hash(i, 2) * 22], [4, 14, 36 + hash(i, 3) * 20], [17, 12, 24 + hash(i, 4) * 12]];
    const hue = i % 2 ? '110,240,255' : '255,110,190';
    const rise = ease.outBack(c.rise);
    ctx.save();
    ctx.translate(x, GY); ctx.scale(1, Math.max(0.01, rise));
    ctx.save(); ctx.globalCompositeOperation = 'lighter'; ctx.globalAlpha = 0.3; ctx.drawImage(i % 2 ? G_CYAN() : G_PINK(), -52, -62, 104, 84); ctx.restore();
    towers.forEach(([dx, w, h], k) => {
      const g = ctx.createLinearGradient(0, -h, 0, 0); g.addColorStop(0, '#2a1050'); g.addColorStop(1, '#12051f');
      ctx.fillStyle = g; ctx.fillRect(dx, -h, w, h);
      ctx.strokeStyle = `rgba(${hue},0.85)`; ctx.lineWidth = 1.3; ctx.beginPath(); ctx.moveTo(dx, 0); ctx.lineTo(dx, -h); ctx.lineTo(dx + w, -h); ctx.stroke();
      ctx.fillStyle = 'rgba(255,255,255,0.15)'; ctx.fillRect(dx + w - 2, -h, 2, h);
      for (let wy = -h + 6; wy < -4; wy += 7) for (let wx = dx + 3; wx < dx + w - 3; wx += 5) {
        const hv = hash(i * 31 + k * 7 + wx | 0, wy | 0);
        if (hv > 0.45) { const tw = hash(wx | 0, (wy | 0) + Math.floor(t * 0.4 + hv * 9)); ctx.fillStyle = tw > 0.08 ? (hv > 0.8 ? '#ff9ad0' : '#ffd88a') : 'rgba(255,216,138,0.2)'; ctx.fillRect(wx, wy, 2.2, 3); }
      }
      // antenna light
      if (k === 1) { ctx.fillStyle = (Math.sin(t * 3 + i) > 0) ? '#ff5a78' : '#5a1a40'; ctx.fillRect(dx + w / 2 - 1, -h - 5, 2, 5); }
    });
    ctx.restore();
  }

  function drawBase(ctx, b, i) {
    const x = b.x, t = inst.t;
    if (!b.alive) {
      ctx.fillStyle = '#12051f'; ctx.beginPath(); ctx.moveTo(x - 36, GY + 2); ctx.lineTo(x - 22, GY - 9); ctx.lineTo(x - 8, GY - 4); ctx.lineTo(x + 6, GY - 13); ctx.lineTo(x + 22, GY - 5); ctx.lineTo(x + 36, GY + 2); ctx.closePath(); ctx.fill();
      ctx.strokeStyle = 'rgba(110,240,255,0.25)'; ctx.stroke(); return;
    }
    // aim barrel
    const c = G.cursor; const target = Math.atan2(c.y - (GY - 30), c.x - x);
    let ta = clamp(target, -Math.PI + 0.25, -0.25);
    let da = ta - b.aim; b.aim += da * 0.25;
    ctx.fillStyle = '#1d0a36'; ctx.beginPath(); ctx.moveTo(x - 38, GY + 3); ctx.lineTo(x - 28, GY - 10); ctx.lineTo(x + 28, GY - 10); ctx.lineTo(x + 38, GY + 3); ctx.closePath(); ctx.fill();
    ctx.strokeStyle = 'rgba(110,240,255,0.8)'; ctx.lineWidth = 1.5; ctx.stroke();
    ctx.save(); ctx.translate(x, GY - 20); ctx.rotate(b.aim);
    const rc = b.flash * 5;
    ctx.fillStyle = '#2d1654'; ctx.fillRect(-rc, -4, 30, 8);
    ctx.strokeStyle = '#7df9ff'; ctx.lineWidth = 1.2; ctx.strokeRect(-rc, -4, 30, 8);
    ctx.restore();
    ctx.fillStyle = '#2a1250'; ctx.beginPath(); ctx.arc(x, GY - 14, 15, Math.PI, 0); ctx.fill();
    ctx.strokeStyle = 'rgba(255,110,190,0.85)'; ctx.lineWidth = 1.5; ctx.stroke();
    if (b.flash > 0) { ctx.save(); ctx.globalCompositeOperation = 'lighter'; ctx.globalAlpha = b.flash; ctx.drawImage(G_CYAN(), x + Math.cos(b.aim) * 30 - 18, GY - 20 + Math.sin(b.aim) * 30 - 18, 36, 36); ctx.restore(); }
    // ammo pips
    const n = Math.round(b.ammo * Math.min(1, b.pips));
    for (let k = 0; k < AMMO; k++) {
      const row = k < 5 ? 0 : 1, col = k % 5, px = x - 17 + col * 8.5, py = GY - 6 + row * 6.5;
      const on = k < b.ammo;
      ctx.fillStyle = on ? (b.ammo <= 3 ? '#ffb347' : '#7df9ff') : 'rgba(255,255,255,0.1)';
      ctx.fillRect(px, py, 5, 4);
    }
  }

  function trailPath(ctx, w, hx, hy2) {
    ctx.beginPath(); ctx.moveTo(w.pts[0].x, w.pts[0].y);
    for (let i = 1; i < w.pts.length; i++) ctx.lineTo(w.pts[i].x, w.pts[i].y);
    ctx.lineTo(hx, hy2);
  }
  function drawBlast(ctx, b, al) {
    const age = b.t + al / 60, r = blastR(b.kind, age);
    if (r < 0.5) return;
    const life = clamp(1 - age / BL[b.kind].L, 0, 1);
    const fl = 0.92 + 0.08 * Math.sin(age * 38 + b.seed);
    const spr = b.kind === 'int' ? G_CYAN() : b.kind === 'chain' ? G_ORG() : G_RED();
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = (0.35 + 0.65 * life) * fl; ctx.drawImage(spr, b.x - r * 1.45, b.y - r * 1.45, r * 2.9, r * 2.9);
    ctx.globalAlpha = 0.85 * life * life * fl; ctx.drawImage(G_WHITE(), b.x - r * 0.95, b.y - r * 0.95, r * 1.9, r * 1.9);
    if (b.kind === 'int') { ctx.globalAlpha = 0.25 * life; ctx.drawImage(G_PINK(), b.x - r * 1.9, b.y - r * 1.9, r * 3.8, r * 3.8); }
    const col = b.kind === 'int' ? '125,249,255' : b.kind === 'chain' ? '255,190,90' : '255,110,80';
    ctx.strokeStyle = `rgba(${col},${0.25 * life})`; ctx.lineWidth = 9; ctx.beginPath(); ctx.arc(b.x, b.y, r, 0, TAU); ctx.stroke();
    ctx.strokeStyle = `rgba(${col},${0.9 * life})`; ctx.lineWidth = 2.4; ctx.stroke();
    ctx.strokeStyle = `rgba(255,255,255,${0.7 * life})`; ctx.lineWidth = 1; ctx.beginPath(); ctx.arc(b.x, b.y, r * 0.98, 0, TAU); ctx.stroke();
    ctx.globalCompositeOperation = 'source-over';
  }
  function drawPlane(ctx, p, al) {
    const x = lerp(p.px, p.x, al), y = lerp(p.py, p.y, al), d = p.vx > 0 ? 1 : -1, t = inst.t;
    ctx.save(); ctx.translate(x, y); ctx.scale(d, 1);
    ctx.fillStyle = '#2b1252'; ctx.beginPath(); ctx.moveTo(22, 0); ctx.lineTo(4, -5); ctx.lineTo(-10, -16); ctx.lineTo(-14, -16); ctx.lineTo(-8, -4); ctx.lineTo(-22, -3); ctx.lineTo(-24, -8); ctx.lineTo(-27, -8); ctx.lineTo(-24, 0); ctx.lineTo(-24, 2); ctx.lineTo(-10, 5); ctx.lineTo(4, 5); ctx.closePath(); ctx.fill();
    ctx.strokeStyle = '#ffb347'; ctx.lineWidth = 1.4; ctx.stroke();
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = Math.sin(t * 7) > 0 ? 1 : 0.2; ctx.drawImage(G_RED(), -34, -8, 16, 16);
    ctx.globalAlpha = 0.5; ctx.drawImage(G_ORG(), -40, -10, 22, 18);
    ctx.restore();
  }

  function drawWorld(ctx, W, H) {
    const al = alphaNow();
    // cities & bases
    G.cities.forEach((c, i) => drawCity(ctx, c, i));
    G.bases.forEach((b, i) => drawBase(ctx, b, i));
    // lingering ghost trails
    ctx.save(); ctx.globalCompositeOperation = 'lighter'; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    for (const g of G.ghosts) {
      const a = 1 - (g.t + al / 60) / g.life; if (a <= 0) continue;
      ctx.strokeStyle = g.col === 'cyan' ? `rgba(110,240,255,${0.5 * a * a})` : g.col === 'org' ? `rgba(255,170,70,${0.5 * a * a})` : `rgba(255,90,160,${0.5 * a * a})`;
      ctx.lineWidth = 1.6;
      ctx.beginPath(); ctx.moveTo(g.pts[0].x, g.pts[0].y); for (let i = 1; i < g.pts.length; i++) ctx.lineTo(g.pts[i].x, g.pts[i].y); ctx.stroke();
    }
    // warhead trails + heads
    for (const w of G.warheads) {
      const hx = lerp(w.px, w.x, al), hy = lerp(w.py, w.y, al);
      const o0 = w.pts[0];
      const gr = ctx.createLinearGradient(o0.x, o0.y, hx, hy);
      const sm = w.kind === 'smart';
      gr.addColorStop(0, sm ? 'rgba(90,255,170,0.05)' : 'rgba(255,60,130,0.05)'); gr.addColorStop(1, sm ? 'rgba(130,255,190,0.85)' : 'rgba(255,120,170,0.9)');
      ctx.strokeStyle = gr; ctx.lineWidth = 5; ctx.globalAlpha = 0.28; trailPath(ctx, w, hx, hy); ctx.stroke();
      ctx.globalAlpha = 1; ctx.lineWidth = 1.5; trailPath(ctx, w, hx, hy); ctx.stroke();
    }
    ctx.restore();
    for (const w of G.warheads) {
      const hx = lerp(w.px, w.x, al), hy = lerp(w.py, w.y, al);
      ctx.save(); ctx.globalCompositeOperation = 'lighter';
      const big = w.kind === 'mirv' ? 1.9 : w.kind === 'bomb' ? 0.85 : 1;
      const spr = w.kind === 'smart' ? glow('mint', 90, 255, 170) : w.kind === 'mirv' ? G_ORG() : G_PINK();
      ctx.drawImage(spr, hx - 15 * big, hy - 15 * big, 30 * big, 30 * big);
      ctx.drawImage(G_WHITE(), hx - 6, hy - 6, 12, 12);
      ctx.restore();
      if (w.kind === 'mirv') {
        ctx.strokeStyle = '#ffd36e'; ctx.lineWidth = 1.4; ctx.beginPath();
        for (let k = 0; k < 6; k++) { const a = k * TAU / 6 + inst.t * 2; ctx.lineTo(hx + Math.cos(a) * 7, hy + Math.sin(a) * 7); } ctx.closePath(); ctx.stroke();
        // height tick: nothing — the split height is hidden from the viewer too
      } else if (w.kind === 'smart') {
        ctx.strokeStyle = '#7dffb0'; ctx.lineWidth = 1.3; ctx.beginPath(); ctx.moveTo(hx, hy - 7); ctx.lineTo(hx + 6, hy); ctx.lineTo(hx, hy + 7); ctx.lineTo(hx - 6, hy); ctx.closePath(); ctx.stroke();
      }
    }
    for (const p of G.planes) drawPlane(ctx, p, al);
    // interceptors
    ctx.save(); ctx.globalCompositeOperation = 'lighter';
    for (const it of G.ints) {
      const hx = lerp(it.px, it.x, al), hy = lerp(it.py, it.y, al);
      const gr = ctx.createLinearGradient(it.sx, it.sy, hx, hy); gr.addColorStop(0, 'rgba(110,240,255,0.02)'); gr.addColorStop(1, 'rgba(180,255,255,0.95)');
      ctx.strokeStyle = gr; ctx.lineWidth = 4; ctx.globalAlpha = 0.25; ctx.beginPath(); ctx.moveTo(it.sx, it.sy); ctx.lineTo(hx, hy); ctx.stroke();
      ctx.globalAlpha = 1; ctx.lineWidth = 1.5; ctx.stroke();
      ctx.drawImage(G_CYAN(), hx - 11, hy - 11, 22, 22); ctx.drawImage(G_WHITE(), hx - 5, hy - 5, 10, 10);
      ctx.strokeStyle = 'rgba(140,255,255,0.55)'; ctx.lineWidth = 1.2; ctx.beginPath();
      ctx.moveTo(it.tx - 5, it.ty - 5); ctx.lineTo(it.tx + 5, it.ty + 5); ctx.moveTo(it.tx + 5, it.ty - 5); ctx.lineTo(it.tx - 5, it.ty + 5); ctx.stroke();
    }
    ctx.restore();
    // blasts
    ctx.save();
    for (const b of G.blasts) if (!b.fx) drawBlast(ctx, b, al); else {
      const age = b.t + al / 60 - 0.3; if (age < 0.4) { ctx.globalCompositeOperation = 'lighter'; const r = 10 + age * 80; ctx.strokeStyle = `rgba(255,200,120,${0.8 * (1 - age / 0.4)})`; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(b.x, b.y, r, 0, TAU); ctx.stroke(); }
    }
    ctx.restore();
    parts.draw(ctx, 1);
    // floaters
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    for (const f of G.floaters) {
      const u = f.t / 1.4, a = u < 0.1 ? u / 0.1 : 1 - Math.max(0, (u - 0.5) / 0.5);
      ctx.globalAlpha = Math.max(0, a); ctx.font = f.big ? '800 22px "Big Shoulders Display", Impact, sans-serif' : '600 13px "IBM Plex Mono", monospace';
      ctx.fillStyle = f.col; ctx.fillText(f.txt, f.x, f.y - ease.outCubic(Math.min(1, f.t / 0.9)) * 26);
    }
    ctx.globalAlpha = 1;
    // crosshair
    const c = G.cursor, cx = lerp(c.px, c.x, al), cy = lerp(c.py, c.y, al);
    if (!inst.over) {
      ctx.save(); ctx.translate(cx, cy); ctx.globalCompositeOperation = 'lighter';
      const rr = 13 + c.click * 9;
      ctx.strokeStyle = 'rgba(180,255,255,0.95)'; ctx.lineWidth = 1.6;
      ctx.beginPath(); ctx.arc(0, 0, rr, 0, TAU); ctx.stroke();
      ctx.beginPath(); for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { ctx.moveTo(dx * (rr - 4), dy * (rr - 4)); ctx.lineTo(dx * (rr + 8), dy * (rr + 8)); } ctx.stroke();
      ctx.strokeStyle = 'rgba(255,110,190,0.6)'; ctx.rotate(inst.t * 1.4); ctx.beginPath(); ctx.arc(0, 0, rr + 4, 0, 1.2); ctx.moveTo((rr + 4) * Math.cos(Math.PI), (rr + 4) * Math.sin(Math.PI)); ctx.arc(0, 0, rr + 4, Math.PI, Math.PI + 1.2); ctx.stroke();
      ctx.drawImage(G_WHITE(), -4, -4, 8, 8);
      ctx.restore();
    }
  }

  function drawHud(ctx) {
    ctx.save(); ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
    ctx.font = '600 12px "IBM Plex Mono", monospace'; ctx.fillStyle = 'rgba(190,170,255,0.7)';
    ctx.fillText('S C O R E', WW / 2, 24);
    ctx.font = '600 34px "IBM Plex Mono", monospace';
    ctx.fillStyle = 'rgba(255,90,170,0.35)'; ctx.fillText(fmt(inst.score), WW / 2 + 0, 58);
    ctx.fillStyle = '#fff2fa'; ctx.fillText(fmt(inst.score), WW / 2, 57);
    ctx.font = '500 13px "IBM Plex Mono", monospace'; ctx.fillStyle = 'rgba(200,190,255,0.7)';
    ctx.fillText(`WAVE ${G.wave} · ×${G.mult}   BEST ${fmt(Math.max(best, inst.score))}`, WW / 2, 78);
    const bw = 150, bx = WW / 2 - bw / 2, prog = clamp(1 - (G.nextBonus - inst.score) / CITY_BONUS, 0, 1);
    ctx.fillStyle = 'rgba(255,255,255,0.1)'; ctx.fillRect(bx, 86, bw, 3);
    ctx.fillStyle = G.pending > 0 ? '#ffd36e' : '#7df9ff'; ctx.fillRect(bx, 86, bw * prog, 3);
    ctx.font = '500 10px "IBM Plex Mono", monospace'; ctx.fillStyle = 'rgba(200,190,255,0.55)';
    ctx.fillText(G.pending > 0 ? `${G.pending} BONUS CITY READY` : 'NEXT BONUS CITY', WW / 2, 103);
    ctx.restore();
  }
  function drawBanners(ctx) {
    let k = 0;
    for (const b of G.banners) {
      const u = b.t / b.dur, a = u < 0.12 ? u / 0.12 : u > 0.75 ? 1 - (u - 0.75) / 0.25 : 1;
      const sc = 0.85 + 0.15 * ease.outBack(Math.min(1, b.t / 0.4));
      const y = 250 + k * 78; k++;
      ctx.save(); ctx.translate(WW / 2, y); ctx.scale(sc, sc); ctx.globalAlpha = Math.max(0, a);
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      const red = b.kind === 'red', cy = b.kind === 'cyan', gold = b.kind === 'gold';
      ctx.font = '800 64px "Big Shoulders Display", Impact, sans-serif';
      const g = ctx.createLinearGradient(0, -30, 0, 30);
      if (red) { g.addColorStop(0, '#ffd36e'); g.addColorStop(1, '#ff4a2a'); } else if (cy) { g.addColorStop(0, '#d6ffff'); g.addColorStop(1, '#3fd0ff'); } else if (gold) { g.addColorStop(0, '#fff3b0'); g.addColorStop(1, '#ffb347'); } else { g.addColorStop(0, '#ffe27a'); g.addColorStop(1, '#ff4fa0'); }
      ctx.lineJoin = 'round'; ctx.strokeStyle = red ? 'rgba(255,60,30,0.35)' : 'rgba(255,80,170,0.35)'; ctx.lineWidth = 14; ctx.strokeText(b.txt, 0, 0);
      ctx.fillStyle = g; ctx.fillText(b.txt, 0, 0);
      if (red) { // hazard stripes
        ctx.save(); ctx.beginPath(); ctx.rect(-170, 34, 340, 9); ctx.clip();
        for (let i = -20; i < 20; i++) { ctx.fillStyle = i % 2 ? '#ff4a2a' : '#1a0a14'; ctx.beginPath(); ctx.moveTo(i * 18, 43); ctx.lineTo(i * 18 + 9, 43); ctx.lineTo(i * 18 + 18, 34); ctx.lineTo(i * 18 + 9, 34); ctx.fill(); }
        ctx.restore();
      }
      ctx.font = '500 20px Fredoka, sans-serif'; ctx.fillStyle = 'rgba(255,240,250,0.9)'; ctx.fillText(b.sub || '', 0, red ? 62 : 46);
      ctx.restore();
    }
  }

  inst.draw = (ctx, W, H) => {
    if (!inst.L || inst.L.W0 !== undefined) inst.resize(W, H);
    const L = inst.L;
    drawBg(ctx, W, H);
    ctx.save();
    const sh = G.shake;
    ctx.translate(L.ox + (sh > 0.02 ? Math.sin(inst.t * 83) * sh * 3 : 0), L.oy + (sh > 0.02 ? Math.cos(inst.t * 71) * sh * 3 : 0));
    ctx.scale(L.S, L.S);
    drawWorld(ctx, W, H);
    drawHud(ctx);
    drawBanners(ctx);
    ctx.restore();
    if (G.flash > 0.02) { ctx.fillStyle = inst.over ? `rgba(255,70,90,${G.flash * 0.35})` : `rgba(255,170,200,${G.flash * 0.12})`; ctx.fillRect(0, 0, W, H); }
    if (inst.over) { ctx.fillStyle = `rgba(20,0,20,${Math.min(0.45, G.overT * 0.25)})`; ctx.fillRect(0, 0, W, H); }
  };

  inst.hud = () => ({ score: fmt(inst.score), detail: `Wave ${G.wave} · ${aliveCities()} cities · ${totalAmmo()} ammo` });
  inst.result = () => (G.msg ? G.msg + ' on' : 'Last city fell on') + ` wave ${G.wave} with ${fmt(inst.score)} points (${S.name})`;
  inst.resize(800, 600);
  return inst;
}

Arcade.register({
  id: 'missiles', name: 'Afterglow Command', genre: 'Arcade defense',
  aiNote: 'Reads warhead trails, leads every shot for interceptor flight time, and moves its crosshair at hand speed with about five clicks a second.',
  blurb: 'Neon missile defense: endless waves over six cities.',
  bg: '#14052e', accent: '#ff4fa0', endless: true, parScore: PAR, twists: TWISTS, create,
});
})();
