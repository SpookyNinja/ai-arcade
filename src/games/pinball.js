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

// ---------------------------------------------------------------------------
// Clockwork Pinball — a brass-and-walnut table. Logical table 600 x 1000 (y down).
// Physics: circle-vs-capsule collisions, 12 substeps per 60 Hz tick, flippers are
// rotating tapered capsules that impart their surface velocity to the ball.
// ---------------------------------------------------------------------------
const TW = 600, TH = 1000, BR = 11;
const GRAV = 1000, VMAX = 1900, SUBS = 12;
const REST_A = 0.52, UP_A = -0.49, W_UP = 22, W_DN = 14;
const FL_LEN = 88, FL_R0 = 12, FL_R1 = 7;
const FLIPS = [{ px: 190, py: 890, s: 1 }, { px: 375, py: 890, s: -1 }];
const LANE_X = 562, PLUNGER_Y = 968, REST_Y = PLUNGER_Y - BR;
const GOAL = 390000;
const MAX_TIME = 360;
const MX = x => 565 - x;
const ROOF_X = 34, ROOF_Y = 664;
const LANE_C = [251, 314];
const DROP_X = [217, 262, 307, 352], DROP_Y = 470;
const PTS = { bumper: 100, sling: 25, drop: 500, bank: 5000, lane: 1000, lanes: 5000, orbit: 2500 };
const SIMV = { bumper: 2.5, sling: 0.25, drop: 5, lane: 10, lanes: 50, orbit: 18, post: 0 };
const BUMPER_POS = [[190, 290], [370, 275], [272, 372]];
const TAU2 = Math.PI * 2;
const clampv = (v, a, b) => (v < a ? a : v > b ? b : v);

// ---------------------------------------------------------------------------
// Static geometry: every collider is a capsule (segment + radius; a post is a
// degenerate segment).
// ---------------------------------------------------------------------------
const CAPS = [];
const SLINGS = [];
function cap(ax, ay, bx, by, rad, e, kind, o) {
  const c = {
    ax, ay, bx, by, rad, e, kind, id: 0, ow: false, gnx: 0, gny: 0, rail: false, arc: false,
    x0: Math.min(ax, bx) - rad - BR - 2, x1: Math.max(ax, bx) + rad + BR + 2,
    y0: Math.min(ay, by) - rad - BR - 2, y1: Math.max(ay, by) + rad + BR + 2,
  };
  if (o) Object.assign(c, o);
  c.dx = bx - ax; c.dy = by - ay; c.l2 = c.dx * c.dx + c.dy * c.dy;
  CAPS.push(c);
  return c;
}
(function buildGeometry() {
  // top arc
  const N = 30;
  for (let i = 0; i < N; i++) {
    const a0 = Math.PI + Math.PI * i / N, a1 = Math.PI + Math.PI * (i + 1) / N;
    cap(300 + 280 * Math.cos(a0), 300 + 280 * Math.sin(a0), 300 + 280 * Math.cos(a1), 300 + 280 * Math.sin(a1), 0, 0.3, 'wall', { arc: true });
  }
  cap(20, 300, 20, 1000, 0, 0.3, 'wall', { rail: true });
  cap(580, 300, 580, 1000, 0, 0.3, 'wall', { rail: true });
  cap(545, 245, 545, 1000, 3, 0.3, 'wall', { rail: true });
  // one-way gate at the top of the plunger lane (ball passes upward, never returns)
  {
    const l2 = Math.hypot(30, 35);
    cap(545, 245, 580, 215, 2, 0.2, 'gate', { ow: true, gnx: -30 / l2, gny: -35 / l2 });
  }
  // orbit rail on the left
  cap(70, 520, 70, 245, 3, 0.3, 'wall', { rail: true });
  // one-way gate on top of the orbit channel: balls go up through it, never back down the channel
  cap(20, 215, 70, 245, 2, 0.2, 'gate', { ow: true, gnx: 30 / Math.hypot(30, 50), gny: -50 / Math.hypot(30, 50) });
  // right-side deflector: guides balls falling down the right wall back toward the inlane
  cap(545, 520, 503, 585, 3, 0.3, 'wall', { rail: true });
  // outlane roofs
  { cap(20, 636, ROOF_X, ROOF_Y, 3, 0.3, 'wall', { rail: true }); cap(MX(20), 636, MX(ROOF_X), ROOF_Y, 3, 0.3, 'wall', { rail: true }); }
  // lane posts at the top
  for (const x of [220, 282.5, 345]) cap(x, 62, x, 122, 4, 0.5, 'wall', { rail: true });
  // plunger floor
  cap(545, PLUNGER_Y, 580, PLUNGER_Y, 0, 0.15, 'plunger');
  for (let side = 0; side < 2; side++) {
    const X = side ? MX : (x => x);
    cap(X(52), 700, X(52), 760, 3, 0.3, 'wall', { rail: true });
    cap(X(52), 760, X(188), 880, 3, 0.3, 'wall', { rail: true });
    const A = [X(92), 670], B = [X(92), 745], C = [X(150), 775];
    const face = cap(A[0], A[1], C[0], C[1], 2, 0.3, 'sling', { id: side });
    cap(A[0], A[1], B[0], B[1], 2, 0.3, 'wall');
    cap(B[0], B[1], C[0], C[1], 2, 0.3, 'wall');
    SLINGS.push({ pts: [A, B, C], face, side });
  }
  // rubber posts
  for (const [x, y, r] of [[150, 585, 9], [415, 585, 9], [110, 455, 8], [455, 455, 8]]) cap(x, y, x, y, r, 0.55, 'post', { rail: false });
  // pop bumpers
  BUMPER_POS.forEach(([x, y], i) => cap(x, y, x, y, 26, 0.45, 'bumper', { id: i }));
  // drop targets
  DROP_X.forEach((x, i) => cap(x - 18, DROP_Y, x + 18, DROP_Y, 4, 0.35, 'drop', { id: i }));
})();

// ---------------------------------------------------------------------------
// Physics (shared by the real game and by the AI's look-ahead simulation).
// ---------------------------------------------------------------------------
function newState() {
  return {
    x: LANE_X, y: REST_Y, vx: 0, vy: 0, ly: REST_Y,
    fa: [REST_A, REST_A], fw: [0, 0], fp: [0, 0],
    dropUp: [1, 1, 1, 1], dropT: [0, 0, 0, 0], lane: [0, 0], orb: 0,
    sim: false, sv: SIMV, rew: 0, ev: [], drained: false, mult: 1, crossX: -1, crossT: -1,
  };
}
function cloneState(S) {
  return {
    x: S.x, y: S.y, vx: S.vx, vy: S.vy, ly: S.ly,
    fa: [S.fa[0], S.fa[1]], fw: [S.fw[0], S.fw[1]], fp: [S.fp[0], S.fp[1]],
    dropUp: S.dropUp.slice(), dropT: [0, 0, 0, 0], lane: S.lane.slice(), orb: S.orb,
    sim: true, sv: S.sv, rew: 0, ev: null, drained: false, mult: S.mult, crossX: -1, crossT: -1,
  };
}
function emit(S, k, i, x, y, v) {
  if (S.sim) S.rew += (S.sv[k] || 0) * S.mult;
  else S.ev.push({ k, i, x, y, v });
}
function updateFlippers(S, h) {
  for (let i = 0; i < 2; i++) {
    const tgt = S.fp[i] ? UP_A : REST_A;
    const a = S.fa[i];
    let na = a;
    if (a !== tgt) {
      na = tgt < a ? Math.max(tgt, a - W_UP * h) : Math.min(tgt, a + W_DN * h);
    }
    S.fw[i] = (na - a) / h;
    S.fa[i] = na;
  }
}
function collideCap(S, c, h) {
  const x = S.x, y = S.y;
  if (x < c.x0 || x > c.x1 || y < c.y0 || y > c.y1) return;
  if (c.kind === 'drop' && !S.dropUp[c.id]) return;
  let t = c.l2 > 0 ? ((x - c.ax) * c.dx + (y - c.ay) * c.dy) / c.l2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const px = c.ax + c.dx * t, py = c.ay + c.dy * t;
  let nx = x - px, ny = y - py;
  const rr = BR + c.rad;
  const d2 = nx * nx + ny * ny;
  if (d2 >= rr * rr) return;
  if (c.ow) {
    const sd = (x - c.ax) * c.gnx + (y - c.ay) * c.gny;
    if (sd < 0 || S.vx * c.gnx + S.vy * c.gny > 0) return;
  }
  let d = Math.sqrt(d2);
  if (d < 1e-5) {
    if (c.ow) { nx = c.gnx; ny = c.gny; }
    else { const l = Math.sqrt(c.l2) || 1; nx = -c.dy / l; ny = c.dx / l; if (c.l2 === 0) { nx = 0; ny = -1; } }
    d = 0;
  } else { nx /= d; ny /= d; }
  const pen = rr - d;
  S.x += nx * (pen + 0.001); S.y += ny * (pen + 0.001);
  const vn = S.vx * nx + S.vy * ny;
  if (vn >= 0) return;
  const imp = -vn;
  const e = imp < 45 ? 0 : c.e;
  S.vx -= (1 + e) * vn * nx; S.vy -= (1 + e) * vn * ny;
  // rolling resistance on the tangential component
  const f = 1 - 0.35 * h;
  const vt = S.vx * -ny + S.vy * nx; // tangential speed
  const dvt = vt * (1 - f);
  S.vx -= -ny * dvt; S.vy -= nx * dvt;
  switch (c.kind) {
    case 'bumper':
      if (imp > 30) {
        S.vx += nx * 400; S.vy += ny * 400;
        emit(S, 'bumper', c.id, c.ax, c.ay, imp);
      }
      break;
    case 'sling':
      if (imp > 200) {
        const vn2 = S.vx * nx + S.vy * ny;
        if (vn2 < 470) { S.vx += (470 - vn2) * nx; S.vy += (470 - vn2) * ny; }
        emit(S, 'sling', c.id, px, py, imp);
      }
      break;
    case 'drop':
      S.dropT[c.id] += h;
      if (imp > 70 || S.dropT[c.id] > 0.15) {
        S.dropUp[c.id] = 0;
        emit(S, 'drop', c.id, c.ax + 18, c.ay, imp);
        if (S.sim && !S.dropUp[0] && !S.dropUp[1] && !S.dropUp[2] && !S.dropUp[3]) S.rew += 50 * S.mult;
      }
      break;
    case 'post':
      if (imp > 150) emit(S, 'post', 0, px, py, imp);
      break;
  }
}
function collideFlip(S, i, h) {
  const F = FLIPS[i], a = S.fa[i];
  const c = Math.cos(a), sn = Math.sin(a);
  const dx = F.s * c, dy = sn;
  let t = (S.x - F.px) * dx + (S.y - F.py) * dy;
  t = t < 0 ? 0 : t > FL_LEN ? FL_LEN : t;
  const px = F.px + dx * t, py = F.py + dy * t;
  const rad = FL_R0 + (FL_R1 - FL_R0) * (t / FL_LEN);
  let nx = S.x - px, ny = S.y - py;
  const rr = BR + rad;
  const d2 = nx * nx + ny * ny;
  if (d2 >= rr * rr) return;
  let d = Math.sqrt(d2);
  if (d < 1e-5) { nx = dy; ny = -dx; d = 0; } else { nx /= d; ny /= d; }
  const pen = rr - d;
  S.x += nx * (pen + 0.001); S.y += ny * (pen + 0.001);
  const w = S.fw[i];
  const svx = w * t * (-F.s * sn), svy = w * t * c;
  const rvx = S.vx - svx, rvy = S.vy - svy;
  const vn = rvx * nx + rvy * ny;
  if (vn >= 0) return;
  const e = -vn < 60 ? 0 : 0.2;
  S.vx -= (1 + e) * vn * nx; S.vy -= (1 + e) * vn * ny;
}
function stepSub(S, h) {
  updateFlippers(S, h);
  for (let i = 0; i < 4; i++) if (S.dropT[i] > 0) S.dropT[i] = Math.max(0, S.dropT[i] - h * 0.5);
  S.ly = S.y;
  S.vy += GRAV * h;
  S.x += S.vx * h; S.y += S.vy * h;
  for (let pass = 0; pass < 2; pass++) {
    for (let i = 0; i < CAPS.length; i++) collideCap(S, CAPS[i], h);
    collideFlip(S, 0, h); collideFlip(S, 1, h);
  }
  const sp2 = S.vx * S.vx + S.vy * S.vy;
  if (sp2 > VMAX * VMAX) { const k = VMAX / Math.sqrt(sp2); S.vx *= k; S.vy *= k; }
  // top lane rollovers
  if (S.ly < 100 && S.y >= 100 && S.y < 140) {
    for (let i = 0; i < 2; i++) {
      if (Math.abs(S.x - LANE_C[i]) < 26 && !S.lane[i]) {
        S.lane[i] = 1;
        emit(S, 'lane', i, LANE_C[i], 100, 0);
        if (S.lane[0] && S.lane[1]) { S.lane[0] = 0; S.lane[1] = 0; emit(S, 'lanes', 0, 282, 100, 0); }
      }
    }
  }
  // orbit
  if (S.x < 64 && S.y > 330 && S.y < 500 && S.vy < -200) S.orb = 1;
  else if (S.orb === 1) {
    if (S.y < 300 && S.x < 72) { S.orb = 0; emit(S, 'orbit', 0, S.x, S.y, 0); }
    else if (S.x > 76 || S.y > 560) S.orb = 0;
  }
  if (S.y > 995) S.drained = true;
  if (S.crossT < 0 && S.ly < 790 && S.y >= 790 && S.vy > 0) { S.crossX = S.x; S.crossT = 0; }
}

// ---------------------------------------------------------------------------
// AI ("Brain").
// What it can see (the observe() snapshot): the ball's on-screen position, the
// angles of both flippers, which drop targets are standing, which top lanes are
// lit, the multiplier and the plunger pull. Hidden: nothing is provided beyond
// that — ball velocity is estimated from the last two observed positions, and the
// AI works from a snapshot that is LAG ticks old (reaction latency, 50 ms).
// It acts ONLY through the two flipper buttons and the plunger button. To choose
// when to press it simulates the (known) table physics a short horizon ahead for a
// set of candidate button plans and picks the plan with the best expected result:
// scoring hits on lit targets / orbit / bumpers, ball height, avoiding the drain.
// Plans include early/late flips (aiming), and holding a flipper up to trap a slow
// ball and then releasing/re-flipping for a deliberate shot.
// ---------------------------------------------------------------------------
const LAG = 3;
class Brain {
  constructor() {
    this.hist = []; this.btn = [];
    this.cur = [0, 0]; this.held = [0, 0]; this.pend = [null, null];
    this.tick = 0; this.planAt = 0;
    this.plungeWait = 0; this.plungeOn = false; this.plungeFor = 0; this.plungeT = 0;
    this.costMs = 0; this.plans = 0;
    // Styles (same visible info, different priorities): Trapper holds/cradles the ball and
    // aims, Fast flipper hits on the fly, Orbit hunter values the orbit and lanes highly.
    this.style = ['Trapper', 'Fast flipper', 'Orbit hunter'][Math.floor(Math.random() * 3)];
    this.sv = Object.assign({}, SIMV);
    if (this.style === 'Orbit hunter') { this.sv.orbit = (SIMV.orbit || 0) * 3; this.sv.lane = (SIMV.lane || 0) * 1.6; this.sv.lanes = (SIMV.lanes || 0) * 1.6; this.sv.bumper = (SIMV.bumper || 0) * 0.7; }
  }
  decide(obs) {
    this.tick++;
    const h = this.hist;
    h.push({ ball: obs.ball ? { x: obs.ball.x, y: obs.ball.y } : null, fa: obs.fa.slice() });
    if (h.length > 14) { h.shift(); this.btn.shift(); }
    const out = { L: 0, R: 0, plunger: false };
    const b = obs.ball;
    if (!b) {
      this.cur = [0, 0]; this.pend = [null, null]; this.plungeWait = 0; this.plungeOn = false;
    } else {
      const prev = h.length > 1 ? h[h.length - 2].ball : null;
      const sp = prev ? Math.hypot(b.x - prev.x, b.y - prev.y) * 60 : 0;
      const inLane = b.x > 548 && b.y > 900;
      if (inLane) {
        this.cur = [0, 0]; this.pend = [null, null];
        if (sp < 60 && b.y > 940) {
          this.plungeWait += 1 / 60;
          if (!this.plungeOn && this.plungeWait > 0.7) { this.plungeOn = true; this.plungeT = 0; this.plungeFor = 0.5 + Math.random() * 0.35; }
          if (this.plungeOn) {
            this.plungeT += 1 / 60;
            if (this.plungeT < this.plungeFor) out.plunger = true; else { this.plungeOn = false; this.plungeWait = -0.8; }
          }
        }
      } else {
        this.plungeWait = 0; this.plungeOn = false;
        this._flippers(obs, b, h);
      }
    }
    for (let f = 0; f < 2; f++) { if (this.cur[f]) this.held[f]++; else this.held[f] = 0; }
    out.L = this.cur[0]; out.R = this.cur[1];
    this.btn.push([this.cur[0], this.cur[1]]);
    return out;
  }
  _flippers(obs, b, h) {
    const n = h.length, m = n - 1 - LAG;
    // execute scheduled toggles
    for (let f = 0; f < 2; f++) {
      const p = this.pend[f];
      if (p && this.tick >= p.at) { this.cur[f] = p.to; this.pend[f] = null; if (p.to) this.held[f] = 0; }
    }
    if (m < 1 || !h[m].ball || !h[m - 1].ball) return;
    // estimated present ball position (for coarse gating only)
    const A = h[m], B = h[m - 1];
    const gate = b.y;
    // long-held flipper: let go
    for (let f = 0; f < 2; f++) if (this.cur[f] && this.held[f] > 150) { this.cur[f] = 0; this.pend[f] = null; }
    if (this.tick < this.planAt) return;
    const lowFast = gate > 480;
    if (!lowFast && !this.cur[0] && !this.cur[1]) { this.planAt = this.tick + 2; return; }
    if (gate < 600 && !(gate > 480 && b.y - h[n - 2].ball?.y > 8)) {
      // far from flippers: release and wait
      for (let f = 0; f < 2; f++) if (this.cur[f]) { this.cur[f] = 0; this.pend[f] = null; }
      this.planAt = this.tick + 2; return;
    }
    const t0 = performance.now();
    this._plan(A, B, m, n);
    this.costMs += performance.now() - t0; this.plans++;
    this.planAt = this.tick + (gate > 740 ? 2 : 3);
  }
  _plan(A, B, m, n) {
    const hist = this.hist;
    const S = newState(); S.sim = true; S.ev = null; S.sv = this.sv; S.mult = this.mult || 1;
    S.x = A.ball.x; S.y = A.ball.y;
    S.vx = (A.ball.x - B.ball.x) * 60;
    S.vy = (A.ball.y - B.ball.y) * 60 + GRAV / 120;
    S.ly = S.y - S.vy / 60;
    S.fa = [A.fa[0], A.fa[1]];
    S.fw = [(A.fa[0] - B.fa[0]) * 60, (A.fa[1] - B.fa[1]) * 60];
    S.dropUp = this.dropUp.slice(); S.lane = this.lane.slice();
    // fast-forward LAG ticks using our own recorded button presses
    for (let k = m; k < n - 1; k++) {
      const bb = this.btn[k] || [0, 0];
      S.fp[0] = bb[0]; S.fp[1] = bb[1];
      simTick(S);
      if (S.drained) break;
    }
    if (S.drained) { return; }
    S.fp[0] = this.cur[0]; S.fp[1] = this.cur[1];
    // baseline: where does the ball go if nothing changes?
    const base = cloneState(S);
    let crossed = S.y >= 790;
    let cx = S.x;
    for (let k = 0; k < 75 && !base.drained; k++) {
      simTick(base);
      if (base.crossT >= 0) { crossed = true; cx = base.crossX; break; }
    }
    if (base.drained) { crossed = true; cx = base.x; }
    const sp = Math.hypot(S.vx, S.vy);
    for (let f = 0; f < 2; f++) {
      const rel = f === 0 ? (cx < 345 || S.x < 300) : (cx > 220 || S.x > 265);
      const near = this._near(S, f);
      if (!crossed && !near && !this.cur[f]) continue;
      if (!rel && !this.cur[f]) continue;
      this._planFlipper(S, f, sp, near);
    }
  }
  _near(S, f) {
    const F = FLIPS[f];
    const a = this.cur[f] ? UP_A : REST_A;
    const dx = F.s * Math.cos(a), dy = Math.sin(a);
    let t = (S.x - F.px) * dx + (S.y - F.py) * dy; t = clampv(t, 0, FL_LEN);
    const px = F.px + dx * t, py = F.py + dy * t;
    return S.y > 760 && Math.hypot(S.x - px, S.y - py) < 75;
  }
  _planFlipper(S, f, speed, near) {
    const s0 = this.cur[f];
    let cands = [];
    if (!s0) {
      for (let d = 26; d >= 0; d -= 2) cands.push({ tog: [d], tail: true });
      if (this.style === 'Trapper' ? speed < 1000 : this.style !== 'Fast flipper' && speed < 700) for (const c of [12, 8, 4, 0]) cands.push({ tog: [c], tail: false, catchPlan: true });
    } else {
      if (!near && this.held[f] > 8) { this.cur[f] = 0; this.pend[f] = null; return; }
      if (this.held[f] <= 8) return;
      for (const r of [30, 20, 15, 10, 6, 3, 0]) cands.push({ tog: [r], tail: false });
      for (const r of [4, 0]) for (const g of [28, 24, 20, 17, 14, 12, 10, 8, 6, 4, 2]) cands.push({ tog: [r, r + g], tail: true });
    }
    const evalPlan = c => {
      const T = cloneState(S);
      const last = c.tog.length ? c.tog[c.tog.length - 1] : 0;
      const hor = Math.min(130, Math.max(60, last + 48));
      let ti = 0, tl = -99;
      for (let k = 0; k < hor; k++) {
        while (ti < c.tog.length && c.tog[ti] <= k) { T.fp[f] ^= 1; tl = k; ti++; }
        if (c.tail && ti === c.tog.length && T.fp[f] === 1 && k >= tl + 13) T.fp[f] = 0;
        simTick(T);
        if (T.drained) { T.rew -= 60 + (hor - k) * 0.05; return T.rew; }
      }
      return T.rew + (880 - T.y) / 70;
    };
    let best = { tog: [], tail: false }, bestR = evalPlan(best);
    let bestCand = null;
    for (const c of cands) {
      const r = evalPlan(c) + (this.style === 'Trapper' && c.catchPlan ? 0.6 : 0) + Math.random() * 0.12;
      if (r > bestR + 0.25) { best = c; bestR = r; bestCand = c; }
    }
    // refine odd delays around the best single flip
    if (bestCand && !s0 && bestCand.tail && bestCand.tog.length === 1) {
      const d0 = bestCand.tog[0];
      for (const d of [d0 + 1, d0 - 1]) {
        if (d < 0) continue;
        const c = { tog: [d], tail: true };
        const r = evalPlan(c);
        if (r > bestR + 0.05) { best = c; bestR = r; }
      }
    }
    if (best.tog.length) {
      this.pend[f] = { at: this.tick + best.tog[0], to: s0 ? 0 : 1 };
      if (best.tog[0] <= 0) { this.cur[f] = s0 ? 0 : 1; this.pend[f] = null; if (this.cur[f]) this.held[f] = 0; }
    } else {
      this.pend[f] = null;
    }
  }
}
function simTick(S) {
  const sp = Math.sqrt(S.vx * S.vx + S.vy * S.vy);
  const n = sp > 1500 ? 6 : sp > 1100 ? 5 : sp > 700 ? 4 : sp > 350 ? 3 : 2;
  const h = 1 / 60 / n;
  for (let i = 0; i < n; i++) { stepSub(S, h); if (S.drained) break; }
}

// ---------------------------------------------------------------------------
// Art helpers
// ---------------------------------------------------------------------------
function mulberry(a) { return function () { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
function mkCanvas(w, h) { const c = document.createElement('canvas'); c.width = Math.max(2, Math.ceil(w)); c.height = Math.max(2, Math.ceil(h)); return c; }
function tablePath(g) {
  g.beginPath(); g.moveTo(20, 1000); g.lineTo(20, 300); g.arc(300, 300, 280, Math.PI, Math.PI * 2, false); g.lineTo(580, 1000); g.closePath();
}
let GLOWS = null;
function glowSprite(kind) {
  if (!GLOWS) {
    GLOWS = {};
    const mk = (r, g, b) => {
      const c = mkCanvas(96, 96), x = c.getContext('2d');
      const gr = x.createRadialGradient(48, 48, 0, 48, 48, 48);
      gr.addColorStop(0, `rgba(${r},${g},${b},1)`); gr.addColorStop(0.25, `rgba(${r},${g},${b},0.55)`);
      gr.addColorStop(0.6, `rgba(${r},${g},${b},0.14)`); gr.addColorStop(1, `rgba(${r},${g},${b},0)`);
      x.fillStyle = gr; x.fillRect(0, 0, 96, 96); return c;
    };
    GLOWS.amber = mk(255, 176, 70); GLOWS.copper = mk(240, 140, 80); GLOWS.white = mk(255, 240, 210);
    GLOWS.nixie = mk(255, 120, 40); GLOWS.red = mk(255, 90, 60);
  }
  return GLOWS[kind];
}
function glow(g, kind, x, y, r, a) {
  g.globalAlpha = a; g.drawImage(glowSprite(kind), x - r, y - r, r * 2, r * 2); g.globalAlpha = 1;
}
function makeGear(teeth, rp, k) {
  const R = rp + 8, size = R * 2 * k;
  const c = mkCanvas(size, size), g = c.getContext('2d');
  g.scale(k, k); g.translate(R, R);
  g.beginPath();
  const rt = rp + 5, rr = rp - 5;
  for (let i = 0; i < teeth; i++) {
    const a = TAU2 * i / teeth, hr = Math.PI / teeth * 0.58, ht = Math.PI / teeth * 0.30;
    const pts = [[a - hr, rr], [a - ht, rt], [a + ht, rt], [a + hr, rr]];
    pts.forEach((p, j) => { const x = Math.cos(p[0]) * p[1], y = Math.sin(p[0]) * p[1]; if (i === 0 && j === 0) g.moveTo(x, y); else g.lineTo(x, y); });
  }
  g.closePath();
  // spoke windows
  const spokes = 6, r1 = rp * 0.28, r2 = rp * 0.76;
  for (let i = 0; i < spokes; i++) {
    const a0 = TAU2 * i / spokes + 0.12, a1 = TAU2 * (i + 1) / spokes - 0.12;
    g.moveTo(Math.cos(a0) * r2, Math.sin(a0) * r2);
    g.arc(0, 0, r2, a0, a1, false); g.lineTo(Math.cos(a1) * r1, Math.sin(a1) * r1);
    g.arc(0, 0, r1, a1, a0, true); g.closePath();
  }
  g.moveTo(rp * 0.1, 0); g.arc(0, 0, rp * 0.1, 0, TAU2, true);
  g.fillStyle = '#c99a48'; g.fill('evenodd');
  g.strokeStyle = '#f0d58a'; g.lineWidth = 1.2; g.stroke();
  return c;
}
// gear chains in table space: {x,y,t,rp,w(rad/s),phase}
function buildGearChain(defs) {
  const out = [];
  defs.forEach((d, i) => {
    if (!d.parent && d.parent !== 0) { out.push({ x: d.x, y: d.y, t: d.t, rp: d.t * 5, w: d.w, phase: d.phase || 0, dir: 1 }); return; }
    const p = out[d.parent], rp = d.t * 5, al = d.ang;
    const dist = p.rp + rp;
    out.push({
      x: p.x + Math.cos(al) * dist, y: p.y + Math.sin(al) * dist, t: d.t, rp,
      w: -p.w * p.t / d.t, phase: al + Math.PI - Math.PI / d.t + (p.phase - al) * 0 + 0, dir: -p.dir, pa: al, pp: p.phase,
    });
    // phase relation: parent has a tooth at angle al at t=0 only if parent phase aligns; compute from parent's phase
    const g = out[out.length - 1];
    // parent tooth positions: pp + k*2pi/pt. Choose rotation so tooth/gap meshes along line (al).
    const pt = p.t;
    const kk = Math.round((al - p.phase) / (TAU2 / pt));
    const toothAng = p.phase + kk * TAU2 / pt;   // nearest parent tooth to the line
    const dev = al - toothAng;                   // angular offset of parent tooth from the line
    // child gap must be at angle al+pi, displaced by -dev*(pt/ct) in the reversed-rotation sense
    g.phase = al + Math.PI - Math.PI / d.t + dev * pt / d.t;
    void i;
  });
  return out;
}
const TABLE_GEARS = buildGearChain([
  { x: 95, y: 470, t: 20, w: 0.11, phase: 0 },
  { parent: 0, t: 12, ang: -0.55 },
  { parent: 1, t: 26, ang: 0.45 },
  { x: 480, y: 800, t: 30, w: -0.07, phase: 0.3 },
  { parent: 3, t: 14, ang: -2.1 },
  { x: 300, y: 130, t: 16, w: 0.12, phase: 0 },
]);

// ---------------------------------------------------------------------------
// The game
// ---------------------------------------------------------------------------
class Pinball {
  constructor() {
    this.W = 1600; this.H = 900; this.sc = 1; this.ox = 0; this.oy = 0; this.dpr = 1;
    this.t = 0; this.tick = 0;
    this.over = false; this.won = false; this.endT = 0; this.endMsg = '';
    this.S = newState();
    this.brain = new Brain(); this.style = this.brain.style;
    this.score = 0; this.disp = 0; this.mult = 1; this.balls = 3; this.ballNo = 1;
    this.phase = 'serve'; this.phaseT = 0; this.charge = 0; this.charging = false; this.pull = 0; this.plKick = 0;
    this.lane = [0, 0]; this.laneFlash = 0; this.dropAnim = [1, 1, 1, 1]; this.bankT = -1; this.bankFlash = 0;
    this.bump = BUMPER_POS.map(() => ({ flash: 0, rings: [] }));
    this.sling = [{ flash: 0 }, { flash: 0 }];
    this.orbitFlash = 0; this.orbitCount = 0;
    this.pops = []; this.parts = new Particles(); this.trail = []; this.rot = 0;
    this.shx = 0; this.shy = 0; this.shvx = 0; this.shvy = 0;
    this.stuckT = 0; this.anchor = { x: 0, y: 0 }; this.lastProg = 0;
    this.lamps = Array.from({ length: 24 }, () => Math.random() * 10);
    this.drainMsg = 0; this.lastDrainY = 0; this.fw = [0, 0];
    this.dimmer = 1; this.fireT = 0; this.maxSpeed = 0; this.nudges = 0; this.totalBumps = 0;
    this.cache = null;
  }

  // ----- layout & caches -----
  resize(W, H) {
    this.W = W; this.H = H;
    this.dpr = Math.min(2, (typeof window !== 'undefined' && window.devicePixelRatio) || 1);
    this.sc = Math.min(H * 0.94 / 1040, W * 0.92 / 640);
    this.ox = W / 2 - 300 * this.sc; this.oy = H / 2 - 520 * this.sc;
    this.cache = null;
  }
  buildCaches() {
    const { W, H, sc, dpr } = this;
    const k = sc * dpr;
    const c = {};
    // background
    c.bg = mkCanvas(W * dpr, H * dpr);
    {
      const g = c.bg.getContext('2d'); g.scale(dpr, dpr);
      g.fillStyle = '#0d0906'; g.fillRect(0, 0, W, H);
      const rg = g.createRadialGradient(W / 2, H * 0.45, 0, W / 2, H * 0.45, Math.max(W, H) * 0.75);
      rg.addColorStop(0, '#2a1d12'); rg.addColorStop(0.55, '#150e09'); rg.addColorStop(1, '#070504');
      g.fillStyle = rg; g.fillRect(0, 0, W, H);
      const rnd = mulberry(77);
      for (let i = 0; i < 220; i++) {
        const y = rnd() * H, x = rnd() * W, len = 60 + rnd() * 400;
        g.strokeStyle = rnd() < 0.5 ? 'rgba(90,62,36,0.07)' : 'rgba(0,0,0,0.18)';
        g.lineWidth = 0.6 + rnd() * 1.6;
        g.beginPath(); g.moveTo(x, y); g.bezierCurveTo(x + len * 0.3, y + (rnd() - 0.5) * 6, x + len * 0.7, y + (rnd() - 0.5) * 6, x + len, y + (rnd() - 0.5) * 3); g.stroke();
      }
      // table shadow
      g.save(); g.translate(this.ox, this.oy); g.scale(sc, sc);
      g.shadowColor = 'rgba(0,0,0,0.75)'; g.shadowBlur = 50 * sc; g.shadowOffsetY = 14 * sc;
      tablePath(g); g.fillStyle = '#000'; g.fill();
      g.restore();
    }
    // background gears (screen space)
    c.bgGears = [];
    const defs = [[0.09, 0.80, 0.30, 26, 0.018], [0.90, 0.22, 0.24, 22, -0.022], [0.88, 0.88, 0.17, 16, 0.03], [0.14, 0.14, 0.14, 14, -0.03]];
    for (const [fx, fy, hh, t, w] of defs) {
      const rp = H * hh;
      const sprK = Math.min(1, 700 / (2 * (rp + 8)));
      c.bgGears.push({ spr: makeGearPx(t, rp, sprK * 1), x: W * fx, y: H * fy, rp, w, ph: fx * 7 });
    }
    // table gears
    c.gears = TABLE_GEARS.map(g => ({ g, spr: makeGear(g.t, g.rp, k) }));
    // board
    const bw = (TW + 40) * k, bh = (TH + 60) * k;
    c.board = mkCanvas(bw, bh); c.over = mkCanvas(bw, bh);
    buildBoard(c.board.getContext('2d'), k);
    buildOverlay(c.over.getContext('2d'), k);
    this.cache = c;
  }

  // ----- AI observation: only what a player sees -----
  observe() {
    const S = this.S;
    const vis = this.phase !== 'drain' && !S.drained;
    return {
      ball: vis ? { x: S.x, y: S.y } : null,
      fa: S.fa.slice(), dropUp: S.dropUp.slice(), lane: this.lane.slice(), mult: this.mult, charge: this.charge,
    };
  }

  // ----- game logic -----
  _ipg() { return [[[this.S], ['x', 'y'], 120], [[this.S.fa], [0, 1], 2]]; }
  step(dt) {
    IP.snap(this._ipg());
    this.tick++; this.t += dt;
    this.visuals(dt);
    if (this.over) { this.endStep(dt); return; }
    if (this.t > MAX_TIME) { this.finish(false, 'Out of time'); return; }
    const S = this.S;
    const obs = this.observe();
    this.brain.mult = this.mult; this.brain.dropUp = S.dropUp; this.brain.lane = this.lane;
    const act = this.brain.decide(obs);
    S.fp[0] = act.L ? 1 : 0; S.fp[1] = act.R ? 1 : 0;
    S.mult = this.mult;
    const h = dt / SUBS;
    this.phaseT += dt;
    if (this.phase === 'drain') {
      for (let i = 0; i < SUBS; i++) updateFlippers(S, h);
      if (this.phaseT > 1.9) {
        if (this.balls <= 0) { this.finish(false, `Drained all balls with ${fmt(this.score)} points`); return; }
        this.newBall();
      }
      return;
    }
    const resting = S.x > 548 && S.y > REST_Y - 4 && Math.hypot(S.vx, S.vy) < 80;
    if (resting && (act.plunger || (this.phase === 'serve' && this.phaseT > 9))) {
      this.charge = Math.min(1, this.charge + dt / (act.plunger ? 0.9 : 0.6));
      this.charging = true;
    } else if (this.charging) {
      if (this.charge > 0.12 && resting) this.launch();
      this.charging = false; this.charge = 0;
    }
    if (this.charging) {
      S.y = REST_Y + this.charge * 26; S.vx = 0; S.vy = 0;
      for (let i = 0; i < SUBS; i++) updateFlippers(S, h);
    } else {
      S.ev.length = 0;
      for (let i = 0; i < SUBS; i++) { stepSub(S, h); if (S.drained) break; }
      for (const e of S.ev) this.onEvent(e);
      const sp = Math.hypot(S.vx, S.vy); if (sp > this.maxSpeed) this.maxSpeed = sp;
    }
    // sanity: ball out of bounds / NaN
    if (!(S.x > 0 && S.x < TW && S.y > -40 && S.y < 1100)) {
      if (S.y >= 1000) S.drained = true; else this.respawnTop();
    }
    if (S.drained) { this.onDrain(); return; }
    // stuck-ball nudge
    if (this.phase === 'play' && !resting) {
      const d = Math.hypot(S.x - this.anchor.x, S.y - this.anchor.y);
      if (d > 45) { this.anchor.x = S.x; this.anchor.y = S.y; this.stuckT = 0; } else this.stuckT += dt;
      if (this.t - this.lastProg > 14) { this.stuckT = 6; this.lastProg = this.t; }
      if (this.stuckT > 5) {
        S.vy -= 420; S.vx += rnd.float(-260, 260); this.stuckT = 0; this.anchor.x = S.x; this.anchor.y = S.y;
        this.nudges++; this.shvx += rnd.float(-60, 60); this.shvy += 70;
      }
    } else { this.stuckT = 0; this.anchor.x = S.x; this.anchor.y = S.y; }
    // bank reset
    if (this.bankT >= 0) {
      this.bankT -= dt;
      if (this.bankT < 0) { S.dropUp = [1, 1, 1, 1]; this.bankT = -1; this.parts.burst(282, DROP_Y, 20, { color: ['#f0d58a', '#c9a24b'], speed: 160, life: 0.8, size: 3, gravity: 200 }); }
    }
    // trail
    this.trail.push(S.x, S.y); if (this.trail.length > 14) this.trail.splice(0, 2);
    const sp = Math.hypot(S.vx, S.vy);
    this.rot += (sp * dt / BR) * (S.vx >= 0 ? 1 : -1) * 0.6;
    if (this.score >= GOAL) this.finish(true, `Reached ${fmt(this.score)} points on ball ${this.ballNo}`);
  }
  launch() {
    const S = this.S; this.lastProg = this.t;
    S.y = REST_Y; S.vx = rnd.float(-12, 12);
    S.vy = -(1290 + 150 * this.charge + rnd.float(-25, 25));
    this.phase = 'play'; this.phaseT = 0; this.plKick = 1; this.shvy += 60;
    this.stuckT = 0; this.anchor.x = S.x; this.anchor.y = S.y;
    this.parts.burst(LANE_X, 960, 14, { color: ['#f0d58a', '#fff3c8'], speed: 220, life: 0.5, size: 2.4, angle: Math.PI / 2, spread: 0.5, gravity: 300 });
  }
  respawnTop() {
    const S = this.S; S.x = 300; S.y = 120; S.vx = rnd.float(-60, 60); S.vy = 100;
  }
  newBall() {
    const S = this.S;
    S.x = LANE_X; S.y = REST_Y; S.vx = 0; S.vy = 0; S.ly = S.y; S.drained = false; S.orb = 0;
    S.fa = [REST_A, REST_A]; S.fw = [0, 0];
    this.phase = 'serve'; this.phaseT = 0; this.charge = 0; this.charging = false; this.trail.length = 0;
    this.ballNo = Math.min(3, 4 - this.balls); this.brain.plungeWait = -0.3;
  }
  onDrain() {
    this.balls--; this.phase = 'drain'; this.phaseT = 0; this.drainMsg = 1; this.trail.length = 0;
    this.shvy += 90;
    this.parts.burst(clampv(this.S.x, 40, 540), 985, 16, { color: ['#c9a24b', '#7a5a22'], speed: 120, life: 0.7, size: 2.5, angle: -Math.PI / 2, spread: 0.9, gravity: 400 });
  }
  addScore(base, x, y, label) {
    const v = base * this.mult;
    this.score += v;
    this.pops.push({ x, y, txt: '+' + fmt(v), t: 0, big: base >= 2500, label });
    if (this.pops.length > 24) this.pops.shift();
  }
  onEvent(e) {
    const S = this.S;
    if (e.k !== 'sling' && e.k !== 'post') this.lastProg = this.t;
    switch (e.k) {
      case 'bumper': {
        const b = this.bump[e.i]; b.flash = 1; b.rings.push(0); if (b.rings.length > 4) b.rings.shift();
        this.addScore(PTS.bumper, e.x + rnd.float(-12, 12), e.y - 30);
        this.parts.burst(e.x, e.y, 10, { color: ['#ffb070', '#f0d58a', '#e8854a'], speed: 260, speedMin: 90, life: 0.55, size: 2.8, gravity: 300 });
        this.shvx += rnd.float(-25, 25); this.shvy += rnd.float(-25, 25); this.totalBumps++;
        break;
      }
      case 'sling':
        this.sling[e.i].flash = 1; this.addScore(PTS.sling, e.x, e.y - 14);
        this.parts.burst(e.x, e.y, 6, { color: ['#f0d58a', '#ffffff'], speed: 200, life: 0.4, size: 2, gravity: 200 });
        break;
      case 'drop': {
        this.addScore(PTS.drop, e.x - 18, e.y - 20);
        this.parts.burst(e.x - 18, e.y, 10, { color: ['#f0d58a', '#c9a24b'], speed: 190, life: 0.6, size: 2.4, gravity: 300 });
        if (!S.dropUp[0] && !S.dropUp[1] && !S.dropUp[2] && !S.dropUp[3] && this.bankT < 0) {
          this.addScore(PTS.bank, 282, 440);
          this.mult = Math.min(5, this.mult + 1); this.bankT = 1.1; this.bankFlash = 1.2;
          this.parts.burst(282, 470, 40, { color: ['#ffd98a', '#ffb070', '#fff3c8'], speed: 380, life: 1, size: 3.4, gravity: 260 });
        }
        break;
      }
      case 'lane':
        this.lane[e.i] = 1; this.addScore(PTS.lane, LANE_C[e.i], 118);
        this.parts.burst(LANE_C[e.i], 100, 8, { color: ['#ffd98a', '#fff3c8'], speed: 140, life: 0.5, size: 2.2, gravity: 100 });
        break;
      case 'lanes':
        this.addScore(PTS.lanes, 282, 135); this.laneFlash = 1.4;
        this.parts.burst(282, 100, 30, { color: ['#ffd98a', '#fff3c8', '#ffb070'], speed: 280, life: 0.9, size: 3, gravity: 200 });
        break;
      case 'orbit':
        this.addScore(PTS.orbit, 60, 290); this.orbitFlash = 1.4; this.orbitCount++;
        this.parts.burst(50, 280, 26, { color: ['#ffd98a', '#e8854a'], speed: 300, life: 0.9, size: 3, gravity: 250 });
        break;
    }
  }
  finish(won, msg) {
    if (this.over) return;
    this.over = true; this.won = won; this.endMsg = msg; this.endT = 0;
    this.trail.length = 0;
  }
  endStep(dt) {
    this.endT += dt;
    if (this.won) {
      this.fireT -= dt;
      if (this.fireT <= 0) {
        this.fireT = rnd.float(0.12, 0.3);
        const x = rnd.float(60, 520), y = rnd.float(120, 700);
        this.parts.burst(x, y, 36, { color: ['#ffd98a', '#ffb070', '#fff3c8', '#e8854a'], speed: 330, life: 1.3, size: 3.2, gravity: 160 });
      }
    } else this.dimmer = Math.max(0.28, this.dimmer - dt * 0.5);
  }
  visuals(dt) {
    this.parts.update(dt);
    this.disp += (this.score - this.disp) * Math.min(1, dt * 9);
    if (Math.abs(this.score - this.disp) < 1) this.disp = this.score;
    for (const b of this.bump) { b.flash = Math.max(0, b.flash - dt * 4.5); b.rings = b.rings.map(a => a + dt * 2.2).filter(a => a < 1); }
    for (const s of this.sling) s.flash = Math.max(0, s.flash - dt * 6);
    for (let i = 0; i < 4; i++) {
      const tgt = this.S.dropUp[i] ? 1 : 0;
      this.dropAnim[i] += clampv(tgt - this.dropAnim[i], -dt * 9, dt * 3.2);
    }
    this.laneFlash = Math.max(0, this.laneFlash - dt);
    if (this.laneFlash === 0 && this.lane[0] && this.lane[1]) { this.lane = [0, 0]; }
    this.bankFlash = Math.max(0, this.bankFlash - dt); this.orbitFlash = Math.max(0, this.orbitFlash - dt);
    this.plKick = Math.max(0, this.plKick - dt * 5);
    this.pull += ((this.charging ? this.charge : 0) - this.pull) * Math.min(1, dt * (this.charging ? 10 : 40));
    this.drainMsg = Math.max(0, this.drainMsg - dt * 0.5);
    for (const p of this.pops) p.t += dt;
    this.pops = this.pops.filter(p => p.t < 1.1);
    // camera shake: damped spring
    this.shvx += (-this.shx * 180 - this.shvx * 12) * dt; this.shvy += (-this.shy * 180 - this.shvy * 12) * dt;
    this.shx += this.shvx * dt; this.shy += this.shvy * dt;
  }
  hud() {
    const pct = Math.min(100, Math.floor(this.score / GOAL * 100));
    return { score: fmt(this.score), detail: `Ball ${Math.min(3, this.ballNo)}/3 · x${this.mult} · ${pct}% to goal` };
  }
  result() {
    if (this.won) return this.endMsg + ' (' + this.brain.style + ')';
    return (this.endMsg || 'Game over') + ' (' + this.brain.style + ')';
  }

  // ----- drawing -----
  draw(ctx, W, H) {
    const a = IP.alpha();
    const st = IP.push(this._ipg(), a);
    try { this._draw(ctx, W, H); } finally { IP.pop(st); }
  }
  _draw(ctx, W, H) {
    if (W !== this.W || H !== this.H) this.resize(W, H);
    if (!this.cache) this.buildCaches();
    const c = this.cache, sc = this.sc, t = this.t;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.drawImage(c.bg, 0, 0, W, H);
    // background gears
    ctx.globalAlpha = 0.07;
    for (const bg of c.bgGears) {
      ctx.save(); ctx.translate(bg.x, bg.y); ctx.rotate(bg.ph + t * bg.w);
      const R = bg.rp + 8; ctx.drawImage(bg.spr, -R, -R, R * 2, R * 2); ctx.restore();
    }
    ctx.globalAlpha = 1;
    // warm ambient motes
    this.drawMotes(ctx, W, H, t);
    ctx.save();
    ctx.translate(this.ox + this.shx * sc, this.oy + this.shy * sc);
    ctx.scale(sc, sc);
    ctx.drawImage(c.board, -20, -20, TW + 40, TH + 60);
    // gears + clock under glass
    ctx.save(); tablePath(ctx); ctx.clip();
    ctx.globalAlpha = 0.12 * this.dimmer;
    for (const gg of c.gears) {
      const g = gg.g;
      ctx.save(); ctx.translate(g.x, g.y); ctx.rotate(g.phase + t * g.w);
      const R = g.rp + 8; ctx.drawImage(gg.spr, -R, -R, R * 2, R * 2); ctx.restore();
    }
    ctx.globalAlpha = 1;
    this.drawClockHands(ctx, t);
    ctx.restore();
    this.drawLamps(ctx, t);
    this.drawNixie(ctx, t);
    this.drawDrops(ctx);
    this.drawSlings(ctx);
    this.drawBumpers(ctx, t);
    this.drawPlungerLane(ctx);
    this.drawFlippers(ctx);
    this.drawBall(ctx);
    this.parts.draw(ctx, 1);
    ctx.drawImage(c.over, -20, -20, TW + 40, TH + 60);
    this.drawPlungerFront(ctx);
    // glass sheen
    ctx.save(); tablePath(ctx); ctx.clip();
    const sx = ((t * 40) % 1400) - 500;
    const sg = ctx.createLinearGradient(sx, 0, sx + 260, 520);
    sg.addColorStop(0, 'rgba(255,240,210,0)'); sg.addColorStop(0.5, 'rgba(255,240,210,0.045)'); sg.addColorStop(1, 'rgba(255,240,210,0)');
    ctx.fillStyle = sg; ctx.fillRect(0, 0, TW, TH);
    const sg2 = ctx.createLinearGradient(0, 0, 0, 500);
    sg2.addColorStop(0, 'rgba(255,235,200,0.05)'); sg2.addColorStop(1, 'rgba(255,235,200,0)');
    ctx.fillStyle = sg2; ctx.fillRect(0, 0, TW, 500);
    ctx.restore();
    this.drawPops(ctx);
    this.drawStatus(ctx);
    ctx.restore();
  }
  drawMotes(ctx, W, H, t) {
    ctx.save(); ctx.globalCompositeOperation = 'lighter';
    for (let i = 0; i < 18; i++) {
      const sx = (i * 977 % 1000) / 1000, sy = (i * 613 % 1000) / 1000;
      const x = ((sx * W + t * (6 + i % 5 * 3) + Math.sin(t * 0.3 + i) * 30) % (W + 40)) - 20;
      const y = ((sy * H - t * (4 + i % 4 * 2)) % H + H) % H;
      ctx.globalAlpha = 0.18 + 0.12 * Math.sin(t * 0.7 + i * 1.7);
      ctx.drawImage(glowSprite('amber'), x - 8, y - 8, 16, 16);
    }
    ctx.restore(); ctx.globalAlpha = 1;
  }
  drawClockHands(ctx, t) {
    const cx = 282, cy = 650;
    const hand = (ang, len, w, col) => {
      ctx.strokeStyle = col; ctx.lineWidth = w; ctx.lineCap = 'round';
      ctx.beginPath(); ctx.moveTo(cx - Math.cos(ang) * 8, cy - Math.sin(ang) * 8); ctx.lineTo(cx + Math.cos(ang) * len, cy + Math.sin(ang) * len); ctx.stroke();
    };
    ctx.globalAlpha = 0.5 * this.dimmer;
    hand(-Math.PI / 2 + t / 600 * TAU2 + 1.2, 34, 3, '#c9a24b');
    hand(-Math.PI / 2 + t / 30 * TAU2 + 0.4, 50, 2.2, '#e0bd6a');
    const sec = Math.floor(t) + Math.min(1, (t % 1) * 6) ;
    hand(-Math.PI / 2 + sec / 60 * TAU2, 54, 1, '#e8854a');
    ctx.fillStyle = '#c9a24b'; ctx.beginPath(); ctx.arc(cx, cy, 4, 0, TAU2); ctx.fill();
    ctx.globalAlpha = 1;
  }
  bulb(ctx, x, y, r, lit, kind, t, idx) {
    ctx.fillStyle = '#1d130b'; ctx.beginPath(); ctx.arc(x, y, r + 2.5, 0, TAU2); ctx.fill();
    ctx.strokeStyle = 'rgba(201,162,75,0.7)'; ctx.lineWidth = 1.2; ctx.beginPath(); ctx.arc(x, y, r + 2.5, 0, TAU2); ctx.stroke();
    const fl = lit > 0 ? lit * (0.9 + 0.1 * Math.sin(t * 13 + idx * 2.3)) * this.dimmer : 0;
    ctx.fillStyle = '#3a2512'; ctx.beginPath(); ctx.arc(x, y, r, 0, TAU2); ctx.fill();
    if (fl > 0.02) {
      ctx.save(); ctx.globalCompositeOperation = 'lighter';
      glow(ctx, kind, x, y, r * 4.2, fl * 0.9);
      ctx.restore();
      const g = ctx.createRadialGradient(x, y, 0, x, y, r);
      g.addColorStop(0, `rgba(255,248,215,${fl})`); g.addColorStop(0.5, `rgba(255,190,90,${fl})`); g.addColorStop(1, `rgba(200,100,30,${fl * 0.8})`);
      ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x, y, r, 0, TAU2); ctx.fill();
    }
    // filament
    ctx.strokeStyle = fl > 0.02 ? `rgba(255,255,230,${0.5 * fl + 0.2})` : 'rgba(120,80,40,0.55)'; ctx.lineWidth = 0.8;
    ctx.beginPath(); ctx.moveTo(x - r * 0.5, y + r * 0.2); ctx.lineTo(x - r * 0.2, y - r * 0.3); ctx.lineTo(x + r * 0.2, y + r * 0.3); ctx.lineTo(x + r * 0.5, y - r * 0.2); ctx.stroke();
  }
  drawLamps(ctx, t) {
    const S = this.S;
    let k = 0;
    // top lanes
    for (let i = 0; i < 2; i++) {
      const fl = this.laneFlash > 0 ? (Math.floor(t * 8) % 2 ? 1 : 0.25) : 0;
      this.bulb(ctx, LANE_C[i], 92, 6.5, this.lane[i] ? 1 : fl, 'amber', t, k++);
    }
    // multiplier lamps x2..x5
    for (let i = 0; i < 4; i++) {
      const lit = this.mult >= i + 2 ? 1 : 0;
      const flash = this.bankFlash > 0 && Math.floor(t * 10 + i) % 2 === 0 ? 0.9 : 0;
      this.bulb(ctx, 222 + i * 40, 238, 6, Math.max(lit, flash), 'copper', t, k++);
    }
    // drop target lamps (lit when the target is down)
    for (let i = 0; i < 4; i++) {
      const lit = 1 - this.dropAnim[i];
      this.bulb(ctx, DROP_X[i], 503, 5.5, lit, 'amber', t, k++);
    }
    // orbit lamps (chase)
    for (let i = 0; i < 3; i++) {
      const chase = this.orbitFlash > 0 ? (Math.floor(t * 12) % 3 === 2 - i ? 1 : 0.15) : 0;
      const base = Math.min(1, this.orbitCount / 3) * 0.55 + (this.orbitCount > i ? 0.4 : 0) * 0;
      this.bulb(ctx, 45, 470 - i * 55, 5.5, Math.max(chase, this.orbitCount > i ? 0.9 : base * 0.15), 'amber', t, k++);
    }
    // inlane ambient lamps (slow chase)
    for (let i = 0; i < 4; i++) {
      const x = i < 2 ? 72 : 493, y = 700 + (i % 2) * 24;
      const a = 0.12 + 0.55 * Math.max(0, Math.sin(t * 1.6 - i * 0.9));
      this.bulb(ctx, x, y, 4.8, a, 'amber', t, k++);
    }
  }
  drawNixie(ctx, t) {
    const digits = String(Math.floor(this.disp));
    const x0 = 282.5 - 3.5 * 34, cy = 168;
    ctx.font = '600 38px "IBM Plex Mono", ui-monospace, monospace';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    const n = 7;
    const str = digits.length > n ? digits.slice(-n) : digits;
    for (let i = 0; i < n; i++) {
      const di = i - (n - str.length);
      if (di < 0) continue;
      const cx = x0 + i * 34 + 17;
      const flick = 0.92 + 0.08 * Math.sin(t * 17 + i * 3.1) * Math.sin(t * 5.3 + i);
      const a = flick * this.dimmer * (this.over && this.won ? 0.75 + 0.25 * Math.sin(this.endT * 9) : 1);
      ctx.save(); ctx.globalCompositeOperation = 'lighter';
      glow(ctx, 'nixie', cx, cy, 34, 0.5 * a);
      ctx.restore();
      ctx.fillStyle = `rgba(255,128,48,${a})`;
      ctx.fillText(str[di], cx, cy + 1);
      ctx.fillStyle = `rgba(255,214,150,${0.45 * a})`;
      ctx.fillText(str[di], cx, cy + 1);
    }
    // goal progress
    const p = clampv(this.score / GOAL, 0, 1);
    const bx = 282.5 - 135, bw = 270, by = 201;
    ctx.fillStyle = 'rgba(0,0,0,0.5)'; ctx.fillRect(bx, by, bw, 5);
    const g = ctx.createLinearGradient(bx, 0, bx + bw, 0);
    g.addColorStop(0, '#7a5a22'); g.addColorStop(1, '#f0d58a');
    ctx.fillStyle = g; ctx.fillRect(bx, by, bw * p, 5);
    ctx.fillStyle = 'rgba(240,213,138,0.55)'; ctx.font = '500 9px Fredoka, sans-serif';
    ctx.textAlign = 'left'; ctx.fillText('GOAL ' + fmt(GOAL), bx, by + 13);
    ctx.textAlign = 'right'; ctx.fillText(`BALL ${Math.min(3, this.ballNo)}   x${this.mult}`, bx + bw, by + 13);
    ctx.textAlign = 'center';
  }
  drawDrops(ctx) {
    for (let i = 0; i < 4; i++) {
      const a = this.dropAnim[i], x = DROP_X[i], y = DROP_Y;
      // slot
      ctx.fillStyle = '#0c0805'; roundRect(ctx, x - 19, y - 5, 38, 10, 3); ctx.fill();
      if (a < 0.05) continue;
      const lift = a * 5;
      ctx.fillStyle = 'rgba(0,0,0,0.5)'; roundRect(ctx, x - 18, y - 4 + lift * 0.6, 36, 9, 3); ctx.fill();
      const g = ctx.createLinearGradient(0, y - 5 - lift, 0, y + 4);
      g.addColorStop(0, '#f2d98b'); g.addColorStop(0.5, '#c79a3e'); g.addColorStop(1, '#6b4a17');
      ctx.fillStyle = g; roundRect(ctx, x - 18, y - 5 - lift * 0.5, 36, 9 + lift * 0.4, 3); ctx.fill();
      ctx.strokeStyle = 'rgba(255,240,190,0.5)'; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(x - 14, y - 4 - lift * 0.5); ctx.lineTo(x + 14, y - 4 - lift * 0.5); ctx.stroke();
    }
  }
  drawSlings(ctx) {
    for (const s of SLINGS) {
      const fl = this.sling[s.side].flash;
      const [A, B, C] = s.pts;
      const ang = Math.atan2(C[1] - A[1], C[0] - A[0]);
      const nx = Math.sin(ang) * (s.side ? -1 : 1), ny = -Math.cos(ang) * (s.side ? -1 : 1);
      // outward normal of the face
      const fx = s.side ? -Math.abs(nx) : Math.abs(nx), fy = -Math.abs(ny);
      const push = fl * 4;
      ctx.beginPath(); ctx.moveTo(A[0], A[1]); ctx.lineTo(C[0], C[1]); ctx.lineTo(B[0], B[1]); ctx.closePath();
      const g = ctx.createLinearGradient(A[0], A[1], C[0], C[1]);
      g.addColorStop(0, '#5a2e18'); g.addColorStop(1, '#2a140a');
      ctx.fillStyle = g; ctx.fill();
      ctx.strokeStyle = '#a8742f'; ctx.lineWidth = 2; ctx.lineJoin = 'round'; ctx.stroke();
      // rubber band
      ctx.strokeStyle = '#17100b'; ctx.lineWidth = 5; ctx.lineCap = 'round';
      ctx.beginPath(); ctx.moveTo(A[0] + fx * (2 + push), A[1] + fy * (2 + push)); ctx.lineTo(C[0] + fx * (2 + push), C[1] + fy * (2 + push)); ctx.stroke();
      if (fl > 0.02) {
        ctx.save(); ctx.globalCompositeOperation = 'lighter';
        ctx.strokeStyle = `rgba(255,200,120,${fl * 0.9})`; ctx.lineWidth = 3;
        ctx.beginPath(); ctx.moveTo(A[0] + fx * 2, A[1] + fy * 2); ctx.lineTo(C[0] + fx * 2, C[1] + fy * 2); ctx.stroke();
        glow(ctx, 'amber', (A[0] + C[0]) / 2, (A[1] + C[1]) / 2, 50, fl * 0.6);
        ctx.restore();
      }
      // little gear emblem
      ctx.strokeStyle = 'rgba(240,213,138,0.4)'; ctx.lineWidth = 1;
      const mx = (A[0] + B[0] + C[0]) / 3, my = (A[1] + B[1] + C[1]) / 3;
      ctx.beginPath(); ctx.arc(mx, my, 7, 0, TAU2); ctx.stroke();
      for (let i = 0; i < 6; i++) { const a = i * TAU2 / 6 + this.t * 0.5; ctx.beginPath(); ctx.moveTo(mx + Math.cos(a) * 7, my + Math.sin(a) * 7); ctx.lineTo(mx + Math.cos(a) * 10, my + Math.sin(a) * 10); ctx.stroke(); }
    }
  }
  drawBumpers(ctx, t) {
    BUMPER_POS.forEach(([x, y], i) => {
      const b = this.bump[i], r = 26;
      // expanding rings
      for (const a of b.rings) {
        ctx.strokeStyle = `rgba(255,170,100,${(1 - a) * 0.55})`; ctx.lineWidth = 3 * (1 - a) + 0.6;
        ctx.beginPath(); ctx.arc(x, y, r + 6 + a * 62, 0, TAU2); ctx.stroke();
      }
      const s = 1 + 0.1 * b.flash;
      ctx.save(); ctx.translate(x, y); ctx.scale(s, s);
      ctx.fillStyle = 'rgba(0,0,0,0.5)'; ctx.beginPath(); ctx.arc(2, 4, r + 3, 0, TAU2); ctx.fill();
      ctx.fillStyle = '#1b0f08'; ctx.beginPath(); ctx.arc(0, 0, r + 4, 0, TAU2); ctx.fill();
      ctx.strokeStyle = '#a8742f'; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(0, 0, r + 3.5, 0, TAU2); ctx.stroke();
      const g = ctx.createRadialGradient(-8, -10, 2, 0, 0, r);
      g.addColorStop(0, b.flash > 0.3 ? '#fff0d0' : '#f2b27a'); g.addColorStop(0.45, '#c46c3c'); g.addColorStop(1, '#5c2a14');
      ctx.fillStyle = g; ctx.beginPath(); ctx.arc(0, 0, r, 0, TAU2); ctx.fill();
      // engraved ring + rivets
      ctx.strokeStyle = 'rgba(40,16,6,0.55)'; ctx.lineWidth = 1.3; ctx.beginPath(); ctx.arc(0, 0, r - 6, 0, TAU2); ctx.stroke();
      for (let k = 0; k < 8; k++) { const a = k * TAU2 / 8 + t * 0.3 * (i % 2 ? 1 : -1); ctx.fillStyle = 'rgba(255,225,170,0.6)'; ctx.beginPath(); ctx.arc(Math.cos(a) * (r - 6), Math.sin(a) * (r - 6), 1.5, 0, TAU2); ctx.fill(); }
      // brass cap
      const g2 = ctx.createRadialGradient(-3, -4, 1, 0, 0, 11);
      g2.addColorStop(0, '#fff3c8'); g2.addColorStop(0.5, '#d4a64a'); g2.addColorStop(1, '#6b4a17');
      ctx.fillStyle = g2; ctx.beginPath(); ctx.arc(0, 0, 11, 0, TAU2); ctx.fill();
      ctx.restore();
      if (b.flash > 0.02) {
        ctx.save(); ctx.globalCompositeOperation = 'lighter';
        glow(ctx, 'amber', x, y, 80, b.flash * 0.9);
        ctx.restore();
      }
    });
  }
  drawFlippers(ctx) {
    for (let i = 0; i < 2; i++) {
      const F = FLIPS[i], a = this.S.fa[i];
      const dx = F.s * Math.cos(a), dy = Math.sin(a);
      // shadow
      ctx.save(); ctx.translate(3, 5); flipperPath(ctx, F.px, F.py, a, F.s, FL_R0, FL_R1, FL_LEN); ctx.fillStyle = 'rgba(0,0,0,0.45)'; ctx.fill(); ctx.restore();
      flipperPath(ctx, F.px, F.py, a, F.s, FL_R0, FL_R1, FL_LEN); ctx.fillStyle = '#1d1510'; ctx.fill();
      flipperPath(ctx, F.px, F.py, a, F.s, FL_R0 - 3, FL_R1 - 2.2, FL_LEN);
      const nx = -dy, ny = dx;
      const g = ctx.createLinearGradient(F.px + nx * FL_R0, F.py + ny * FL_R0, F.px - nx * FL_R0, F.py - ny * FL_R0);
      g.addColorStop(0, '#f6e19a'); g.addColorStop(0.45, '#cf9f40'); g.addColorStop(1, '#6b4a17');
      ctx.fillStyle = g; ctx.fill();
      ctx.strokeStyle = 'rgba(255,248,215,0.4)'; ctx.lineWidth = 1.4; ctx.lineCap = 'round';
      const sgn = (i === 0) ? -1 : 1;
      ctx.beginPath(); ctx.moveTo(F.px + nx * 5 * sgn * -1 + dx * 14, F.py + ny * 5 * sgn * -1 + dy * 14); ctx.lineTo(F.px + nx * 3 * sgn * -1 + dx * (FL_LEN - 14), F.py + ny * 3 * sgn * -1 + dy * (FL_LEN - 14)); ctx.stroke();
      // pivot screw
      ctx.fillStyle = '#3d2a10'; ctx.beginPath(); ctx.arc(F.px, F.py, 5.5, 0, TAU2); ctx.fill();
      ctx.fillStyle = '#d9b25c'; ctx.beginPath(); ctx.arc(F.px, F.py, 4, 0, TAU2); ctx.fill();
      ctx.strokeStyle = '#5a3d12'; ctx.lineWidth = 1.2; ctx.beginPath(); ctx.moveTo(F.px - 3, F.py - 1.5); ctx.lineTo(F.px + 3, F.py + 1.5); ctx.stroke();
    }
  }
  drawBall(ctx) {
    const S = this.S;
    if (this.phase === 'drain' || S.drained || this.over && !this.won && this.endT > 0.1 && false) return;
    const tr = this.trail;
    if (tr.length > 4) {
      const sp = Math.hypot(S.vx, S.vy);
      const a0 = clampv((sp - 150) / 1000, 0, 1) * 0.4;
      ctx.save(); ctx.lineCap = 'round';
      const n = tr.length / 2;
      for (let i = 1; i < n; i++) {
        const f = i / n;
        ctx.strokeStyle = `rgba(200,215,230,${a0 * f * f})`; ctx.lineWidth = BR * 2 * f * 0.55;
        ctx.beginPath(); ctx.moveTo(tr[(i - 1) * 2], tr[(i - 1) * 2 + 1]); ctx.lineTo(tr[i * 2], tr[i * 2 + 1]); ctx.stroke();
      }
      ctx.restore();
    }
    drawSteelBall(ctx, S.x, S.y, this.rot, this.dimmer);
  }
  drawPlungerLane(ctx) {
    // groove highlight
    ctx.fillStyle = 'rgba(0,0,0,0.25)'; ctx.fillRect(548, 250, 29, 740);
  }
  drawPlungerFront(ctx) {
    const pull = this.pull * 26 - this.plKick * 7;
    const y = PLUNGER_Y + pull;
    // spring
    ctx.strokeStyle = '#8a8f96'; ctx.lineWidth = 2; ctx.beginPath();
    const top = y + 2, bot = 1030;
    const n = 9;
    for (let i = 0; i <= n; i++) { const yy = top + (bot - top) * i / n; const xx = LANE_X + (i % 2 ? 7 : -7); if (i === 0) ctx.moveTo(LANE_X, yy); else ctx.lineTo(xx, yy); }
    ctx.stroke();
    // head
    const g = ctx.createLinearGradient(LANE_X - 12, 0, LANE_X + 12, 0);
    g.addColorStop(0, '#6b4a17'); g.addColorStop(0.4, '#f2d98b'); g.addColorStop(1, '#6b4a17');
    ctx.fillStyle = g; roundRect(ctx, LANE_X - 12, y, 24, 7, 3); ctx.fill();
  }
  drawPops(ctx) {
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    for (const p of this.pops) {
      const a = p.t / 1.1, e = ease.outBack(Math.min(1, p.t * 5));
      ctx.globalAlpha = a < 0.6 ? 1 : 1 - (a - 0.6) / 0.4;
      ctx.font = `800 ${p.big ? 30 : 21}px "Big Shoulders Display", Impact, sans-serif`;
      const y = p.y - ease.outCubic(a) * 30, s = 0.6 + 0.4 * e;
      ctx.save(); ctx.translate(p.x, y); ctx.scale(s, s);
      ctx.lineWidth = 4; ctx.strokeStyle = 'rgba(20,10,4,0.8)'; ctx.strokeText(p.txt, 0, 0);
      ctx.fillStyle = p.big ? '#fff0b8' : '#f0d58a'; ctx.fillText(p.txt, 0, 0);
      ctx.restore();
    }
    ctx.globalAlpha = 1;
  }
  drawStatus(ctx) {
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    if (this.phase === 'drain' && !this.over) {
      const a = Math.min(1, this.phaseT * 3) * (this.phaseT > 1.5 ? 1 - (this.phaseT - 1.5) / 0.4 : 1);
      ctx.globalAlpha = Math.max(0, a);
      ctx.font = '800 54px "Big Shoulders Display", Impact, sans-serif';
      ctx.lineWidth = 6; ctx.strokeStyle = 'rgba(20,10,4,0.85)';
      const msg = this.balls > 0 ? 'BALL LOST' : 'LAST BALL LOST';
      ctx.strokeText(msg, 282, 560); ctx.fillStyle = '#e8b068'; ctx.fillText(msg, 282, 560);
      ctx.globalAlpha = 1;
    }
    if (this.over) {
      const a = Math.min(1, this.endT * 1.5);
      ctx.globalAlpha = a;
      ctx.font = '800 60px "Big Shoulders Display", Impact, sans-serif';
      ctx.lineWidth = 7; ctx.strokeStyle = 'rgba(20,10,4,0.85)';
      const msg = this.won ? 'GOAL REACHED' : this.endMsg.startsWith('Out') ? 'OUT OF TIME' : 'GAME OVER';
      ctx.strokeText(msg, 282, 560); ctx.fillStyle = this.won ? '#fff0b8' : '#d98a68'; ctx.fillText(msg, 282, 560);
      ctx.globalAlpha = 1;
    }
  }
}

function fmt(n) { return String(Math.floor(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ' '); }
function makeGearPx(teeth, rp, k) {
  // gear sprite at pixel scale k (k<=1 means downscaled); drawn at logical size 2*(rp+8)
  return makeGearAt(teeth, rp, k);
}
function makeGearAt(teeth, rp, k) {
  // build a gear with pitch radius rp (px), rasterized at scale k
  const R = rp + 8, size = Math.max(8, R * 2 * k);
  const c = mkCanvas(size, size), g = c.getContext('2d');
  g.scale(k, k); g.translate(R, R);
  const rt = rp + rp * 0.035, rr = rp - rp * 0.035;
  g.beginPath();
  for (let i = 0; i < teeth; i++) {
    const a = TAU2 * i / teeth, hr = Math.PI / teeth * 0.58, ht = Math.PI / teeth * 0.30;
    const pts = [[a - hr, rr], [a - ht, rt], [a + ht, rt], [a + hr, rr]];
    pts.forEach((p, j) => { const x = Math.cos(p[0]) * p[1], y = Math.sin(p[0]) * p[1]; if (i === 0 && j === 0) g.moveTo(x, y); else g.lineTo(x, y); });
  }
  g.closePath();
  const spokes = 6, r1 = rp * 0.28, r2 = rp * 0.78;
  for (let i = 0; i < spokes; i++) {
    const a0 = TAU2 * i / spokes + 0.12, a1 = TAU2 * (i + 1) / spokes - 0.12;
    g.moveTo(Math.cos(a0) * r2, Math.sin(a0) * r2);
    g.arc(0, 0, r2, a0, a1, false); g.lineTo(Math.cos(a1) * r1, Math.sin(a1) * r1);
    g.arc(0, 0, r1, a1, a0, true); g.closePath();
  }
  g.moveTo(rp * 0.1, 0); g.arc(0, 0, rp * 0.1, 0, TAU2, true);
  g.fillStyle = '#c99a48'; g.fill('evenodd');
  g.strokeStyle = '#f0d58a'; g.lineWidth = Math.max(1, 1.5 / k); g.stroke();
  return c;
}
function flipperPath(g, px, py, ang, s, r0, r1, len) {
  const dx = s * Math.cos(ang), dy = Math.sin(ang);
  const tx = px + dx * len, ty = py + dy * len;
  const phi = Math.atan2(dy, dx);
  const psi = Math.acos((r0 - r1) / len);
  g.beginPath();
  g.moveTo(px + Math.cos(phi + psi) * r0, py + Math.sin(phi + psi) * r0);
  g.lineTo(tx + Math.cos(phi + psi) * r1, ty + Math.sin(phi + psi) * r1);
  g.arc(tx, ty, r1, phi + psi, phi - psi, true);
  g.lineTo(px + Math.cos(phi - psi) * r0, py + Math.sin(phi - psi) * r0);
  g.arc(px, py, r0, phi - psi, phi + psi, true);
  g.closePath();
}
function drawSteelBall(ctx, x, y, rot, dim) {
  ctx.fillStyle = 'rgba(0,0,0,0.38)'; ctx.beginPath(); ctx.ellipse(x + 3, y + 5, BR * 0.95, BR * 0.8, 0, 0, TAU2); ctx.fill();
  const g = ctx.createRadialGradient(x - 4, y - 5, 1, x, y, BR);
  g.addColorStop(0, '#ffffff'); g.addColorStop(0.28, '#d5dbe1'); g.addColorStop(0.62, '#7d868f'); g.addColorStop(1, '#1d2328');
  ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x, y, BR, 0, TAU2); ctx.fill();
  ctx.save(); ctx.beginPath(); ctx.arc(x, y, BR - 0.3, 0, TAU2); ctx.clip();
  ctx.translate(x, y); ctx.rotate(rot);
  // environment horizon band that rolls with the ball
  const bg = ctx.createLinearGradient(0, -BR, 0, BR);
  bg.addColorStop(0, 'rgba(255,255,255,0)'); bg.addColorStop(0.4, 'rgba(20,26,32,0.35)'); bg.addColorStop(0.52, 'rgba(255,230,190,0.35)'); bg.addColorStop(0.7, 'rgba(10,14,18,0.30)'); bg.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = bg; ctx.fillRect(-BR, -BR, BR * 2, BR * 2);
  ctx.restore();
  // specular highlight
  ctx.fillStyle = 'rgba(255,255,255,0.9)'; ctx.beginPath(); ctx.ellipse(x - 4 + Math.sin(rot) * 0.8, y - 5, 2.6, 1.7, -0.6, 0, TAU2); ctx.fill();
  ctx.fillStyle = 'rgba(255,200,140,0.35)'; ctx.beginPath(); ctx.arc(x + 4, y + 5, 3, 0, TAU2); ctx.fill();
  if (dim < 1) { ctx.fillStyle = `rgba(0,0,0,${(1 - dim) * 0.6})`; ctx.beginPath(); ctx.arc(x, y, BR, 0, TAU2); ctx.fill(); }
}

// ---- static board art -----------------------------------------------------
function buildBoard(g, k) {
  g.scale(k, k); g.translate(20, 20);
  // wood
  tablePath(g);
  const wg = g.createRadialGradient(300, 450, 0, 300, 450, 700);
  wg.addColorStop(0, '#2b1e13'); wg.addColorStop(0.6, '#1a120c'); wg.addColorStop(1, '#0f0a07');
  g.fillStyle = wg; g.fill();
  g.save(); tablePath(g); g.clip();
  const rnd = mulberry(5);
  for (let i = 0; i < 300; i++) {
    const x = rnd() * 600, y0 = rnd() * 1000, len = 80 + rnd() * 400;
    g.strokeStyle = rnd() < 0.5 ? 'rgba(110,76,44,0.07)' : 'rgba(0,0,0,0.22)';
    g.lineWidth = 0.5 + rnd() * 1.3;
    g.beginPath(); g.moveTo(x, y0); g.bezierCurveTo(x + (rnd() - 0.5) * 10, y0 + len * 0.3, x + (rnd() - 0.5) * 10, y0 + len * 0.7, x + (rnd() - 0.5) * 6, y0 + len); g.stroke();
  }
  // lane groove
  g.fillStyle = 'rgba(0,0,0,0.25)'; g.fillRect(545, 215, 35, 785);
  // engraved rings around bumpers
  g.strokeStyle = 'rgba(201,162,75,0.28)'; g.lineWidth = 1.1;
  for (const [x, y] of BUMPER_POS) {
    g.beginPath(); g.arc(x, y, 38, 0, TAU2); g.stroke();
    g.setLineDash([3, 5]); g.beginPath(); g.arc(x, y, 45, 0, TAU2); g.stroke(); g.setLineDash([]);
  }
  // arcs near the top
  g.strokeStyle = 'rgba(201,162,75,0.16)';
  for (const r of [250, 232]) { g.beginPath(); g.arc(300, 300, r, Math.PI * 1.08, Math.PI * 1.92); g.stroke(); }
  // clock face
  const cx = 282, cy = 650;
  g.strokeStyle = 'rgba(201,162,75,0.4)'; g.lineWidth = 1.6;
  g.beginPath(); g.arc(cx, cy, 68, 0, TAU2); g.stroke();
  g.lineWidth = 0.8; g.beginPath(); g.arc(cx, cy, 62, 0, TAU2); g.stroke();
  for (let i = 0; i < 60; i++) {
    const a = i * TAU2 / 60, big = i % 5 === 0;
    const r1 = big ? 52 : 57;
    g.lineWidth = big ? 1.4 : 0.7; g.strokeStyle = `rgba(201,162,75,${big ? 0.5 : 0.28})`;
    g.beginPath(); g.moveTo(cx + Math.cos(a) * r1, cy + Math.sin(a) * r1); g.lineTo(cx + Math.cos(a) * 61, cy + Math.sin(a) * 61); g.stroke();
  }
  g.fillStyle = 'rgba(201,162,75,0.42)'; g.font = '600 10px Fraunces, Georgia, serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
  const rom = ['XII', 'I', 'II', 'III', 'IIII', 'V', 'VI', 'VII', 'VIII', 'IX', 'X', 'XI'];
  for (let i = 0; i < 12; i++) { const a = -Math.PI / 2 + i * TAU2 / 12; g.fillText(rom[i], cx + Math.cos(a) * 42, cy + Math.sin(a) * 42); }
  // title engraving
  g.fillStyle = 'rgba(201,162,75,0.38)'; g.font = '600 22px Fraunces, Georgia, serif';
  try { g.letterSpacing = '6px'; } catch (e) { /* ignore */ }
  g.fillText('CLOCKWORK', 282, 748);
  g.font = '600 11px Fraunces, Georgia, serif';
  try { g.letterSpacing = '9px'; } catch (e) { /* ignore */ }
  g.fillText('PINBALL', 282, 770);
  try { g.letterSpacing = '0px'; } catch (e) { /* ignore */ }
  // orbit arrows
  g.strokeStyle = 'rgba(201,162,75,0.3)'; g.lineWidth = 1.6; g.lineCap = 'round'; g.lineJoin = 'round';
  for (const y of [500, 420, 340]) { g.beginPath(); g.moveTo(40, y + 7); g.lineTo(45, y); g.lineTo(50, y + 7); g.stroke(); }
  g.fillStyle = 'rgba(201,162,75,0.33)'; g.font = '600 9px Fredoka, sans-serif';
  g.save(); g.translate(30, 300); g.rotate(-Math.PI / 2); g.textAlign = 'left'; g.fillText('ORBIT', 0, 0); g.restore();
  // bank plate & labels
  g.fillStyle = '#0c0805'; roundRect(g, 192, 478, 184, 8, 3); g.fill();
  g.strokeStyle = 'rgba(201,162,75,0.5)'; g.lineWidth = 1; roundRect(g, 192, 478, 184, 8, 3); g.stroke();
  g.fillStyle = 'rgba(201,162,75,0.38)'; g.font = '600 9px Fredoka, sans-serif'; g.textAlign = 'center';
  for (let i = 0; i < 4; i++) g.fillText('x' + (i + 2), 222 + i * 40, 255);
  g.fillText('MULTIPLIER', 282, 215);
  g.fillText('BONUS LANES', 282, 78);
  // lane arrows
  for (const x of LANE_C) { g.beginPath(); g.moveTo(x - 7, 108); g.lineTo(x, 118); g.lineTo(x + 7, 108); g.stroke(); }
  // rubber posts
  for (const c of CAPS) if (c.kind === 'post') {
    g.fillStyle = 'rgba(0,0,0,0.5)'; g.beginPath(); g.arc(c.ax + 2, c.ay + 3, c.rad + 1, 0, TAU2); g.fill();
    g.fillStyle = '#1c1511'; g.beginPath(); g.arc(c.ax, c.ay, c.rad, 0, TAU2); g.fill();
    g.strokeStyle = 'rgba(160,120,60,0.45)'; g.lineWidth = 1.2; g.beginPath(); g.arc(c.ax, c.ay, c.rad - 0.5, 0, TAU2); g.stroke();
    const pg = g.createRadialGradient(c.ax - 1, c.ay - 1, 0.5, c.ax, c.ay, c.rad * 0.55);
    pg.addColorStop(0, '#f2d98b'); pg.addColorStop(1, '#6b4a17');
    g.fillStyle = pg; g.beginPath(); g.arc(c.ax, c.ay, c.rad * 0.5, 0, TAU2); g.fill();
  }
  // nixie plate
  const px = 282.5 - 135, pw = 270, py = 140, ph = 56;
  g.fillStyle = 'rgba(0,0,0,0.55)'; roundRect(g, px - 8, py - 8, pw + 16, ph + 16, 10); g.fill();
  g.strokeStyle = '#a8742f'; g.lineWidth = 3; roundRect(g, px - 8, py - 8, pw + 16, ph + 16, 10); g.stroke();
  g.strokeStyle = 'rgba(240,213,138,0.5)'; g.lineWidth = 1; roundRect(g, px - 6.5, py - 6.5, pw + 13, ph + 13, 9); g.stroke();
  for (let i = 0; i < 7; i++) {
    const x = 282.5 - 3.5 * 34 + i * 34;
    const tg = g.createLinearGradient(x, py, x + 34, py);
    tg.addColorStop(0, '#0b0705'); tg.addColorStop(0.5, '#1a110b'); tg.addColorStop(1, '#0b0705');
    g.fillStyle = tg; roundRect(g, x + 2, py + 1, 30, ph - 2, 8); g.fill();
    g.strokeStyle = 'rgba(255,200,140,0.18)'; g.lineWidth = 1; roundRect(g, x + 2, py + 1, 30, ph - 2, 8); g.stroke();
    g.fillStyle = 'rgba(255,120,40,0.07)'; g.font = '600 38px "IBM Plex Mono", monospace'; g.textBaseline = 'middle';
    g.fillText('8', x + 17, 169);
  }
  g.restore();
  // rails (brass)
  const rails = CAPS.filter(c => c.rail);
  const drawRail = (list, width, col, ox, oy) => {
    g.strokeStyle = col; g.lineWidth = width; g.lineCap = 'round'; g.lineJoin = 'round';
    g.beginPath();
    for (const c of list) { g.moveTo(c.ax + ox, c.ay + oy); g.lineTo(c.bx + ox, c.by + oy); }
    g.stroke();
  };
  const arcs = CAPS.filter(c => c.arc);
  const allRails = rails.concat(arcs);
  // sling frame segments are drawn in dynamic layer
  g.save(); tablePath(g); g.clip();
  drawRail(allRails, 11, 'rgba(0,0,0,0.5)', 2, 3);
  g.restore();
  drawRail(allRails, 9, '#2a1b0b', 0, 0);
  drawRail(allRails, 6.5, '#9b6c2a', 0, 0);
  drawRail(allRails, 4.6, '#d4a64a', 0, 0);
  drawRail(allRails, 1.6, '#fbeab0', -0.8, -0.8);
  // gate
  for (const gt of CAPS.filter(c => c.kind === 'gate')) {
    g.strokeStyle = '#7a5a22'; g.lineWidth = 5; g.lineCap = 'round'; g.beginPath(); g.moveTo(gt.ax, gt.ay); g.lineTo(gt.bx, gt.by); g.stroke();
    g.strokeStyle = '#f0d58a'; g.lineWidth = 2; g.beginPath(); g.moveTo(gt.ax, gt.ay - 1); g.lineTo(gt.bx, gt.by - 1); g.stroke();
    g.fillStyle = '#d4a64a'; g.beginPath(); g.arc(gt.bx, gt.by, 3, 0, TAU2); g.fill();
  }
}
function buildOverlay(g, k) {
  g.scale(k, k); g.translate(20, 20);
  // table rim (outer half of a stroke around the table outline)
  g.save();
  g.beginPath(); g.rect(-20, -20, 640, 1060); tablePath(g); g.clip('evenodd');
  tablePath(g);
  g.strokeStyle = '#1d1209'; g.lineWidth = 26; g.lineJoin = 'round'; g.stroke();
  g.strokeStyle = '#6b4a17'; g.lineWidth = 16; g.stroke();
  g.strokeStyle = '#b98a38'; g.lineWidth = 11; g.stroke();
  g.strokeStyle = '#f0d58a'; g.lineWidth = 3.5; g.stroke();
  g.restore();
  // apron / drain pit (not covering the plunger lane)
  g.save();
  g.beginPath(); g.rect(0, 990, 545, 80); g.clip();
  const ag = g.createLinearGradient(0, 988, 0, 1040);
  ag.addColorStop(0, '#0a0604'); ag.addColorStop(1, '#241810');
  g.fillStyle = ag; g.fillRect(-20, 988, 600, 80);
  g.restore();
  g.fillStyle = ag; g.fillRect(-20, 1018, 36, 30); g.fillRect(578, 1018, 40, 30);
  // brass fascia
  g.fillStyle = '#6b4a17'; g.fillRect(-14, 988, 565, 7);
  const fg = g.createLinearGradient(0, 988, 0, 995);
  fg.addColorStop(0, '#f0d58a'); fg.addColorStop(1, '#a8742f');
  g.fillStyle = fg; g.fillRect(-14, 988, 565, 4);
  // screws
  for (const x of [60, 160, 282, 400, 500]) {
    g.fillStyle = '#d9b25c'; g.beginPath(); g.arc(x, 1011, 4.2, 0, TAU2); g.fill();
    g.strokeStyle = '#4a3010'; g.lineWidth = 1.2; g.beginPath(); g.moveTo(x - 2.6, 1010); g.lineTo(x + 2.6, 1012); g.stroke();
  }
  g.fillStyle = 'rgba(201,162,75,0.45)'; g.font = '600 13px Fraunces, Georgia, serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
  try { g.letterSpacing = '5px'; } catch (e) { /* ignore */ }
  g.fillText('DRAIN', 282, 1030);
  try { g.letterSpacing = '0px'; } catch (e) { /* ignore */ }
}

Arcade.register({
  id: 'pinball',
  name: 'Clockwork Pinball',
  genre: 'Pinball',
  aiNote: "Sees the ball, flippers and lit targets 50 ms late, estimates ball speed from two frames, and uses only the two flipper buttons and the plunger.",
  blurb: 'A brass clockwork table: bumpers, slingshots, drop targets and a nixie scoreboard.',
  bg: '#17110c',
  accent: '#d4a64a',
  create() { return new Pinball(); },
});
})();
