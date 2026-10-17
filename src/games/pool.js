// pool.js — Velvet Break: 8-ball, Autopilot AI (amber) vs the house bot (cyan).
(() => {
'use strict';

// ---------------------------------------------------------------------------
// Constants (table space: cloth nose-to-nose is TW x TH, ball centres live in [R, TW-R] x [R, TH-R])
// ---------------------------------------------------------------------------
const TW = 1000, TH = 500, R = 12, RAIL = 50, CD = 22;
const GC = 36, GS = 28, JR = 3.5;               // corner / side pocket mouth gaps, jaw radius
const NB = 16;
const H_STEP = 1 / 180, SUB = 3;                // physics substep (3 per 60 Hz tick)
const ROLL = 70, DRAG = 0.7, MINV = 4;         // rolling friction: v' = -(ROLL + DRAG v)
const REST_C = 0.8, REST_B = 0.96, VMAX = 1400;
const D2 = 4 * R * R;
const DEG = Math.PI / 180;
const AI_SIGMA = 0.25 * DEG;                    // human limit of Autopilot aim, Gaussian
const BOT_SIGMA = 0.22 * DEG;                   // house bot aim noise (tuned)
const BOT_LOOK = 14;                             // how many shots the house bot sanity-sims
const TIME_CAP = 330;
const FOOT_X = 720, HEAD_X = 250;
const AI_COL = '#f0b445', BOT_COL = '#5cc8e6';

const PK = [
  { x: -6, y: -6, r: 30, ax: -0.7071, ay: -0.7071, min: 0.3 },
  { x: TW / 2, y: -12, r: 27, ax: 0, ay: -1, min: 0.42 },
  { x: TW + 6, y: -6, r: 30, ax: 0.7071, ay: -0.7071, min: 0.3 },
  { x: -6, y: TH + 6, r: 30, ax: -0.7071, ay: 0.7071, min: 0.3 },
  { x: TW / 2, y: TH + 12, r: 27, ax: 0, ay: 1, min: 0.42 },
  { x: TW + 6, y: TH + 6, r: 30, ax: 0.7071, ay: 0.7071, min: 0.3 },
];
const JAWS = [
  [GC, 0], [0, GC], [TW - GC, 0], [TW, GC], [GC, TH], [0, TH - GC], [TW - GC, TH], [TW, TH - GC],
  [TW / 2 - GS, 0], [TW / 2 + GS, 0], [TW / 2 - GS, TH], [TW / 2 + GS, TH],
];

const HEX = ['#f4efe3', '#f0c030', '#1f58c8', '#d8392c', '#6b3fa8', '#ee7a1e', '#1d8a4e', '#8c2430', '#15151a'];
const RGB = HEX.map(h => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)]);
const ballHex = id => HEX[id <= 8 ? id : id - 8];
const groupOf = id => (id === 8 ? 'eight' : id === 0 ? null : id < 8 ? 'solid' : 'stripe');
const groupIds = g => (g === 'solid' ? [1, 2, 3, 4, 5, 6, 7] : [9, 10, 11, 12, 13, 14, 15]);
const smooth01 = v => (v < 0 ? 0 : v > 1 ? 1 : v);
const alphaNow = () => (typeof Arcade !== 'undefined' && Arcade.alpha != null && isFinite(Arcade.alpha) ? Arcade.alpha : 1);

// ---------------------------------------------------------------------------
// Physics (shared by the real game and by the AI's look-ahead simulations)
// ---------------------------------------------------------------------------
function newTable() {
  return {
    x: new Float64Array(NB), y: new Float64Array(NB), vx: new Float64Array(NB), vy: new Float64Array(NB),
    alive: new Uint8Array(NB), mv: new Int8Array(NB), isMv: new Uint8Array(NB), spin: 0,
  };
}
function copyTable(d, s) {
  d.x.set(s.x); d.y.set(s.y); d.vx.set(s.vx); d.vy.set(s.vy); d.alive.set(s.alive); d.spin = s.spin;
}
function newEv(fx) { return { first: -1, potted: [], railAfter: false, fx: fx ? [] : null, pq: fx ? [] : null }; }

function travel(v) {
  const tau = Math.log(1 + DRAG * v / ROLL) / DRAG;
  return (v + ROLL / DRAG) * (1 - Math.exp(-DRAG * tau)) / DRAG - ROLL * tau / DRAG;
}
function invTravel(s) {
  let lo = 0, hi = 2400;
  for (let i = 0; i < 28; i++) { const m = (lo + hi) / 2; if (travel(m) < s) lo = m; else hi = m; }
  return (lo + hi) / 2;
}

function physStep(T, h, ev) {
  const x = T.x, y = T.y, vx = T.vx, vy = T.vy, al = T.alive, mv = T.mv, im = T.isMv;
  let nm = 0; im.fill(0);
  for (let i = 0; i < NB; i++) {
    if (!al[i]) continue;
    const ax = vx[i], ay = vy[i];
    if (ax === 0 && ay === 0) continue;
    const sp = Math.sqrt(ax * ax + ay * ay);
    const ns = sp * (1 - DRAG * h) - ROLL * h;
    if (ns < MINV) { vx[i] = 0; vy[i] = 0; continue; }
    const f = ns / sp; vx[i] = ax * f; vy[i] = ay * f;
    x[i] += vx[i] * h; y[i] += vy[i] * h;
    mv[nm++] = i; im[i] = 1;
  }
  if (nm === 0) return 0;
  for (let m = 0; m < nm; m++) {
    const i = mv[m];
    if (!al[i]) continue;
    for (let j = 0; j < NB; j++) {
      if (j === i || !al[j]) continue;
      if (im[j] && j < i) continue;
      const dx = x[j] - x[i], dy = y[j] - y[i], d2 = dx * dx + dy * dy;
      if (d2 >= D2) continue;
      const d = Math.sqrt(d2) || 1e-4, nx = dx / d, ny = dy / d;
      const ov = (2 * R - d) * 0.5;
      x[i] -= nx * ov; y[i] -= ny * ov; x[j] += nx * ov; y[j] += ny * ov;
      const rvn = (vx[i] - vx[j]) * nx + (vy[i] - vy[j]) * ny;
      if (rvn > 0) {
        const cue = i === 0 || j === 0;
        const pvx = vx[0], pvy = vy[0];
        const imp = rvn * (1 + REST_B) * 0.5;
        vx[i] -= imp * nx; vy[i] -= imp * ny; vx[j] += imp * nx; vy[j] += imp * ny;
        if (cue) {
          if (ev.first < 0) ev.first = i === 0 ? j : i;
          if (T.spin !== 0) {
            const s0 = Math.sqrt(pvx * pvx + pvy * pvy);
            if (s0 > 1) { const k = T.spin * rvn * 0.55 / s0; vx[0] += pvx * k; vy[0] += pvy * k; }
            T.spin = 0;
          }
        }
        if (ev.fx && rvn > 90) ev.fx.push(0, x[i] + nx * R, y[i] + ny * R, rvn);
      }
    }
  }
  for (let m = 0; m < nm; m++) {
    const i = mv[m];
    if (!al[i]) continue;
    let px = x[i], py = y[i];
    let pot = -1;
    for (let k = 0; k < 6; k++) {
      const P = PK[k], dx = px - P.x, dy = py - P.y;
      if (dx * dx + dy * dy < P.r * P.r) { pot = k; break; }
    }
    if (pot < 0 && (px < -26 || px > TW + 26 || py < -26 || py > TH + 26)) {
      let bd = 1e9; for (let k = 0; k < 6; k++) { const d = (px - PK[k].x) ** 2 + (py - PK[k].y) ** 2; if (d < bd) { bd = d; pot = k; } }
    }
    if (pot >= 0) {
      al[i] = 0; ev.potted.push(i);
      if (ev.pq) ev.pq.push({ id: i, pk: pot, x: px, y: py, sp: Math.hypot(vx[i], vy[i]) });
      vx[i] = 0; vy[i] = 0; continue;
    }
    let hit = 0;
    if (px < R) {
      if (py > GC && py < TH - GC) { px = R; if (vx[i] < 0) { hit = -vx[i]; vx[i] = -vx[i] * REST_C; vy[i] *= 0.985; } }
    } else if (px > TW - R) {
      if (py > GC && py < TH - GC) { px = TW - R; if (vx[i] > 0) { hit = vx[i]; vx[i] = -vx[i] * REST_C; vy[i] *= 0.985; } }
    }
    if (py < R) {
      if ((px > GC && px < TW / 2 - GS) || (px > TW / 2 + GS && px < TW - GC)) { py = R; if (vy[i] < 0) { hit = Math.max(hit, -vy[i]); vy[i] = -vy[i] * REST_C; vx[i] *= 0.985; } }
    } else if (py > TH - R) {
      if ((px > GC && px < TW / 2 - GS) || (px > TW / 2 + GS && px < TW - GC)) { py = TH - R; if (vy[i] > 0) { hit = Math.max(hit, vy[i]); vy[i] = -vy[i] * REST_C; vx[i] *= 0.985; } }
    }
    for (let q = 0; q < JAWS.length; q++) {
      const jx = px - JAWS[q][0], jy = py - JAWS[q][1], dd = jx * jx + jy * jy, rr = R + JR;
      if (dd < rr * rr) {
        const d = Math.sqrt(dd) || 1e-4, nx = jx / d, ny = jy / d;
        px += nx * (rr - d); py += ny * (rr - d);
        const vn = vx[i] * nx + vy[i] * ny;
        if (vn < 0) { vx[i] -= 1.7 * vn * nx; vy[i] -= 1.7 * vn * ny; hit = Math.max(hit, -vn); }
      }
    }
    x[i] = px; y[i] = py;
    if (hit > 8) {
      if (ev.first >= 0) ev.railAfter = true;
      if (ev.fx && hit > 120) ev.fx.push(1, px, py, hit);
    }
  }
  return nm;
}

function simShot(T0, S, ang, speed, spin) {
  copyTable(S, T0);
  S.vx[0] = Math.cos(ang) * speed; S.vy[0] = Math.sin(ang) * speed; S.spin = spin;
  const ev = newEv(false);
  for (let s = 0; s < 2300; s++) if (!physStep(S, H_STEP, ev)) break;
  return ev;
}

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------
// c = { group: 'solid'|'stripe'|null, isBreak, ownAlive }
function judge(c, ev) {
  const potted = ev.potted, cuePot = potted.includes(0);
  const objPot = potted.filter(i => i !== 0);
  const J = { foul: false, reason: '', loss: false, win: false, continues: false, assign: null, respot8: false, scratch: cuePot, objPot, lossWhy: '' };
  const group = c.group, onEight = !!group && !c.ownAlive, first = ev.first;
  if (first < 0) { J.foul = true; J.reason = 'No ball contacted'; }
  else if (!c.isBreak) {
    if (!group) { if (first === 8) { J.foul = true; J.reason = 'Hit the 8 first'; } }
    else if (onEight) { if (first !== 8) { J.foul = true; J.reason = 'Must hit the 8 first'; } }
    else if (groupOf(first) !== group) { J.foul = true; J.reason = 'Wrong ball first'; }
  }
  if (cuePot) { J.foul = true; J.reason = 'Scratch'; }
  if (!J.foul && first >= 0 && !ev.railAfter && objPot.length === 0) { J.foul = true; J.reason = 'No rail after contact'; }
  if (objPot.includes(8)) {
    if (c.isBreak) J.respot8 = true;
    else if (!group) { J.loss = true; J.lossWhy = 'potted the 8-ball on an open table'; }
    else if (!onEight) { J.loss = true; J.lossWhy = 'potted the 8-ball early'; }
    else if (J.foul) { J.loss = true; J.lossWhy = 'fouled while potting the 8-ball'; }
    else J.win = true;
  }
  if (!J.loss && !J.win && !J.foul) {
    const legal = objPot.filter(i => i !== 8);
    if (!group) { if (legal.length) { J.continues = true; if (!c.isBreak) J.assign = groupOf(legal[0]); } }
    else if (legal.some(i => groupOf(i) === group)) J.continues = true;
  }
  return J;
}

// ---------------------------------------------------------------------------
// Geometry helpers (shared by the AI planner and the house bot)
// ---------------------------------------------------------------------------
function segD2(ax, ay, bx, by, px, py) {
  const abx = bx - ax, aby = by - ay, l2 = abx * abx + aby * aby;
  let t = l2 > 0 ? ((px - ax) * abx + (py - ay) * aby) / l2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const qx = ax + abx * t - px, qy = ay + aby * t - py;
  return qx * qx + qy * qy;
}
function clearPath(T, ax, ay, bx, by, s1, s2, cl) {
  const c2 = cl * cl;
  for (let i = 0; i < NB; i++) {
    if (!T.alive[i] || i === s1 || i === s2) continue;
    if (segD2(ax, ay, bx, by, T.x[i], T.y[i]) < c2) return false;
  }
  return true;
}
function aliveOf(T, group) {
  const out = [];
  for (const id of groupIds(group)) if (T.alive[id]) out.push(id);
  return out;
}
// 'solid'/'stripe' -> same, or 'eight' once that group is cleared; null stays null (open table)
function effGroup(T, g) { if (!g) return null; return aliveOf(T, g).length ? g : 'eight'; }
function targetsFor(T, g) {
  if (g === 'eight') return T.alive[8] ? [8] : [];
  if (!g) { const o = []; for (let i = 1; i < NB; i++) if (i !== 8 && T.alive[i]) o.push(i); return o; }
  return aliveOf(T, g);
}
function directShot(T, cx, cy, tid, pk) {
  const P = PK[pk], tx = T.x[tid], ty = T.y[tid];
  let ux = P.x - tx, uy = P.y - ty; const d2 = Math.hypot(ux, uy);
  if (d2 < 1) return null;
  ux /= d2; uy /= d2;
  if (ux * P.ax + uy * P.ay < P.min) return null;
  const gx = tx - ux * 2 * R, gy = ty - uy * 2 * R;
  if (gx < R || gx > TW - R || gy < R || gy > TH - R) return null;
  const vx = gx - cx, vy = gy - cy, d1 = Math.hypot(vx, vy);
  if (d1 < 0.5) return null;
  const cos = (vx * ux + vy * uy) / d1;
  if (cos < 0.2) return null;
  if (!clearPath(T, cx, cy, gx, gy, 0, tid, 2 * R - 1.5)) return null;
  if (!clearPath(T, tx, ty, P.x, P.y, tid, 0, 2 * R - 1.5)) return null;
  return { kind: 'direct', tid, pk, gx, gy, ang: Math.atan2(vy, vx), d1, d2, cut: Math.acos(Math.min(1, cos)), cos };
}
function bankShot(T, cx, cy, tid, pk, rail) {
  const P = PK[pk], tx = T.x[tid], ty = T.y[tid];
  let mx = P.x, my = P.y;
  if (rail === 0) mx = 2 * R - P.x; else if (rail === 1) mx = 2 * (TW - R) - P.x;
  else if (rail === 2) my = 2 * R - P.y; else my = 2 * (TH - R) - P.y;
  let ux = mx - tx, uy = my - ty; const dm = Math.hypot(ux, uy);
  if (dm < 40) return null;
  ux /= dm; uy /= dm;
  let s;
  if (rail === 0) s = (R - tx) / ux; else if (rail === 1) s = (TW - R - tx) / ux;
  else if (rail === 2) s = (R - ty) / uy; else s = (TH - R - ty) / uy;
  if (!(s > 8) || s > dm - 8) return null;
  const bx = tx + ux * s, by = ty + uy * s;
  if (rail < 2) { if (by < GC + 14 || by > TH - GC - 14) return null; }
  else if (!((bx > GC + 14 && bx < TW / 2 - GS - 10) || (bx > TW / 2 + GS + 10 && bx < TW - GC - 14))) return null;
  let wx = P.x - bx, wy = P.y - by; const dw = Math.hypot(wx, wy);
  wx /= dw; wy /= dw;
  if (wx * P.ax + wy * P.ay < P.min) return null;
  const gx = tx - ux * 2 * R, gy = ty - uy * 2 * R;
  if (gx < R || gx > TW - R || gy < R || gy > TH - R) return null;
  const vx = gx - cx, vy = gy - cy, d1 = Math.hypot(vx, vy);
  if (d1 < 0.5) return null;
  const cos = (vx * ux + vy * uy) / d1;
  if (cos < 0.4) return null;
  if (!clearPath(T, cx, cy, gx, gy, 0, tid, 2 * R - 1.5)) return null;
  if (!clearPath(T, tx, ty, bx, by, tid, 0, 2 * R - 1.5)) return null;
  if (!clearPath(T, bx, by, P.x, P.y, tid, 0, 2 * R - 1.5)) return null;
  return { kind: 'bank', tid, pk, gx, gy, ang: Math.atan2(vy, vx), d1, d2: (dm * 1.0) * 1.35, cut: Math.acos(Math.min(1, cos)), cos };
}
// quick 0..1 estimate of how good the best straight-in shot is from this layout
function easeScore(T, cx, cy, g) {
  const tg = targetsFor(T, g);
  let best = 0;
  for (let a = 0; a < tg.length; a++) for (let k = 0; k < 6; k++) {
    const s = directShot(T, cx, cy, tg[a], k);
    if (!s) continue;
    const D = s.d1 / 450 + s.d2 / 380 + (s.cut / 1.5708) * 3.2;
    const v = 1 - D / 6;
    if (v > best) best = v;
  }
  return best;
}
function tableFromObs(obs) {
  const T = newTable();
  for (const b of obs.balls) { T.x[b.id] = b.x; T.y[b.id] = b.y; T.alive[b.id] = 1; }
  return T;
}

// ---------------------------------------------------------------------------
// AUTOPILOT AI.  It sees only what is drawn: the observe() snapshot (ball ids + positions at rest,
// who owns which group, whether it is a break / ball-in-hand).  It knows the table physics and
// runs look-ahead simulations of candidate shots with that knowledge, spread over many ticks
// (generators yield every couple of sims).  Output is a shot {ang, speed, spin}; the game then
// adds the human aim error (sigma 0.25 deg).
// ---------------------------------------------------------------------------
// AI styles (picked at create()): posW scales cue-ball position play, oppW the penalty for leaving the
// opponent an easy table, nCand how many geometric candidates get simulated, pw the power multipliers
// tried, safe = plays a low-power safety when no decent pot exists.
const POOL_STYLES = [
  { name: 'Position player', posW: 1.3, oppW: 1, nCand: 11, pw: [1.12, 1.55, 2.2], safe: false },
  { name: 'Pot everything', posW: 0.45, oppW: 0.6, nCand: 16, pw: [1.2, 1.8, 2.6], safe: false },
  { name: 'Safety first', posW: 0.9, oppW: 2.6, nCand: 11, pw: [1.05, 1.4, 2.0], safe: true },
];
let STY = POOL_STYLES[0];
function* aiPlace(obs, out) {
  const T0 = tableFromObs(obs);
  if (obs.isBreak) {
    out.pos = { x: 232, y: TH / 2 + rnd.pick([-60, -30, 0, 0, 30, 60]) }; out.done = true; return;
  }
  const g = effGroup(T0, obs.group);
  let best = null, bs = -1, n = 0;
  for (let gx = 40; gx <= TW - 40; gx += 36) for (let gy = 40; gy <= TH - 40; gy += 36) {
    let ok = true;
    for (let i = 1; i < NB; i++) if (T0.alive[i] && (T0.x[i] - gx) ** 2 + (T0.y[i] - gy) ** 2 < (2 * R + 6) ** 2) { ok = false; break; }
    if (!ok) continue;
    T0.x[0] = gx; T0.y[0] = gy; T0.alive[0] = 1;
    const e = easeScore(T0, gx, gy, g) + rnd.float(0, 0.03);
    if (e > bs) { bs = e; best = { x: gx, y: gy }; }
    if (++n % 10 === 0) yield;
  }
  out.pos = best || { x: HEAD_X, y: TH / 2 };
  out.done = true;
}

function* aiPlan(obs, out) {
  const T0 = tableFromObs(obs), S = newTable();
  const cx = T0.x[0], cy = T0.y[0], group = obs.group, isBreak = obs.isBreak;
  const ownAlive = group ? aliveOf(T0, group).length > 0 : false;
  const ctx = { group, isBreak, ownAlive };
  const eg = effGroup(T0, group);
  const targets = targetsFor(T0, eg);
  yield;
  if (isBreak) {
    let bd = 1e9, bid = 1;
    for (const b of obs.balls) if (b.id) { const d = Math.hypot(b.x - cx, b.y - cy); if (d < bd) { bd = d; bid = b.id; } }
    out.hint = Math.atan2(T0.y[bid] - cy, T0.x[bid] - cx);
    out.result = { ang: out.hint, speed: 1330, spin: 0 }; out.done = true; return;
  }
  // ----- geometric candidates -----
  const cands = [];
  for (const tid of targets) for (let k = 0; k < 6; k++) {
    const s = directShot(T0, cx, cy, tid, k);
    if (s) { s.D = s.d1 / 450 + s.d2 / 380 + (s.cut / 1.5708) * 3.2; cands.push(s); }
  }
  cands.sort((a, b) => a.D - b.D);
  let list = cands.slice(0, STY.nCand);
  if (list.length < 4) {
    const banks = [];
    for (const tid of targets) for (let k = 0; k < 6; k++) for (let r = 0; r < 4; r++) {
      const s = bankShot(T0, cx, cy, tid, k, r);
      if (s) { s.D = 1.5 + s.d1 / 450 + s.d2 / 300 + (s.cut / 1.5708) * 3.2; banks.push(s); }
    }
    banks.sort((a, b) => a.D - b.D);
    list = list.concat(banks.slice(0, 8));
  }
  out.hint = list.length ? list[0].ang : null;
  const results = [];
  let simCount = 0;
  const evalShot = (ang, speed, spin) => {
    const ev = simShot(T0, S, ang, speed, spin);
    const J = judge(ctx, ev);
    return { sc: scoreOutcome(S, ev, J, ctx), J };
  };
  // ----- sims for the geometric candidates (3 power levels each; spin only when the plain shot works) -----
  for (const c of list) {
    const cosv = Math.max(c.cos, 0.3);
    const vo = invTravel(c.d2 + (c.kind === 'bank' ? 30 : 10));
    const vimp0 = vo / (c.kind === 'bank' ? Math.max(cosv, 0.5) : cosv);
    for (const m of STY.pw) {
      const vimp = Math.min(vimp0 * m, VMAX * 0.9);
      const v0 = Math.min(VMAX * 0.97, Math.max(140, invTravel(c.d1 + travel(vimp))));
      const r = evalShot(c.ang, v0, 0);
      results.push({ ang: c.ang, speed: v0, spin: 0, sc: r.sc, tid: c.tid });
      if (++simCount % 2 === 0) yield;
      if (r.sc > 200 && !r.J.foul) {
        for (const sp of [0.7, -0.7]) {
          const r2 = evalShot(c.ang, v0, sp);
          results.push({ ang: c.ang, speed: v0, spin: sp, sc: r2.sc, tid: c.tid });
          if (++simCount % 2 === 0) yield;
        }
      }
    }
  }
  // ----- fallbacks when nothing potted: straight hits, then rail kicks -----
  const bestSoFar = results.reduce((m, r) => Math.max(m, r.sc), -1e9);
  if (bestSoFar < 150) {
    for (const tid of targets) {
      const a0 = Math.atan2(T0.y[tid] - cy, T0.x[tid] - cx);
      for (const v of [260, 620, 1000]) {
        const r = evalShot(a0, v, 0); results.push({ ang: a0, speed: v, spin: 0, sc: r.sc, tid });
        if (++simCount % 2 === 0) yield;
      }
    }
    if (results.every(r => r.sc < -300)) {
      for (const tid of targets) for (let rail = 0; rail < 4; rail++) {
        let mx = T0.x[tid], my = T0.y[tid];
        if (rail === 0) mx = 2 * R - mx; else if (rail === 1) mx = 2 * (TW - R) - mx;
        else if (rail === 2) my = 2 * R - my; else my = 2 * (TH - R) - my;
        const a0 = Math.atan2(my - cy, mx - cx);
        for (const v of [500, 900]) {
          const r = evalShot(a0, v, 0); results.push({ ang: a0, speed: v, spin: 0, sc: r.sc, tid });
          if (++simCount % 2 === 0) yield;
        }
      }
    }
  }
  // ----- robustness check on the best few: re-sim with +-0.3 deg aim error and +-3% power -----
  if (STY.safe && Math.max(...results.map(r => r.sc), -1e9) < 260) {
    // no good pot: try soft safeties on legal balls, scored mostly on what they leave the opponent
    for (const tid of targets) {
      const a0 = Math.atan2(T0.y[tid] - cy, T0.x[tid] - cx);
      for (const v of [200, 330, 480]) for (const da of [0, 0.04, -0.04]) {
        const r = evalShot(a0 + da, v, 0); results.push({ ang: a0 + da, speed: v, spin: 0, sc: r.sc + 60, tid });
        if (++simCount % 2 === 0) yield;
      }
    }
  }
  for (const r of results) r.sc += rnd.float(0, 0.5);
  results.sort((a, b) => b.sc - a.sc);
  const clampS = v => Math.max(-2000, Math.min(2000, v));
  let bestR = null, bestF = -1e9;
  for (const r of results.slice(0, 8)) {
    const sc = [clampS(r.sc)];
    for (const [da, mv] of [[0.3 * DEG, 1], [-0.3 * DEG, 1], [0, 0.97], [0, 1.03]]) {
      sc.push(clampS(evalShot(r.ang + da, Math.min(VMAX, r.speed * mv), r.spin).sc));
      if (++simCount % 2 === 0) yield;
    }
    const mean = sc.reduce((a, b) => a + b, 0) / sc.length;
    const f = 0.5 * mean + 0.5 * Math.min(...sc) - r.speed * 0.04;
    if (f > bestF) { bestF = f; bestR = r; }
  }
  if (!bestR) bestR = { ang: Math.atan2(T0.y[targets[0]] - cy, T0.x[targets[0]] - cx), speed: 500, spin: 0 };
  out.hint = bestR.ang;
  { const e0 = simShot(T0, S, bestR.ang, bestR.speed, bestR.spin); out.pred = `first=${e0.first} pot=[${e0.potted}] sc=${bestR.sc.toFixed(0)}`; }
  out.result = { ang: bestR.ang, speed: bestR.speed, spin: bestR.spin };
  out.done = true;
}

// Score of one simulated outcome (higher is better) from the shooter's point of view.
function scoreOutcome(S, ev, J, ctx) {
  if (J.loss) return -1e5;
  if (J.win) return 1e5;
  let s = 0;
  if (J.foul) s -= J.scratch ? 700 : 520;
  const g1 = J.assign || ctx.group;
  let own = 0, opp = 0;
  for (const id of J.objPot) {
    if (id === 8) continue;
    const gg = groupOf(id);
    if (g1) { if (gg === g1) own++; else opp++; } else own++;
  }
  s += own * 230 - opp * 210;
  if (J.respot8) s -= 40;
  const cueIn = S.alive[0];
  if (!J.foul && J.continues && cueIn) {
    s += 120;
    s += 330 * STY.posW * Math.max(0, easeScore(S, S.x[0], S.y[0], effGroup(S, g1 || null)));
    if (!g1) s += 0;
  } else if (!J.foul && cueIn) {
    const og = g1 === 'solid' ? 'stripe' : g1 === 'stripe' ? 'solid' : null;
    s -= 170 * STY.oppW * Math.max(0, easeScore(S, S.x[0], S.y[0], og ? effGroup(S, og) : null));
  }
  return s;
}

// ---------------------------------------------------------------------------
// HOUSE BOT: easiest straight-in shot (no sims, no spin, no banks), noisy aim, rough power.
// ---------------------------------------------------------------------------
function houseBotPlan(obs) {
  const T0 = tableFromObs(obs), cx = T0.x[0], cy = T0.y[0];
  if (obs.isBreak) {
    let bd = 1e9, bid = 1;
    for (const b of obs.balls) if (b.id) { const d = Math.hypot(b.x - cx, b.y - cy); if (d < bd) { bd = d; bid = b.id; } }
    const a = Math.atan2(T0.y[bid] - cy, T0.x[bid] - cx);
    return { ang: a + rnd.gauss() * BOT_SIGMA, speed: 1180 + rnd.float(-60, 60), spin: 0 };
  }
  const targets = targetsFor(T0, effGroup(T0, obs.group));
  const cands = [];
  for (const tid of targets) for (let k = 0; k < 6; k++) {
    const s = directShot(T0, cx, cy, tid, k);
    if (s && s.cut < 1.05) { s.D = (s.d1 / 450 + s.d2 / 380 + (s.cut / 1.5708) * 3.2) * (1 + rnd.float(0, 0.2)); cands.push(s); }
  }
  if (cands.length) {
    cands.sort((a, b) => a.D - b.D);
    const S = newTable(), ctx = { group: obs.group, isBreak: false, ownAlive: obs.group ? aliveOf(T0, obs.group).length > 0 : false };
    let pick = null;
    const mk = c => {
      const vimp = invTravel(c.d2 + 10) / Math.max(c.cos, 0.35) * rnd.float(1.2, 1.7);
      return { c, v0: Math.min(1250, Math.max(220, invTravel(c.d1 + travel(Math.min(vimp, 1100))))) };
    };
    // a quick sanity sim of its few best-looking shots (no spin, no position play)
    let bestLeave = -1, found = 0;
    for (const c of cands.slice(0, BOT_LOOK)) {
      for (let a = 0; a < 2; a++) {
        const m = mk(c), ev = simShot(T0, S, c.ang, m.v0, 0), J = judge(ctx, ev);
        if (J.objPot.length && !J.foul && !J.loss) {
          const lv = S.alive[0] ? easeScore(S, S.x[0], S.y[0], effGroup(S, J.assign || obs.group)) : 0;
          if (lv > bestLeave) { bestLeave = lv; pick = m; }
          found++; break;
        }
      }
      if (found >= 3) break;
    }
    if (!pick) pick = mk(cands.length > 1 && rnd.float() < 0.5 ? rnd.pick(cands) : cands[0]);
    let noise = rnd.gauss() * BOT_SIGMA;
    if (rnd.float() < 0.02) noise += rnd.float(-1, 1) * 3.5 * DEG;
    return { ang: pick.c.ang + noise, speed: pick.v0, spin: 0 };
  }
  // nothing straight-in: just hit the closest legal ball
  let tid = targets[0], bd = 1e9;
  for (const t of targets) { const d = Math.hypot(T0.x[t] - cx, T0.y[t] - cy); if (d < bd) { bd = d; tid = t; } }
  return { ang: Math.atan2(T0.y[tid] - cy, T0.x[tid] - cx) + rnd.gauss() * BOT_SIGMA, speed: rnd.float(380, 700), spin: 0 };
}
function houseBotPlace(obs) {
  if (obs.isBreak) return { x: 232, y: TH / 2 + rnd.pick([-40, 0, 40]) };
  const T0 = tableFromObs(obs), g = effGroup(T0, obs.group);
  let best = { x: HEAD_X, y: TH / 2 }, bs = -1;
  for (let n = 0; n < 14; n++) {
    const gx = rnd.float(50, TW - 50), gy = rnd.float(50, TH - 50);
    let ok = true;
    for (let i = 1; i < NB; i++) if (T0.alive[i] && (T0.x[i] - gx) ** 2 + (T0.y[i] - gy) ** 2 < (2 * R + 6) ** 2) { ok = false; break; }
    if (!ok) continue;
    T0.x[0] = gx; T0.y[0] = gy; T0.alive[0] = 1;
    const e = easeScore(T0, gx, gy, g);
    if (e > bs) { bs = e; best = { x: gx, y: gy }; }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Ball orientation maths (fake 3D roll)
// ---------------------------------------------------------------------------
function rotCols(M, kx, ky, ang) {
  const c = Math.cos(ang), s = Math.sin(ang), omc = 1 - c;
  for (let col = 0; col < 3; col++) {
    const vx = M[col], vy = M[3 + col], vz = M[6 + col];
    const cx = ky * vz, cy = -kx * vz, cz = kx * vy - ky * vx;
    const dot = kx * vx + ky * vy;
    M[col] = vx * c + cx * s + kx * dot * omc;
    M[3 + col] = vy * c + cy * s + ky * dot * omc;
    M[6 + col] = vz * c + cz * s;
  }
}
function randOri() {
  const th = rnd.float(0, TAU), c = Math.cos(th), s = Math.sin(th);
  const M = [c, -s, 0, s, c, 0, 0, 0, 1];
  const phi = rnd.float(0, TAU);
  rotCols(M, Math.cos(phi), Math.sin(phi), rnd.float(0, 0.9));
  return M;
}
function renorm(M) {
  // Gram-Schmidt on columns
  let a = [M[0], M[3], M[6]], b = [M[1], M[4], M[7]];
  let l = Math.hypot(a[0], a[1], a[2]); a = a.map(v => v / l);
  const d = a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  b = [b[0] - a[0] * d, b[1] - a[1] * d, b[2] - a[2] * d];
  l = Math.hypot(b[0], b[1], b[2]); b = b.map(v => v / l);
  const c = [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  M[0] = a[0]; M[3] = a[1]; M[6] = a[2]; M[1] = b[0]; M[4] = b[1]; M[7] = b[2]; M[2] = c[0]; M[5] = c[1]; M[8] = c[2];
}

// ---------------------------------------------------------------------------
// Sprites (cached offscreen canvases)
// ---------------------------------------------------------------------------
const shadeCache = {}, shadowCache = {};
function shadeSprite(S) {
  if (shadeCache[S]) return shadeCache[S];
  const cv = document.createElement('canvas'); cv.width = cv.height = S;
  const g = cv.getContext('2d'), r = S / 2;
  let gr = g.createRadialGradient(r * 0.72, r * 0.64, r * 0.05, r, r, r);
  gr.addColorStop(0, 'rgba(255,255,255,0.10)'); gr.addColorStop(0.45, 'rgba(10,15,40,0)');
  gr.addColorStop(0.82, 'rgba(5,10,35,0.28)'); gr.addColorStop(1, 'rgba(2,5,25,0.72)');
  g.fillStyle = gr; g.beginPath(); g.arc(r, r, r, 0, TAU); g.fill();
  g.save(); g.beginPath(); g.arc(r, r, r, 0, TAU); g.clip();
  gr = g.createRadialGradient(r * 0.66, r * 0.56, 0, r * 0.66, r * 0.56, r * 0.5);
  gr.addColorStop(0, 'rgba(255,255,255,0.95)'); gr.addColorStop(0.3, 'rgba(255,255,255,0.45)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = gr; g.fillRect(0, 0, S, S);
  gr = g.createRadialGradient(r * 1.25, r * 1.4, r * 0.3, r * 1.25, r * 1.4, r * 0.85);
  gr.addColorStop(0, 'rgba(150,190,255,0.0)'); gr.addColorStop(0.8, 'rgba(150,190,255,0.12)'); gr.addColorStop(1, 'rgba(150,190,255,0)');
  g.fillStyle = gr; g.fillRect(0, 0, S, S);
  g.restore();
  return (shadeCache[S] = cv);
}
function shadowSprite() {
  if (shadowCache.s) return shadowCache.s;
  const S = 96, cv = document.createElement('canvas'); cv.width = cv.height = S;
  const g = cv.getContext('2d');
  const gr = g.createRadialGradient(S / 2, S / 2, S * 0.12, S / 2, S / 2, S / 2);
  gr.addColorStop(0, 'rgba(0,0,0,0.55)'); gr.addColorStop(0.55, 'rgba(0,0,0,0.28)'); gr.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = gr; g.fillRect(0, 0, S, S);
  return (shadowCache.s = cv);
}

function renderBallSprite(b, S) {
  if (!b.cv || b.cv.width !== S) {
    b.cv = document.createElement('canvas'); b.cv.width = b.cv.height = S;
    b.cx2 = b.cv.getContext('2d'); b.img = b.cx2.createImageData(S, S);
  }
  const d = b.img.data, M = b.M, id = b.id;
  const col = RGB[id <= 8 ? id : id - 8], striped = id > 8, cue = id === 0;
  const inv = 2 / S;
  for (let py = 0; py < S; py++) {
    const ny = (py + 0.5) * inv - 1;
    for (let px = 0; px < S; px++) {
      const nx = (px + 0.5) * inv - 1, r2 = nx * nx + ny * ny, idx = (py * S + px) * 4;
      if (r2 > 1.1) { d[idx + 3] = 0; continue; }
      const rr = Math.sqrt(r2);
      let cov = (1 - rr) * S * 0.5 + 0.5;
      if (cov <= 0) { d[idx + 3] = 0; continue; }
      if (cov > 1) cov = 1;
      const nz = Math.sqrt(Math.max(0, 1 - r2));
      const qy = M[1] * nx + M[4] * ny + M[7] * nz;
      const qz = M[2] * nx + M[5] * ny + M[8] * nz;
      let r = col[0], g = col[1], bl = col[2];
      if (striped) {
        const w = smooth01((Math.abs(qy) - 0.52) * 14 + 0.5);
        r += (244 - r) * w; g += (240 - g) * w; bl += (232 - bl) * w;
      }
      const aqz = qz < 0 ? -qz : qz;
      if (!cue) {
        const w = smooth01((aqz - 0.86) * 24 + 0.5);
        r += (246 - r) * w; g += (243 - g) * w; bl += (236 - bl) * w;
      } else {
        const w = smooth01((aqz - 0.965) * 60 + 0.5);
        r += (200 - r) * w; g += (60 - g) * w; bl += (50 - bl) * w;
      }
      d[idx] = r; d[idx + 1] = g; d[idx + 2] = bl; d[idx + 3] = cov * 255;
    }
  }
  b.cx2.putImageData(b.img, 0, 0);
  b.sver = b.ver; b.sS = S; b.acc = 0;
}

// ---------------------------------------------------------------------------
// The game
// ---------------------------------------------------------------------------
const PH = { RACK: 0, PLACE: 1, THINK: 2, ALIGN: 3, PULL: 4, HOLD: 5, STRIKE: 6, ROLL: 7, JUDGE: 8, END: 9 };
const TRAY = { x0: TW / 2 - 240, x1: TW / 2 + 240, y: TH + RAIL + 28, h: 36 };
const slotX = i => TRAY.x1 - 22 - i * 30;
const angDiff = (a, b) => { let d = a - b; while (d > Math.PI) d -= TAU; while (d < -Math.PI) d += TAU; return d; };

function create() {
  STY = rnd.pick(POOL_STYLES);
  let W = 1600, H = 900, scale = 1, ox = 0, oy = 0;
  let cache = null, cacheKey = '';
  let bgGrad = null, vigGrad = null, bgKey = '';
  const T = newTable();
  const PX = new Float64Array(NB), PY = new Float64Array(NB);
  const balls = [];
  for (let i = 0; i < NB; i++) balls.push({ id: i, M: randOri(), ver: 0, sver: -1, sS: 0, acc: 0, cv: null, upd: 0 });
  const particles = new Particles();
  const players = [
    { name: 'AUTOPILOT', col: AI_COL, group: null },
    { name: 'HOUSE BOT', col: BOT_COL, group: null },
  ];
  const motes = [];
  for (let i = 0; i < 34; i++) motes.push({ x: rnd.float(0, TW), y: rnd.float(-40, TH), vx: rnd.float(-5, 5), vy: rnd.float(-3, 1.5), s: rnd.float(0.6, 2), p: rnd.float(0, TAU) });

  const G = {
    over: false, won: false,
    phase: PH.RACK, pt: 0, time: 0, turn: 0, shotNo: 0, isBreak: true, inHand: true,
    sinks: [], tray: [], toasts: [], ev: newEv(true), plan: null, ctrlOut: null, gen: null,
    cue: { ang: 0, pang: 0, pull: 30, ppull: 30, alpha: 0, palpha: 0, who: 0 },
    cueAppear: 0, ring: null, placeHold: 0, finish: null, resultText: '', restT: 0, thinkMin: 1.3,
    camKick: 0, lastLog: '', potCount: [0, 0], endT: 0, flash: 0,
  };

  // ---- rack ----
  function setupRack() {
    const ids = [];
    const rest = rnd.shuffle([1, 2, 3, 4, 5, 6, 7, 9, 10, 11, 12, 13, 14, 15]);
    // positions row-major: (r,c); centre = row 2 col 1 => 8 ; back corners one solid one stripe
    const solids = rest.filter(i => i < 8), stripes = rest.filter(i => i > 8);
    const corner = rnd.float() < 0.5 ? [solids.pop(), stripes.pop()] : [stripes.pop(), solids.pop()];
    const others = rnd.shuffle(solids.concat(stripes));
    const layout = [];
    let oi = 0;
    for (let r = 0; r < 5; r++) for (let c = 0; c <= r; c++) {
      let id;
      if (r === 2 && c === 1) id = 8;
      else if (r === 4 && c === 0) id = corner[0];
      else if (r === 4 && c === 4) id = corner[1];
      else id = others[oi++];
      layout.push({ id, r, c });
    }
    const dxr = Math.sqrt(3) * R + 0.15, dyr = 2 * R + 0.15;
    for (const L of layout) {
      T.x[L.id] = FOOT_X + L.r * dxr; T.y[L.id] = TH / 2 + (L.c - L.r / 2) * dyr;
      T.alive[L.id] = 1;
    }
    T.alive[0] = 0; T.x[0] = 230; T.y[0] = TH / 2;
    for (let i = 0; i < NB; i++) { T.vx[i] = 0; T.vy[i] = 0; PX[i] = T.x[i]; PY[i] = T.y[i]; }
    G.rackDx = dxr;
  }
  setupRack();
  G.turn = rnd.float() < 0.5 ? 0 : 1;

  // ---- observation: only what is visible on screen ----
  function observe() {
    const out = [];
    for (let i = 0; i < NB; i++) if (T.alive[i]) out.push({ id: i, x: T.x[i], y: T.y[i] });
    return { balls: out, group: players[G.turn].group, isBreak: G.isBreak, inHand: G.inHand, openTable: !players[0].group && !players[1].group };
  }

  function toast(text, sub, col, dur = 2.2) { G.toasts.push({ text, sub: sub || '', col: col || '#f1e7d2', t: 0, dur }); if (G.toasts.length > 3) G.toasts.shift(); }

  // ---- turn flow ----
  function beginTurn() {
    G.shotNo++;
    G.cue.who = G.turn;
    if (G.inHand) beginPlace(); else beginThink();
  }
  function beginPlace() {
    const obs = observe();
    G.phase = PH.PLACE; G.pt = 0; G.cueAppear = 0; G.placeDone = false;
    const hadCue = !!T.alive[0];
    G.cueFadeOut = hadCue ? 1 : 0;
    G.oldCue = hadCue ? { x: T.x[0], y: T.y[0] } : null;
    if (hadCue) T.alive[0] = 0;
    if (G.turn === 0) { G.ctrlOut = { done: false, pos: null }; G.gen = aiPlace(obs, G.ctrlOut); }
    else { G.ctrlOut = { done: true, pos: houseBotPlace(obs) }; G.gen = null; }
    G.cue.alpha = 0;
  }
  function beginThink() {
    const obs = observe();
    G.phase = PH.THINK; G.pt = 0;
    if (G.turn === 0) { G.ctrlOut = { done: false, hint: null, result: null }; G.gen = aiPlan(obs, G.ctrlOut); G.thinkMin = G.isBreak ? 1.0 : 1.3; }
    else { G.ctrlOut = { done: true, hint: null, result: houseBotPlan(obs) }; G.ctrlOut.hint = G.ctrlOut.result.ang; G.gen = null; G.thinkMin = G.isBreak ? 0.8 : 1.0; }
    // cue stick starts off to the side, pointing roughly at the table
    const cx = T.x[0], cy = T.y[0];
    let toward = Math.atan2(TH / 2 - cy, TW / 2 - cx);
    G.cue.ang = G.cue.pang = toward + rnd.float(-0.9, 0.9);
    G.cue.pull = G.cue.ppull = 120; G.cue.alpha = G.cue.palpha = 0;
  }
  function stepGen(n) {
    if (!G.gen) return;
    for (let i = 0; i < n; i++) { const r = G.gen.next(); if (r.done) { G.gen = null; G.ctrlOut.done = true; break; } }
  }

  function fire() {
    const p = G.plan, c = G.cue;
    const sp = Math.min(VMAX, p.speed * (1 + rnd.gauss() * (G.turn === 0 ? 0.008 : 0.03)));
    T.vx[0] = Math.cos(c.ang) * sp; T.vy[0] = Math.sin(c.ang) * sp; T.spin = p.spin || 0;
    G.ev = newEv(true);
    G.phase = PH.ROLL; G.pt = 0; G.restT = 0; G.rollT = 0;
    G.camKick = Math.min(1, sp / 1300);
    const tipx = T.x[0] + Math.cos(c.ang) * -R, tipy = T.y[0] + Math.sin(c.ang) * -R;
    particles.burst(T.x[0] - Math.cos(c.ang) * R, T.y[0] - Math.sin(c.ang) * R, 7, { speed: 60 + sp * 0.05, speedMin: 12, life: 0.7, size: 1.8, color: ['#8fb0ff', '#6e8fe0', '#c9d6ff'], drag: 3 });
    void tipx; void tipy;
  }

  function resumeAfterShot() {
    // called from JUDGE after the pause
    if (G.finish) return;
    G.turn = G.nextTurn;
    G.inHand = G.nextInHand;
    beginTurn();
  }

  function doJudge() {
    const shooter = G.turn, P = players[shooter];
    const ownAlive = P.group ? G.groupAliveBefore : false;
    const ctx = { group: P.group, isBreak: G.isBreak, ownAlive };
    const ev = G.ev;
    const J = judge(ctx, ev);
    G.lastJ = J;
    (G.log || (G.log = [])).push(`t=${G.time.toFixed(0)} shot${G.shotNo} P${shooter} grp=${P.group} v=${G.plan ? G.plan.speed.toFixed(0) : '-'} first=${ev.first} pot=[${ev.potted}] foul=${J.foul ? J.reason : ''} cont=${J.continues} | pred ${G.ctrlOut && G.ctrlOut.pred}`);
    const name = P.name === 'AUTOPILOT' ? 'Autopilot' : 'House bot';
    // 8 on the break: respot
    if (J.respot8) {
      const dxr = G.rackDx;
      let rx = FOOT_X + 2 * dxr, ry = TH / 2;
      for (let tries = 0; tries < 40; tries++) {
        let ok = true;
        for (let i = 0; i < NB; i++) if (T.alive[i] && (T.x[i] - rx) ** 2 + (T.y[i] - ry) ** 2 < (2 * R + 1) ** 2) { ok = false; break; }
        if (ok) break; rx += 2 * R + 2;
        if (rx > TW - 30) { rx = FOOT_X; ry += 2 * R + 2; }
      }
      T.x[8] = rx; T.y[8] = ry; T.vx[8] = T.vy[8] = 0; T.alive[8] = 1; PX[8] = rx; PY[8] = ry;
      const ti = G.tray.findIndex(t => t.id === 8); if (ti >= 0) G.tray.splice(ti, 1);
      G.sinks = G.sinks.filter(s => s.id !== 8);
      toast('8-BALL RESPOTTED', 'Potted on the break', '#f1e7d2');
    }
    if (J.win || J.loss) {
      const winner = J.win ? shooter : 1 - shooter;
      G.finish = { winner, t: 0 };
      G.finishText = J.win ? `${name} sank the 8-ball to clear the table` : `${name} ${J.lossWhy}`;
      G.shooterWon8 = J.win;
      G.phase = PH.END; G.endT = 0;
      toast(winner === 0 ? 'AUTOPILOT WINS' : 'HOUSE BOT WINS', J.win ? '8-ball sunk' : name + ' ' + J.lossWhy, players[winner].col, 4);
      if (winner === 0) celebrate();
      return;
    }
    if (J.assign) {
      P.group = J.assign; players[1 - shooter].group = J.assign === 'solid' ? 'stripe' : 'solid';
      toast(`${name.toUpperCase()}: ${J.assign === 'solid' ? 'SOLIDS' : 'STRIPES'}`, 'Table is closed', P.col);
    }
    if (J.foul) {
      toast(J.reason.toUpperCase(), 'Ball in hand for ' + (shooter === 0 ? 'House bot' : 'Autopilot'), '#ff8a70');
      G.nextTurn = 1 - shooter; G.nextInHand = true;
    } else if (J.continues) {
      G.nextTurn = shooter; G.nextInHand = false;
      if (!J.assign && J.objPot.length) toast('POTTED', '', P.col, 1.2);
    } else {
      G.nextTurn = 1 - shooter; G.nextInHand = false;
    }
    G.isBreak = false;
    G.phase = PH.JUDGE; G.pt = 0;
  }

  function celebrate() {
    for (let k = 0; k < 90; k++) particles.burst(rnd.float(150, TW - 150), rnd.float(80, TH - 80), 1, { speed: 260, speedMin: 60, life: 1.8, size: 3.4, gravity: 120, color: ['#f6d58c', '#f0b445', '#ffffff', '#ffd9a0'], drag: 1.2 });
  }

  // ---- tick ----
  function updateOri(i, dx, dy) {
    const d = Math.hypot(dx, dy);
    if (d < 1e-5) return;
    const b = balls[i];
    rotCols(b.M, -dy / d, dx / d, d / R);
    b.ver++; b.acc += d / R; if ((b.ver & 127) === 0) renorm(b.M);
  }

  function step(dt) {
    G.time += dt; G.pt += dt;
    for (let i = 0; i < NB; i++) { PX[i] = T.x[i]; PY[i] = T.y[i]; }
    const c = G.cue; c.pang = c.ang; c.ppull = c.pull; c.palpha = c.alpha;
    particles.update(dt);
    if (G.camKick > 0) G.camKick = Math.max(0, G.camKick - dt * 1.4);
    for (const t of G.toasts) t.t += dt;
    G.toasts = G.toasts.filter(t => t.t < t.dur);
    if (G.ring) { G.ring.t += dt; if (G.ring.t > 0.9) G.ring = null; }
    // sinks -> tray
    for (let i = G.sinks.length - 1; i >= 0; i--) {
      const s = G.sinks[i]; s.pt = s.t; s.t += dt;
      if (s.t >= 0.32) {
        G.sinks.splice(i, 1);
        if (s.id !== 0) {
          G.tray.push({ id: s.id, x: TRAY.x0 + 4, px: TRAY.x0 + 4, y: TRAY.y, tx: slotX(G.tray.length), a: 0 });
        }
      }
    }
    for (let k = 0; k < G.tray.length; k++) {
      const it = G.tray[k]; it.px = it.x; it.tx = slotX(k); it.a = Math.min(1, it.a + dt * 6);
      const dx = it.tx - it.x;
      if (Math.abs(dx) > 0.05) {
        const st = Math.min(Math.abs(dx), (30 + Math.abs(dx) * 3.6) * dt) * Math.sign(dx);
        it.x += st; balls[it.id].ver++; rotCols(balls[it.id].M, 0, 1, st / (R * 0.85)); balls[it.id].acc += Math.abs(st) / R;
      }
    }
    if (G.time > TIME_CAP && !G.finish && G.phase !== PH.END) {
      G.finish = { winner: 1, t: 0 }; G.finishText = 'Out of time'; G.phase = PH.END; G.endT = 0;
      toast('OUT OF TIME', '', '#ff8a70', 3);
    }

    switch (G.phase) {
      case PH.RACK:
        if (G.pt > 1.7) { G.isBreak = true; G.inHand = true; beginTurn(); }
        break;
      case PH.PLACE: {
        const o = G.ctrlOut;
        if (G.gen) stepGen(3);
        if (G.cueFadeOut > 0) G.cueFadeOut = Math.max(0, G.cueFadeOut - dt * 3.5);
        if (!G.placeDone && o.done && G.cueFadeOut <= 0 && G.pt > 0.35) {
          T.x[0] = o.pos.x; T.y[0] = o.pos.y; T.vx[0] = T.vy[0] = 0; T.alive[0] = 1; PX[0] = T.x[0]; PY[0] = T.y[0];
          G.ring = { x: o.pos.x, y: o.pos.y, t: 0 }; G.placeDone = true; G.placeT0 = G.pt;
        }
        if (G.placeDone) {
          G.cueAppear = Math.min(1, (G.pt - G.placeT0) / 0.45);
          if (G.pt - G.placeT0 > 0.55) { G.cueAppear = 1; beginThink(); }
        }
        break;
      }
      case PH.THINK: {
        stepGen(1);
        const o = G.ctrlOut;
        c.alpha = Math.min(1, c.alpha + dt * 3);
        // pull settles to a hovering distance
        c.pull += (26 + Math.sin(G.time * 2.1) * 3 - c.pull) * (1 - Math.exp(-dt * 3));
        let target = o.hint != null ? o.hint : c.ang;
        const dd = angDiff(target, c.ang);
        const mx = 1.6 * dt;
        c.ang += Math.max(-mx, Math.min(mx, dd * (1 - Math.exp(-dt * 3.2))));
        c.ang += Math.sin(G.time * 1.3) * 0.0006;
        if (o.done && o.result && G.pt >= G.thinkMin) {
          const sg = G.turn === 0 ? AI_SIGMA : 0;       // house bot noise already applied in its plan
          G.plan = { ang: o.result.ang + rnd.gauss() * sg, speed: o.result.speed, spin: o.result.spin };
          G.alignFrom = c.ang; G.alignD = angDiff(G.plan.ang, c.ang);
          G.phase = PH.ALIGN; G.pt = 0;
        }
        break;
      }
      case PH.ALIGN: {
        const u = Math.min(1, G.pt / 0.45);
        c.ang = G.alignFrom + G.alignD * ease.inOutCubic(u);
        c.pull += (26 - c.pull) * (1 - Math.exp(-dt * 6));
        if (u >= 1) { c.ang = G.plan.ang; G.phase = PH.PULL; G.pt = 0; G.pullMax = 22 + 90 * Math.pow(G.plan.speed / VMAX, 0.8); G.pullStart = c.pull; G.pullDur = 0.35 + 0.3 * (G.plan.speed / VMAX); }
        break;
      }
      case PH.PULL: {
        const u = Math.min(1, G.pt / G.pullDur);
        c.pull = G.pullStart + (G.pullMax - G.pullStart) * ease.inOutCubic(u);
        if (u >= 1) { G.phase = PH.HOLD; G.pt = 0; }
        break;
      }
      case PH.HOLD:
        c.pull = G.pullMax + Math.sin(G.pt * 40) * 0.5;
        if (G.pt > 0.15) { G.phase = PH.STRIKE; G.pt = 0; G.strikeDur = 0.13 - 0.06 * (G.plan.speed / VMAX); }
        break;
      case PH.STRIKE: {
        const u = Math.min(1, G.pt / G.strikeDur);
        c.pull = G.pullMax * (1 - u * u) - 0;       // gap shrinks to 0 at contact
        if (u >= 1) { c.pull = 0; G.groupAliveBefore = players[G.turn].group ? aliveOf(T, players[G.turn].group).length > 0 : false; fire(); }
        break;
      }
      case PH.ROLL: case PH.END: case PH.JUDGE: {
        if (G.phase === PH.ROLL) {
          G.rollT += dt;
          let nm = 0;
          for (let s = 0; s < SUB; s++) nm = Math.max(nm, physStep(T, H_STEP, G.ev));
          for (let i = 0; i < NB; i++) if (T.alive[i]) updateOri(i, T.x[i] - PX[i], T.y[i] - PY[i]);
          const pq = G.ev.pq;
          for (const q of pq) {
            const P = PK[q.pk];
            G.sinks.push({ id: q.id, sx: q.x, sy: q.y, pk: q.pk, t: 0, pt: 0, sp: q.sp });
            particles.burst(P.x + P.ax * -14, P.y + P.ay * -14, 10, { speed: 150, speedMin: 30, life: 0.7, size: 2.6, color: ['#f6d58c', '#f0b445', '#fff4d0'], drag: 3 });
          }
          pq.length = 0;
          const fx = G.ev.fx;
          for (let k = 0; k < fx.length; k += 4) {
            const kind = fx[k], x = fx[k + 1], y = fx[k + 2], sp = fx[k + 3];
            if (particles.list.length > 260) break;
            if (kind === 0) particles.burst(x, y, Math.min(5, 1 + (sp / 250) | 0), { speed: 40 + sp * 0.12, speedMin: 15, life: 0.35, size: 1.7, color: ['#fff4d8', '#b9d0ff'], drag: 5 });
            else particles.burst(x, y, 2, { speed: 20 + sp * 0.06, speedMin: 6, life: 0.4, size: 1.4, color: ['#4d7fd0', '#8fb0ff'], drag: 5 });
          }
          fx.length = 0;
          if (G.rollT > 22) { for (let i = 0; i < NB; i++) { T.vx[i] = 0; T.vy[i] = 0; } nm = 0; }
          // cue follow-through
          if (G.rollT < 0.14) c.pull = -6 * Math.sin(G.rollT / 0.14 * Math.PI * 0.5) + 0;
          else { c.pull = Math.min(70, c.pull + 260 * dt * (G.rollT - 0.14)); c.alpha = Math.max(0, c.alpha - dt * 3.2); }
          if (nm === 0 && G.sinks.length === 0) { G.restT += dt; if (G.restT > 0.35) doJudge(); } else G.restT = 0;
        } else if (G.phase === PH.JUDGE) {
          c.alpha = Math.max(0, c.alpha - dt * 4);
          if (G.pt > 0.6) resumeAfterShot();
        } else {
          // END: let things settle, then finish
          G.endT += dt; c.alpha = Math.max(0, c.alpha - dt * 4);
          let moving = false;
          for (let s = 0; s < SUB; s++) if (physStep(T, H_STEP, G.ev)) moving = true;
          for (let i = 0; i < NB; i++) if (T.alive[i]) updateOri(i, T.x[i] - PX[i], T.y[i] - PY[i]);
          for (const q of G.ev.pq) G.sinks.push({ id: q.id, sx: q.x, sy: q.y, pk: q.pk, t: 0, pt: 0, sp: q.sp });
          G.ev.pq.length = 0; G.ev.fx.length = 0;
          if (G.endT > 1.8 && !G.over) {
            G.over = true; G.won = G.finish.winner === 0;
            G.resultText = G.finishText;
          }
          if (G.won && G.endT < 3 && Math.random() < 0.15) particles.burst(rnd.float(150, TW - 150), rnd.float(60, TH - 60), 6, { speed: 200, life: 1.3, size: 3, gravity: 140, color: ['#f6d58c', '#f0b445', '#fff'], drag: 1.3 });
        }
        break;
      }
    }
    if (G.phase !== PH.ROLL && G.phase !== PH.END) {
      // keep the follow-through sane when not rolling
    }
  }

  // -----------------------------------------------------------------------
  // Layout / cache
  // -----------------------------------------------------------------------
  const BOX_X0 = -RAIL, BOX_X1 = TW + RAIL, BOX_Y0 = -RAIL - 60, BOX_Y1 = TH + RAIL + 52;
  function resize(w, h) {
    W = w; H = h;
    const bw = BOX_X1 - BOX_X0, bh = BOX_Y1 - BOX_Y0;
    scale = Math.min((W * 0.94) / bw, (H * 0.95) / bh);
    ox = W / 2 - scale * (TW / 2);
    oy = (H - scale * bh) / 2 - scale * BOX_Y0 - H * 0.006;
    cache = null;
  }

  function buildCache() {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const cs = Math.max(0.5, Math.min(2.1, scale * dpr));
    const pad = 70;
    const x0 = -RAIL - pad, y0 = -RAIL - pad, w = TW + 2 * RAIL + 2 * pad, h = TH + 2 * RAIL + 2 * pad;
    const cv = document.createElement('canvas');
    cv.width = Math.ceil(w * cs); cv.height = Math.ceil(h * cs);
    const g = cv.getContext('2d');
    g.setTransform(cs, 0, 0, cs, -x0 * cs, -y0 * cs);
    const rr = (x, y, ww, hh, r) => roundRect(g, x, y, ww, hh, r);
    // table shadow
    g.save(); g.shadowColor = 'rgba(0,0,0,0.65)'; g.shadowBlur = 46 * cs; g.shadowOffsetY = 18 * cs;
    g.fillStyle = '#000'; rr(-RAIL, -RAIL, TW + 2 * RAIL, TH + 2 * RAIL, 26); g.fill(); g.restore();
    // wood frame
    let gr = g.createLinearGradient(0, -RAIL, 0, TH + RAIL);
    gr.addColorStop(0, '#6a301c'); gr.addColorStop(0.5, '#4a2012'); gr.addColorStop(1, '#2f130c');
    g.fillStyle = gr; rr(-RAIL, -RAIL, TW + 2 * RAIL, TH + 2 * RAIL, 26); g.fill();
    // grain
    g.save(); rr(-RAIL, -RAIL, TW + 2 * RAIL, TH + 2 * RAIL, 26); g.clip();
    let seed = 7; const sr = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    for (let i = 0; i < 260; i++) {
      const horiz = sr() < 0.5;
      g.strokeStyle = `rgba(${sr() < 0.5 ? '20,6,2' : '150,80,50'},${0.05 + sr() * 0.09})`; g.lineWidth = 0.5 + sr() * 1.6;
      g.beginPath();
      if (horiz) { const yy = -RAIL + sr() * (TH + 2 * RAIL); g.moveTo(-RAIL, yy); g.bezierCurveTo(TW * 0.3, yy + (sr() - 0.5) * 8, TW * 0.7, yy + (sr() - 0.5) * 8, TW + RAIL, yy + (sr() - 0.5) * 6); }
      else { const xx = -RAIL + sr() * (TW + 2 * RAIL); g.moveTo(xx, -RAIL); g.bezierCurveTo(xx + (sr() - 0.5) * 8, TH * 0.3, xx + (sr() - 0.5) * 8, TH * 0.7, xx + (sr() - 0.5) * 6, TH + RAIL); }
      g.stroke();
    }
    g.restore();
    // outer bevel + brass trim
    g.lineWidth = 2; g.strokeStyle = 'rgba(255,200,150,0.22)'; rr(-RAIL + 1, -RAIL + 1, TW + 2 * RAIL - 2, TH + 2 * RAIL - 2, 25); g.stroke();
    g.lineWidth = 1.6; g.strokeStyle = 'rgba(201,162,75,0.55)'; rr(-RAIL + 7, -RAIL + 7, TW + 2 * RAIL - 14, TH + 2 * RAIL - 14, 19); g.stroke();
    // cloth
    g.fillStyle = '#0f2547'; g.fillRect(-CD, -CD, TW + 2 * CD, TH + 2 * CD);
    gr = g.createRadialGradient(TW * 0.5, TH * 0.46, 20, TW * 0.5, TH * 0.46, 640);
    gr.addColorStop(0, 'rgba(90,150,235,0.55)'); gr.addColorStop(0.4, 'rgba(50,100,185,0.28)'); gr.addColorStop(1, 'rgba(0,0,15,0.55)');
    g.fillStyle = gr; g.fillRect(-CD, -CD, TW + 2 * CD, TH + 2 * CD);
    // cloth speckle
    g.save(); g.beginPath(); g.rect(-CD, -CD, TW + 2 * CD, TH + 2 * CD); g.clip();
    for (let i = 0; i < 2600; i++) { g.fillStyle = sr() < 0.5 ? 'rgba(255,255,255,0.035)' : 'rgba(0,0,20,0.06)'; g.fillRect(sr() * TW, sr() * TH, 1 + sr() * 1.4, 1 + sr() * 1.4); }
    // spots
    g.fillStyle = 'rgba(210,225,255,0.22)';
    for (const [sx, sy] of [[HEAD_X, TH / 2], [FOOT_X + 30, TH / 2]]) { g.beginPath(); g.arc(sx, sy, 2.4, 0, TAU); g.fill(); }
    g.strokeStyle = 'rgba(210,225,255,0.10)'; g.lineWidth = 1; g.setLineDash([5, 7]);
    g.beginPath(); g.moveTo(HEAD_X, 8); g.lineTo(HEAD_X, TH - 8); g.stroke(); g.setLineDash([]);
    g.restore();
    // cushions
    const cush = (pts) => {
      g.beginPath(); g.moveTo(pts[0][0], pts[0][1]); for (let i = 1; i < pts.length; i++) g.lineTo(pts[i][0], pts[i][1]); g.closePath();
    };
    const segsH = [[GC, TW / 2 - GS], [TW / 2 + GS, TW - GC]];
    const segsV = [[GC, TH - GC]];
    const cl = '#0b1c3b';
    for (const [a, b] of segsH) {
      // top
      g.fillStyle = cl; cush([[a, 0], [b, 0], [b + CD * 0.9, -CD], [a - CD * 0.9, -CD]]); g.fill();
      g.strokeStyle = 'rgba(140,180,255,0.30)'; g.lineWidth = 1.4; g.beginPath(); g.moveTo(a, 0); g.lineTo(b, 0); g.stroke();
      g.fillStyle = cl; cush([[a, TH], [b, TH], [b + CD * 0.9, TH + CD], [a - CD * 0.9, TH + CD]]); g.fill();
      g.beginPath(); g.moveTo(a, TH); g.lineTo(b, TH); g.stroke();
    }
    for (const [a, b] of segsV) {
      g.fillStyle = cl; cush([[0, a], [0, b], [-CD, b + CD * 0.9], [-CD, a - CD * 0.9]]); g.fill();
      g.strokeStyle = 'rgba(140,180,255,0.30)'; g.lineWidth = 1.4; g.beginPath(); g.moveTo(0, a); g.lineTo(0, b); g.stroke();
      g.fillStyle = cl; cush([[TW, a], [TW, b], [TW + CD, b + CD * 0.9], [TW + CD, a - CD * 0.9]]); g.fill();
      g.beginPath(); g.moveTo(TW, a); g.lineTo(TW, b); g.stroke();
    }
    // cushion shadow on cloth
    g.save(); g.beginPath(); g.rect(0, 0, TW, TH); g.clip();
    const sh = (x1, y1, x2, y2, rx, ry, rw, rh) => { const gg = g.createLinearGradient(x1, y1, x2, y2); gg.addColorStop(0, 'rgba(0,0,12,0.38)'); gg.addColorStop(1, 'rgba(0,0,12,0)'); g.fillStyle = gg; g.fillRect(rx, ry, rw, rh); };
    sh(0, 0, 0, 16, 0, 0, TW, 16); sh(0, TH, 0, TH - 16, 0, TH - 16, TW, 16);
    sh(0, 0, 16, 0, 0, 0, 16, TH); sh(TW, 0, TW - 16, 0, TW - 16, 0, 16, TH);
    g.restore();
    // wood inner edge shadow
    g.strokeStyle = 'rgba(0,0,0,0.5)'; g.lineWidth = 2; rr(-CD - 1, -CD - 1, TW + 2 * CD + 2, TH + 2 * CD + 2, 5); g.stroke();
    // pockets
    for (const P of PK) {
      const hr = P.r * 0.8;
      g.fillStyle = '#26160e'; g.beginPath(); g.arc(P.x, P.y, hr + 9, 0, TAU); g.fill();
      g.strokeStyle = 'rgba(201,162,75,0.7)'; g.lineWidth = 2; g.beginPath(); g.arc(P.x, P.y, hr + 9.5, 0, TAU); g.stroke();
      const hg = g.createRadialGradient(P.x - 3, P.y - 3, 3, P.x, P.y, hr + 2);
      hg.addColorStop(0, '#030303'); hg.addColorStop(0.7, '#08060a'); hg.addColorStop(1, '#1b1210');
      g.fillStyle = hg; g.beginPath(); g.arc(P.x, P.y, hr, 0, TAU); g.fill();
      g.strokeStyle = 'rgba(80,50,30,0.8)'; g.lineWidth = 3; g.beginPath(); g.arc(P.x, P.y, hr + 1.5, 0, TAU); g.stroke();
    }
    // diamonds
    const diamond = (x, y) => {
      g.save(); g.translate(x, y); g.rotate(Math.PI / 4);
      const dg = g.createLinearGradient(-4, -4, 4, 4); dg.addColorStop(0, '#f3dc9a'); dg.addColorStop(0.5, '#c9a24b'); dg.addColorStop(1, '#7a5a1e');
      g.fillStyle = dg; g.fillRect(-4, -4, 8, 8); g.strokeStyle = 'rgba(0,0,0,0.5)'; g.lineWidth = 0.8; g.strokeRect(-4, -4, 8, 8); g.restore();
    };
    const dyT = -(CD + (RAIL - CD) / 2 - 1);
    for (const fx of [0.125, 0.25, 0.375, 0.625, 0.75, 0.875]) { diamond(TW * fx, dyT); diamond(TW * fx, TH - dyT); }
    for (const fy of [0.25, 0.5, 0.75]) { diamond(dyT, TH * fy); diamond(TW - dyT, TH * fy); }
    // brass corner plates
    for (const [cx, cy] of [[-RAIL + 15, -RAIL + 15], [TW + RAIL - 15, -RAIL + 15], [-RAIL + 15, TH + RAIL - 15], [TW + RAIL - 15, TH + RAIL - 15]]) {
      const bg = g.createRadialGradient(cx - 3, cy - 3, 1, cx, cy, 12); bg.addColorStop(0, '#f6e2a6'); bg.addColorStop(0.6, '#b8903a'); bg.addColorStop(1, '#6d4f19');
      g.fillStyle = bg; g.beginPath(); g.arc(cx, cy, 9, 0, TAU); g.fill();
      g.strokeStyle = 'rgba(0,0,0,0.4)'; g.lineWidth = 0.8; g.stroke();
    }
    // tray (below)
    const ty = TRAY.y - TRAY.h / 2;
    g.save(); g.shadowColor = 'rgba(0,0,0,0.6)'; g.shadowBlur = 14 * cs; g.shadowOffsetY = 5 * cs;
    gr = g.createLinearGradient(0, ty, 0, ty + TRAY.h); gr.addColorStop(0, '#2a150d'); gr.addColorStop(1, '#4b2415');
    g.fillStyle = gr; rr(TRAY.x0 - 14, ty - 4, TRAY.x1 - TRAY.x0 + 28, TRAY.h + 8, 14); g.fill(); g.restore();
    g.strokeStyle = 'rgba(201,162,75,0.55)'; g.lineWidth = 1.5; rr(TRAY.x0 - 14, ty - 4, TRAY.x1 - TRAY.x0 + 28, TRAY.h + 8, 14); g.stroke();
    gr = g.createLinearGradient(0, ty + 4, 0, ty + TRAY.h - 4); gr.addColorStop(0, '#0c0605'); gr.addColorStop(1, '#1d0f09');
    g.fillStyle = gr; rr(TRAY.x0, ty + 4, TRAY.x1 - TRAY.x0, TRAY.h - 8, 10); g.fill();
    for (let i = 0; i < 15; i++) { g.strokeStyle = 'rgba(255,255,255,0.04)'; g.beginPath(); g.arc(slotX(i), TRAY.y, R * 0.85 + 2, 0, TAU); g.stroke(); }
    cache = { cv, x0, y0, w, h };
  }

  // -----------------------------------------------------------------------
  // Drawing
  // -----------------------------------------------------------------------
  function drawBg(ctx) {
    const key = W + 'x' + H;
    if (key !== bgKey) {
      bgKey = key;
      bgGrad = ctx.createRadialGradient(W / 2, H * 0.45, H * 0.1, W / 2, H * 0.5, Math.max(W, H) * 0.75);
      bgGrad.addColorStop(0, '#2b1d14'); bgGrad.addColorStop(0.5, '#170f0b'); bgGrad.addColorStop(1, '#070504');
      vigGrad = ctx.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.35, W / 2, H / 2, Math.max(W, H) * 0.78);
      vigGrad.addColorStop(0, 'rgba(0,0,0,0)'); vigGrad.addColorStop(1, 'rgba(0,0,0,0.55)');
    }
    ctx.fillStyle = bgGrad; ctx.fillRect(0, 0, W, H);
    // slow floor planks, very faint
    ctx.save(); ctx.globalAlpha = 0.05; ctx.strokeStyle = '#c9a27a'; ctx.lineWidth = 1;
    const off = (G.time * 3) % 90;
    for (let x = -90 + off; x < W + 90; x += 90) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x - 40, H); ctx.stroke(); }
    ctx.restore();
  }

  function drawBall(ctx, id, X, Y, k, alpha, darkness) {
    // k = scale factor of the ball radius (1 = R)
    const b = balls[id], rad = R * k;
    const ta = ctx.getTransform().a;
    let S = Math.round(2 * rad * ta); if (S < 12) S = 12; if (S > 72) S = 72;
    if (b.sver !== b.ver && b.sS === S && b.acc < 0.045) { /* reuse slightly stale albedo while rolling */ }
    else if (b.sver !== b.ver || b.sS !== S || !b.cv) renderBallSprite(b, S);
    ctx.save();
    if (alpha < 1) ctx.globalAlpha = alpha;
    ctx.drawImage(b.cv, X - rad, Y - rad, 2 * rad, 2 * rad);
    // numbers (fake 3D: the disc moves across the sphere with the roll)
    if (id !== 0) {
      const M = b.M;
      for (let side = -1; side <= 1; side += 2) {
        const z = side * M[8];
        if (z < 0.12) continue;
        const cx = X + side * M[2] * rad, cy = Y + side * M[5] * rad;
        const f = rad / 10;
        ctx.save();
        ctx.globalAlpha = (alpha < 1 ? alpha : 1) * smooth01((z - 0.12) / 0.3);
        ctx.transform(side * M[0] * f, side * M[3] * f, M[1] * f, M[4] * f, cx, cy);
        ctx.fillStyle = '#141414'; ctx.font = '700 7.4px Fredoka, "Trebuchet MS", sans-serif';
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText(String(id), 0, 0.4);
        if (id === 6 || id === 9) { ctx.fillRect(-2.4, 4.4, 4.8, 0.9); }
        ctx.restore();
      }
    }
    ctx.drawImage(shadeSprite(S), X - rad, Y - rad, 2 * rad, 2 * rad);
    if (darkness) { ctx.globalAlpha = darkness; ctx.fillStyle = '#000'; ctx.beginPath(); ctx.arc(X, Y, rad, 0, TAU); ctx.fill(); }
    ctx.restore();
  }
  function drawShadow(ctx, X, Y, k, alpha) {
    const s = R * k * 2.7;
    ctx.globalAlpha = alpha; ctx.drawImage(shadowSprite(), X - s / 2 + 3.2 * k, Y - s / 2 + 5 * k, s, s); ctx.globalAlpha = 1;
  }

  function raycast(cx, cy, ang) {
    const dx = Math.cos(ang), dy = Math.sin(ang);
    let bt = 1e9, hit = -1;
    for (let i = 1; i < NB; i++) {
      if (!T.alive[i]) continue;
      const fx = T.x[i] - cx, fy = T.y[i] - cy, b = fx * dx + fy * dy;
      if (b <= 0) continue;
      const c = fx * fx + fy * fy - 4 * R * R, disc = b * b - c;
      if (disc < 0) continue;
      const t = b - Math.sqrt(disc);
      if (t > 0 && t < bt) { bt = t; hit = i; }
    }
    let wt = 1e9;
    if (dx < -1e-6) wt = Math.min(wt, (R - cx) / dx); else if (dx > 1e-6) wt = Math.min(wt, (TW - R - cx) / dx);
    if (dy < -1e-6) wt = Math.min(wt, (R - cy) / dy); else if (dy > 1e-6) wt = Math.min(wt, (TH - R - cy) / dy);
    return { t: Math.min(bt, wt), hit: bt < wt ? hit : -1, dx, dy };
  }

  function drawAim(ctx, a) {
    const c = G.cue;
    let vis = 0;
    if (G.phase === PH.THINK) vis = 0.5 * c.alpha; else if (G.phase === PH.ALIGN || G.phase === PH.PULL || G.phase === PH.HOLD) vis = 0.9;
    else if (G.phase === PH.STRIKE) vis = 0.7;
    if (vis <= 0.01 || !T.alive[0]) return;
    const cx = T.x[0], cy = T.y[0], ang = c.pang + angDiff(c.ang, c.pang) * a;
    const rc = raycast(cx, cy, ang);
    const ex = cx + rc.dx * rc.t, ey = cy + rc.dy * rc.t;
    ctx.save();
    ctx.lineCap = 'round';
    ctx.strokeStyle = `rgba(255,236,190,${0.55 * vis})`; ctx.lineWidth = 1.6;
    ctx.setLineDash([7, 9]); ctx.lineDashOffset = -G.time * 26;
    ctx.beginPath(); ctx.moveTo(cx + rc.dx * R * 1.2, cy + rc.dy * R * 1.2); ctx.lineTo(ex, ey); ctx.stroke();
    ctx.setLineDash([]);
    if (rc.hit >= 0) {
      const ob = rc.hit, nx = T.x[ob] - ex, ny = T.y[ob] - ey, nl = Math.hypot(nx, ny) || 1;
      ctx.strokeStyle = `rgba(255,236,190,${0.7 * vis})`; ctx.lineWidth = 1.4;
      ctx.beginPath(); ctx.arc(ex, ey, R, 0, TAU); ctx.stroke();
      const lg = ctx.createLinearGradient(T.x[ob], T.y[ob], T.x[ob] + nx / nl * 120, T.y[ob] + ny / nl * 120);
      lg.addColorStop(0, `rgba(255,236,190,${0.75 * vis})`); lg.addColorStop(1, 'rgba(255,236,190,0)');
      ctx.strokeStyle = lg; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(T.x[ob] + nx / nl * R, T.y[ob] + ny / nl * R); ctx.lineTo(T.x[ob] + nx / nl * 120, T.y[ob] + ny / nl * 120); ctx.stroke();
      // cue-ball deflection tangent
      let tx = -ny / nl, ty = nx / nl; if (tx * rc.dx + ty * rc.dy < 0) { tx = -tx; ty = -ty; }
      const cosc = Math.abs(rc.dx * nx / nl + rc.dy * ny / nl), len = 70 * (1 - cosc * 0.6);
      ctx.strokeStyle = `rgba(180,210,255,${0.45 * vis})`; ctx.lineWidth = 1.2;
      ctx.beginPath(); ctx.moveTo(ex + tx * R, ey + ty * R); ctx.lineTo(ex + tx * (R + len), ey + ty * (R + len)); ctx.stroke();
    } else {
      ctx.strokeStyle = `rgba(255,236,190,${0.6 * vis})`; ctx.lineWidth = 1.4;
      ctx.beginPath(); ctx.arc(ex, ey, 3, 0, TAU); ctx.stroke();
    }
    ctx.restore();
  }

  function drawCue(ctx, a) {
    const c = G.cue;
    const alpha = c.palpha + (c.alpha - c.palpha) * a;
    if (alpha <= 0.01 || !T.alive[0]) return;
    const ang = c.pang + angDiff(c.ang, c.pang) * a;
    const pull = c.ppull + (c.pull - c.ppull) * a;
    const cx = PX[0] + (T.x[0] - PX[0]) * a, cy = PY[0] + (T.y[0] - PY[0]) * a;
    const col = players[G.cue.who].col;
    ctx.save();
    ctx.translate(cx, cy); ctx.rotate(ang);
    const tip = -(R + 1.5 + pull), L = 640;
    const poly = (xa, xb, wa, wb) => { ctx.beginPath(); ctx.moveTo(xa, -wa); ctx.lineTo(xb, -wb); ctx.lineTo(xb, wb); ctx.lineTo(xa, wa); ctx.closePath(); };
    const wAt = x => 2.1 + (-(x - tip)) / L * -3.4 * -1; // placeholder, overwritten below
    void wAt;
    const w0 = 2.3, w1 = 4.6, wAtF = d => w0 + (w1 - w0) * (d / L);
    // shadow
    ctx.save(); ctx.translate(4, 7); ctx.globalAlpha = alpha * 0.28; ctx.fillStyle = '#000'; poly(tip, tip - L, w0, w1); ctx.fill(); ctx.restore();
    ctx.globalAlpha = alpha;
    // shaft (maple)
    const sh = ctx.createLinearGradient(0, -w1, 0, w1);
    sh.addColorStop(0, '#f7e3b4'); sh.addColorStop(0.5, '#d9b87a'); sh.addColorStop(1, '#a17c45');
    ctx.fillStyle = sh; poly(tip - 14, tip - 330, wAtF(14), wAtF(330)); ctx.fill();
    // butt (dark wood)
    const bt = ctx.createLinearGradient(0, -w1, 0, w1);
    bt.addColorStop(0, '#5b2c1c'); bt.addColorStop(0.5, '#3a1810'); bt.addColorStop(1, '#22100a');
    ctx.fillStyle = bt; poly(tip - 330, tip - L, wAtF(330), wAtF(L)); ctx.fill();
    // wrap accent in player colour + brass rings
    ctx.fillStyle = col; ctx.globalAlpha = alpha * 0.85; poly(tip - 380, tip - 392, wAtF(380), wAtF(392)); ctx.fill(); poly(tip - 398, tip - 402, wAtF(398), wAtF(402)); ctx.fill();
    ctx.globalAlpha = alpha; ctx.fillStyle = '#c9a24b'; poly(tip - 328, tip - 334, wAtF(328), wAtF(334)); ctx.fill();
    // ferrule + tip
    ctx.fillStyle = '#efe8d8'; poly(tip - 2, tip - 14, w0 - 0.1, wAtF(14)); ctx.fill();
    ctx.fillStyle = '#3f6cc4'; poly(tip, tip - 2.4, w0 - 0.3, w0 - 0.1); ctx.fill();
    // highlight
    ctx.globalAlpha = alpha * 0.35; ctx.fillStyle = '#fff'; poly(tip - 20, tip - 330, wAtF(20) * -0.45, wAtF(330) * -0.45 + 0.0); ctx.fill();
    ctx.restore();
  }

  function drawRackFrame(ctx) {
    if (G.phase !== PH.RACK) return;
    const t = G.pt;
    const lift = ease.outCubic(smooth01((t - 1.0) / 0.7));
    const a = 1 - lift;
    if (a <= 0.01) return;
    const dxr = G.rackDx, X0 = FOOT_X, m = R + 2.5;
    const xa = X0 - 2 * m, xb = X0 + 4 * dxr + m, hh = (xb - xa) * Math.tan(Math.PI / 6);
    ctx.save();
    ctx.globalAlpha = a;
    ctx.translate(-lift * 6, -lift * 14);
    ctx.lineJoin = 'round';
    ctx.strokeStyle = 'rgba(0,0,0,0.35)'; ctx.lineWidth = 7; ctx.beginPath();
    ctx.moveTo(xa + 3, TH / 2 + 5); ctx.lineTo(xb + 3, TH / 2 - hh + 5); ctx.lineTo(xb + 3, TH / 2 + hh + 5); ctx.closePath(); ctx.stroke();
    ctx.strokeStyle = '#7a3b22'; ctx.lineWidth = 6;
    ctx.beginPath(); ctx.moveTo(xa, TH / 2); ctx.lineTo(xb, TH / 2 - hh); ctx.lineTo(xb, TH / 2 + hh); ctx.closePath(); ctx.stroke();
    ctx.strokeStyle = 'rgba(201,162,75,0.85)'; ctx.lineWidth = 1.4; ctx.stroke();
    ctx.restore();
  }

  function groupIcons(ctx, g, x, y, dir) {
    // returns nothing; draws 7 (+8) icons starting at x going in dir
    const ids = g ? groupIds(g) : null;
    for (let i = 0; i < 8; i++) {
      const cx = x + dir * i * 21, id = i < 7 ? (ids ? ids[i] : 0) : 8;
      const present = id === 8 ? !!T.alive[8] : (ids ? T.alive[id] : 0);
      const on8 = i === 7 && g && aliveOf(T, g).length === 0;
      ctx.beginPath(); ctx.arc(cx, y, 7.5, 0, TAU);
      if (ids || i === 7) {
        if (present) {
          ctx.fillStyle = ballHex(id); ctx.globalAlpha = (i === 7 && !on8) ? 0.4 : 1; ctx.fill();
          if (id > 8) { ctx.strokeStyle = '#f4efe3'; ctx.lineWidth = 2.2; ctx.beginPath(); ctx.arc(cx, y, 5.6, 0, TAU); ctx.stroke(); }
          ctx.globalAlpha = 1;
        } else { ctx.strokeStyle = 'rgba(241,231,210,0.25)'; ctx.lineWidth = 1.2; ctx.stroke(); }
        if (on8 && i === 7) { ctx.strokeStyle = '#f6d58c'; ctx.lineWidth = 1.6; ctx.beginPath(); ctx.arc(cx, y, 10.5, 0, TAU); ctx.stroke(); }
      } else {
        ctx.strokeStyle = 'rgba(241,231,210,0.16)'; ctx.lineWidth = 1.2; ctx.stroke();
      }
    }
  }

  function drawPlates(ctx) {
    const y = BOX_Y0 + 4, hgt = 46;
    const plates = [
      { p: players[0], x: -RAIL, w: TW / 2 + RAIL - 100, dir: 1, idx: 0 },
      { p: players[1], x: TW / 2 + 100, w: TW / 2 + RAIL - 100, dir: -1, idx: 1 },
    ];
    const active = (G.phase === PH.END || G.over) ? -1 : G.turn;
    for (const pl of plates) {
      const on = pl.idx === active;
      ctx.save();
      roundRect(ctx, pl.x, y, pl.w, hgt, 12);
      const gr = ctx.createLinearGradient(0, y, 0, y + hgt); gr.addColorStop(0, on ? 'rgba(48,34,22,0.92)' : 'rgba(26,18,13,0.85)'); gr.addColorStop(1, 'rgba(14,9,6,0.9)');
      ctx.fillStyle = gr; ctx.fill();
      ctx.lineWidth = on ? 2 : 1; ctx.strokeStyle = on ? pl.p.col : 'rgba(241,231,210,0.14)'; ctx.stroke();
      if (on) { ctx.globalAlpha = 0.16 + 0.06 * Math.sin(G.time * 3); ctx.lineWidth = 7; ctx.stroke(); ctx.globalAlpha = 1; }
      const tx = pl.dir > 0 ? pl.x + 18 : pl.x + pl.w - 18;
      ctx.fillStyle = on ? pl.p.col : 'rgba(241,231,210,0.5)';
      ctx.font = '800 22px "Big Shoulders Display", Impact, sans-serif'; ctx.textBaseline = 'middle';
      ctx.textAlign = pl.dir > 0 ? 'left' : 'right';
      ctx.fillText(pl.p.name, tx, y + 16);
      ctx.font = '600 10.5px "IBM Plex Mono", monospace'; ctx.fillStyle = 'rgba(241,231,210,0.55)';
      const gl = pl.p.group ? (pl.p.group === 'solid' ? 'SOLIDS' : 'STRIPES') : 'OPEN';
      ctx.fillText(gl, tx, y + 35);
      const ix = pl.dir > 0 ? pl.x + pl.w - 18 - 7 * 21 - 6 : pl.x + 18 + 7 * 21 + 6;
      // icons run toward the outer edge
      const startX = pl.dir > 0 ? pl.x + pl.w - 16 - 7 * 21 : pl.x + 16 + 7 * 21;
      void ix;
      groupIcons(ctx, pl.p.group, startX, y + hgt / 2, pl.dir);
      ctx.restore();
    }
    // centre marker
    ctx.save();
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.font = '600 11px "IBM Plex Mono", monospace'; ctx.fillStyle = 'rgba(241,231,210,0.55)';
    const open = !players[0].group;
    ctx.fillText(open ? 'OPEN TABLE' : 'SHOT ' + G.shotNo, TW / 2, y + 15);
    ctx.font = '800 17px "Big Shoulders Display", Impact, sans-serif'; ctx.fillStyle = '#c9a24b';
    ctx.fillText('VELVET BREAK', TW / 2, y + 33);
    ctx.restore();
  }

  function drawToasts(ctx) {
    let k = 0;
    for (const t of G.toasts) {
      const u = t.t / t.dur, a = Math.min(1, t.t / 0.2) * Math.min(1, (t.dur - t.t) / 0.4);
      const y = TH / 2 - 8 - k * 58 - (1 - ease.outCubic(Math.min(1, t.t / 0.3))) * 14;
      ctx.save(); ctx.globalAlpha = a;
      ctx.font = '800 34px "Big Shoulders Display", Impact, sans-serif';
      const w = Math.max(220, ctx.measureText(t.text).width + 54), h = t.sub ? 58 : 46;
      roundRect(ctx, TW / 2 - w / 2, y - h / 2, w, h, 14);
      ctx.fillStyle = 'rgba(10,8,6,0.78)'; ctx.fill();
      ctx.strokeStyle = t.col; ctx.lineWidth = 1.5; ctx.stroke();
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillStyle = t.col;
      ctx.fillText(t.text, TW / 2, y - (t.sub ? 9 : 0));
      if (t.sub) { ctx.font = '500 14px Fredoka, sans-serif'; ctx.fillStyle = 'rgba(241,231,210,0.8)'; ctx.fillText(t.sub, TW / 2, y + 16); }
      ctx.restore(); void u; k++;
    }
  }

  function draw(ctx, w, h) {
    if (w !== W || h !== H) resize(w, h);
    drawBg(ctx);
    if (!cache) buildCache();
    const a = alphaNow();
    const tm = G.time;
    const camX = Math.sin(tm * 0.11) * 3, camY = Math.cos(tm * 0.09) * 2.4;
    const zoom = 1 + 0.004 * Math.sin(tm * 0.07) + G.camKick * 0.0045;
    ctx.save();
    ctx.translate(ox + camX * scale, oy + camY * scale);
    ctx.translate(scale * TW / 2, scale * TH / 2); ctx.scale(scale * zoom, scale * zoom); ctx.translate(-TW / 2, -TH / 2);
    ctx.drawImage(cache.cv, cache.x0, cache.y0, cache.w, cache.h);
    // moving lamp sheen on the cloth
    ctx.save(); ctx.beginPath(); ctx.rect(0, 0, TW, TH); ctx.clip();
    const lx = TW * 0.5 + Math.sin(tm * 0.16) * 70, ly = TH * 0.44 + Math.cos(tm * 0.13) * 30;
    const lg = ctx.createRadialGradient(lx, ly, 10, lx, ly, 330);
    lg.addColorStop(0, 'rgba(255,240,205,0.13)'); lg.addColorStop(1, 'rgba(255,240,205,0)');
    ctx.fillStyle = lg; ctx.fillRect(0, 0, TW, TH);
    ctx.restore();
    // chalk-free stuff: aim assist under balls
    drawAim(ctx, a);
    // balls: shadows then spheres
    const showCue = T.alive[0] || G.phase === PH.PLACE;
    for (let i = 0; i < NB; i++) {
      if (!T.alive[i]) continue;
      const X = PX[i] + (T.x[i] - PX[i]) * a, Y = PY[i] + (T.y[i] - PY[i]) * a;
      let al = 1, k = 1;
      if (i === 0 && G.phase === PH.PLACE) { al = ease.outCubic(G.cueAppear); k = 0.7 + 0.3 * ease.outBack(G.cueAppear); }
      drawShadow(ctx, X, Y, k, 0.9 * al);
    }
    for (let i = 0; i < NB; i++) {
      if (!T.alive[i]) continue;
      const X = PX[i] + (T.x[i] - PX[i]) * a, Y = PY[i] + (T.y[i] - PY[i]) * a;
      let al = 1, k = 1;
      if (i === 0 && G.phase === PH.PLACE) { al = ease.outCubic(G.cueAppear); k = 0.7 + 0.3 * ease.outBack(G.cueAppear); }
      drawBall(ctx, i, X, Y, k, al, 0);
    }
    void showCue;
    if (G.phase === PH.PLACE && G.cueFadeOut > 0 && G.oldCue) {
      drawBall(ctx, 0, G.oldCue.x, G.oldCue.y, 1, G.cueFadeOut, 0);
    }
    if (G.ring) {
      const u = G.ring.t / 0.9, e = ease.outCubic(u);
      ctx.save(); ctx.strokeStyle = `rgba(255,236,190,${0.8 * (1 - u)})`; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(G.ring.x, G.ring.y, R + 4 + e * 26, 0, TAU); ctx.stroke(); ctx.restore();
    }
    drawRackFrame(ctx);
    // sinking balls
    for (const s of G.sinks) {
      const u = smooth01((s.pt + (s.t - s.pt) * a) / 0.32), P = PK[s.pk];
      const e = u * u;
      const X = s.sx + (P.x - P.ax * -5 - s.sx) * e, Y = s.sy + (P.y - P.ay * -5 - s.sy) * e;
      drawBall(ctx, s.id, X, Y, 1 - 0.5 * u, 1 - 0.55 * u, 0.65 * u);
    }
    drawCue(ctx, a);
    particles.draw(ctx, 1);
    // dust motes in the lamp light
    ctx.save(); ctx.globalCompositeOperation = 'lighter';
    for (const m of motes) {
      const x = ((m.x + tm * m.vx) % (TW + 100) + TW + 100) % (TW + 100) - 50;
      const y = ((m.y + tm * m.vy + Math.sin(tm * 0.4 + m.p) * 14) % (TH + 100) + TH + 100) % (TH + 100) - 50;
      const dl = Math.hypot(x - TW / 2, y - TH / 2) / 600;
      ctx.globalAlpha = Math.max(0, 0.22 * (1 - dl)) * (0.6 + 0.4 * Math.sin(tm * 0.9 + m.p));
      ctx.fillStyle = '#ffeccc'; ctx.beginPath(); ctx.arc(x, y, m.s, 0, TAU); ctx.fill();
    }
    ctx.restore();
    // tray balls
    for (const it of G.tray) {
      const x = it.px + (it.x - it.px) * a;
      drawBall(ctx, it.id, x, it.y, 0.85, it.a, 0);
    }
    drawPlates(ctx);
    drawToasts(ctx);
    // end overlay
    if (G.phase === PH.END && G.finish) {
      const u = smooth01(G.endT / 0.9);
      ctx.save();
      ctx.globalAlpha = u * 0.35; ctx.fillStyle = G.finish.winner === 0 ? '#2a1a05' : '#1a0505'; ctx.fillRect(-CD, -CD, TW + 2 * CD, TH + 2 * CD);
      ctx.restore();
    }
    ctx.restore();
    // vignette over the whole frame
    ctx.fillStyle = vigGrad; ctx.fillRect(0, 0, W, H);
  }

  function hud() {
    const ai = players[0], hb = players[1];
    const left = g => (g ? aliveOf(T, g).length : 7);
    const score = ai.group ? `AI ${7 - left(ai.group)}/7 · HOUSE ${7 - left(hb.group)}/7` : 'Open table';
    let detail = `Shot ${G.shotNo} · ${players[G.turn].name === 'AUTOPILOT' ? 'Autopilot' : 'House bot'} to shoot`;
    if (G.over) detail = G.won ? 'Rack won' : 'Rack lost';
    return { score, detail };
  }
  function result() { return (G.resultText || (G.won ? 'Cleared the rack' : 'Lost the rack')) + ' (' + STY.name + ')'; }

  const inst = {
    style: STY.name, resize, step, draw, hud, result, _G: G, _T: T, _dbg: { aiPlan, tableFromObs, directShot, simShot, newTable, judge, invTravel, travel },
    get over() { return G.over; }, get won() { return G.won; },
  };
  return inst;
}

Arcade.register({
  id: 'pool', name: 'Velvet Break', genre: 'Pool · 8-ball',
  aiNote: "Sees the table as drawn and simulates the known physics for each shot, but adds about a quarter degree of human aim error.",
  blurb: 'The Autopilot breaks and runs the rack against a house bot: ghost-ball aim, banks, and cue-ball position.',
  bg: '#0f2547', accent: '#c9a24b', create,
});
})();
