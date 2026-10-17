(() => {
'use strict';

// ---------------------------------------------------------------------------
// Quiet Descent — lunar lander. Five landings on ever more rugged terrain.
// World units: 1200 wide x 700 tall, y points UP in the physics (drawing flips it).
// ---------------------------------------------------------------------------
const WW = 1200, WH = 700, STEP = 6, NP = WW / STEP + 1;
const G = 12;                      // lunar gravity (u/s^2)
const AMAX = 30;                   // engine acceleration at full throttle
const BURN = 4.6;                  // fuel units per second at full throttle
const SPOOL = 10;                  // throttle spool rate (1/s)
const ROT_MAX = 2.2, ROT_ACC = 10; // rad/s, rad/s^2
const FOOT = 16, FOOT_X = 15;      // lander geometry: centre -> foot pad
const LIM_VY = 20, LIM_VX = 11, LIM_ANG = 8 * Math.PI / 180;
const FUEL_MAX = 100, FUEL_START = 100, REFILL = 22;
const ROUNDS = 5;
const TIME_CAP = 330;
const GOLD = '#e9bf5a', GOLD_D = '#9a6f1c', INK = 'rgba(236,239,246,0.92)';

const smooth = t => { t = clamp(t, 0, 1); return t * t * (3 - 2 * t); };
const alphaNow = () => (typeof Arcade !== 'undefined' && typeof Arcade.alpha === 'number' ? clamp(Arcade.alpha, 0, 1) : 1);
const fmt = n => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');

// ------------------------------- terrain ------------------------------------
function makeNoise(spacing, amp) {
  const n = Math.ceil(WW / spacing) + 4;
  const v = Array.from({ length: n }, () => rnd.float(-1, 1));
  return x => {
    const f = x / spacing + 1, i = Math.floor(f), t = f - i, s = t * t * (3 - 2 * t);
    return amp * (v[i] * (1 - s) + v[i + 1] * s);
  };
}

function genTerrain(round) {
  const rough = 28 + 24 * round;
  const octs = [makeNoise(380, rough), makeNoise(170, rough * 0.5), makeNoise(75, rough * 0.22), makeNoise(30, rough * 0.07 + 1)];
  const base = rnd.float(150, 205);
  const bumps = [];
  const nb = round >= 3 ? 2 : round >= 1 ? 1 : 0;
  for (let i = 0; i < nb; i++) bumps.push({ x: rnd.float(260, 940), h: 55 + 28 * round + rnd.float(0, 30), s: rnd.float(55, 85) });
  const craters = [];
  const nc = 5 + rnd.int(3);
  for (let i = 0; i < nc; i++) { const r = rnd.float(26, 62); craters.push({ x: rnd.float(50, WW - 50), r, d: r * rnd.float(0.28, 0.42) }); }
  const h = new Float32Array(NP);
  for (let i = 0; i < NP; i++) {
    const x = i * STEP;
    let y = base + octs.reduce((a, f) => a + f(x), 0);
    for (const b of bumps) y += b.h * Math.exp(-(((x - b.x) / b.s) ** 2));
    for (const c of craters) {
      const d = Math.abs(x - c.x) / c.r;
      if (d < 1) y -= c.d * (1 - d * d);
      y += c.d * 0.28 * Math.exp(-(((d - 1.05) / 0.14) ** 2));
    }
    h[i] = clamp(y, 110, 400);
  }
  // pads
  const centers = [];
  for (let tries = 0; tries < 400 && centers.length < 3; tries++) {
    const c = rnd.float(150, 1050);
    if (centers.every(o => Math.abs(o - c) > 230)) centers.push(c);
  }
  while (centers.length < 3) centers.push(200 + centers.length * 400);
  rnd.shuffle(centers);
  const sc = 1 - 0.052 * round;
  const specs = [[2, 100 * sc], [3, 72 * sc], [5, 54 * sc]];
  const pads = specs.map(([mult, w], k) => {
    const cx = centers[k];
    let sum = 0, cnt = 0;
    for (let x = cx - w / 2; x <= cx + w / 2; x += STEP) { sum += h[clamp(Math.round(x / STEP), 0, NP - 1)]; cnt++; }
    const y = clamp(sum / cnt, 120, 330);
    for (let i = 0; i < NP; i++) {
      const d = Math.abs(i * STEP - cx) - w / 2 - 5;
      if (d <= 0) h[i] = y;
      else if (d < 36) { const s = smooth(d / 36); h[i] = y * (1 - s) + h[i] * s; }
    }
    return { cx, w, x0: cx - w / 2, x1: cx + w / 2, y, mult };
  });
  const pebbles = [];
  for (let i = 0; i < 110; i++) pebbles.push({ x: rnd.float(0, WW), d: rnd.float(3, 90), r: rnd.float(1, 3.4), a: rnd.float(0.06, 0.22), l: rnd.float(0, 1) });
  const ridges = [0, 1].map(k => {
    const n1 = makeNoise(260 - k * 90, 55 + k * 20), n2 = makeNoise(90, 14);
    const pts = [];
    for (let x = -300; x <= WW + 300; x += 20) pts.push([x, 230 + k * 40 + n1(x + 300 * 0) + n2(x)]);
    return pts;
  });
  const T = { h, pads, craters, pebbles, ridges, round };
  return T;
}
function htAt(T, x) {
  const f = clamp(x / STEP, 0, NP - 1), i = Math.min(NP - 2, Math.floor(f)), t = f - i;
  return T.h[i] * (1 - t) + T.h[i + 1] * t;
}

// -------------------------------- AI ----------------------------------------
// What the AI can see (observe()): the gauges a pilot reads — noisy readings of
// position, altitude, vertical/horizontal speed, attitude angle, and fuel — plus
// the terrain profile and the landing pads (position, width, multiplier) that are
// drawn on screen. It never reads the true physics state or any hidden RNG.
// It acts only through three held keys: rotate-left, rotate-right, main engine.
// Engine taps are pulse-width style in 0.08 s windows (≤12 presses/s) and
// rotation keys cannot change faster than every 0.07 s; it starts 0.7 s late.
// Guidance: pad choice by multiplier vs. difficulty vs. fuel; a velocity-profile
// law (lateral stop-distance curve, vertical suicide-burn-like curve over a
// terrain-clearing floor + approach funnel) converted to a thrust direction;
// bang-bang attitude control with a predicted stopping angle.
// AI styles (picked per game): dec = vertical braking accel used for the descent profile, vmax = max descent
// speed, vTn/vTa = touch-down speed target before/after alignment, mult = exponent on the pad multiplier,
// distK = distance tolerance when choosing pads, sw = how much better another pad must be to switch, fun = funnel height.
const LANDER_STYLES = [
  { name: 'Direct descent', dec: 7.5, vmax: 62, vTn: 2.8, vTa: 4, mult: 1, distK: 1100, sw: 1.45, fun: 26 },
  { name: 'Hover and settle', dec: 5.2, vmax: 40, vTn: 2.2, vTa: 2.6, mult: 1, distK: 900, sw: 1.45, fun: 40 },
  { name: 'Pad hopper', dec: 6.6, vmax: 54, vTn: 2.6, vTa: 3.4, mult: 1.3, distK: 1400, sw: 1.3, fun: 30 },
];
// Super AI: exact gauges, no read-in delay, per-frame engine PWM and key changes, steeper suicide-burn profile.
const SUPER_LANDER_STYLE = { name: 'Super AI', dec: 12, vmax: 62, vTn: 2.8, vTa: 4, mult: 1.3, distK: 1400, sw: 1.3, fun: 26 };
const PL = { tp: 0.02, mag: 0.97 };
const GATES = [30, 70, 120, 180, 250], GATE_V = 9;
const COAST = [0, 0.15, 0.3, 0.5, 0.75, 1, 1.5, 2, 2.5, 3, 4, 5, 6, 7, 8, 10, 12, 14, 16, 19, 22, 26, 30];
const LD = { law: true, filt: true, slew: true, hold: true, win: true, fun: false };
const LanderAI = {
  sty: LANDER_STYLES[0], sup: false,
  reset() {
    this.round = -1; this.est = null; this.pad = null; this.key = { rot: 0, thr: 0 };
    this.rotHold = 0; this.winAcc = 0; this.winT = 0; this.winOn = 0; this.wm = 0; this.t = 0;
    this.aligned = false; this.reeval = 0; this.cmdRot = 0;
  },

  observe(g) {
    const L = g.L;
    const q = this.sup ? 0 : 1;
    return {
      round: g.round, flying: g.phase === 'flight', terrain: g.T,
      x: L.x + q * rnd.gauss() * 0.6, y: L.y + q * rnd.gauss() * 0.6,
      vx: L.vx + q * rnd.gauss() * 1.4, vy: L.vy + q * rnd.gauss() * 1.4,
      ang: L.ang + q * rnd.gauss() * 0.006,
      fuel: L.fuel,
    };
  },

  choosePad(o, e) {
    const T = o.terrain;
    let best = null, bv = -1;
    for (const p of T.pads) {
      const dx = Math.abs(p.cx - e.x);
      const margin = (p.w - FOOT_X * 2) / 2;               // slack each side of the feet
      const pSucc = clamp(0.35 + margin / 16, 0.3, 1);
      const lo = Math.min(e.x, p.cx), hi = Math.max(e.x, p.cx);
      let peak = 0;
      for (let x = lo; x <= hi; x += 12) peak = Math.max(peak, htAt(T, x));
      const climb = Math.max(0, peak + 45 - e.y);
      const need = 18 + 0.045 * dx + 0.1 * Math.max(0, e.y - p.y) * 0.5 + 0.35 * climb + 0.04 * Math.abs(e.vx) * 2;
      const fuelOK = o.fuel > need * 1.15 ? 1 : clamp((o.fuel - need * 0.6) / (need * 0.55), 0.05, 1);
      const v = Math.pow(p.mult, this.sty.mult) * pSucc * fuelOK / (1 + dx / this.sty.distK) * (1 + (this.sup ? 0 : Math.random() * 0.02));
      if (v > bv) { bv = v; best = p; }
    }
    return best;
  },

  // Coast-then-burn guidance to a gate just above the pad: for each coast time (ballistic, engine off) and each burn
  // duration build the minimum-energy (linear-in-time thrust) solution to the gate, check thrust/tilt limits and
  // terrain clearance along the whole path, and keep the cheapest in fuel. Returns what to do right now.
  planFor(o, e, pad, H) {
    const T = o.terrain, ph = pad.w / 2;
    const rfx = pad.cx, rfy = pad.y + FOOT + H, vfx = 0, vfy = -GATE_V;
    const clearAt = (rx, ry, vxx) => {
      const near = Math.abs(rx - pad.cx) < ph + 45;
      return ry - ((near ? pad.y : htAt(T, rx)) + FOOT + (near ? 22 : 24 + 0.2 * Math.abs(vxx)));
    };
    let best = null;
    for (let ci = 0; ci < COAST.length; ci++) {
      const tc = COAST[ci];
      // ballistic leg
      let okc = true;
      for (let k = 1; k <= Math.ceil(tc / 0.5); k++) {
        const tt = Math.min(tc, k * 0.5);
        if (clearAt(e.x + e.vx * tt, e.y + e.vy * tt - 0.5 * G * tt * tt, e.vx) < 0) { okc = false; break; }
      }
      if (!okc) break;
      const x1 = e.x + e.vx * tc, y1 = e.y + e.vy * tc - 0.5 * G * tc * tc, vx1 = e.vx, vy1 = e.vy - G * tc;
      if (x1 < 20 || x1 > WW - 20) break;
      for (let t = 1.2; t < 50; t *= 1.12) {
        const zx = rfx - (x1 + vx1 * t), zy = rfy - (y1 + vy1 * t - 0.5 * G * t * t);
        const wx = vfx - vx1, wy = vfy - (vy1 - G * t);
        const a0x = 6 * zx / (t * t) - 2 * wx / t, a0y = 6 * zy / (t * t) - 2 * wy / t;
        const a1x = 2 * (wx - a0x * t) / (t * t), a1y = 2 * (wy - a0y * t) / (t * t);
        let ok = true, fuel = 0;
        const N = 8, dt = t / N;
        for (let k = 0; k <= N; k++) {
          const tau = k * dt;
          const ax = a0x + a1x * tau, ay = a0y + a1y * tau, mag = Math.hypot(ax, ay);
          if (mag > AMAX * PL.mag) { ok = false; break; }
          if (mag > 2.5 && (ay <= 0 || Math.abs(ax) > 0.8 * ay || (k >= N - 2 && Math.abs(ax) > 0.3 * ay))) { ok = false; break; }
          fuel += BURN * (mag / AMAX) * dt * (k === 0 || k === N ? 0.5 : 1);
          if (k > 0) {
            const rx = x1 + vx1 * tau + 0.5 * a0x * tau * tau + a1x * tau * tau * tau / 6;
            const ry = y1 + vy1 * tau - 0.5 * G * tau * tau + 0.5 * a0y * tau * tau + a1y * tau * tau * tau / 6;
            if (rx < 20 || rx > WW - 20 || clearAt(rx, ry, vx1 + a0x * tau) < 0) { ok = false; break; }
            const mt = tau - dt / 2, mx = x1 + vx1 * mt + 0.5 * a0x * mt * mt + a1x * mt * mt * mt / 6;
            const my = y1 + vy1 * mt - 0.5 * G * mt * mt + 0.5 * a0y * mt * mt + a1y * mt * mt * mt / 6;
            if (clearAt(mx, my, vx1) < -4) { ok = false; break; }
          }
        }
        if (!ok) continue;
        const vimp = Math.sqrt(GATE_V * GATE_V + 2 * G * H), sc = fuel + PL.tp * (tc + t) + (vimp - 9) * 1.67 / 6.5 * (BURN / 1) / 4.6 + 0 * H;
        if (!best || sc < best.sc) best = { sc, fuel: fuel + (vimp - 9) * 1.67 / 6.5, H, tc, tgo: tc + t, tb: t, ax: a0x, ay: a0y };
      }
    }
    return best;
  },

  planBest(o, e, pad) {
    let best = null;
    for (const H of GATES) { const P = this.planFor(o, e, pad, H); if (P && (!best || P.sc < best.sc)) best = P; }
    return best;
  },

  choosePadSup(o, e) {
    const T = o.terrain;
    let best = null, bv = -1;
    for (const p of T.pads) {
      const P = this.planBest(o, e, p);
      if (!P) continue;
      const margin = (p.w - FOOT_X * 2) / 2;
      const pSucc = clamp(0.35 + margin / 16, 0.3, 1);
      const cost = P.fuel + 12;
      const fuelOK = o.fuel > cost * 1.25 + 4 ? 1 : clamp((o.fuel - cost * 0.7) / (cost * 0.55), 0.03, 1);
      const v = Math.pow(p.mult, 1.3) * pSucc * fuelOK / (1 + cost / 45);
      if (v > bv) { bv = v; best = p; }
    }
    return best || this.choosePad(o, e);
  },

  update(g, dt) {
    const o = this.observe(g);
    this.t += dt;
    if (!o.flying) { this.key.rot = 0; this.key.thr = 0; return this.key; }
    if (o.round !== this.round) {
      this.round = o.round; this.key = { rot: 0, thr: 0 }; this.thS = undefined; this.est = null; this.pad = null; this.t = 0; this.aligned = false;
      this.winAcc = 0; this.winT = 0; this.winOn = 0; this.wm = 0; this.final = false; this.thLast = undefined;
    }
    if (!this.est) this.est = { x: o.x, y: o.y, vx: o.vx, vy: o.vy, ang: o.ang, w: 0 };
    const e = this.est;
    // filters (a pilot reads smoothed gauges); attitude rate is dead-reckoned from own key presses
    e.x += (o.x - e.x) * 0.4 + e.vx * dt * 0 ; e.y += (o.y - e.y) * 0.4;
    e.vx += (o.vx - e.vx) * 0.28; e.vy += (o.vy - e.vy) * 0.28;
    this.wm += clamp(this.key.rot * ROT_MAX - this.wm, -ROT_ACC * dt, ROT_ACC * dt);
    e.ang += this.wm * dt; e.ang += (o.ang - e.ang) * 0.25; e.w = this.wm;
    if (this.sup && LD.filt) { e.x = o.x; e.y = o.y; e.vx = o.vx; e.vy = o.vy; e.ang = o.ang; }
    if (!this.sup && this.t < 1.0) return this.key;                       // human read-in delay
    const T = o.terrain;
    this.reeval -= dt;
    if (!this.pad) { this.pad = this.sup && LD.law ? this.choosePadSup(o, e) : this.choosePad(o, e); }
    else if (this.reeval <= 0 && e.y - htAt(T, e.x) > 140) {
      this.reeval = 1.0;
      const c = this.sup && LD.law ? this.choosePadSup(o, e) : this.choosePad(o, e);
      if (c !== this.pad && !(this.sup && LD.law)) {
        const vNew = this.padValue(o, e, c), vOld = this.padValue(o, e, this.pad);
        if (vNew > vOld * this.sty.sw) this.pad = c;
      }
    }
    g.aiTarget = this.pad;
    const pad = this.pad;
    const dx = pad.cx - e.x, adx = Math.abs(dx), ph = pad.w / 2;
    const gh = e.y - FOOT - htAt(T, e.x);                    // radar altitude under the feet

    // --- alignment latch for the final drop
    const tol = Math.max(5, ph * 0.33);
    if (!this.aligned) { if (adx < tol && Math.abs(e.vx) < 4.5) this.aligned = true; }
    else if (adx > ph * 0.72 || Math.abs(e.vx) > 9 || (gh > 55 && adx > tol * 1.6)) this.aligned = false;

    // --- terrain-clearing floor along the way (look ahead along motion + braking distance)
    const aH = this.sup && LD.fun ? 3 : 1.8;
    const stopD = e.vx * Math.abs(e.vx) / (2 * aH);
    let xa = e.x, xb = e.x + e.vx * 1.5 + stopD * 0.6;
    const lo = Math.min(xa, xb) - 26, hi = Math.max(xa, xb) + 26;
    let peak = 0;
    for (let x = lo; x <= hi; x += STEP) {
      if (Math.abs(x - pad.cx) < ph + 34) continue;
      peak = Math.max(peak, htAt(T, x));
    }
    const clear = 34 + 0.3 * Math.abs(e.vx);
    const terrFloor = peak > 0 ? peak + FOOT + clear : 0;
    const funnel = this.aligned ? pad.y + FOOT
            : this.sup && LD.fun ? pad.y + FOOT + this.sty.fun + Math.min(75, 0.2 * Math.max(0, adx - ph * 0.5))
      : pad.y + FOOT + this.sty.fun + (this.sty.slope || 0.42) * Math.max(0, adx - ph * 0.5);
    let floorY = Math.max(terrFloor, funnel);
    const hh = e.y - floorY;
    const vT = this.aligned ? this.sty.vTa : this.sty.vTn;
    let vyDes;
    if (hh > 0) vyDes = -Math.min(this.sty.vmax, vT + Math.sqrt(2 * this.sty.dec * hh));
    else vyDes = Math.min(26, -hh * 1.2);

    // --- lateral velocity profile
    let vxMax = this.sup && LD.fun ? Math.min(45, 12 + 0.4 * Math.max(0, e.y - pad.y)) : Math.min(34, 10 + 0.35 * Math.max(0, e.y - pad.y));
    if (this.aligned) vxMax = 9;
    let vxDes = Math.sign(dx) * Math.min(vxMax, Math.sqrt(2 * aH * Math.max(adx - 3, 0)), 1.5 * adx);
    // when the lander is far below the funnel (e.g. climbing out of a gorge) don't push sideways into rock
    let thDes, u, planned = false;
    if (this.sup && LD.law && !this.final) {
      // Super AI transit: re-plan every frame a minimum-energy (linear-in-time thrust) trajectory to a gate above the
      // pad, over a search of flight times; the original descent law takes over once the gate is reached.
      const P = this.planBest(o, e, pad);
      if (P && Math.hypot(pad.cx - e.x, pad.y + FOOT + P.H - e.y) < 20 && Math.hypot(e.vx, e.vy + GATE_V) < 9) this.final = true;
      if (P && !this.final && P.tgo > 1.0 && gh > 30) {
        const mag = Math.hypot(P.ax, P.ay);
        if (P.tc >= 0.25 || mag < 1.2 || P.ay <= 0) {
          u = 0; thDes = P.ay > 1 ? clamp(Math.atan2(P.ax, P.ay), -0.75, 0.75) : (this.thLast !== undefined ? this.thLast : e.ang);
          if (P.ay > 1) this.thLast = thDes;
        } else {
          thDes = clamp(Math.atan2(P.ax, P.ay), -0.75, 0.75); this.thLast = thDes;
          u = clamp(mag / AMAX * clamp(Math.cos(thDes) / Math.max(Math.cos(e.ang), 0.5), 0, 1.4), 0, 1);
          u *= clamp(1 - (Math.abs(e.ang - thDes) - 0.2) / 0.3, 0, 1);
        }
        this.thS = thDes; planned = true;
      } else if (P || gh < 60) this.final = true;
    }
    if (!planned) {
    const ax = clamp(1.2 * (vxDes - e.vx), -3.4, 3.4);
    const ay = clamp(3.2 * (vyDes - e.vy), -G, AMAX * 0.95);
    let Ty = ay + G, Tx = ax;
    const maxTilt = clamp(0.03 + gh * 0.011, 0.04, 0.6);
    // tilt follows the lateral demand only (decoupled from vertical thrust pulses, so it doesn't chatter)
    thDes = clamp(Math.atan(Tx / (G * 1.1)), -maxTilt, maxTilt);
    Ty = Math.max(Ty, Math.abs(Tx) * (Math.abs(Tx) > 1.5 ? 0.9 : 0));
    let Treq = Ty > 0.3 ? Ty / Math.max(Math.cos(thDes), 0.5) : 0;
    if (gh < 16) thDes = 0;
    if (this.thS === undefined || this.t < 0.8) this.thS = e.ang;
    this.thS += clamp(thDes - this.thS, -(this.sup && LD.slew ? 6 : 1.6) * dt, (this.sup && LD.slew ? 6 : 1.6) * dt); thDes = this.thS;
    u = clamp(Treq / AMAX, 0, 1);
    const aerr = Math.abs(e.ang - thDes);
    u *= gh < 45 ? clamp(1 - (aerr - 0.3) / 0.3, 0.3, 1) : clamp(1 - (aerr - 0.25) / 0.3, 0, 1);

    }
    // --- attitude keys: bang-bang to the predicted stopping angle, 0.07 s hold
    this.rotHold -= dt;
    const err = thDes - e.ang;
    const stopA = e.w * Math.abs(e.w) / (2 * ROT_ACC);
    const e2 = err - stopA;
    const dz = gh < 40 ? 0.012 : 0.022;
    let want = Math.abs(e2) < dz ? 0 : Math.sign(e2);
    if (want !== this.key.rot && this.rotHold <= 0) { this.key.rot = want; this.rotHold = this.sup && LD.hold ? 0 : 0.07; }

    // --- main engine: pulse-density in 0.08 s windows
    this.winT -= dt;
    if (this.winT <= 0) {
      this.winT = this.sup && LD.win ? 0.0001 : 0.08;
      if (u > 0.93) { this.winOn = 1; this.winAcc = 0; }
      else if (u < 0.06) { this.winOn = 0; this.winAcc = Math.min(this.winAcc, 0.5); }
      else { this.winAcc += u; if (this.winAcc >= 0.5) { this.winOn = 1; this.winAcc -= 1; } else this.winOn = 0; }
    }
    this.key.thr = this.winOn;
    return this.key;
  },

  padValue(o, e, p) {
    const margin = (p.w - FOOT_X * 2) / 2, dx = Math.abs(p.cx - e.x);
    return Math.pow(p.mult, this.sty.mult) * clamp(0.35 + margin / 16, 0.3, 1) / (1 + dx / this.sty.distK);
  },
};

// ------------------------------- visuals ------------------------------------
let _earth = null;
function earthSprite(r) {
  const rr = Math.max(8, Math.round(r / 4) * 4);
  if (_earth && _earth.rr === rr) return _earth;
  const S = Math.ceil(rr * 3), c = document.createElement('canvas'); c.width = c.height = S;
  const x = c.getContext('2d'), m = S / 2;
  let seed = 7; const rd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const glow = x.createRadialGradient(m, m, rr * 0.9, m, m, rr * 1.45);
  glow.addColorStop(0, 'rgba(110,170,255,0.30)'); glow.addColorStop(1, 'rgba(110,170,255,0)');
  x.fillStyle = glow; x.fillRect(0, 0, S, S);
  x.save(); x.beginPath(); x.arc(m, m, rr, 0, TAU); x.clip();
  const sea = x.createRadialGradient(m - rr * 0.35, m - rr * 0.35, rr * 0.1, m, m, rr);
  sea.addColorStop(0, '#5aa0e8'); sea.addColorStop(0.55, '#2a63b8'); sea.addColorStop(1, '#10316b');
  x.fillStyle = sea; x.fillRect(0, 0, S, S);
  for (let k = 0; k < 9; k++) {
    x.fillStyle = `rgba(${96 + rd() * 30 | 0},${118 + rd() * 30 | 0},${84 + rd() * 20 | 0},0.78)`;
    x.beginPath();
    const cx = m + (rd() - 0.5) * rr * 1.5, cy = m + (rd() - 0.5) * rr * 1.5, n = 7, rad = rr * (0.12 + rd() * 0.2);
    const pp = []; for (let i = 0; i < n; i++) { const a = i / n * TAU, q = rad * (0.6 + rd() * 0.7); pp.push([cx + Math.cos(a) * q * 1.4, cy + Math.sin(a) * q]); }
    for (let i = 0; i < n; i++) { const p0 = pp[i], p1 = pp[(i + 1) % n], mx = (p0[0] + p1[0]) / 2, my = (p0[1] + p1[1]) / 2; if (!i) x.moveTo(mx, my); else x.quadraticCurveTo(p0[0], p0[1], mx, my); }
    x.quadraticCurveTo(pp[0][0], pp[0][1], (pp[0][0] + pp[1][0]) / 2, (pp[0][1] + pp[1][1]) / 2);
    x.closePath(); x.fill();
  }
  for (let k = 0; k < 14; k++) {
    x.fillStyle = 'rgba(255,255,255,0.20)'; x.beginPath();
    x.ellipse(m + (rd() - 0.5) * rr * 1.7, m + (rd() - 0.5) * rr * 1.7, rr * (0.1 + rd() * 0.28), rr * (0.025 + rd() * 0.05), rd() * 3, 0, TAU); x.fill();
  }
  const sh = x.createLinearGradient(m - rr * 0.6, m - rr * 0.6, m + rr * 0.9, m + rr * 0.9);
  sh.addColorStop(0, 'rgba(0,0,12,0)'); sh.addColorStop(0.5, 'rgba(0,0,12,0.12)'); sh.addColorStop(1, 'rgba(0,0,12,0.75)');
  x.fillStyle = sh; x.fillRect(0, 0, S, S);
  x.restore();
  x.strokeStyle = 'rgba(160,205,255,0.35)'; x.lineWidth = Math.max(1, rr * 0.02); x.beginPath(); x.arc(m, m, rr - 1, 0, TAU); x.stroke();
  return (_earth = { c, rr, S });
}

class Lander {
  constructor(opts = {}) {
    this.superAI = !!opts.superAI;
    this.W = 1280; this.H = 720; this.sb = 1;
    this.over = false; this.won = false;
    this.t = 0; this.score = 0; this.crashes = 0; this.landed = 0; this.round = 0;
    this.fuel = FUEL_START; this.log = [];
    this.dust = []; this.debris = []; this.floaters = []; this.P = new Particles();
    this.stars = Array.from({ length: 170 }, () => ({ x: Math.random(), y: Math.random() * 0.8, r: rnd.float(0.4, 1.4), p: rnd.float(0, TAU), s: rnd.float(0.5, 2) }));
    this.shake = 0; this.fade = 0; this.fadeDir = 0; this.msg = null; this.msgT = 0;
    this.endReason = '';
    this.styleDef = this.superAI ? SUPER_LANDER_STYLE : LANDER_STYLES[Math.floor(Math.random() * LANDER_STYLES.length)]; this.style = this.styleDef.name; LanderAI.sty = this.styleDef; LanderAI.sup = this.superAI;
    LanderAI.reset();
    this.startRound(0, true);
  }

  startRound(r, first) {
    this.round = r;
    this.T = genTerrain(r);
    const T = this.T;
    const side = Math.random() < 0.5 ? -1 : 1;
    const x = side < 0 ? rnd.float(70, 130) : WW - rnd.float(70, 130);
    let top = 0; for (let i = 0; i < NP; i++) top = Math.max(top, T.h[i]);
    const y = clamp(top + rnd.float(210, 270), 470, 630);
    const L = this.L = {
      x, y, vx: -side * (15 + 4 * r + rnd.float(0, 9)), vy: -rnd.float(0, 10), ang: rnd.float(-0.1, 0.1) * (1 + r * 0.4), w: 0,
      thr: 0, rot: 0, key: 0, fuel: this.fuel, legC: 0, legV: 0, vis: true, rest: false,
    };
    L.px = L.x; L.py = L.y; L.pang = L.ang; L.pthr = 0;
    this.phase = 'flight'; this.pt = 0;
    this.dust.length = 0; this.debris.length = 0; this.floaters.length = 0; this.P.list.length = 0;
    this.aiTarget = null;
    this.rt = 0;
    this.cam = { x: WW / 2, y: WH / 2, z: 1 }; this.cam.px = this.cam.x; this.cam.py = this.cam.y; this.cam.pz = 1;
    this.msg = null; this.shake = 0;
    this.fadeDir = first ? 0 : -1; this.fade = first ? 0 : 1;
  }

  resize(W, H) { this.W = W; this.H = H; this.sb = Math.min(W / WW, H / WH); }

  // ------------------------------- logic ------------------------------------
  step(dt) {
    this.t += dt;
    const L = this.L;
    // render interpolation snapshots
    L.px = L.x; L.py = L.y; L.pang = L.ang; L.pthr = L.thr;
    const C = this.cam; C.px = C.x; C.py = C.y; C.pz = C.z;

    if (!this.over && this.t > TIME_CAP) { this.finish(false, 'Out of time'); }
    if (this.fadeDir) {
      this.fade += this.fadeDir * dt / 0.7;
      if (this.fadeDir < 0 && this.fade <= 0) { this.fade = 0; this.fadeDir = 0; }
      if (this.fadeDir > 0 && this.fade >= 1) { this.fade = 1; this.fadeDir = 0; this.startRound(this.round + 1, false); return; }
    }
    this.pt += dt;
    this.msgT += dt;

    if (this.phase === 'flight') {
      this.rt += dt;
      const k = LanderAI.update(this, dt);
      L.rotKey = k.rot; L.thrKey = k.thr;
      this.physics(dt);
    } else {
      L.rotKey = 0; L.thrKey = 0;
      // settle animation after touchdown
      if (this.phase === 'landed') {
        L.legV += (-90 * L.legC - 9 * L.legV) * dt; L.legC += L.legV * dt;
        L.ang *= Math.exp(-6 * dt); L.thr = 0;
      }
      if (this.phase === 'crashed') { /* debris only */ }
      const hold = this.phase === 'landed' ? 3.0 : 3.4;
      if (this.pt > hold && !this.over && !this.fadeDir) this.fadeDir = 1;
    }
    this.updateFx(dt);
    this.updateCam(dt);
  }

  physics(dt) {
    const L = this.L, T = this.T;
    // controls
    const rotTarget = L.rotKey * ROT_MAX;
    L.w += clamp(rotTarget - L.w, -ROT_ACC * dt, ROT_ACC * dt);
    L.rot = L.rotKey;
    const thrOn = L.thrKey && L.fuel > 0;
    L.thr += clamp((thrOn ? 1 : 0) - L.thr, -SPOOL * dt, SPOOL * dt);
    if (L.fuel <= 0) L.thr = Math.max(0, L.thr - 3 * dt);
    L.fuel = Math.max(0, L.fuel - BURN * L.thr * dt);
    const n = 2, h = dt / n;
    for (let s = 0; s < n; s++) {
      L.ang += L.w * h;
      const T_ = AMAX * L.thr;
      L.vx += Math.sin(L.ang) * T_ * h;
      L.vy += (Math.cos(L.ang) * T_ - G) * h;
      L.x += L.vx * h; L.y += L.vy * h;
      if (this.contact()) return;
    }
    if (L.y > WH + 500 || L.x < -260 || L.x > WW + 260) { L.vis = false; this.crash(true); }
  }

  localToWorld(lx, ly) {
    const L = this.L, s = Math.sin(L.ang), c = Math.cos(L.ang);
    return [L.x + lx * c + ly * s, L.y - lx * s + ly * c];
  }

  contact() {
    const L = this.L, T = this.T;
    const pts = [[-FOOT_X, -FOOT], [FOOT_X, -FOOT], [0, -13], [-12, -6], [12, -6], [-7, 13], [7, 13]];
    let hit = -1;
    for (let i = 0; i < pts.length; i++) {
      const [wx, wy] = this.localToWorld(pts[i][0], pts[i][1]);
      if (wy <= htAt(T, wx)) { hit = i; break; }
    }
    if (hit < 0) return false;
    const a = this.localToWorld(-FOOT_X, -FOOT), b = this.localToWorld(FOOT_X, -FOOT);
    const mid = (a[0] + b[0]) / 2;
    const pad = T.pads.find(p => a[0] >= p.x0 - 2 && b[0] <= p.x1 + 2);
    const speedOK = L.vy > -LIM_VY && Math.abs(L.vx) < LIM_VX && Math.abs(L.ang) < LIM_ANG;
    this.last = { vy: L.vy, vx: L.vx, ang: L.ang };
    if (pad && hit < 2 && speedOK) this.touchdown(pad);
    else this.crash(false);
    return true;
  }

  touchdown(pad) {
    const L = this.L;
    this.phase = 'landed'; this.pt = 0;
    const pts = 100 * pad.mult + Math.round(L.fuel);
    this.score += pts; this.landed++; this.fuel = L.fuel;
    this.log.push({ ok: true, mult: pad.mult });
    L.y = pad.y + FOOT; L.legC = 0.9; L.legV = 0; L.vx = 0; L.vy = 0; L.w = 0; L.thr = 0; L.rest = true;
    this.usedPad = pad; this.padFlash = 0;
    this.msg = { text: 'TOUCHDOWN', sub: `x${pad.mult} pad`, ok: true }; this.msgT = 0;
    this.floaters.push({ x: L.x, y: pad.y + 40, vy: 22, t: 0, text: `+${pts}`, c: GOLD });
    for (let i = 0; i < 26; i++) {
      const dir = i % 2 ? 1 : -1;
      this.dust.push({ x: L.x + dir * rnd.float(4, 16), y: pad.y + 2, vx: dir * rnd.float(25, 90), vy: rnd.float(3, 18), t: 0, max: rnd.float(1.2, 2.4), r: rnd.float(2, 4.2) });
    }
    this.P.burst(L.x, -(pad.y + 8), 40, { color: [GOLD, '#fff3c8', '#ffd98a'], speed: 150, speedMin: 30, life: 1.3, size: 2.2, gravity: 30, angle: -Math.PI / 2, spread: 1.5 });
    this.shake = 2;
    this.fuel = Math.min(FUEL_MAX, this.fuel + REFILL);
    if (this.round >= ROUNDS - 1) this.finish(this.crashes <= 1, '');
  }

  crash(lost) {
    const L = this.L;
    this.phase = 'crashed'; this.pt = 0;
    this.crashes++; this.log.push({ ok: false, mult: 0 }); this.fuel = Math.min(FUEL_MAX, L.fuel + REFILL);
    this.msg = { text: 'CRASHED', sub: this.crashReason(lost), ok: false }; this.msgT = 0;
    L.thr = 0;
    if (!lost) {
      L.vis = false;
      const gx = L.x, gy = L.y;
      for (let i = 0; i < 16; i++) {
        const a = rnd.float(0, TAU), sp = rnd.float(15, 110);
        const poly = []; const n = 3 + rnd.int(3), rr = rnd.float(2.5, 6.5);
        for (let k = 0; k < n; k++) { const q = k / n * TAU; poly.push([Math.cos(q) * rr * rnd.float(0.6, 1.2), Math.sin(q) * rr * rnd.float(0.6, 1.2)]); }
        this.debris.push({ x: gx + rnd.float(-10, 10), y: gy + rnd.float(-8, 8), vx: L.vx * 0.4 + Math.cos(a) * sp, vy: Math.max(L.vy * -0.1, 0) + Math.abs(Math.sin(a)) * sp * 0.9 + 20, ang: rnd.float(0, TAU), w: rnd.float(-8, 8), poly, gold: i % 3 !== 0, t: 0 });
      }
      this.P.burst(gx, -gy, 70, { color: ['#fff6d6', GOLD, '#ffb040', '#ffffff'], speed: 190, speedMin: 30, life: 1.2, size: 3, gravity: 25 });
      this.flash = 1; this.shock = { x: gx, y: gy, t: 0 };
      for (let i = 0; i < 30; i++) {
        const dir = Math.random() < 0.5 ? -1 : 1;
        this.dust.push({ x: gx + dir * rnd.float(0, 14), y: htAt(this.T, gx) + 2, vx: dir * rnd.float(20, 120), vy: rnd.float(2, 30), t: 0, max: rnd.float(1.2, 2.6), r: rnd.float(2, 5) });
      }
    }
    this.shake = 7;
    if (this.crashes >= 2) this.finish(false, 'Crashed twice');
    else if (this.round >= ROUNDS - 1) this.finish(this.crashes <= 1, '');
  }

  crashReason(lost) {
    if (lost) return 'lost in space';
    const l = this.last || {}, why = [];
    if (l.vy < -LIM_VY) why.push('too fast'); else if (Math.abs(l.vx) >= LIM_VX) why.push('too much drift'); else if (Math.abs(l.ang) >= LIM_ANG) why.push('bad angle'); else why.push('off the pad');
    return why[0];
  }

  finish(won, reason) {
    if (this.over) return;
    this.over = true; this.won = won; this.endReason = reason;
  }

  updateFx(dt) {
    const L = this.L, T = this.T;
    // plume dust + sparks
    if (this.phase === 'flight' && L.thr > 0.05) {
      const gh = L.y - FOOT - htAt(T, L.x);
      if (gh < 110) {
        const k = L.thr * (1 - gh / 110);
        const n = Math.random() < k * 2.2 ? 1 + (Math.random() < k) : 0;
        for (let i = 0; i < n; i++) {
          const dir = Math.random() < 0.5 ? -1 : 1;
          this.dust.push({ x: L.x + dir * rnd.float(0, 10), y: htAt(T, L.x) + 1.5, vx: dir * rnd.float(30, 190) * (0.4 + k), vy: rnd.float(1, 14), t: 0, max: rnd.float(0.9, 2.2), r: rnd.float(1.8, 4) });
        }
      }
      if (Math.random() < 0.5) {
        const [bx, by] = this.localToWorld(0, -15);
        this.P.burst(bx, -by, 1, { color: ['#ffe9a8', GOLD, '#fff'], speed: 70, speedMin: 30, life: 0.5, size: 1.6, angle: Math.PI / 2 - L.ang, spread: 0.35, drag: 3 });
      }
    }
    if (this.phase === 'flight' && L.rotKey && Math.random() < 0.6) {
      const [bx, by] = this.localToWorld(-L.rotKey * 14, 6);
      this.P.burst(bx, -by, 1, { color: '#e8eefc', speed: 55, speedMin: 20, life: 0.35, size: 1.3, angle: Math.atan2(-Math.cos(L.ang) * 0, L.rotKey) * 0 + (L.rotKey > 0 ? Math.PI : 0), spread: 0.5, drag: 3 });
    }
    if (this.P.list.length > 420) this.P.list.length = 420;
    this.P.update(dt);
    for (let i = this.dust.length - 1; i >= 0; i--) {
      const d = this.dust[i];
      d.t += dt; if (d.t >= d.max) { this.dust[i] = this.dust[this.dust.length - 1]; this.dust.pop(); continue; }
      d.px = d.x; d.py = d.y;
      const dr = Math.exp(-0.9 * dt); d.vx *= dr; d.vy = d.vy * dr - 9 * dt;
      d.x += d.vx * dt; d.y += d.vy * dt;
      const gy = htAt(T, d.x) + 1;
      if (d.y < gy) { d.y = gy; d.vy = 0; d.vx *= 0.94; }
    }
    if (this.dust.length > 260) this.dust.splice(0, this.dust.length - 260);
    for (let i = this.debris.length - 1; i >= 0; i--) {
      const d = this.debris[i];
      d.t += dt; if (d.t > 6) { this.debris.splice(i, 1); continue; }
      d.vy -= G * 0.8 * dt; d.x += d.vx * dt; d.y += d.vy * dt; d.ang += d.w * dt;
      const gy = htAt(T, d.x) + 2;
      if (d.y < gy) { d.y = gy; d.vy = Math.abs(d.vy) * 0.3; d.vx *= 0.75; d.w *= 0.7; if (d.vy < 4) d.vy = 0; }
    }
    for (let i = this.floaters.length - 1; i >= 0; i--) {
      const f = this.floaters[i]; f.t += dt; f.y += f.vy * dt; if (f.t > 2.2) this.floaters.splice(i, 1);
    }
    if (this.flash) this.flash = Math.max(0, this.flash - dt * 2.4);
    if (this.shock) { this.shock.t += dt; if (this.shock.t > 1.2) this.shock = null; }
    this.shake *= Math.exp(-5 * dt);
    if (this.padFlash !== undefined) this.padFlash += dt;
  }

  updateCam(dt) {
    const L = this.L, C = this.C || this.cam, T = this.T, W = this.W, H = this.H;
    const sb = this.sb || 1;
    const gh = L.y - FOOT - htAt(T, L.x);
    const pad = this.phase === 'landed' && this.usedPad ? this.usedPad : this.aiTarget;
    let zAlt = 1 + 0.95 * smooth((230 - gh) / 170);
    let tx = WW / 2, ty = WH / 2, z = 1;
    if (this.phase === 'crashed' || (this.phase === 'landed')) zAlt = Math.max(zAlt, 1.55);
    if (pad) {
      const dxp = Math.max(1, Math.abs(L.x - pad.cx));
      z = Math.max(1, Math.min(zAlt, (W * 0.36) / (sb * dxp)));
      const zb = clamp((z - 1) / 0.95, 0, 1);
      tx = lerp(WW / 2, (L.x + pad.cx) / 2, zb);
      const s = sb * z;
      const gyTarget = pad.y + 0.05 * H / s + 10;
      ty = lerp(WH / 2, Math.min(Math.max(gyTarget, (L.y + pad.y) / 2 + 0.06 * H / s), WH), zb);
    }
    if (this.phase === 'crashed' && !L.vis) { z = Math.max(z, 1.6); }
    const k = 1 - Math.exp(-dt * 2.4);
    C.x += (tx - C.x) * k; C.y += (ty - C.y) * k; C.z += (z - C.z) * (1 - Math.exp(-dt * 1.8));
  }

  hud() {
    const L = this.L;
    const c = this.crashes ? ` · ${this.crashes} crash${this.crashes > 1 ? 'es' : ''}` : '';
    return { score: fmt(this.score), detail: `Landing ${Math.min(this.round + 1, ROUNDS)}/${ROUNDS} · Fuel ${Math.round(L.fuel)}${c}` };
  }

  result() { return this.result0() + ` (${this.style})`; }
  result0() {
    if (this.won) return `${ROUNDS} landings, ${this.crashes} crash${this.crashes === 1 ? '' : 'es'}, ${fmt(this.score)} points`;
    if (this.endReason === 'Out of time') return 'Out of time';
    return `Crashed twice by landing ${this.round + 1} of ${ROUNDS}`;
  }

  // ------------------------------- drawing ----------------------------------
  draw(ctx, W, H) {
    const a = alphaNow();
    const L = this.L, C = this.cam, T = this.T;
    const sb = Math.min(W / WW, H / WH);
    const cx = lerp(C.px, C.x, a), cy = lerp(C.py, C.y, a), cz = lerp(C.pz, C.z, a);
    const s = sb * cz;
    const shx = (Math.random() - 0.5) * this.shake * 2, shy = (Math.random() - 0.5) * this.shake * 2;
    // ---- sky
    staticLayer(ctx, 'lander-sky', W, H, (x, w, h) => {
      const g = x.createLinearGradient(0, 0, 0, h);
      g.addColorStop(0, '#03050c'); g.addColorStop(0.6, '#07102a'); g.addColorStop(1, '#101c3c');
      x.fillStyle = g; x.fillRect(0, 0, w, h);
    });
    const time = this.t;
    ctx.save();
    for (const st of this.stars) {
      const px = ((st.x * W - (cx - WW / 2) * s * 0.04) % W + W) % W, py = st.y * H;
      const tw = 0.55 + 0.45 * Math.sin(time * st.s + st.p);
      ctx.globalAlpha = 0.25 + 0.55 * tw * (0.5 + st.r / 2.8);
      ctx.fillStyle = '#dfe8ff';
      ctx.fillRect(px, py, st.r, st.r);
    }
    ctx.restore();
    // ---- Earth rising
    {
      const er = Math.min(W, H) * 0.095, sp = earthSprite(er * Math.min(2, window.devicePixelRatio || 1));
      const prog = clamp((this.round + clamp(this.rt / 40, 0, 1)) / ROUNDS, 0, 1);
      const ex = W * 0.16 - (cx - WW / 2) * s * 0.03, ey = H * (0.5 - 0.31 * smooth(prog * 1.05));
      const k = er / (sp.rr / Math.min(2, window.devicePixelRatio || 1)) / Math.min(2, window.devicePixelRatio || 1);
      const dw = sp.S * er / sp.rr * Math.min(2, window.devicePixelRatio || 1);
      ctx.drawImage(sp.c, ex - dw / 2, ey - dw / 2, dw, dw);
    }
    // ---- far ridges (parallax)
    const ridgeCols = ['#1b2030', '#262b3b'];
    for (let k = 0; k < 2; k++) {
      const p = 0.28 + 0.3 * k;
      const rs = sb * (1 + (cz - 1) * p), rcx = WW / 2 + (cx - WW / 2) * p, rcy = lerp(WH / 2, cy, p);
      ctx.save();
      ctx.translate(W / 2 - rcx * rs + shx * 0.4, H / 2 + rcy * rs + shy * 0.4); ctx.scale(rs, rs);
      ctx.fillStyle = ridgeCols[k];
      ctx.beginPath();
      const R = T.ridges[k];
      const bot = -(rcy - H / (2 * rs) - 60);
      ctx.moveTo(R[0][0] - 400, bot);
      for (const [x, y] of R) ctx.lineTo(x, -y);
      ctx.lineTo(R[R.length - 1][0] + 400, bot);
      ctx.closePath(); ctx.fill();
      ctx.restore();
    }
    // ---- world
    ctx.save();
    ctx.translate(W / 2 - cx * s + shx, H / 2 + cy * s + shy); ctx.scale(s, s);
    this.drawTerrain(ctx, W, H, s, cx, cy);
    this.drawPads(ctx, s);
    this.drawDust(ctx, a, false);
    this.drawShadow(ctx, a);
    if (L.vis) this.drawLander(ctx, a, s);
    this.drawDebris(ctx);
    this.P.draw(ctx, 1);
    this.drawDust(ctx, a, true);
    if (this.shock) {
      const k = this.shock.t / 1.2;
      ctx.strokeStyle = `rgba(255,236,190,${0.6 * (1 - k)})`; ctx.lineWidth = 3 * (1 - k) + 0.5;
      ctx.beginPath(); ctx.ellipse(this.shock.x, -htAt(T, this.shock.x), 16 + 110 * ease.outCubic(k), 4 + 20 * ease.outCubic(k), 0, 0, TAU); ctx.stroke();
    }
    ctx.restore();
    // ---- floating text (screen space)
    for (const f of this.floaters) {
      const sx = W / 2 + (f.x - cx) * s, sy = H / 2 - (f.y - cy) * s, al = Math.min(1, (2.2 - f.t) * 1.2) * Math.min(1, f.t * 6);
      ctx.globalAlpha = al; ctx.fillStyle = f.c;
      ctx.font = `600 ${Math.round(22 * Math.min(W, H) / 900 + 8)}px "IBM Plex Mono", monospace`; ctx.textAlign = 'center';
      ctx.fillText(f.text, sx, sy); ctx.globalAlpha = 1;
    }
    if (this.flash) { ctx.fillStyle = `rgba(255,240,205,${0.32 * this.flash})`; ctx.fillRect(0, 0, W, H); }
    // vignette
    liveLayer(ctx, 'lander-vig', W, H, 4, (x, w, h) => {
      const g = x.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.45, w / 2, h / 2, Math.max(w, h) * 0.75);
      g.addColorStop(0, 'rgba(0,0,0,0)'); g.addColorStop(1, 'rgba(0,0,6,0.55)');
      x.fillStyle = g; x.fillRect(0, 0, w, h);
    });
    this.drawUI(ctx, W, H);
    if (this.fade > 0) { ctx.fillStyle = `rgba(2,4,10,${clamp(this.fade, 0, 1)})`; ctx.fillRect(0, 0, W, H); }
  }

  drawTerrain(ctx, W, H, s, cx, cy) {
    const T = this.T, h = T.h;
    const x0 = cx - W / (2 * s) - 30, x1 = cx + W / (2 * s) + 30;
    const bot = -(cy - H / (2 * s) - 60);
    const i0 = Math.floor(x0 / STEP), i1 = Math.ceil(x1 / STEP);
    const hh = i => h[clamp(i, 0, NP - 1)];
    const g = ctx.createLinearGradient(0, -420, 0, 40);
    g.addColorStop(0, '#9fa2aa'); g.addColorStop(0.45, '#73767e'); g.addColorStop(1, '#3a3d46');
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.moveTo(i0 * STEP, bot);
    for (let i = i0; i <= i1; i++) ctx.lineTo(i * STEP, -hh(i));
    ctx.lineTo(i1 * STEP, bot); ctx.closePath(); ctx.fill();
    // relief: a copy of the ground shifted down-right and painted over a light wash leaves a lit sliver on every
    // slope that faces the upper-left light (thicker on steeper slopes) — gentle shaded hills without seams
    ctx.save();
    ctx.beginPath(); ctx.moveTo(i0 * STEP, bot);
    for (let i = i0; i <= i1; i++) ctx.lineTo(i * STEP, -hh(i));
    ctx.lineTo(i1 * STEP, bot); ctx.closePath(); ctx.clip();
    ctx.fillStyle = 'rgba(255,255,255,0.16)'; ctx.fillRect(i0 * STEP, -1000, (i1 - i0) * STEP, 1400 + bot + 1000);
    ctx.translate(5, 7); ctx.fillStyle = g;
    ctx.beginPath(); ctx.moveTo(i0 * STEP - 20, bot);
    for (let i = i0 - 4; i <= i1; i++) ctx.lineTo(i * STEP, -hh(i));
    ctx.lineTo(i1 * STEP, bot); ctx.closePath(); ctx.fill();
    ctx.translate(-12, -16);   // and a faint shadow sliver on the opposite side
    ctx.fillStyle = 'rgba(6,8,18,0.0)';
    ctx.restore();
    // craters: soft inner shading
    for (const c of T.craters) {
      const yb = htAt(T, c.x) + c.d * 0.1;
      ctx.fillStyle = 'rgba(10,12,24,0.16)';
      ctx.beginPath(); ctx.ellipse(c.x - c.r * 0.12, -yb + 1, c.r * 0.7, c.d * 0.5 + 2, 0, 0, TAU); ctx.fill();
      ctx.fillStyle = 'rgba(255,255,255,0.07)';
      ctx.beginPath(); ctx.ellipse(c.x + c.r * 0.35, -yb - 1, c.r * 0.3, c.d * 0.28 + 1, 0, 0, TAU); ctx.fill();
    }
    // pebbles
    for (const p of T.pebbles) {
      const y = htAt(T, p.x) - p.d;
      ctx.fillStyle = p.l > 0.5 ? `rgba(255,255,255,${p.a * 0.7})` : `rgba(10,12,22,${p.a * 1.2})`;
      ctx.beginPath(); ctx.ellipse(p.x, -y, p.r * 1.4, p.r, 0, 0, TAU); ctx.fill();
    }
    // lit rim line
    ctx.strokeStyle = 'rgba(232,236,246,0.38)'; ctx.lineWidth = 1.6 / Math.max(s, 0.5) * 1.2;
    ctx.lineJoin = 'round';
    ctx.beginPath();
    for (let i = i0; i <= i1; i++) ctx.lineTo(i * STEP, -hh(i));
    ctx.stroke();
  }

  drawPads(ctx, s) {
    const T = this.T, t = this.t, a = alphaNow();
    for (const p of T.pads) {
      const used = this.usedPad === p && this.phase === 'landed';
      const flash = used ? 0.7 + 0.3 * Math.sin(this.padFlash * 12) : 0;
      // plate
      ctx.fillStyle = '#c9ccd4'; ctx.fillRect(p.x0 - 3, -p.y - 1, p.w + 6, 6);
      ctx.fillStyle = '#6c707a'; ctx.fillRect(p.x0 - 3, -p.y + 3, p.w + 6, 3);
      // chase lights
      const n = Math.max(4, Math.floor(p.w / 9));
      for (let i = 0; i < n; i++) {
        const x = p.x0 + (i + 0.5) * p.w / n;
        const b = 0.35 + 0.65 * Math.max(0, Math.sin(t * 5 - i * 0.9)) ** 2 + flash * 0.5;
        ctx.fillStyle = `rgba(233,191,90,${clamp(b, 0, 1)})`;
        ctx.beginPath(); ctx.arc(x, -p.y - 0.4, 1.7, 0, TAU); ctx.fill();
        ctx.fillStyle = `rgba(233,191,90,${clamp(b, 0, 1) * 0.2})`;
        ctx.beginPath(); ctx.arc(x, -p.y - 0.4, 5, 0, TAU); ctx.fill();
      }
      // edge posts
      ctx.fillStyle = GOLD; ctx.fillRect(p.x0 - 3, -p.y - 9, 1.6, 10); ctx.fillRect(p.x1 + 1.4, -p.y - 9, 1.6, 10);
      // multiplier label
      const pulse = (0.75 + 0.25 * Math.sin(t * 3 + p.cx)) * (used ? 0.2 : 1);
      ctx.save();
      ctx.font = `600 ${p.mult >= 5 ? 19 : 16}px "IBM Plex Mono", monospace`; ctx.textAlign = 'center';
      ctx.fillStyle = `rgba(233,191,90,${0.28 * pulse})`;
      ctx.fillText('x' + p.mult, p.cx, -p.y - 18);
      ctx.fillText('x' + p.mult, p.cx + 0.6, -p.y - 18);
      ctx.fillStyle = `rgba(247,214,130,${pulse})`;
      ctx.fillText('x' + p.mult, p.cx, -p.y - 19);
      ctx.restore();
      if (this.aiTarget === p && this.phase === 'flight') {
        const bob = Math.sin(t * 4) * 3;
        ctx.fillStyle = 'rgba(233,191,90,0.85)';
        ctx.beginPath(); ctx.moveTo(p.cx - 6, -p.y - 50 + bob); ctx.lineTo(p.cx + 6, -p.y - 50 + bob); ctx.lineTo(p.cx, -p.y - 42 + bob); ctx.closePath(); ctx.fill();
      }
    }
  }

  drawDust(ctx, a, front) {
    for (const d of this.dust) {
      const isFront = d.r > 3;
      if (isFront !== front) continue;
      const k = d.t / d.max;
      const x = (d.px !== undefined ? lerp(d.px, d.x, a) : d.x), y = (d.py !== undefined ? lerp(d.py, d.y, a) : d.y);
      ctx.fillStyle = `rgba(190,194,204,${0.38 * (1 - k) * Math.min(1, d.t * 8)})`;
      ctx.beginPath(); ctx.arc(x, -y, d.r * (0.7 + 0.8 * k), 0, TAU); ctx.fill();
    }
  }

  drawShadow(ctx, a) {
    const L = this.L; if (!L.vis) return;
    const x = lerp(L.px, L.x, a), y = lerp(L.py, L.y, a);
    const gy = htAt(this.T, x), h = y - gy;
    if (h > 220) return;
    const k = 1 - h / 220;
    ctx.fillStyle = `rgba(8,10,20,${0.38 * k})`;
    ctx.beginPath(); ctx.ellipse(x, -gy + 1, 22 * (0.7 + 0.5 * k), 3.2 * k + 0.5, 0, 0, TAU); ctx.fill();
  }

  drawDebris(ctx) {
    for (const d of this.debris) {
      const k = Math.min(1, (6 - d.t) / 1.5);
      ctx.save(); ctx.translate(d.x, -d.y); ctx.rotate(-d.ang); ctx.globalAlpha = k;
      ctx.fillStyle = d.gold ? GOLD : '#aeb3be'; ctx.strokeStyle = d.gold ? GOLD_D : '#e9ecf3'; ctx.lineWidth = 0.7;
      ctx.beginPath(); d.poly.forEach(([x, y], i) => ctx[i ? 'lineTo' : 'moveTo'](x, y)); ctx.closePath(); ctx.fill(); ctx.stroke();
      ctx.restore();
    }
  }

  drawLander(ctx, a, s) {
    const L = this.L;
    const x = lerp(L.px, L.x, a), y = lerp(L.py, L.y, a);
    let ang = lerp(L.pang, L.ang, a);
    const thr = lerp(L.pthr, L.thr, a);
    const t = this.t;
    ctx.save();
    ctx.translate(x, -y); ctx.rotate(ang);
    // plume (additive)
    if (thr > 0.04) {
      const fl = 0.85 + 0.15 * Math.sin(t * 90) + 0.12 * Math.sin(t * 53 + 1);
      const len = thr * (30 * fl + 8), w = 4 + 4 * thr;
      ctx.save(); ctx.globalCompositeOperation = 'lighter';
      let g = ctx.createLinearGradient(0, 14, 0, 14 + len);
      g.addColorStop(0, 'rgba(255,248,220,0.95)'); g.addColorStop(0.35, 'rgba(255,200,110,0.55)'); g.addColorStop(1, 'rgba(255,170,60,0)');
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.moveTo(-3.4, 14); ctx.quadraticCurveTo(-w * 1.5, 14 + len * 0.5, 0, 14 + len); ctx.quadraticCurveTo(w * 1.5, 14 + len * 0.5, 3.4, 14); ctx.closePath(); ctx.fill();
      g = ctx.createLinearGradient(0, 14, 0, 14 + len * 0.55);
      g.addColorStop(0, 'rgba(255,255,255,0.95)'); g.addColorStop(1, 'rgba(255,230,160,0)');
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.moveTo(-2, 14); ctx.lineTo(0, 14 + len * 0.55 * fl); ctx.lineTo(2, 14); ctx.closePath(); ctx.fill();
      const gl = ctx.createRadialGradient(0, 17, 0, 0, 17, 26 * thr + 6);
      gl.addColorStop(0, `rgba(255,214,140,${0.4 * thr})`); gl.addColorStop(1, 'rgba(255,214,140,0)');
      ctx.fillStyle = gl; ctx.beginPath(); ctx.arc(0, 17, 26 * thr + 6, 0, TAU); ctx.fill();
      ctx.restore();
    }
    // RCS puffs
    if (L.rot && this.phase === 'flight') {
      const sg = L.rot;
      ctx.save(); ctx.globalCompositeOperation = 'lighter';
      for (const [px, py, dirx] of [[-sg * 15.5, -5, -sg], [sg * 15.5, 4, sg]]) {
        const j = 0.7 + 0.3 * Math.sin(t * 80 + px);
        ctx.fillStyle = `rgba(235,242,255,${0.7 * j})`;
        ctx.beginPath(); ctx.moveTo(px, py - 1.5); ctx.lineTo(px + dirx * 9 * j, py); ctx.lineTo(px, py + 1.5); ctx.closePath(); ctx.fill();
      }
      ctx.restore();
    }
    const lc = L.legC * 3;  // leg compression
    ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    ctx.strokeStyle = INK; ctx.lineWidth = 1.05;
    // far legs (dimmer)
    ctx.globalAlpha = 0.55;
    for (const sg of [-1, 1]) {
      ctx.beginPath(); ctx.moveTo(sg * 6, 6); ctx.lineTo(sg * (FOOT_X - 5), FOOT - 3 - lc * 0.5); ctx.stroke();
    }
    ctx.globalAlpha = 1;
    // legs + foot pads
    for (const sg of [-1, 1]) {
      ctx.beginPath(); ctx.moveTo(sg * 9, 4); ctx.lineTo(sg * FOOT_X, FOOT - lc); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(sg * 4, 9); ctx.lineTo(sg * (FOOT_X - 1.5), FOOT - 4 - lc * 0.5); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(sg * (FOOT_X - 4.5), FOOT - lc + 0.6); ctx.lineTo(sg * (FOOT_X + 4.5), FOOT - lc + 0.6); ctx.stroke();
    }
    // engine bell
    ctx.fillStyle = '#4b505c';
    ctx.beginPath(); ctx.moveTo(-3, 9); ctx.lineTo(3, 9); ctx.lineTo(5.2, 14); ctx.lineTo(-5.2, 14); ctx.closePath(); ctx.fill(); ctx.stroke();
    // descent stage — gold foil
    const gf = ctx.createLinearGradient(-12, -6, 12, 9);
    gf.addColorStop(0, '#f6d77f'); gf.addColorStop(0.35, '#d9a93f'); gf.addColorStop(0.6, '#f0cc70'); gf.addColorStop(1, '#8e6418');
    ctx.fillStyle = gf;
    ctx.beginPath();
    ctx.moveTo(-8, -6); ctx.lineTo(8, -6); ctx.lineTo(12, -1); ctx.lineTo(12, 5); ctx.lineTo(8, 9); ctx.lineTo(-8, 9); ctx.lineTo(-12, 5); ctx.lineTo(-12, -1); ctx.closePath();
    ctx.fill(); ctx.stroke();
    ctx.save(); ctx.clip();
    ctx.strokeStyle = 'rgba(255,245,200,0.55)'; ctx.lineWidth = 0.6;
    for (const [x1, y1, x2, y2] of [[-10, -4, -4, 3], [-3, -5, 4, 6], [3, -5, 10, 2], [-9, 4, -3, 8], [4, 2, 9, 7]]) { ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke(); }
    ctx.strokeStyle = 'rgba(110,70,10,0.45)';
    for (const [x1, y1, x2, y2] of [[-11, 1, -5, 6], [0, -6, 6, 1], [-6, -5, -1, 2]]) { ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke(); }
    ctx.restore();
    ctx.strokeStyle = INK; ctx.lineWidth = 1.05;
    // ascent stage
    const ag = ctx.createLinearGradient(-7, -13, 7, -6);
    ag.addColorStop(0, '#f2f4f8'); ag.addColorStop(1, '#aab0bd');
    ctx.fillStyle = ag;
    ctx.beginPath(); ctx.moveTo(-7.5, -6); ctx.lineTo(-5.2, -13); ctx.lineTo(5.2, -13); ctx.lineTo(7.5, -6); ctx.closePath(); ctx.fill(); ctx.stroke();
    ctx.fillStyle = '#16213a';
    ctx.beginPath(); ctx.moveTo(-3.6, -8); ctx.lineTo(-2.6, -11.4); ctx.lineTo(2.6, -11.4); ctx.lineTo(3.6, -8); ctx.closePath(); ctx.fill();
    ctx.strokeStyle = 'rgba(180,215,255,0.75)'; ctx.lineWidth = 0.6;
    ctx.beginPath(); ctx.moveTo(-1.8, -10.8); ctx.lineTo(0.3, -10.8); ctx.stroke();
    ctx.strokeStyle = INK; ctx.lineWidth = 1.05;
    // antenna + dish
    ctx.beginPath(); ctx.moveTo(4.2, -13); ctx.lineTo(7.5, -19.5); ctx.stroke();
    ctx.beginPath(); ctx.arc(7.9, -19.8, 2.3, 0.2, Math.PI + 0.2); ctx.stroke();
    // RCS pods
    ctx.fillStyle = '#7b808c';
    for (const sg of [-1, 1]) { ctx.beginPath(); ctx.rect(sg > 0 ? 12 : -15.2, -4, 3.2, 6); ctx.fill(); ctx.stroke(); }
    ctx.restore();
  }

  drawUI(ctx, W, H) {
    const u = Math.min(W, H) / 900, L = this.L;
    const pw = 236 * u, ph = 168 * u, px = W - pw - W * 0.03, py = H * 0.045;
    ctx.save();
    ctx.globalAlpha = 0.9;
    roundRect(ctx, px, py, pw, ph, 10 * u);
    ctx.fillStyle = 'rgba(8,12,24,0.62)'; ctx.fill();
    ctx.strokeStyle = 'rgba(233,191,90,0.35)'; ctx.lineWidth = 1; ctx.stroke();
    const fs = 12 * u;
    ctx.font = `600 ${fs}px "IBM Plex Mono", monospace`; ctx.textBaseline = 'middle';
    const lx = px + 14 * u, rx = px + pw - 14 * u;
    // landing pips
    ctx.fillStyle = 'rgba(233,236,246,0.6)'; ctx.textAlign = 'left';
    ctx.fillText('LANDING', lx, py + 18 * u);
    for (let i = 0; i < ROUNDS; i++) {
      const cx = rx - (ROUNDS - 1 - i) * 17 * u - 6 * u, cy = py + 18 * u, r = 5.4 * u;
      const e = this.log[i];
      ctx.beginPath(); ctx.arc(cx, cy, r, 0, TAU);
      if (e && e.ok) { ctx.fillStyle = GOLD; ctx.fill(); }
      else if (e) { ctx.strokeStyle = '#e8776a'; ctx.lineWidth = 1.6 * u; ctx.beginPath(); ctx.moveTo(cx - r * 0.7, cy - r * 0.7); ctx.lineTo(cx + r * 0.7, cy + r * 0.7); ctx.moveTo(cx + r * 0.7, cy - r * 0.7); ctx.lineTo(cx - r * 0.7, cy + r * 0.7); ctx.stroke(); }
      else { ctx.strokeStyle = i === this.round ? GOLD : 'rgba(233,236,246,0.35)'; ctx.lineWidth = 1.2 * u; ctx.stroke(); }
    }
    // fuel bar
    const fy = py + 42 * u;
    ctx.fillStyle = 'rgba(233,236,246,0.6)'; ctx.fillText('FUEL', lx, fy);
    const bx = lx + 44 * u, bw = rx - bx - 34 * u;
    roundRect(ctx, bx, fy - 4 * u, bw, 8 * u, 4 * u); ctx.fillStyle = 'rgba(255,255,255,0.1)'; ctx.fill();
    const fr = clamp(L.fuel / FUEL_MAX, 0, 1);
    if (fr > 0.01) { roundRect(ctx, bx, fy - 4 * u, bw * fr, 8 * u, 4 * u); ctx.fillStyle = fr < 0.2 ? '#e8776a' : GOLD; ctx.fill(); }
    ctx.fillStyle = INK; ctx.textAlign = 'right'; ctx.fillText(String(Math.round(L.fuel)), rx, fy);
    // readouts
    const rows = [
      ['V SPEED', -L.vy, LIM_VY, 'u/s', v => v < LIM_VY],
      ['H SPEED', Math.abs(L.vx), LIM_VX, 'u/s', v => v < LIM_VX],
      ['ANGLE', Math.abs(L.ang) * 180 / Math.PI, 8, '°', v => v < 8],
      ['ALTITUDE', Math.max(0, L.y - FOOT - htAt(this.T, L.x)), 0, 'u', () => true],
    ];
    const altNow = Math.max(0, L.y - FOOT - htAt(this.T, L.x));
    rows.forEach((r, i) => {
      const y = py + (68 + i * 24) * u;
      ctx.textAlign = 'left'; ctx.fillStyle = 'rgba(233,236,246,0.6)'; ctx.fillText(r[0], lx, y);
      const live = this.phase === 'flight' || this.phase === 'landed';
      const v = live ? r[1] : 0, ok = r[4](v) || altNow > 70 || this.phase !== 'flight';
      ctx.textAlign = 'right'; ctx.fillStyle = ok ? INK : '#e8776a';
      const txt = (r[0] === 'V SPEED' ? (v < 0 ? '↑ ' : '↓ ') : '') + Math.abs(v).toFixed(r[0] === 'ALTITUDE' ? 0 : 1) + ' ' + r[3];
      ctx.fillText(txt, rx, y);
    });
    ctx.restore();
    // banner
    if (this.msg && this.msgT < 3.4 && this.phase !== 'flight') {
      const k = ease.outBack(clamp(this.msgT / 0.45, 0, 1)), al = clamp((3.4 - this.msgT) * 2, 0, 1) * clamp(this.msgT * 6, 0, 1);
      ctx.save(); ctx.globalAlpha = al; ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
      const m = this.msg, cy = H * 0.24;
      ctx.translate(W / 2, cy); ctx.scale(0.9 + 0.1 * k, 0.9 + 0.1 * k);
      ctx.font = `600 ${Math.round(40 * u)}px Fredoka, sans-serif`;
      ctx.fillStyle = m.ok ? GOLD : '#e8776a'; ctx.fillText(m.text, 0, 0);
      ctx.font = `600 ${Math.round(18 * u)}px "IBM Plex Mono", monospace`;
      ctx.fillStyle = 'rgba(236,239,246,0.85)'; ctx.fillText(m.sub, 0, 28 * u);
      ctx.restore();
    }
  }
}

Arcade.register({
  id: 'lander',
  name: 'Quiet Descent',
  genre: 'Lunar lander',
  aiNote: 'Reads noisy speed, angle and fuel gauges, picks a landing pad, and flies with only rotate and thrust keys, tapped at human rates.',
  blurb: 'A gold-foil lander drops toward the grey moon, five landings, one careful burn at a time.',
  bg: '#0a1226',
  accent: '#e9bf5a',
  create(opts = {}) { return new Lander(opts); },
});

// offscreen layer helpers (static sky / low-res vignette)
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
  if (l.fresh) { l.fresh = false; l.x.setTransform(l.sc, 0, 0, l.sc, 0, 0); l.x.clearRect(0, 0, W, H); paint(l.x, W, H); }
  ctx.drawImage(l.c, 0, 0, W, H);
}
})();
