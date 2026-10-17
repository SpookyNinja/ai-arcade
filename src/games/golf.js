// golf.js — Moonlit Links: nine-hole mini golf at night, played by the Autopilot AI.
(() => {
'use strict';

// ---------------------------------------------------------------------------
// Constants (course space: every hole lives in a ~1000 x 600 box, y points down)
// ---------------------------------------------------------------------------
const STEP = 1 / 60, SUB = 3, DT = STEP / SUB;
const BR = 6;                       // ball radius
const WH = 8;                       // wall half thickness
const RW = BR + WH, RW2 = RW * RW;
const CR = 10;                      // cup radius
const ROLL = 150;                   // rolling deceleration (u/s^2)
const SAND = 560;                   // extra deceleration in sand
const E_WALL = 0.8, E_BUMP = 0.9, E_MOVE = 0.55;
const VMAX = 740, VMIN = 55;        // putt speed range (power 0..1)
const SINKV = 130;                  // max speed to drop at the cup centre
const MAXS = 7;                     // pick-up after this many strokes
const SIG_A = 0.4 * Math.PI / 180;  // human aim noise
const SIG_P = 0.02;                 // human power noise
const AIM_T = 2.5;                  // seconds from "lining up" to impact
const TIME_CAP = 420;
const NHOLES = 9;
const TAU2 = Math.PI * 2;

const alphaNow = () => (typeof Arcade !== 'undefined' && Arcade.alpha != null && isFinite(Arcade.alpha) ? Arcade.alpha : 1);

// ---------------------------------------------------------------------------
// Hole layouts
// ---------------------------------------------------------------------------
const RC = (x0, y0, x1, y1) => ({ t: 'r', x0, y0, x1, y1 });
const CC = (x, y, r) => ({ t: 'c', x, y, r });
const rectPoly = (x0, y0, x1, y1) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
function inS(s, x, y) {
  if (s.t === 'r') return x >= s.x0 && x <= s.x1 && y >= s.y0 && y <= s.y1;
  const dx = x - s.x, dy = y - s.y;
  return dx * dx + dy * dy <= s.r * s.r;
}

const POOL = [
  { name: 'Tee Time', par: 2,
    outline: rectPoly(70, 200, 930, 400),
    islands: [rectPoly(360, 200, 380, 322), rectPoly(520, 278, 540, 400), rectPoly(680, 200, 700, 322)],
    bumpers: [{ x: 790, y: 330, r: 18 }],
    tee: { x: 140, y: 300 }, cup: { x: 865, y: 300 } },
  { name: 'The Elbow', par: 2,
    outline: [[80, 80], [920, 80], [920, 540], [750, 540], [750, 250], [80, 250]],
    sand: [CC(380, 165, 58)],
    water: [CC(835, 395, 40)],
    bumpers: [{ x: 600, y: 165, r: 20 }],
    tee: { x: 140, y: 165 }, cup: { x: 835, y: 495 } },
  { name: 'Pinball Alley', par: 2,
    outline: rectPoly(70, 150, 930, 450),
    bumpers: [{ x: 280, y: 215, r: 22 }, { x: 280, y: 385, r: 22 }, { x: 430, y: 300, r: 26 },
      { x: 580, y: 205, r: 22 }, { x: 580, y: 395, r: 22 }, { x: 730, y: 300, r: 26 }, { x: 820, y: 220, r: 18 }],
    tee: { x: 125, y: 300 }, cup: { x: 880, y: 330 } },
  { name: 'Sandy Hollow', par: 2,
    outline: rectPoly(80, 130, 920, 470),
    islands: [rectPoly(480, 130, 500, 340)],
    sand: [CC(320, 320, 95), RC(650, 380, 780, 470)],
    water: [CC(700, 240, 55)],
    bumpers: [{ x: 600, y: 420, r: 18 }],
    tee: { x: 140, y: 250 }, cup: { x: 860, y: 400 } },
  { name: 'Old Windmill', par: 3,
    outline: rectPoly(80, 150, 920, 450),
    mills: [{ x: 360, y: 300, n: 4, len: 112, w: 11, om: 0.9, ph: 0.4, hub: 16 },
      { x: 640, y: 300, n: 4, len: 112, w: 11, om: -0.9, ph: 1.2, hub: 16 }],
    tee: { x: 140, y: 300 }, cup: { x: 865, y: 300 } },
  { name: 'Switchback', par: 2,
    outline: rectPoly(80, 130, 920, 470),
    water: [RC(280, 400, 760, 470), RC(280, 130, 760, 200)],
    slopes: [{ s: RC(280, 130, 520, 470), ax: 0, ay: 330 }, { s: RC(520, 130, 760, 470), ax: 0, ay: -330 }],
    bumpers: [{ x: 640, y: 300, r: 18 }, { x: 400, y: 260, r: 16 }],
    tee: { x: 140, y: 300 }, cup: { x: 860, y: 300 } },
  { name: 'Island Green', par: 3,
    outline: rectPoly(70, 100, 930, 500),
    water: [RC(500, 100, 710, 272), RC(500, 328, 710, 500)],
    slopes: [{ s: RC(710, 100, 930, 500), ax: -150, ay: 70 }],
    bumpers: [{ x: 790, y: 330, r: 18 }],
    tee: { x: 140, y: 300 }, cup: { x: 870, y: 190 } },
  { name: 'Gatekeeper', par: 2,
    outline: rectPoly(80, 170, 920, 430),
    islands: [rectPoly(640, 170, 660, 260)],
    gates: [{ x: 330, y: 300, len: 150, amp: 62, T: 3.0, ph: 0.8, w: 11 }, { x: 540, y: 300, len: 150, amp: 62, T: 3.6, ph: 3.0, w: 11 }, { x: 740, y: 300, len: 120, amp: 50, T: 2.6, ph: 1.7, w: 11 }],
    sand: [RC(770, 170, 830, 430)],
    tee: { x: 140, y: 300 }, cup: { x: 872, y: 215 } },
  { name: 'Grand Finale', par: 3,
    outline: rectPoly(70, 70, 930, 530),
    islands: [rectPoly(70, 225, 740, 245), rectPoly(260, 375, 930, 395)],
    sand: [CC(560, 310, 50)],
    water: [CC(820, 310, 38)],
    mills: [{ x: 470, y: 152, n: 2, len: 50, w: 10, om: 1.3, ph: 0, hub: 12 }],
    slopes: [{ s: RC(120, 78, 300, 217), ax: -110, ay: 0 }],
    bumpers: [{ x: 700, y: 460, r: 18 }],
    tee: { x: 860, y: 465 }, cup: { x: 140, y: 150 } },
  // ---- extra designs (the round draws 9 of the whole pool at random) ----
  { name: 'Zigzag', par: 3,
    outline: rectPoly(80, 100, 920, 500),
    islands: [rectPoly(320, 100, 340, 360), rectPoly(600, 240, 620, 500)],
    tee: { x: 140, y: 170 }, cup: { x: 860, y: 430 } },
  { name: 'Dogleg', par: 3,
    outline: [[100, 80], [420, 80], [420, 330], [900, 330], [900, 520], [100, 520]],
    sand: [CC(640, 425, 55)],
    bumpers: [{ x: 760, y: 420, r: 16 }],
    tee: { x: 160, y: 150 }, cup: { x: 845, y: 430 } },
  { name: 'Twin Ponds', par: 3,
    outline: rectPoly(70, 130, 930, 470),
    water: [CC(380, 300, 75), CC(620, 300, 75)],
    bumpers: [{ x: 500, y: 300, r: 18 }],
    tee: { x: 130, y: 300 }, cup: { x: 870, y: 300 } },
  { name: 'Bunker Run', par: 2,
    outline: rectPoly(80, 160, 920, 440),
    sand: [RC(320, 160, 420, 440), RC(580, 160, 680, 440)],
    bumpers: [{ x: 500, y: 300, r: 18 }, { x: 800, y: 230, r: 16 }],
    tee: { x: 140, y: 300 }, cup: { x: 865, y: 330 } },
  { name: 'Crosswind', par: 2,
    outline: rectPoly(80, 120, 920, 480),
    water: [RC(300, 420, 700, 480)],
    slopes: [{ s: RC(300, 120, 700, 480), ax: 0, ay: 210 }],
    bumpers: [{ x: 800, y: 300, r: 18 }],
    tee: { x: 140, y: 250 }, cup: { x: 865, y: 330 } },
  { name: 'Mill Race', par: 3,
    outline: rectPoly(80, 130, 920, 470),
    mills: [{ x: 500, y: 300, n: 3, len: 112, w: 11, om: 1.1, ph: 0.7, hub: 16 }],
    bumpers: [{ x: 780, y: 225, r: 16 }, { x: 780, y: 375, r: 16 }],
    tee: { x: 140, y: 300 }, cup: { x: 865, y: 300 } },
  { name: 'Gate Crash', par: 2,
    outline: rectPoly(80, 170, 920, 430),
    gates: [{ x: 360, y: 300, len: 130, amp: 55, T: 3.2, ph: 0.4, w: 11 }, { x: 620, y: 300, len: 130, amp: 55, T: 2.8, ph: 2.2, w: 11 }],
    bumpers: [{ x: 780, y: 250, r: 16 }, { x: 780, y: 350, r: 16 }],
    tee: { x: 140, y: 300 }, cup: { x: 872, y: 300 } },
  { name: 'Hourglass', par: 2,
    outline: [[80, 100], [420, 100], [500, 260], [580, 100], [920, 100], [920, 500], [580, 500], [500, 340], [420, 500], [80, 500]],
    sand: [CC(250, 300, 48)],
    tee: { x: 140, y: 300 }, cup: { x: 860, y: 300 } },
  { name: 'Hairpin', par: 3,
    outline: rectPoly(80, 80, 920, 520),
    islands: [rectPoly(80, 300, 780, 320)],
    sand: [CC(330, 435, 55)],
    tee: { x: 140, y: 170 }, cup: { x: 140, y: 450 } },
  { name: 'The Wedge', par: 2,
    outline: [[80, 100], [920, 260], [920, 340], [80, 500]],
    bumpers: [{ x: 500, y: 300, r: 20 }],
    tee: { x: 140, y: 300 }, cup: { x: 870, y: 300 } },
  { name: 'Lake Loop', par: 3,
    outline: rectPoly(70, 90, 930, 510),
    water: [CC(500, 300, 120)],
    bumpers: [{ x: 760, y: 215, r: 16 }],
    tee: { x: 130, y: 300 }, cup: { x: 870, y: 300 } },
];

// ---------------------------------------------------------------------------
// Course generation: every round draws NHOLES of the POOL at random, orders them so pars build up
// sensibly (easier holes first, tougher towards the end), mirrors each hole at random and nudges movers / bumpers / sand a little ("where safe").
// ---------------------------------------------------------------------------
function segDist(px, py, ax, ay, bx, by) {
  const ex = bx - ax, ey = by - ay, l2 = ex * ex + ey * ey;
  let u = l2 ? ((px - ax) * ex + (py - ay) * ey) / l2 : 0; u = u < 0 ? 0 : u > 1 ? 1 : u;
  return Math.hypot(px - ax - ex * u, py - ay - ey * u);
}
function wallDist(d, x, y) {
  let m = 1e9;
  for (const poly of [d.outline, ...(d.islands || [])])
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i], b = poly[(i + 1) % poly.length];
      m = Math.min(m, segDist(x, y, a[0], a[1], b[0], b[1]));
    }
  return m;
}
function mirrorDef(d, fx, fy) {
  const X = x => (fx ? 1000 - x : x), Y = y => (fy ? 600 - y : y);
  const P = q => [X(q[0]), Y(q[1])];
  const S = s => s.t === 'r'
    ? { t: 'r', x0: Math.min(X(s.x0), X(s.x1)), x1: Math.max(X(s.x0), X(s.x1)), y0: Math.min(Y(s.y0), Y(s.y1)), y1: Math.max(Y(s.y0), Y(s.y1)) }
    : { t: 'c', x: X(s.x), y: Y(s.y), r: s.r };
  const o = Object.assign({}, d);
  o.outline = d.outline.map(P);
  if (d.islands) o.islands = d.islands.map(poly => poly.map(P));
  if (d.sand) o.sand = d.sand.map(S);
  if (d.water) o.water = d.water.map(S);
  if (d.slopes) o.slopes = d.slopes.map(q => ({ s: S(q.s), ax: fx ? -q.ax : q.ax, ay: fy ? -q.ay : q.ay }));
  if (d.bumpers) o.bumpers = d.bumpers.map(b => Object.assign({}, b, { x: X(b.x), y: Y(b.y) }));
  if (d.mills) o.mills = d.mills.map(m => {
    const r = Object.assign({}, m, { x: X(m.x), y: Y(m.y) });
    if (fx && fy) r.ph = m.ph + Math.PI;
    else if (fx) { r.om = -m.om; r.ph = Math.PI - m.ph; }
    else if (fy) { r.om = -m.om; r.ph = -m.ph; }
    return r;
  });
  if (d.gates) o.gates = d.gates.map(g => Object.assign({}, g, { x: X(g.x), y: Y(g.y), ph: fy ? g.ph + Math.PI : g.ph }));
  o.tee = { x: X(d.tee.x), y: Y(d.tee.y) };
  o.cup = { x: X(d.cup.x), y: Y(d.cup.y) };
  return o;
}
function varyDef(d0) {
  const d = JSON.parse(JSON.stringify(d0));
  const R = Math.random, J = r => (R() * 2 - 1) * r;
  for (const m of d.mills || []) { m.om *= 1 + J(0.14); m.ph = R() * TAU2; }
  for (const g of d.gates || []) { g.T *= 1 + J(0.12); g.ph = R() * TAU2; }
  const bumps = d.bumpers || [];
  bumps.forEach((b, i) => {
    for (let k = 0; k < 6; k++) {
      const x = b.x + J(12), y = b.y + J(12);
      let ok = wallDist(d, x, y) >= b.r + RW + 14 && pointInPolys([d.outline], x, y);
      ok = ok && Math.hypot(x - d.tee.x, y - d.tee.y) > b.r + 40 && Math.hypot(x - d.cup.x, y - d.cup.y) > b.r + 40;
      for (const w of d.water || []) if (ok && (w.t === 'c' ? Math.hypot(x - w.x, y - w.y) < w.r + b.r + 14 : (x > w.x0 - b.r - 14 && x < w.x1 + b.r + 14 && y > w.y0 - b.r - 14 && y < w.y1 + b.r + 14))) ok = false;
      bumps.forEach((o, j) => { if (j !== i && Math.hypot(x - o.x, y - o.y) < o.r + b.r + 2 * BR + 10) ok = false; });
      for (const m of d.mills || []) if (Math.hypot(x - m.x, y - m.y) < m.len + b.r + 20) ok = false;
      for (const g of d.gates || []) if (Math.abs(x - g.x) < b.r + 30) ok = false;
      if (ok) { b.x = x; b.y = y; break; }
    }
  });
  for (const s of d.sand || []) {
    if (s.t !== 'c') continue;
    const inT = inS(s, d.tee.x, d.tee.y), inC = inS(s, d.cup.x, d.cup.y);
    for (let k = 0; k < 6; k++) {
      const x = s.x + J(14), y = s.y + J(14), t = { t: 'c', x, y, r: s.r };
      if (inS(t, d.tee.x, d.tee.y) === inT && inS(t, d.cup.x, d.cup.y) === inC && wallDist(d, x, y) > 12 && pointInPolys([d.outline], x, y)) { s.x = x; s.y = y; break; }
    }
  }
  return d;
}
function pickCourse(force, plain) {
  const R = Math.random;
  const shuffle = a => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(R() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
  let sel = null;
  if (force) sel = force.map(i => POOL[i]);
  else {
    for (let tries = 0; tries < 600 && !sel; tries++) {
      const c = shuffle(POOL.map((_, i) => i)).slice(0, NHOLES).map(i => POOL[i]);
      const ex = c.reduce((a, h) => a + h.ex, 0);
      const nm = c.filter(h => h.mills).length, ng = c.filter(h => h.gates).length, nw = c.filter(h => h.water).length;
      if (ex >= -0.6 && ex <= 0.6 && nm <= 2 && ng <= 2 && nw <= 5) sel = c;
    }
    if (!sel) sel = shuffle(POOL.slice()).slice(0, NHOLES);
    // easy holes first, par 3s drift towards the back, a par 3 to finish
    const key = new Map(sel.map(h => [h, h.par + h.ex + R() * 1.1]));
    sel.sort((a, b) => key.get(a) - key.get(b));
  }
  if (plain) return sel;
  return sel.map(h => mirrorDef(varyDef(h), R() < 0.5, R() < 0.5));
}

// Calibration from AI test rounds (all styles mixed): ex = average strokes minus par for each design.
// A round is only dealt if its holes' ex add up to a fair, winnable-but-not-easy total.
const POOL_PAR = [2, 2, 2, 2, 3, 2, 3, 2, 3, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2];
const POOL_EX = [0.24, 0.17, -0.32, 0.32, -0.39, -0.35, 0.06, 0.18, 0.68, -0.31, -0.29, -0.32, -0.15, -0.4, -0.29, -0.24, -0.4, 0.38, -0.53, -0.31];
POOL.forEach((h, i) => { h.par = POOL_PAR[i]; h.ex = POOL_EX[i]; });

function compile(def) {
  const H = Object.assign({}, def);
  H.islands = def.islands || [];
  H.sand = def.sand || [];
  H.water = def.water || [];
  H.slopes = def.slopes || [];
  H.mills = (def.mills || []).map(m => Object.assign({}, m));
  H.gates = (def.gates || []).map(g => Object.assign({}, g));
  H.bumpers = (def.bumpers || []).map(b => Object.assign({}, b));
  for (const m of H.mills) H.bumpers.push({ x: m.x, y: m.y, r: m.hub, hubOf: true });
  const polys = [def.outline, ...H.islands];
  H.polys = polys;
  const pad = RW + 1;
  const A = [], B = [], C = [], D = [];
  for (const poly of polys) for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    A.push(a[0]); B.push(a[1]); C.push(b[0]); D.push(b[1]);
  }
  const n = A.length;
  H.ns = n;
  H.sx0 = Float64Array.from(A); H.sy0 = Float64Array.from(B); H.sx1 = Float64Array.from(C); H.sy1 = Float64Array.from(D);
  H.bx0 = new Float64Array(n); H.bx1 = new Float64Array(n); H.by0 = new Float64Array(n); H.by1 = new Float64Array(n); H.sl2 = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    H.bx0[i] = Math.min(A[i], C[i]) - pad; H.bx1[i] = Math.max(A[i], C[i]) + pad;
    H.by0[i] = Math.min(B[i], D[i]) - pad; H.by1[i] = Math.max(B[i], D[i]) + pad;
    H.sl2[i] = (C[i] - A[i]) ** 2 + (D[i] - B[i]) ** 2;
  }
  let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
  for (const p of def.outline) { x0 = Math.min(x0, p[0]); y0 = Math.min(y0, p[1]); x1 = Math.max(x1, p[0]); y1 = Math.max(y1, p[1]); }
  H.minX = x0; H.minY = y0; H.maxX = x1; H.maxY = y1;
  H.hasDyn = H.mills.length + H.gates.length > 0;
  H.path = null;
  if (typeof Path2D !== 'undefined') {
    const p = new Path2D();
    for (const poly of polys) { poly.forEach((q, i) => (i ? p.lineTo(q[0], q[1]) : p.moveTo(q[0], q[1]))); p.closePath(); }
    H.path = p;
  }
  // decorative speckles for sand (deterministic per hole)
  H.speck = H.sand.map((s, k) => {
    const out = []; let seed = 1337 + k * 77 + Math.floor(s.t === 'r' ? s.x0 : s.x);
    const rr = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
    const area = s.t === 'r' ? (s.x1 - s.x0) * (s.y1 - s.y0) : Math.PI * s.r * s.r;
    const cnt = Math.min(260, Math.floor(area / 55));
    for (let i = 0; i < cnt; i++) {
      let x, y;
      if (s.t === 'r') { x = s.x0 + rr() * (s.x1 - s.x0); y = s.y0 + rr() * (s.y1 - s.y0); }
      else { const a = rr() * TAU2, d = Math.sqrt(rr()) * s.r; x = s.x + Math.cos(a) * d; y = s.y + Math.sin(a) * d; }
      out.push([x, y, rr() < 0.5 ? 0 : 1]);
    }
    return out;
  });
  return H;
}

// ---------------------------------------------------------------------------
// Physics (shared by the real game and by the AI's in-head simulations)
// ---------------------------------------------------------------------------
const DYN = { n: 0, ax: new Float64Array(24), ay: new Float64Array(24), bx: new Float64Array(24), by: new Float64Array(24),
  rw: new Float64Array(24), cx: new Float64Array(24), cy: new Float64Array(24), om: new Float64Array(24),
  gvx: new Float64Array(24), gvy: new Float64Array(24) };

function buildDyn(H, t) {
  let n = 0;
  for (const m of H.mills) {
    for (let k = 0; k < m.n; k++) {
      const a = m.ph + m.om * t + k * TAU2 / m.n, c = Math.cos(a), s = Math.sin(a);
      DYN.ax[n] = m.x + c * m.hub; DYN.ay[n] = m.y + s * m.hub;
      DYN.bx[n] = m.x + c * m.len; DYN.by[n] = m.y + s * m.len;
      DYN.rw[n] = BR + m.w / 2; DYN.cx[n] = m.x; DYN.cy[n] = m.y; DYN.om[n] = m.om; DYN.gvx[n] = 0; DYN.gvy[n] = 0;
      n++;
    }
  }
  for (const g of H.gates) {
    const arg = TAU2 * t / g.T + g.ph;
    const cy = g.y + g.amp * Math.sin(arg);
    DYN.ax[n] = g.x; DYN.ay[n] = cy - g.len / 2; DYN.bx[n] = g.x; DYN.by[n] = cy + g.len / 2;
    DYN.rw[n] = BR + g.w / 2; DYN.cx[n] = 0; DYN.cy[n] = 0; DYN.om[n] = 0; DYN.gvx[n] = 0;
    DYN.gvy[n] = g.amp * TAU2 / g.T * Math.cos(arg);
    n++;
  }
  DYN.n = n;
}

const BALL = { x: 0, y: 0, vx: 0, vy: 0, hitV: 0, hitB: -1, wall: 0 };

// advance one substep; returns 0 = nothing, 1 = sunk, 2 = water
function stepBall(b, H, t, dyn) {
  let x = b.x, y = b.y, vx = b.vx, vy = b.vy;
  let dec = ROLL;
  const sand = H.sand;
  for (let i = 0; i < sand.length; i++) if (inS(sand[i], x, y)) { dec += SAND; break; }
  const sl = H.slopes;
  for (let i = 0; i < sl.length; i++) if (inS(sl[i].s, x, y)) { vx += sl[i].ax * DT; vy += sl[i].ay * DT; }
  let sp = Math.sqrt(vx * vx + vy * vy);
  const dd = dec * DT;
  if (sp <= dd) { vx = 0; vy = 0; sp = 0; } else { const k = (sp - dd) / sp; vx *= k; vy *= k; sp -= dd; }
  const cx = H.cup.x, cy = H.cup.y;
  let cdx = cx - x, cdy = cy - y;
  const cd2 = cdx * cdx + cdy * cdy;
  if (sp > 0 && sp < 190 && cd2 < (CR * 1.9) * (CR * 1.9) && cd2 > 1e-6) {
    const cd = Math.sqrt(cd2);
    vx += cdx / cd * 260 * DT; vy += cdy / cd * 260 * DT;
  }
  x += vx * DT; y += vy * DT;
  let hv = 0, hitB = -1, wall = 0;
  // static walls
  const ns = H.ns, sx0 = H.sx0, sy0 = H.sy0, sx1 = H.sx1, sy1 = H.sy1, bx0 = H.bx0, bx1 = H.bx1, by0 = H.by0, by1 = H.by1, sl2 = H.sl2;
  for (let i = 0; i < ns; i++) {
    if (x < bx0[i] || x > bx1[i] || y < by0[i] || y > by1[i]) continue;
    const ax = sx0[i], ay = sy0[i], ex = sx1[i] - ax, ey = sy1[i] - ay;
    let u = ((x - ax) * ex + (y - ay) * ey) / sl2[i];
    u = u < 0 ? 0 : u > 1 ? 1 : u;
    const dx = x - (ax + ex * u), dy = y - (ay + ey * u), d2 = dx * dx + dy * dy;
    if (d2 < RW2 && d2 > 1e-9) {
      const d = Math.sqrt(d2), nx = dx / d, ny = dy / d;
      x += nx * (RW - d); y += ny * (RW - d);
      const vn = vx * nx + vy * ny;
      if (vn < 0) {
        vx -= (1 + E_WALL) * vn * nx; vy -= (1 + E_WALL) * vn * ny;
        const tx = -ny, ty = nx, vt = (vx * tx + vy * ty) * 0.012;
        vx -= vt * tx; vy -= vt * ty;
        if (-vn > hv) hv = -vn;
        wall = 1;
      }
    }
  }
  // bumpers
  const bp = H.bumpers;
  for (let i = 0; i < bp.length; i++) {
    const q = bp[i], dx = x - q.x, dy = y - q.y, rr = q.r + BR, d2 = dx * dx + dy * dy;
    if (d2 < rr * rr && d2 > 1e-9) {
      const d = Math.sqrt(d2), nx = dx / d, ny = dy / d;
      x = q.x + nx * rr; y = q.y + ny * rr;
      const vn = vx * nx + vy * ny;
      if (vn < 0) {
        vx -= (1 + E_BUMP) * vn * nx; vy -= (1 + E_BUMP) * vn * ny;
        if (-vn > hv) hv = -vn;
        hitB = i;
      }
    }
  }
  // moving obstacles
  if (dyn && H.hasDyn) {
    buildDyn(H, t);
    for (let i = 0; i < DYN.n; i++) {
      const ax = DYN.ax[i], ay = DYN.ay[i], ex = DYN.bx[i] - ax, ey = DYN.by[i] - ay;
      const l2 = ex * ex + ey * ey;
      let u = ((x - ax) * ex + (y - ay) * ey) / l2;
      u = u < 0 ? 0 : u > 1 ? 1 : u;
      const qx = ax + ex * u, qy = ay + ey * u, dx = x - qx, dy = y - qy, rw = DYN.rw[i], d2 = dx * dx + dy * dy;
      if (d2 < rw * rw && d2 > 1e-9) {
        const d = Math.sqrt(d2), nx = dx / d, ny = dy / d;
        x += nx * (rw - d); y += ny * (rw - d);
        const qvx = DYN.gvx[i] - DYN.om[i] * (qy - DYN.cy[i]), qvy = DYN.gvy[i] + DYN.om[i] * (qx - DYN.cx[i]);
        const rvx = vx - qvx, rvy = vy - qvy, vn = rvx * nx + rvy * ny;
        if (vn < 0) {
          vx = rvx - (1 + E_MOVE) * vn * nx + qvx; vy = rvy - (1 + E_MOVE) * vn * ny + qvy;
          if (-vn > hv) hv = -vn;
          wall = 2;
        }
      }
    }
  }
  b.x = x; b.y = y; b.vx = vx; b.vy = vy; b.hitV = hv; b.hitB = hitB; b.wall = wall;
  const wt = H.water;
  for (let i = 0; i < wt.length; i++) if (inS(wt[i], x, y)) return 2;
  cdx = cx - x; cdy = cy - y;
  const d2c = cdx * cdx + cdy * cdy;
  if (d2c < CR * CR) {
    const sp2 = Math.sqrt(vx * vx + vy * vy), d = Math.sqrt(d2c);
    if (sp2 < SINKV * (1 - 0.85 * d / CR)) { b.x = cx; b.y = cy; return 1; }
  }
  return 0;
}

const SIMR = { code: 0, x: 0, y: 0, t: 0, bn: 0 };
const SB = { x: 0, y: 0, vx: 0, vy: 0, hitV: 0, hitB: -1, wall: 0 };
function simulate(H, x, y, ang, spd, t0, dyn) {
  const b = SB;
  b.x = x; b.y = y; b.vx = Math.cos(ang) * spd; b.vy = Math.sin(ang) * spd;
  let t = t0, n = 0, bn = 0;
  for (; n < 2400; n++) {
    const r = stepBall(b, H, t, dyn);
    t += DT;
    if (b.wall === 1) bn++;
    SIMR.bn = bn;
    if (r) { SIMR.code = r; SIMR.x = b.x; SIMR.y = b.y; SIMR.t = n * DT; return SIMR; }
    if (b.vx === 0 && b.vy === 0) break;
  }
  SIMR.code = 0; SIMR.x = b.x; SIMR.y = b.y; SIMR.t = n * DT;
  return SIMR;
}

// ---------------------------------------------------------------------------
// The AI. Everything it knows comes from observe(): the ball position, the course layout
// (walls, hazards, slopes, cup — all visible), and the *visible phase* of moving obstacles.
// It does not see the RNG that perturbs its swing. It "plays in its head": it simulates the same
// rolling physics a human learns, searching angle x power on a grid, refining, then picking the
// shot that is best when aim jitters by ~0.4 deg and power by ~2% (and waits for windmill/gate gaps).
// The search runs as a generator, a few ms per tick, over the first ~1.5 s of lining up.
// ---------------------------------------------------------------------------
class Heap {
  constructor() { this.k = []; this.v = []; }
  push(key, val) {
    const k = this.k, v = this.v; let i = k.length; k.push(key); v.push(val);
    while (i > 0) { const p = (i - 1) >> 1; if (k[p] <= key) break; k[i] = k[p]; v[i] = v[p]; i = p; }
    k[i] = key; v[i] = val;
  }
  pop() {
    const k = this.k, v = this.v, rv = v[0], lk = k.pop(), lv = v.pop(), n = k.length;
    if (n) {
      let i = 0;
      for (;;) {
        let c = 2 * i + 1; if (c >= n) break;
        if (c + 1 < n && k[c + 1] < k[c]) c++;
        if (k[c] >= lk) break;
        k[i] = k[c]; v[i] = v[c]; i = c;
      }
      k[i] = lk; v[i] = lv;
    }
    return rv;
  }
  get size() { return this.k.length; }
}

function pointInPolys(polys, x, y) {
  let inside = false;
  for (const poly of polys) {
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const xi = poly[i][0], yi = poly[i][1], xj = poly[j][0], yj = poly[j][1];
      if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
    }
  }
  return inside;
}

// geodesic distance-to-cup field over the visible course (ignores moving obstacles)
function buildNav(H) {
  const cs = 8, minX = H.minX, minY = H.minY;
  const nx = Math.ceil((H.maxX - minX) / cs) + 1, ny = Math.ceil((H.maxY - minY) / cs) + 1;
  const ok = new Uint8Array(nx * ny), mul = new Float32Array(nx * ny).fill(1);
  const thr = (RW - 3) * (RW - 3);
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const x = minX + i * cs, y = minY + j * cs;
    let good = pointInPolys(H.polys, x, y);
    if (good) {
      for (let s = 0; s < H.ns && good; s++) {
        if (x < H.bx0[s] || x > H.bx1[s] || y < H.by0[s] || y > H.by1[s]) continue;
        const ax = H.sx0[s], ay = H.sy0[s], ex = H.sx1[s] - ax, ey = H.sy1[s] - ay;
        let u = ((x - ax) * ex + (y - ay) * ey) / H.sl2[s]; u = u < 0 ? 0 : u > 1 ? 1 : u;
        const dx = x - ax - ex * u, dy = y - ay - ey * u;
        if (dx * dx + dy * dy < thr) good = false;
      }
    }
    if (good) for (const w of H.water) if (inS(w, x, y)) { good = false; break; }
    if (good) for (const b of H.bumpers) if ((x - b.x) ** 2 + (y - b.y) ** 2 < (b.r + BR - 2) ** 2) { good = false; break; }
    if (good) for (const s of H.sand) if (inS(s, x, y)) { mul[j * nx + i] = 1.7; break; }
    ok[j * nx + i] = good ? 1 : 0;
  }
  const dist = new Float64Array(nx * ny).fill(Infinity);
  const ci = Math.round((H.cup.x - minX) / cs), cj = Math.round((H.cup.y - minY) / cs);
  const hp = new Heap();
  dist[cj * nx + ci] = 0; ok[cj * nx + ci] = 1; hp.push(0, cj * nx + ci);
  while (hp.size) {
    const key = hp.k[0], id = hp.pop();
    if (key > dist[id]) continue;
    const i = id % nx, j = (id / nx) | 0;
    for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
      if (!di && !dj) continue;
      const ii = i + di, jj = j + dj;
      if (ii < 0 || jj < 0 || ii >= nx || jj >= ny) continue;
      const nid = jj * nx + ii;
      if (!ok[nid]) continue;
      const nd = key + (di && dj ? 1.414 : 1) * cs * mul[nid];
      if (nd < dist[nid]) { dist[nid] = nd; hp.push(nd, nid); }
    }
  }
  return {
    gd(x, y) {
      const i = Math.round((x - minX) / cs), j = Math.round((y - minY) / cs);
      let best = Infinity;
      for (let r = 0; r <= 3 && best === Infinity; r++) {
        for (let dj = -r; dj <= r; dj++) for (let di = -r; di <= r; di++) {
          const ii = i + di, jj = j + dj;
          if (ii < 0 || jj < 0 || ii >= nx || jj >= ny) continue;
          const d = dist[jj * nx + ii];
          if (d < best) best = d;
        }
      }
      return best === Infinity ? 2500 : best;
    },
  };
}

const restCost = gd => 1 + 0.9 * (1 - Math.exp(-gd / 170));

// AI styles: genuinely different tactics, all competent.
//  robust  - how much aim/power jitter the final shot choice is tested against (low = takes the sharper line)
//  powPen  - cost per unit of putt power (high = prefers soft, controlled putts)
//  restW   - weight on where the ball ends up when it does not drop (high = lag/position play)
//  bank    - cost bonus per wall bounce (prefers bank shots when they are about as good)
const STYLES = {
  'Bold': { robust: 0.6, powPen: 0.0, restW: 0.8, bank: 0 },
  'Lag putter': { robust: 1.6, powPen: 0.14, restW: 1.35, bank: 0 },
  'Bank artist': { robust: 1.0, powPen: 0.03, restW: 1.0, bank: 0.07 },
};
const STYLE_NAMES = Object.keys(STYLES);

class Golfer {
  constructor(style) { this.st = STYLES[style] || STYLES['Bold']; this.nav = null; this.H = null; this.gen = null; this.done = true; this.plan = null; this.best = null; }
  newHole(H) { this.nav = buildNav(H); this.H = H; }
  // obs = { x, y, t, mills:[{angle}], gates:[{arg}] }
  begin(obs) {
    // model of the course as seen right now (moving parts positioned from what is visible)
    const M = Object.create(this.H);
    M.mills = this.H.mills.map((m, i) => Object.assign({}, m, { ph: obs.mills[i].angle - m.om * obs.t }));
    M.gates = this.H.gates.map((g, i) => Object.assign({}, g, { ph: obs.gates[i].arg - TAU2 * obs.t / g.T }));
    this.M = M; this.obs = obs; this.plan = null; this.best = null; this.done = false;
    this.gen = this.search();
  }
  step(ms) {
    if (this.done) return;
    this.deadline = performance.now() + ms;
    if (this.gen.next().done) this.done = true;
  }
  finish() { while (!this.done) this.step(50); }
  cost(res) {
    const st = this.st, bb = st.bank * Math.min(res.bn, 2), rj = Math.random() * 1e-3; // rj: random tie-break
    if (res.code === 1) return 1 - bb + rj;
    if (res.code === 2) return 2 + st.restW * restCost(this.nav.gd(this.obs.x, this.obs.y)) + rj;
    let c = 1 + st.restW * restCost(this.nav.gd(res.x, res.y)) - bb;
    for (const s of this.H.sand) if (inS(s, res.x, res.y)) { c += 0.2; break; }
    return c + rj;
  }
  run(ang, spd, dyn, t) {
    const o = this.obs, r = simulate(this.M, o.x, o.y, ang, spd, t, dyn);
    return this.cost(r);
  }
  *search() {
    const o = this.obs, M = this.M, hasDyn = M.hasDyn;
    const D2R = Math.PI / 180;
    const spdOf = p => VMIN + p * (VMAX - VMIN);
    const tRel = o.t + AIM_T;
    const over = () => performance.now() > this.deadline;
    // stage 1: coarse sweep, ignoring moving parts (we handle their timing later)
    const PW = [0.14, 0.24, 0.36, 0.5, 0.65, 0.82, 1.0], NA = 120;
    const cands = [], a0 = Math.random() * TAU2 / NA;   // random grid offset: equal shots are not always found the same way
    for (let i = 0; i < NA; i++) {
      const a = a0 + i * TAU2 / NA;
      for (const p of PW) {
        const c = this.run(a, spdOf(p), false, tRel);
        cands.push({ a, p, c });
        if (!this.best || c < this.best.c) this.best = { a, p, c };
        if (over()) yield;
      }
    }
    cands.sort((u, v) => u.c - v.c);
    const picked = [];
    const angD = (u, v) => Math.abs(Math.atan2(Math.sin(u - v), Math.cos(u - v)));
    for (const c of cands) {
      if (picked.every(q => angD(q.a, c.a) > 6 * D2R || Math.abs(q.p - c.p) > 0.18)) picked.push(c);
      if (picked.length >= 8) break;
    }
    // stage 2: local refinement of each candidate
    const levels = [[1.6 * D2R, 0.07], [0.6 * D2R, 0.03], [0.2 * D2R, 0.012]];
    for (const cur of picked) {
      for (const [da, dp] of levels) {
        for (let it = 0; it < 2; it++) {
          let bestN = null;
          for (const [sa, sp] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
            const a = cur.a + sa * da, p = cur.p + sp * dp;
            if (p < 0.04 || p > 1) continue;
            const c = this.run(a, spdOf(p), false, tRel);
            if (c < cur.c - 1e-9 && (!bestN || c < bestN.c)) bestN = { a, p, c };
            if (over()) yield;
          }
          if (!bestN) break;
          cur.a = bestN.a; cur.p = bestN.p; cur.c = bestN.c;
          if (cur.c < this.best.c) this.best = { a: cur.a, p: cur.p, c: cur.c };
        }
      }
    }
    picked.sort((u, v) => u.c - v.c);
    // stage 3: robustness against aim/power jitter (+ timing of moving obstacles)
    const NS = 8, noise = [];
    for (let i = 0; i < NS; i++) noise.push([gauss() * SIG_A * this.st.robust, gauss() * SIG_P * this.st.robust]);
    let period = 0;
    if (M.mills.length) period = TAU2 / (M.mills[0].om * M.mills[0].n);
    else if (M.gates.length) period = M.gates[0].T;
    const delays = hasDyn ? [0, 1, 2, 3, 4, 5, 6, 7].map(k => k * period / 8) : [0];
    let bestR = null;
    for (const cand of picked.slice(0, 6)) {
      for (const dp of [0, -0.025, 0.025]) {
        const p = cand.p + dp;
        if (p < 0.04 || p > 1) continue;
        const spd = spdOf(p);
        // choose delay(s) by nominal cost first
        const dl = [];
        for (const d of delays) {
          dl.push({ d, c: this.run(cand.a, spd, hasDyn, tRel + d) });
          if (over()) yield;
        }
        dl.sort((u, v) => u.c - v.c);
        for (const e of dl.slice(0, hasDyn ? 2 : 1)) {
          let sum = 0;
          for (const [na, np] of noise) {
            sum += this.run(cand.a + na, spd * (1 + np), hasDyn, tRel + e.d);
            if (over()) yield;
          }
          const rc = sum / NS + this.st.powPen * p + 0.012 * e.d + Math.random() * 0.004;
          if (!bestR || rc < bestR.rc) bestR = { a: cand.a, p, delay: e.d, rc };
        }
      }
    }
    this.plan = bestR || { a: this.best.a, p: this.best.p, delay: 0, rc: 9 };
  }
}
function gauss() {
  let u = 0, v = 0;
  while (!u) u = Math.random();
  while (!v) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(TAU2 * v);
}

// ---------------------------------------------------------------------------
// Game
// ---------------------------------------------------------------------------
const COL = {
  brick: '#9a4231', brickHi: '#c36a4e', brickDark: '#2a100c',
  feltA: '#1e6c48', feltB: '#175a3b', feltEdge: '#0b3524',
  amber: '#f2b94b', cream: '#f4ead2',
};

function makeGlow(rgb, size = 64) {
  const c = document.createElement('canvas'); c.width = c.height = size;
  const g = c.getContext('2d'), r = size / 2;
  const gr = g.createRadialGradient(r, r, 0, r, r, r);
  gr.addColorStop(0, `rgba(${rgb},1)`); gr.addColorStop(0.25, `rgba(${rgb},0.45)`); gr.addColorStop(1, `rgba(${rgb},0)`);
  g.fillStyle = gr; g.fillRect(0, 0, size, size);
  return c;
}

function create() {
  const dbg = typeof globalThis !== 'undefined' ? globalThis.__golfDbg : null;
  const course = pickCourse(dbg && dbg.force, dbg && dbg.plain);
  const holes = course.map(compile);
  const style = STYLE_NAMES[Math.floor(Math.random() * STYLE_NAMES.length)];
  const golfer = new Golfer(dbg && dbg.style || style);
  const bulbCols = ['255,200,110', '255,150,120', '150,225,205', '255,236,190'];
  const glows = bulbCols.map(c => makeGlow(c));
  const flies = [];
  for (let i = 0; i < 26; i++) flies.push({ x: Math.random(), y: Math.random(), ph: Math.random() * 6.28, sp: 0.2 + Math.random() * 0.5, r: 0.02 + Math.random() * 0.04 });

  const G = {
    over: false, won: false, W: 0, H: 0,
    t: 0, holeIdx: -1, P: null, prevP: null, trans: 1, strokesTotal: 0, parDone: 0,
    scores: [], overT: 0, bg: null, endMsg: '', timeout: false,
  };

  function newPlay(idx) {
    const V = holes[idx];
    const P = {
      V, idx, ph: 'arrive', pt: 0, strokes: 0,
      b: { x: V.tee.x, y: V.tee.y, px: V.tee.x, py: V.tee.y, vx: 0, vy: 0 },
      last: { x: V.tee.x, y: V.tee.y },
      trail: [], parts: new Particles(), pops: [], rings: [], bump: V.bumpers.map(() => 0),
      aimShow: Math.atan2(V.cup.y - V.tee.y, V.cup.x - V.tee.x), pShow: 0.3, tgtA: 0, tgtP: 0,
      hitT: AIM_T, launched: false, swingT: 9, swingGap: 30, swingAng: 0,
      sinkT: 0, splashT: 0, rollT: 0, flagBoost: 0, dropAlpha: 1, popBall: 0, fit: null,
      sandT: 0, hasAim: false, ballShow: 1,
    };
    return P;
  }

  function fitHole(P) {
    if (!P) return;
    const { W, H } = G, V = P.V;
    const u = clamp(Math.min(W / 1000, H / 620), 0.6, 1.7);
    const cardH = cardRect().h;
    const top = cardRect().y + cardH + H * 0.025;
    const bot = H - clamp(H * 0.085, 52, 80);
    const aw = W * 0.9, ah = Math.max(80, bot - top);
    const bw = V.maxX - V.minX + 40, bh = V.maxY - V.minY + 40;
    const s = Math.min(aw / bw, ah / bh);
    P.fit = { s, ox: (W - (V.maxX - V.minX) * s) / 2 - V.minX * s, oy: top + (ah - (V.maxY - V.minY) * s) / 2 - V.minY * s };
    void u;
  }
  function cardRect() {
    const { W, H } = G;
    const u = clamp(Math.min(W / 1000, H / 620), 0.6, 1.7);
    const w = Math.min(W * 0.9, 860 * u), rowH = 21 * u, h = rowH * 3 + 12 * u;
    return { x: (W - w) / 2, y: Math.max(H * 0.058, 34), w, h, rowH, u };
  }

  function buildBg() {
    const { W, H } = G;
    const c = document.createElement('canvas'); c.width = Math.max(2, Math.ceil(W)); c.height = Math.max(2, Math.ceil(H));
    const g = c.getContext('2d');
    const gr = g.createRadialGradient(W * 0.5, H * 0.45, 0, W * 0.5, H * 0.5, Math.hypot(W, H) * 0.62);
    gr.addColorStop(0, '#12281f'); gr.addColorStop(0.55, '#0b1c17'); gr.addColorStop(1, '#050d0b');
    g.fillStyle = gr; g.fillRect(0, 0, W, H);
    // grass blades
    let seed = 99; const rr = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
    g.lineCap = 'round';
    const n = Math.floor(W * H / 520);
    for (let i = 0; i < n; i++) {
      const x = rr() * W, y = rr() * H, l = 3 + rr() * 5, a = -Math.PI / 2 + (rr() - 0.5) * 0.9;
      g.strokeStyle = rr() < 0.5 ? 'rgba(70,140,100,0.10)' : 'rgba(20,50,35,0.28)';
      g.lineWidth = 1;
      g.beginPath(); g.moveTo(x, y); g.lineTo(x + Math.cos(a) * l, y + Math.sin(a) * l); g.stroke();
    }
    // moon glow
    const mx = W * 0.84, my = H * 0.12, mr = Math.min(W, H) * 0.05;
    const mg = g.createRadialGradient(mx, my, 0, mx, my, mr * 7);
    mg.addColorStop(0, 'rgba(200,225,235,0.20)'); mg.addColorStop(0.3, 'rgba(150,190,200,0.07)'); mg.addColorStop(1, 'rgba(150,190,200,0)');
    g.fillStyle = mg; g.fillRect(0, 0, W, H);
    g.fillStyle = 'rgba(236,244,240,0.85)'; g.beginPath(); g.arc(mx, my, mr, 0, TAU2); g.fill();
    g.fillStyle = 'rgba(160,185,190,0.4)';
    for (const [dx, dy, r] of [[-0.3, -0.25, 0.2], [0.25, 0.1, 0.28], [-0.1, 0.4, 0.15]]) { g.beginPath(); g.arc(mx + dx * mr, my + dy * mr, r * mr, 0, TAU2); g.fill(); }
    G.bg = c;
  }

  // ---- game flow --------------------------------------------------------
  function startHole(idx) {
    G.holeIdx = idx;
    G.prevP = G.P;
    G.P = newPlay(idx);
    fitHole(G.P);
    golfer.newHole(G.P.V);
    G.trans = idx === 0 ? 1 : 0;
    if (idx === 0) G.P.ph = 'wait';
  }

  function observe(P) {
    // what a player sees: ball, course, and the current positions of moving parts
    return {
      x: P.b.x, y: P.b.y, t: G.t,
      mills: P.V.mills.map(m => ({ angle: m.ph + m.om * G.t })),
      gates: P.V.gates.map(g => ({ arg: TAU2 * G.t / g.T + g.ph })),
    };
  }

  function beginAim(P) {
    P.ph = 'aim'; P.pt = 0; P.launched = false; P.hitT = AIM_T;
    P.swingT = 9;
    golfer.begin(observe(P));
    P.tgtA = P.aimShow; P.tgtP = P.pShow; P.hasAim = true;
  }

  function launch(P) {
    const pl = golfer.plan;
    const ang = pl.a + gauss() * SIG_A;
    const spd = (VMIN + pl.p * (VMAX - VMIN)) * (1 + gauss() * SIG_P);
    const b = P.b;
    b.vx = Math.cos(ang) * spd; b.vy = Math.sin(ang) * spd;
    P.last.x = b.x; P.last.y = b.y;
    P.strokes++;
    P.ph = 'roll'; P.rollT = 0; P.swingT = 0; P.swingAng = pl.a;
    P.trail.length = 0;
    P.parts.burst(b.x, b.y, 6, { angle: pl.a, spread: 0.6, speed: 70, speedMin: 20, size: 2.2, life: 0.35, color: ['#eaf7ef', '#cfe9d6'] });
    G.hits = (G.hits || 0) + 1;
  }

  function finishHole(P, pickup) {
    const par = P.V.par;
    const sc = pickup ? MAXS : P.strokes;
    G.scores[P.idx] = sc;
    G.strokesTotal += sc; G.parDone += par;
    const d = sc - par;
    let txt = sc === 1 ? 'HOLE IN ONE!' : pickup ? 'PICK UP' : d <= -2 ? 'EAGLE!' : d === -1 ? 'BIRDIE!' : d === 0 ? 'PAR' : d === 1 ? 'BOGEY' : d === 2 ? 'DOUBLE BOGEY' : '+' + d;
    P.pops.push({ x: P.V.cup.x, y: P.V.cup.y - 40, text: txt, t: 0, col: d < 0 ? '#ffd56a' : d === 0 ? '#e8f4e8' : '#ff9d8a', big: true });
    P.doneT = 0;
  }

  function stepPlay(P, dt, pre) {
    const V = P.V, b = P.b;
    P.pt += dt;
    P.parts.update(dt);
    if (P.parts.list.length > 260) P.parts.list.length = 260;
    for (let i = P.pops.length - 1; i >= 0; i--) { const p = P.pops[i]; p.t += dt; if (p.t > 2.2) P.pops.splice(i, 1); }
    for (let i = P.rings.length - 1; i >= 0; i--) { const r = P.rings[i]; r.t += dt; if (r.t > r.life) P.rings.splice(i, 1); }
    for (let i = 0; i < P.bump.length; i++) P.bump[i] = Math.max(0, P.bump[i] - dt * 4);
    P.flagBoost = Math.max(0, P.flagBoost - dt * 0.8);
    P.swingT += dt;
    if (pre) return;
    b.px = b.x; b.py = b.y;
    const ph = P.ph;
    if (ph === 'arrive') { /* sliding in */ }
    else if (ph === 'wait') {
      if (P.pt > 0.45) beginAim(P);
    } else if (ph === 'aim') {
      const t = P.pt;
      if (!golfer.done) {
        let ms = t < AIM_T - 0.9 ? 2.0 : 9;
        if (t > AIM_T - 0.15) { golfer.finish(); } else golfer.step(ms);
        const bs = golfer.plan || golfer.best;
        if (bs) { P.tgtA = bs.a; P.tgtP = bs.p; }
      }
      if (golfer.done && golfer.plan) {
        P.tgtA = golfer.plan.a; P.tgtP = golfer.plan.p; P.hitT = AIM_T + golfer.plan.delay;
      }
      const da = Math.atan2(Math.sin(P.tgtA - P.aimShow), Math.cos(P.tgtA - P.aimShow));
      P.aimShow += da * (1 - Math.exp(-7 * dt));
      P.pShow += (P.tgtP - P.pShow) * (1 - Math.exp(-6 * dt));
      if (golfer.done && t >= P.hitT) { P.aimShow = golfer.plan.a; launch(P); }
    } else if (ph === 'roll') {
      P.rollT += dt;
      let code = 0;
      for (let k = 0; k < SUB; k++) {
        code = stepBall(b, V, G.t + k * DT, true);
        if (b.hitB >= 0) { P.bump[b.hitB] = 1; }
        if (b.hitV > 140) {
          P.parts.burst(b.x, b.y, 3, { speed: 70, size: 2, life: 0.3, color: b.wall === 2 ? '#ffe2a8' : '#fff2c4' });
          if (b.hitB >= 0) P.parts.burst(b.x, b.y, 5, { speed: 110, size: 2.4, life: 0.4, color: ['#ffd27a', '#ff9d5c'] });
        }
        if (code) break;
      }
      // sand dust
      let inSand = false;
      for (const s of V.sand) if (inS(s, b.x, b.y)) inSand = true;
      if (inSand && (b.vx !== 0 || b.vy !== 0) && Math.random() < 0.5)
        P.parts.burst(b.x, b.y, 1, { speed: 40, size: 2.6, life: 0.6, color: ['#d8c58e', '#b8a272'], drag: 3 });
      if (P.trail.length === 0 || (P.trail[P.trail.length - 1].x - b.x) ** 2 + (P.trail[P.trail.length - 1].y - b.y) ** 2 > 9) {
        P.trail.push({ x: b.x, y: b.y, t: G.t }); if (P.trail.length > 36) P.trail.shift();
      }
      if (code === 1) {
        P.ph = 'sunk'; P.pt = 0; P.sinkT = 0; P.flagBoost = 1;
        const cu = V.cup;
        P.parts.burst(cu.x, cu.y, 40, { speed: 260, size: 3.4, life: 1.2, color: ['#ffd56a', '#fff3c4', '#9ae6b4', '#ffffff'], gravity: 160, drag: 1.6 });
        P.rings.push({ x: cu.x, y: cu.y, t: 0, life: 0.9, r0: 8, r1: 55, col: '255,226,140' });
        finishHole(P, false);
      } else if (code === 2) {
        P.ph = 'splash'; P.pt = 0; P.splashT = 0;
        P.strokes++;       // penalty stroke
        P.rings.push({ x: b.x, y: b.y, t: 0, life: 1.1, r0: 6, r1: 48, col: '170,230,240' });
        P.rings.push({ x: b.x, y: b.y, t: -0.18, life: 1.1, r0: 4, r1: 36, col: '170,230,240' });
        P.parts.burst(b.x, b.y, 26, { speed: 190, size: 3, life: 0.9, color: ['#bfeaf2', '#7fcbdc', '#ffffff'], gravity: 320, drag: 1.2 });
        P.pops.push({ x: b.x, y: b.y - 26, text: '+1 splash', t: 0, col: '#9fe0ee' });
        P.dropAlpha = 1;
      } else if (b.vx === 0 && b.vy === 0 && P.rollT > 0.2) {
        P.vx0 = 0;
        if (P.strokes >= MAXS) { P.ph = 'pickup'; P.pt = 0; finishHole(P, true); }
        else { P.ph = 'wait'; P.pt = 0; }
      } else if (P.rollT > 22) {
        b.vx = b.vy = 0;
        if (P.strokes >= MAXS) { P.ph = 'pickup'; P.pt = 0; finishHole(P, true); } else { P.ph = 'wait'; P.pt = 0; }
      }
    } else if (ph === 'splash') {
      P.splashT += dt;
      if (P.pt > 1.1) {
        b.x = b.px = P.last.x; b.y = b.py = P.last.y; b.vx = b.vy = 0;
        P.trail.length = 0;
        P.popBall = 0;
        if (P.strokes >= MAXS) { P.ph = 'pickup'; P.pt = 0; finishHole(P, true); }
        else { P.ph = 'wait'; P.pt = 0.1; }
      }
    } else if (ph === 'sunk' || ph === 'pickup') {
      P.sinkT += dt;
      if (P.pt > 2.0) P.ph = 'done';
    }
  }

  function step(dt) {
    if (G.over) { G.overT += dt; G.t += dt; if (G.P) stepPlay(G.P, dt, true); return; }
    G.t += dt;
    if (G.holeIdx < 0) startHole(0);
    const P = G.P;
    if (G.trans < 1) {
      G.trans = Math.min(1, G.trans + dt / 1.35);
      if (G.prevP) stepPlay(G.prevP, dt, true);
      if (G.trans >= 1) { G.prevP = null; if (P.ph === 'arrive') { P.ph = 'wait'; P.pt = 0; } }
    }
    stepPlay(P, dt, P.ph === 'arrive');
    if (P.ph === 'done') {
      if (G.holeIdx + 1 >= NHOLES) endGame(false);
      else startHole(G.holeIdx + 1);
    }
    if (!G.over && G.t > TIME_CAP) endGame(true);
  }

  function endGame(timeout) {
    G.over = true; G.overT = 0; G.timeout = timeout;
    const par = course.reduce((a, h) => a + h.par, 0);
    // un-played holes count at par+2 on timeout (so a timeout is a loss)
    let tot = G.strokesTotal;
    if (timeout) tot = par + 99;
    G.final = tot;
    G.won = tot <= par;
    G.parTotal = par;
  }

  // ---- drawing -------------------------------------------------------------
  function drawBackdrop(ctx) {
    const { W, H } = G;
    if (G.bg) ctx.drawImage(G.bg, 0, 0, W, H);
    else { ctx.fillStyle = '#0b1c17'; ctx.fillRect(0, 0, W, H); }
  }

  function drawLights(ctx, t) {
    const { W, H } = G;
    const strands = [
      { y0: H * 0.012, sag: H * 0.03, x0: -10, x1: W + 10, n: 3 },
      { y0: H - H * 0.03, sag: H * 0.02, x0: 340, x1: W + 10, n: 2, bottom: true },
    ];
    ctx.save();
    for (const s of strands) {
      const seg = (s.x1 - s.x0) / s.n;
      ctx.strokeStyle = 'rgba(8,14,12,0.9)'; ctx.lineWidth = 1.4;
      ctx.beginPath();
      const pts = [];
      for (let k = 0; k < s.n; k++) {
        const xa = s.x0 + k * seg;
        for (let i = 0; i <= 24; i++) {
          const u = i / 24, x = xa + u * seg;
          const y = s.y0 + Math.sin(u * Math.PI) * s.sag + Math.sin(t * 0.6 + k) * 0.8;
          i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
          if (i && i % 3 === 0 && i < 24) pts.push([x, y]);
        }
      }
      ctx.stroke();
      ctx.globalCompositeOperation = 'lighter';
      pts.forEach((p, i) => {
        const tw = 0.75 + 0.25 * Math.sin(t * 1.4 + i * 1.7);
        const gi = (i * 7) % 4, gl = glows[gi];
        const sz = 34 + (H / 900) * 8;
        ctx.globalAlpha = 0.85 * tw;
        ctx.drawImage(gl, p[0] - sz / 2, p[1] - sz / 2, sz, sz);
        ctx.globalAlpha = 0.05 * tw;
        const big = H * 0.24;
        ctx.drawImage(gl, p[0] - big / 2, p[1] - big / 2 + (s.bottom ? -big * 0.2 : big * 0.2), big, big);
        ctx.globalAlpha = 0.9;
        ctx.fillStyle = '#fff8e2'; ctx.beginPath(); ctx.arc(p[0], p[1], 1.6, 0, TAU2); ctx.fill();
      });
      ctx.globalCompositeOperation = 'source-over';
    }
    ctx.restore();
  }

  function drawFlies(ctx, t) {
    const { W, H } = G;
    ctx.save(); ctx.globalCompositeOperation = 'lighter';
    for (const f of flies) {
      const x = (f.x + Math.sin(t * f.sp + f.ph) * f.r) * W, y = (f.y + Math.cos(t * f.sp * 0.8 + f.ph) * f.r) * H;
      const a = Math.max(0, Math.sin(t * 1.3 + f.ph * 3));
      ctx.globalAlpha = 0.5 * a * a;
      const sz = 12;
      ctx.drawImage(glows[3], x - sz / 2, y - sz / 2, sz, sz);
    }
    ctx.restore();
  }

  function shapePath(ctx, s) {
    ctx.beginPath();
    if (s.t === 'r') ctx.rect(s.x0, s.y0, s.x1 - s.x0, s.y1 - s.y0);
    else ctx.arc(s.x, s.y, s.r, 0, TAU2);
  }

  function drawHole(ctx, P, shift, tr, al, tAnim) {
    const V = P.V, f = P.fit;
    if (!f) return;
    ctx.save();
    ctx.translate(f.ox + shift, f.oy);
    ctx.scale(f.s, f.s);
    // drop shadow of the course
    ctx.save();
    ctx.translate(0, 9);
    ctx.fillStyle = 'rgba(0,0,0,0.38)'; ctx.fill(V.path, 'evenodd');
    ctx.strokeStyle = 'rgba(0,0,0,0.38)'; ctx.lineWidth = WH * 2 + 4; ctx.lineJoin = 'round'; ctx.stroke(V.path);
    ctx.restore();
    // felt
    ctx.save();
    ctx.clip(V.path, 'evenodd');
    const gr = ctx.createLinearGradient(0, V.minY, 0, V.maxY);
    gr.addColorStop(0, COL.feltA); gr.addColorStop(1, COL.feltB);
    ctx.fillStyle = gr; ctx.fillRect(V.minX - 20, V.minY - 20, V.maxX - V.minX + 40, V.maxY - V.minY + 40);
    // mowing stripes
    ctx.fillStyle = 'rgba(255,255,255,0.028)';
    for (let x = V.minX - 40, k = 0; x < V.maxX + 40; x += 38, k++) if (k % 2) ctx.fillRect(x, V.minY - 20, 38, V.maxY - V.minY + 40);
    // darker edges
    ctx.lineJoin = 'round';
    ctx.strokeStyle = 'rgba(5,35,22,0.30)'; ctx.lineWidth = 64; ctx.stroke(V.path);
    ctx.strokeStyle = 'rgba(5,35,22,0.30)'; ctx.lineWidth = 30; ctx.stroke(V.path);
    // sand
    V.sand.forEach((s, k) => {
      const g2 = ctx.createRadialGradient(s.t === 'c' ? s.x : (s.x0 + s.x1) / 2, s.t === 'c' ? s.y : (s.y0 + s.y1) / 2, 0,
        s.t === 'c' ? s.x : (s.x0 + s.x1) / 2, s.t === 'c' ? s.y : (s.y0 + s.y1) / 2, s.t === 'c' ? s.r : Math.hypot(s.x1 - s.x0, s.y1 - s.y0) / 2);
      g2.addColorStop(0, '#d9c590'); g2.addColorStop(1, '#bda770');
      ctx.fillStyle = g2; shapePath(ctx, s); ctx.fill();
      ctx.save(); shapePath(ctx, s); ctx.clip();
      ctx.fillStyle = 'rgba(120,96,50,0.55)'; ctx.beginPath();
      for (const q of V.speck[k]) if (q[2]) ctx.rect(q[0], q[1], 1.7, 1.7);
      ctx.fill();
      ctx.fillStyle = 'rgba(255,248,214,0.6)'; ctx.beginPath();
      for (const q of V.speck[k]) if (!q[2]) ctx.rect(q[0], q[1], 1.5, 1.5);
      ctx.fill();
      ctx.strokeStyle = 'rgba(90,70,35,0.55)'; ctx.lineWidth = 7; shapePath(ctx, s); ctx.stroke();
      ctx.restore();
      ctx.strokeStyle = 'rgba(70,52,26,0.5)'; ctx.lineWidth = 1.4; shapePath(ctx, s); ctx.stroke();
    });
    // slopes
    V.slopes.forEach(sl => {
      const s = sl.s, mag = Math.hypot(sl.ax, sl.ay), dx = sl.ax / mag, dy = sl.ay / mag;
      const cx = s.t === 'c' ? s.x : (s.x0 + s.x1) / 2, cy = s.t === 'c' ? s.y : (s.y0 + s.y1) / 2;
      const hw = s.t === 'c' ? s.r : (s.x1 - s.x0) / 2, hh = s.t === 'c' ? s.r : (s.y1 - s.y0) / 2;
      const ext = Math.abs(dx) * hw + Math.abs(dy) * hh;
      const g2 = ctx.createLinearGradient(cx - dx * ext, cy - dy * ext, cx + dx * ext, cy + dy * ext);
      g2.addColorStop(0, 'rgba(255,255,230,0.0)'); g2.addColorStop(1, 'rgba(0,25,10,0.28)');
      ctx.fillStyle = g2; shapePath(ctx, s); ctx.fill();
      ctx.save(); shapePath(ctx, s); ctx.clip();
      ctx.strokeStyle = 'rgba(210,245,200,0.34)'; ctx.lineWidth = 2.4; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      const sp = 54, off = (tAnim * (24 + mag * 0.25)) % sp;
      const nx = -dy, ny = dx;
      const R = Math.hypot(hw, hh) + sp;
      for (let a = -R; a <= R; a += sp) for (let c = -R; c <= R; c += 44) {
        const along = a + off, px = cx + dx * along + nx * c, py = cy + dy * along + ny * c;
        const fade = 1 - Math.abs(along) / R;
        ctx.globalAlpha = 0.9 * Math.max(0, fade);
        ctx.beginPath();
        ctx.moveTo(px - dx * 6 + nx * 7, py - dy * 6 + ny * 7);
        ctx.lineTo(px + dx * 6, py + dy * 6);
        ctx.lineTo(px - dx * 6 - nx * 7, py - dy * 6 - ny * 7);
        ctx.stroke();
      }
      ctx.restore();
    });
    // water
    V.water.forEach(s => {
      const cx = s.t === 'c' ? s.x : (s.x0 + s.x1) / 2, cy = s.t === 'c' ? s.y : (s.y0 + s.y1) / 2;
      const rad = s.t === 'c' ? s.r : Math.hypot(s.x1 - s.x0, s.y1 - s.y0) / 2;
      const g2 = ctx.createRadialGradient(cx, cy, 0, cx, cy, rad);
      g2.addColorStop(0, '#13607a'); g2.addColorStop(1, '#0a3a52');
      ctx.fillStyle = g2; shapePath(ctx, s); ctx.fill();
      ctx.save(); shapePath(ctx, s); ctx.clip();
      const x0 = s.t === 'c' ? s.x - s.r : s.x0, x1 = s.t === 'c' ? s.x + s.r : s.x1, y0 = s.t === 'c' ? s.y - s.r : s.y0, y1 = s.t === 'c' ? s.y + s.r : s.y1;
      ctx.lineWidth = 1.6;
      for (let y = y0 + 8, k = 0; y < y1; y += 15, k++) {
        ctx.strokeStyle = `rgba(160,225,235,${0.10 + 0.07 * Math.sin(tAnim * 1.3 + k)})`;
        ctx.beginPath();
        for (let x = x0; x <= x1; x += 6) {
          const yy = y + Math.sin(x * 0.07 + tAnim * 1.6 + k * 1.3) * 2.2;
          x === x0 ? ctx.moveTo(x, yy) : ctx.lineTo(x, yy);
        }
        ctx.stroke();
      }
      const mg = ctx.createRadialGradient(cx + rad * 0.2, cy - rad * 0.15, 0, cx + rad * 0.2, cy - rad * 0.15, rad * 0.7);
      mg.addColorStop(0, 'rgba(235,248,250,0.22)'); mg.addColorStop(1, 'rgba(235,248,250,0)');
      ctx.fillStyle = mg; ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
      ctx.strokeStyle = 'rgba(2,20,30,0.6)'; ctx.lineWidth = 8; shapePath(ctx, s); ctx.stroke();
      ctx.restore();
      ctx.strokeStyle = 'rgba(150,215,225,0.45)'; ctx.lineWidth = 1.6; shapePath(ctx, s); ctx.stroke();
    });
    ctx.restore(); // end felt clip

    // tee mat
    ctx.save();
    ctx.translate(V.tee.x, V.tee.y);
    ctx.fillStyle = 'rgba(0,0,0,0.25)'; roundRect(ctx, -19, -10, 38, 22, 6); ctx.fill();
    ctx.fillStyle = '#2b8a5c'; roundRect(ctx, -19, -12, 38, 22, 6); ctx.fill();
    ctx.strokeStyle = 'rgba(230,255,235,0.35)'; ctx.lineWidth = 1.2; roundRect(ctx, -17, -10, 34, 18, 5); ctx.stroke();
    ctx.restore();

    // cup
    const cu = V.cup;
    ctx.fillStyle = 'rgba(0,0,0,0.35)'; ctx.beginPath(); ctx.arc(cu.x + 1, cu.y + 2, CR + 3, 0, TAU2); ctx.fill();
    const cg = ctx.createRadialGradient(cu.x - 2, cu.y - 3, 1, cu.x, cu.y, CR + 1);
    cg.addColorStop(0, '#202824'); cg.addColorStop(1, '#030504');
    ctx.fillStyle = cg; ctx.beginPath(); ctx.arc(cu.x, cu.y, CR, 0, TAU2); ctx.fill();
    ctx.strokeStyle = 'rgba(210,225,215,0.55)'; ctx.lineWidth = 1.8; ctx.beginPath(); ctx.arc(cu.x, cu.y, CR + 0.4, 0, TAU2); ctx.stroke();

    // walls
    ctx.save();
    ctx.lineJoin = 'round';
    ctx.strokeStyle = COL.brickDark; ctx.lineWidth = WH * 2 + 4; ctx.stroke(V.path);
    ctx.strokeStyle = COL.brick; ctx.lineWidth = WH * 2; ctx.stroke(V.path);
    ctx.strokeStyle = 'rgba(40,12,8,0.55)'; ctx.lineWidth = WH * 2; ctx.setLineDash([1.4, 15]); ctx.stroke(V.path);
    ctx.setLineDash([]);
    ctx.strokeStyle = 'rgba(30,8,5,0.5)'; ctx.lineWidth = 1.2; ctx.stroke(V.path);
    ctx.strokeStyle = 'rgba(255,190,150,0.22)'; ctx.lineWidth = 2.2; ctx.setLineDash([]); ctx.stroke(V.path);
    ctx.restore();

    // bumpers
    V.bumpers.forEach((q, i) => {
      if (q.hubOf) return;
      const pulse = P.bump[i] || 0, rr = q.r * (1 + 0.09 * pulse * pulse);
      ctx.fillStyle = 'rgba(0,0,0,0.35)'; ctx.beginPath(); ctx.arc(q.x + 3, q.y + 6, rr, 0, TAU2); ctx.fill();
      const g2 = ctx.createRadialGradient(q.x - rr * 0.3, q.y - rr * 0.35, rr * 0.1, q.x, q.y, rr);
      g2.addColorStop(0, '#f6d58a'); g2.addColorStop(0.6, '#d9962f'); g2.addColorStop(1, '#8a5018');
      ctx.fillStyle = g2; ctx.beginPath(); ctx.arc(q.x, q.y, rr, 0, TAU2); ctx.fill();
      ctx.fillStyle = '#244a43'; ctx.beginPath(); ctx.arc(q.x, q.y, rr * 0.55, 0, TAU2); ctx.fill();
      const g3 = ctx.createRadialGradient(q.x - rr * 0.18, q.y - rr * 0.2, 0, q.x, q.y, rr * 0.55);
      g3.addColorStop(0, `rgba(190,255,230,${0.35 + 0.5 * pulse})`); g3.addColorStop(1, 'rgba(190,255,230,0)');
      ctx.fillStyle = g3; ctx.beginPath(); ctx.arc(q.x, q.y, rr * 0.55, 0, TAU2); ctx.fill();
    });

    // windmills
    V.mills.forEach(m => {
      ctx.save(); ctx.translate(m.x, m.y);
      for (let k = 0; k < m.n; k++) {
        const a = m.ph + m.om * tr + k * TAU2 / m.n;
        ctx.save(); ctx.rotate(a);
        ctx.fillStyle = 'rgba(0,0,0,0.3)'; ctx.fillRect(m.hub + 3, -m.w / 2 + 6, m.len - m.hub, m.w);
        ctx.restore();
      }
      for (let k = 0; k < m.n; k++) {
        const a = m.ph + m.om * tr + k * TAU2 / m.n;
        ctx.save(); ctx.rotate(a);
        const L = m.len - m.hub;
        ctx.fillStyle = '#5a3a1e'; ctx.fillRect(m.hub, -m.w / 2 - 1.5, L, m.w + 3);
        const wg = ctx.createLinearGradient(0, -m.w / 2, 0, m.w / 2);
        wg.addColorStop(0, '#e2b878'); wg.addColorStop(1, '#a9773f');
        ctx.fillStyle = wg; ctx.fillRect(m.hub, -m.w / 2, L, m.w);
        ctx.fillStyle = 'rgba(40,20,5,0.35)';
        for (let x = m.hub + 8; x < m.len - 3; x += 9) ctx.fillRect(x, -m.w / 2, 1.2, m.w);
        ctx.fillStyle = '#d8453a'; ctx.fillRect(m.len - 8, -m.w / 2, 8, m.w);
        ctx.restore();
      }
      const hr = m.hub;
      const hg = ctx.createRadialGradient(-hr * 0.3, -hr * 0.35, 1, 0, 0, hr);
      hg.addColorStop(0, '#f0d9a8'); hg.addColorStop(0.7, '#b0793b'); hg.addColorStop(1, '#5e3a1b');
      ctx.fillStyle = hg; ctx.beginPath(); ctx.arc(0, 0, hr, 0, TAU2); ctx.fill();
      ctx.fillStyle = '#c4413a'; ctx.beginPath(); ctx.arc(0, 0, hr * 0.5, 0, TAU2); ctx.fill();
      ctx.fillStyle = 'rgba(255,230,200,0.5)'; ctx.beginPath(); ctx.arc(-hr * 0.15, -hr * 0.18, hr * 0.18, 0, TAU2); ctx.fill();
      ctx.restore();
    });

    // gates
    V.gates.forEach(g => {
      const arg = TAU2 * tr / g.T + g.ph, cy = g.y + g.amp * Math.sin(arg);
      ctx.fillStyle = 'rgba(0,0,0,0.28)'; roundRect(ctx, g.x - 4, g.y - g.amp - g.len / 2 - 2, 8, g.amp * 2 + g.len + 4, 4); ctx.fill();
      ctx.fillStyle = 'rgba(0,0,0,0.3)'; roundRect(ctx, g.x - g.w / 2 + 4, cy - g.len / 2 + 6, g.w, g.len, g.w / 2); ctx.fill();
      ctx.lineCap = 'butt';
      ctx.strokeStyle = '#f2ead6'; ctx.lineWidth = g.w; ctx.beginPath(); ctx.moveTo(g.x, cy - g.len / 2); ctx.lineTo(g.x, cy + g.len / 2); ctx.stroke();
      ctx.strokeStyle = '#c93e35'; ctx.setLineDash([12, 12]); ctx.beginPath(); ctx.moveTo(g.x, cy - g.len / 2); ctx.lineTo(g.x, cy + g.len / 2); ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = '#f2b94b'; ctx.beginPath(); ctx.arc(g.x, cy - g.len / 2, g.w * 0.7, 0, TAU2); ctx.arc(g.x, cy + g.len / 2, g.w * 0.7, 0, TAU2); ctx.fill();
    });

    // rings (ripples)
    for (const r of P.rings) {
      if (r.t < 0) continue;
      const k = r.t / r.life, rad = lerp(r.r0, r.r1, ease.outCubic(k));
      ctx.strokeStyle = `rgba(${r.col},${0.7 * (1 - k)})`; ctx.lineWidth = 2.2 * (1 - k) + 0.6;
      ctx.beginPath(); ctx.arc(r.x, r.y, rad, 0, TAU2); ctx.stroke();
    }

    // trail
    if (P.trail.length > 1 && P.ph === 'roll') {
      ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      const n = P.trail.length;
      for (let i = 1; i < n; i++) {
        const a = P.trail[i - 1], b2 = P.trail[i];
        ctx.strokeStyle = `rgba(245,250,240,${0.38 * i / n})`; ctx.lineWidth = 1 + 4 * i / n;
        ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b2.x, b2.y); ctx.stroke();
      }
    }

    // ball
    const b = P.b;
    let bx = lerp(b.px, b.x, al), by = lerp(b.py, b.y, al);
    let showBall = P.ph !== 'splash' && P.ph !== 'done' && P.ph !== 'pickup';
    let bs = 1, ba = 1;
    if (P.ph === 'sunk') { const k = Math.min(1, P.sinkT / 0.28); bx = cu.x; by = cu.y; bs = 1 - 0.75 * ease.outCubic(k); ba = 1 - k; showBall = k < 1; }
    if (P.ph === 'wait' && P.pt < 0.5 && P.popBall !== undefined && P.last) bs = 1;
    if (P.ph === 'arrive') { bs = 1; }
    if (showBall) {
      if (P.ph === 'wait' || P.ph === 'aim') bs = 1 + Math.max(0, 0.5 - P.pt * 2) * 0.4 * (P.strokes > 0 ? 1 : 0);
      ctx.globalAlpha = ba;
      ctx.fillStyle = 'rgba(0,0,0,0.35)'; ctx.beginPath(); ctx.ellipse(bx + 1.5, by + 3, BR * bs, BR * bs * 0.8, 0, 0, TAU2); ctx.fill();
      const bg = ctx.createRadialGradient(bx - BR * 0.35, by - BR * 0.4, 0.5, bx, by, BR * bs);
      bg.addColorStop(0, '#ffffff'); bg.addColorStop(0.65, '#e8ece6'); bg.addColorStop(1, '#a9b3ad');
      ctx.fillStyle = bg; ctx.beginPath(); ctx.arc(bx, by, BR * bs, 0, TAU2); ctx.fill();
      ctx.globalAlpha = 1;
    }
    if (P.ph === 'splash' && P.splashT > 0.75) {
      const k = (P.splashT - 0.75) / 0.35;
      ctx.globalAlpha = Math.min(1, k * 1.5);
      const gx = P.last.x, gy = P.last.y, sc = 0.6 + 0.4 * ease.outBack(Math.min(1, k));
      const bg = ctx.createRadialGradient(gx - 2, gy - 2, 0.5, gx, gy, BR * sc);
      bg.addColorStop(0, '#fff'); bg.addColorStop(1, '#a9b3ad');
      ctx.fillStyle = bg; ctx.beginPath(); ctx.arc(gx, gy, BR * sc, 0, TAU2); ctx.fill();
      ctx.globalAlpha = 1;
    }

    // aim + putter
    if (P.ph === 'aim' || (P.ph === 'roll' && P.swingT < 0.6)) drawAim(ctx, P, bx, by);

    // flag
    drawFlag(ctx, V, P, tAnim);

    P.parts.draw(ctx, 1);

    // text pops
    for (const p of P.pops) {
      const k = p.t / 2.2, a = k < 0.12 ? k / 0.12 : k > 0.75 ? (1 - k) / 0.25 : 1;
      const sc = p.big ? 1 + 0.25 * Math.max(0, 1 - k * 6) : 1;
      ctx.save();
      ctx.translate(p.x, p.y - ease.outCubic(Math.min(1, k * 1.4)) * 28);
      ctx.scale(sc, sc);
      ctx.globalAlpha = Math.max(0, a);
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.font = `${p.big ? 600 : 500} ${p.big ? 30 : 18}px Fredoka, "Trebuchet MS", sans-serif`;
      ctx.lineWidth = 5; ctx.strokeStyle = 'rgba(0,20,10,0.75)'; ctx.lineJoin = 'round';
      ctx.strokeText(p.text, 0, 0);
      ctx.fillStyle = p.col; ctx.fillText(p.text, 0, 0);
      ctx.restore();
    }
    ctx.restore();
  }

  function drawFlag(ctx, V, P, t) {
    const cu = V.cup, h = 62;
    const wave = 1 + P.flagBoost * 2.2;
    const px = cu.x + 3, py = cu.y - h;
    ctx.save();
    // shadow on the felt
    ctx.strokeStyle = 'rgba(0,0,0,0.28)'; ctx.lineWidth = 2.4; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(cu.x, cu.y); ctx.lineTo(cu.x + 30, cu.y + 20); ctx.stroke();
    ctx.strokeStyle = '#eee7d3'; ctx.lineWidth = 2.4;
    ctx.beginPath(); ctx.moveTo(cu.x, cu.y); ctx.lineTo(px, py); ctx.stroke();
    // flag cloth
    const fw = 30, fh = 19;
    ctx.beginPath(); ctx.moveTo(px, py + 1);
    for (let i = 0; i <= 8; i++) { const u = i / 8, x = px + u * fw; ctx.lineTo(x, py + 1 + Math.sin(t * 5 - u * 4) * 2.6 * u * wave + u * 2); }
    for (let i = 8; i >= 0; i--) { const u = i / 8, x = px + u * fw * (1 - 0.0); ctx.lineTo(x, py + 1 + fh * (1 - u * 0.35) + Math.sin(t * 5 - u * 4 + 0.4) * 2.6 * u * wave); }
    ctx.closePath();
    const fg = ctx.createLinearGradient(px, py, px + fw, py);
    fg.addColorStop(0, '#f6c35a'); fg.addColorStop(1, '#e0872e');
    ctx.fillStyle = fg; ctx.fill();
    ctx.fillStyle = '#fff8e0'; ctx.beginPath(); ctx.arc(px, py - 1.5, 2.4, 0, TAU2); ctx.fill();
    ctx.restore();
  }

  function drawAim(ctx, P, bx, by) {
    const b = P.b;
    let a = P.aimShow;
    const dx = Math.cos(a), dy = Math.sin(a);
    const t = P.pt;
    const isAim = P.ph === 'aim';
    // dotted guide
    if (isAim) {
      const fadeIn = Math.min(1, t / 0.4), fadeOut = P.hitT - t < 0.25 ? Math.max(0, (P.hitT - t) / 0.25) : 1;
      const al = fadeIn * fadeOut;
      const len = 54 + 190 * P.pShow;
      ctx.save();
      ctx.globalAlpha = 0.75 * al;
      ctx.strokeStyle = 'rgba(255,236,170,0.9)'; ctx.lineWidth = 2.2; ctx.lineCap = 'round';
      ctx.setLineDash([2, 9]);
      ctx.lineDashOffset = -t * 18;
      ctx.beginPath(); ctx.moveTo(bx + dx * 14, by + dy * 14); ctx.lineTo(bx + dx * (14 + len), by + dy * (14 + len)); ctx.stroke();
      ctx.setLineDash([]);
      const ex = bx + dx * (14 + len), ey = by + dy * (14 + len);
      ctx.fillStyle = 'rgba(255,236,170,0.95)';
      ctx.beginPath();
      ctx.moveTo(ex + dx * 9, ey + dy * 9);
      ctx.lineTo(ex - dy * 5.5, ey + dx * 5.5);
      ctx.lineTo(ex + dy * 5.5, ey - dx * 5.5);
      ctx.closePath(); ctx.fill();
      // power arc
      ctx.globalAlpha = 0.85 * al;
      const back = a + Math.PI, span = Math.PI * 0.8 * P.pShow;
      ctx.strokeStyle = 'rgba(0,0,0,0.35)'; ctx.lineWidth = 4;
      ctx.beginPath(); ctx.arc(bx, by, 19, back - Math.PI * 0.4, back + Math.PI * 0.4); ctx.stroke();
      ctx.strokeStyle = `hsl(${lerp(130, 22, P.pShow)},85%,62%)`; ctx.lineWidth = 3.4;
      ctx.beginPath(); ctx.arc(bx, by, 19, back - span / 2, back + span / 2); ctx.stroke();
      ctx.restore();
    }
    // putter
    let gap, alpha = 1;
    if (isAim) {
      const hit = P.hitT;
      const pullK = ease.inOutCubic(clamp((t - (hit - 0.85)) / 0.65, 0, 1));
      const strikeK = clamp((t - (hit - 0.12)) / 0.12, 0, 1);
      const rest = 26 + 4 * Math.sin(t * 2);
      const maxPull = 14 + 36 * P.pShow;
      gap = lerp(rest, rest + maxPull, pullK);
      gap = lerp(gap, BR + 2, strikeK * strikeK);
      alpha = Math.min(1, t / 0.5);
    } else {
      const k = P.swingT;
      gap = lerp(BR + 2, -26, ease.outCubic(clamp(k / 0.22, 0, 1)));
      alpha = 1 - clamp((k - 0.2) / 0.35, 0, 1);
      a = P.swingAng;
    }
    const ux = Math.cos(a), uy = Math.sin(a);
    const hx = bx - ux * gap, hy = by - uy * gap;
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.lineCap = 'round';
    ctx.strokeStyle = 'rgba(0,0,0,0.3)'; ctx.lineWidth = 3.4;
    ctx.beginPath(); ctx.moveTo(hx - ux * 3 + 4, hy - uy * 3 + 7); ctx.lineTo(hx - ux * 70 + 4, hy - uy * 70 + 7); ctx.stroke();
    ctx.strokeStyle = '#c9d2d4'; ctx.lineWidth = 2.6;
    ctx.beginPath(); ctx.moveTo(hx - ux * 3, hy - uy * 3); ctx.lineTo(hx - ux * 70, hy - uy * 70); ctx.stroke();
    ctx.strokeStyle = '#a2552f'; ctx.lineWidth = 4.4;
    ctx.beginPath(); ctx.moveTo(hx - ux * 52, hy - uy * 52); ctx.lineTo(hx - ux * 70, hy - uy * 70); ctx.stroke();
    ctx.save(); ctx.translate(hx, hy); ctx.rotate(a);
    ctx.fillStyle = 'rgba(0,0,0,0.3)'; roundRect(ctx, -6 + 2, -11 + 5, 7, 22, 2.5); ctx.fill();
    const pg = ctx.createLinearGradient(-6, 0, 2, 0);
    pg.addColorStop(0, '#8f9a9d'); pg.addColorStop(1, '#e6eef0');
    ctx.fillStyle = pg; roundRect(ctx, -6, -11, 7, 22, 2.5); ctx.fill();
    ctx.fillStyle = '#f2b94b'; ctx.fillRect(0, -2, 1.2, 4);
    ctx.restore();
    ctx.restore();
  }

  function drawCard(ctx) {
    const { W } = G, r = cardRect(), u = r.u;
    const x0 = r.x, y0 = r.y, w = r.w, h = r.h;
    ctx.save();
    ctx.fillStyle = 'rgba(0,0,0,0.35)'; roundRect(ctx, x0 + 2, y0 + 5, w, h, 10 * u); ctx.fill();
    const g = ctx.createLinearGradient(0, y0, 0, y0 + h);
    g.addColorStop(0, '#2f2217'); g.addColorStop(1, '#211810');
    ctx.fillStyle = g; roundRect(ctx, x0, y0, w, h, 10 * u); ctx.fill();
    ctx.strokeStyle = 'rgba(240,200,130,0.35)'; ctx.lineWidth = 1.2; roundRect(ctx, x0 + 0.5, y0 + 0.5, w - 1, h - 1, 10 * u); ctx.stroke();
    const cols = NHOLES + 2, cw = (w - 16 * u) / cols, ox = x0 + 8 * u;
    const fs = 13 * u;
    ctx.textBaseline = 'middle';
    ctx.font = `600 ${fs}px "IBM Plex Mono", monospace`;
    const rows = [y0 + 6 * u + r.rowH * 0.5, y0 + 6 * u + r.rowH * 1.5, y0 + 6 * u + r.rowH * 2.5];
    ctx.textAlign = 'left'; ctx.fillStyle = 'rgba(244,234,210,0.55)';
    ctx.font = `500 ${fs * 0.9}px Fredoka, sans-serif`;
    ctx.fillText('HOLE', ox, rows[0]); ctx.fillText('PAR', ox, rows[1]); ctx.fillText('AI', ox, rows[2]);
    ctx.textAlign = 'center';
    let totPar = 0, totSc = 0, played = 0;
    for (let i = 0; i < NHOLES; i++) {
      const cx = ox + cw * (i + 1.5);
      const cur = i === G.holeIdx && !G.over;
      if (cur) {
        ctx.fillStyle = 'rgba(242,185,75,0.16)'; roundRect(ctx, cx - cw * 0.46, y0 + 4 * u, cw * 0.92, h - 8 * u, 6 * u); ctx.fill();
        ctx.strokeStyle = 'rgba(242,185,75,0.6)'; ctx.lineWidth = 1; roundRect(ctx, cx - cw * 0.46, y0 + 4 * u, cw * 0.92, h - 8 * u, 6 * u); ctx.stroke();
      }
      ctx.font = `600 ${fs}px "IBM Plex Mono", monospace`;
      ctx.fillStyle = cur ? '#ffd88a' : 'rgba(244,234,210,0.8)';
      ctx.fillText(String(i + 1), cx, rows[0]);
      ctx.fillStyle = 'rgba(244,234,210,0.6)'; ctx.fillText(String(course[i].par), cx, rows[1]);
      totPar += 0;
      const sc = G.scores[i];
      if (sc != null) {
        const d = sc - course[i].par;
        ctx.fillStyle = d < 0 ? '#ffd56a' : d === 0 ? '#e8f4e8' : '#ff9d8a';
        ctx.fillText(String(sc), cx, rows[2]);
        if (d < 0) { ctx.strokeStyle = 'rgba(255,213,106,0.8)'; ctx.lineWidth = 1.2; ctx.beginPath(); ctx.arc(cx, rows[2], fs * 0.85, 0, TAU2); ctx.stroke(); }
        else if (d > 0) { ctx.strokeStyle = 'rgba(255,157,138,0.7)'; ctx.lineWidth = 1.2; ctx.strokeRect(cx - fs * 0.75, rows[2] - fs * 0.75, fs * 1.5, fs * 1.5); }
        totSc += sc; totPar += course[i].par; played++;
      } else if (cur && G.P) {
        ctx.fillStyle = 'rgba(255,216,138,0.9)';
        ctx.fillText(G.P.strokes ? String(G.P.strokes) : '·', cx, rows[2]);
      }
    }
    const cx = ox + cw * (NHOLES + 1.5);
    ctx.font = `600 ${fs * 0.9}px Fredoka, sans-serif`; ctx.fillStyle = 'rgba(244,234,210,0.55)';
    ctx.fillText('TOTAL', cx, rows[0]);
    ctx.font = `600 ${fs}px "IBM Plex Mono", monospace`;
    ctx.fillStyle = 'rgba(244,234,210,0.6)';
    ctx.fillText(String(course.reduce((a, q) => a + q.par, 0)), cx, rows[1]);
    const diff = totSc - totPar;
    ctx.fillStyle = played === 0 ? 'rgba(244,234,210,0.5)' : diff <= 0 ? '#ffd56a' : '#ff9d8a';
    ctx.fillText(played === 0 ? '-' : `${totSc} (${diff > 0 ? '+' : ''}${diff})`, cx, rows[2]);
    ctx.restore();
    void W;
  }

  function draw(ctx, W, H) {
    if (W !== G.W || H !== G.H) resize(W, H);
    const al = alphaNow();
    const tr = G.t - (1 - al) * STEP;
    const tAnim = tr;
    drawBackdrop(ctx);
    drawLights(ctx, tr);
    if (G.P) {
      const e = ease.inOutCubic(G.trans);
      const cx = W / 2, cy = H * 0.55;
      if (G.prevP && G.trans < 1) {
        ctx.save(); ctx.globalAlpha = clamp(1 - e * 1.4, 0, 1);
        const z = 1 - 0.16 * e;
        ctx.translate(cx, cy); ctx.scale(z, z); ctx.translate(-cx, -cy);
        drawHole(ctx, G.prevP, -e * W * 0.9, tr, 1, tAnim);
        ctx.restore();
      }
      if (G.trans < 1) {
        ctx.save(); ctx.globalAlpha = clamp(e * 1.4 - 0.2, 0, 1);
        const z = 1 + 0.16 * (1 - e);
        ctx.translate(cx, cy); ctx.scale(z, z); ctx.translate(-cx, -cy);
        drawHole(ctx, G.P, (1 - e) * W * 0.9, tr, al, tAnim);
        ctx.restore();
      } else drawHole(ctx, G.P, 0, tr, al, tAnim);
    }
    drawFlies(ctx, tr);
    drawCard(ctx);
    if (G.over) drawEnd(ctx, W, H);
    // intro fade
    if (G.t < 0.6) { ctx.fillStyle = `rgba(5,13,11,${1 - G.t / 0.6})`; ctx.fillRect(0, 0, W, H); }
  }

  function drawEnd(ctx, W, H) {
    const k = ease.outCubic(clamp(G.overT / 1.0, 0, 1));
    const par = G.parTotal, tot = G.strokesTotal, d = tot - par;
    ctx.save();
    ctx.fillStyle = `rgba(4,12,9,${0.5 * k})`; ctx.fillRect(0, 0, W, H);
    ctx.globalAlpha = k;
    ctx.translate(W / 2, H / 2 + (1 - k) * 14);
    const u = clamp(Math.min(W / 1000, H / 620), 0.6, 1.7);
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.font = `600 ${58 * u}px Fredoka, "Trebuchet MS", sans-serif`;
    const msg = G.timeout ? 'OUT OF TIME' : d < 0 ? `${-d} UNDER PAR` : d === 0 ? 'LEVEL PAR' : `${d} OVER PAR`;
    ctx.lineWidth = 8 * u; ctx.strokeStyle = 'rgba(0,18,10,0.8)'; ctx.lineJoin = 'round';
    ctx.strokeText(msg, 0, 0);
    ctx.fillStyle = G.won ? '#ffd56a' : '#ff9d8a'; ctx.fillText(msg, 0, 0);
    ctx.font = `500 ${22 * u}px Fredoka, sans-serif`;
    ctx.fillStyle = 'rgba(244,234,210,0.85)';
    ctx.fillText(G.timeout ? '' : `${tot} strokes · par ${par}`, 0, 44 * u);
    ctx.restore();
  }

  function resize(W, H) {
    G.W = W; G.H = H;
    buildBg();
    fitHole(G.P); fitHole(G.prevP);
  }

  const inst = {
    style: dbg && dbg.style || style,
    get over() { return G.over; },
    get won() { return G.won; },
    get scores() { return G.scores; },
    resize, step, draw,
    hud() {
      const P = G.P;
      const hole = Math.max(0, G.holeIdx) + 1;
      const diff = G.strokesTotal - G.parDone;
      const score = `${G.strokesTotal} strokes (${G.strokesTotal === 0 && !G.scores.length ? 'E' : (diff > 0 ? '+' : '') + diff})`;
      const detail = G.over ? 'Round complete' : `Hole ${Math.min(NHOLES, hole)}/${NHOLES} · par ${course[Math.min(NHOLES, hole) - 1].par}${P ? ' · stroke ' + (P.strokes + (P.ph === 'roll' ? 0 : 1)) : ''}`;
      return { score, detail };
    },
    result() {
      const par = course.reduce((a, h) => a + h.par, 0);
      if (G.timeout) return 'Ran out of time on the course';
      const d = G.strokesTotal - par;
      return `Finished 9 holes in ${G.strokesTotal} strokes (par ${par}) — ${d < 0 ? -d + ' under' : d === 0 ? 'level' : d + ' over'}`;
    },
  };
  if (dbg) dbg.last = inst;
  return inst;
}

Arcade.register({
  id: 'golf', name: 'Moonlit Links', genre: 'Mini golf', bg: '#0c1e18', accent: '#f2b94b',
  blurb: 'Nine night holes with windmills, sand and water. Finish at or under par.',
  aiNote: 'Simulates every putt in its head, then swings with a human hand: about 0.4° aim and 2% power wobble.',
  create,
});
})();
