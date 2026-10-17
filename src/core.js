// core.js — shared contract between the shell and every game. Loaded first.
'use strict';

const TAU = Math.PI * 2;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, t) => a + (b - a) * t;
const ease = {
  outCubic: t => 1 - Math.pow(1 - t, 3),
  inOutCubic: t => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2),
  outBack: t => { const c = 1.70158; return 1 + (c + 1) * Math.pow(t - 1, 3) + c * Math.pow(t - 1, 2); },
  outQuad: t => 1 - (1 - t) * (1 - t),
};
const rnd = {
  float: (a = 0, b = 1) => a + Math.random() * (b - a),
  int: n => Math.floor(Math.random() * n),
  pick: arr => arr[Math.floor(Math.random() * arr.length)],
  gauss: () => { let u = 0, v = 0; while (!u) u = Math.random(); while (!v) v = Math.random(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(TAU * v); },
  shuffle: arr => { for (let i = arr.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [arr[i], arr[j]] = [arr[j], arr[i]]; } return arr; },
};
const hsl = (h, s, l, a = 1) => `hsla(${h},${s}%,${l}%,${a})`;

function roundRect(ctx, x, y, w, h, r) {
  r = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

// Simple particle pool. Coordinates are whatever space the game draws in.
class Particles {
  constructor() { this.list = []; }
  burst(x, y, n, o = {}) {
    for (let i = 0; i < n; i++) {
      const a = o.angle != null ? o.angle + rnd.float(-1, 1) * (o.spread ?? Math.PI) : rnd.float(0, TAU);
      const sp = rnd.float(o.speedMin ?? 40, o.speed ?? 220);
      this.list.push({
        x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp,
        life: 0, max: rnd.float(0.5, 1) * (o.life ?? 0.9),
        size: rnd.float(0.5, 1) * (o.size ?? 4),
        color: Array.isArray(o.color) ? rnd.pick(o.color) : (o.color ?? '#fff'),
        g: o.gravity ?? 0, drag: o.drag ?? 2,
      });
    }
  }
  update(dt) {
    const L = this.list;
    for (let i = L.length - 1; i >= 0; i--) {
      const p = L[i];
      p.life += dt;
      if (p.life >= p.max) { L[i] = L[L.length - 1]; L.pop(); continue; }
      const d = Math.exp(-p.drag * dt);
      p.vx *= d; p.vy = p.vy * d + p.g * dt;
      p.x += p.vx * dt; p.y += p.vy * dt;
    }
  }
  draw(ctx, scale = 1) {
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (const p of this.list) {
      const t = 1 - p.life / p.max;
      ctx.globalAlpha = t;
      ctx.fillStyle = p.color;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.size * scale * (0.4 + 0.6 * t), 0, TAU);
      ctx.fill();
    }
    ctx.restore();
  }
}

// ---------------------------------------------------------------------------
// Game registry. See DESIGN.md "Game contract" for the full interface.
//
// Arcade.register({
//   id, name, genre, blurb, bg, accent,      // metadata (bg/accent are CSS colors)
//   create() -> instance
// })
//
// instance = {
//   resize(W, H),        // CSS pixels of the canvas; called once before first step and on every resize
//   step(dt),            // fixed timestep, dt = 1/60 s. Runs game rules AND the AI for that tick.
//   draw(ctx, W, H),     // draw the full frame (ctx already scaled for devicePixelRatio)
//   over: false,         // set true when the game has ended (keep drawing an end animation afterwards)
//   won: false,          // set with over: true if the AI won
//   hud() -> { score: '12 480', detail: 'Level 7 · 54 lines' },
//   result() -> 'Cleared 150 lines',   // one line for the end card
// }
//
// FAIR PLAY RULE: the AI code in a game may only read what is drawn on screen
// (through an explicit observe() snapshot), and acts only through the same
// rate-limited inputs a human would have. See DESIGN.md.
// ---------------------------------------------------------------------------
const Arcade = {
  games: [],
  register(def) {
    for (const k of ['id', 'name', 'genre', 'create']) if (!def[k]) throw new Error('game missing ' + k);
    this.games.push(def);
  },
  get(id) { return this.games.find(g => g.id === id); },
};

// Rate-limited input channel: the AI pushes actions; the game consumes at most
// one action every `interval` seconds (human-like input speed).
class InputQueue {
  constructor(interval) { this.interval = interval; this.q = []; this.cool = 0; }
  push(a) { this.q.push(a); }
  clear() { this.q.length = 0; }
  get pending() { return this.q.length; }
  // call once per step; returns an action or null
  poll(dt) {
    this.cool -= dt;
    if (this.cool > 0 || !this.q.length) return null;
    this.cool = this.interval;
    return this.q.shift();
  }
}
