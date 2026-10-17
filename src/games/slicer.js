// slicer.js — Orchard Slash: fruit slicing in a night zen garden.
// Fixed 60 Hz logic. World is 900 units tall (width follows aspect). Everything drawn at
// lerp(prev, cur, Arcade.alpha) so it stays smooth on high-refresh displays.
(() => {
'use strict';

const WORLD_H = 900;
const GRAV = 1250;
const FRUIT_R = 56, BOMB_R = 48;
const GOAL = 300;
const LIVES = 3;
const BLADE_VMAX = 3500;     // max hand speed, u/s (≈ 3500 px/s at 900 px tall)
const BLADE_ACC = 70000;     // max hand acceleration, u/s^2
const BLADE_ACTIVE = 650;    // blade only cuts above this speed
const CHAIN_WIN = 0.28;      // slices closer together than this form one combo
const TIME_CAP = 360;
const STEP = 1 / 60;

const alphaNow = () => (typeof Arcade !== 'undefined' && Arcade.alpha != null ? Arcade.alpha : 1);
const mk = (w, h) => { const c = document.createElement('canvas'); c.width = Math.max(2, Math.ceil(w)); c.height = Math.max(2, Math.ceil(h)); return c; };
function mulberry32(a) { return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const hypot = Math.hypot;

// ---------------------------------------------------------------------------
// Fruit art. Each type draws a whole fruit and a cut half (dome up, flat edge on y=cy).
// ---------------------------------------------------------------------------
function halfPath(g, cx, cy, rx, ry) { g.beginPath(); g.ellipse(cx, cy, Math.max(1, rx), Math.max(1, ry), 0, Math.PI, TAU); g.closePath(); }
function discGrad(g, cx, cy, R, stops, ox = -0.35, oy = -0.4) {
  const gr = g.createRadialGradient(cx + R * ox, cy + R * oy, R * 0.08, cx, cy, R * 1.08);
  stops.forEach((c, i) => gr.addColorStop(i / (stops.length - 1), c));
  return gr;
}
function halfFruit(g, cx, cy, R, o) {
  const rx = (o.rx || 1) * R, ry = (o.ry || 1) * R;
  if (o.pre) o.pre(g, cx, cy, R);
  halfPath(g, cx, cy, rx, ry);
  const sg = g.createLinearGradient(0, cy - ry, 0, cy); sg.addColorStop(0, o.skin[0]); sg.addColorStop(1, o.skin[1]);
  g.fillStyle = sg; g.fill();
  const sk = R * 0.055, rw = R * (o.rindW ?? 0.08);
  halfPath(g, cx, cy, rx - sk, ry - sk); g.fillStyle = o.rind; g.fill();
  const fr = Math.min(rx, ry) - sk - rw;
  halfPath(g, cx, cy, rx - sk - rw, ry - sk - rw);
  const fg = g.createRadialGradient(cx, cy, 0, cx, cy, R);
  fg.addColorStop(0, o.flesh[0]); fg.addColorStop(1, o.flesh[1]);
  g.fillStyle = fg; g.fill();
  g.save(); g.clip();
  if (o.extra) o.extra(g, cx, cy, fr);
  g.restore();
  // wet sheen near the top-left of the flesh
  g.strokeStyle = 'rgba(255,255,255,0.32)'; g.lineWidth = Math.max(1, R * 0.045); g.lineCap = 'round';
  g.beginPath(); g.ellipse(cx, cy, Math.max(1, rx - sk - rw - R * 0.06), Math.max(1, ry - sk - rw - R * 0.06), 0, Math.PI * 1.05, Math.PI * 1.42); g.stroke();
  // glassy cut edge
  g.strokeStyle = 'rgba(255,255,255,0.35)'; g.lineWidth = Math.max(1, R * 0.03);
  g.beginPath(); g.moveTo(cx - rx + sk, cy); g.lineTo(cx + rx - sk, cy); g.stroke();
  g.strokeStyle = 'rgba(0,0,0,0.25)'; g.lineWidth = Math.max(1, R * 0.025);
  halfPath(g, cx, cy, rx, ry); g.stroke();
}
function rimLine(g, R) { g.strokeStyle = 'rgba(0,0,0,0.28)'; g.lineWidth = Math.max(1.5, R * 0.035); g.stroke(); }
function seededDots(rng, n, R, fn) { for (let i = 0; i < n; i++) { const a = rng() * TAU, d = Math.sqrt(rng()) * R; fn(Math.cos(a) * d, Math.sin(a) * d, rng); } }

const TYPES = [
  { id: 'melon', juice: ['#ff4f6d', '#ff8aa0', '#ffd3dc'], stain: '255,70,105', rx: 1, ry: 1,
    whole(g, cx, cy, R) {
      g.beginPath(); g.arc(cx, cy, R, 0, TAU); g.fillStyle = discGrad(g, cx, cy, R, ['#8fd36a', '#459a3d', '#1b5226']); g.fill();
      g.save(); g.clip(); g.strokeStyle = 'rgba(12,58,26,0.55)'; g.lineWidth = R * 0.12; g.lineCap = 'round';
      for (const k of [-0.85, -0.57, -0.29, 0, 0.29, 0.57, 0.85]) { g.beginPath(); g.moveTo(cx, cy - R * 1.05); g.quadraticCurveTo(cx + k * R * 2.0, cy, cx, cy + R * 1.05); g.stroke(); }
      g.restore(); g.beginPath(); g.arc(cx, cy, R, 0, TAU); rimLine(g, R);
    },
    half: { skin: ['#3f8f3c', '#1d5a2a'], rind: '#d7ecae', rindW: 0.07, flesh: ['#ff7088', '#e0304c'],
      extra(g, cx, cy, R) { g.fillStyle = '#1a0f12'; for (let i = 0; i < 7; i++) { const a = Math.PI + (i + 0.5) / 7 * Math.PI, d = R * (0.35 + 0.28 * (i % 2)); g.save(); g.translate(cx + Math.cos(a) * d, cy + Math.sin(a) * d); g.rotate(a + Math.PI / 2); g.beginPath(); g.ellipse(0, 0, R * 0.035, R * 0.07, 0, 0, TAU); g.fill(); g.restore(); } } } },
  { id: 'orange', juice: ['#ff9a1c', '#ffbf55', '#ffe2a0'], stain: '255,150,30', rx: 1, ry: 1,
    whole(g, cx, cy, R) {
      g.beginPath(); g.arc(cx, cy, R, 0, TAU); g.fillStyle = discGrad(g, cx, cy, R, ['#ffc65e', '#f48a14', '#b04c08']); g.fill();
      const rng = mulberry32(7); g.save(); g.clip();
      seededDots(rng, 110, R, (x, y, r) => { g.fillStyle = 'rgba(150,60,0,0.30)'; g.beginPath(); g.arc(cx + x, cy + y, R * (0.014 + r() * 0.02), 0, TAU); g.fill(); });
      g.restore();
      g.fillStyle = '#4f9a35'; g.beginPath(); g.ellipse(cx, cy - R * 0.9, R * 0.2, R * 0.08, 0, 0, TAU); g.fill();
      g.beginPath(); g.arc(cx, cy, R, 0, TAU); rimLine(g, R);
    },
    half: { skin: ['#f08a16', '#c65a0a'], rind: '#fff1cb', rindW: 0.06, flesh: ['#ffb13a', '#ff8000'],
      extra(g, cx, cy, R) { g.strokeStyle = 'rgba(255,240,200,0.6)'; g.lineWidth = R * 0.03; g.lineCap = 'round';
        for (let i = 1; i < 8; i++) { const a = Math.PI + i / 8 * Math.PI; g.beginPath(); g.moveTo(cx, cy); g.lineTo(cx + Math.cos(a) * R, cy + Math.sin(a) * R); g.stroke(); }
        g.fillStyle = 'rgba(255,225,150,0.5)'; g.beginPath(); g.arc(cx, cy, R * 0.09, Math.PI, TAU); g.fill(); } } },
  { id: 'apple', juice: ['#fff1b0', '#ffe27a', '#ff8a7a'], stain: '255,236,150', rx: 1, ry: 1,
    whole(g, cx, cy, R) {
      g.strokeStyle = '#6a4326'; g.lineWidth = R * 0.09; g.lineCap = 'round'; g.beginPath(); g.moveTo(cx, cy - R * 0.8); g.quadraticCurveTo(cx + R * 0.02, cy - R * 1.1, cx + R * 0.14, cy - R * 1.22); g.stroke();
      g.fillStyle = '#58a63a'; g.save(); g.translate(cx + R * 0.34, cy - R * 1.04); g.rotate(-0.45); g.beginPath(); g.ellipse(0, 0, R * 0.3, R * 0.13, 0, 0, TAU); g.fill(); g.restore();
      g.beginPath(); g.arc(cx, cy, R, 0, TAU); g.fillStyle = discGrad(g, cx, cy, R, ['#ff7466', '#d92f33', '#7c1020']); g.fill();
      g.save(); g.clip(); const bl = g.createRadialGradient(cx + R * 0.45, cy + R * 0.5, 0, cx + R * 0.45, cy + R * 0.5, R * 0.9); bl.addColorStop(0, 'rgba(255,215,90,0.42)'); bl.addColorStop(1, 'rgba(255,215,90,0)'); g.fillStyle = bl; g.fillRect(cx - R, cy - R, R * 2, R * 2);
      g.strokeStyle = 'rgba(100,10,20,0.25)'; g.lineWidth = R * 0.04; for (let i = -2; i <= 2; i++) { g.beginPath(); g.moveTo(cx + i * R * 0.1, cy - R * 0.8); g.quadraticCurveTo(cx + i * R * 0.55, cy, cx + i * R * 0.15, cy + R * 0.9); g.stroke(); }
      g.restore(); g.fillStyle = 'rgba(60,10,10,0.35)'; g.beginPath(); g.ellipse(cx, cy - R * 0.86, R * 0.2, R * 0.08, 0, 0, TAU); g.fill();
      g.beginPath(); g.arc(cx, cy, R, 0, TAU); rimLine(g, R);
    },
    half: { skin: ['#d62f33', '#8c1522'], rind: '#fff4d2', rindW: 0.03, flesh: ['#fffbe4', '#f3e2a4'],
      extra(g, cx, cy, R) { g.fillStyle = '#e8d49a'; g.beginPath(); g.ellipse(cx, cy, R * 0.34, R * 0.2, 0, Math.PI, TAU); g.fill(); g.fillStyle = '#5a3418';
        for (const d of [-0.12, 0.12]) { g.beginPath(); g.ellipse(cx + d * R, cy - R * 0.06, R * 0.04, R * 0.07, d * 3, 0, TAU); g.fill(); } } } },
  { id: 'kiwi', juice: ['#9bd13a', '#c9ec6b', '#f0ffc2'], stain: '160,215,60', rx: 0.98, ry: 0.86,
    whole(g, cx, cy, R) {
      const rx = R * 0.98, ry = R * 0.86;
      g.beginPath(); g.ellipse(cx, cy, rx, ry, 0, 0, TAU); const gr = g.createRadialGradient(cx - R * 0.3, cy - R * 0.35, R * 0.1, cx, cy, R * 1.05); gr.addColorStop(0, '#c89c63'); gr.addColorStop(0.6, '#8d6137'); gr.addColorStop(1, '#4a2e17'); g.fillStyle = gr; g.fill();
      const rng = mulberry32(21); g.save(); g.clip(); g.lineCap = 'round';
      for (let i = 0; i < 260; i++) { const a = rng() * TAU, d = Math.sqrt(rng()) * R, x = cx + Math.cos(a) * d, y = cy + Math.sin(a) * d * 0.88, an = rng() * TAU, l = R * (0.05 + rng() * 0.07);
        g.strokeStyle = rng() < 0.5 ? 'rgba(50,28,10,0.5)' : 'rgba(225,185,125,0.4)'; g.lineWidth = Math.max(1, R * 0.018); g.beginPath(); g.moveTo(x, y); g.lineTo(x + Math.cos(an) * l, y + Math.sin(an) * l); g.stroke(); }
      g.restore(); g.beginPath(); g.ellipse(cx, cy, rx, ry, 0, 0, TAU); rimLine(g, R);
    },
    half: { rx: 0.98, ry: 0.86, skin: ['#8d6137', '#4a2e17'], rind: '#dbe9a2', rindW: 0.035, flesh: ['#a6d848', '#5f9d28'],
      extra(g, cx, cy, R) { g.fillStyle = 'rgba(238,246,200,0.9)'; g.beginPath(); g.ellipse(cx, cy, R * 0.3, R * 0.17, 0, Math.PI, TAU); g.fill(); g.fillStyle = '#16100c';
        for (let i = 0; i < 14; i++) { const a = Math.PI + (i + 0.5) / 14 * Math.PI, d = R * 0.5; g.save(); g.translate(cx + Math.cos(a) * d, cy + Math.sin(a) * d * 0.9); g.rotate(a); g.beginPath(); g.ellipse(0, 0, R * 0.06, R * 0.028, 0, 0, TAU); g.fill(); g.restore(); } } } },
  { id: 'plum', juice: ['#f5a523', '#ffcf5e', '#b36ad8'], stain: '170,95,215', rx: 1, ry: 1,
    whole(g, cx, cy, R) {
      g.strokeStyle = '#5a3a22'; g.lineWidth = R * 0.07; g.lineCap = 'round'; g.beginPath(); g.moveTo(cx, cy - R * 0.85); g.lineTo(cx + R * 0.05, cy - R * 1.15); g.stroke();
      g.beginPath(); g.arc(cx, cy, R, 0, TAU); g.fillStyle = discGrad(g, cx, cy, R, ['#b985dc', '#6b3199', '#26103f']); g.fill();
      g.save(); g.clip(); const b = g.createRadialGradient(cx - R * 0.3, cy - R * 0.3, 0, cx - R * 0.3, cy - R * 0.3, R); b.addColorStop(0, 'rgba(190,205,255,0.30)'); b.addColorStop(1, 'rgba(190,205,255,0)'); g.fillStyle = b; g.fillRect(cx - R, cy - R, R * 2, R * 2);
      g.strokeStyle = 'rgba(15,3,32,0.5)'; g.lineWidth = R * 0.05; g.beginPath(); g.moveTo(cx, cy - R * 0.95); g.quadraticCurveTo(cx + R * 0.45, cy, cx, cy + R * 0.95); g.stroke(); g.restore();
      g.beginPath(); g.arc(cx, cy, R, 0, TAU); rimLine(g, R);
    },
    half: { skin: ['#5e2b8a', '#26103f'], rind: '#c98a4a', rindW: 0.03, flesh: ['#ffd25a', '#ec9a22'],
      extra(g, cx, cy, R) { g.fillStyle = '#7b4a2a'; g.beginPath(); g.ellipse(cx, cy, R * 0.3, R * 0.4, 0, Math.PI, TAU); g.fill(); g.strokeStyle = 'rgba(40,20,10,0.5)'; g.lineWidth = R * 0.03; g.beginPath(); g.ellipse(cx, cy, R * 0.3, R * 0.4, 0, Math.PI, TAU); g.stroke(); } } },
  { id: 'pineapple', juice: ['#ffe14a', '#fff08a', '#ffc933'], stain: '255,225,80', rx: 0.8, ry: 1,
    crown(g, cx, cy, R) {
      const n = 9; for (let i = 0; i < n; i++) { const a = -Math.PI / 2 + (i - (n - 1) / 2) * 0.27, l = R * (0.55 + 0.35 * Math.cos((i - (n - 1) / 2) * 0.5)), bx = cx + Math.sin((i - (n - 1) / 2) * 0.27) * R * 0.1, by = cy - R * 0.85;
        g.fillStyle = i % 2 ? '#3f8a30' : '#57a53a'; g.beginPath(); g.moveTo(bx - R * 0.1, by); g.quadraticCurveTo(bx + Math.cos(a) * l * 0.5 - R * 0.05, by + Math.sin(a) * l * 0.6, bx + Math.cos(a) * l, by + Math.sin(a) * l); g.quadraticCurveTo(bx + Math.cos(a) * l * 0.5 + R * 0.08, by + Math.sin(a) * l * 0.5, bx + R * 0.1, by); g.closePath(); g.fill(); }
    },
    whole(g, cx, cy, R) {
      this.crown(g, cx, cy, R);
      const rx = R * 0.8, ry = R;
      g.beginPath(); g.ellipse(cx, cy, rx, ry, 0, 0, TAU); const gr = g.createRadialGradient(cx - R * 0.3, cy - R * 0.4, R * 0.1, cx, cy, R * 1.05); gr.addColorStop(0, '#ffd966'); gr.addColorStop(0.55, '#e3a42a'); gr.addColorStop(1, '#8a4d10'); g.fillStyle = gr; g.fill();
      g.save(); g.clip(); g.strokeStyle = 'rgba(105,55,8,0.55)'; g.lineWidth = R * 0.045;
      for (let i = -14; i <= 14; i++) { g.beginPath(); g.moveTo(cx - R, cy + i * R * 0.27 - R); g.lineTo(cx + R, cy + i * R * 0.27 + R); g.stroke(); g.beginPath(); g.moveTo(cx + R, cy + i * R * 0.27 - R); g.lineTo(cx - R, cy + i * R * 0.27 + R); g.stroke(); }
      g.restore(); g.beginPath(); g.ellipse(cx, cy, rx, ry, 0, 0, TAU); rimLine(g, R);
    },
    half: { rx: 0.8, ry: 1, skin: ['#d19a28', '#8a4d10'], rind: '#f2d982', rindW: 0.06, flesh: ['#fff0a0', '#f7c833'],
      pre(g, cx, cy, R) { TYPES[5].crown(g, cx, cy, R); },
      extra(g, cx, cy, R) { g.fillStyle = 'rgba(255,248,205,0.8)'; g.beginPath(); g.ellipse(cx, cy, R * 0.16, R * 0.9, 0, Math.PI, TAU); g.fill(); g.strokeStyle = 'rgba(210,150,30,0.45)'; g.lineWidth = R * 0.02;
        for (let i = 1; i < 10; i++) { const a = Math.PI + i / 10 * Math.PI; g.beginPath(); g.moveTo(cx + Math.cos(a) * R * 0.17, cy + Math.sin(a) * R * 0.5); g.lineTo(cx + Math.cos(a) * R * 0.62, cy + Math.sin(a) * R * 0.95); g.stroke(); } } } },
];

function glowSprite(rgb, size = 96) {
  const c = mk(size, size), g = c.getContext('2d'), r = size / 2;
  const gr = g.createRadialGradient(r, r, 0, r, r, r);
  gr.addColorStop(0, `rgba(${rgb},1)`); gr.addColorStop(0.35, `rgba(${rgb},0.4)`); gr.addColorStop(1, `rgba(${rgb},0)`);
  g.fillStyle = gr; g.fillRect(0, 0, size, size); return c;
}

// ---------------------------------------------------------------------------
// AI — the "hand". It controls the blade only through env.cmd(vx, vy): a desired cursor
// velocity, which the game clamps to the human speed/acceleration limits.
// What it can see (env.observe()): the blade's own position/velocity and, for every fruit/bomb
// that is visible on screen, its id, kind, position and radius — sampled 70 ms ago (reaction
// delay). It estimates motion from two consecutive observed positions and applies known gravity.
// It never sees fruits still below the screen, upcoming volleys, or any RNG.
// ---------------------------------------------------------------------------
// AI styles (picked at create()): comboW = bonus weight for multi-fruit strokes, delayW = cost per second of
// waiting before the stroke, nearPen = penalty for passing close to a bomb, bm = extra bomb clearance (px).
const SLICER_STYLES = [
  { name: 'Combo hunter', comboW: 1.7, delayW: 0.6, nearPen: 0.5, bm: 0 },
  { name: 'Quick cutter', comboW: 0.9, delayW: 1.5, nearPen: 0.5, bm: 0 },
  { name: 'Careful cutter', comboW: 1.2, delayW: 0.8, nearPen: 1.6, bm: 12 },
];
// Super AI: no reaction delay, no stroke noise, hand limits far beyond human (see create()).
const SUPER_STYLE = { name: 'Super AI', comboW: 1.5, delayW: 1.2, nearPen: 0.8, bm: 4 };
function makeAI(env, sty) {
  const G = env.limits.grav, A_ACC = env.limits.acc, VMAX = env.limits.vmax;
  const SUP = !!sty.superAI;
  const DELAY = SUP ? 0 : 4;            // 4 ticks = 67 ms reaction delay (Super AI: none)
  const VS = SUP ? 6500 : 3000, VAPP = SUP ? 7000 : 3200, A_BR = A_ACC * 0.6, RUN = 74, EXT = 92;
  const DELAYS = SUP ? [0.03, 0.06, 0.1, 0.15, 0.2, 0.26, 0.33, 0.42, 0.56] : [0.05, 0.12, 0.2, 0.3, 0.42, 0.56];
  const NANG = SUP ? 16 : 8;
  const hist = [];
  const ignore = new Map();
  let plan = null, swipe = null, replan = 0, now = 0;
  let idleX = null, idleY = null;

  function strokeT(s) {
    const tv = VS / A_ACC, sv = 0.5 * A_ACC * tv * tv;
    return s <= sv ? Math.sqrt(2 * s / A_ACC) : tv + (s - sv) / VS;
  }
  function travelT(d) {
    const da = VAPP * VAPP / (2 * A_BR);
    return d < 2 * da ? 2 * Math.sqrt(d / A_BR) : 2 * VAPP / A_BR + (d - 2 * da) / VAPP;
  }
  // time at which seek() has covered s of an approach of length d (accelerate, cruise at VAPP, brake), from rest
  function profT(s, d) {
    const da = VAPP * VAPP / (2 * A_BR);
    if (d < 2 * da) return s < d / 2 ? Math.sqrt(2 * s / A_BR) : travelT(d) - Math.sqrt(2 * Math.max(0, d - s) / A_BR);
    if (s < da) return Math.sqrt(2 * s / A_BR);
    if (s <= d - da) return VAPP / A_BR + (s - da) / VAPP;
    return travelT(d) - Math.sqrt(2 * Math.max(0, d - s) / A_BR);
  }
  const norm = (x, y) => { const l = hypot(x, y) || 1; return [x / l, y / l]; };

  function buildModel(cur, prev, lag) {
    const pm = new Map(); for (const it of prev.items) pm.set(it.id, it);
    const out = [];
    for (const it of cur.items) {
      if ((ignore.get(it.id) || 0) > now) continue;
      const p = pm.get(it.id);
      if (!p) continue;
      const vx = (it.x - p.x) / STEP, vy = (it.y - p.y) / STEP + 0.5 * G * STEP;
      const m = { id: it.id, bomb: it.bomb, r: it.r, x: it.x, y: it.y, vx, vy };
      m.at = t => { const q = t + lag; return [m.x + vx * q, m.y + vy * q + 0.5 * G * q * q]; };
      // time (from now) until the centre falls below the bottom edge
      const yb = cur.H + it.r, c = it.y - yb;
      const disc = vy * vy - 2 * G * c;
      m.tFall = disc > 0 ? (-vy + Math.sqrt(disc)) / G - lag : 9;
      out.push(m);
    }
    return out;
  }

  function evalStroke(bx, by, P0x, P0y, dx, dy, Ls, D, model, H, W) {
    const hits = [];
    let bad = false, near = false;
    // approach path (bombs only)
    const dA = hypot(P0x - bx, P0y - by);
    for (let s = 0; s <= dA && !bad; s += 50) {
      const f = dA ? s / dA : 1, px = bx + (P0x - bx) * f, py = by + (P0y - by) * f;
      // arrival time at this point of the approach: the kinematic profile of seek() (Super AI) or a linear share of D
      const tp = SUP ? profT(s, dA) : D * f;
      for (const m of model) if (m.bomb) {
        for (const k of SUP ? [0.7, 1, 1.3] : [1]) {
          const q = m.at(tp * k), d = hypot(q[0] - px, q[1] - py);
          if (d < m.r + 48 + sty.bm) bad = true; else if (d < m.r + 100) near = true;
        }
      }
    }
    if (bad) return null;
    for (let s = 0; s <= Ls + 72; s += 26) {
      const px = P0x + dx * s, py = P0y + dy * s, t = D + strokeT(s);
      for (const m of model) {
        const q = m.at(t), d = hypot(q[0] - px, q[1] - py);
        if (m.bomb) { if (d < m.r + 42 + sty.bm) return null; if (d < m.r + 95) near = true; }
        else if (s <= Ls && d < m.r * 0.8 && q[1] < H + 10 && !hits.includes(m)) hits.push(m);
      }
    }
    const tEnd = D + strokeT(Ls);
    let score = 0;
    score += hits.length;
    const n = hits.length;
    if (n >= 2) score += (n - 1) * 0.25 * (sty.comboW - 1);
    if (n >= 3) score += (3 + (n - 3)) * 0.9 * sty.comboW;
    score -= sty.delayW * D + (near ? sty.nearPen : 0) - (SUP ? 0 : Math.random() * 0.06);
    // lookahead: greedy earliest-deadline rollout over the fruits this stroke leaves behind;
    // every fruit it could not serve in time would cost a life.
    {
      let t = tEnd, cx = P0x + dx * (Ls + 60), cy = P0y + dy * (Ls + 60);
      const rest = [];
      for (const m of model) if (!m.bomb && m.tFall > 0.05 && !hits.includes(m)) rest.push(m);
      rest.sort((u, v) => u.tFall - v.tFall);
      for (const m of rest) {
        let tt = t + 0.1, p = m.at(tt);
        tt = t + travelT(hypot(p[0] - cx, p[1] - cy)) + 0.1; p = m.at(tt);
        tt = t + travelT(hypot(p[0] - cx, p[1] - cy)) + 0.1; p = m.at(tt);
        if (tt + 0.04 < m.tFall && p[1] < H) { t = tt + 0.05; cx = p[0]; cy = p[1]; } else score -= 5;
      }
    }
    return { score, hits, tEnd };
  }

  function makeCand(bx, by, ax, ay, bx2, by2, D, model, snap) {
    const W = snap.W, H = snap.H;
    const cl = (v, hi) => Math.max(3, Math.min(hi - 3, v));
    const Ax = cl(ax, W), Ay = cl(ay, H), Bx = cl(bx2, W), By = cl(by2, H);
    const L = hypot(Bx - Ax, By - Ay);
    if (L < 60 || L > 1000) return null;
    const [dx, dy] = norm(Bx - Ax, By - Ay);
    const P0x = cl(Ax - dx * RUN, W), P0y = cl(Ay - dy * RUN, H);
    const Ls = hypot(Bx - P0x, By - P0y);
    const dApp = hypot(P0x - bx, P0y - by);
    if (travelT(dApp) + 0.03 > D) return null;
    const r = evalStroke(bx, by, P0x, P0y, dx, dy, Ls, D, model, H, W);
    if (!r || !r.hits.length) return null;
    return { P0x, P0y, dx, dy, Ls, ts: now + D, score: r.score, hits: r.hits, tEnd: now + r.tEnd };
  }

  function makePlan(snap, model) {
    const bx = snap.blade.x, by = snap.blade.y;
    let best = null;
    for (const D of DELAYS) {
      const tm = D + 0.12;
      const pts = [];
      for (const m of model) if (!m.bomb) { const q = m.at(tm); if (q[1] > -30 && q[1] < snap.H + 20 && q[0] > -30 && q[0] < snap.W + 30) pts.push(q); }
      const consider = c => { if (c && (!best || c.score > best.score)) best = c; };
      for (let i = 0; i < pts.length; i++) {
        const p = pts[i];
        for (let k = 0; k < NANG; k++) {
          const a = k * TAU / NANG + 0.2, dx = Math.cos(a), dy = Math.sin(a);
          consider(makeCand(bx, by, p[0] - dx * EXT, p[1] - dy * EXT, p[0] + dx * EXT, p[1] + dy * EXT, D, model, snap));
        }
        for (let j = i + 1; j < pts.length; j++) {
          const q = pts[j], [dx, dy] = norm(q[0] - p[0], q[1] - p[1]);
          consider(makeCand(bx, by, p[0] - dx * EXT, p[1] - dy * EXT, q[0] + dx * EXT, q[1] + dy * EXT, D, model, snap));
          consider(makeCand(bx, by, q[0] + dx * EXT, q[1] + dy * EXT, p[0] - dx * EXT, p[1] - dy * EXT, D, model, snap));
        }
      }
    }
    return best;
  }

  function seek(snap, tx, ty, vmax) {
    const dx = tx - snap.blade.x, dy = ty - snap.blade.y, d = hypot(dx, dy);
    if (d < 1.2) { env.cmd(0, 0); return; }
    const v = Math.min(vmax, Math.sqrt(2 * A_BR * d), SUP ? d * 40 : 1e9);
    env.cmd(dx / d * v, dy / d * v);
  }

  return {
    tick() {
      const snap = env.observe();
      now = snap.t;
      hist.push(snap); if (hist.length > DELAY + 3) hist.shift();
      const bl = snap.blade;
      if (env.over()) { env.cmd(0, 0); return; }
      if (hist.length < DELAY + 2) { env.cmd(0, 0); return; }
      for (const [k, v] of ignore) if (v < now) ignore.delete(k);

      if (swipe) {
        const proj = (bl.x - swipe.P0x) * swipe.dx + (bl.y - swipe.P0y) * swipe.dy;
        if (proj + (SUP ? hypot(bl.vx, bl.vy) * (STEP + hypot(bl.vx, bl.vy) / (2 * A_ACC)) : 0) >= swipe.Ls || now - swipe.t0 > 0.7) { swipe = null; env.cmd(0, 0); }
        else { env.cmd(swipe.dx * VS, swipe.dy * VS); return; }
      }

      const cur = hist[hist.length - 1 - DELAY], prev = hist[hist.length - 2 - DELAY];
      const lag = DELAY * STEP;
      const model = buildModel(cur, prev, lag);

      replan -= 1;
      if (replan <= 0) {
        replan = SUP ? 1 : 2;
        let fresh = makePlan(snap, model);
        let kept = null;
        if (plan) {
          const D = plan.ts - now;
          if (D > -0.12) {
            const r = evalStroke(bl.x, bl.y, plan.P0x, plan.P0y, plan.dx, plan.dy, plan.Ls, Math.max(D, 0), model, snap.H, snap.W);
            if (r && r.hits.length) kept = Object.assign({}, plan, { score: r.score, hits: r.hits, tEnd: now + r.tEnd });
          }
        }
        plan = kept && (!fresh || fresh.score < kept.score + 0.45) ? kept : (fresh || null);
      }

      if (plan) {
        const dist = hypot(plan.P0x - bl.x, plan.P0y - bl.y);
        if (now >= plan.ts - 0.012 && dist < 34 && hypot(bl.vx, bl.vy) < (SUP ? 1400 : 900)) {
          // commit: human motor noise on the stroke direction
          const ang = Math.atan2(plan.dy, plan.dx) + (SUP ? 0 : rnd.gauss() * 0.011);
          swipe = { P0x: plan.P0x, P0y: plan.P0y, dx: Math.cos(ang), dy: Math.sin(ang), Ls: plan.Ls, t0: now };
          for (const m of plan.hits) ignore.set(m.id, plan.tEnd + 0.22);
          plan = null;
          env.cmd(swipe.dx * VS, swipe.dy * VS);
          return;
        }
        if (now > plan.ts + 0.18) plan = null;
        else { seek(snap, plan.P0x, plan.P0y, VAPP); idleX = null; return; }
      }
      // nothing to do: drift gently near the middle
      if (idleX === null) { idleX = bl.x; idleY = bl.y; }
      const tx = snap.W * 0.5 + Math.sin(now * 0.7) * snap.W * 0.12, ty = snap.H * 0.62 + Math.cos(now * 0.9) * 40;
      seek(snap, tx, ty, 420);
    },
  };
}

// ---------------------------------------------------------------------------
Arcade.register({
  id: 'slicer', name: 'Orchard Slash', genre: 'Fruit slicing',
  aiNote: "Sees only fruit and bombs already on screen, 70 ms late, and swipes with a blade limited to human speed and acceleration.",
  blurb: 'Fruits fly through a moonlit zen garden. Slice them, spare the bombs.',
  bg: '#0f1819', accent: '#f29f3d',
  create(opts = {}) {
    const SUP = !!opts.superAI;
    const B_ACC = SUP ? BLADE_ACC * 4 : BLADE_ACC, B_VMAX = SUP ? BLADE_VMAX * 3 : BLADE_VMAX;   // Super AI: inhuman hand
    let W = 1600, H = 900, sc = 1, Wl = 1600, dpr = 1, q = 1;
    let xmin = 100, xmax = 1500;
    let bg = null, bgKey = '';
    let spr = null, bombSpr = null, specSpr = null, shadowSpr = null;
    const glows = {};
    let sprKey = '';
    let T = 0, nextId = 1;

    const items = [];     // fruits and bombs in flight
    const pieces = [];    // sliced halves
    const drops = [];     // juice droplets / sparks
    const stains = [];    // juice splats on the gravel
    const floaters = [], slashes = [], rings = [];
    const trail = [];
    const queue = [];
    let spawnT = 1.2;
    let score = 0, lives = LIVES, sliced = 0, bestCombo = 0, bombsHit = 0, missed = 0;
    let chain = 0, lastSliceT = -9, comboFloater = null;
    let shake = 0, flash = 0, flashCol = '255,255,255', hurt = 0;
    let slow = 1, endT = 0, celebT = 0, reason = '';
    const bl = { x: 800, y: 560, px: 800, py: 560, vx: 0, vy: 0, cx: 0, cy: 0 };
    const motes = [];
    const rngM = mulberry32(99);
    for (let i = 0; i < 22; i++) motes.push({ x: rngM(), y: rngM(), s: 0.3 + rngM() * 0.7, ph: rngM() * 6.28 });

    const inst = { over: false, won: false };

    // ---------------- layout & cached art ----------------
    function bake() {
      const key = W + 'x' + H + '@' + q;
      if (key === bgKey) return;
      bgKey = key;
      bg = mk(W * q, H * q);
      const g = bg.getContext('2d'); g.scale(q, q);
      const rng = mulberry32(1234);
      const base = g.createRadialGradient(W * 0.5, H * 0.42, 0, W * 0.5, H * 0.45, Math.hypot(W, H) * 0.62);
      base.addColorStop(0, '#26352f'); base.addColorStop(0.6, '#182322'); base.addColorStop(1, '#0a1112');
      g.fillStyle = base; g.fillRect(0, 0, W, H);
      // gravel grain
      const n = Math.floor(W * H / 160);
      for (let i = 0; i < n; i++) {
        const x = rng() * W, y = rng() * H, s = 0.6 + rng() * 1.2;
        g.fillStyle = rng() < 0.5 ? 'rgba(180,205,200,0.07)' : 'rgba(0,0,0,0.16)';
        g.fillRect(x, y, s, s);
      }
      // zones around rocks
      const hh = H / 900;
      const zones = [
        { x: W * 0.12, y: H * 0.64, rock: 92 * hh, zone: 250 * hh },
        { x: W * 0.9, y: H * 0.2, rock: 58 * hh, zone: 170 * hh },
        { x: W * 0.62, y: H * 0.93, rock: 40 * hh, zone: 120 * hh },
      ];
      const sp = 17 * hh;
      const rake = (alphaDark, alphaLight) => {
        g.lineCap = 'round'; g.lineJoin = 'round';
        // straight raked lines outside zones
        g.save();
        g.beginPath(); g.rect(0, 0, W, H);
        for (const z of zones) { g.moveTo(z.x + z.zone, z.y); g.arc(z.x, z.y, z.zone, 0, TAU); }
        g.clip('evenodd');
        for (let k = 0, y0 = -sp; y0 < H + sp * 2; k++, y0 += sp) {
          g.beginPath();
          for (let x = -10; x <= W + 20; x += 22) { const y = y0 + Math.sin(x * 0.0034 / hh + k * 0.045) * 9 * hh + Math.sin(x * 0.011 / hh) * 1.6 * hh; x === -10 ? g.moveTo(x, y) : g.lineTo(x, y); }
          g.strokeStyle = `rgba(4,9,9,${alphaDark})`; g.lineWidth = sp * 0.3; g.stroke();
          g.translate(0, sp * 0.34); g.strokeStyle = `rgba(150,185,180,${alphaLight})`; g.lineWidth = sp * 0.17; g.stroke(); g.translate(0, -sp * 0.34);
        }
        g.restore();
        // ripples around rocks
        for (const z of zones) {
          g.save(); g.beginPath(); g.arc(z.x, z.y, z.zone, 0, TAU); g.clip();
          for (let r = z.rock * 1.25; r < z.zone; r += sp) {
            g.beginPath(); g.arc(z.x, z.y, r, 0, TAU);
            g.strokeStyle = `rgba(4,9,9,${alphaDark})`; g.lineWidth = sp * 0.3; g.stroke();
            g.beginPath(); g.arc(z.x, z.y, r + sp * 0.34, 0, TAU);
            g.strokeStyle = `rgba(150,185,180,${alphaLight})`; g.lineWidth = sp * 0.17; g.stroke();
          }
          g.restore();
        }
      };
      rake(0.4, 0.085);
      // rocks
      const blob = (cx, cy, rx, ry, seed) => {
        const r2 = mulberry32(seed), pts = [], m = 11;
        for (let i = 0; i < m; i++) { const a = i / m * TAU; const k = 0.84 + r2() * 0.28; pts.push([cx + Math.cos(a) * rx * k, cy + Math.sin(a) * ry * k * 0.82]); }
        g.beginPath();
        for (let i = 0; i < m; i++) { const p0 = pts[i], p1 = pts[(i + 1) % m], mx = (p0[0] + p1[0]) / 2, my = (p0[1] + p1[1]) / 2; if (i === 0) g.moveTo((pts[m - 1][0] + p0[0]) / 2, (pts[m - 1][1] + p0[1]) / 2); g.quadraticCurveTo(p0[0], p0[1], mx, my); }
        g.closePath();
      };
      const rock = (cx, cy, rx, ry, seed, moss) => {
        // soft shadow
        const sg = g.createRadialGradient(cx - rx * 0.1, cy + ry * 0.55, 0, cx - rx * 0.1, cy + ry * 0.55, rx * 1.5);
        sg.addColorStop(0, 'rgba(0,0,0,0.5)'); sg.addColorStop(1, 'rgba(0,0,0,0)');
        g.fillStyle = sg; g.fillRect(cx - rx * 2, cy - ry, rx * 4, ry * 3);
        blob(cx, cy, rx, ry, seed);
        const lg = g.createLinearGradient(cx + rx * 0.6, cy - ry, cx - rx * 0.5, cy + ry);
        lg.addColorStop(0, '#64706f'); lg.addColorStop(0.45, '#2c3837'); lg.addColorStop(1, '#0f1616');
        g.fillStyle = lg; g.fill();
        g.save(); g.clip();
        const r3 = mulberry32(seed + 5);
        if (moss) for (let i = 0; i < 70; i++) {
          const a = r3() * TAU, d = Math.sqrt(r3()) * rx * 0.95; const x = cx + Math.cos(a) * d - rx * 0.12, y = cy - ry * 0.28 + Math.sin(a) * d * 0.55 - Math.abs(Math.sin(a)) * ry * 0.1;
          const f = Math.max(0, 1 - (y - (cy - ry * 0.9)) / (ry * 1.1));
          if (r3() > f * 1.05) continue;
          g.fillStyle = `rgba(${70 + r3() * 40 | 0},${120 + r3() * 50 | 0},${50 + r3() * 25 | 0},${0.55 + r3() * 0.35})`;
          g.beginPath(); g.arc(x, y, rx * (0.05 + r3() * 0.12), 0, TAU); g.fill();
        }
        // cracks
        g.strokeStyle = 'rgba(0,0,0,0.3)'; g.lineWidth = 1.5 * hh; g.beginPath(); g.moveTo(cx + rx * 0.2, cy - ry * 0.2); g.lineTo(cx + rx * 0.05, cy + ry * 0.15); g.lineTo(cx + rx * 0.25, cy + ry * 0.4); g.stroke();
        g.restore();
        blob(cx, cy, rx, ry, seed); g.strokeStyle = 'rgba(190,220,225,0.22)'; g.lineWidth = 2 * hh; g.stroke();
      };
      rock(zones[0].x, zones[0].y, zones[0].rock, zones[0].rock * 0.95, 11, true);
      rock(zones[0].x + zones[0].rock * 0.95, zones[0].y + zones[0].rock * 0.55, zones[0].rock * 0.42, zones[0].rock * 0.4, 12, true);
      rock(zones[1].x, zones[1].y, zones[1].rock, zones[1].rock * 0.9, 13, true);
      rock(zones[2].x, zones[2].y, zones[2].rock, zones[2].rock * 0.8, 14, false);
      // moonlight pool, top right
      const mg = g.createRadialGradient(W * 0.78, -H * 0.05, 0, W * 0.78, H * 0.1, Math.max(W, H) * 0.75);
      mg.addColorStop(0, 'rgba(170,205,225,0.20)'); mg.addColorStop(0.5, 'rgba(120,160,190,0.06)'); mg.addColorStop(1, 'rgba(120,160,190,0)');
      g.fillStyle = mg; g.fillRect(0, 0, W, H);
      // vignette
      const vg = g.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.35, W / 2, H / 2, Math.hypot(W, H) * 0.58);
      vg.addColorStop(0, 'rgba(0,0,0,0)'); vg.addColorStop(1, 'rgba(0,0,0,0.62)');
      g.fillStyle = vg; g.fillRect(0, 0, W, H);
    }

    function buildSprites() {
      const key = (sc * dpr).toFixed(3);
      if (key === sprKey) return;
      sprKey = key;
      const R = FRUIT_R * sc * dpr, S = Math.ceil(R * 3.3);
      spr = TYPES.map(t => {
        const w = mk(S, S), g = w.getContext('2d'); t.whole(g, S / 2, S / 2, R);
        const h = mk(S, S), g2 = h.getContext('2d'); halfFruit(g2, S / 2, S / 2, R, t.half);
        return { whole: w, half: h, S, wS: S / (sc * dpr) };
      });
      // bomb
      const RB = BOMB_R * sc * dpr, SB = Math.ceil(RB * 3.4), b = mk(SB, SB), g = b.getContext('2d'), cx = SB / 2, cy = SB / 2 + RB * 0.25;
      g.strokeStyle = '#8a7350'; g.lineWidth = RB * 0.09; g.lineCap = 'round'; g.beginPath(); g.moveTo(cx, cy - RB * 1.0); g.bezierCurveTo(cx + RB * 0.05, cy - RB * 1.4, cx + RB * 0.5, cy - RB * 1.35, cx + RB * 0.42, cy - RB * 1.7); g.stroke();
      g.beginPath(); g.arc(cx, cy, RB, 0, TAU); g.fillStyle = discGrad(g, cx, cy, RB, ['#6d747d', '#2c3036', '#07080a']); g.fill();
      g.save(); g.clip(); g.strokeStyle = 'rgba(190,200,210,0.14)'; g.lineWidth = RB * 0.06; g.beginPath(); g.ellipse(cx, cy, RB * 0.98, RB * 0.34, -0.2, 0, TAU); g.stroke();
      g.strokeStyle = 'rgba(255,100,70,0.75)'; g.lineWidth = RB * 0.13; g.lineCap = 'round';
      g.beginPath(); g.moveTo(cx - RB * 0.3, cy - RB * 0.3); g.lineTo(cx + RB * 0.3, cy + RB * 0.3); g.moveTo(cx + RB * 0.3, cy - RB * 0.3); g.lineTo(cx - RB * 0.3, cy + RB * 0.3); g.stroke();
      g.restore();
      g.fillStyle = '#3a3f46'; roundRect(g, cx - RB * 0.2, cy - RB * 1.12, RB * 0.4, RB * 0.28, RB * 0.06); g.fill();
      g.beginPath(); g.arc(cx, cy, RB, 0, TAU); rimLine(g, RB);
      bombSpr = { c: b, S: SB, wS: SB / (sc * dpr), tipX: RB * 0.42 / (sc * dpr), tipY: (-RB * 1.7 + RB * 0.25) / (sc * dpr), oy: RB * 0.25 / (sc * dpr) };
      // fixed-lamp specular highlight (not rotated with the fruit)
      const hs = Math.ceil(R * 1.1), sc2 = mk(hs, hs), sg = sc2.getContext('2d');
      const gr = sg.createRadialGradient(hs / 2, hs / 2, 0, hs / 2, hs / 2, hs / 2);
      gr.addColorStop(0, 'rgba(255,255,255,0.85)'); gr.addColorStop(0.4, 'rgba(255,255,255,0.22)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
      sg.fillStyle = gr; sg.fillRect(0, 0, hs, hs);
      specSpr = { c: sc2, wS: hs / (sc * dpr) };
      const ss = 96, sh = mk(ss, ss), shg = sh.getContext('2d');
      const sgr = shg.createRadialGradient(ss / 2, ss / 2, 0, ss / 2, ss / 2, ss / 2);
      sgr.addColorStop(0, 'rgba(0,0,0,0.45)'); sgr.addColorStop(1, 'rgba(0,0,0,0)');
      shg.fillStyle = sgr; shg.fillRect(0, 0, ss, ss); shadowSpr = sh;
    }
    const glow = rgb => glows[rgb] || (glows[rgb] = glowSprite(rgb));

    inst.resize = (w, h) => {
      W = w; H = h; sc = H / WORLD_H; Wl = W / sc;
      dpr = Math.min(2, (typeof devicePixelRatio === 'number' && devicePixelRatio) || 1);
      q = Math.min(dpr, 1.5);
      xmin = Math.max(90, Wl / 2 - 820); xmax = Math.min(Wl - 90, Wl / 2 + 820);
      bake(); buildSprites();
      bl.x = Math.min(Math.max(bl.x, 0), Wl); bl.y = Math.min(Math.max(bl.y, 0), WORLD_H); bl.px = bl.x; bl.py = bl.y;
    };

    // ---------------- spawning ----------------
    function difficulty() { return Math.min(1, (score / GOAL) * 0.8 + T / 420); }
    function launch(bomb, x0, xa, apex, delay) {
      queue.push({ t: delay, bomb, x0, xa, apex });
    }
    function spawnNow(e) {
      const y0 = WORLD_H + (e.bomb ? BOMB_R : FRUIT_R) + 24;
      const vy = -Math.sqrt(2 * GRAV * (y0 - e.apex)), tUp = -vy / GRAV;
      const vx = Math.max(-420, Math.min(420, (e.xa - e.x0) / tUp));
      items.push({
        id: nextId++, bomb: e.bomb, type: e.bomb ? -1 : (Math.random() * TYPES.length) | 0, r: e.bomb ? BOMB_R : FRUIT_R,
        x: e.x0, y: y0, px: e.x0, py: y0, vx, vy, rot: rnd.float(0, TAU), prot: 0, vr: rnd.float(-3.2, 3.2) * (e.bomb ? 0.5 : 1), age: 0,
      });
      const it = items[items.length - 1]; it.prot = it.rot;
    }
    function planVolley() {
      const d = difficulty();
      let n = Math.round(2 + d * 2.7 + rnd.float(-0.9, 1.1));
      n = Math.max(1, Math.min(6, n));
      const pb = T < 6 ? 0 : 0.05 + 0.2 * d;
      let bombs = 0;
      const mode = Math.random();
      const items2 = [];
      for (let i = 0; i < n; i++) {
        let bomb = Math.random() < pb && bombs < (d > 0.55 ? 2 : 1) && n > 1;
        if (i === n - 1 && bombs === n - 1 && bomb) bomb = false;
        if (bomb) bombs++;
        items2.push(bomb);
      }
      const span = xmax - xmin;
      if (mode < 0.5) {            // scatter
        items2.forEach((b, i) => launch(b, rnd.float(xmin, xmax), rnd.float(xmin + span * 0.14, xmax - span * 0.14), rnd.float(190, 470), rnd.float(0, 0.3) + i * 0.04));
      } else if (mode < 0.78) {    // fan from one spot
        const ox = rnd.float(xmin + span * 0.2, xmax - span * 0.2);
        items2.forEach((b, i) => launch(b, ox + rnd.float(-30, 30), Math.max(xmin, Math.min(xmax, ox + (i - (n - 1) / 2) * 190 + rnd.float(-30, 30))), rnd.float(220, 430), i * 0.075));
      } else {                     // sweeping wave
        const dir = Math.random() < 0.5 ? 1 : -1;
        items2.forEach((b, i) => { const f = n > 1 ? i / (n - 1) : 0.5, x0 = dir > 0 ? xmin + f * span : xmax - f * span; launch(b, x0, Math.max(xmin, Math.min(xmax, x0 + rnd.float(-90, 90))), rnd.float(210, 440), i * 0.17); });
      }
      return 2.6 - 0.85 * d + rnd.float(-0.2, 0.35);
    }

    // ---------------- effects ----------------
    function juiceBurst(x, y, t, dx, dy, big) {
      const n = big ? 26 : 18, cols = TYPES[t].juice, nx = -dy, ny = dx;
      for (let i = 0; i < n; i++) {
        const side = Math.random() < 0.5 ? -1 : 1, sp = rnd.float(150, 620) * (big ? 1.2 : 1), sa = rnd.float(-0.6, 0.6);
        const vx = (nx * Math.cos(sa) - ny * Math.sin(sa)) * side * sp * 0.8 + dx * rnd.float(-120, 120), vy = (ny * Math.cos(sa) + nx * Math.sin(sa)) * side * sp * 0.8 + dy * rnd.float(-120, 120) - rnd.float(0, 160);
        drops.push({ x, y, px: x, py: y, vx, vy, g: 1500, life: 0, max: rnd.float(0.45, 1.0), size: rnd.float(3, 8), col: rnd.pick(cols), streak: 0.014 });
      }
    }
    function addStain(x, y, t, big, dx, dy) {
      const rng = mulberry32((Math.random() * 1e9) | 0), ang = Math.atan2(dy || 0, dx || 1);
      // an irregular central blot plus a spray of dots thrown mostly along the cut direction
      const blobs = [];
      const m = 7, r0 = FRUIT_R * (0.5 + rng() * 0.2);
      for (let i = 0; i < m; i++) { const a = i / m * TAU + rng() * 0.4; blobs.push({ dx: Math.cos(a) * r0 * 0.45, dy: Math.sin(a) * r0 * 0.45, r: r0 * (0.4 + rng() * 0.25) }); }
      const k = big ? 12 : 8;
      for (let i = 0; i < k; i++) {
        const side = rng() < 0.5 ? 0 : Math.PI, a = ang + side + (rng() - 0.5) * 0.9, d = FRUIT_R * (0.7 + rng() * 1.6);
        blobs.push({ dx: Math.cos(a) * d, dy: Math.sin(a) * d, r: FRUIT_R * (0.03 + rng() * 0.1), ex: 1.6 + rng(), a });
      }
      stains.push({ x, y, col: TYPES[t].stain, age: 0, blobs, a0: 0.2 + rng() * 0.07 });
      if (stains.length > 46) stains.shift();
    }
    function addFloater(x, y, txt, col, size, max = 0.9, vy = -70) { floaters.push({ x, y, vy, txt, col, size, age: 0, max }); }
    function ring(x, y, r0, r1, max, col, w = 6) { rings.push({ x, y, r0, r1, age: 0, max, col, w }); }

    function sliceFruit(f, dx, dy) {
      const idx = items.indexOf(f); if (idx >= 0) items.splice(idx, 1);
      const ang = Math.atan2(dy, dx), nx = -dy, ny = dx;
      for (let s = -1; s <= 1; s += 2) {
        pieces.push({ type: f.type, x: f.x, y: f.y, px: f.x, py: f.y, vx: f.vx * 0.85 + nx * s * rnd.float(120, 230), vy: f.vy * 0.85 + ny * s * rnd.float(120, 230) - 30,
          rot: ang + (s > 0 ? Math.PI : 0), prot: ang + (s > 0 ? Math.PI : 0), vr: s * rnd.float(1.5, 4.5) + f.vr * 0.3, age: 0 });
      }
      juiceBurst(f.x, f.y, f.type, dx, dy, false);
      addStain(f.x, f.y, f.type, false, dx, dy);
      slashes.push({ x: f.x - dx * f.r * 1.5, y: f.y - dy * f.r * 1.5, x2: f.x + dx * f.r * 1.5, y2: f.y + dy * f.r * 1.5, age: 0, max: 0.26 });
      ring(f.x, f.y, f.r * 0.4, f.r * 1.7, 0.35, 'rgba(255,255,255,', 3);
      // scoring + combo chain
      if (T - lastSliceT < CHAIN_WIN) chain++; else chain = 1;
      lastSliceT = T; sliced++;
      let pts = 1;
      if (chain === 3) pts += 3; else if (chain > 3) pts += 1;
      score += pts; bestCombo = Math.max(bestCombo, chain);
      addFloater(f.x, f.y - f.r, '+1', '#fff6dc', 34, 0.7);
      if (chain >= 3) {
        if (comboFloater && comboFloater.age < comboFloater.max) { comboFloater.txt = `COMBO x${chain}`; comboFloater.age = Math.min(comboFloater.age, 0.15); comboFloater.x = f.x; comboFloater.y = f.y - f.r * 1.9; comboFloater.size = 44 + chain * 3; }
        else { comboFloater = { x: f.x, y: f.y - f.r * 1.9, vy: -45, txt: `COMBO x${chain}`, col: '#ffd45e', size: 44 + chain * 3, age: 0, max: 1.3 }; floaters.push(comboFloater); }
        shake = Math.max(shake, 3 + chain);
      } else shake = Math.max(shake, 1.2);
      if (score >= GOAL && !inst.over) { inst.over = true; inst.won = true; endT = 0; reason = 'won'; chain = 0; }
    }
    function hitBomb(b) {
      const idx = items.indexOf(b); if (idx >= 0) items.splice(idx, 1);
      lives--; bombsHit++; chain = 0;
      flash = 0.85; flashCol = '255,240,215'; shake = 24; hurt = 1;
      ring(b.x, b.y, 20, 360, 0.6, 'rgba(255,200,120,', 14);
      ring(b.x, b.y, 10, 210, 0.45, 'rgba(255,255,255,', 6);
      for (let i = 0; i < 46; i++) {
        const a = rnd.float(0, TAU), sp = rnd.float(120, 900);
        drops.push({ x: b.x, y: b.y, px: b.x, py: b.y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - 100, g: 900, life: 0, max: rnd.float(0.4, 1.2), size: rnd.float(3, 9), col: rnd.pick(['#ffb347', '#ff7a2e', '#ffe29a', '#3a3f46']), streak: 0.02 });
      }
      addFloater(b.x, b.y - 70, 'BOOM', '#ff8a5e', 54, 1.1, -50);
      if (lives <= 0 && !inst.over) { inst.over = true; inst.won = false; endT = 0; reason = 'bomb'; }
    }
    function missFruit(f) {
      lives--; missed++; chain = 0; hurt = Math.max(hurt, 0.6);
      const x = Math.max(60, Math.min(Wl - 60, f.x));
      addFloater(x, WORLD_H - 80, 'MISS', '#ff7a66', 40, 1.0, -30);
      ring(x, WORLD_H - 20, 10, 110, 0.5, 'rgba(255,110,90,', 5);
      if (lives <= 0 && !inst.over) { inst.over = true; inst.won = false; endT = 0; reason = 'miss'; }
    }

    // ---------------- blade ----------------
    function bladeStep(dt) {
      bl.px = bl.x; bl.py = bl.y;
      let dvx = bl.cx - bl.vx, dvy = bl.cy - bl.vy;
      const dm = hypot(dvx, dvy), mx = B_ACC * dt;
      if (dm > mx) { dvx *= mx / dm; dvy *= mx / dm; }
      bl.vx += dvx; bl.vy += dvy;
      const sp = hypot(bl.vx, bl.vy);
      if (sp > B_VMAX) { bl.vx *= B_VMAX / sp; bl.vy *= B_VMAX / sp; }
      bl.x += bl.vx * dt; bl.y += bl.vy * dt;
      if (bl.x < 0) { bl.x = 0; bl.vx = 0; } else if (bl.x > Wl) { bl.x = Wl; bl.vx = 0; }
      if (bl.y < 0) { bl.y = 0; bl.vy = 0; } else if (bl.y > WORLD_H) { bl.y = WORLD_H; bl.vy = 0; }
      const spd = hypot(bl.x - bl.px, bl.y - bl.py) / dt;
      const active = spd > BLADE_ACTIVE;
      trail.push({ x: bl.x, y: bl.y, t: T, a: active, s: spd });
      while (trail.length && T - trail[0].t > 0.3) trail.shift();
      if (!active) return;
      const dx = (bl.x - bl.px) / (spd * dt), dy = (bl.y - bl.py) / (spd * dt);
      const ax = bl.px, ay = bl.py, bx = bl.x - ax, by = bl.y - ay, bb = bx * bx + by * by;
      for (let i = items.length - 1; i >= 0; i--) {
        const it = items[i];
        let t = bb > 0 ? ((it.x - ax) * bx + (it.y - ay) * by) / bb : 0; t = t < 0 ? 0 : t > 1 ? 1 : t;
        const d = hypot(it.x - (ax + bx * t), it.y - (ay + by * t));
        if (d < it.r * 0.93) { if (it.bomb) hitBomb(it); else sliceFruit(it, dx, dy); if (inst.over && inst.won) return; }
      }
    }

    // ---------------- AI hookup ----------------
    const env = {
      limits: { grav: GRAV, acc: B_ACC, vmax: B_VMAX },
      observe() {
        const vis = [];
        for (const it of items) if (it.y - it.r < WORLD_H && it.y + it.r > 0) vis.push({ id: it.id, bomb: it.bomb, x: it.x, y: it.y, r: it.r });
        return { t: T, W: Wl, H: WORLD_H, blade: { x: bl.x, y: bl.y, vx: bl.vx, vy: bl.vy }, items: vis };
      },
      cmd(vx, vy) { bl.cx = vx; bl.cy = vy; },
      over: () => inst.over,
    };
    const sty = SUP ? Object.assign({ superAI: true }, SUPER_STYLE) : SLICER_STYLES[Math.floor(Math.random() * SLICER_STYLES.length)];
    inst.style = sty.name; if (SUP) inst.superAI = true;
    const ai = makeAI(env, sty);

    // ---------------- step ----------------
    inst.step = dt => {
      T += dt;
      if (!inst.over) {
        ai.tick();
        bladeStep(dt);
        if (T > TIME_CAP) { inst.over = true; inst.won = false; reason = 'time'; endT = 0; }
        spawnT -= dt;
        if (spawnT <= 0 && !inst.over) spawnT = planVolley();
      } else {
        bl.cx = 0; bl.cy = 0; bladeStep(dt);
        endT += dt;
        slow = Math.max(0.35, slow - dt * 1.4);
        if (inst.won) {
          celebT -= dt;
          if (celebT <= 0 && endT < 2.2) {
            celebT = 0.1;
            const x = rnd.float(Wl * 0.15, Wl * 0.85), y = rnd.float(150, 520), t = (Math.random() * TYPES.length) | 0;
            juiceBurst(x, y, t, rnd.float(-1, 1), rnd.float(-1, 1), true); ring(x, y, 8, 120, 0.5, 'rgba(255,240,200,', 3);
          }
        }
      }
      for (let i = queue.length - 1; i >= 0; i--) { queue[i].t -= dt; if (queue[i].t <= 0 && !inst.over) { spawnNow(queue[i]); queue.splice(i, 1); } else if (inst.over) queue.splice(i, 1); }
      const dw = dt * slow;
      for (let i = items.length - 1; i >= 0; i--) {
        const it = items[i];
        it.px = it.x; it.py = it.y; it.prot = it.rot; it.age += dw;
        it.vy += GRAV * dw; it.x += it.vx * dw; it.y += it.vy * dw; it.rot += it.vr * dw;
        if (it.bomb && Math.random() < 0.55) {
          const c = Math.cos(it.rot), s = Math.sin(it.rot), tx = bombSpr ? bombSpr.tipX : 20, ty = bombSpr ? bombSpr.tipY : -80;
          const fx = it.x + tx * c - ty * s, fy = it.y + tx * s + ty * c;
          drops.push({ x: fx, y: fy, px: fx, py: fy, vx: it.vx * 0.3 + rnd.float(-90, 90), vy: it.vy * 0.3 + rnd.float(-160, 20), g: 500, life: 0, max: rnd.float(0.18, 0.4), size: rnd.float(2, 4), col: rnd.pick(['#ffd27a', '#ff9a3c', '#fff1c4']), streak: 0.02 });
        }
        if (it.y - it.r > WORLD_H + 30 && it.vy > 0) {
          items.splice(i, 1);
          if (!it.bomb && !inst.over) missFruit(it);
        }
      }
      for (let i = pieces.length - 1; i >= 0; i--) {
        const p = pieces[i];
        p.px = p.x; p.py = p.y; p.prot = p.rot; p.age += dw;
        p.vy += GRAV * dw; p.x += p.vx * dw; p.y += p.vy * dw; p.rot += p.vr * dw;
        if (p.y > WORLD_H + 200) pieces.splice(i, 1);
      }
      for (let i = drops.length - 1; i >= 0; i--) {
        const d = drops[i];
        d.px = d.x; d.py = d.y; d.life += dw;
        if (d.life >= d.max) { drops.splice(i, 1); continue; }
        d.vy += d.g * dw; d.vx *= Math.exp(-0.9 * dw); d.x += d.vx * dw; d.y += d.vy * dw;
      }
      for (const s of stains) s.age += dt;
      for (let i = stains.length - 1; i >= 0; i--) if (stains[i].age > 16) stains.splice(i, 1);
      for (let i = floaters.length - 1; i >= 0; i--) { const f = floaters[i]; f.age += dt; f.y += f.vy * dt; f.vy *= 0.97; if (f.age > f.max) floaters.splice(i, 1); }
      for (let i = slashes.length - 1; i >= 0; i--) { slashes[i].age += dt; if (slashes[i].age > slashes[i].max) slashes.splice(i, 1); }
      for (let i = rings.length - 1; i >= 0; i--) { rings[i].age += dt; if (rings[i].age > rings[i].max) rings.splice(i, 1); }
      shake *= Math.exp(-7 * dt); flash *= Math.exp(-5 * dt); hurt *= Math.exp(-2.2 * dt);
    };

    // ---------------- draw ----------------
    function drawTrail(ctx, a) {
      const n = trail.length; if (n < 2) return;
      const hx = bl.px + (bl.x - bl.px) * a, hy = bl.py + (bl.y - bl.py) * a;
      ctx.save(); ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      for (let pass = 0; pass < 2; pass++) {
        for (let i = 1; i < n; i++) {
          const p0 = trail[i - 1], p1 = trail[i];
          if (!p1.a && !p0.a) continue;
          const age = T - p1.t, f = Math.max(0, 1 - age / 0.26);
          if (f <= 0) continue;
          const x1 = i === n - 1 ? hx : p1.x, y1 = i === n - 1 ? hy : p1.y;
          const w = (4 + 15 * Math.min(1, p1.s / 2600)) * Math.pow(f, 1.25);
          ctx.beginPath(); ctx.moveTo(p0.x, p0.y); ctx.lineTo(x1, y1);
          if (pass === 0) { ctx.strokeStyle = `rgba(190,225,255,${0.22 * f})`; ctx.lineWidth = w * 3.0; }
          else { ctx.strokeStyle = `rgba(255,255,255,${0.95 * f})`; ctx.lineWidth = w * 0.85; }
          ctx.stroke();
        }
      }
      ctx.restore();
    }
    function drawItems(ctx, a) {
      // shadows
      ctx.save(); ctx.globalAlpha = 0.55;
      for (const it of items) { const x = it.px + (it.x - it.px) * a, y = it.py + (it.y - it.py) * a, r = it.r * 1.7; if (y < WORLD_H + 150) ctx.drawImage(shadowSpr, x - r + 16, y - r + 26, r * 2, r * 2); }
      ctx.restore();
      for (const it of items) {
        const x = it.px + (it.x - it.px) * a, y = it.py + (it.y - it.py) * a, rot = it.prot + (it.rot - it.prot) * a;
        if (y - it.r > WORLD_H + 40) continue;
        const grow = Math.min(1, it.age / 0.2), s = 0.8 + 0.2 * ease.outBack(grow);
        ctx.save(); ctx.translate(x, y);
        if (it.bomb) {
          const pulse = 0.5 + 0.5 * Math.sin(T * 9 + it.id);
          ctx.globalCompositeOperation = 'lighter'; ctx.globalAlpha = 0.16 + 0.10 * pulse;
          const gr = it.r * 2.6; ctx.drawImage(glow('255,70,40'), -gr, -gr, gr * 2, gr * 2);
          ctx.globalCompositeOperation = 'source-over'; ctx.globalAlpha = 1;
          ctx.rotate(rot); ctx.scale(s, s);
          const w = bombSpr.wS; ctx.drawImage(bombSpr.c, -w / 2, -w / 2 - bombSpr.oy, w, w);
          // fuse spark
          ctx.globalCompositeOperation = 'lighter';
          const fl = 0.7 + 0.3 * Math.sin(T * 40 + it.id * 3), sr = 26 * fl;
          ctx.drawImage(glow('255,190,90'), bombSpr.tipX - sr, bombSpr.tipY - sr, sr * 2, sr * 2);
          ctx.restore();
          continue;
        }
        ctx.rotate(rot); ctx.scale(s, s);
        const sp = spr[it.type], w = sp.wS; ctx.drawImage(sp.whole, -w / 2, -w / 2, w, w);
        ctx.restore();
        const hw = specSpr.wS; ctx.drawImage(specSpr.c, x - it.r * 0.34 - hw / 2, y - it.r * 0.4 - hw / 2, hw, hw);
      }
    }
    function drawPieces(ctx, a) {
      for (const p of pieces) {
        const x = p.px + (p.x - p.px) * a, y = p.py + (p.y - p.py) * a, rot = p.prot + (p.rot - p.prot) * a;
        const sp = spr[p.type], w = sp.wS;
        ctx.save(); ctx.translate(x, y); ctx.rotate(rot);
        ctx.drawImage(sp.half, -w / 2, -w / 2, w, w);
        ctx.restore();
      }
    }
    function drawDrops(ctx, a) {
      ctx.save(); ctx.lineCap = 'round';
      for (const d of drops) {
        const f = 1 - d.life / d.max, x = d.px + (d.x - d.px) * a, y = d.py + (d.y - d.py) * a;
        ctx.globalAlpha = Math.min(1, f * 1.5);
        ctx.strokeStyle = d.col; ctx.lineWidth = d.size * (0.5 + 0.5 * f);
        const sx = x - d.vx * d.streak, sy = y - d.vy * d.streak;
        ctx.beginPath(); ctx.moveTo(sx, sy); ctx.lineTo(x, y); ctx.stroke();
      }
      ctx.restore();
    }
    function drawHud(ctx) {
      // score + progress (top-left)
      const x = 44, y = 34;
      ctx.save();
      roundRect(ctx, x - 18, y - 12, 250, 98, 22); ctx.fillStyle = 'rgba(8,16,16,0.45)'; ctx.fill();
      ctx.strokeStyle = 'rgba(255,255,255,0.08)'; ctx.lineWidth = 2; ctx.stroke();
      ctx.font = '600 56px Fredoka, "Trebuchet MS", sans-serif'; ctx.textBaseline = 'alphabetic'; ctx.textAlign = 'left';
      ctx.fillStyle = '#fff3d6'; ctx.fillText(String(score), x, y + 52);
      const wsc = ctx.measureText(String(score)).width;
      ctx.font = '500 24px Fredoka, sans-serif'; ctx.fillStyle = 'rgba(255,243,214,0.5)'; ctx.fillText('/ ' + GOAL, x + wsc + 10, y + 52);
      const bw = 214, p = Math.min(1, score / GOAL);
      roundRect(ctx, x, y + 64, bw, 8, 4); ctx.fillStyle = 'rgba(255,255,255,0.1)'; ctx.fill();
      if (p > 0) { roundRect(ctx, x, y + 64, Math.max(8, bw * p), 8, 4); const g = ctx.createLinearGradient(x, 0, x + bw, 0); g.addColorStop(0, '#9bd13a'); g.addColorStop(1, '#f29f3d'); ctx.fillStyle = g; ctx.fill(); }
      // lives (top-right): zen stones
      for (let i = 0; i < LIVES; i++) {
        const cx = Wl - 70 - i * 64, cy = 66, alive = i < lives;
        const pop = alive ? 1 : 0;
        ctx.beginPath(); ctx.ellipse(cx, cy, 24, 21, 0.15, 0, TAU);
        if (alive) { const g = ctx.createRadialGradient(cx - 8, cy - 8, 2, cx, cy, 28); g.addColorStop(0, '#f4efe0'); g.addColorStop(1, '#8c8a7c'); ctx.fillStyle = g; }
        else ctx.fillStyle = 'rgba(8,16,16,0.55)';
        ctx.fill(); ctx.strokeStyle = alive ? 'rgba(255,255,255,0.35)' : 'rgba(255,255,255,0.1)'; ctx.lineWidth = 2; ctx.stroke();
        if (!alive) { ctx.strokeStyle = '#ff6b5a'; ctx.lineWidth = 5; ctx.lineCap = 'round'; ctx.beginPath(); ctx.moveTo(cx - 10, cy - 10); ctx.lineTo(cx + 10, cy + 10); ctx.moveTo(cx + 10, cy - 10); ctx.lineTo(cx - 10, cy + 10); ctx.stroke(); }
      }
      ctx.restore();
    }
    inst.draw = (ctx, w, h) => {
      const a = alphaNow();
      ctx.drawImage(bg, 0, 0, W, H);
      // drifting mist + moon breath
      ctx.save();
      for (let i = 0; i < 5; i++) {
        const sz = (0.45 + 0.1 * i) * Math.max(W, H) * 0.8, span = W + sz * 2;
        const x = ((i * 0.31 * W + T * (6 + i * 3.2)) % span) - sz, y = H * (0.2 + 0.17 * i) + Math.sin(T * 0.12 + i) * H * 0.03;
        ctx.globalAlpha = 0.05 + 0.012 * Math.sin(T * 0.3 + i * 2);
        ctx.drawImage(glow('180,210,215'), x - sz / 2, y - sz * 0.3, sz, sz * 0.6);
      }
      // fireflies
      ctx.globalCompositeOperation = 'lighter';
      for (const m of motes) {
        const x = ((m.x * W + Math.sin(T * 0.2 * m.s + m.ph) * 60 + T * 4 * m.s) % W + W) % W, y = ((m.y * H - T * 5 * m.s) % H + H) % H;
        ctx.globalAlpha = 0.25 + 0.2 * Math.sin(T * (0.8 + m.s) + m.ph); const r = 14 * m.s + 6;
        ctx.drawImage(glow('230,240,150'), x - r, y - r, r * 2, r * 2);
      }
      ctx.restore();

      ctx.save();
      const sx = Math.sin(T * 71) * shake * sc, sy = Math.cos(T * 59) * shake * sc;
      ctx.translate(sx, sy); ctx.scale(sc, sc);
      // stains
      for (const s of stains) {
        const f = Math.max(0, 1 - s.age / 16), al = s.a0 * Math.pow(f, 0.8) * Math.min(1, s.age / 0.08 + 0.2);
        ctx.fillStyle = `rgba(${s.col},${al})`;
        ctx.beginPath();
        for (const b of s.blobs) { if (b.ex) { ctx.moveTo(s.x + b.dx + b.r * b.ex, s.y + b.dy); ctx.ellipse(s.x + b.dx, s.y + b.dy, b.r * b.ex, b.r, b.a, 0, TAU); } else { ctx.moveTo(s.x + b.dx + b.r, s.y + b.dy); ctx.arc(s.x + b.dx, s.y + b.dy, b.r, 0, TAU); } }
        ctx.fill();
      }
      drawPieces(ctx, a);
      drawItems(ctx, a);
      // slashes
      ctx.save(); ctx.lineCap = 'round';
      for (const s of slashes) {
        const f = 1 - s.age / s.max, e = Math.min(1, s.age / 0.06 + 0.2);
        const mx = (s.x + s.x2) / 2, my = (s.y + s.y2) / 2, hx = (s.x2 - s.x) / 2 * e, hy = (s.y2 - s.y) / 2 * e;
        ctx.strokeStyle = `rgba(255,255,255,${0.55 * f})`; ctx.lineWidth = 14 * f; ctx.beginPath(); ctx.moveTo(mx - hx, my - hy); ctx.lineTo(mx + hx, my + hy); ctx.stroke();
        ctx.strokeStyle = `rgba(255,255,255,${f})`; ctx.lineWidth = 4 * f + 1; ctx.stroke();
      }
      ctx.restore();
      for (const r of rings) {
        const f = r.age / r.max, e = ease.outCubic(f);
        ctx.strokeStyle = r.col + (1 - f) * 0.8 + ')'; ctx.lineWidth = r.w * (1 - f) + 1;
        ctx.beginPath(); ctx.arc(r.x, r.y, r.r0 + (r.r1 - r.r0) * e, 0, TAU); ctx.stroke();
      }
      drawDrops(ctx, a);
      drawTrail(ctx, a);
      // the hand
      { const hx = bl.px + (bl.x - bl.px) * a, hy = bl.py + (bl.y - bl.py) * a, act = trail.length && trail[trail.length - 1].a;
        ctx.save(); ctx.globalCompositeOperation = 'lighter'; ctx.globalAlpha = act ? 0.9 : 0.4;
        const gr = act ? 34 : 22; ctx.drawImage(glow('210,235,255'), hx - gr, hy - gr, gr * 2, gr * 2);
        ctx.restore(); ctx.fillStyle = act ? '#fff' : 'rgba(255,255,255,0.65)'; ctx.beginPath(); ctx.arc(hx, hy, act ? 6 : 4.5, 0, TAU); ctx.fill(); }
      // floaters
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.lineJoin = 'round';
      for (const f of floaters) {
        const k = f.age / f.max, pop = ease.outBack(Math.min(1, f.age / 0.22)), al = k > 0.6 ? 1 - (k - 0.6) / 0.4 : 1;
        const sz = f.size * (0.5 + 0.5 * pop);
        ctx.globalAlpha = Math.max(0, al); ctx.font = `600 ${sz}px Fredoka, "Trebuchet MS", sans-serif`;
        ctx.lineWidth = sz * 0.2; ctx.strokeStyle = 'rgba(10,18,18,0.75)'; ctx.strokeText(f.txt, f.x, f.y);
        ctx.fillStyle = f.col; ctx.fillText(f.txt, f.x, f.y);
      }
      ctx.globalAlpha = 1;
      drawHud(ctx);
      ctx.restore();

      // screen overlays
      if (hurt > 0.01) {
        const g = ctx.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.3, W / 2, H / 2, Math.hypot(W, H) * 0.6);
        g.addColorStop(0, 'rgba(200,30,20,0)'); g.addColorStop(1, `rgba(200,30,20,${0.5 * hurt})`);
        ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
      }
      if (flash > 0.01) { ctx.fillStyle = `rgba(${flashCol},${Math.min(0.9, flash)})`; ctx.fillRect(0, 0, W, H); }
    };

    inst.hud = () => ({ score: `${score} / ${GOAL}`, detail: `${'● '.repeat(Math.max(0, lives)).trim() || '—'} lives · best combo x${bestCombo}` });
    inst.result = () => inst.result0() + ` (${sty.name})`;
    inst.result0 = () => {
      if (inst.won) return `Reached ${GOAL} points — ${sliced} fruits sliced, best combo x${bestCombo}`;
      if (reason === 'bomb') return `Blew up on a bomb at ${score} points`;
      if (reason === 'time') return `Out of time at ${score} points`;
      return `Dropped too many fruits at ${score} points (${sliced} sliced)`;
    };
    return inst;
  },
});
})();
