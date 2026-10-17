(() => {
'use strict';
// ---------------------------------------------------------------------------
// Paper Invaders — space invaders in cut construction paper.
// Logical field 1000x720, scaled to fit. Fixed 60 Hz logic; moving things keep prev positions
// and are drawn at lerp(prev, cur, Arcade.alpha).
// ---------------------------------------------------------------------------
const FW = 1000, FH = 720, DT = 1 / 60;
const COLS = 11, ROWS = 5, SPX = 56, SPY = 46, INV_HW = 20, INV_HH = 15;
const STEP_X = 10, DROP = 24, WALL = 30;
const PLAYER_Y = 648, PLAYER_V = 340, PLAYER_HALF = 17, PL_MIN = 40, PL_MAX = FW - 40, TAU_P = 0.05;
const BULLET_V = 720, BULLET_Y0 = PLAYER_Y - 34;
const BOMB_V = [235, 268, 300], BOMB_MAX = [4, 5, 6], BOMB_GAP = [0.72, 0.5, 0.36];
const WAVE_OY = [122, 160, 198], WAVE_MUL = [1, 0.86, 0.75];
const LOSE_Y = 626, GROUND_Y = 690, UFO_Y = 76;
const REACT_TICKS = 4; // 66 ms input pipeline (60 ms reaction)
const TIME_CAP = 360;
const CS = 3, BW = 26, BH = 20, RS = 6; // bunker cell size (units), cells, px per cell in cache
const BUNKER_X = [125, 375, 625, 875], BUNKER_Y = 520;

const PAL = {
  cream: '#f3e7c9', cream2: '#d9c9a2', must: '#e7a92f', must2: '#c58a1d', teal: '#2f9e92', tealD: '#0f3a42',
  brick: '#c4503a', brick2: '#9a3a2a', sage: '#58b9a0', stick: '#d8ad73', stick2: '#b88a52', coral: '#ff7b54',
};
const SHADOW = 'rgba(0,0,0,0.34)';
const CONF = [PAL.cream, PAL.must, PAL.brick, PAL.teal, PAL.coral, '#8fd3c4'];

const stepInterval = (count, wave) => (0.05 + 0.5 * Math.pow(count / 55, 1.15)) * WAVE_MUL[wave];
const lerpv = (a, b, t) => a + (b - a) * t;
const A = () => (typeof Arcade !== 'undefined' && Arcade.alpha != null ? Arcade.alpha : 1);

// ---- cut-paper critter sprites (drawn into cached offscreen canvases, shadow baked) -----------
function lineCap(g, x1, y1, x2, y2, w, col) {
  g.strokeStyle = col; g.lineWidth = w; g.lineCap = 'round';
  g.beginPath(); g.moveTo(x1, y1); g.lineTo(x2, y2); g.stroke();
}
function dot(g, x, y, r, col) { g.fillStyle = col; g.beginPath(); g.arc(x, y, r, 0, TAU); g.fill(); }
function shapeSquid(g, f, C, sh) {
  const legs = f ? [[-9, 6, -7, 15], [-3, 7, -1, 14], [3, 7, 1, 14], [9, 6, 7, 15]]
                 : [[-9, 6, -14, 14], [-3, 7, -4, 15], [3, 7, 4, 15], [9, 6, 14, 14]];
  for (const l of legs) lineCap(g, l[0], l[1], l[2], l[3], 4.2, C('cream2'));
  lineCap(g, -5, -13, f ? -9 : -7, f ? -19 : -20, 2.2, C('cream2'));
  lineCap(g, 5, -13, f ? 9 : 7, f ? -19 : -20, 2.2, C('cream2'));
  dot(g, f ? -9 : -7, f ? -19 : -20, 2.4, C('brick')); dot(g, f ? 9 : 7, f ? -19 : -20, 2.4, C('brick'));
  g.fillStyle = C('cream'); g.beginPath();
  g.moveTo(-14, 7); g.bezierCurveTo(-15, -6, -11, -16, 0, -16); g.bezierCurveTo(11, -16, 15, -6, 14, 7); g.closePath(); g.fill();
  if (!sh) {
    g.fillStyle = PAL.cream2; g.beginPath(); g.moveTo(-14, 3); g.lineTo(14, 3); g.lineTo(14, 7); g.lineTo(-14, 7); g.closePath(); g.fill();
    dot(g, -5.5, -5, 3.4, PAL.tealD); dot(g, 5.5, -5, 3.4, PAL.tealD);
    dot(g, -6.3, -6, 1.1, PAL.cream); dot(g, 4.7, -6, 1.1, PAL.cream);
    dot(g, -9, 0, 2, PAL.brick); dot(g, 9, 0, 2, PAL.brick);
    g.fillStyle = PAL.brick; g.beginPath(); g.moveTo(-2.5, 1); g.lineTo(2.5, 1); g.lineTo(0, 4.5); g.closePath(); g.fill();
  }
}
function shapeCrab(g, f, C, sh) {
  const arm = f ? [[-14, 1, -20, 8], [14, 1, 20, 8]] : [[-14, -2, -20, -10], [14, -2, 20, -10]];
  for (const a of arm) { lineCap(g, a[0], a[1], a[2], a[3], 4, C('must2')); dot(g, a[2], a[3], 3.6, C('must2')); }
  const lg = f ? [[-9, 8, -7, 15], [9, 8, 7, 15], [-3, 9, -3, 15], [3, 9, 3, 15]] : [[-9, 8, -13, 14], [9, 8, 13, 14], [-3, 9, -4, 15], [3, 9, 4, 15]];
  for (const l of lg) lineCap(g, l[0], l[1], l[2], l[3], 3.4, C('must2'));
  lineCap(g, -5, -8, -5, -13, 2, C('must2')); lineCap(g, 5, -8, 5, -13, 2, C('must2'));
  roundRect(g, -15, -9, 30, 19, 8); g.fillStyle = C('must'); g.fill();
  if (!sh) {
    g.fillStyle = PAL.must2; roundRect(g, -15, 5, 30, 5, 2.5); g.fill();
    dot(g, -5, -14, 3.6, PAL.cream); dot(g, 5, -14, 3.6, PAL.cream);
    dot(g, -5, -13.5, 1.8, PAL.tealD); dot(g, 5, -13.5, 1.8, PAL.tealD);
    g.strokeStyle = PAL.tealD; g.lineWidth = 1.8; g.lineCap = 'round';
    g.beginPath(); g.moveTo(-5, 0); g.quadraticCurveTo(0, 5, 5, 0); g.stroke();
    dot(g, -10, 0, 2, PAL.brick); dot(g, 10, 0, 2, PAL.brick);
    g.fillStyle = PAL.cream; g.fillRect(-1.2, -8, 2.4, 3);
  }
}
function shapeOcto(g, f, C, sh) {
  g.fillStyle = C('brick2');
  const ft = f ? [[-14, -8], [-4, 4], [6, 8]] : [[-17, -11], [-4, 4], [9, 11]];
  g.beginPath();
  for (const [a, b] of ft) { g.moveTo(a - 1, 6); g.lineTo(a + 5, 6); g.lineTo(a + 5, 14); g.quadraticCurveTo(a + 2, 16.5, a - 1, 14); g.closePath(); }
  g.beginPath();
  for (const x of f ? [-13, -4.5, 4.5, 13] : [-16.5, -5.5, 5.5, 16.5]) { g.moveTo(x - 3.2, 4); g.lineTo(x + 3.2, 4); g.lineTo(x + (f ? 0 : Math.sign(x) * 0.8), 14.5); g.closePath(); }
  g.fill();
  g.fillStyle = C('brick'); g.beginPath();
  g.moveTo(-18, 8); g.bezierCurveTo(-19, -6, -12, -15, 0, -15); g.bezierCurveTo(12, -15, 19, -6, 18, 8); g.closePath(); g.fill();
  if (!sh) {
    g.fillStyle = PAL.brick2; g.beginPath(); g.moveTo(-18, 4); g.lineTo(18, 4); g.lineTo(18, 8); g.lineTo(-18, 8); g.closePath(); g.fill();
    dot(g, -7, -4, 4.4, PAL.cream); dot(g, 7, -4, 4.4, PAL.cream);
    dot(g, -6.2, -3.4, 2.1, PAL.tealD); dot(g, 7.8, -3.4, 2.1, PAL.tealD);
    g.fillStyle = PAL.cream; g.beginPath(); g.moveTo(-6, 2); g.lineTo(-3, 5); g.lineTo(0, 2); g.lineTo(3, 5); g.lineTo(6, 2); g.lineTo(6, 3.5); g.lineTo(-6, 3.5); g.closePath(); g.fill();
    dot(g, 0, -11, 2.4, PAL.must); dot(g, -13, -4, 1.6, PAL.must); dot(g, 13, -4, 1.6, PAL.must);
  }
}
const SHAPES = [shapeSquid, shapeCrab, shapeCrab, shapeOcto, shapeOcto];
const SPR_W = 52, SPR_H = 44;
function buildSprites(sc) {
  const out = [];
  for (const fn of [shapeSquid, shapeCrab, shapeOcto]) {
    const pair = [];
    for (let f = 0; f < 2; f++) {
      const c = document.createElement('canvas'); c.width = Math.ceil(SPR_W * sc); c.height = Math.ceil(SPR_H * sc);
      const g = c.getContext('2d'); g.setTransform(sc, 0, 0, sc, SPR_W / 2 * sc, SPR_H / 2 * sc);
      g.save(); g.translate(2.6, 3.6); fn(g, f, () => SHADOW, true); g.restore();
      fn(g, f, k => PAL[k], false);
      pair.push(c);
    }
    out.push(pair);
  }
  return out;
}

// ---- bunker of torn paper: a grid of cells that gets bitten ------------------------------------
class Bunker {
  constructor(x, y) { this.x = x; this.y = y; this.cells = new Uint8Array(BW * BH); this.shade = new Float32Array(BW * BH); this.cv = null; this.pop = 0; this.reset(); }
  reset() {
    for (let cy = 0; cy < BH; cy++) for (let cx = 0; cx < BW; cx++) {
      let on = 1;
      const r = 8;
      if (cy < r && cx < r && Math.hypot(r - cx - 0.5, r - cy - 0.5) > r) on = 0;
      if (cy < r && cx >= BW - r && Math.hypot(cx - (BW - r) + 0.5, r - cy - 0.5) > r) on = 0;
      if (cy >= 13 && cx >= 9 && cx <= BW - 10) { const dx = cx - (BW - 1) / 2; if (cy > 15 || Math.abs(dx) < 3.4 + (cy - 13) * 0.6) on = 0; }
      this.cells[cy * BW + cx] = on; this.shade[cy * BW + cx] = (Math.random() - 0.5) * 0.12;
    }
    for (let cy = 0; cy < BH; cy++) for (let cx = 0; cx < BW; cx++) {
      const i = cy * BW + cx;
      if (!this.cells[i]) continue;
      const edge = !this.has(cx - 1, cy) || !this.has(cx + 1, cy) || !this.has(cx, cy - 1);
      if (edge && Math.random() < 0.16) this.cells[i] = 0;
    }
    this.dirty = true; this.pop = 0;
  }
  has(cx, cy) { return cx >= 0 && cy >= 0 && cx < BW && cy < BH && this.cells[cy * BW + cx] === 1; }
  hasAt(wx, wy) { return this.has(Math.floor((wx - this.x) / CS), Math.floor((wy - this.y) / CS)); }
  bite(wx, wy, r) {
    const cx0 = (wx - this.x) / CS, cy0 = (wy - this.y) / CS, rr = r / CS;
    let n = 0;
    for (let cy = Math.max(0, Math.floor(cy0 - rr - 1)); cy <= Math.min(BH - 1, Math.ceil(cy0 + rr + 1)); cy++)
      for (let cx = Math.max(0, Math.floor(cx0 - rr - 1)); cx <= Math.min(BW - 1, Math.ceil(cx0 + rr + 1)); cx++) {
        const i = cy * BW + cx;
        if (!this.cells[i]) continue;
        const d = Math.hypot(cx + 0.5 - cx0, cy + 0.5 - cy0);
        if (d < rr * (0.55 + Math.random() * 0.6)) { this.cells[i] = 0; n++; }
      }
    if (n) this.dirty = true;
    return n;
  }
  clearRect(x0, y0, x1, y1) {
    let n = 0;
    for (let cy = 0; cy < BH; cy++) for (let cx = 0; cx < BW; cx++) {
      const i = cy * BW + cx;
      if (!this.cells[i]) continue;
      const wx = this.x + cx * CS + CS / 2, wy = this.y + cy * CS + CS / 2;
      if (wx > x0 && wx < x1 && wy > y0 && wy < y1) { this.cells[i] = 0; n++; }
    }
    if (n) this.dirty = true;
    return n;
  }
  render() {
    if (!this.cv) { this.cv = document.createElement('canvas'); this.cv.width = BW * RS + 14; this.cv.height = BH * RS + 14; }
    const g = this.cv.getContext('2d'); g.clearRect(0, 0, this.cv.width, this.cv.height);
    g.fillStyle = SHADOW;
    for (let cy = 0; cy < BH; cy++) for (let cx = 0; cx < BW; cx++) if (this.cells[cy * BW + cx]) g.fillRect(cx * RS + 6, cy * RS + 8, RS + 0.5, RS + 0.5);
    for (let cy = 0; cy < BH; cy++) for (let cx = 0; cx < BW; cx++) {
      const i = cy * BW + cx;
      if (!this.cells[i]) continue;
      const l = 62 + this.shade[i] * 100;
      g.fillStyle = `hsl(165,38%,${l * 0.78}%)`;
      g.fillRect(cx * RS, cy * RS, RS + 0.6, RS + 0.6);
      if (!this.has(cx, cy - 1)) { g.fillStyle = 'rgba(255,255,235,0.38)'; g.fillRect(cx * RS, cy * RS, RS + 0.6, 1.8); }
      if (!this.has(cx, cy + 1)) { g.fillStyle = 'rgba(0,40,40,0.35)'; g.fillRect(cx * RS, cy * RS + RS - 1.6, RS + 0.6, 1.8); }
      if (!this.has(cx - 1, cy)) { g.fillStyle = 'rgba(255,255,235,0.18)'; g.fillRect(cx * RS, cy * RS, 1.2, RS); }
    }
    this.dirty = false;
  }
  draw(g, a) {
    if (this.dirty || !this.cv) this.render();
    const k = RS ? CS / RS : 0.5;
    const sc = a >= 1 ? 1 : ease.outBack(clamp(a, 0, 1));
    g.save(); g.translate(this.x + BW * CS / 2, this.y + BH * CS); g.scale(sc, sc);
    g.globalAlpha = clamp(a * 3, 0, 1);
    g.drawImage(this.cv, -BW * CS / 2, -BH * CS, this.cv.width * k, this.cv.height * k);
    g.restore();
  }
  covers(x) { // any intact paper in this column band (a bullet from below would chew through it)
    const cx0 = Math.floor((x - 3 - this.x) / CS), cx1 = Math.floor((x + 3 - this.x) / CS);
    for (let cx = Math.max(0, cx0); cx <= Math.min(BW - 1, cx1); cx++) for (let cy = 0; cy < BH; cy++) if (this.cells[cy * BW + cx]) return true;
    return false;
  }
  // stopping y for a bomb of centre (x,y) falling: first intact cell under its tip (or Infinity)
  stopY(bx, y) {
    const cx0 = Math.floor((bx - 2.5 - this.x) / CS), cx1 = Math.floor((bx + 2.5 - this.x) / CS);
    if (cx1 < 0 || cx0 >= BW) return Infinity;
    const cyStart = Math.max(0, Math.floor((y + 8 - this.y) / CS));
    for (let cy = cyStart; cy < BH; cy++)
      for (let cx = Math.max(0, cx0); cx <= Math.min(BW - 1, cx1); cx++)
        if (this.cells[cy * BW + cx]) return this.y + cy * CS - 8;
    return Infinity;
  }
}

// ---------------------------------------------------------------------------
// AI. It only uses the observe() snapshot = what a player sees: player position, own bullet, falling
// bombs, UFO, which invaders are alive + formation offset, bunker paper cells. Formation timing
// (step times) is inferred from watching it move; step interval formula = known game constant.
// Output: {dir:-1|0|1, fire:bool}, applied by the game 66 ms later (reaction), player max speed 340.
// ---------------------------------------------------------------------------
// AI styles picked at create(): edge = bonus for outer columns, low = bonus for the lowest invaders (closest
// to the ground), ufo = bonus for UFO targets, jit = random tie-break noise on target scores.
const INV_STYLES = [
  { name: 'Edge cutter', edge: 1, low: 0.12, ufo: 1.3, jit: 0.04 },
  { name: 'Bottom-up', edge: 0.1, low: 0.55, ufo: 0.9, jit: 0.04 },
  { name: 'UFO hunter', edge: 0.5, low: 0.15, ufo: 3.2, jit: 0.04 },
];
const InvadersAI = {
  sty: INV_STYLES[0],
  reset() {
    this.now = 0; this.tStep = 0; this.lastOx = null; this.lastOy = null; this.dir = 1; this.wave = -1;
    this.hist = new Array(REACT_TICKS).fill(0); this.lastPx = null; this.vx = 0; this.fireLock = 0; this.lastCol = -1; this.dest = null;
  },
  think(s) {
    this.now += DT;
    const out = { dir: 0, fire: false };
    if (s.wave !== this.wave || s.phase !== 'play') {
      if (s.wave !== this.wave || s.phase !== 'play') { this.wave = s.wave; this.lastOx = null; }
    }
    if (s.phase !== 'play') { this.hist.push(0); this.hist.shift(); this.lastPx = s.px; return out; }
    if (this.lastOx === null) { this.lastOx = s.ox; this.lastOy = s.oy; this.tStep = this.now; this.dir = 1; }
    else if (s.ox !== this.lastOx || s.oy !== this.lastOy) {
      this.tStep = this.now;
      if (s.ox !== this.lastOx) this.dir = Math.sign(s.ox - this.lastOx); else this.dir = -this.dir;
      this.lastOx = s.ox; this.lastOy = s.oy;
    }
    if (this.lastPx !== null) this.vx = (s.px - this.lastPx) / DT;
    this.lastPx = s.px;
    if (!s.alive) { this.hist.push(0); this.hist.shift(); return out; }

    // --- my own position/velocity after the already-sent (pending) commands land
    const K = 1 - Math.exp(-DT / TAU_P);
    let x = s.px, v = this.vx;
    for (const d of this.hist) { v += (d * PLAYER_V - v) * K; x = clamp(x + v * DT, PL_MIN, PL_MAX); }
    const pxPred = x, vPred = v;

    // --- formation schedule (position of the formation at future times)
    const alive = s.alive_inv; let minC = 99, maxC = -1; const low = new Array(COLS).fill(-1);
    for (let c = 0; c < COLS; c++) for (let r = ROWS - 1; r >= 0; r--) if (alive[r * COLS + c]) { low[c] = r; if (c < minC) minC = c; if (c > maxC) maxC = c; break; }
    if (maxC < 0) { this.hist.push(0); this.hist.shift(); return out; }
    const ivl = stepInterval(s.count, s.wave);
    const sched = [{ t: 0, ox: s.ox, oy: s.oy }];
    {
      let ox = s.ox, oy = s.oy, dir = this.dir, t = Math.max(0, this.tStep + ivl - this.now);
      while (t < 2.2) {
        const left = ox + minC * SPX - INV_HW, right = ox + maxC * SPX + INV_HW;
        if (dir > 0 ? right + STEP_X > FW - WALL : left - STEP_X < WALL) { oy += DROP; dir = -dir; } else ox += dir * STEP_X;
        sched.push({ t, ox, oy }); t += ivl;
      }
    }
    const at = T => { let e = sched[0]; for (let i = 1; i < sched.length && sched[i].t <= T; i++) e = sched[i]; return e; };

    // --- bombs: where each will stop (hits a bunker or the ground / reaches me)
    const vb = BOMB_V[s.wave];
    const bombs = [];
    for (const b of s.bombs) {
      let end = Infinity;
      for (const bk of s.bunkers) { const e = bk.stopY(b.x, b.y); if (e < end) end = e; }
      bombs.push({ x: b.x, y: b.y, end });
    }
    const blocked = (xx) => { // intact paper above this x (a shot from here would chew my own bunker)
      for (const bk of s.bunkers) if (bk.covers(xx)) return true;
      return false;
    };

    // --- targets
    const targets = [];
    const bulletFree = s.bullet ? Math.max(0, (s.bullet.y - 20) / BULLET_V) : 0;
    for (let c = 0; c < COLS; c++) {
      const r = low[c]; if (r < 0) continue;
      let T = 0.6, xf = pxPred, tf = 0;
      for (let k = 0; k < 4; k++) {
        const e = at(T);
        const xt = e.ox + c * SPX, yt = e.oy + r * SPY;
        xf = clamp(xt, PL_MIN, PL_MAX);
        tf = Math.max(Math.abs(xf - pxPred) / PLAYER_V + REACT_TICKS * DT * 0.5, bulletFree + 0.04);
        T = tf + Math.max(0, (BULLET_Y0 - yt) / BULLET_V);
      }
      const e = at(T); const xt = e.ox + c * SPX;
      if (Math.abs(xf - xt) > 9) continue;
      let sc = T - this.sty.low * r + Math.random() * this.sty.jit;
      if (c === minC || c === maxC) sc -= 0.5 * this.sty.edge; else sc -= 0.25 * this.sty.edge * Math.max(c, COLS - 1 - c) / 5;
      if (c === this.lastCol) sc -= 0.15;
      if (blocked(xf) && s.count > 5) sc += 0.55;
      targets.push({ c, xf, sc, T, ufo: false });
    }
    if (s.ufo) {
      let T = 0.8, xf = pxPred, tf = 0;
      for (let k = 0; k < 4; k++) {
        const xt = s.ufo.x + s.ufo.vx * T;
        xf = clamp(xt, PL_MIN, PL_MAX);
        tf = Math.max(Math.abs(xf - pxPred) / PLAYER_V + REACT_TICKS * DT * 0.5, bulletFree + 0.04);
        T = tf + (BULLET_Y0 - UFO_Y) / BULLET_V;
      }
      const xt = s.ufo.x + s.ufo.vx * T;
      if (xt > 20 && xt < FW - 20 && Math.abs(xf - xt) < 9 && !blocked(xf)) targets.push({ c: -2, xf, sc: T - this.sty.ufo, T, ufo: true });
    }
    targets.sort((a, b) => a.sc - b.sc);
    const tgt = targets[0];
    if (tgt) this.lastCol = tgt.c;

    // --- fire: opportunistic. If a shot from where I will be hits a predicted invader/UFO, take it.
    if (!s.bullet && this.fireLock <= 0 && !blocked(pxPred)) {
      const tf = REACT_TICKS * DT;
      let ok = false;
      for (let c = 0; c < COLS && !ok; c++) {
        const r = low[c]; if (r < 0) continue;
        let T = tf + 0.5;
        for (let k = 0; k < 3; k++) { const e = at(T); T = tf + Math.max(0, (BULLET_Y0 - (e.oy + r * SPY)) / BULLET_V); }
        const e = at(T);
        if (Math.abs(e.ox + c * SPX - pxPred) < 12) ok = true;
      }
      if (!ok && s.ufo) {
        const T = tf + (BULLET_Y0 - UFO_Y) / BULLET_V;
        if (Math.abs(s.ufo.x + s.ufo.vx * T - pxPred) < 12) ok = true;
      }
      if (ok) { out.fire = true; this.fireLock = REACT_TICKS * DT + 0.08; }
    }
    this.fireLock -= DT;

    // --- movement: pick the safe destination nearest my goal x
    const want = tgt ? tgt.xf : (this.dest ?? FW / 2);
    const HIT = PLAYER_HALF + 5 + 9;
    const delay = REACT_TICKS * DT;
    const firstHit = (d) => {
      for (let k = 1; k <= 54; k++) {
        const t = k / 30;
        let xx;
        if (t <= delay) xx = lerpv(s.px, pxPred, t / delay);
        else xx = pxPred + clamp(d - pxPred, -PLAYER_V * (t - delay), PLAYER_V * (t - delay));
        for (const b of bombs) {
          const y = b.y + vb * t;
          if (y > b.end) continue;
          if (y > PLAYER_Y - 34 && y < PLAYER_Y + 24 && Math.abs(b.x - xx) < HIT) return t;
        }
      }
      return Infinity;
    };
    let dest = clamp(want, PL_MIN, PL_MAX);
    if (bombs.length) {
      if (firstHit(dest) !== Infinity) {
        let best = null, bestScore = -1e9;
        for (let d = PL_MIN; d <= PL_MAX; d += 8) {
          const ft = firstHit(d);
          const sc = (ft === Infinity ? 100 : ft * 8) - Math.abs(d - want) * 0.02 - Math.abs(d - pxPred) * 0.004;
          if (sc > bestScore) { bestScore = sc; best = d; }
        }
        dest = best;
      }
    }
    this.dest = dest;
    const stop = pxPred + vPred * TAU_P;
    const e = dest - stop;
    out.dir = Math.abs(e) < 2.2 ? 0 : Math.sign(e);
    this.hist.push(out.dir); this.hist.shift();
    return out;
  },
};

// ---------------------------------------------------------------------------
// Game
// ---------------------------------------------------------------------------
function create() {
  const G = {
    over: false, won: false,
    W: 1600, H: 900, s: 1, ox0: 0, oy0: 0,
    time: 0, state: 'intro', stateT: 0, wave: 0, score: 0, lives: 3, kills: 0, endReason: '',
    px: FW / 2, ppx: FW / 2, vx: 0, pAlive: true, pDeadT: 0, invuln: 0, recoil: 0, tilt: 0, lifted: 0,
    bullet: null, bombs: [], bombT: 1, ufo: null, ufoT: 14, conf: [], rings: [], tags: [], shake: 0, flash: 0,
    inv: new Uint8Array(55), count: 55, fox: 0, foy: 0, fdir: 1, fTimer: 0, fFrame: 0, fStepAt: -9, introDrop: 0,
    bunkers: BUNKER_X.map(x => new Bunker(x - BW * CS / 2, BUNKER_Y)), pipe: Array.from({ length: REACT_TICKS }, () => ({ dir: 0, fire: false })),
    sprites: null, spriteSc: 0, bg: null, bgKey: '', stars: [], clouds: [], pattern: null,
  };
  // deterministic decoration
  let seed = 7; const rr = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  for (let i = 0; i < 70; i++) G.stars.push({ x: -500 + rr() * 2000, y: -400 + rr() * 900, r: 2 + rr() * 3.2, ph: rr() * 6, hue: rr() < 0.3 ? PAL.must : PAL.cream });
  for (let i = 0; i < 7; i++) G.clouds.push({ x: rr() * 1800, y: 60 + rr() * 380, s: 0.8 + rr() * 1.2, v: 4 + rr() * 6 });

  InvadersAI.sty = INV_STYLES[Math.floor(Math.random() * INV_STYLES.length)]; G.style = InvadersAI.sty.name;
  InvadersAI.reset();
  setupWave();

  function setupWave() {
    G.inv.fill(1); G.count = 55;
    G.fox = (FW - 10 * SPX) / 2; G.foy = WAVE_OY[G.wave]; G.fdir = 1; G.fTimer = 0; G.fFrame = 0; G.fStepAt = -9;
    G.bombs.length = 0; G.bullet = null; G.bombT = 1.2; G.ufo = null; G.ufoT = 12 + Math.random() * 8;
    for (const b of G.bunkers) b.reset();
    G.state = 'intro'; G.stateT = 0;
  }

  // ---- fx helpers
  function confetti(x, y, n, cols, o = {}) {
    for (let i = 0; i < n; i++) {
      if (G.conf.length > 700) G.conf.shift();
      const a = o.angle != null ? o.angle + (Math.random() - 0.5) * (o.spread ?? 2) : Math.random() * TAU;
      const sp = (o.min ?? 40) + Math.random() * (o.speed ?? 260);
      G.conf.push({
        x, y, px: x, py: y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - (o.up ?? 60), rot: Math.random() * TAU, vr: (Math.random() - 0.5) * 16,
        w: 3 + Math.random() * 5.5, h: 2 + Math.random() * 3, col: Array.isArray(cols) ? cols[(Math.random() * cols.length) | 0] : cols,
        life: 0, max: (o.life ?? 1.3) * (0.6 + Math.random() * 0.8), ph: Math.random() * 6, g: o.g ?? 420,
      });
    }
  }
  const ring = (x, y, r1, col, life = 0.35) => G.rings.push({ x, y, r1, col, life: 0, max: life });
  const tag = (x, y, text, col) => G.tags.push({ x, y, text, col, life: 0, max: 1.1 });
  function addScore(n, x, y) { G.score += n; tag(x, y, '+' + n, PAL.must); }

  function lowestRow(c) { for (let r = ROWS - 1; r >= 0; r--) if (G.inv[r * COLS + c]) return r; return -1; }
  const invX = c => G.fox + c * SPX, invY = r => G.foy + r * SPY;

  function observe() {
    const bl = G.bullet;
    return {
      phase: G.state, wave: G.wave, px: G.px, alive: G.pAlive, count: G.count,
      bullet: bl ? { x: bl.x, y: bl.y } : null,
      bombs: G.bombs.map(b => ({ x: b.x, y: b.y })),
      ufo: G.ufo ? { x: G.ufo.x, vx: G.ufo.vx } : null,
      ox: G.fox, oy: G.foy, alive_inv: G.inv.slice(), bunkers: G.bunkers, // read-only views of the visible paper
    };
  }

  function hitPlayer() {
    G.lives--; G.pAlive = false; G.pDeadT = 0;
    confetti(G.px, PLAYER_Y, 40, [PAL.cream, PAL.brick, PAL.must, PAL.tealD], { speed: 380, life: 1.6 });
    ring(G.px, PLAYER_Y, 70, PAL.cream, 0.5); G.shake = 14; G.flash = 0.5;
    G.bombs = G.bombs.filter(b => Math.abs(b.x - G.px) > 60);
    if (G.lives <= 0) endGame(false, 'Out of lives in wave ' + (G.wave + 1));
  }
  function endGame(won, why) {
    if (G.over) return;
    G.over = true; G.won = won; G.endReason = why; G.state = won ? 'won' : 'lost'; G.stateT = 0;
    if (won) { G.lifted = 0; }
  }

  function killInvader(i) {
    G.inv[i] = 0; G.count--; G.kills++;
    const c = i % COLS, r = (i / COLS) | 0, x = invX(c), y = invY(r);
    const cols = r === 0 ? [PAL.cream, PAL.cream2, PAL.brick] : r < 3 ? [PAL.must, PAL.must2, PAL.cream] : [PAL.brick, PAL.brick2, PAL.must];
    confetti(x, y, 16, cols, { speed: 240, life: 1.1 });
    ring(x, y, 34, PAL.cream, 0.3); G.shake = Math.max(G.shake, 2);
    addScore(r === 0 ? 30 : r < 3 ? 20 : 10, x, y - 14);
  }

  function formationStep() {
    let minC = 99, maxC = -1;
    for (let c = 0; c < COLS; c++) if (lowestRow(c) >= 0) { if (c < minC) minC = c; if (c > maxC) maxC = c; }
    if (maxC < 0) return;
    const left = G.fox + minC * SPX - INV_HW, right = G.fox + maxC * SPX + INV_HW;
    if (G.fdir > 0 ? right + STEP_X > FW - WALL : left - STEP_X < WALL) { G.foy += DROP; G.fdir = -G.fdir; } else G.fox += G.fdir * STEP_X;
    G.fFrame ^= 1; G.fStepAt = G.time;
    // invaders chew through bunkers they touch
    for (const b of G.bunkers) {
      if (G.foy + (ROWS - 1) * SPY + INV_HH < b.y) continue;
      for (let i = 0; i < 55; i++) if (G.inv[i]) {
        const x = invX(i % COLS), y = invY((i / COLS) | 0);
        if (b.clearRect(x - INV_HW - 2, y - INV_HH - 2, x + INV_HW + 2, y + INV_HH + 2)) confetti(x, y + 8, 3, PAL.sage, { speed: 120, life: 0.7 });
      }
    }
    let lowY = 0; for (let c = 0; c < COLS; c++) { const r = lowestRow(c); if (r >= 0) lowY = Math.max(lowY, invY(r) + INV_HH); }
    if (lowY >= LOSE_Y && !G.over) {
      G.shake = 22; G.flash = 0.8;
      confetti(G.px, PLAYER_Y, 40, [PAL.cream, PAL.brick, PAL.must], { speed: 380, life: 1.6 }); G.pAlive = false;
      endGame(false, 'Invaders landed in wave ' + (G.wave + 1));
    }
  }

  function spawnBomb() {
    const cols = []; for (let c = 0; c < COLS; c++) if (lowestRow(c) >= 0) cols.push(c);
    if (!cols.length) return;
    let c;
    if (Math.random() < 0.5 && G.pAlive) { // aimed at the player's column
      c = cols.reduce((b, k) => (Math.abs(invX(k) - G.px) < Math.abs(invX(b) - G.px) ? k : b), cols[0]);
    } else c = cols[(Math.random() * cols.length) | 0];
    const r = lowestRow(c);
    G.bombs.push({ x: invX(c), y: invY(r) + 20, py: invY(r) + 20, ph: Math.random() * 6 });
    ring(invX(c), invY(r) + 16, 14, PAL.coral, 0.2);
  }

  G.resize = function (W, H) {
    G.W = W; G.H = H;
    G.s = Math.min(W * 0.94 / FW, H * 0.94 / FH);
    G.ox0 = (W - FW * G.s) / 2; G.oy0 = (H - FH * G.s) / 2;
    G.bgKey = '';
  };

  G.step = function (dt) {
    G.time += dt; G.stateT += dt;
    // fx
    for (let i = G.conf.length - 1; i >= 0; i--) {
      const p = G.conf[i]; p.life += dt;
      if (p.life >= p.max) { G.conf[i] = G.conf[G.conf.length - 1]; G.conf.pop(); continue; }
      p.px = p.x; p.py = p.y;
      p.vx *= Math.exp(-1.6 * dt); p.vy = p.vy * Math.exp(-1.2 * dt) + p.g * dt;
      p.x += p.vx * dt + Math.sin(p.life * 7 + p.ph) * 10 * dt; p.y += p.vy * dt; p.rot += p.vr * dt;
    }
    for (let i = G.rings.length - 1; i >= 0; i--) { G.rings[i].life += dt; if (G.rings[i].life >= G.rings[i].max) G.rings.splice(i, 1); }
    for (let i = G.tags.length - 1; i >= 0; i--) { const t = G.tags[i]; t.life += dt; t.y -= 26 * dt; if (t.life >= t.max) G.tags.splice(i, 1); }
    G.shake *= Math.exp(-6 * dt); G.flash = Math.max(0, G.flash - dt * 1.2); G.recoil = Math.max(0, G.recoil - dt * 6);

    G.ppx = G.px;
    if (G.bullet) G.bullet.py = G.bullet.y;
    for (const b of G.bombs) b.py = b.y;
    if (G.ufo) G.ufo.px = G.ufo.x;

    if (G.state === 'intro') {
      G.introDrop = ease.outCubic(clamp(G.stateT / 1.7, 0, 1));
      G.vx *= Math.exp(-dt / TAU_P); G.px += G.vx * dt;
      InvadersAI.think(observe());
      if (G.stateT >= 2.1) { G.state = 'play'; G.stateT = 0; }
      return;
    }
    if (G.state === 'clear') {
      G.vx *= Math.exp(-dt / TAU_P); G.px = clamp(G.px + G.vx * dt, PL_MIN, PL_MAX);
      if (G.stateT > 1.9) { G.wave++; setupWave(); }
      return;
    }
    if (G.state === 'won') {
      G.lifted += dt; if (G.lifted > 0.6) { G.vx = Math.min(1400, (G.vx || 0) + 900 * dt); }
      if (G.lifted > 0.5 && G.lifted < 3.4) confetti(G.px, PLAYER_Y + 30 - (G.lifted > 0.6 ? (G.lifted - 0.6) * (G.lifted - 0.6) * 450 : 0), 2, [PAL.must, PAL.coral, PAL.cream], { angle: Math.PI / 2, spread: 0.7, speed: 160, life: 0.9 });
      if (G.lifted < 3.8 && Math.random() < 0.5) confetti(Math.random() * FW, -10, 4, CONF, { angle: Math.PI / 2, spread: 0.5, speed: 120, min: 20, up: 0, g: 160, life: 3 });
      return;
    }
    if (G.state === 'lost') return;

    // ================= play =================
    if (G.time > TIME_CAP) { endGame(false, 'Out of time'); return; }

    // --- AI -> delayed command
    const cmd = InvadersAI.think(observe());
    G.pipe.push(cmd); const act = G.pipe.shift();
    if (G.pAlive) {
      const K = 1 - Math.exp(-dt / TAU_P);
      G.vx += (act.dir * PLAYER_V - G.vx) * K;
      G.px = clamp(G.px + G.vx * dt, PL_MIN, PL_MAX);
      if (G.px <= PL_MIN || G.px >= PL_MAX) G.vx = 0;
      if (act.fire && !G.bullet) { G.bullet = { x: G.px, y: BULLET_Y0, py: BULLET_Y0 }; G.recoil = 1; confetti(G.px, BULLET_Y0 + 10, 2, [PAL.cream, PAL.must], { angle: Math.PI / 2, spread: 0.5, speed: 80, life: 0.4 }); }
    } else {
      G.vx *= Math.exp(-dt / TAU_P);
      G.pDeadT += dt;
      if (G.pDeadT > 1.5 && !G.over) { G.pAlive = true; G.invuln = 2.2; G.vx = 0; G.pipe.forEach(c => { c.dir = 0; c.fire = false; }); InvadersAI.hist.fill(0); }
    }
    G.tilt += (clamp(G.vx / PLAYER_V, -1, 1) * 0.12 - G.tilt) * Math.min(1, dt * 14);
    G.invuln = Math.max(0, G.invuln - dt);

    // --- player bullet
    if (G.bullet) {
      const bl = G.bullet; const n = Math.ceil(BULLET_V * dt / 4); let hit = false;
      for (let k = 0; k < n && !hit; k++) {
        bl.y -= BULLET_V * dt / n;
        for (const b of G.bunkers) if (b.hasAt(bl.x, bl.y)) { b.bite(bl.x, bl.y + 2, 9); confetti(bl.x, bl.y, 8, PAL.sage, { angle: Math.PI / 2, spread: 1.4, speed: 160, life: 0.8 }); hit = true; break; }
        if (hit) break;
        for (let i = 0; i < 55; i++) if (G.inv[i]) {
          const x = invX(i % COLS), y = invY((i / COLS) | 0);
          if (Math.abs(bl.x - x) < INV_HW + 3 && Math.abs(bl.y - y) < INV_HH + 4) { killInvader(i); hit = true; break; }
        }
        if (hit) break;
        if (G.ufo && Math.abs(bl.x - G.ufo.x) < 28 && Math.abs(bl.y - UFO_Y) < 14) {
          const pts = [50, 100, 150, 300][(Math.random() * 4) | 0];
          confetti(G.ufo.x, UFO_Y, 34, [PAL.must, PAL.cream, PAL.teal, PAL.brick, PAL.coral], { speed: 320, life: 1.6 });
          ring(G.ufo.x, UFO_Y, 60, PAL.cream, 0.45); addScore(pts, G.ufo.x, UFO_Y - 20); G.shake = Math.max(G.shake, 4);
          G.ufo = null; G.ufoT = 18 + Math.random() * 10; hit = true; break;
        }
        for (let j = G.bombs.length - 1; j >= 0; j--) {
          const b = G.bombs[j];
          if (Math.abs(b.x - bl.x) < 9 && Math.abs(b.y - bl.y) < 14) { confetti(b.x, b.y, 8, [PAL.coral, PAL.cream], { speed: 140, life: 0.6 }); ring(b.x, b.y, 22, PAL.coral, 0.25); G.bombs.splice(j, 1); hit = true; break; }
        }
      }
      if (hit) { G.bullet = null; confetti(bl.x, bl.y, 3, PAL.cream, { speed: 80, life: 0.4 }); }
      else if (bl.y < -10) G.bullet = null;
    }

    // --- formation
    G.fTimer += dt;
    const ivl = stepInterval(G.count, G.wave);
    if (G.fTimer >= ivl) { G.fTimer -= ivl; if (G.fTimer > ivl) G.fTimer = 0; formationStep(); }

    // --- bombs
    if (!G.over) {
      G.bombT -= dt;
      if (G.bombT <= 0 && G.bombs.length < BOMB_MAX[G.wave] && G.count > 0) {
        spawnBomb(); G.bombT = BOMB_GAP[G.wave] * (0.55 + Math.random() * 0.9);
      }
    }
    for (let i = G.bombs.length - 1; i >= 0; i--) {
      const b = G.bombs[i]; b.y += BOMB_V[G.wave] * dt;
      let gone = false;
      for (const bk of G.bunkers) {
        if (bk.hasAt(b.x - 2, b.y + 8) || bk.hasAt(b.x + 2, b.y + 8) || bk.hasAt(b.x, b.y + 4)) { bk.bite(b.x, b.y + 8, 11); confetti(b.x, b.y + 8, 9, [PAL.sage, PAL.coral], { angle: -Math.PI / 2, spread: 1.6, speed: 170, life: 0.8 }); gone = true; break; }
      }
      if (!gone && G.pAlive && G.invuln <= 0 && !G.over && b.y + 8 > PLAYER_Y - 26 && b.y - 8 < PLAYER_Y + 16 && Math.abs(b.x - G.px) < PLAYER_HALF + 4) { gone = true; hitPlayer(); }
      else if (!gone && b.y > GROUND_Y - 8) { confetti(b.x, GROUND_Y - 4, 7, [PAL.coral, PAL.cream, PAL.must], { angle: -Math.PI / 2, spread: 1.1, speed: 150, life: 0.7 }); gone = true; }
      if (gone) G.bombs.splice(i, 1);
    }

    // --- UFO
    if (G.ufo) {
      G.ufo.x += G.ufo.vx * dt;
      if (G.ufo.x < -50 || G.ufo.x > FW + 50) { G.ufo = null; G.ufoT = 16 + Math.random() * 10; }
    } else {
      G.ufoT -= dt;
      if (G.ufoT <= 0 && G.count > 6) { const d = Math.random() < 0.5 ? 1 : -1; G.ufo = { x: d > 0 ? -40 : FW + 40, px: d > 0 ? -40 : FW + 40, vx: d * (150 + G.wave * 10) }; }
    }

    // --- wave clear
    if (G.count === 0 && !G.over) {
      confetti(FW / 2, 200, 50, CONF, { speed: 420, life: 2, g: 260 });
      for (const b of G.bombs) confetti(b.x, b.y, 5, PAL.coral, { speed: 100, life: 0.6 });
      G.bombs.length = 0; G.bullet = null;
      if (G.wave === 2) endGame(true, '');
      else { G.state = 'clear'; G.stateT = 0; }
    }
  };

  G.hud = () => ({ score: String(G.score).replace(/\B(?=(\d{3})+(?!\d))/g, ' '), detail: `Wave ${Math.min(3, G.wave + 1)}/3 · ${Math.max(0, G.lives)} ${G.lives === 1 ? 'life' : 'lives'}` });
  G.result = () => G.won ? `Cleared all 3 waves with ${G.lives} ${G.lives === 1 ? 'life' : 'lives'} left`
    : (G.endReason || 'Overrun') + ` · ${G.kills} invaders down`;
  { const r0 = G.result; G.result = () => r0() + ` (${G.style})`; }

  // ------------------------------------------------------------------ drawing
  function paperPattern(ctx) {
    if (G.pattern && G.patternCtxOk) return G.pattern;
    const c = document.createElement('canvas'); c.width = c.height = 160;
    const g = c.getContext('2d');
    for (let i = 0; i < 2600; i++) {
      g.fillStyle = Math.random() < 0.5 ? 'rgba(255,250,225,0.05)' : 'rgba(0,0,0,0.06)';
      g.fillRect(Math.random() * 160, Math.random() * 160, 1 + Math.random() * 1.5, 1 + Math.random() * 1.5);
    }
    g.lineCap = 'round';
    for (let i = 0; i < 90; i++) {
      g.strokeStyle = Math.random() < 0.5 ? 'rgba(255,250,225,0.05)' : 'rgba(0,0,0,0.05)'; g.lineWidth = 0.7;
      const x = Math.random() * 160, y = Math.random() * 160, a = Math.random() * TAU, l = 3 + Math.random() * 7;
      g.beginPath(); g.moveTo(x, y); g.lineTo(x + Math.cos(a) * l, y + Math.sin(a) * l); g.stroke();
    }
    G.pattern = c; G.patternCtxOk = true; return c;
  }
  function ridge(g, x0, x1, base, amp, f1, f2, ph, col, shadowUp) {
    const path = (dy) => {
      g.beginPath(); g.moveTo(x0, 2000);
      for (let x = x0; x <= x1 + 24; x += 24) g.lineTo(x, base + dy + amp * Math.sin(x * f1 + ph) + amp * 0.5 * Math.sin(x * f2 + ph * 2.3));
      g.lineTo(x1 + 24, 2000); g.closePath();
    };
    if (shadowUp) { g.fillStyle = 'rgba(0,0,0,0.14)'; path(-9); g.fill(); g.fillStyle = 'rgba(0,0,0,0.18)'; path(-4); g.fill(); }
    g.fillStyle = col; path(0); g.fill();
  }
  function scallop(g, x0, x1, y, r, col, bottom) {
    g.fillStyle = col; g.beginPath(); g.moveTo(x0, bottom);
    g.lineTo(x0, y);
    for (let x = x0; x < x1 + r * 2; x += r * 2) g.arc(x + r, y, r, Math.PI, 0);
    g.lineTo(x1 + r * 2, bottom); g.closePath(); g.fill();
  }
  function paintBg(g, W, H) {
    const s = G.s, ox = G.ox0, oy = G.oy0;
    g.save(); g.translate(ox, oy); g.scale(s, s);
    const x0 = -ox / s - 10, x1 = (W - ox) / s + 10, y0 = -oy / s - 10, y1 = (H - oy) / s + 10;
    const sky = g.createLinearGradient(0, y0, 0, 700);
    sky.addColorStop(0, '#0a2a31'); sky.addColorStop(0.55, '#0d3640'); sky.addColorStop(1, '#0f434a');
    g.fillStyle = sky; g.fillRect(x0, y0, x1 - x0, y1 - y0 + 400);
    // paper moon rising behind the hills
    g.fillStyle = 'rgba(0,0,0,0.2)'; g.beginPath(); g.arc(506, 606, 74, 0, TAU); g.fill();
    g.fillStyle = 'rgba(232,214,160,0.34)'; g.beginPath(); g.arc(500, 600, 74, 0, TAU); g.fill();
    g.fillStyle = 'rgba(190,170,120,0.2)'; for (const [cx, cy, r] of [[478, 580, 14], [524, 612, 10], [492, 628, 7]]) { g.beginPath(); g.arc(cx, cy, r, 0, TAU); g.fill(); }
    ridge(g, x0, x1, 578, 26, 0.0075, 0.021, 1.0, '#11454c', true);
    ridge(g, x0, x1, 622, 22, 0.0095, 0.027, 3.1, '#145157', true);
    ridge(g, x0, x1, 656, 14, 0.012, 0.034, 5.2, '#1a6460', true);
    // grass strip and brick-red ground, torn-paper layered
    g.fillStyle = 'rgba(0,0,0,0.25)'; scallop(g, x0, x1, GROUND_Y - 6, 17, 'rgba(0,0,0,0.25)', y1 + 400);
    scallop(g, x0, x1, GROUND_Y - 2, 17, '#25796a', y1 + 400);
    g.fillStyle = 'rgba(0,0,0,0.3)'; g.fillRect(x0, GROUND_Y + 12, x1 - x0, 5);
    g.fillStyle = '#8a3b2b'; g.fillRect(x0, GROUND_Y + 14, x1 - x0, y1 - GROUND_Y + 400);
    g.strokeStyle = 'rgba(243,231,201,0.55)'; g.lineWidth = 2; g.setLineDash([9, 8]);
    g.beginPath(); g.moveTo(x0, GROUND_Y + 28); g.lineTo(x1, GROUND_Y + 28); g.stroke(); g.setLineDash([]);
    g.restore();
    // paper fibre
    const pat = g.createPattern(paperPattern(g), 'repeat');
    g.fillStyle = pat; g.fillRect(0, 0, W, H);
  }

  function drawStar(g, x, y, r, rot) {
    g.beginPath();
    for (let i = 0; i < 8; i++) { const a = rot + i * Math.PI / 4, rad = i % 2 ? r * 0.32 : r; g.lineTo(x + Math.cos(a) * rad, y + Math.sin(a) * rad); }
    g.closePath(); g.fill();
  }
  function paperTag(g, x, y, w, h, text, fill, tc, font) {
    g.save(); g.translate(x, y);
    g.fillStyle = SHADOW; roundRect(g, -w / 2 + 2, -h / 2 + 3, w, h, 6); g.fill();
    g.fillStyle = fill; roundRect(g, -w / 2, -h / 2, w, h, 6); g.fill();
    g.fillStyle = 'rgba(255,255,240,0.25)'; g.fillRect(-w / 2 + 4, -h / 2 + 1.5, w - 8, 1.5);
    g.fillStyle = tc; g.font = font || '600 17px Fredoka, "Trebuchet MS", sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText(text, 0, 1); g.restore();
  }

  function rocket(g, x, y, tilt, lift, recoil, mini) {
    const pass = (sh) => {
      const C = sh ? () => SHADOW : k => PAL[k];
      g.save(); if (sh) g.translate(2.6, 3.6);
      // craft stick
      roundRect(g, -31, 21, 62, 11, 5.5); g.fillStyle = C('stick'); g.fill();
      if (!sh) {
        g.strokeStyle = 'rgba(184,138,82,0.6)'; g.lineWidth = 1;
        for (const gy of [24.5, 28, 30]) { g.beginPath(); g.moveTo(-26, gy); g.quadraticCurveTo(0, gy + 0.8, 26, gy - 0.4); g.stroke(); }
      }
      g.save(); g.translate(0, 20); g.rotate(tilt); g.translate(0, -20 + recoil * 2.5);
      // fins
      g.fillStyle = C('must');
      g.beginPath(); g.moveTo(-9, 2); g.lineTo(-21, 20); g.lineTo(-9, 18); g.closePath(); g.fill();
      g.beginPath(); g.moveTo(9, 2); g.lineTo(21, 20); g.lineTo(9, 18); g.closePath(); g.fill();
      // body
      g.fillStyle = C('cream'); g.beginPath(); g.moveTo(-10, 21); g.lineTo(-10, -4); g.bezierCurveTo(-10, -18, -4, -26, 0, -31); g.bezierCurveTo(4, -26, 10, -18, 10, -4); g.lineTo(10, 21); g.closePath(); g.fill();
      if (!sh) {
        g.fillStyle = PAL.brick; g.beginPath(); g.moveTo(-8.2, -12); g.bezierCurveTo(-6, -20, -3, -25, 0, -31); g.bezierCurveTo(3, -25, 6, -20, 8.2, -12); g.quadraticCurveTo(0, -8, -8.2, -12); g.fill();
        g.fillStyle = PAL.cream2; g.fillRect(-10, 14, 20, 7);
        g.fillStyle = PAL.must; g.fillRect(-10, 9, 20, 3);
        dot(g, 0, 0, 5.4, PAL.cream2); dot(g, 0, 0, 4, PAL.tealD); dot(g, -1.2, -1.2, 1.2, '#7fd0c4');
      }
      g.restore();
      g.restore();
    };
    g.save(); g.translate(x, y + lift); if (mini) g.scale(mini, mini);
    pass(true); pass(false);
    g.restore();
  }
  function ufoShape(g, x, y, rt, vx) {
    const pass = (sh) => {
      g.save(); g.translate(x + (sh ? 3 : 0), y + (sh ? 5 : 0)); g.rotate(Math.sin(rt * 5) * 0.06);
      g.fillStyle = sh ? SHADOW : PAL.teal; g.beginPath(); g.ellipse(0, -4, 12, 12, 0, Math.PI, 0); g.fill();
      g.fillStyle = sh ? SHADOW : PAL.must; g.beginPath(); g.ellipse(0, 3, 29, 9, 0, 0, TAU); g.fill();
      if (!sh) {
        g.fillStyle = PAL.must2; g.beginPath(); g.ellipse(0, 7, 24, 4.5, 0, 0, Math.PI); g.fill();
        g.fillStyle = 'rgba(255,255,230,0.5)'; g.beginPath(); g.ellipse(-4, -8, 4, 3, -0.5, 0, TAU); g.fill();
        for (let i = -2; i <= 2; i++) dot(g, i * 10, 3, 2.3, ((Math.floor(rt * 6) + i) & 1) ? PAL.cream : PAL.brick);
      }
      g.restore();
    };
    pass(true); pass(false);
  }
  function bombShape(g, b, a, rt) {
    const y = lerpv(b.py, b.y, a);
    const fl = Math.floor((y + b.ph * 10) / 7) & 1;
    for (let pass = 0; pass < 2; pass++) {
      g.save(); g.translate(b.x + (pass ? 0 : 2.2), y + (pass ? 0 : 3.4));
      g.strokeStyle = pass ? PAL.coral : SHADOW; g.lineWidth = 5; g.lineJoin = 'round'; g.lineCap = 'round';
      g.beginPath(); const sg = fl ? 1 : -1;
      g.moveTo(0, -10); g.lineTo(4 * sg, -5); g.lineTo(-4 * sg, 0); g.lineTo(4 * sg, 5); g.lineTo(0, 10); g.stroke();
      if (pass) { g.strokeStyle = PAL.cream; g.lineWidth = 1.5; g.globalAlpha = 0.85; g.stroke(); g.globalAlpha = 1; }
      g.restore();
    }
  }

  G.draw = function (ctx, W, H) {
    const a = A();
    const rt = G.time - (1 - a) * DT;
    const base = ctx.getTransform();
    const dpr = Math.min(2, base.a || 1);
    // cached background
    const key = W + 'x' + H + '@' + dpr;
    if (!G.bg || G.bgKey !== key) {
      if (!G.bg) G.bg = document.createElement('canvas');
      G.bg.width = Math.ceil(W * dpr); G.bg.height = Math.ceil(H * dpr);
      const g = G.bg.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0); paintBg(g, W, H); G.bgKey = key;
    }
    ctx.drawImage(G.bg, 0, 0, W, H);
    // sprites (rebuilt when on-screen scale changes)
    const sc = Math.max(0.5, (base.a || 1) * G.s);
    if (!G.sprites || Math.abs(sc - G.spriteSc) / sc > 0.06) { G.sprites = buildSprites(sc); G.spriteSc = sc; }

    const shk = G.shake;
    ctx.save();
    ctx.translate(G.ox0 + (Math.random() - 0.5) * shk * G.s * 0.6, G.oy0 + (Math.random() - 0.5) * shk * G.s * 0.6);
    ctx.scale(G.s, G.s);
    const x0 = -G.ox0 / G.s, x1 = (W - G.ox0) / G.s, y0 = -G.oy0 / G.s;

    // stars + clouds
    ctx.fillStyle = PAL.cream;
    for (const st of G.stars) {
      if (st.x < x0 - 20 || st.x > x1 + 20 || st.y < y0 - 20) continue;
      const tw = 0.55 + 0.45 * Math.sin(rt * 1.4 + st.ph);
      ctx.globalAlpha = 0.22 + 0.4 * tw; ctx.fillStyle = st.hue;
      drawStar(ctx, st.x, st.y, st.r * (0.8 + 0.3 * tw), rt * 0.15 + st.ph);
    }
    ctx.globalAlpha = 1;
    for (const c of G.clouds) {
      const span = (x1 - x0) + 500;
      const cx = x0 - 250 + (((c.x - rt * c.v) % span) + span) % span;
      ctx.fillStyle = 'rgba(243,231,201,0.07)';
      ctx.beginPath(); ctx.arc(cx, c.y, 22 * c.s, Math.PI, 0); ctx.arc(cx + 26 * c.s, c.y - 6 * c.s, 28 * c.s, Math.PI, 0); ctx.arc(cx + 58 * c.s, c.y, 20 * c.s, Math.PI, 0); ctx.lineTo(cx - 22 * c.s, c.y); ctx.fill();
    }

    // bunkers
    for (const b of G.bunkers) b.draw(ctx, G.state === 'intro' ? clamp((G.stateT - 0.3) / 1.0, 0, 1) : 1);

    // UFO
    if (G.ufo) { const ux = lerpv(G.ufo.px, G.ufo.x, a); ufoShape(ctx, ux, UFO_Y, rt, G.ufo.vx); }

    // invaders
    if (G.state !== 'lost' || true) {
      const drop = G.state === 'intro' ? -(1 - G.introDrop) * 360 : 0;
      const age = rt - G.fStepAt, hop = age >= 0 && age < 0.16 ? Math.sin(Math.PI * age / 0.16) : 0;
      const frame = G.fFrame;
      const spW = SPR_W, spH = SPR_H;
      for (let i = 0; i < 55; i++) {
        if (!G.inv[i]) continue;
        const c = i % COLS, r = (i / COLS) | 0;
        const type = r === 0 ? 0 : r < 3 ? 1 : 2;
        const spr = G.sprites[type][frame];
        const bob = Math.sin(rt * 2.2 + c * 0.6 + r) * 0.8;
        const sq = 1 + hop * 0.06;
        ctx.save();
        ctx.translate(invX(c), invY(r) + drop - hop * 3.5 + bob);
        ctx.scale(sq, 1 / sq);
        ctx.drawImage(spr, -spW / 2, -spH / 2, spW, spH);
        ctx.restore();
      }
    }

    // bombs and bullet
    for (const b of G.bombs) bombShape(ctx, b, a, rt);
    if (G.bullet) {
      const by = lerpv(G.bullet.py, G.bullet.y, a);
      ctx.fillStyle = SHADOW; roundRect(ctx, G.bullet.x - 2 + 2.2, by - 9 + 3.4, 5, 18, 2.5); ctx.fill();
      ctx.fillStyle = PAL.cream; roundRect(ctx, G.bullet.x - 2.5, by - 9, 5, 18, 2.5); ctx.fill();
      ctx.fillStyle = PAL.must; roundRect(ctx, G.bullet.x - 2.5, by + 2, 5, 7, 2.5); ctx.fill();
    }

    // player
    if (G.state === 'won') {
      const lf = Math.max(0, G.lifted - 0.6);
      const yy = PLAYER_Y - lf * lf * 450;
      if (yy > -120) rocket(ctx, G.px, yy, Math.sin(rt * 20) * 0.03 * Math.min(1, lf), 0, 0);
    } else if (G.pAlive) {
      if (G.invuln > 0 && Math.floor(rt * 12) % 2 === 0) ctx.globalAlpha = 0.35;
      rocket(ctx, lerpv(G.ppx, G.px, a), PLAYER_Y, G.tilt, 0, G.recoil);
      ctx.globalAlpha = 1;
    }

    // rings, confetti, tags
    for (const r of G.rings) {
      const t = (r.life + a * DT * 0) / r.max, e = ease.outCubic(clamp(t, 0, 1));
      ctx.globalAlpha = (1 - t) * 0.8; ctx.strokeStyle = r.col; ctx.lineWidth = 3 * (1 - t) + 0.5;
      ctx.beginPath(); ctx.arc(r.x, r.y, r.r1 * e, 0, TAU); ctx.stroke();
    }
    ctx.globalAlpha = 1;
    for (const p of G.conf) {
      const t = p.life / p.max;
      const x = lerpv(p.px, p.x, a), y = lerpv(p.py, p.y, a);
      ctx.save(); ctx.translate(x, y); ctx.rotate(p.rot + 0);
      const flip = Math.abs(Math.cos(p.life * 8 + p.ph));
      ctx.globalAlpha = t > 0.65 ? (1 - t) / 0.35 : 1;
      ctx.fillStyle = 'rgba(0,0,0,0.3)'; ctx.fillRect(-p.w / 2 + 1.2, -p.h * flip / 2 + 1.8, p.w, Math.max(0.8, p.h * flip));
      ctx.fillStyle = p.col; ctx.fillRect(-p.w / 2, -p.h * flip / 2, p.w, Math.max(0.8, p.h * flip));
      ctx.restore();
    }
    ctx.globalAlpha = 1;
    for (const t of G.tags) {
      const k = t.life / t.max; ctx.globalAlpha = k > 0.7 ? (1 - k) / 0.3 : 1;
      const pop = ease.outBack(clamp(k * 5, 0, 1));
      ctx.save(); ctx.translate(t.x, t.y); ctx.scale(pop, pop);
      paperTag(ctx, 0, 0, 52, 24, t.text, PAL.cream, PAL.brick2, '600 15px Fredoka, sans-serif'); ctx.restore();
    }
    ctx.globalAlpha = 1;

    // in-world HUD: score tag, wave tag, spare rockets (top of field)
    paperTag(ctx, 110, 28, 168, 32, 'SCORE  ' + String(G.score).padStart(5, '0'), PAL.must, PAL.tealD);
    paperTag(ctx, FW / 2, 28, 130, 32, 'WAVE ' + Math.min(3, G.wave + 1) + ' / 3', PAL.cream, PAL.brick2);
    for (let i = 0; i < 3; i++) {
      if (i >= G.lives) { ctx.globalAlpha = 0.2; }
      rocket(ctx, FW - 150 + i * 44 + 22, 14, 0, 0, 0, 0.5);
      ctx.globalAlpha = 1;
    }

    // banners
    const ban = (text, sub, fill, tc, t, dur) => {
      const k = clamp(t / 0.4, 0, 1), out = clamp((dur - t) / 0.35, 0, 1);
      const w = 560 * ease.outBack(k);
      ctx.save(); ctx.globalAlpha = out; ctx.translate(FW / 2, 330); ctx.rotate(-0.02);
      ctx.fillStyle = SHADOW; ctx.fillRect(-w / 2 + 4, -44 + 7, w, 92);
      ctx.fillStyle = fill; ctx.fillRect(-w / 2, -44, w, 92);
      ctx.fillStyle = 'rgba(0,0,0,0.12)'; ctx.fillRect(-w / 2, 40, w, 8);
      ctx.fillStyle = tc; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      if (k > 0.5) {
        ctx.font = '600 52px Fredoka, "Trebuchet MS", sans-serif'; ctx.fillText(text, 0, -6);
        ctx.font = '500 18px Fredoka, sans-serif'; ctx.globalAlpha = out * 0.8; ctx.fillText(sub, 0, 28);
      }
      ctx.restore();
    };
    if (G.state === 'intro') ban('WAVE ' + (G.wave + 1), G.wave === 0 ? 'Here they come' : G.wave === 1 ? 'They start lower and march faster' : 'Final wave', PAL.must, PAL.tealD, G.stateT, 2.1);
    else if (G.state === 'clear') ban('WAVE CLEARED', 'Fresh paper for the bunkers', PAL.cream, PAL.brick2, G.stateT, 1.9);
    else if (G.state === 'won') ban('ALL CLEAR', 'The sky is quiet again', PAL.cream, PAL.teal, Math.max(0, G.stateT - 0.2), 3.4);
    ctx.restore();

    // flash / vignette
    if (G.flash > 0) { ctx.fillStyle = `rgba(255,120,80,${G.flash * 0.22})`; ctx.fillRect(0, 0, W, H); }
    if (G.state === 'lost') { ctx.fillStyle = `rgba(20,5,5,${Math.min(0.4, G.stateT * 0.25)})`; ctx.fillRect(0, 0, W, H); }
  };

  return G;
}

Arcade.register({
  id: 'invaders', name: 'Paper Invaders', genre: 'Space invaders',
  aiNote: "Sees the formation, bombs, UFO and bunkers, infers the march timing by watching, and reacts 66 ms late with a ship capped at 340 units a second.",
  blurb: 'Cut-paper critters march on a craft-stick rocket. Hold the bunkers.',
  bg: '#0d3640', accent: '#e7a92f', create,
});
})();
