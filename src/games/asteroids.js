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
// Orbital Drift — Asteroids. World height is fixed at 720 units; the width
// follows the canvas aspect, and the whole screen wraps.
// ---------------------------------------------------------------------------
const WH = 720;
const TURN = 240 * Math.PI / 180;   // rad/s
const THRUST = 380, DRAG = 0.95, MAX_V = 340;
const BULLET_V = 640, BULLET_LIFE = 1.0, FIRE_CD = 0.18, MAX_BULLETS = 4;
const SHIP_R = 11;
const RADII = [48, 27, 14];          // large, medium, small
const POINTS = [20, 50, 100];
const WIN_WAVE = 6;
const LIVES = 3;
const TIME_CAP = 360;
const LIGHT = { x: 0.6, y: 0.8 };    // direction the planet-shine comes from (towards the planet)
const wrapAng = a => { a %= TAU; if (a > Math.PI) a -= TAU; else if (a < -Math.PI) a += TAU; return a; };
const waveCount = w => 3 + w;                  // wave 1 -> 4 large rocks
const rockSpeed = w => 1 + 0.7 * (w - 1);
const MAX_ROCK_V = 300;

// ---------------------------------------------------------------------------
// AI. It sees what is on screen: the ship (position, heading, velocity -- the
// drift is visible), every rock (position, radius, drift -- visible motion),
// and the bullets in flight (position, direction, remaining life -- bullets fade
// as they age). It never sees future wave composition or random split kicks.
// It acts only through the player's four keys: rotate left, rotate right,
// thrust, fire -- the game applies the same turn rate, thrust, fire cooldown
// and 4-bullet limit as for a human.
// Each tick: (1) predict whether coasting is safe for the next 1.3 s; if not,
// either shoot the offender (if it can be done in time) or pick the best of
// 16 escape headings by simulating a short burn; (2) otherwise choose the rock
// with the smallest (time-to-aim + time-to-hit) via an intercept solution that
// accounts for wrapping, turn toward the lead angle and fire when a bullet fired
// now would hit something that no bullet in flight already covers.
// ---------------------------------------------------------------------------
const AsteroidsAI = {
  esc: null, plan: null, planAge: 99, lastTarget: -1, idle: 0, style: 'Hunter',
  // Styles: Turret (holds the centre, rotates and shoots), Hunter (flies at targets),
  // Sweeper (orbits the screen centre while shooting). Differ in positioning only.
  reset() { this.dir = 0; this.style = ['Turret', 'Hunter', 'Sweeper'][Math.floor(Math.random() * 3)]; this.idle = 0; this.esc = null; this.plan = null; this.planAge = 99; this.lastTarget = -1; },

  // minimum-image wrap of a delta
  md(d, S) { return d - Math.round(d / S) * S; },

  // earliest time t in (0, tmax] where |d + v t| == s t (bullet intercept); d = rock - shooter
  intercept(dx, dy, vx, vy, s, tmax) {
    const a = vx * vx + vy * vy - s * s, b = 2 * (dx * vx + dy * vy), c = dx * dx + dy * dy;
    let t = -1;
    if (Math.abs(a) < 1e-6) { if (Math.abs(b) > 1e-9) t = -c / b; }
    else {
      const disc = b * b - 4 * a * c;
      if (disc < 0) return -1;
      const sq = Math.sqrt(disc), t1 = (-b - sq) / (2 * a), t2 = (-b + sq) / (2 * a);
      t = Infinity;
      if (t1 > 0) t = t1;
      if (t2 > 0 && t2 < t) t = t2;
      if (t === Infinity) return -1;
    }
    return t > 0 && t <= tmax ? t : -1;
  },

  // closest approach of two linear movers within [0,tmax]; returns {t, d}
  closest(dx, dy, vx, vy, tmax) {
    const vv = vx * vx + vy * vy;
    let t = vv < 1e-9 ? 0 : -(dx * vx + dy * vy) / vv;
    t = clamp(t, 0, tmax);
    return { t, d: Math.hypot(dx + vx * t, dy + vy * t) };
  },

  // simulate the ship following a plan against drifting rocks; returns min clearance + first violation
  simulate(obs, heading, burn, turnTime) {
    const { W, H, ship, rocks } = obs;
    let x = ship.x, y = ship.y, vx = ship.vx, vy = ship.vy;
    const dt = 0.05, N = 28;
    let minClear = 1e9, tv = -1, hit = -1;
    let burned = 0;
    for (let i = 1; i <= N; i++) {
      const t = i * dt;
      if (heading != null && t >= turnTime && burned < burn) {
        const ax = Math.cos(heading) * THRUST, ay = Math.sin(heading) * THRUST;
        vx += ax * dt; vy += ay * dt; burned += dt;
      }
      const dr = Math.exp(-DRAG * dt); vx *= dr; vy *= dr;
      const sp = Math.hypot(vx, vy); if (sp > MAX_V) { vx *= MAX_V / sp; vy *= MAX_V / sp; }
      x += vx * dt; y += vy * dt;
      for (let k = 0; k < rocks.length; k++) {
        const r = rocks[k];
        const dx = this.md(r.x + r.vx * t - x, W), dy = this.md(r.y + r.vy * t - y, H);
        const c = Math.hypot(dx, dy) - r.r - SHIP_R;
        if (c < minClear) { minClear = c; }
        if (c < 14 && tv < 0) { tv = t; hit = k; }
      }
    }
    return { clear: minClear, tv, hit };
  },

  // Returns the key state {left,right,thrust,fire}.
  think(obs, dt) {
    const keys = { left: false, right: false, thrust: false, fire: false };
    const { W, H, ship, rocks, bullets } = obs;
    if (!ship.alive || !rocks.length) { this.esc = null; return keys; }
    this.planAge += dt;

    // --- bullet coverage: rocks that bullets already in flight will hit
    const claimed = new Array(rocks.length).fill(false);
    for (const b of bullets) {
      for (let k = 0; k < rocks.length; k++) {
        const r = rocks[k];
        const dx = this.md(r.x - b.x, W), dy = this.md(r.y - b.y, H);
        const c = this.closest(dx, dy, r.vx - b.vx, r.vy - b.vy, b.life);
        if (c.d < r.r + 4) claimed[k] = true;
      }
    }

    // --- targeting: lead angle for every rock
    let best = null;
    const tmax = BULLET_LIFE - 0.08;
    for (let k = 0; k < rocks.length; k++) {
      if (claimed[k]) continue;
      const r = rocks[k];
      const dx = this.md(r.x - ship.x, W), dy = this.md(r.y - ship.y, H);
      const t = this.intercept(dx, dy, r.vx, r.vy, BULLET_V, tmax);
      if (t < 0) continue;
      const ang = Math.atan2(dy + r.vy * t, dx + r.vx * t);
      const aimT = Math.abs(wrapAng(ang - ship.a)) / TURN;
      const c = this.closest(dx, dy, r.vx - ship.vx, r.vy - ship.vy, 2);
      const threat = c.d < r.r + SHIP_R + 60 ? 0.5 : 0;
      const cost = aimT + t * 0.8 - threat + (k === this.lastTarget ? -0.12 : 0) + (r.size === 2 ? 0.1 : 0) + Math.random() * 0.03;
      if (!best || cost < best.cost) best = { k, cost, ang, aimT, t };
    }

    // --- danger check (coast prediction) every few ticks
    let danger = null;
    if (!ship.inv) {
      if (this.planAge > 0.2 || !this.plan) {
        this.plan = this.simulate(obs, null, 0, 0);
        this.planAge = 0;
      }
      if (this.plan.clear < 16) danger = this.plan;
    }

    // --- escape state machine
    if (this.esc) {
      this.esc.ttl -= dt;
      if (this.esc.ttl <= 0) this.esc = null;
    }
    if (danger && !this.esc) {
      // can we shoot the offender in time?
      const off = rocks[danger.hit];
      let shoot = false;
      if (off && !claimed[danger.hit] && danger.tv > 0.55) {
        const dx = this.md(off.x - ship.x, W), dy = this.md(off.y - ship.y, H);
        const t = this.intercept(dx, dy, off.vx, off.vy, BULLET_V, tmax);
        if (t > 0) {
          const ang = Math.atan2(dy + off.vy * t, dx + off.vx * t);
          const aimT = Math.abs(wrapAng(ang - ship.a)) / TURN;
          if (aimT + t + 0.2 < danger.tv && off.size > 0) shoot = true;
          else if (aimT + t + 0.2 < danger.tv && danger.clear < 0) shoot = true;
        }
      }
      if (!shoot) {
        let bestH = null;
        for (let i = 0; i < 16; i++) {
          const hd = i / 16 * TAU;
          const turnT = Math.max(0, Math.abs(wrapAng(hd - ship.a)) / TURN - 0.1);
          const burn = 0.3;
          const s = this.simulate(obs, hd, burn, turnT);
          const score = Math.min(s.clear, 90) - turnT * 38 + (s.tv < 0 ? 25 : 0);
          if (!bestH || score > bestH.score) bestH = { hd, score, clear: s.clear };
        }
        // only commit if it is actually better than coasting
        if (bestH && bestH.clear > danger.clear + 4) {
          this.esc = { hd: bestH.hd, ttl: 0.55, burn: 0.3, facing: false };
        }
      }
    }

    let desired = null;           // angle to rotate toward
    if (this.esc) {
      desired = this.esc.hd;
      const err = Math.abs(wrapAng(desired - ship.a));
      if (err < 0.4 && this.esc.burn > 0) { keys.thrust = true; this.esc.burn -= dt; }
    } else if (best && this.idle < 3.0) {
      desired = best.ang;
    } else if (rocks.length && this.style !== 'Hunter') {
      // Turret: drift back to the centre; Sweeper: circle the centre
      const cx = this.md(W / 2 - ship.x, W), cy = this.md(H / 2 - ship.y, H), dist = Math.hypot(cx, cy);
      const sp = Math.hypot(ship.vx, ship.vy);
      if (this.style === 'Turret') {
        if (dist > 90 || sp > 60) {
          // steer against velocity plus pull toward centre
          const tx = cx * 1.2 - ship.vx * 1.5, ty = cy * 1.2 - ship.vy * 1.5;
          desired = Math.atan2(ty, tx);
          if (Math.abs(wrapAng(desired - ship.a)) < 0.3 && Math.hypot(tx, ty) > 60) keys.thrust = true;
        } else desired = null;
      } else {
        const R = Math.min(W, H) * 0.3;
        const rx = -cx, ry = -cy, rl = Math.max(1, Math.hypot(rx, ry));
        const dir = this.dir || (this.dir = Math.random() < 0.5 ? 1 : -1);
        const tx = -ry / rl * dir * 130 + (-rx / rl) * (rl - R) * 0.8 - ship.vx;
        const ty = rx / rl * dir * 130 + (-ry / rl) * (rl - R) * 0.8 - ship.vy;
        desired = Math.atan2(ty, tx);
        if (Math.abs(wrapAng(desired - ship.a)) < 0.3 && Math.hypot(tx, ty) > 40) keys.thrust = true;
      }
    } else if (rocks.length) {
      // nothing in reach (or no shot for a while): head for a point ahead of the nearest rock
      let bd = 1e9, bk = null;
      for (const r of rocks) {
        const dx = this.md(r.x - ship.x, W), dy = this.md(r.y - ship.y, H), d = dx * dx + dy * dy;
        if (d < bd) { bd = d; bk = Math.atan2(this.md(r.y + r.vy * 1.8 - ship.y, H), this.md(r.x + r.vx * 1.8 - ship.x, W)); }
      }
      desired = bk;
      if (Math.abs(wrapAng(bk - ship.a)) < 0.3 && Math.hypot(ship.vx, ship.vy) < 170) keys.thrust = true;
    }
    this.lastTarget = best ? best.k : -1;

    if (desired != null) {
      const err = wrapAng(desired - ship.a);
      const dead = clamp(0.5 * Math.atan2(30, 40 + (best ? best.t * BULLET_V : 0)), 0.008, TURN * dt * 0.5);
      if (err > dead) keys.right = true; else if (err < -dead) keys.left = true;
    }

    // --- fire: a bullet launched along the current heading would hit an uncovered rock
    // (accounting for the heading after this tick's rotation)
    const hd = ship.a + (keys.right ? TURN * dt : keys.left ? -TURN * dt : 0);
    const sx = ship.x + Math.cos(hd) * 14, sy = ship.y + Math.sin(hd) * 14;
    const bvx = Math.cos(hd) * BULLET_V, bvy = Math.sin(hd) * BULLET_V;
    for (let k = 0; k < rocks.length; k++) {
      if (claimed[k]) continue;
      const r = rocks[k];
      const dx = this.md(r.x - sx, W), dy = this.md(r.y - sy, H);
      const c = this.closest(dx, dy, r.vx - bvx, r.vy - bvy, tmax);
      if (c.d < r.r * 0.82) { keys.fire = true; break; }
    }
    this.idle = keys.fire ? 0 : this.idle + dt;
    return keys;
  },
};

// ---------------------------------------------------------------------------
function makeRock(x, y, size, speedMul, vx, vy) {
  const r = RADII[size];
  const n = 9 + rnd.int(5);
  const verts = [];
  for (let i = 0; i < n; i++) {
    const a = i / n * TAU;
    verts.push({ a, d: rnd.float(0.74, 1.08) });
  }
  const craters = [];
  for (let i = 0; i < (size === 0 ? 3 : size === 1 ? 2 : 1); i++) {
    const a = rnd.float(0, TAU), d = rnd.float(0.1, 0.5);
    craters.push({ x: Math.cos(a) * d, y: Math.sin(a) * d, r: rnd.float(0.12, 0.24) });
  }
  if (vx === undefined) {
    const sp = [rnd.float(34, 62), rnd.float(60, 100), rnd.float(90, 140)][size] * speedMul;
    const a = rnd.float(0, TAU);
    vx = Math.cos(a) * sp; vy = Math.sin(a) * sp;
  }
  return {
    x, y, vx: ((m) => m > MAX_ROCK_V ? MAX_ROCK_V / m : 1)(Math.hypot(vx, vy)) * vx, vy: ((m) => m > MAX_ROCK_V ? MAX_ROCK_V / m : 1)(Math.hypot(vx, vy)) * vy, size, r, verts, craters,
    ang: rnd.float(0, TAU), spin: rnd.float(-1, 1) * (size === 2 ? 2.2 : size === 1 ? 1.4 : 0.8),
    tint: rnd.float(-1, 1), flash: 0, nvx: rnd.gauss() * 9, nvy: rnd.gauss() * 9,
  };
}

function create() {
  const parts = new Particles();
  const dust = [];
  for (let layer = 0; layer < 3; layer++)
    for (let i = 0; i < 70 - layer * 12; i++)
      dust.push({ x: Math.random(), y: Math.random(), layer, tw: rnd.float(0, TAU), s: rnd.float(0.6, 1.4) });

  const G = {
    over: false, won: false,
    W: 1280, H: WH, scale: 1, cw: 1280, ch: 720,
    t: 0, endT: 0,
    ship: null, rocks: [], bullets: [], shards: [], rings: [], floaters: [],
    keys: { left: false, right: false, thrust: false, fire: false },
    cd: 0, score: 0, lives: LIVES, wave: 0, waveT: 0, bannerT: 0, bannerText: '',
    respawnT: 0.4, shake: 0, shakeX: 0, shakeY: 0, resultText: '',
    flameT: 0, hits: 0, shots: 0, deaths: 0,
  };

  function spawnShip() {
    G.ship = { x: G.W / 2, y: G.H / 2, vx: 0, vy: 0, a: -Math.PI / 2, alive: true, inv: 2, born: 0 };
    AsteroidsAI.esc = null;
  }

  function startWave(n) {
    G.wave = n; G.bannerT = 2.4;
    G.bannerText = n === WIN_WAVE ? 'FINAL WAVE' : 'WAVE ' + n;
    const cnt = waveCount(n);
    for (let i = 0; i < cnt; i++) {
      let x, y, tries = 0;
      do {
        // spawn along the edges
        if (Math.random() < G.W / (G.W + G.H)) { x = rnd.float(0, G.W); y = Math.random() < 0.5 ? rnd.float(0, 50) : rnd.float(G.H - 50, G.H); }
        else { y = rnd.float(0, G.H); x = Math.random() < 0.5 ? rnd.float(0, 50) : rnd.float(G.W - 50, G.W); }
        tries++;
      } while (G.ship && G.ship.alive && Math.hypot(x - G.ship.x, y - G.ship.y) < 230 && tries < 30);
      const rk = makeRock(x, y, 0, rockSpeed(n));
      rk.born = 0;
      G.rocks.push(rk);
    }
  }

  function explode(x, y, size, color) {
    const r = RADII[size];
    G.rings.push({ x, y, r0: r * 0.3, r1: r * 2.1, t: 0, max: 0.5 + size * -0.05 + 0.15, warm: true });
    const n = 6 + (2 - size) * 0 + Math.round(r / 5);
    for (let i = 0; i < n; i++) {
      const a = rnd.float(0, TAU), sp = rnd.float(40, 170) * (1.3 - size * 0.2);
      G.shards.push({
        x: x + Math.cos(a) * r * 0.3, y: y + Math.sin(a) * r * 0.3,
        vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, a: rnd.float(0, TAU), va: rnd.float(-8, 8),
        len: rnd.float(r * 0.25, r * 0.6), t: 0, max: rnd.float(0.6, 1.2), color: color || '#c9b8a0',
      });
    }
    parts.burst(x, y, 10 + (2 - size) * 4, { speed: 220, speedMin: 30, life: 0.7, size: 2.6, color: ['#ffd8a0', '#ffb070', '#fff4dc'], drag: 2.5 });
  }

  function killShip() {
    const s = G.ship;
    s.alive = false; G.deaths++;
    G.rings.push({ x: s.x, y: s.y, r0: 8, r1: 120, t: 0, max: 0.9, warm: false });
    G.rings.push({ x: s.x, y: s.y, r0: 4, r1: 60, t: 0, max: 0.6, warm: true });
    for (let i = 0; i < 14; i++) {
      const a = rnd.float(0, TAU), sp = rnd.float(60, 260);
      G.shards.push({ x: s.x, y: s.y, vx: Math.cos(a) * sp + s.vx * 0.5, vy: Math.sin(a) * sp + s.vy * 0.5, a: rnd.float(0, TAU), va: rnd.float(-10, 10), len: rnd.float(6, 16), t: 0, max: rnd.float(0.8, 1.5), color: '#f4ead2' });
    }
    parts.burst(s.x, s.y, 40, { speed: 340, speedMin: 40, life: 1, size: 3.2, color: ['#fff6e0', '#ffcf80', '#ff9a5a', '#9fd0ff'], drag: 2.2 });
    G.shake = Math.max(G.shake, 9);
    G.lives--;
    G.respawnT = 1.6;
    if (G.lives <= 0) endGame(false, 'Out of lives on wave ' + G.wave);
  }

  function endGame(won, text) {
    G.over = true; G.won = won; G.resultText = text; G.endT = 0;
  }

  function destroyRock(i, byBullet) {
    const rk = G.rocks[i];
    G.rocks.splice(i, 1);
    G.score += POINTS[rk.size];
    const col = rk.size === 0 ? '#bba68f' : rk.size === 1 ? '#c6b19a' : '#d0bba2';
    explode(rk.x, rk.y, rk.size, col);
    G.floaters.push({ x: rk.x, y: rk.y - rk.r, text: '+' + POINTS[rk.size], t: 0, max: 0.9 });
    G.shake = Math.max(G.shake, rk.size === 0 ? 4.5 : rk.size === 1 ? 2.8 : 1.4);
    if (rk.size < 2) {
      const base = Math.atan2(rk.vy, rk.vx) + rnd.float(-0.4, 0.4);
      const sp0 = Math.hypot(rk.vx, rk.vy);
      for (let j = 0; j < 2; j++) {
        const side = j === 0 ? 1 : -1;
        const a = base + side * rnd.float(0.5, 1.1);
        const sp = Math.max(sp0 * 1.15, [0, 62, 98][rk.size + 1] * rockSpeed(G.wave)) * rnd.float(0.95, 1.25);
        const nr = makeRock(rk.x + Math.cos(a) * rk.r * 0.3, rk.y + Math.sin(a) * rk.r * 0.3, rk.size + 1, 1, Math.cos(a) * sp, Math.sin(a) * sp);
        nr.flash = 0.18;
        G.rocks.push(nr);
      }
    }
  }

  function observe() {
    const s = G.ship;
    return {
      W: G.W, H: G.H,
      ship: { x: s.x, y: s.y, vx: s.vx, vy: s.vy, a: s.a, alive: s.alive, inv: s.inv > 0 },
      // velocity is estimated from on-screen motion, so it carries a little human-like error
      rocks: G.rocks.map(r => ({ x: r.x, y: r.y, vx: r.vx + r.nvx, vy: r.vy + r.nvy, r: r.r, size: r.size })),
      bullets: G.bullets.map(b => ({ x: b.x, y: b.y, vx: b.vx, vy: b.vy, life: BULLET_LIFE - b.age })),
    };
  }

  function wrap(o) {
    if (o.x < 0) o.x += G.W; else if (o.x >= G.W) o.x -= G.W;
    if (o.y < 0) o.y += G.H; else if (o.y >= G.H) o.y -= G.H;
  }

  function centerClear() {
    for (const r of G.rocks) {
      const dx = r.x - G.W / 2, dy = r.y - G.H / 2;
      if (Math.hypot(dx, dy) < r.r + 85) return false;
    }
    return true;
  }

  const ipg = () => [[[G.ship], ['x', 'y'], 100], [[G.ship], ['a'], 3], [G.rocks, ['x', 'y'], 100], [G.rocks, ['ang'], 3],
    [G.bullets, ['x', 'y'], 100], [G.shards, ['x', 'y'], 100], [G.shards, ['a'], 3], [[G], ['t'], 0, 't'], [G.rings, ['t'], 0, 't']];
  function step(dt) {
    IP.snap(ipg());
    G.t += dt;
    G.flameT += dt;
    // cosmetic updates always run
    parts.update(dt);
    for (let i = G.shards.length - 1; i >= 0; i--) {
      const s = G.shards[i]; s.t += dt;
      if (s.t >= s.max) { G.shards.splice(i, 1); continue; }
      const d = Math.exp(-1.2 * dt); s.vx *= d; s.vy *= d; s.x += s.vx * dt; s.y += s.vy * dt; s.a += s.va * dt;
    }
    for (let i = G.rings.length - 1; i >= 0; i--) { const r = G.rings[i]; r.t += dt; if (r.t >= r.max) G.rings.splice(i, 1); }
    for (let i = G.floaters.length - 1; i >= 0; i--) { const f = G.floaters[i]; f.t += dt; f.y -= 22 * dt; if (f.t >= f.max) G.floaters.splice(i, 1); }
    G.shake *= Math.exp(-7 * dt);
    G.shakeX = (Math.random() - 0.5) * 2 * G.shake; G.shakeY = (Math.random() - 0.5) * 2 * G.shake;
    if (G.bannerT > 0) G.bannerT -= dt;

    for (const r of G.rocks) {
      r.x += r.vx * dt; r.y += r.vy * dt; r.ang += r.spin * dt; if (r.flash > 0) r.flash -= dt;
      wrap(r);
    }
    for (let i = G.bullets.length - 1; i >= 0; i--) {
      const b = G.bullets[i];
      b.age += dt; b.x += b.vx * dt; b.y += b.vy * dt; wrap(b);
      if (b.age >= BULLET_LIFE) G.bullets.splice(i, 1);
    }

    if (G.over) {
      G.endT += dt;
      if (G.ship && G.ship.alive) { G.ship.x += G.ship.vx * dt; G.ship.y += G.ship.vy * dt; wrap(G.ship); }
      return;
    }

    if (G.t > TIME_CAP) { endGame(false, 'Out of time on wave ' + G.wave); return; }

    // waves
    if (G.wave === 0) { startWave(1); }
    else if (!G.rocks.length) {
      G.waveT += dt;
      if (G.waveT > 3.2) {
        G.waveT = 0;
        if (G.wave >= WIN_WAVE) { endGame(true, 'Cleared wave ' + WIN_WAVE + ' with ' + G.lives + (G.lives === 1 ? ' life' : ' lives') + ' left'); return; }
        startWave(G.wave + 1);
      }
    }

    // ship
    const s = G.ship;
    if (!s) { if ((G.respawnT -= dt) <= 0) spawnShip(); }
    else if (!s.alive) {
      G.respawnT -= dt;
      if (G.respawnT <= 0 && centerClear()) spawnShip();
    } else {
      // --- AI produces key state; game applies the human rules
      const keys = G.keys = AsteroidsAI.think(observe(), dt);
      s.born += dt;
      if (keys.left) s.a -= TURN * dt;
      if (keys.right) s.a += TURN * dt;
      s.a = wrapAng(s.a);
      if (keys.thrust) {
        s.vx += Math.cos(s.a) * THRUST * dt; s.vy += Math.sin(s.a) * THRUST * dt;
        if (Math.random() < 0.8) {
          const bx = s.x - Math.cos(s.a) * 11, by = s.y - Math.sin(s.a) * 11;
          parts.burst(bx, by, 1, { angle: s.a + Math.PI, spread: 0.35, speedMin: 90, speed: 190, life: 0.35, size: 2, color: ['#ffd9a0', '#ff9a5a', '#fff4dc'], drag: 3 });
        }
      }
      const dr = Math.exp(-DRAG * dt); s.vx *= dr; s.vy *= dr;
      const sp = Math.hypot(s.vx, s.vy); if (sp > MAX_V) { s.vx *= MAX_V / sp; s.vy *= MAX_V / sp; }
      s.x += s.vx * dt; s.y += s.vy * dt; wrap(s);
      if (s.inv > 0) s.inv -= dt;
      G.cd -= dt;
      if (keys.fire && G.cd <= 0 && G.bullets.length < MAX_BULLETS) {
        G.cd = FIRE_CD; G.shots++;
        const ca = Math.cos(s.a), sa = Math.sin(s.a);
        G.bullets.push({ x: s.x + ca * 14, y: s.y + sa * 14, vx: ca * BULLET_V, vy: sa * BULLET_V, age: 0 });
        parts.burst(s.x + ca * 14, s.y + sa * 14, 3, { angle: s.a, spread: 0.5, speedMin: 40, speed: 120, life: 0.18, size: 1.8, color: '#fff2c8', drag: 4 });
      }
    }

    // bullet vs rock
    for (let bi = G.bullets.length - 1; bi >= 0; bi--) {
      const b = G.bullets[bi];
      for (let i = 0; i < G.rocks.length; i++) {
        const r = G.rocks[i];
        const dx = b.x - r.x, dy = b.y - r.y;
        const ddx = Math.abs(dx) > G.W / 2 ? G.W - Math.abs(dx) : dx, ddy = Math.abs(dy) > G.H / 2 ? G.H - Math.abs(dy) : dy;
        if (ddx * ddx + ddy * ddy < (r.r + 2) * (r.r + 2)) {
          G.bullets.splice(bi, 1); G.hits++;
          destroyRock(i, true);
          break;
        }
      }
    }
    // ship vs rock
    if (G.ship && G.ship.alive && G.ship.inv <= 0) {
      const s2 = G.ship;
      for (const r of G.rocks) {
        const dx = Math.abs(s2.x - r.x), dy = Math.abs(s2.y - r.y);
        const ddx = dx > G.W / 2 ? G.W - dx : dx, ddy = dy > G.H / 2 ? G.H - dy : dy;
        const rr = r.r * 0.9 + SHIP_R * 0.8;
        if (ddx * ddx + ddy * ddy < rr * rr) { killShip(); break; }
      }
    }
  }

  // ---------------- drawing ----------------
  function wrapDraw(x, y, r, fn) {
    const xs = [0], ys = [0];
    if (x < r) xs.push(G.W); else if (x > G.W - r) xs.push(-G.W);
    if (y < r) ys.push(G.H); else if (y > G.H - r) ys.push(-G.H);
    for (const ox of xs) for (const oy of ys) fn(x + ox, y + oy);
  }

  function paintStaticBg(ctx, W, H) {
    const g = ctx.createLinearGradient(0, 0, W * 0.3, H);
    g.addColorStop(0, '#0a0e2c'); g.addColorStop(0.55, '#0b1030'); g.addColorStop(1, '#121545');
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
    // faint nebula blooms
    const nb = [[0.2, 0.25, 0.45, 'rgba(70,60,170,0.13)'], [0.7, 0.15, 0.35, 'rgba(40,110,170,0.09)']];
    for (const [nx, ny, nr, c] of nb) {
      const rg = ctx.createRadialGradient(W * nx, H * ny, 0, W * nx, H * ny, Math.max(W, H) * nr);
      rg.addColorStop(0, c); rg.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = rg; ctx.fillRect(0, 0, W, H);
    }
    // planet limb, bottom-right
    const R = Math.min(W, H) * 0.72;
    const px = W * 1.02 + Math.sin(0 * 0.05) * 2, py = H * 1.12;
    const atm = ctx.createRadialGradient(px, py, R * 0.9, px, py, R * 1.35);
    atm.addColorStop(0, 'rgba(255,170,110,0.0)');
    atm.addColorStop(0.12, 'rgba(255,175,120,0.30)');
    atm.addColorStop(0.3, 'rgba(110,150,255,0.14)');
    atm.addColorStop(1, 'rgba(40,60,160,0)');
    ctx.fillStyle = atm; ctx.fillRect(0, 0, W, H);
    const body = ctx.createRadialGradient(px - R * 0.05, py - R * 0.08, R * 0.1, px, py, R);
    body.addColorStop(0, '#080c26'); body.addColorStop(0.82, '#0b1235'); body.addColorStop(0.94, '#1b3377'); body.addColorStop(0.985, '#6fa9ff'); body.addColorStop(1, '#bfe0ff');
    ctx.fillStyle = body; ctx.beginPath(); ctx.arc(px, py, R, 0, TAU); ctx.fill();
    // thin warm rim
    ctx.strokeStyle = 'rgba(255,200,150,0.35)'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(px, py, R + 1, Math.PI * 1.05, Math.PI * 1.6); ctx.stroke();
    // cloud bands
    ctx.save(); ctx.beginPath(); ctx.arc(px, py, R * 0.99, 0, TAU); ctx.clip();
    for (let i = 0; i < 5; i++) {
      ctx.strokeStyle = `rgba(120,160,255,${0.035 + i * 0.005})`; ctx.lineWidth = 10 + i * 6;
      ctx.beginPath(); ctx.arc(px + 30 * i, py + 40 * i, R * (0.93 - i * 0.07) + Math.sin(0 * 0.1 + i) * 3, Math.PI * 1.05, Math.PI * 1.55); ctx.stroke();
    }
    ctx.restore();
    // vignette
    const vg = ctx.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.45, W / 2, H / 2, Math.max(W, H) * 0.8);
    vg.addColorStop(0, 'rgba(0,0,10,0)'); vg.addColorStop(1, 'rgba(0,0,12,0.45)');
    ctx.fillStyle = vg; ctx.fillRect(0, 0, W, H);
  }

  // the static backdrop (gradient, nebulae, planet, vignette) is painted once onto an offscreen canvas
  let bgCache = null;
  function drawBackground(ctx) {
    const W = G.cw, H = G.ch;
    const sc = Math.min(2, (ctx.getTransform ? ctx.getTransform().a : 1) || 1);
    if (!bgCache || bgCache.W !== W || bgCache.H !== H || bgCache.sc !== sc) {
      const c = document.createElement('canvas'); c.width = Math.ceil(W * sc); c.height = Math.ceil(H * sc);
      const x = c.getContext('2d'); x.scale(sc, sc); paintStaticBg(x, W, H);
      bgCache = { c, W, H, sc };
    }
    ctx.drawImage(bgCache.c, 0, 0, W, H);
    // star dust (3 parallax layers)
    const sh = G.ship && G.ship.alive ? G.ship : { vx: 0, vy: 0 };
    for (const d of dust) {
      const sp = 3 + d.layer * 5;
      const par = 0.015 * (d.layer + 1);
      let x = ((d.x * W - G.t * sp - (G.ship ? G.ship.x * par * G.scale : 0)) % W + W) % W;
      let y = ((d.y * H - G.t * sp * 0.25 - (G.ship ? G.ship.y * par * G.scale : 0)) % H + H) % H;
      const tw = 0.55 + 0.45 * Math.sin(G.t * (0.8 + d.layer * 0.4) + d.tw);
      const sz = (0.8 + d.layer * 0.5) * d.s * Math.max(1, G.scale * 0.9);
      ctx.fillStyle = `rgba(${d.layer === 0 ? '170,190,255' : d.layer === 1 ? '220,225,255' : '255,240,225'},${(0.25 + d.layer * 0.18) * tw})`;
      ctx.fillRect(x, y, sz, sz);
    }
  }

  function drawRock(ctx, r) {
    wrapDraw(r.x, r.y, r.r * 1.15, (x, y) => {
      ctx.save(); ctx.translate(x, y); ctx.rotate(r.ang);
      const pts = r.verts.map(v => [Math.cos(v.a) * v.d * r.r, Math.sin(v.a) * v.d * r.r]);
      ctx.beginPath(); ctx.moveTo(pts[0][0], pts[0][1]);
      for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
      ctx.closePath();
      const lit = r.flash > 0 ? r.flash / 0.18 : 0;
      ctx.fillStyle = lit > 0 ? `rgb(${Math.round(36 + lit * 170)},${Math.round(34 + lit * 140)},${Math.round(52 + lit * 90)})`
        : `rgb(${50 + r.tint * 6},${48 + r.tint * 4},${74 + r.tint * 7})`;
      ctx.fill();
      // craters
      ctx.lineWidth = 1.2;
      ctx.strokeStyle = 'rgba(8,10,28,0.55)';
      for (const c of r.craters) { ctx.beginPath(); ctx.arc(c.x * r.r, c.y * r.r, c.r * r.r, 0, TAU); ctx.stroke(); }
      ctx.restore();
      // sunlit rim: edges whose outward normal faces the light (in screen space)
      ctx.save(); ctx.translate(x, y);
      const ca = Math.cos(r.ang), sa = Math.sin(r.ang);
      const sp = pts.map(p => [p[0] * ca - p[1] * sa, p[0] * sa + p[1] * ca]);
      ctx.lineCap = 'round';
      ctx.strokeStyle = 'rgba(130,140,200,0.55)'; ctx.lineWidth = 1.2;
      ctx.beginPath(); ctx.moveTo(sp[0][0], sp[0][1]);
      for (let i = 1; i < sp.length; i++) ctx.lineTo(sp[i][0], sp[i][1]);
      ctx.closePath(); ctx.stroke();
      for (let i = 0; i < sp.length; i++) {
        const a = sp[i], b = sp[(i + 1) % sp.length];
        const mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2, ml = Math.hypot(mx, my) || 1;
        const dot = (mx * LIGHT.x + my * LIGHT.y) / ml;
        if (dot < 0.12) continue;
        ctx.strokeStyle = `rgba(255,${Math.round(190 + dot * 40)},${Math.round(130 + dot * 60)},${Math.min(1, dot * 1.25)})`;
        ctx.lineWidth = 1.6 + dot * 1.6;
        ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke();
      }
      ctx.restore();
    });
  }

  function drawShip(ctx) {
    const s = G.ship;
    if (!s || !s.alive) return;
    let alpha = 1;
    if (s.inv > 0) alpha = 0.55 + 0.45 * Math.sin(G.t * 28) * Math.sin(G.t * 28);
    const appear = ease.outBack(clamp(s.born / 0.35, 0, 1));
    wrapDraw(s.x, s.y, 30, (x, y) => {
      ctx.save(); ctx.translate(x, y); ctx.rotate(s.a); ctx.scale(appear, appear); ctx.globalAlpha = alpha;
      // invulnerability bubble
      if (s.inv > 0) {
        ctx.strokeStyle = `rgba(160,210,255,${0.25 + 0.2 * Math.sin(G.t * 9)})`; ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.arc(0, 0, 22, 0, TAU); ctx.stroke();
      }
      // flame
      if (G.keys.thrust) {
        const fl = 11 + Math.random() * 9;
        ctx.globalCompositeOperation = 'lighter';
        const fg = ctx.createLinearGradient(-8, 0, -8 - fl, 0);
        fg.addColorStop(0, 'rgba(255,240,200,0.95)'); fg.addColorStop(0.45, 'rgba(255,150,70,0.7)'); fg.addColorStop(1, 'rgba(255,80,40,0)');
        ctx.fillStyle = fg;
        ctx.beginPath(); ctx.moveTo(-6, -4.5); ctx.lineTo(-8 - fl, 0); ctx.lineTo(-6, 4.5); ctx.closePath(); ctx.fill();
        const gg = ctx.createRadialGradient(-10, 0, 0, -10, 0, 22);
        gg.addColorStop(0, 'rgba(255,170,90,0.35)'); gg.addColorStop(1, 'rgba(255,120,40,0)');
        ctx.fillStyle = gg; ctx.fillRect(-34, -24, 48, 48);
        ctx.globalCompositeOperation = 'source-over';
      }
      // hull
      const hg = ctx.createLinearGradient(-10, -10, 14, 10);
      hg.addColorStop(0, '#ffe9b0'); hg.addColorStop(0.5, '#ffffff'); hg.addColorStop(1, '#e8c377');
      ctx.fillStyle = hg;
      ctx.beginPath(); ctx.moveTo(15, 0); ctx.lineTo(-10, 9.5); ctx.lineTo(-5, 0); ctx.lineTo(-10, -9.5); ctx.closePath(); ctx.fill();
      ctx.strokeStyle = 'rgba(255,214,140,0.9)'; ctx.lineWidth = 1.1; ctx.lineJoin = 'round'; ctx.stroke();
      // cockpit + spine
      ctx.fillStyle = '#4a79c9';
      ctx.beginPath(); ctx.ellipse(3, 0, 3.6, 1.8, 0, 0, TAU); ctx.fill();
      ctx.strokeStyle = 'rgba(190,140,70,0.6)'; ctx.lineWidth = 0.9;
      ctx.beginPath(); ctx.moveTo(-5, 0); ctx.lineTo(-9, 6.5); ctx.moveTo(-5, 0); ctx.lineTo(-9, -6.5); ctx.stroke();
      ctx.restore();
    });
    // soft glow
    ctx.save(); ctx.globalCompositeOperation = 'lighter';
    const gl = ctx.createRadialGradient(s.x, s.y, 0, s.x, s.y, 36);
    gl.addColorStop(0, 'rgba(255,225,160,0.16)'); gl.addColorStop(1, 'rgba(255,225,160,0)');
    ctx.fillStyle = gl; ctx.fillRect(s.x - 36, s.y - 36, 72, 72);
    ctx.restore();
  }

  function drawBullets(ctx) {
    ctx.save(); ctx.lineCap = 'round'; ctx.globalCompositeOperation = 'lighter';
    for (const b of G.bullets) {
      const fade = clamp((BULLET_LIFE - b.age) / 0.25, 0, 1);
      const len = 0.022;
      wrapDraw(b.x, b.y, 20, (x, y) => {
        ctx.strokeStyle = `rgba(255,190,90,${0.22 * fade})`; ctx.lineWidth = 8;
        ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x - b.vx * len, y - b.vy * len); ctx.stroke();
        ctx.strokeStyle = `rgba(255,248,224,${fade})`; ctx.lineWidth = 2.6;
        ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x - b.vx * len, y - b.vy * len); ctx.stroke();
      });
    }
    ctx.restore();
  }

  function draw(ctx, W, H) {
    const a = IP.alpha(), st = IP.push(ipg(), a);
    try { drawImpl(ctx, W, H); } finally { IP.pop(st); }
  }
  function drawImpl(ctx, W, H) {
    G.cw = W; G.ch = H;
    drawBackground(ctx);
    ctx.save();
    ctx.translate(G.shakeX * G.scale, G.shakeY * G.scale);
    ctx.scale(G.scale, G.scale);
    // rings
    ctx.save(); ctx.globalCompositeOperation = 'lighter';
    for (const r of G.rings) {
      const k = r.t / r.max, e = ease.outCubic(k);
      ctx.strokeStyle = r.warm ? `rgba(255,190,110,${(1 - k) * 0.8})` : `rgba(170,210,255,${(1 - k) * 0.8})`;
      ctx.lineWidth = 1 + 5 * (1 - k);
      ctx.beginPath(); ctx.arc(r.x, r.y, lerp(r.r0, r.r1, e), 0, TAU); ctx.stroke();
      const rg = ctx.createRadialGradient(r.x, r.y, 0, r.x, r.y, lerp(r.r0, r.r1, e));
      rg.addColorStop(0, `rgba(255,210,150,${(1 - k) * (1 - k) * 0.25})`); rg.addColorStop(1, 'rgba(255,210,150,0)');
      ctx.fillStyle = rg; ctx.beginPath(); ctx.arc(r.x, r.y, lerp(r.r0, r.r1, e), 0, TAU); ctx.fill();
    }
    ctx.restore();
    for (const r of G.rocks) drawRock(ctx, r);
    drawBullets(ctx);
    // shards
    ctx.lineCap = 'round';
    for (const s of G.shards) {
      const k = s.t / s.max;
      ctx.globalAlpha = 1 - k * k;
      ctx.strokeStyle = s.color; ctx.lineWidth = 2;
      const dx = Math.cos(s.a) * s.len / 2, dy = Math.sin(s.a) * s.len / 2;
      wrapDraw(s.x, s.y, 10, (x, y) => { ctx.beginPath(); ctx.moveTo(x - dx, y - dy); ctx.lineTo(x + dx, y + dy); ctx.stroke(); });
    }
    ctx.globalAlpha = 1;
    drawShip(ctx);
    parts.draw(ctx, 1);
    // floaters
    ctx.textAlign = 'center'; ctx.font = '600 15px "IBM Plex Mono", monospace';
    for (const f of G.floaters) {
      const k = f.t / f.max;
      ctx.fillStyle = `rgba(255,226,170,${1 - k * k})`;
      ctx.fillText(f.text, f.x, f.y);
    }
    ctx.restore();

    // wave banner
    if (G.bannerT > 0 && !G.over) {
      const total = 2.4, k = 1 - G.bannerT / total;
      const a = k < 0.15 ? k / 0.15 : k > 0.7 ? (1 - k) / 0.3 : 1;
      ctx.save(); ctx.globalAlpha = clamp(a, 0, 1); ctx.textAlign = 'center';
      ctx.fillStyle = '#f3e4c4';
      ctx.font = `800 ${Math.round(64 * G.scale)}px "Big Shoulders Display", Impact, sans-serif`;
      ctx.fillText(G.bannerText, W / 2, H * 0.3 + (1 - ease.outCubic(clamp(k * 4, 0, 1))) * 14);
      ctx.fillStyle = 'rgba(255,200,130,0.8)'; ctx.fillRect(W / 2 - 40 * G.scale, H * 0.3 + 14 * G.scale, 80 * G.scale, 2 * G.scale);
      ctx.restore();
    }
    // lives (top-left) and wave pips
    ctx.save(); ctx.translate(26 * G.scale, 30 * G.scale); ctx.scale(G.scale, G.scale);
    for (let i = 0; i < LIVES; i++) {
      ctx.save(); ctx.translate(i * 26, 0); ctx.rotate(-Math.PI / 2); ctx.scale(0.8, 0.8);
      ctx.globalAlpha = i < G.lives ? 0.95 : 0.18;
      ctx.fillStyle = '#f6e3b4';
      ctx.beginPath(); ctx.moveTo(15, 0); ctx.lineTo(-10, 9.5); ctx.lineTo(-5, 0); ctx.lineTo(-10, -9.5); ctx.closePath(); ctx.fill();
      ctx.restore();
    }
    for (let i = 0; i < WIN_WAVE; i++) {
      ctx.fillStyle = i < G.wave - (G.rocks.length ? 1 : 0) ? 'rgba(255,200,130,0.95)' : i === G.wave - 1 ? 'rgba(255,200,130,0.55)' : 'rgba(255,255,255,0.14)';
      ctx.beginPath(); ctx.arc(i * 14 + 3, 26, 3.2, 0, TAU); ctx.fill();
    }
    ctx.restore();

    // end overlay
    if (G.over) {
      const k = clamp(G.endT / 1.2, 0, 1);
      if (G.won) {
        ctx.save(); ctx.globalAlpha = k; ctx.textAlign = 'center';
        ctx.fillStyle = '#ffe2a8';
        ctx.font = `800 ${Math.round(70 * G.scale)}px "Big Shoulders Display", Impact, sans-serif`;
        ctx.fillText('SECTOR CLEAR', W / 2, H * 0.3);
        ctx.restore();
      } else {
        ctx.fillStyle = `rgba(5,5,20,${0.35 * k})`; ctx.fillRect(0, 0, W, H);
      }
    }
  }

  function resize(W, H) {
    G.cw = W; G.ch = H;
    G.scale = H / WH;
    const nw = WH * W / H;
    if (G.W !== nw) {
      const f = nw / G.W;
      const fix = o => { o.x *= f; };
      G.rocks.forEach(fix); G.bullets.forEach(fix); G.shards.forEach(fix);
      if (G.ship) G.ship.x *= f;
      G.W = nw;
    }
  }

  return {
    style: AsteroidsAI.style,
    get over() { return G.over; },
    get won() { return G.won; },
    resize, step, draw,
    hud() {
      return { score: String(G.score).replace(/\B(?=(\d{3})+(?!\d))/g, ' '), detail: `Wave ${Math.max(1, G.wave)}/${WIN_WAVE} · ${Math.max(0, G.lives)} ${G.lives === 1 ? 'life' : 'lives'}` };
    },
    result() { return G.resultText + ' · ' + G.hits + '/' + G.shots + ' shots hit (' + AsteroidsAI.style + ')'; },
    _G: G,
  };
}

Arcade.register({
  id: 'asteroids', name: 'Orbital Drift', genre: 'Asteroids',
  aiNote: "Sees rocks, bullets and its own drift on screen, guesses rock motion with small errors, and flies with the same four keys, turn rate and four-bullet limit as a human.",
  blurb: 'A lone ship clears six waves of tumbling rock around a glowing planet.',
  bg: '#0b1030', accent: '#ffc77a',
  create() { AsteroidsAI.reset(); return create(); },
});
})();
