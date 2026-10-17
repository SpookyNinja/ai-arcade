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


// ---------------------------------------------------------------------------
// Lantern Glide — flappy-style. Logical height 600; width follows the aspect.
// ---------------------------------------------------------------------------
const WH = 600;               // world height
const GROUND = 548;           // top of the ground strip
const GRAV = 1500, FLAP_V = -470;
const MIN_FLAP = 0.12;        // human tap rate: min time between flaps
const BIRD_R = 13;
const STALK_W = 60, CAP_W = 70, CAP_H = 20;
const SPACING = 300;
const TIME_CAP = 900;         // 15 min safety cap

// Speed is capped at what the tap-latency AI can still react to; after that the grove gets harder through
// narrower gaps, tighter spacing and wilder height changes (patterns), not through raw speed.
const speedFor = s => Math.min(290, 230 + 2 * s);
const gapFor = i => 175 - 45 * Math.min(i, 100) / 100 - 26 * Math.min(Math.max(i - 100, 0), 200) / 200;
const stepFor = i => Math.min(260, 80 + 2 * Math.min(i, 60) + 1.2 * Math.max(0, i - 60));
const spacingFor = i => SPACING - 50 * Math.min(Math.max(i - 100, 0), 200) / 200;

// ---------------------------------------------------------------------------
// AI. It sees: the lantern's y (and its vertical speed, which is derivable from
// the last two frames), the stalks currently on screen (x, gap centre, gap
// size), the score (which sets the visible scroll speed), and its own flap
// history. It cannot see gates that have not scrolled onto the screen yet.
// It acts only by tapping (flap), at most once per MIN_FLAP seconds.
// Model-predictive control: simulate "wait now" and "flap now", each followed
// by a greedy policy, for 1.4 s against the visible stalks.
// ---------------------------------------------------------------------------
const GlideAI = {
  since: 1, prevY: null, queued: -1, prevGates: null,
  // Styles: where in the gap it aims, and how far ahead it anticipates the tap.
  STYLES: {
    'Center line': { frac: 0.5, lo: 8, hi: 40, lead: 0.05 },
    'Low rider': { frac: 0.7, lo: 14, hi: 56, lead: 0.05 },
    'Late flapper': { frac: 0.55, lo: 10, hi: 46, lead: 0.04 },
  },
  style: null, jit: 0, off: 0,
  sup: false, lat: 3, minFlap: MIN_FLAP,
  reset(name, sup) {
    this.since = 1; this.prevY = null; this.prevGates = null; this.queued = -1;
    this.sup = !!sup; this.lat = sup ? 0 : 3; this.minFlap = sup ? 0.004 : MIN_FLAP;
    this.style = sup ? { frac: 0, lo: 0, hi: 0, lead: 0 } : (this.STYLES[name] || this.STYLES['Center line']);
    this.jit = sup ? 0 : rnd.float(-3, 3); // random tie-break nudge
  },

  targetFor(g) {
    const s = this.style;
    return g.cy + this.jit + this.off + Math.min(s.hi, Math.max(s.lo, s.frac * (g.gap / 2 - BIRD_R - 4)));
  },

  sim(obs, first) {
    const dt = 1 / 60, N = this.sup ? 110 : 84, pad = BIRD_R + (this.sup ? 1.5 : 4), LAT = this.lat; // taps land ~3 frames after being decided
    let y = obs.y, vy = obs.vy, since = this.since;
    let applyAt = this.queued >= 0 ? Math.round(this.queued / dt) : -1;
    const gates = obs.gates, bx = obs.bx, sp = obs.speed;
    for (let i = 0; i < N; i++) {
      const t = i * dt;
      if (applyAt === i) { vy = FLAP_V; applyAt = -1; }
      let flap = false;
      if (applyAt < 0 && since >= this.minFlap) {
        if (i === 0) flap = first;
        else if (vy > 0) {
          let tgt = GROUND * 0.5;
          for (let k = 0; k < gates.length; k++) {
            const gx = gates[k].x - sp * t;
            if (gx + STALK_W / 2 + pad > bx) { tgt = this.targetFor(gates[k]) + (gates[k].vy || 0) * Math.min(t, 0.6); break; }
          }
          flap = y + vy * this.style.lead > tgt; // the tap lands ~50 ms later
        }
      }
      if (flap) { since = 0; if (LAT === 0) vy = FLAP_V; else applyAt = i + LAT; }
      vy += GRAV * dt; y += vy * dt; since += dt;
      if (y - pad < 0 || y + pad > GROUND) return t;
      for (let k = 0; k < gates.length; k++) {
        const gx = gates[k].x - sp * t;
        if (Math.abs(gx - bx) > CAP_W / 2 + pad) continue;
        const gcy = gates[k].cy + (gates[k].vy || 0) * Math.min(t, 0.6);
        const top = gcy - gates[k].gap / 2, bot = gcy + gates[k].gap / 2;
        if (circleRect(bx, y, pad, gx - STALK_W / 2, -50, STALK_W, top + 50)) return t;
        if (circleRect(bx, y, pad, gx - STALK_W / 2, bot, STALK_W, GROUND - bot)) return t;
        if (circleRect(bx, y, pad, gx - CAP_W / 2, top - CAP_H, CAP_W, CAP_H)) return t;
        if (circleRect(bx, y, pad, gx - CAP_W / 2, bot, CAP_W, CAP_H)) return t;
      }
    }
    return N * dt;
  },

  // returns true to tap
  act(obs, dt) {
    if (this.prevY == null) { this.prevY = obs.y; }
    this.since += dt;
    if (this.queued >= 0) { this.queued -= dt; if (this.queued < 0) this.queued = -1; }
    // visible gate drift: compare with the previous frame's gates (matched by scroll position)
    const pg = this.prevGates;
    if (pg) for (const g of obs.gates) {
      let best = null;
      for (const q of pg) if (Math.abs(q.x - dt * obs.speed - g.x) < 3) { best = q; break; }
      g.vy = best ? (g.cy - best.cy) / dt : 0;
    }
    this.prevGates = obs.gates.map(g => ({ x: g.x, cy: g.cy }));
    const o = { y: obs.y, vy: (obs.y - this.prevY) / dt, gates: obs.gates, bx: obs.bx, speed: obs.speed };
    this.prevY = obs.y;
    if (this.since < this.minFlap || this.queued >= 0) return false;
    const H = (this.sup ? 110 : 84) * dt;
    let flap;
    if (this.sup) {
      // super: try several aim offsets inside the gap for the follow-up policy, keep the best outcome
      let bw = 0, bf = 0;
      for (const off of [0, -14, 14, -28, 28, -42, 42, -8, 8]) {
        this.off = off;
        const w = this.sim(o, false); if (w > bw) bw = w;
        const f = this.sim(o, true); if (f > bf) bf = f;
        if (bw >= H - 1e-6) break;
      }
      this.off = 0;
      flap = bw >= H - 1e-6 ? false : bf > bw;
    } else {
      const w = this.sim(o, false);
      if (w >= H - 1e-6) flap = false;
      else {
        const f = this.sim(o, true);
        flap = f > w;
      }
    }
    if (flap) { this.since = 0; this.queued = this.lat ? this.lat / 60 : -1; }
    return flap;
  },
};

function circleRect(cx, cy, r, rx, ry, rw, rh) {
  const px = cx < rx ? rx : cx > rx + rw ? rx + rw : cx;
  const py = cy < ry ? ry : cy > ry + rh ? ry + rh : cy;
  const dx = cx - px, dy = cy - py;
  return dx * dx + dy * dy < r * r;
}

const hash = n => { const s = Math.sin(n * 127.1 + 311.7) * 43758.5453; return s - Math.floor(s); };

const TWISTS = [
  { key: 'squeeze', name: 'Tight squeezes', desc: 'Bursts of extra-narrow gates, marked with red glow.' },
  { key: 'moving', name: 'Swaying bamboo', desc: 'Some bamboo gates sway up and down.' },
];
// ---------------------------------------------------------------------------
class Glide {
  static get TWISTS() { return TWISTS; }
  constructor(opts = {}) {
    this.superAI = !!opts.superAI;
    this.best = opts.best;
    const TW = Glide.TWISTS, tw = opts.twist;
    const tdef = tw ? (typeof tw === 'string' ? TW.find(x => x.key === tw) : null) || rnd.pick(TW) : null;
    this.twist = tdef ? { key: tdef.key, name: tdef.name, desc: tdef.desc } : null;
    this.squeezeLeft = 0; this.squeezeIn = 6;
    this.banner = null;
    this.over = false; this.won = false; this.t = 0; this.overT = 0;
    this.W = 1600; this.H = 900; this.k = 1.5; this.ox = 0; this.oy = 0; this.worldW = 1066;
    this.score = 0;
    this.bx = 280;
    this.bird = { y: 290, vy: 0, rot: 0, spin: 0, flap: 0, dead: false, deadT: 0, glow: 1, x: 280 };
    this.cool = 0; this.pending = -1;
    this.scroll = 0;       // distance travelled
    this.scrollV = speedFor(0);
    this.gates = []; this.nextIdx = 0; this.lastCy = 290;
    this.hover = 0.9;
    this.parts = new Particles(); this.embers = new Particles();
    this.texts = [];
    this.endMsg = '';
    this.flame = 1;
    this.bgScroll = 0;
    this.ff = [];
    for (let i = 0; i < 46; i++) this.ff.push({ x: rnd.float(0, 1), y: rnd.float(0.2, 0.92), ph: rnd.float(0, 6.3), sp: rnd.float(0.4, 1.2), z: rnd.float(0.25, 0.9) });
    this.sky = [];
    for (let i = 0; i < 9; i++) this.sky.push({ x: rnd.float(0, 1), y: rnd.float(0.15, 0.55), s: rnd.float(4, 9), sp: rnd.float(4, 9), ph: rnd.float(0, 6) });
    this.stars = [];
    for (let i = 0; i < 70; i++) this.stars.push({ x: rnd.float(0, 1), y: rnd.float(0, 0.4), s: rnd.float(0.5, 1.5), ph: rnd.float(0, 6.3) });
    this.seed = rnd.float(0, 1000);
    this.sprites = null;
    this.style = this.superAI ? 'Super AI' : rnd.pick(Object.keys(GlideAI.STYLES));
    GlideAI.reset(this.style, this.superAI);
    this.fillGates();
  }

  resize(W, H) {
    this.W = W; this.H = H;
    this.k = Math.max(H / WH, 0) ;
    if (W / H < 1.25) this.k = W / (WH * 1.25);
    this.worldW = W / this.k;
    this.oy = (H - WH * this.k) / 2; this.ox = 0;
    this.bx = Math.max(150, this.worldW * 0.27);
    if (!this.bird.dead) this.bird.x = this.bx;
  }

  fillGates() {
    while (this.nextIdx === 0 || this.lastWx() < this.scroll + this.worldW + 200) {
      const i = this.nextIdx++;
      let gap = gapFor(i); const R = stepFor(i);
      let squeeze = false;
      if (this.twist && this.twist.key === 'squeeze' && i > 4) {
        if (this.squeezeLeft > 0) { this.squeezeLeft--; squeeze = true; }
        else if (--this.squeezeIn <= 0) { this.squeezeLeft = 3; this.squeezeIn = Math.round(rnd.float(12, 20)); squeeze = true; }
        if (squeeze) gap = Math.max(100, gap - 16);
      }
      const lo = gap / 2 + 56, hi = GROUND - gap / 2 - 56;
      let cy = i === 0 ? 290 : this.lastCy + rnd.float(-R, R);
      cy = Math.min(hi, Math.max(lo, cy));
      this.lastCy = cy;
      const wx = i === 0 ? this.bx + 480 + this.scroll : this.lastWx() + spacingFor(i);
      const g = { wx, cy, cy0: cy, gap, idx: i, passed: false, seed: rnd.float(0, 100), squeeze, amp: 0, ph: rnd.float(0, 6.28) };
      if (this.twist && this.twist.key === 'moving' && i > 3) g.amp = Math.max(0, Math.min(rnd.float(12, 22), cy - lo, hi - cy));
      this.gates.push(g);
    }
  }
  lastWx() { return this.gates.length ? this.gates[this.gates.length - 1].wx : 0; }

  observe() {
    const gs = [];
    for (const g of this.gates) {
      const x = g.wx - this.scroll;
      if (x > -60 && x < this.worldW + 40) gs.push({ x, cy: g.cy, gap: g.gap });
    }
    return { y: this.bird.y, bx: this.bx, gates: gs, speed: speedFor(this.score) };
  }

  _ipg() { return [[[this], ['scroll', 'bgScroll'], 60], [[this.bird], ['y', 'rot'], 150]]; }

  step(dt) {

    IP.snap(this._ipg());
    this.t += dt;
    this.parts.update(dt); this.embers.update(dt);
    for (let i = this.texts.length - 1; i >= 0; i--) { this.texts[i].life += dt; if (this.texts[i].life > 1.1) this.texts.splice(i, 1); }
    this.bird.flap = Math.max(0, this.bird.flap - dt * 5);
    this.bgScroll += this.scrollV * dt;
    const b = this.bird;

    if (this.over) {
      this.overT += dt;
      if (b.dead) this.stepDead(dt);
      else { // victory glide
        b.vy += (-60 - b.vy) * dt * 1.2; b.y += b.vy * dt;
        b.rot += (-0.12 - b.rot) * dt * 2;
        this.scroll += this.scrollV * dt;
        if (Math.random() < 0.12) this.parts.burst(rnd.float(0.2, 0.95) * this.worldW, rnd.float(60, 330), 30, { color: ['#ffd36b', '#ff8a5b', '#ffe7a8', '#ff6b9a', '#fff'], speed: 260, life: 1.4, size: 3, gravity: 140, drag: 1.5 });
      }
      return;
    }
    if (this.t > TIME_CAP) { this.die('Out of time'); return; }
    if (this.banner) { this.banner.life += dt; if (this.banner.life > 2.4) this.banner = null; }
    for (const g of this.gates) if (g.amp) g.cy = g.cy0 + g.amp * Math.sin(this.t * 0.8 + g.ph);

    this.scrollV = speedFor(this.score);
    this.scroll += this.scrollV * dt;
    this.fillGates();
    while (this.gates.length && this.gates[0].wx - this.scroll < -120) this.gates.shift();

    this.cool -= dt;
    if (this.hover > 0) {
      this.hover -= dt;
      b.y = 290 + Math.sin(this.t * 4) * 6; b.vy = 0;
      b.rot = Math.sin(this.t * 3) * 0.04;
      this.ambientEmbers(dt);
      return;
    }
    // human-like tap latency: the press (min 0.12 s apart) takes effect ~50 +/- 14 ms later
    if (GlideAI.act(this.observe(), dt) && this.pending < 0 && this.cool <= 0) {
      if (this.superAI) { this.flap(); this.cool = GlideAI.minFlap; }
      else { this.pending = 0.05 + rnd.float(-0.014, 0.014); this.cool = MIN_FLAP; }
    }
    if (this.pending >= 0) { this.pending -= dt; if (this.pending < 0) this.flap(); }

    b.vy += GRAV * dt; b.y += b.vy * dt;
    b.rot += (clamp(b.vy / 900, -0.4, 0.75) - b.rot) * Math.min(1, dt * 10);
    this.ambientEmbers(dt);

    // collisions & scoring
    if (b.y - BIRD_R < 0) { b.y = BIRD_R; this.die('Hit the sky'); return; }
    if (b.y + BIRD_R > GROUND) { b.y = GROUND - BIRD_R; this.die('Hit the ground'); return; }
    for (const g of this.gates) {
      const gx = g.wx - this.scroll;
      if (!g.passed && gx + STALK_W / 2 < this.bx - BIRD_R) {
        g.passed = true; this.score++; this.onPass(g, gx);
        if (g.squeeze && !this.banner) this.banner = { life: 0, txt: 'TIGHT SQUEEZE' };
        if (this.twist && this.twist.key === 'moving' && this.score === 4) this.banner = { life: 0, txt: 'SWAYING BAMBOO' };
      }
      if (Math.abs(gx - this.bx) > CAP_W / 2 + BIRD_R) continue;
      const top = g.cy - g.gap / 2, bot = g.cy + g.gap / 2;
      if (circleRect(this.bx, b.y, BIRD_R, gx - STALK_W / 2, -50, STALK_W, top + 50) ||
          circleRect(this.bx, b.y, BIRD_R, gx - STALK_W / 2, bot, STALK_W, GROUND - bot) ||
          circleRect(this.bx, b.y, BIRD_R, gx - CAP_W / 2, top - CAP_H, CAP_W, CAP_H) ||
          circleRect(this.bx, b.y, BIRD_R, gx - CAP_W / 2, bot, CAP_W, CAP_H)) {
        this.die('Crashed into the bamboo'); return;
      }
    }
  }

  flap() {
    const b = this.bird;
    b.vy = FLAP_V; b.flap = 1;
    this.embers.burst(this.bx, b.y + 14, 5, { angle: Math.PI / 2, spread: 0.7, speed: 110, speedMin: 30, life: 0.6, size: 2.2, color: ['#ffb347', '#ff7a3a', '#ffe08a'], gravity: -40, drag: 1.5 });
  }

  ambientEmbers(dt) {
    if (Math.random() < dt * 10) this.embers.burst(this.bx + rnd.float(-5, 5), this.bird.y + 8, 1, { angle: Math.PI / 2, spread: 0.5, speed: 30, speedMin: 10, life: 0.9, size: 1.8, color: '#ffc067', gravity: -30, drag: 1 });
  }

  onPass(g, gx) {
    const y = g.cy;
    this.texts.push({ x: this.bx + 30, y: y - 18, life: 0, txt: '+1' });
    this.parts.burst(this.bx + 10, y, 16, { color: ['#fff3b0', '#ffd36b', '#ffffff', '#ffb6d9'], speed: 170, speedMin: 40, life: 0.9, size: 3, gravity: -20, drag: 1.8 });
    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * TAU + this.t;
      this.parts.burst(this.bx + 10 + Math.cos(a) * 14, y + Math.sin(a) * 14, 1, { angle: a, spread: 0.1, speed: 120, speedMin: 100, life: 0.7, size: 4, color: '#fff8d0', drag: 2.5 });
    }
  }

  die(msg) {
    const b = this.bird;
    this.over = true; this.won = false; this.endMsg = msg; b.dead = true; b.deadT = 0;
    b.spin = (Math.random() < 0.5 ? -1 : 1) * rnd.float(5, 9);
    b.vy = Math.min(b.vy, -120);
    this.embers.burst(this.bx, b.y, 36, { color: ['#ff9a3d', '#ff5a2a', '#ffd27a', '#fff'], speed: 220, life: 1.6, size: 3.2, gravity: -60, drag: 1.2 });
    this.parts.burst(this.bx, b.y, 14, { color: ['#ffe9b0', '#fff'], speed: 160, life: 0.5, size: 2.4 });
  }

  stepDead(dt) {
    const b = this.bird;
    b.deadT += dt;
    this.flame = Math.max(0, 1 - b.deadT / 0.9);
    this.scrollV *= Math.exp(-dt * 3.5);
    this.scroll += this.scrollV * dt;
    if (b.y + BIRD_R < GROUND) {
      b.vy += GRAV * dt; b.y += b.vy * dt; b.rot += b.spin * dt;
      if (b.y + BIRD_R >= GROUND) {
        b.y = GROUND - BIRD_R; b.vy = 0; b.spin = 0; b.rot = Math.round(b.rot / 0.5) * 0.5 % 0.2 + 0.9;
        this.embers.burst(this.bx, GROUND - 6, 18, { angle: -Math.PI / 2, spread: 1.3, speed: 150, life: 1.2, size: 2.6, color: ['#ff9a3d', '#ff5a2a', '#ffd27a'], gravity: -30, drag: 1.4 });
      }
    }
    if (b.deadT < 1.4 && Math.random() < dt * 22) this.embers.burst(this.bx, b.y, 1, { angle: -Math.PI / 2, spread: 0.9, speed: 80, life: 1.3, size: 2.4, color: ['#ff9a3d', '#ff5a2a', '#ffd27a'], gravity: -50, drag: 1 });
  }

  win() {
    this.over = true; this.won = true;
    this.endMsg = 'Done';
    this.parts.burst(this.bx + 60, this.bird.y - 60, 80, { color: ['#ffd36b', '#ff8a5b', '#ffe7a8', '#ff6b9a', '#fff'], speed: 340, life: 1.6, size: 3.4, gravity: 140, drag: 1.4 });
  }

  hud() { return { score: String(this.score), detail: 'Endless' }; }
  result() { return `${this.endMsg} after ${this.score} ${this.score === 1 ? 'gate' : 'gates'} (${this.style})`; }

  // ---------------------------------------------------------------- drawing
  makeSprites() {
    const mk = (size, stops) => {
      const c = document.createElement('canvas'); c.width = c.height = size;
      const g = c.getContext('2d'); const r = size / 2;
      const gr = g.createRadialGradient(r, r, 0, r, r, r);
      for (const [o, col] of stops) gr.addColorStop(o, col);
      g.fillStyle = gr; g.fillRect(0, 0, size, size);
      return c;
    };
    this.sprites = {
      glow: mk(128, [[0, 'rgba(255,190,90,0.95)'], [0.25, 'rgba(255,150,60,0.45)'], [0.6, 'rgba(255,110,50,0.12)'], [1, 'rgba(255,100,40,0)']]),
      ff: mk(32, [[0, 'rgba(255,245,160,1)'], [0.3, 'rgba(255,230,120,0.5)'], [1, 'rgba(255,220,100,0)']]),
      sun: mk(256, [[0, 'rgba(255,214,150,0.95)'], [0.25, 'rgba(255,170,110,0.5)'], [1, 'rgba(255,140,100,0)']]),
    };
  }

  hill(ctx, layer, color, base, amp, par, freq, W0, W1) {
    const off = this.bgScroll * par;
    ctx.beginPath();
    ctx.moveTo(W0, WH + 400);
    for (let x = W0; x <= W1 + 12; x += 12) {
      const u = (x + off) * freq + layer * 40 + this.seed;
      const y = base + Math.sin(u) * amp + Math.sin(u * 2.3 + 1.7) * amp * 0.5 + Math.sin(u * 0.45 + 4) * amp * 0.9;
      ctx.lineTo(x, y);
    }
    ctx.lineTo(W1 + 12, WH + 400);
    ctx.closePath();
    ctx.fillStyle = color; ctx.fill();
  }

  draw(ctx, W, H) {

    const a = IP.alpha();

    const st = IP.push(this._ipg(), a);

    try { this._draw(ctx, W, H); } finally { IP.pop(st); }

  }

  _draw(ctx, W, H) {
    if (!this.sprites) this.makeSprites();
    const k = this.k, t = this.t, ww = this.worldW;
    const oy = this.oy;
    // sky (covers whole canvas)
    staticLayer(ctx, 'sky', W, H, (x, W, H) => {
      const sk = x.createLinearGradient(0, oy, 0, oy + GROUND * k);
      sk.addColorStop(0, '#171646'); sk.addColorStop(0.35, '#3c2a6e'); sk.addColorStop(0.65, '#9a4a7a'); sk.addColorStop(0.85, '#e8806a'); sk.addColorStop(1, '#ffb877');
      x.fillStyle = '#171646'; x.fillRect(0, 0, W, H);
      x.fillStyle = sk; x.fillRect(0, 0, W, oy + GROUND * k);
      if (oy > 0) { x.fillStyle = '#171646'; x.fillRect(0, 0, W, oy + 1); }
    });

    ctx.save();
    ctx.translate(this.ox, oy); ctx.scale(k, k);

    // stars
    for (const s of this.stars) {
      const a = 0.35 + 0.35 * Math.sin(t * 1.3 + s.ph);
      ctx.globalAlpha = a * (1 - s.y / 0.5);
      ctx.fillStyle = '#fff'; ctx.fillRect(s.x * ww, s.y * WH, s.s, s.s);
    }
    ctx.globalAlpha = 1;
    // low sun glow
    ctx.globalAlpha = 0.9;
    ctx.drawImage(this.sprites.sun, ww * 0.68 - 260, GROUND - 330, 520, 520);
    ctx.globalAlpha = 1;

    // distant sky lanterns
    ctx.save(); ctx.globalCompositeOperation = 'lighter';
    for (const s of this.sky) {
      const x = ((s.x * ww - this.bgScroll * 0.05 - t * 3) % (ww + 80) + ww + 80) % (ww + 80) - 40;
      const y = s.y * WH - ((t * s.sp) % 260) * 0.35 + Math.sin(t * 0.6 + s.ph) * 6;
      const yy = ((y % 330) + 330) % 330 + 60;
      ctx.globalAlpha = 0.55 + 0.2 * Math.sin(t * 2 + s.ph);
      ctx.drawImage(this.sprites.glow, x - s.s * 2.2, yy - s.s * 2.2, s.s * 4.4, s.s * 4.4);
    }
    ctx.restore();

    // parallax hills
    const W0 = -this.ox / k - 20, W1 = ww + 20;
    this.hill(ctx, 0, '#7a4a86', 430, 26, 0.06, 0.0062, W0, W1);
    this.hill(ctx, 1, '#4f3a80', 470, 30, 0.14, 0.0085, W0, W1);
    // string-light dots on the middle hill
    ctx.save(); ctx.globalCompositeOperation = 'lighter';
    for (let i = 0; i < 28; i++) {
      const x = ((i * 64 - this.bgScroll * 0.14) % (ww + 120) + ww + 120) % (ww + 120) - 40;
      const u = (x + this.bgScroll * 0.14) * 0.0085 + 40 + this.seed;
      const y = 470 + Math.sin(u) * 30 + Math.sin(u * 2.3 + 1.7) * 15 + Math.sin(u * 0.45 + 4) * 27 - 4;
      if (hash(i + this.seed) > 0.55) { ctx.globalAlpha = 0.5 + 0.4 * Math.sin(t * 2.2 + i); ctx.drawImage(this.sprites.glow, x - 7, y - 7, 14, 14); }
    }
    ctx.restore();
    this.hill(ctx, 2, '#2f2560', 508, 22, 0.32, 0.011, W0, W1);

    // fireflies (behind stalks)
    this.drawFireflies(ctx, ww, 0);

    // stalks
    for (const g of this.gates) this.drawGate(ctx, g, g.wx - this.scroll);

    // ground
    this.drawGround(ctx, W0, W1);

    // fireflies in front
    this.drawFireflies(ctx, ww, 1);

    // lantern
    this.drawLantern(ctx);
    this.embers.draw(ctx, 1);
    this.parts.draw(ctx, 1);

    // floaters
    ctx.font = '600 26px Fredoka, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    for (const f of this.texts) {
      const p = f.life / 1.1;
      ctx.globalAlpha = Math.min(1, (1 - p) * 1.6);
      ctx.fillStyle = '#fff5c8';
      ctx.fillText(f.txt, f.x, f.y - ease.outCubic(p) * 40);
    }
    ctx.globalAlpha = 1;
    if (this.banner) {
      const p = this.banner.life / 2.4;
      ctx.globalAlpha = Math.min(1, (1 - p) * 2.2, p * 8);
      ctx.font = '700 40px Fredoka, sans-serif'; ctx.fillStyle = '#ff5a3a'; ctx.strokeStyle = '#2a0e24'; ctx.lineWidth = 6;
      ctx.strokeText(this.banner.txt, ww / 2, 150); ctx.fillText(this.banner.txt, ww / 2, 150);
      ctx.globalAlpha = 1;
    }
    // big faint score
    ctx.font = '600 84px Fredoka, sans-serif'; ctx.textAlign = 'center';
    ctx.fillStyle = 'rgba(255,244,214,0.16)'; ctx.fillText(String(this.score), ww / 2, 74);
    ctx.restore();

    // vignette
    staticLayer(ctx, 'vg', W, H, (x, W, H) => {
      const vg = x.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.5, W / 2, H / 2, Math.max(W, H) * 0.85);
      vg.addColorStop(0, 'rgba(0,0,0,0)'); vg.addColorStop(1, 'rgba(10,6,30,0.4)');
      x.fillStyle = vg; x.fillRect(0, 0, W, H);
    });
  }

  drawFireflies(ctx, ww, layer) {
    ctx.save(); ctx.globalCompositeOperation = 'lighter';
    const t = this.t;
    for (const f of this.ff) {
      if ((f.z > 0.6 ? 1 : 0) !== layer) continue;
      const x = (((f.x * ww - this.bgScroll * f.z * 0.5 + Math.sin(t * f.sp + f.ph) * 24) % ww) + ww) % ww;
      const y = f.y * GROUND + Math.cos(t * f.sp * 0.8 + f.ph) * 18;
      const a = 0.25 + 0.75 * Math.max(0, Math.sin(t * f.sp * 1.4 + f.ph * 3));
      ctx.globalAlpha = a * 0.9;
      const s = 14 * f.z + 6;
      ctx.drawImage(this.sprites.ff, x - s / 2, y - s / 2, s, s);
    }
    ctx.restore();
  }

  drawGround(ctx, W0, W1) {
    const gh = WH + 400 - GROUND;
    const g = ctx.createLinearGradient(0, GROUND, 0, GROUND + 60);
    g.addColorStop(0, '#241a4a'); g.addColorStop(1, '#130d2c');
    ctx.fillStyle = g; ctx.fillRect(W0, GROUND, W1 - W0, gh);
    // grass edge
    ctx.fillStyle = '#2e2459';
    ctx.beginPath(); ctx.moveTo(W0, GROUND + 3);
    const off = this.scroll;
    for (let x = W0; x <= W1 + 10; x += 10) ctx.lineTo(x, GROUND - 3 - 3 * Math.sin((x + off) * 0.07) - 2 * Math.sin((x + off) * 0.19));
    ctx.lineTo(W1 + 10, GROUND + 8); ctx.lineTo(W0, GROUND + 8); ctx.closePath(); ctx.fill();
    // festival lantern string stakes
    const sp = 150;
    const first = Math.floor((off + W0) / sp) - 1;
    ctx.save();
    for (let i = first; i < first + (W1 - W0) / sp + 3; i++) {
      const x = i * sp - off;
      const fl = 0.7 + 0.3 * Math.sin(this.t * 3 + i * 1.7);
      ctx.strokeStyle = '#120b26'; ctx.lineWidth = 3;
      ctx.beginPath(); ctx.moveTo(x, GROUND + 6); ctx.lineTo(x, GROUND - 26); ctx.stroke();
      // lantern on stake
      ctx.globalCompositeOperation = 'lighter'; ctx.globalAlpha = 0.55 * fl;
      ctx.drawImage(this.sprites.glow, x - 22, GROUND - 52, 44, 44);
      ctx.globalCompositeOperation = 'source-over'; ctx.globalAlpha = 1;
      ctx.fillStyle = `rgba(255,${120 + 40 * fl | 0},60,0.95)`;
      ctx.beginPath(); ctx.ellipse(x, GROUND - 30, 7, 8.5, 0, 0, TAU); ctx.fill();
    }
    ctx.restore();
  }

  drawGate(ctx, g, x) {
    if (x < -80 || x > this.worldW + 80) return;
    const top = g.cy - g.gap / 2, bot = g.cy + g.gap / 2;
    if (g.squeeze) { ctx.save(); ctx.globalCompositeOperation = 'lighter'; ctx.globalAlpha = 0.5 + 0.3 * Math.sin(this.t * 8);
      ctx.fillStyle = '#ff3a2a'; ctx.fillRect(x - CAP_W / 2 - 3, top - 6, CAP_W + 6, 6); ctx.fillRect(x - CAP_W / 2 - 3, bot, CAP_W + 6, 6); ctx.restore(); }
    this.drawStalk(ctx, x, -60, top, true, g);
    this.drawStalk(ctx, x, bot, GROUND + 6, false, g);
  }

  drawStalk(ctx, cx, y0, y1, fromTop, g) {
    const w = STALK_W, x0 = cx - w / 2;
    const gr = ctx.createLinearGradient(x0, 0, x0 + w, 0);
    gr.addColorStop(0, '#3f6a2f'); gr.addColorStop(0.3, '#b8c95a'); gr.addColorStop(0.5, '#9db84a'); gr.addColorStop(1, '#2f5226');
    ctx.fillStyle = gr; ctx.fillRect(x0, y0, w, y1 - y0);
    // soft inner highlight
    ctx.fillStyle = 'rgba(255,248,170,0.18)'; ctx.fillRect(x0 + w * 0.22, y0, w * 0.1, y1 - y0);
    // dusk tint toward bottom
    // segments: nodes every 78 units anchored at the gap edge
    const edge = fromTop ? y1 : y0;
    const dir = fromTop ? -1 : 1;
    const n = Math.ceil((y1 - y0 + 80) / 78) + 1;
    for (let i = 0; i < n; i++) {
      const ny = edge + dir * (i * 78 + 46);
      if (ny < y0 - 12 || ny > y1 + 12) continue;
      const gg = ctx.createLinearGradient(x0 - 3, 0, x0 + w + 3, 0);
      gg.addColorStop(0, '#2f5226'); gg.addColorStop(0.3, '#d9d56a'); gg.addColorStop(0.6, '#a88e36'); gg.addColorStop(1, '#3d3a1a');
      ctx.fillStyle = gg; ctx.fillRect(x0 - 3, ny - 5, w + 6, 10);
      ctx.fillStyle = 'rgba(255,255,255,0.25)'; ctx.fillRect(x0 - 3, ny - 5, w + 6, 2);
      ctx.fillStyle = 'rgba(0,0,0,0.25)'; ctx.fillRect(x0 - 3, ny + 3, w + 6, 2);
      // leaves
      const hv = hash(g.seed + i * 3.1 + (fromTop ? 0.5 : 0));
      if (hv > 0.6 && i > 0) {
        const side = hv > 0.8 ? 1 : -1;
        const sway = Math.sin(this.t * 1.3 + g.seed + i) * 0.06;
        ctx.save(); ctx.translate(cx + side * (w / 2 + 1), ny); ctx.rotate(side * (-0.6 + sway) + (fromTop ? 0.5 : -0.2));
        ctx.fillStyle = '#5d9a3a';
        ctx.beginPath(); ctx.moveTo(0, 0); ctx.quadraticCurveTo(side * 16, -7, side * 34, 2); ctx.quadraticCurveTo(side * 16, 6, 0, 0); ctx.fill();
        ctx.strokeStyle = 'rgba(255,255,200,0.35)'; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(side * 30, 1); ctx.stroke();
        ctx.restore();
      }
    }
    // cap at the gap edge
    const cy = fromTop ? y1 - CAP_H : y0;
    const cg = ctx.createLinearGradient(cx - CAP_W / 2, 0, cx + CAP_W / 2, 0);
    cg.addColorStop(0, '#3f6a2f'); cg.addColorStop(0.3, '#d5d870'); cg.addColorStop(0.55, '#a8b24a'); cg.addColorStop(1, '#2f5226');
    ctx.fillStyle = cg;
    roundRect(ctx, cx - CAP_W / 2, cy, CAP_W, CAP_H, 5); ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.3)'; ctx.fillRect(cx - CAP_W / 2 + 4, fromTop ? cy + CAP_H - 5 : cy + 2, CAP_W - 8, 2);
    ctx.fillStyle = 'rgba(0,0,0,0.22)'; ctx.fillRect(cx - CAP_W / 2 + 3, fromTop ? cy + CAP_H - 3 : cy + CAP_H - 4, CAP_W - 6, 3);
  }

  drawLantern(ctx) {
    const b = this.bird, x = b.dead ? this.bx : this.bx, y = b.y;
    const fl = this.flame * (0.82 + 0.12 * Math.sin(this.t * 17) + 0.06 * Math.sin(this.t * 29 + 1));
    // glow
    ctx.save(); ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = 0.9 * fl;
    ctx.drawImage(this.sprites.glow, x - 70, y - 70, 140, 140);
    ctx.restore();
    ctx.save();
    ctx.translate(x, y); ctx.rotate(b.rot);
    const sq = 1.2 * (1 + 0.08 * b.flap), sy = 1.2 * (1 - 0.08 * b.flap);
    ctx.scale(sq, sy);
    // tassel
    const sway = Math.sin(this.t * 5 + b.vy * 0.003) * 3 - b.vy * 0.012;
    ctx.strokeStyle = '#e8b04a'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(0, 18); ctx.quadraticCurveTo(sway * 0.5, 26, sway, 33); ctx.stroke();
    ctx.fillStyle = '#e8b04a'; ctx.beginPath(); ctx.ellipse(sway, 35, 3, 5, 0, 0, TAU); ctx.fill();
    // body
    const lit = this.flame;
    const bg = ctx.createRadialGradient(0, -2, 1, 0, 0, 22);
    const c0 = lit > 0.05 ? `rgb(255,${Math.round(150 + 90 * fl)},${Math.round(70 + 40 * fl)})` : '#5a2a22';
    bg.addColorStop(0, mix('#4a1e1a', c0, lit)); bg.addColorStop(0.55, mix('#6a2a22', '#f0562e', 0.4 + 0.6 * lit)); bg.addColorStop(1, mix('#3c1914', '#b82a22', 0.3 + 0.7 * lit));
    ctx.fillStyle = bg;
    ctx.beginPath(); ctx.ellipse(0, 0, 16.5, 19, 0, 0, TAU); ctx.fill();
    // ribs
    ctx.strokeStyle = `rgba(255,225,170,${0.18 + 0.4 * lit})`; ctx.lineWidth = 1.3;
    for (const rx of [-11, -5.5, 0, 5.5, 11]) {
      ctx.beginPath(); ctx.ellipse(0, 0, Math.abs(rx) * 1.0 + 0.01, 19 * (1 - Math.abs(rx) / 60), 0, -Math.PI / 2, Math.PI / 2);
      ctx.moveTo(0, -19); ctx.stroke();
    }
    ctx.beginPath(); ctx.moveTo(0, -19); ctx.lineTo(0, 19); ctx.stroke();
    ctx.beginPath(); ctx.ellipse(0, 0, 16.5, 7, 0, 0, TAU); ctx.stroke();
    // caps
    ctx.fillStyle = '#3a2418';
    roundRect(ctx, -9, -22, 18, 6, 2); ctx.fill();
    roundRect(ctx, -9, 16, 18, 5, 2); ctx.fill();
    ctx.fillStyle = `rgba(232,176,74,${0.5 + 0.4 * lit})`; ctx.fillRect(-9, -20, 18, 1.5);
    // flame core
    if (lit > 0.02) {
      ctx.globalAlpha = Math.min(1, lit * 0.9);
      const fg = ctx.createRadialGradient(0, 2, 0, 0, 2, 11);
      fg.addColorStop(0, 'rgba(255,250,210,0.95)'); fg.addColorStop(1, 'rgba(255,200,100,0)');
      ctx.fillStyle = fg; ctx.beginPath(); ctx.ellipse(0, 2 - fl * 1.5, 9, 12 * fl + 2, 0, 0, TAU); ctx.fill();
      ctx.globalAlpha = 1;
    }
    // highlight
    ctx.fillStyle = 'rgba(255,255,255,0.18)'; ctx.beginPath(); ctx.ellipse(-7, -8, 3.2, 6, -0.3, 0, TAU); ctx.fill();
    ctx.restore();
  }
}

function mix(a, b, t) {
  const pa = parse(a), pb = parse(b);
  return `rgb(${Math.round(pa[0] + (pb[0] - pa[0]) * t)},${Math.round(pa[1] + (pb[1] - pa[1]) * t)},${Math.round(pa[2] + (pb[2] - pa[2]) * t)})`;
}
function parse(c) {
  if (c[0] === '#') { const n = parseInt(c.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; }
  const m = c.match(/\d+/g); return [+m[0], +m[1], +m[2]];
}

Arcade.register({
  id: 'glide',
  name: 'Lantern Glide',
  genre: 'Flappy flyer',
  aiNote: "Sees the lantern and the stalks already on screen, never gates still off-screen, and taps with human latency at most every 0.12 s.",
  blurb: 'A paper lantern drifts through a bamboo grove at dusk.',
  bg: '#2a2160',
  accent: '#ff8a4a',
  endless: true,
  parScore: 115,
  twists: TWISTS,
  create(opts = {}) { return new Glide(opts); },
});
})();
