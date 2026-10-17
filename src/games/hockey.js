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
// Ice Hockey Duel — air hockey seen from above. Goals on the left/right ends so
// the table fills a wide screen. Left (amber) = Autopilot AI, right (cyan) =
// the house bot. First to 7 goals.
// Logical field 1000 x 560 (+ frame), scaled to fit.
// ---------------------------------------------------------------------------
const FW = 1000, FH = 560, CY = FH / 2;
const GH = 165;                  // goal half-width
const PR = 22, MR = 40, POST = 7; // puck / mallet / goal post radii
const FRX = 34, FRY = 46;        // frame thickness (left/right, top/bottom)
const TW = FW + FRX * 2, TH = FH + FRY * 2;
const MAXV = 1150, ACC = 8500;   // mallet limits (identical for both players)
const PUCKMAX = 1500, FRIC = 0.22, WALLE = 0.92, MALE = 0.72;
const SUB = 5, WIN = 7, TIME_CAP = 360;
const AMBER = '#ffb347', CYAN = '#4fd8ff';
const TWISTS = [
  { key: 'turbo', name: 'Turbo house', desc: 'The house mallet gets bursts of extra speed.' },
  { key: 'surge', name: 'Puck surge', desc: 'Now and then the house bot smashes the puck with a surge of speed.' },
];

const TAUU = Math.PI * 2;
const sgn = v => (v < 0 ? -1 : 1);

// time for a mallet starting at rest to cover distance L with the accel/speed limits
function travelTime(L) {
  const ta = MAXV / ACC, sa = 0.5 * ACC * ta * ta;
  return L < sa ? Math.sqrt(2 * L / ACC) : ta + (L - sa) / MAXV;
}

// ---------------------------------------------------------------------------
// BRAIN — used by both players (own frame: own goal at x=0, opponent goal at
// x=FW; the right-hand player gets a mirrored view). The Autopilot AI and the
// house bot differ only in `cfg` (house bot: slower reaction, noisy tracking,
// no wall-bounce prediction, only straight shots).
//
// What it can see (what a human sees): the puck's position on screen (delayed
// by its reaction latency; velocity is estimated from the last two observed
// positions), the opponent mallet position, and its own mallet position and
// velocity (the player's own hand). It never reads hidden state. It only
// outputs a target position for its mallet; the game moves the mallet with the
// same max speed / acceleration for both players and the centre-line limit.
// ---------------------------------------------------------------------------
const N = 80;
class Brain {
  constructor(cfg) {
    this.cfg = cfg; this.hist = []; this.tx = 0; this.ty = CY; this.mode = 'home';
    this.TX = new Float32Array(N); this.TY = new Float32Array(N);
    this.striking = 0; this.shot = null; this.jitter = 0; this.noiseY = 0; this.noiseT = 0; this.lastAtk = false;
    this.reg = { xmin: MR, xmax: FW / 2 - MR, ymin: MR, ymax: FH - MR };
  }
  // trajectory of the puck for N ticks (friction, wall bounces if `bounce`)
  predict(x, y, vx, vy, bounce) {
    const f = Math.exp(-FRIC / 60);
    for (let i = 0; i < N; i++) {
      this.TX[i] = x; this.TY[i] = y;
      vx *= f; vy *= f; x += vx / 60; y += vy / 60;
      if (bounce) {
        if (y < PR) { y = PR + (PR - y); vy = -vy * WALLE; } else if (y > FH - PR) { y = (FH - PR) - (y - (FH - PR)); vy = -vy * WALLE; }
        if (x < PR && Math.abs(y - CY) > GH) { x = PR + (PR - x); vx = -vx * WALLE; }
        else if (x > FW - PR && Math.abs(y - CY) > GH) { x = FW - PR - (x - (FW - PR)); vx = -vx * WALLE; }
      } else y = Math.max(PR, Math.min(FH - PR, y));
    }
  }
  inReg(x, y, tol) {
    const r = this.reg;
    return x >= r.xmin - tol && x <= r.xmax + tol && y >= r.ymin - tol && y <= r.ymax + tol;
  }
  clampT(x, y) {
    const r = this.reg;
    return [Math.max(r.xmin, Math.min(r.xmax, x)), Math.max(r.ymin, Math.min(r.ymax, y))];
  }
  // simulate a straight/banked shot from (cx,cy) along unit d; where does it arrive at the far end?
  simShot(cx, cy, dx, dy) {
    let x = cx, y = cy, sp = 1350, t = 0, b = 0;
    if (dx <= 0.02) return null;
    for (let k = 0; k < 5; k++) {
      const tx = (FW - PR - x) / (dx * sp);
      const ty = dy > 0.0001 ? (FH - PR - y) / (dy * sp) : dy < -0.0001 ? (PR - y) / (dy * sp) : Infinity;
      if (tx <= ty) { y += dy * sp * tx; t += tx; return { y, t, b }; }
      x += dx * sp * ty; y = dy > 0 ? FH - PR : PR; t += ty; dy = -dy; sp *= 0.93; b++;
    }
    return null;
  }
  // choose the strike direction for contact point C
  pickShot(cx, cy, oppY, wind) {
    const c = this.cfg; let best = null, bestS = -1e9;
    const aim = Math.atan2(CY + this.jitter - cy, FW - cx);
    for (let a = -110; a <= 110; a += 5) {
      const th = a * Math.PI / 180, dx = Math.cos(th), dy = Math.sin(th);
      const bx = cx - dx * (MR + PR + wind), by = cy - dy * (MR + PR + wind);
      if (!this.inReg(bx, by, 8)) continue;
      const kx = cx - dx * (MR + PR), ky = cy - dy * (MR + PR);
      if (!this.inReg(kx, ky, 8)) continue;
      let s;
      if (c.bank) {
        const r = this.simShot(cx, cy, dx, dy);
        if (!r) s = -2000 - Math.abs(a);
        else {
          const goal = Math.abs(r.y - CY) <= GH - PR * 0.6 - 4;
          const cover = 0.6 * MAXV * Math.max(0, r.t - 0.14);
          const dist = Math.abs(r.y - oppY);
          s = goal ? 200 + dist - 0.45 * cover + (r.b === 1 ? (c.bankB ?? 60) : r.b === 0 ? (c.directB ?? 0) : -20 * (r.b - 1)) - r.t * (c.speedW ?? 40)
                   : -400 + dist * 0.15 - r.b * 30;
          s -= Math.abs(a) * 0.15;
        }
      } else s = -Math.abs(th - aim);
      if (!c.noRand) s += Math.random() * 0.5;
      if (s > bestS) { bestS = s; best = { dx, dy, a }; }
    }
    return best;
  }
  think(o) {
    const c = this.cfg;
    this.hist.push(o); if (this.hist.length > c.delay + 3) this.hist.shift();
    const L = this.hist.length;
    const cur = this.hist[Math.max(0, L - 1 - c.delay)], prv = this.hist[Math.max(0, L - 2 - c.delay)];
    const px = cur.px, py = cur.py, vx = (cur.px - prv.px) * 60, vy = (cur.py - prv.py) * 60;
    const spd = Math.hypot(vx, vy);
    const M = o.me;
    this.predict(px, py, vx, vy, c.bounce);
    if (--this.noiseT <= 0) { this.noiseT = 12; this.noiseY = c.trackNoise * (Math.random() * 2 - 1) * 1.7; }
    // where does the puck cross the defence line?
    let yc = null, tc = 0;
    const line = c.defX + 55;
    if (vx < -40) for (let i = 0; i < N; i++) if (this.TX[i] <= line) { yc = this.TY[i]; tc = i / 60; break; }
    const threat = yc != null && Math.abs(yc - CY) < GH + MR + 40;
    const fast = vx < -c.defendSpeed;
    let tx = c.homeX, ty = CY, mode = 'home';

    if (fast && (threat || px > FW / 2)) {
      mode = 'defend';
      tx = c.defX; ty = yc != null ? yc + this.noiseY : py;
      if (yc == null) ty = CY + (py - CY) * 0.7;
      // narrow, goal-hugging stance when the shot is clearly wide
      if (!threat) { tx = c.homeX; ty = CY + (ty - CY) * 0.6; }
    } else if (px < FW / 2 + 12 && !(vx > 380) && !(c.patient && spd > c.patient) && this.attack(cur, vx, vy, spd, M, o.oy)) {
      mode = 'attack'; tx = this.atx; ty = this.aty;
    } else {
      // home: stand between puck and the goal
      const k = c.homeTrack;
      ty = CY + (py - CY) * k;
      if (yc != null) ty = ty * 0.4 + (yc + this.noiseY) * 0.6;
      tx = c.homeX + (px > FW / 2 ? 55 : 0);
      this.striking = 0; this.shot = null;
    }
    if (mode !== 'attack') { this.striking = 0; this.shot = null; }
    if (mode === 'attack' && !this.lastAtk) this.jitter = (Math.random() * 2 - 1) * c.aimNoise * 120;
    this.lastAtk = mode === 'attack'; this.mode = mode;
    const t2 = this.clampT(tx, ty); this.tx = t2[0]; this.ty = t2[1];
  }
  // returns true and sets atx/aty when there is a reachable attacking plan
  attack(cur, vx, vy, spd, M, oppY) {
    const px = cur.px, py = cur.py, TX = this.TX, TY = this.TY;
    const i0 = spd < 30 ? 0 : Math.min(10, N - 1);
    let shot = this.shot;
    if (!this.striking || !shot) {
      let sh = null, wind = 125;
      sh = this.pickShot(TX[i0], TY[i0], oppY, wind);
      if (!sh) { wind = 45; sh = this.pickShot(TX[i0], TY[i0], oppY, wind); }
      if (!sh) return false;
      shot = this.shot = { dx: sh.dx, dy: sh.dy, wind };
    }
    const { dx, dy, wind } = shot;
    // earliest contact the mallet can make in time
    let ci = -1;
    for (let i = 1; i < 60; i++) {
      const cx = TX[i], cy = TY[i];
      if (cx > FW / 2 + 12) continue;
      const kx = cx - dx * (MR + PR), ky = cy - dy * (MR + PR);
      if (!this.inReg(kx, ky, 12)) continue;
      if (travelTime(Math.hypot(M.x - kx, M.y - ky)) + 0.04 <= i / 60) { ci = i; break; }
    }
    if (ci < 0) return false;
    const cx = TX[ci], cy = TY[ci];
    const rx = M.x - cx, ry = M.y - cy;
    const a = rx * dx + ry * dy, perp = Math.abs(rx * dy - ry * dx);
    const mv = Math.hypot(M.vx, M.vy);
    const dirOK = mv < 320 || (M.vx * dx + M.vy * dy) / mv > 0.8;
    const behind = a < -(MR + PR) + 12 && a > -(MR + PR + wind + 70);
    const kx = cx - dx * (MR + PR), ky = cy - dy * (MR + PR);
    const tT = travelTime(Math.hypot(M.x - kx, M.y - ky));
    if (this.striking > 0 || (behind && perp < 22 && dirOK && ci / 60 <= tT + 0.07)) {
      if (this.striking <= 0) this.striking = 22;
      else this.striking--;
      this.atx = cx + dx * 85; this.aty = cy + dy * 85;
      if (a > 10 || this.striking <= 0) { this.striking = 0; this.shot = null; }
      return true;
    }
    // windup point behind the puck, detouring around the puck if the path crosses it
    let bx = cx - dx * (MR + PR + wind), by = cy - dy * (MR + PR + wind);
    const sx = bx - M.x, sy = by - M.y, sl = Math.hypot(sx, sy);
    if (sl > 1 && spd < 250) {
      const t = Math.max(0, Math.min(1, ((px - M.x) * sx + (py - M.y) * sy) / (sl * sl)));
      const qx = M.x + sx * t, qy = M.y + sy * t;
      if (Math.hypot(px - qx, py - qy) < MR + PR + 16) {
        const side = (sx * (py - M.y) - sy * (px - M.x)) > 0 ? -1 : 1;
        const nx = -sy / sl * side, ny = sx / sl * side;
        bx = px + nx * (MR + PR + 55); by = py + ny * (MR + PR + 55);
      }
    }
    this.atx = bx; this.aty = by;
    return true;
  }
}

const AI_CFG = { delay: 4, bounce: true, bank: true, trackNoise: 0, aimNoise: 0, defX: 108, homeX: 125, homeTrack: 0.6, defendSpeed: 480 };
// AI styles (cfg overrides): Banker favours bank shots, Striker favours direct fast shots,
// Wall sits deeper, tracks tightly and only counter-attacks once the puck has slowed.
const AI_STYLES = {
  'Banker': { bankB: 150, directB: -30, speedW: 25 },
  'Striker': { bankB: 35, directB: 25, speedW: 50 },
  'Wall': { defX: 98, homeX: 112, homeTrack: 0.72, patient: 650, defendSpeed: 380 },
};
// Super AI: zero reaction delay, no noise, no random tie-breaking, best bank/direct mix
const SUPER_CFG = { delay: 0, bankB: 90, directB: 0, speedW: 40, noRand: true, defX: 104, homeX: 120, homeTrack: 0.7, defendSpeed: 420 };
const HOUSE_CFG = { delay: 8, bounce: false, bank: false, trackNoise: 12, aimNoise: 0.25, defX: 100, homeX: 112, homeTrack: 0.8, defendSpeed: 380 };

// ---------------------------------------------------------------------------
// Static helpers
// ---------------------------------------------------------------------------
const glowCache = {};
function glowSprite(color) {
  if (glowCache[color]) return glowCache[color];
  const c = document.createElement('canvas'); c.width = c.height = 128;
  const g = c.getContext('2d'), r = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  r.addColorStop(0, color); r.addColorStop(0.35, color + '66'); r.addColorStop(1, color + '00');
  g.fillStyle = r; g.fillRect(0, 0, 128, 128);
  return (glowCache[color] = c);
}
function mulberry(a) { return () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
function fmtTime(t) { const s = Math.floor(t); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); }

class Hockey {
  constructor(opts = {}) {
    this.W = 1600; this.H = 900; this.s = 1; this.ox = 0; this.oy = 0;
    this.over = false; this.won = false; this.t = 0; this.overT = 0;
    this.score = [0, 0];
    this.twistDef = opts.twist ? (TWISTS.find(t => t.key === opts.twist) || TWISTS[Math.floor(Math.random() * TWISTS.length)]) : null;
    this.twist = this.twistDef ? { key: this.twistDef.key, name: this.twistDef.name, desc: this.twistDef.desc } : null;
    this.TW = this.twistDef ? this.twistDef.key : '';
    this.surgeCd = 0; this.surgeGlow = 0; this.boostT = 0; this.boostIn = 8; this.slickT = 0; this.slickIn = 14; this.alertT = 0; this.alertText = '';
    this.mal = [this.mkMallet(0), this.mkMallet(1)];
    const names = Object.keys(AI_STYLES);
    if (opts.superAI) {
      this.superAI = true; this.style = 'Super AI';
      this.brain = [new Brain(Object.assign({}, AI_CFG, SUPER_CFG)), new Brain(HOUSE_CFG)];
    } else {
      this.style = names[Math.floor(Math.random() * names.length)];
      this.brain = [new Brain(Object.assign({}, AI_CFG, AI_STYLES[this.style])), new Brain(HOUSE_CFG)];
    }
    this.puck = { x: FW / 2, y: CY, vx: 0, vy: 0, live: false };
    this.parts = new Particles();
    this.trail = []; this.ripples = []; this.shake = 0; this.goalT = 0; this.goalSide = -1;
    this.serveT = 1.4; this.serveSide = Math.random() < 0.5 ? 0 : 1; this.serveX = 0; this.serveY = CY;
    this.flash = [0, 0]; this.popT = [9, 9]; this.hits = 0; this.stillT = 0; this.rally = 0;
    this.lastHitBy = -1; this.rec = 0;
    this.motes = []; const rr = mulberry(7);
    for (let i = 0; i < 46; i++) this.motes.push({ x: rr(), y: rr(), z: 0.3 + rr() * 0.7, ph: rr() * 6.28 });
    this.scratches = [];
    const r2 = mulberry(1234);
    for (let i = 0; i < 70; i++) {
      const x = r2() * FW, y = r2() * FH, a = -0.5 + r2() * 0.9 + (r2() < 0.2 ? 1.6 : 0), l = 50 + r2() * 220;
      this.scratches.push([x, y, x + Math.cos(a) * l, y + Math.sin(a) * l + (r2() - 0.5) * 20, 0.03 + r2() * 0.07]);
    }
    this.static = null; this.staticKey = '';
    this.placeServe(true);
    for (const m of this.mal) { m.x = m.side === 0 ? 125 : FW - 125; m.y = CY; m.tx = m.x; m.ty = m.y; }
  }
  mkMallet(side) { return { side, x: 0, y: CY, vx: 0, vy: 0, tx: 0, ty: CY, flash: 0 }; }
  placeServe() {
    const sd = this.serveSide;
    this.serveX = sd === 0 ? FW * 0.3 : FW * 0.7;
    this.serveY = CY + (Math.random() * 2 - 1) * 90;
    const p = this.puck; p.x = this.serveX; p.y = this.serveY; p.vx = p.vy = 0; p.live = false;
    this.trail.length = 0;
  }
  resize(W, H) {
    this.W = W; this.H = H;
    this.s = Math.min(W * 0.88 / TW, H * 0.88 / TH);
    this.ox = (W - TW * this.s) / 2; this.oy = (H - TH * this.s) / 2 - H * 0.005;
  }

  // ---- observation (own frame) ----
  observe(i) {
    const m = this.mal[i], o = this.mal[1 - i], p = this.puck;
    const f = i === 0 ? 1 : -1, ox = i === 0 ? 0 : FW;
    return {
      px: i === 0 ? p.x : FW - p.x, py: p.y, oy: o.y,
      me: { x: i === 0 ? m.x : FW - m.x, y: m.y, vx: m.vx * f, vy: m.vy },
    };
  }

  // ---- physics ----
  moveMallet(m, dt) {
    const dx = m.tx - m.x, dy = m.ty - m.y, d = Math.hypot(dx, dy);
    const bk = m.side === 1 && this.boostT > 0 ? 2.2 : 1, MAXV_ = MAXV * bk, ACC_ = ACC * bk;
    let dvx = 0, dvy = 0;
    if (d > 0.4) {
      const sp = Math.min(MAXV_, Math.sqrt(2 * ACC_ * 0.65 * d), d * 26);
      dvx = dx / d * sp; dvy = dy / d * sp;
    }
    let ax = dvx - m.vx, ay = dvy - m.vy; const al = Math.hypot(ax, ay), lim = ACC_ * dt;
    if (al > lim) { ax *= lim / al; ay *= lim / al; }
    m.vx += ax; m.vy += ay;
    const v = Math.hypot(m.vx, m.vy); if (v > MAXV_) { m.vx *= MAXV_ / v; m.vy *= MAXV_ / v; }
  }
  _ipg() { return [[[this.puck, ...this.mal], ['x', 'y'], 150]]; }
  step(dt) {
    IP.snap(this._ipg());
    this.t += dt;
    this.parts.update(dt);
    for (const r of this.ripples) r.t += dt;
    this.ripples = this.ripples.filter(r => r.t < r.max);
    this.shake *= Math.exp(-6 * dt);
    this.flash[0] = Math.max(0, this.flash[0] - dt); this.flash[1] = Math.max(0, this.flash[1] - dt);
    for (const m of this.mal) m.flash = Math.max(0, m.flash - dt * 5);
    this.popT[0] += dt; this.popT[1] += dt;
    const p = this.puck;

    if (this.over) {
      this.overT += dt;
      for (const m of this.mal) { this.moveMallet(m, dt); this.integrateMallet(m, dt); }
      this.sinkPuck(dt);
      if (this.won && Math.random() < 0.25) this.confetti(AMBER);
      else if (!this.won && Math.random() < 0.25) this.confetti(CYAN);
      return;
    }
    // brains
    for (let i = 0; i < 2; i++) {
      const b = this.brain[i], m = this.mal[i];
      b.think(this.observe(i));
      if (this.serveT > 0.3 || this.goalT > 0) { b.tx = b.cfg.homeX; b.ty = CY; }
      m.tx = i === 0 ? b.tx : FW - b.tx; m.ty = b.ty;
    }
    for (const m of this.mal) this.moveMallet(m, dt);

    if (this.goalT > 0) {
      this.goalT -= dt; this.sinkPuck(dt);
      for (const m of this.mal) this.integrateMallet(m, dt);
      if (this.goalT <= 0) { this.serveSide = this.goalSide; /* conceder serves */ this.serveT = 1.1; this.placeServe(); }
      return;
    }
    if (this.serveT > 0) {
      this.serveT -= dt;
      for (const m of this.mal) this.integrateMallet(m, dt);
      if (this.serveT <= 0) { p.live = true; this.stillT = 0; this.rally = 0; }
      return;
    }
    if (this.t > TIME_CAP) { this.finish(false, true); return; }
    if (this.alertT > 0) this.alertT -= dt;
    if (this.surgeCd > 0) this.surgeCd -= dt;
    if (this.TW === 'turbo') {
      if (this.boostT > 0) {
        this.boostT -= dt;
        const m = this.mal[1];
        if (Math.random() < 0.7) this.parts.burst(m.x, m.y, 1, { color: ['#ff7a4a', '#ffd9a0', '#ffffff'], speed: 120, speedMin: 20, life: 0.4, size: 3.4, drag: 4 });
      } else { this.boostIn -= dt; if (this.boostIn <= 0) { this.boostT = 5; this.boostIn = (7 + Math.random() * 6); this.alertT = 1.4; this.alertText = 'TURBO!'; this.shake = Math.max(this.shake, 4); } }
    }

    // physics substeps
    const h = dt / SUB, fr = Math.exp(-FRIC * dt);
    p.vx *= fr; p.vy *= fr;
    for (let k = 0; k < SUB; k++) {
      for (const m of this.mal) this.integrateMallet(m, h);
      p.x += p.vx * h; p.y += p.vy * h;
      for (const m of this.mal) this.collide(m);
      if (this.walls()) return;
    }
    const sp = Math.hypot(p.vx, p.vy);
    if (sp > PUCKMAX) { p.vx *= PUCKMAX / sp; p.vy *= PUCKMAX / sp; }
    // trail
    this.trail.push(p.x, p.y); if (this.trail.length > 28) this.trail.splice(0, 2);
    // anti-stall: a puck that sits dead for a while gets a nudge from the air jets
    if (sp < 12) { this.stillT += dt; if (this.stillT > 5) { this.stillT = 0; const a = Math.random() * TAUU; p.vx = Math.cos(a) * 160; p.vy = Math.sin(a) * 160; } } else this.stillT = 0;
  }
  integrateMallet(m, h) {
    m.x += m.vx * h; m.y += m.vy * h;
    const xmin = m.side === 0 ? MR : FW / 2 + MR, xmax = m.side === 0 ? FW / 2 - MR : FW - MR;
    if (m.x < xmin) { m.x = xmin; if (m.vx < 0) m.vx = 0; } else if (m.x > xmax) { m.x = xmax; if (m.vx > 0) m.vx = 0; }
    if (m.y < MR) { m.y = MR; if (m.vy < 0) m.vy = 0; } else if (m.y > FH - MR) { m.y = FH - MR; if (m.vy > 0) m.vy = 0; }
  }
  collide(m) {
    const p = this.puck;
    let dx = p.x - m.x, dy = p.y - m.y, d = Math.hypot(dx, dy);
    if (d >= MR + PR) return;
    if (d < 0.001) { dx = m.side === 0 ? 1 : -1; dy = 0; d = 1; }
    const nx = dx / d, ny = dy / d;
    p.x = m.x + nx * (MR + PR); p.y = m.y + ny * (MR + PR);
    const rel = (p.vx - m.vx) * nx + (p.vy - m.vy) * ny;
    if (rel < 0) {
      const j = -(1 + MALE) * rel;
      p.vx += j * nx; p.vy += j * ny;
      if (j > 220) this.onHit(m, p.x - nx * PR, p.y - ny * PR, j);
      if (this.TW === 'surge' && m.side === 1 && j > 300 && this.surgeCd <= 0 && Math.random() < 0.3) {
        this.surgeCd = 6; p.vx *= 1.5; p.vy *= 1.5; this.alertT = 1.2; this.alertText = 'SURGE!'; this.shake = Math.max(this.shake, 6); this.surgeGlow = 1.2;
        this.ripples.push({ x: p.x, y: p.y, t: 0, max: 0.7, r0: 20, r1: 120, col: '#ff7a4a', kind: 'hit' });
        this.parts.burst(p.x, p.y, 24, { color: ['#ff7a4a', '#ffd9a0', '#ffffff'], speed: 380, speedMin: 80, life: 0.7, size: 3.4, drag: 3 });
      }
    }
    // squeezed against the wall: keep the puck inside
    if (p.y < PR) p.y = PR; else if (p.y > FH - PR) p.y = FH - PR;
  }
  onHit(m, x, y, j) {
    m.flash = 1; this.hits++;
    if (this.lastHitBy !== m.side) { this.lastHitBy = m.side; }
    const col = m.side === 0 ? AMBER : CYAN, n = Math.min(14, 3 + Math.floor(j / 140));
    this.parts.burst(x, y, n, { color: [col, '#ffffff'], speed: 160 + j * 0.22, speedMin: 40, life: 0.45, size: 3, drag: 4 });
    this.ripples.push({ x, y, t: 0, max: 0.5, r0: 14, r1: 40 + Math.min(40, j * 0.03), col, kind: 'hit' });
  }
  wallSpark(x, y, sp) {
    this.parts.burst(x, y, 3 + Math.min(6, (sp / 250) | 0), { color: ['#ffffff', '#bfeaff'], speed: 120 + sp * 0.12, life: 0.4, size: 2.4, drag: 5 });
  }
  walls() {
    const p = this.puck;
    // posts
    for (const sx of [0, FW]) for (const sy of [CY - GH, CY + GH]) {
      const dx = p.x - sx, dy = p.y - sy, d = Math.hypot(dx, dy);
      if (d < PR + POST && d > 0.001) {
        const nx = dx / d, ny = dy / d; p.x = sx + nx * (PR + POST); p.y = sy + ny * (PR + POST);
        const vn = p.vx * nx + p.vy * ny;
        if (vn < 0) { p.vx -= 1.9 * vn * nx; p.vy -= 1.9 * vn * ny; this.wallSpark(sx, sy, -vn); }
      }
    }
    if (p.y < PR) { p.y = PR; if (p.vy < 0) { this.wallSpark(p.x, 0, -p.vy); p.vy = -p.vy * WALLE; p.vx *= 0.985; } }
    else if (p.y > FH - PR) { p.y = FH - PR; if (p.vy > 0) { this.wallSpark(p.x, FH, p.vy); p.vy = -p.vy * WALLE; p.vx *= 0.985; } }
    const inSlot = Math.abs(p.y - CY) <= GH;
    if (p.x < PR && !inSlot) { p.x = PR; if (p.vx < 0) { this.wallSpark(0, p.y, -p.vx); p.vx = -p.vx * WALLE; } }
    else if (p.x > FW - PR && !inSlot) { p.x = FW - PR; if (p.vx > 0) { this.wallSpark(FW, p.y, p.vx); p.vx = -p.vx * WALLE; } }
    if (p.x < -3) { this.goal(0); return true; }   // puck entered the left goal -> house scores
    if (p.x > FW + 3) { this.goal(1); return true; }
    return false;
  }
  goal(side) { // side = goal that was hit (0 = left/AI's goal)
    const scorer = 1 - side;
    this.score[scorer]++; this.popT[scorer] = 0;
    this.goalSide = side; this.goalT = 1.7; this.flash[side] = 1.2; this.shake = 14;
    const gx = side === 0 ? 0 : FW, col = scorer === 0 ? AMBER : CYAN, p = this.puck;
    this.ripples.push({ x: gx, y: CY, t: 0, max: 1.3, r0: 20, r1: 900, col, kind: 'goal' });
    this.ripples.push({ x: gx, y: CY, t: -0.12, max: 1.3, r0: 20, r1: 640, col: '#ffffff', kind: 'goal' });
    this.parts.burst(gx, p.y, 70, { angle: side === 0 ? 0 : Math.PI, spread: 1.3, color: [col, '#ffffff', '#cdeeff'], speed: 620, speedMin: 120, life: 1.4, size: 4.2, drag: 2.2 });
    this.trail.length = 0;
    if (this.score[scorer] >= WIN) this.finish(scorer === 0, false);
  }
  sinkPuck(dt) {
    const p = this.puck; p.x += p.vx * dt; p.y += p.vy * dt; p.vx *= Math.exp(-3 * dt); p.vy *= Math.exp(-3 * dt);
    const lim = this.goalSide === 0 ? -FRX + 18 : FW + FRX - 18;
    if (this.goalSide === 0) p.x = Math.max(p.x, lim); else p.x = Math.min(p.x, lim);
  }
  confetti(col) {
    const x = Math.random() * FW, y = Math.random() * FH * 0.4;
    this.parts.burst(x, y, 2, { color: [col, '#ffffff', '#9fe8ff', '#ffd9a0'], speed: 160, speedMin: 30, life: 1.6, size: 3.6, drag: 1.2, gravity: 90 });
  }
  finish(won, timeout) {
    this.over = true; this.won = won; this.timeout = timeout; this.overT = 0;
    if (timeout) this.rec = 0;
  }
  hud() {
    return { score: `${this.score[0]} – ${this.score[1]}`, detail: `First to ${WIN} · ${fmtTime(this.t)}` };
  }
  result() {
    const a = this.score[0], b = this.score[1];
    if (this.timeout) return `Out of time at ${a}–${b} (${this.style})`;
    return this.won ? `Beat the house bot ${a}–${b} in ${fmtTime(this.t)} (${this.style})` : `Lost to the house bot ${a}–${b} after ${fmtTime(this.t)} (${this.style})`;
  }

  // ---------------- drawing ----------------
  buildStatic(dpr) {
    const k = this.s * dpr;
    const c = document.createElement('canvas');
    c.width = Math.ceil(TW * k); c.height = Math.ceil(TH * k);
    const g = c.getContext('2d'); g.scale(k, k);
    // drop shadow
    g.save(); g.shadowColor = 'rgba(0,0,0,0.55)'; g.shadowBlur = 40; g.shadowOffsetY = 14;
    roundRect(g, 4, 4, TW - 8, TH - 8, 34); g.fillStyle = '#10222d'; g.fill(); g.restore();
    // frame
    let gr = g.createLinearGradient(0, 0, 0, TH);
    gr.addColorStop(0, '#35596d'); gr.addColorStop(0.5, '#1d3a4b'); gr.addColorStop(1, '#122a38');
    roundRect(g, 4, 4, TW - 8, TH - 8, 34); g.fillStyle = gr; g.fill();
    g.lineWidth = 2; g.strokeStyle = 'rgba(190,230,255,0.28)'; roundRect(g, 5, 5, TW - 10, TH - 10, 33); g.stroke();
    g.strokeStyle = 'rgba(0,0,0,0.45)'; roundRect(g, 9, 9, TW - 18, TH - 18, 30); g.stroke();
    // rail rivets
    g.fillStyle = 'rgba(200,235,255,0.22)';
    for (let i = 0; i < 9; i++) for (const y of [FRY * 0.5, TH - FRY * 0.5]) {
      if (Math.abs(i - 4) < 1.6 && y < FRY) continue;
      g.beginPath(); g.arc(70 + i * (TW - 140) / 8, y, 2.4, 0, TAUU); g.fill();
    }
    g.translate(FRX, FRY);
    // surface
    gr = g.createRadialGradient(FW / 2, CY, 40, FW / 2, CY, FW * 0.62);
    gr.addColorStop(0, '#16445a'); gr.addColorStop(0.6, '#0e2f41'); gr.addColorStop(1, '#09202d');
    roundRect(g, 0, 0, FW, FH, 10); g.fillStyle = gr; g.fill();
    g.save(); roundRect(g, 0, 0, FW, FH, 10); g.clip();
    // scratches
    g.lineCap = 'round';
    for (const s of this.scratches) { g.strokeStyle = `rgba(190,232,255,${s[4]})`; g.lineWidth = 0.8; g.beginPath(); g.moveTo(s[0], s[1]); g.lineTo(s[2], s[3]); g.stroke(); }
    // air-hockey holes
    const rr = mulberry(99); g.fillStyle = 'rgba(150,215,245,0.13)';
    for (let y = 8, row = 0; y < FH; y += 14, row++) for (let x = 8 + (row % 2) * 7; x < FW; x += 14) {
      if (rr() < 0.04) continue; g.beginPath(); g.arc(x, y, 1.15, 0, TAUU); g.fill();
    }
    // creases
    for (const side of [0, 1]) {
      const gx = side === 0 ? 0 : FW, col = side === 0 ? '255,179,71' : '79,216,255';
      const cg = g.createRadialGradient(gx, CY, GH * 0.4, gx, CY, GH + 90);
      cg.addColorStop(0, `rgba(${col},0.16)`); cg.addColorStop(1, `rgba(${col},0)`);
      g.fillStyle = cg; g.beginPath(); g.arc(gx, CY, GH + 90, 0, TAUU); g.fill();
      g.strokeStyle = `rgba(${col},0.22)`; g.lineWidth = 2; g.beginPath(); g.arc(gx, CY, GH + 55, side === 0 ? -Math.PI / 2 : Math.PI / 2, side === 0 ? Math.PI / 2 : -Math.PI / 2 + TAUU, false); g.stroke();
    }
    // centre markings
    g.strokeStyle = 'rgba(170,225,255,0.34)'; g.lineWidth = 3;
    g.beginPath(); g.moveTo(FW / 2, 0); g.lineTo(FW / 2, FH); g.stroke();
    g.lineWidth = 2.5; g.beginPath(); g.arc(FW / 2, CY, 92, 0, TAUU); g.stroke();
    g.fillStyle = 'rgba(170,225,255,0.4)'; g.beginPath(); g.arc(FW / 2, CY, 6, 0, TAUU); g.fill();
    for (const [x, y] of [[FW * 0.25, CY - 150], [FW * 0.25, CY + 150], [FW * 0.75, CY - 150], [FW * 0.75, CY + 150]]) {
      g.strokeStyle = 'rgba(170,225,255,0.3)'; g.lineWidth = 2; g.beginPath(); g.arc(x, y, 16, 0, TAUU); g.stroke();
      g.fillStyle = 'rgba(170,225,255,0.3)'; g.beginPath(); g.arc(x, y, 4, 0, TAUU); g.fill();
    }
    // inner shadow near rails
    for (const [x0, y0, x1, y1] of [[0, 0, 0, 26], [0, FH, 0, FH - 26], [0, 0, 26, 0], [FW, 0, FW - 26, 0]]) {
      const ig = g.createLinearGradient(x0, y0, x1, y1); ig.addColorStop(0, 'rgba(0,10,18,0.5)'); ig.addColorStop(1, 'rgba(0,10,18,0)');
      g.fillStyle = ig; g.fillRect(0, 0, FW, FH);
    }
    g.restore();
    // goal slots (recess in the frame)
    for (const side of [0, 1]) {
      const col = side === 0 ? AMBER : CYAN;
      const x = side === 0 ? -FRX + 6 : FW, w = FRX - 6;
      g.fillStyle = '#04101a'; g.fillRect(x, CY - GH, w, GH * 2);
      const sg = g.createLinearGradient(side === 0 ? 0 : FW, 0, side === 0 ? -FRX : FW + FRX, 0);
      sg.addColorStop(0, col + '55'); sg.addColorStop(1, col + '00');
      g.fillStyle = sg; g.fillRect(x, CY - GH, w, GH * 2);
      g.strokeStyle = col + 'aa'; g.lineWidth = 2.5;
      g.beginPath(); g.moveTo(side === 0 ? 0 : FW, CY - GH); g.lineTo(side === 0 ? 0 : FW, CY + GH); g.stroke();
      for (const sy of [CY - GH, CY + GH]) {
        g.fillStyle = '#9fc4d8'; g.beginPath(); g.arc(side === 0 ? 0 : FW, sy, POST, 0, TAUU); g.fill();
        g.fillStyle = '#ffffff88'; g.beginPath(); g.arc((side === 0 ? 0 : FW) - 1.5, sy - 2, 2.2, 0, TAUU); g.fill();
      }
    }
    // rim highlight
    g.strokeStyle = 'rgba(170,225,255,0.22)'; g.lineWidth = 2; roundRect(g, 0, 0, FW, FH, 10); g.stroke();
    return c;
  }

  drawBackground(ctx, W, H) {
    const g = ctx.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, '#071a26'); g.addColorStop(1, '#040f17');
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
    const t = this.t;
    // slow aurora/frost glow pools
    ctx.globalCompositeOperation = 'lighter';
    const pools = [[0.2, 0.25, 0.55, '#1b6f94', 0.16, 0.021], [0.82, 0.78, 0.5, '#26577c', 0.14, 0.017], [0.55, 0.1, 0.4, '#1e8a8a', 0.09, 0.013]];
    for (const [px, py, pr, col, a, sp] of pools) {
      const x = W * (px + Math.sin(t * sp * 3 + px * 9) * 0.07), y = H * (py + Math.cos(t * sp * 3 + py * 7) * 0.06), r = Math.max(W, H) * pr;
      ctx.globalAlpha = a; ctx.drawImage(glowSprite(col), x - r, y - r, r * 2, r * 2);
    }
    ctx.globalAlpha = 1;
    // drifting snow motes
    ctx.fillStyle = '#d8f1ff';
    for (const m of this.motes) {
      const x = ((m.x + t * 0.004 * m.z + Math.sin(t * 0.2 + m.ph) * 0.01) % 1 + 1) % 1 * W;
      const y = ((m.y + t * 0.012 * m.z) % 1) * H;
      ctx.globalAlpha = 0.05 + 0.17 * m.z * (0.6 + 0.4 * Math.sin(t * 0.9 + m.ph));
      ctx.beginPath(); ctx.arc(x, y, 1 + m.z * 2, 0, TAUU); ctx.fill();
    }
    ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
    // vignette
    const v = ctx.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.35, W / 2, H / 2, Math.max(W, H) * 0.75);
    v.addColorStop(0, 'rgba(0,0,0,0)'); v.addColorStop(1, 'rgba(0,4,8,0.6)');
    ctx.fillStyle = v; ctx.fillRect(0, 0, W, H);
  }

  drawMallet(ctx, m, col, lite) {
    const fl = m.flash, sp = Math.hypot(m.vx, m.vy);
    // shadow
    ctx.fillStyle = 'rgba(0,8,14,0.4)'; ctx.beginPath(); ctx.arc(m.x + 5, m.y + 9, MR + 1, 0, TAUU); ctx.fill();
    // glow pool
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = 0.32 + fl * 0.4 + Math.min(0.18, sp / 6000);
    const gr = MR * (2.6 + fl * 0.5); ctx.drawImage(glowSprite(col), m.x - gr, m.y - gr, gr * 2, gr * 2);
    ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
    // base disc
    let g = ctx.createRadialGradient(m.x - 10, m.y - 12, 4, m.x, m.y, MR);
    g.addColorStop(0, lite); g.addColorStop(0.7, col); g.addColorStop(1, shade(col, 0.45));
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(m.x, m.y, MR, 0, TAUU); ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.35)'; ctx.lineWidth = 1.6; ctx.beginPath(); ctx.arc(m.x, m.y, MR - 1, 0, TAUU); ctx.stroke();
    ctx.strokeStyle = 'rgba(0,0,0,0.25)'; ctx.lineWidth = 3; ctx.beginPath(); ctx.arc(m.x, m.y, MR * 0.72, 0, TAUU); ctx.stroke();
    // raised knob
    g = ctx.createRadialGradient(m.x - 7, m.y - 9, 2, m.x, m.y, MR * 0.58);
    g.addColorStop(0, '#ffffff'); g.addColorStop(0.35, lite); g.addColorStop(1, shade(col, 0.7));
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(m.x, m.y, MR * 0.58, 0, TAUU); ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.55)'; ctx.beginPath(); ctx.ellipse(m.x - 8, m.y - 10, 7, 4, -0.7, 0, TAUU); ctx.fill();
    if (fl > 0) { ctx.globalAlpha = fl * 0.5; ctx.strokeStyle = '#fff'; ctx.lineWidth = 3; ctx.beginPath(); ctx.arc(m.x, m.y, MR + 2 + (1 - fl) * 6, 0, TAUU); ctx.stroke(); ctx.globalAlpha = 1; }
  }

  draw(ctx, W, H) {

    const a = IP.alpha();

    const st = IP.push(this._ipg(), a);

    try { this._draw(ctx, W, H); } finally { IP.pop(st); }

  }

  _draw(ctx, W, H) {
    this.drawBackground(ctx, W, H);
    const dpr = ctx.getTransform().a || 1;
    const key = `${this.s.toFixed(3)}|${dpr}`;
    if (this.staticKey !== key) { this.static = this.buildStatic(dpr); this.staticKey = key; }
    const t = this.t, p = this.puck, s = this.s;
    ctx.save();
    const sh = this.shake;
    ctx.translate(this.ox + Math.sin(t * 71) * sh * 0.5 * s, this.oy + Math.cos(t * 59) * sh * 0.5 * s);
    ctx.scale(s, s);
    ctx.drawImage(this.static, 0, 0, TW, TH);
    // ---- scoreboard on the top rail ----
    this.drawScoreboard(ctx);
    ctx.translate(FRX, FRY);

    // goal slot glow + lamps (outside the clip)
    for (const side of [0, 1]) {
      const col = side === 0 ? AMBER : CYAN, f = Math.min(1, this.flash[side]);
      const pulse = 0.35 + 0.15 * Math.sin(t * 2.2 + side * 2);
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = Math.min(1, pulse + f * 1.4);
      const gx = side === 0 ? -8 : FW + 8, r = GH * (1.5 + f * 0.9);
      ctx.drawImage(glowSprite(col), gx - r, CY - r, r * 2, r * 2);
      ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
    }
    ctx.save();
    roundRect(ctx, 0, 0, FW, FH, 10); ctx.clip();
    // moving sheen
    const sx = ((t * 38) % (FW + 600)) - 300;
    const sg = ctx.createLinearGradient(sx - 140, 0, sx + 140, FH);
    sg.addColorStop(0, 'rgba(180,230,255,0)'); sg.addColorStop(0.5, 'rgba(180,230,255,0.055)'); sg.addColorStop(1, 'rgba(180,230,255,0)');
    ctx.fillStyle = sg; ctx.fillRect(0, 0, FW, FH);
    // big faint scores on each half
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    for (let i = 0; i < 2; i++) {
      const pop = this.popT[i] < 0.6 ? 1 + 0.35 * (1 - ease.outCubic(this.popT[i] / 0.6)) : 1;
      ctx.save(); ctx.translate(FW * (i === 0 ? 0.25 : 0.75), CY); ctx.scale(pop, pop);
      ctx.globalAlpha = 0.07 + (this.popT[i] < 0.6 ? 0.1 * (1 - this.popT[i] / 0.6) : 0);
      ctx.fillStyle = i === 0 ? AMBER : CYAN; ctx.font = '800 300px "Big Shoulders Display", Impact, sans-serif';
      ctx.fillText(String(this.score[i]), 0, 8);
      ctx.restore();
    }
    ctx.globalAlpha = 1;
    // ripples
    for (const r of this.ripples) {
      if (r.t < 0) continue;
      const u = r.t / r.max, e = ease.outCubic(u), rad = r.r0 + (r.r1 - r.r0) * e;
      ctx.globalAlpha = (1 - u) * (r.kind === 'goal' ? 0.65 : 0.5);
      ctx.strokeStyle = r.col; ctx.lineWidth = r.kind === 'goal' ? 5 * (1 - u) + 1 : 2;
      ctx.beginPath(); ctx.arc(r.x, r.y, rad, 0, TAUU); ctx.stroke();
    }
    ctx.globalAlpha = 1;
    // puck trail
    const tr = this.trail, n = tr.length / 2, spd = Math.hypot(p.vx, p.vy);
    if (n > 2 && this.goalT <= 0) {
      ctx.globalCompositeOperation = 'lighter'; ctx.lineCap = 'round';
      const ta = Math.min(1, spd / 900);
      for (let i = 1; i < n; i++) {
        const u = i / n;
        ctx.strokeStyle = `rgba(190,235,255,${(u * u * 0.5 * ta).toFixed(3)})`;
        ctx.lineWidth = PR * 1.5 * u;
        ctx.beginPath(); ctx.moveTo(tr[(i - 1) * 2], tr[(i - 1) * 2 + 1]); ctx.lineTo(tr[i * 2], tr[i * 2 + 1]); ctx.stroke();
      }
      ctx.globalCompositeOperation = 'source-over';
    }
    // mallets under puck? (mallet shadows/body first, puck on top for contact look)
    this.drawMallet(ctx, this.mal[0], AMBER, '#ffe2b0');
    this.drawMallet(ctx, this.mal[1], CYAN, '#c9f4ff');
    this.drawPuck(ctx, p, spd);
    ctx.restore(); // clip

    this.parts.draw(ctx, 1);

    // twist callouts
    if (this.boostT > 0) {
      const m = this.mal[1];
      ctx.save(); ctx.globalCompositeOperation = 'lighter';
      const r = MR * 2.6, g = ctx.createRadialGradient(m.x, m.y, MR * 0.5, m.x, m.y, r);
      g.addColorStop(0, 'rgba(255,120,60,0.55)'); g.addColorStop(1, 'rgba(255,80,30,0)');
      ctx.fillStyle = g; ctx.beginPath(); ctx.arc(m.x, m.y, r, 0, TAUU); ctx.fill();
      ctx.restore();
    }
    if (this.alertT > 0 && !this.over) {
      ctx.save(); ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.globalAlpha = Math.min(1, this.alertT * 2.5);
      const fl = Math.floor(this.alertT * 8) % 2;
      ctx.font = '800 64px "Big Shoulders Display", Impact, sans-serif'; ctx.lineWidth = 7; ctx.strokeStyle = 'rgba(0,10,20,0.7)';
      ctx.strokeText(this.alertText, FW / 2, CY - 150); ctx.fillStyle = (fl ? '#ff8a58' : '#ffd9a0');
      ctx.fillText(this.alertText, FW / 2, CY - 150);
      ctx.restore();
    }

    // goal text
    if (this.goalT > 0 || (this.over && this.overT < 3)) {
      const gt = this.over ? Math.min(this.overT, 1.7) : 1.7 - this.goalT;
      if (!this.over || this.overT < 1.9) {
        const u = Math.min(1, gt / 0.5), e = ease.outBack(u), a = Math.min(1, (1.7 - gt) / 0.4 + (this.over ? 1 : 0));
        const scorer = 1 - this.goalSide, col = scorer === 0 ? AMBER : CYAN;
        ctx.save(); ctx.translate(FW / 2, CY - 6); ctx.scale(e, e); ctx.globalAlpha = Math.max(0, Math.min(1, a));
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.font = '800 130px "Big Shoulders Display", Impact, sans-serif';
        ctx.fillStyle = 'rgba(0,10,20,0.5)'; ctx.fillText('GOAL!', 4, 8);
        ctx.fillStyle = col; ctx.fillText('GOAL!', 0, 0);
        ctx.font = '600 24px "IBM Plex Mono", monospace'; ctx.fillStyle = '#e8f6ff';
        ctx.fillText(scorer === 0 ? 'AUTOPILOT' : 'HOUSE BOT', 0, 78);
        ctx.restore();
      }
    }
    ctx.restore();
  }

  drawPuck(ctx, p, spd) {
    let sc = 1, al = 1;
    if (this.goalT > 0 && !this.over) { const u = 1 - this.goalT / 1.7; al = Math.max(0, 1 - u * 2.2); sc = 1 - 0.3 * u; }
    else if (this.over) al = 0;
    else if (this.serveT > 0) { const u = Math.max(0, Math.min(1, 1 - (this.serveT - 0.1) / 0.9)); sc = ease.outBack(u) * (1 + (1 - u) * 0.8) ; al = u; sc = Math.max(0.01, sc); }
    if (al <= 0) return;
    ctx.save(); ctx.globalAlpha = al; ctx.translate(p.x, p.y); ctx.scale(sc, sc);
    ctx.fillStyle = 'rgba(0,8,14,0.45)'; ctx.beginPath(); ctx.arc(3, 6, PR, 0, TAUU); ctx.fill();
    // puck glow
    ctx.globalCompositeOperation = 'lighter'; ctx.globalAlpha = al * (0.18 + Math.min(0.3, spd / 3500));
    ctx.drawImage(glowSprite('#bfe9ff'), -PR * 2.6, -PR * 2.6, PR * 5.2, PR * 5.2);
    ctx.globalAlpha = al; ctx.globalCompositeOperation = 'source-over';
    const g = ctx.createRadialGradient(-6, -7, 2, 0, 0, PR);
    g.addColorStop(0, '#ffffff'); g.addColorStop(0.7, '#e8f4fb'); g.addColorStop(1, '#a9c6d6');
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(0, 0, PR, 0, TAUU); ctx.fill();
    ctx.strokeStyle = 'rgba(60,110,140,0.55)'; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(0, 0, PR * 0.62, 0, TAUU); ctx.stroke();
    ctx.strokeStyle = 'rgba(255,255,255,0.8)'; ctx.lineWidth = 1.2; ctx.beginPath(); ctx.arc(0, 0, PR - 0.8, 0, TAUU); ctx.stroke();
    ctx.restore();
  }

  drawScoreboard(ctx) {
    const cx = TW / 2, y = FRY / 2;
    ctx.save();
    roundRect(ctx, cx - 210, y - 17, 420, 34, 10);
    ctx.fillStyle = '#04111a'; ctx.fill();
    ctx.strokeStyle = 'rgba(160,215,245,0.3)'; ctx.lineWidth = 1.5; ctx.stroke();
    ctx.textBaseline = 'middle';
    // pips
    for (let i = 0; i < 2; i++) {
      for (let k = 0; k < WIN; k++) {
        const on = k < this.score[i], col = i === 0 ? AMBER : CYAN;
        const x = i === 0 ? cx - 40 - 14 * (WIN - 1 - k) - 18 : cx + 40 + 14 * k + 18;
        ctx.beginPath(); ctx.arc(x, y, 4.2, 0, TAUU);
        if (on) {
          ctx.fillStyle = col; ctx.fill();
          ctx.globalAlpha = 0.5; ctx.globalCompositeOperation = 'lighter'; ctx.drawImage(glowSprite(col), x - 12, y - 12, 24, 24); ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
        } else { ctx.fillStyle = 'rgba(120,170,200,0.2)'; ctx.fill(); }
      }
    }
    ctx.font = '600 24px "IBM Plex Mono", monospace'; ctx.textAlign = 'center';
    for (let i = 0; i < 2; i++) {
      const pop = this.popT[i] < 0.5 ? 1 + 0.5 * (1 - ease.outCubic(this.popT[i] / 0.5)) : 1;
      ctx.save(); ctx.translate(cx + (i === 0 ? -22 : 22), y + 1); ctx.scale(pop, pop);
      ctx.fillStyle = i === 0 ? AMBER : CYAN; ctx.fillText(String(this.score[i]), 0, 0); ctx.restore();
    }
    ctx.fillStyle = 'rgba(200,230,245,0.55)'; ctx.fillText(':', cx, y);
    ctx.font = '600 11px "Big Shoulders Display", sans-serif'; ctx.fillStyle = 'rgba(255,200,130,0.7)';
    ctx.textAlign = 'left'; ctx.fillText('AUTOPILOT', cx - 200, y + 1);
    ctx.fillStyle = 'rgba(140,225,255,0.7)'; ctx.textAlign = 'right'; ctx.fillText('HOUSE BOT', cx + 200, y + 1);
    ctx.restore();
  }
}

function shade(hex, k) {
  const n = parseInt(hex.slice(1), 16);
  return `rgb(${Math.round((n >> 16 & 255) * k)},${Math.round((n >> 8 & 255) * k)},${Math.round((n & 255) * k)})`;
}

Arcade.register({
  id: 'hockey', name: 'Ice Hockey Duel', genre: 'Air hockey',
  aiNote: "Sees the puck late, estimates its velocity from two frames, and moves its mallet under the same speed and acceleration limits as the house bot.",
  blurb: 'Bank shots and razor defence against the house bot. First to seven.',
  bg: '#0e2a3a', accent: '#ffb347',
  twists: TWISTS,
  create(opts = {}) { return new Hockey(opts); },
});
})();
