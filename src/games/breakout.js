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
// Prism Breaker — brick breaker. Logical field 1000x760, scaled to fit.
// ---------------------------------------------------------------------------
const FW = 1000, FH = 760;
const COLS = 12, ROWS = 8;
const BX0 = 30, BW = (FW - 60) / COLS, BH = 26, BY0 = 84;
const PADY = 700, PADH = 16, PADW = 130, PADMAX = 1100;
const BR = 8; // ball radius
const BASE_SPEED = 520, SPEED_STEP = 12, MAX_SPEED = 860;
const TIME_CAP = 360;
const TRAIL = 14;

function brickHp(kind, r, c) {
  const dx = Math.abs(c - 5.5);
  switch (kind) {
    case 'wall': return 1;
    case 'pyramid': return dx <= 1.0 + r * 0.7 ? 1 : 0;
    case 'diamond': return dx / 6 + Math.abs(r - 3.5) / 4.2 <= 1 ? 1 : 0;
    case 'checker': return (r + c) % 2 === 0 ? (r <= 3 ? 2 : 1) : 0;
  }
  return 1;
}

// ---------------------------------------------------------------------------
// AI. It can see ONLY what a human sees on the screen: the ball position this
// frame, the paddle position/width, which bricks are still standing (and
// whether armored ones are cracked), and the field geometry. Ball velocity is
// estimated from the last two observed ball positions. It acts through a single
// output: the x it wants the paddle at; the game moves the paddle at <= 1100 u/s.
// ---------------------------------------------------------------------------
// Tactic styles weight scoreAim: channel = bonus for opening a column to the top, depth = preference for
// deeper (lower) rows, edge = preference for bricks far from the centre column.
const BO_STYLES = [
  { name: 'Tunneler', channel: 5, depth: 0.15, edge: 0 },
  { name: 'Sweeper', channel: 1, depth: 0.95, edge: 0 },
  { name: 'Edge hunter', channel: 2.5, depth: 0.15, edge: 0.75 },
];
const BreakoutAI = {
  style: BO_STYLES[0],
  hist: [], aimErr: 0, aimOff: 0, aimTick: 0, lastTarget: FW / 2,
  reset(style) { if (style) this.style = style; this.hist = []; this.aimOff = 0; this.aimTick = 0; this.lastTarget = FW / 2; },

  // march a ball (unit dir) with wall + brick bounces. Returns landing info.
  trace(hp, x, y, dx, dy, stopAtBrick, stopY) {
    const ds = 4; let dist = 0;
    const removed = stopAtBrick ? null : new Set();
    const maxY = BY0 + ROWS * BH + BR;
    for (let i = 0; i < 1500; i++) {
      const px = x, py = y;
      x += dx * ds; y += dy * ds; dist += ds;
      if (x < BR) { x = 2 * BR - x; dx = -dx; } else if (x > FW - BR) { x = 2 * (FW - BR) - x; dx = -dx; }
      if (y < BR) { y = 2 * BR - y; dy = -dy; }
      if (dy > 0 && y >= stopY) return { x, y, dist, brick: -1 };
      if (y < maxY) {
        const c0 = Math.floor((x - BR - BX0) / BW), c1 = Math.floor((x + BR - BX0) / BW);
        const r0 = Math.floor((y - BR - BY0) / BH), r1 = Math.floor((y + BR - BY0) / BH);
        let hit = false;
        for (let r = Math.max(0, r0); r <= Math.min(ROWS - 1, r1) && !hit; r++) {
          for (let c = Math.max(0, c0); c <= Math.min(COLS - 1, c1); c++) {
            const idx = r * COLS + c;
            if (hp[idx] <= 0 || (removed && removed.has(idx))) continue;
            const bx = BX0 + c * BW, by = BY0 + r * BH;
            const cx = Math.min(Math.max(x, bx), bx + BW), cy = Math.min(Math.max(y, by), by + BH);
            const ex = x - cx, ey = y - cy;
            if (ex * ex + ey * ey >= BR * BR) continue;
            if (stopAtBrick) return { x, y, dist, brick: idx };
            // axis reflection based on where we came from
            const inX = px >= bx - BR && px <= bx + BW + BR;
            if (inX) dy = -dy; else dx = -dx;
            x = px; y = py;
            if (hp[idx] <= 1) removed.add(idx);
            hit = true; break;
          }
        }
      }
    }
    return { x, y, dist, brick: -1 };
  },

  scoreAim(hp, idx, off, nAlive) {
    const r = Math.floor(idx / COLS), c = idx % COLS;
    let s = 1;
    let above = 0;
    for (let rr = 0; rr < r; rr++) if (hp[rr * COLS + c] > 0) above++;
    const h = hp[idx];
    if (above === 0 && h <= 1) s += this.style.channel;                 // opens a channel above the wall
    if (above === 0 && h > 1) s += 1.5;                // damages the channel-brick
    // sparsity: empty neighbours (4-neighbourhood)
    let empty = 0;
    if (c === 0 || hp[idx - 1] <= 0) empty++;
    if (c === COLS - 1 || hp[idx + 1] <= 0) empty++;
    if (r === 0 || hp[idx - COLS] <= 0) empty++;
    if (r < ROWS - 1 && hp[idx + COLS] <= 0) empty++;
    s += empty * (nAlive < 24 ? 1.2 : 0.5);
    // prefer taking down tall columns top-down only when there is no hole; deeper first = more time in the wall
    s += r * this.style.depth + Math.abs(c - 5.5) * this.style.edge + Math.random() * 0.03;
    if (h > 1) s -= 0.6;
    s -= Math.abs(off) * 1.4;
    return s;
  },

  act(obs, dt) {
    const hp = obs.hp;
    if (!obs.ball) { this.hist.length = 0; this.lastTarget = FW / 2; return FW / 2; }
    const b = { x: obs.ball.x, y: obs.ball.y };
    if (obs.held) { this.hist.length = 0; return b.x; }
    // Human-like perception: ~0.1 s reaction delay, a little positional noise on what is
    // read off the screen, and velocity smoothed over a few frames.
    const D = 15, Wn = 6;
    this.hist.push({ x: b.x + rnd.gauss() * 3, y: b.y + rnd.gauss() * 3 });
    if (this.hist.length > D + Wn + 1) this.hist.shift();
    if (this.hist.length < D + Wn + 1) return this.lastTarget;
    const cur = this.hist[0], old = this.hist[Wn];
    const vx = (old.x - cur.x) / (Wn * dt), vy = (old.y - cur.y) / (Wn * dt);
    const spd = Math.hypot(vx, vy);
    b.x = old.x; b.y = old.y; // (seen D frames ago)
    if (spd < 50) { return this.lastTarget; }
    const dx = vx / spd, dy = vy / spd;
    const stopY = PADY - PADH / 2 - BR;
    const land = this.trace(hp, b.x, b.y, dx, dy, false, stopY);
    const L = land.x;
    const tLeft = land.dist / spd - D * dt;
    const hw = PADW / 2;
    let target = L;
    if (dy > 0.05 || b.y > 380) {
      this.aimTick--;
      if (this.aimTick <= 0) {
        this.aimTick = 6;
        let nAlive = 0; for (let i = 0; i < hp.length; i++) if (hp[i] > 0) nAlive++;
        let best = -1e9, bestOff = 0;
        const reach = PADMAX * Math.max(0, tLeft - 0.05) * 0.85;
        for (let off = -0.85; off <= 0.8501; off += 0.05) {
          let tx = L - off * hw;
          tx = Math.min(Math.max(tx, hw), FW - hw);
          const realOff = (L - tx) / hw;
          if (Math.abs(realOff - off) > 0.06) continue;
          if (Math.abs(tx - obs.padX) > reach + 8) continue;
          const a = off * (Math.PI / 3);
          const res = this.trace(hp, L, stopY, Math.sin(a), -Math.cos(a), true, 1e9);
          let s;
          if (res.brick < 0) s = -3 - Math.abs(off); else s = this.scoreAim(hp, res.brick, off, nAlive);
          if (Math.abs(off - this.aimOff) < 0.001) s += 0.4; // hysteresis
          if (s > best) { best = s; bestOff = off; }
        }
        // nothing reachable: just get under the ball as far as possible
        this.aimOff = best > -1e8 ? bestOff : 0;
        this.aimErr = this.aimErr * 0.5 + rnd.gauss() * 17; // imprecise hand
      }
      target = L - this.aimOff * hw + this.aimErr;
    } else {
      this.aimTick = 0;
    }
    target = Math.min(Math.max(target, hw), FW - hw);
    this.lastTarget = target;
    return target;
  },
};

// ---------------------------------------------------------------------------
// Game
// ---------------------------------------------------------------------------
class Breakout {
  constructor() {
    this.over = false; this.won = false;
    this.t = 0; this.overT = 0;
    this.W = 1600; this.H = 900;
    this.kind = rnd.pick(['wall', 'pyramid', 'diamond', 'checker']);
    this.hp = new Array(COLS * ROWS).fill(0);
    this.maxhp = new Array(COLS * ROWS).fill(0);
    this.flash = new Array(COLS * ROWS).fill(0);
    this.total = 0;
    for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) {
      const h = brickHp(this.kind, r, c);
      this.hp[r * COLS + c] = h; this.maxhp[r * COLS + c] = h; if (h) this.total++;
    }
    this.left = this.total;
    this.pad = { x: FW / 2, v: 0, flash: 0, squash: 0 };
    this.lives = 3; this.score = 0; this.speed = BASE_SPEED;
    this.ball = { x: FW / 2, y: PADY - PADH / 2 - BR, vx: 0, vy: 0, held: true, lost: false };
    this.ready = 1.7;
    this.trail = [];
    this.shards = []; this.parts = new Particles(); this.texts = [];
    this.shake = 0; this.shakeT = 0; this.endMsg = ''; this.lostFlash = 0;
    this.padVisible = 1;
    this.sprites = null;
    this.rays = [];
    for (let i = 0; i < 6; i++) this.rays.push({ x: rnd.float(-0.2, 1.2), w: rnd.float(0.06, 0.16), sp: rnd.float(0.004, 0.012), a: rnd.float(0.03, 0.07) });
    this.styleDef = rnd.pick(BO_STYLES); this.style = this.styleDef.name;
    BreakoutAI.reset(this.styleDef);
  }

  resize(W, H) {
    this.W = W; this.H = H;
    this.s = Math.min(W * 0.9 / FW, H * 0.9 / FH);
    this.ox = (W - FW * this.s) / 2; this.oy = (H - FH * this.s) / 2;
  }

  // snapshot of what is visible on screen
  observe() {
    const b = this.ball;
    return {
      ball: this.over ? null : { x: b.x, y: b.y },
      held: b.held,
      padX: this.pad.x,
      hp: this.hp.slice(),
    };
  }

  _ipg() { return [[[this.ball], ['x', 'y'], 140], [[this.pad], ['x'], 140], [this.shards, ['x', 'y', 'rot'], 200]]; }

  step(dt) {

    IP.snap(this._ipg());
    this.t += dt;
    this.parts.update(dt);
    for (let i = this.shards.length - 1; i >= 0; i--) {
      const s = this.shards[i];
      s.life += dt; s.vy += 900 * dt; s.x += s.vx * dt; s.y += s.vy * dt; s.rot += s.vr * dt;
      if (s.life > s.max) { this.shards[i] = this.shards[this.shards.length - 1]; this.shards.pop(); }
    }
    for (let i = this.texts.length - 1; i >= 0; i--) {
      const f = this.texts[i]; f.life += dt; if (f.life > 0.9) { this.texts[i] = this.texts[this.texts.length - 1]; this.texts.pop(); }
    }
    for (let i = 0; i < this.flash.length; i++) if (this.flash[i] > 0) this.flash[i] = Math.max(0, this.flash[i] - dt * 5);
    this.shake = Math.max(0, this.shake - dt * 14);
    this.shakeT += dt;
    this.pad.flash = Math.max(0, this.pad.flash - dt * 4);
    this.pad.squash = Math.max(0, this.pad.squash - dt * 6);
    this.lostFlash = Math.max(0, this.lostFlash - dt * 2);

    if (this.over) {
      this.overT += dt;
      if (this.won) {
        if (Math.random() < 0.18) this.parts.burst(rnd.float(150, 850), rnd.float(120, 420), 26, { color: ['#ffd36b', '#ff7ab6', '#7be0ff', '#b7ff9a', '#fff'], speed: 320, life: 1.3, size: 3.4, gravity: 220, drag: 1.4 });
      }
      this.movePaddle(dt, this.pad.x);
      return;
    }
    if (this.t > TIME_CAP) { this.finish(false, 'Out of time'); return; }

    const target = BreakoutAI.act(this.observe(), dt);
    this.movePaddle(dt, target);

    const b = this.ball;
    if (b.held) {
      b.x = this.pad.x; b.y = PADY - PADH / 2 - BR;
      this.ready -= dt;
      this.trail.length = 0;
      if (this.ready <= 0) {
        const a = rnd.float(-0.45, 0.45);
        b.held = false; b.vx = Math.sin(a) * this.speed; b.vy = -Math.cos(a) * this.speed;
        this.parts.burst(b.x, b.y, 10, { angle: -Math.PI / 2, spread: 1.2, color: '#fff', speed: 160, life: 0.5, size: 3 });
      }
      return;
    }
    this.moveBall(dt);
    this.trail.push(b.x, b.y);
    if (this.trail.length > TRAIL * 2) this.trail.splice(0, 2);
  }

  movePaddle(dt, target) {
    const p = this.pad;
    const hw = PADW / 2;
    const want = Math.max(-PADMAX, Math.min(PADMAX, (target - p.x) * 12));
    p.v += (want - p.v) * Math.min(1, dt * 22);
    p.v = Math.max(-PADMAX, Math.min(PADMAX, p.v));
    p.x += p.v * dt;
    if (p.x < hw) { p.x = hw; p.v = 0; } else if (p.x > FW - hw) { p.x = FW - hw; p.v = 0; }
  }

  moveBall(dt) {
    const b = this.ball;
    const dist = this.speed * dt;
    const n = Math.max(1, Math.ceil(dist / 4));
    const h = dt / n;
    const padTop = PADY - PADH / 2;
    for (let i = 0; i < n; i++) {
      b.x += b.vx * h; b.y += b.vy * h;
      let bounced = false;
      if (b.x < BR) { b.x = BR; b.vx = Math.abs(b.vx); bounced = true; this.wallPing(b.x - BR, b.y); }
      else if (b.x > FW - BR) { b.x = FW - BR; b.vx = -Math.abs(b.vx); bounced = true; this.wallPing(b.x + BR, b.y); }
      if (b.y < BR) { b.y = BR; b.vy = Math.abs(b.vy); bounced = true; this.wallPing(b.x, 0); }

      // paddle
      if (b.vy > 0 && b.y + BR >= padTop && b.y - BR <= PADY + PADH / 2 && Math.abs(b.x - this.pad.x) <= PADW / 2 + BR * 0.6) {
        const off = Math.max(-1, Math.min(1, (b.x - this.pad.x) / (PADW / 2)));
        this.speed = Math.min(MAX_SPEED, this.speed + SPEED_STEP);
        const a = off * (Math.PI / 3);
        b.vx = Math.sin(a) * this.speed; b.vy = -Math.cos(a) * this.speed;
        b.y = padTop - BR;
        this.pad.flash = 1; this.pad.squash = 1;
        this.parts.burst(b.x, padTop, 8, { angle: -Math.PI / 2, spread: 1.3, color: ['#fff', '#cfa8ff', '#8fe9ff'], speed: 200, life: 0.5, size: 2.6 });
        bounced = false;
      }

      // bricks
      if (b.y < BY0 + ROWS * BH + BR) {
        const c0 = Math.floor((b.x - BR - BX0) / BW), c1 = Math.floor((b.x + BR - BX0) / BW);
        const r0 = Math.floor((b.y - BR - BY0) / BH), r1 = Math.floor((b.y + BR - BY0) / BH);
        let bestD = 1e9, bi = -1, bnx = 0, bny = 0, bpx = 0, bpy = 0;
        for (let r = Math.max(0, r0); r <= Math.min(ROWS - 1, r1); r++) {
          for (let c = Math.max(0, c0); c <= Math.min(COLS - 1, c1); c++) {
            const idx = r * COLS + c;
            if (this.hp[idx] <= 0) continue;
            const bx = BX0 + c * BW, by = BY0 + r * BH;
            const cx = Math.min(Math.max(b.x, bx), bx + BW), cy = Math.min(Math.max(b.y, by), by + BH);
            const ex = b.x - cx, ey = b.y - cy;
            const d2 = ex * ex + ey * ey;
            if (d2 >= BR * BR || d2 >= bestD) continue;
            bestD = d2; bi = idx; bpx = cx; bpy = cy;
            if (d2 < 1e-6) { // centre inside the brick: push out along the shallow axis
              const l = b.x - bx, rr = bx + BW - b.x, t = b.y - by, bt = by + BH - b.y;
              const m = Math.min(l, rr, t, bt);
              bnx = m === l ? -1 : m === rr ? 1 : 0; bny = m === t ? -1 : m === bt ? 1 : 0;
              if (!bnx && !bny) bny = -1;
            } else { const d = Math.sqrt(d2); bnx = ex / d; bny = ey / d; }
          }
        }
        if (bi >= 0) {
          const dot = b.vx * bnx + b.vy * bny;
          if (dot < 0) { b.vx -= 2 * dot * bnx; b.vy -= 2 * dot * bny; }
          b.x = bpx + bnx * (BR + 0.05) ; b.y = bpy + bny * (BR + 0.05);
          this.hitBrick(bi);
          bounced = true;
        }
      }
      if (bounced) {
        // keep exact speed and avoid ultra-flat trajectories
        let m = Math.hypot(b.vx, b.vy) || 1;
        b.vx = b.vx / m * this.speed; b.vy = b.vy / m * this.speed;
        const minV = this.speed * 0.22;
        if (Math.abs(b.vy) < minV) {
          b.vy = (b.vy >= 0 ? 1 : -1) * minV;
          b.vx = Math.sign(b.vx || 1) * Math.sqrt(Math.max(0, this.speed * this.speed - minV * minV));
        }
      }
      if (b.y > FH + 30) { this.loseBall(); return; }
    }
  }

  wallPing(x, y) {
    this.parts.burst(x, y, 3, { color: '#c9a6ff', speed: 90, life: 0.35, size: 2 });
  }

  hitBrick(idx) {
    const r = Math.floor(idx / COLS), c = idx % COLS;
    const bx = BX0 + c * BW + BW / 2, by = BY0 + r * BH + BH / 2;
    this.hp[idx]--;
    const hue = this.hueOf(r);
    this.shake = Math.min(1, this.shake + 0.5);
    if (this.hp[idx] > 0) {
      this.flash[idx] = 1;
      this.parts.burst(bx, by, 8, { color: ['#fff', '#cfd6e6'], speed: 180, life: 0.4, size: 2.4 });
      this.score += 5;
      return;
    }
    this.left--;
    const pts = (ROWS - r) * 10 * (this.maxhp[idx]);
    this.score += pts;
    const col = `hsl(${hue},75%,60%)`;
    const n = 6 + rnd.int(5);
    for (let i = 0; i < n; i++) {
      const a = rnd.float(0, Math.PI * 2), sp = rnd.float(80, 320);
      this.shards.push({
        x: bx + rnd.float(-BW / 3, BW / 3), y: by + rnd.float(-BH / 3, BH / 3),
        vx: Math.cos(a) * sp + this.ball.vx * 0.15, vy: Math.sin(a) * sp - 120 + this.ball.vy * 0.1,
        rot: rnd.float(0, 6.3), vr: rnd.float(-12, 12), size: rnd.float(5, 11), life: 0, max: rnd.float(0.7, 1.3),
        color: col, hue,
      });
    }
    this.parts.burst(bx, by, 14, { color: [`hsl(${hue},90%,75%)`, '#fff', `hsl(${hue + 20},90%,70%)`], speed: 260, life: 0.8, size: 3, gravity: 120 });
    this.texts.push({ x: bx, y: by, txt: '+' + pts, life: 0, hue });
    if (this.left <= 0) this.finish(true, `Cleared all ${this.total} bricks`);
  }

  hueOf(r) { return (338 + r * 38) % 360; }

  loseBall() {
    const b = this.ball;
    this.lives--;
    this.lostFlash = 1;
    this.shake = 1;
    this.parts.burst(b.x, FH - 10, 26, { angle: -Math.PI / 2, spread: 1.4, color: ['#ff9ad0', '#fff', '#ffcf7a'], speed: 360, life: 0.9, size: 3.4, gravity: 300 });
    if (this.lives <= 0) { this.finish(false, `Ran out of lives with ${this.left} bricks left`); return; }
    this.speed = Math.max(BASE_SPEED, this.speed - 60);
    b.held = true; b.vx = b.vy = 0; this.ready = 1.0; this.trail.length = 0;
    b.x = this.pad.x; b.y = PADY - PADH / 2 - BR;
  }

  finish(won, msg) {
    this.over = true; this.won = won; this.endMsg = msg;
    this.ball.held = false;
    if (won) {
      this.parts.burst(FW / 2, 300, 120, { color: ['#ffd36b', '#ff7ab6', '#7be0ff', '#b7ff9a', '#fff'], speed: 520, life: 1.6, size: 4, gravity: 200, drag: 1.2 });
    } else {
      this.parts.burst(this.pad.x, PADY, 40, { color: ['#e7d7ff', '#8fe9ff', '#fff'], speed: 380, life: 1.2, size: 3.4, gravity: 400 });
    }
  }

  hud() {
    return { score: String(this.score).replace(/\B(?=(\d{3})+$)/g, ' '), detail: `Lives ${Math.max(0, this.lives)} · ${this.left} bricks left` };
  }
  result() { return this.endMsg + (this.won ? ` with ${this.lives} ${this.lives === 1 ? 'life' : 'lives'} to spare` : '') + ` (${this.style})`; }

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
      ball: mk(128, [[0, 'rgba(255,255,255,0.95)'], [0.18, 'rgba(255,240,255,0.6)'], [0.45, 'rgba(190,140,255,0.2)'], [1, 'rgba(190,140,255,0)']]),
      pad: mk(128, [[0, 'rgba(160,120,255,0.55)'], [0.5, 'rgba(120,90,255,0.18)'], [1, 'rgba(120,90,255,0)']]),
    };
  }

  draw(ctx, W, H) {

    const a = IP.alpha();

    const st = IP.push(this._ipg(), a);

    try { this._draw(ctx, W, H); } finally { IP.pop(st); }

  }

  _draw(ctx, W, H) {
    if (!this.sprites) this.makeSprites();
    const t = this.t;
    // background
    liveLayer(ctx, 'bg', W, H, 8, (x, W, H) => {
      const gx = W * (0.5 + 0.08 * Math.sin(t * 0.13)), gy = H * (0.38 + 0.05 * Math.cos(t * 0.17));
      const bg = x.createRadialGradient(gx, gy, 0, gx, gy, Math.max(W, H) * 0.75);
      bg.addColorStop(0, '#2b1558'); bg.addColorStop(0.55, '#1b0e38'); bg.addColorStop(1, '#0d0618');
      x.fillStyle = '#140a24'; x.fillRect(0, 0, W, H);
      x.fillStyle = bg; x.fillRect(0, 0, W, H);
    });
    // diagonal light rays
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.translate(W / 2, H / 2); ctx.rotate(-0.55);
    const D = Math.hypot(W, H);
    for (const r of this.rays) {
      const x = ((r.x + t * r.sp) % 1.6 - 0.3) * D - D / 2;
      const w = r.w * D;
      const g = ctx.createLinearGradient(x - w, 0, x + w, 0);
      const a = r.a * (0.7 + 0.3 * Math.sin(t * 0.4 + r.x * 9));
      g.addColorStop(0, 'rgba(180,140,255,0)'); g.addColorStop(0.5, `rgba(180,140,255,${a})`); g.addColorStop(1, 'rgba(180,140,255,0)');
      ctx.fillStyle = g; ctx.fillRect(x - w, -D, w * 2, D * 2);
    }
    ctx.restore();

    const s = this.s;
    let sx = 0, sy = 0;
    if (this.shake > 0.01) { sx = Math.sin(this.shakeT * 90) * 2 * this.shake; sy = Math.cos(this.shakeT * 77) * 2 * this.shake; }
    ctx.save();
    ctx.translate(this.ox + sx * s, this.oy + sy * s);
    ctx.scale(s, s);

    // field panel
    roundRect(ctx, -6, -6, FW + 12, FH + 12, 18);
    ctx.fillStyle = 'rgba(10,4,24,0.38)'; ctx.fill();
    ctx.lineWidth = 2; ctx.strokeStyle = 'rgba(190,160,255,0.16)'; ctx.stroke();
    // faint lower glow when ball lost
    if (this.lostFlash > 0) {
      const g = ctx.createLinearGradient(0, FH - 120, 0, FH);
      g.addColorStop(0, 'rgba(255,100,160,0)'); g.addColorStop(1, `rgba(255,100,160,${0.35 * this.lostFlash})`);
      ctx.fillStyle = g; ctx.fillRect(0, FH - 120, FW, 120);
    }

    // bricks
    const sweep = this.t < 1.6 ? (this.t / 1.2) : 9;
    for (let r = 0; r < ROWS; r++) {
      const hue = this.hueOf(r);
      for (let c = 0; c < COLS; c++) {
        const idx = r * COLS + c;
        if (this.hp[idx] <= 0) continue;
        this.drawBrick(ctx, BX0 + c * BW, BY0 + r * BH, hue, idx, sweep, c, r);
      }
    }

    // shards
    for (const sh of this.shards) {
      const a = 1 - sh.life / sh.max;
      ctx.save(); ctx.translate(sh.x, sh.y); ctx.rotate(sh.rot);
      ctx.globalAlpha = Math.min(1, a * 1.6);
      ctx.fillStyle = sh.color;
      ctx.beginPath(); ctx.moveTo(-sh.size, sh.size * 0.5); ctx.lineTo(sh.size * 0.9, -sh.size * 0.3); ctx.lineTo(-sh.size * 0.1, -sh.size); ctx.closePath(); ctx.fill();
      ctx.globalAlpha = Math.min(1, a * 1.6) * 0.5; ctx.fillStyle = '#fff';
      ctx.beginPath(); ctx.moveTo(-sh.size, sh.size * 0.5); ctx.lineTo(-sh.size * 0.1, -sh.size); ctx.lineTo(-sh.size * 0.3, 0); ctx.closePath(); ctx.fill();
      ctx.restore();
    }

    // floating score
    ctx.font = '600 15px Fredoka, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    for (const f of this.texts) {
      const k = f.life / 0.9;
      ctx.globalAlpha = (1 - k) * 0.9; ctx.fillStyle = `hsl(${f.hue},90%,82%)`;
      ctx.fillText(f.txt, f.x, f.y - 6 - ease.outCubic(k) * 30);
    }
    ctx.globalAlpha = 1;

    this.parts.draw(ctx, 1);

    // lives
    for (let i = 0; i < 3; i++) {
      const x = FW - 28 - i * 24, y = FH - 22;
      const alive = i < this.lives;
      ctx.beginPath(); ctx.arc(x, y, 6, 0, TAU);
      ctx.fillStyle = alive ? '#fff' : 'rgba(255,255,255,0.12)'; ctx.fill();
      if (alive) { ctx.globalAlpha = 0.4; ctx.drawImage(this.sprites.ball, x - 16, y - 16, 32, 32); ctx.globalAlpha = 1; }
    }

    // paddle
    this.drawPaddle(ctx);
    // ball
    this.drawBall(ctx);

    ctx.restore();

    // soft vignette
    staticLayer(ctx, 'vg', W, H, (x, W, H) => {
      const vg = x.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.45, W / 2, H / 2, Math.max(W, H) * 0.8);
      vg.addColorStop(0, 'rgba(0,0,0,0)'); vg.addColorStop(1, 'rgba(0,0,0,0.45)');
      x.fillStyle = vg; x.fillRect(0, 0, W, H);
    });
  }

  drawBrick(ctx, x, y, hue, idx, sweep, c, r) {
    const inset = 1.6;
    const hp = this.hp[idx], armored = this.maxhp[idx] > 1;
    const bx = x + inset, by = y + inset, bw = BW - inset * 2, bh = BH - inset * 2;
    const fl = this.flash[idx];
    // idle shimmer
    const sh = 0.5 + 0.5 * Math.sin(this.t * 1.1 - c * 0.5 - r * 0.9);
    const light = armored ? 40 + fl * 25 : 54 + fl * 28 + sh * 3;
    const sat = armored ? 45 : 72;
    const g = ctx.createLinearGradient(0, by, 0, by + bh);
    g.addColorStop(0, `hsl(${hue},${sat}%,${light + 12}%)`);
    g.addColorStop(1, `hsl(${hue},${sat + 6}%,${light - 12}%)`);
    roundRect(ctx, bx, by, bw, bh, 5);
    ctx.fillStyle = g; ctx.fill();
    // top bevel highlight
    ctx.fillStyle = 'rgba(255,255,255,0.32)';
    roundRect(ctx, bx + 2, by + 1.5, bw - 4, 4, 2); ctx.fill();
    // bottom shade
    ctx.fillStyle = 'rgba(0,0,0,0.22)';
    ctx.fillRect(bx + 3, by + bh - 4, bw - 6, 3);
    // facet glint
    const gl = Math.max(0, Math.sin(this.t * 0.7 + c * 0.9 + r * 1.7));
    if (gl > 0.985) { ctx.fillStyle = 'rgba(255,255,255,0.5)'; ctx.fillRect(bx + bw * 0.2, by + 2, bw * 0.25, bh - 4); }
    if (armored) {
      roundRect(ctx, bx + 0.5, by + 0.5, bw - 1, bh - 1, 5);
      ctx.lineWidth = hp > 1 ? 2 : 1; ctx.strokeStyle = hp > 1 ? 'rgba(225,232,255,0.85)' : 'rgba(225,232,255,0.35)'; ctx.stroke();
      ctx.fillStyle = 'rgba(235,240,255,0.75)';
      for (const px of [bx + 6, bx + bw - 6]) { ctx.beginPath(); ctx.arc(px, by + bh / 2, 1.6, 0, TAU); ctx.fill(); }
      if (hp <= 1) { // cracks
        ctx.strokeStyle = 'rgba(10,0,30,0.7)'; ctx.lineWidth = 1.2;
        ctx.beginPath(); ctx.moveTo(bx + bw * 0.45, by + 1); ctx.lineTo(bx + bw * 0.52, by + bh * 0.4); ctx.lineTo(bx + bw * 0.42, by + bh * 0.65); ctx.lineTo(bx + bw * 0.55, by + bh - 1); ctx.stroke();
      }
    }
    if (fl > 0) { ctx.fillStyle = `rgba(255,255,255,${0.5 * fl})`; roundRect(ctx, bx, by, bw, bh, 5); ctx.fill(); }
    // opening light sweep
    const sp = sweep - (c + (ROWS - r) * 0.6) / (COLS + ROWS);
    if (sp > 0 && sp < 0.35) {
      ctx.fillStyle = `rgba(255,255,255,${0.55 * Math.sin(sp / 0.35 * Math.PI)})`;
      roundRect(ctx, bx, by, bw, bh, 5); ctx.fill();
    }
  }

  drawPaddle(ctx) {
    const p = this.pad;
    if (this.over && !this.won) return;
    const sq = this.pad.squash;
    const w = PADW * (1 + 0.06 * sq), h = PADH * (1 - 0.25 * sq);
    const x = p.x - w / 2, y = PADY - h / 2 + 3 * sq;
    // under-glow
    ctx.globalAlpha = 0.9 + 0.1 * p.flash;
    ctx.drawImage(this.sprites.pad, p.x - 150, PADY - 60, 300, 120);
    ctx.globalAlpha = 1;
    const g = ctx.createLinearGradient(0, y, 0, y + h);
    g.addColorStop(0, '#ffffff'); g.addColorStop(0.5, '#d9c8ff'); g.addColorStop(1, '#8f7cff');
    roundRect(ctx, x, y, w, h, h / 2);
    ctx.fillStyle = g; ctx.fill();
    ctx.fillStyle = `rgba(255,255,255,${0.35 + 0.5 * p.flash})`;
    roundRect(ctx, x + 8, y + 2, w - 16, 3, 1.5); ctx.fill();
    // moving sheen
    const sh = ((this.t * 0.45) % 1.4) - 0.2;
    ctx.save(); roundRect(ctx, x, y, w, h, h / 2); ctx.clip();
    ctx.fillStyle = 'rgba(255,255,255,0.45)'; ctx.fillRect(x + sh * w, y, 10, h);
    ctx.restore();
  }

  drawBall(ctx) {
    const b = this.ball;
    if (this.over && !this.won) return;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    const tr = this.trail;
    const n = tr.length / 2;
    for (let i = 0; i < n; i++) {
      const k = (i + 1) / n;
      const r = BR * (0.25 + 0.75 * k);
      ctx.globalAlpha = 0.5 * k * k;
      ctx.drawImage(this.sprites.ball, tr[i * 2] - r * 2.6, tr[i * 2 + 1] - r * 2.6, r * 5.2, r * 5.2);
    }
    ctx.globalAlpha = 1;
    ctx.drawImage(this.sprites.ball, b.x - BR * 4, b.y - BR * 4, BR * 8, BR * 8);
    ctx.restore();
    ctx.beginPath(); ctx.arc(b.x, b.y, BR, 0, TAU);
    ctx.fillStyle = '#fff'; ctx.fill();
    ctx.beginPath(); ctx.arc(b.x, b.y, BR - 2.5, 0, TAU);
    ctx.fillStyle = '#fffbe8'; ctx.fill();
  }
}

Arcade.register({
  id: 'breakout',
  name: 'Prism Breaker',
  genre: 'Brick breaker',
  aiNote: "Sees only the ball, paddle and standing bricks, guesses the ball velocity from two frames, and reacts 0.1 s late with a paddle capped at 1100 units a second.",
  blurb: 'A comet of light shatters a wall of jewels.',
  bg: '#140a24',
  accent: '#b98cff',
  create() { return new Breakout(); },
});
})();
