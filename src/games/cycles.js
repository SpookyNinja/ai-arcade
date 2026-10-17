(() => {
'use strict';
// =====================================================================================
// Afterglow Arena — light-cycle duel. Autopilot vs 3 house bots on a square neon grid.
// Every cycle leaves a solid wall; turns are 90 degrees only; last one alive wins the round,
// first to 3 round wins takes the match. The arena slowly collapses from its rim (tight space),
// speed is capped at a pace the AI's turn limit can handle, bots get smarter every round.
// Sections: 1) constants  2) Pilot (the Autopilot brain)  3) house bots  4) game + drawing
// =====================================================================================

// ------------------------------------------------------------------ 1. constants
const G = 40, N = G * G;
const DX = [1, 0, -1, 0], DY = [0, 1, 0, -1]; // 0=E 1=S 2=W 3=N
const WALL = 250, PENDING = 251;
const CYC = [
  { name: 'AUTOPILOT', main: '#27e7ff', hi: '#dcfcff', rgb: '39,231,255' },
  { name: 'PULSE', main: '#ff3bbd', hi: '#ffd9f1', rgb: '255,59,189' },
  { name: 'VIPER', main: '#a6ff2e', hi: '#f0ffd0', rgb: '166,255,46' },
  { name: 'EMBER', main: '#ffb02a', hi: '#fff0d0', rgb: '255,176,42' },
];
const Q = Math.round(G * 0.22);
const SLOTS = [[Q, Q, 0], [G - 1 - Q, Q, 1], [G - 1 - Q, G - 1 - Q, 2], [Q, G - 1 - Q, 3]];
const V_MAX = 15.5;          // cells/s cap: with a 0.10 s turn limit the AI can still turn every 2nd cell
const WIN_ROUNDS = 3;
const COLLAPSE_FIRST = 22, COLLAPSE_EVERY = 6, COLLAPSE_WARN = 3, MIN_INNER = 10;
const NBR = (() => { // neighbour table, -1 = outside
  const a = new Int16Array(N * 4);
  for (let y = 0; y < G; y++) for (let x = 0; x < G; x++) for (let d = 0; d < 4; d++) {
    const nx = x + DX[d], ny = y + DY[d];
    a[(y * G + x) * 4 + d] = nx < 0 || ny < 0 || nx >= G || ny >= G ? -1 : ny * G + nx;
  }
  return a;
})();
const ringIdx = (x, y) => Math.min(x, y, G - 1 - x, G - 1 - y);
const baseSpeed = (t, round) => {
  const v0 = 10.5 + 0.5 * Math.min(round, 4);
  return v0 + (V_MAX - v0) * Math.min(1, t / 70);
};

// ------------------------------------------------------------------ 2. Pilot
// The Autopilot brain. It sees ONLY the observe() snapshot: the grid (who owns each cell, the
// collapse ring including its red warning), each cycle's visible head cell + direction, its own
// turn cooldown. Search: depth-limited lookahead over its own moves (straight/left/right, respecting
// the turn-rate limit), rivals predicted to continue straight (or turn if blocked), leaf scored by a
// Voronoi territory flood fill (cells I reach strictly before any rival) with a wall-hug tie-break.
class Pilot {
  constructor(cfg) {
    this.cfg = cfg; this.W = new Uint8Array(N); this.lab = new Uint8Array(N); this.q = new Int16Array(N);
    this.EX = new Int16Array(48); this.EY = new Int16Array(48); this.ED = new Int8Array(48); this.EA = new Uint8Array(48);
    this.U = []; for (let i = 0; i < 10; i++) this.U.push(new Int16Array(8));
    this.ne = 0; this.D = cfg.depth; this.cellT = 0.07; this.bestM = 0; this.cnt = new Int32Array(8);
  }
  decide(o) {
    const cfg = this.cfg, W = this.W;
    W.set(o.grid);
    this.ne = o.others.length; this.cellT = o.cellT;
    for (let k = 0; k < this.ne; k++) { const e = o.others[k]; this.EX[k] = e.x; this.EY[k] = e.y; this.ED[k] = e.dir; this.EA[k] = e.alive ? 1 : 0; }
    this.D = cfg.depth;
    // fewer plies when many cells are free of rivals' influence is not needed; keep cost bounded instead
    this.bestM = 0;
    this.rec(0, o.me.x, o.me.y, o.me.dir, o.cool, 0);
    return (o.me.dir + this.bestM) & 3;
  }
  headOn(nx, ny) {
    let pen = 0;
    for (let k = 0; k < this.ne; k++) {
      if (!this.EA[k]) continue;
      const ex = this.EX[k], ey = this.EY[k], ed = this.ED[k];
      if (ex + DX[ed] === nx && ey + DY[ed] === ny) pen += 900 * this.cfg.fear;
      else if (Math.abs(ex - nx) + Math.abs(ey - ny) === 1) pen += 140 * this.cfg.fear;
    }
    return pen;
  }
  rec(ply, x, y, d, cool, hug) {
    if (ply >= this.D) return this.leaf(x, y, hug);
    const W = this.W, cfg = this.cfg; let best = -1e9;
    for (let mi = 0; mi < 3; mi++) {
      const m = mi === 0 ? 0 : mi === 1 ? 3 : 1;
      if (m && cool > 0.0005) continue;
      const nd = (d + m) & 3, ci = NBR[(y * G + x) * 4 + nd];
      let sc;
      if (ci < 0 || W[ci]) sc = -10000 + ply * 80;
      else {
        const nx = x + DX[nd], ny = y + DY[nd];
        let hb = 0; for (let k = 0; k < 4; k++) { const j = NBR[ci * 4 + k]; if (j < 0 || W[j]) hb++; }
        const pen = ply === 0 ? this.headOn(nx, ny) : 0;
        const U = this.U[ply]; W[ci] = 7; U[0] = ci; let un = 1;
        const a = ply * 4, b = a + 4;
        for (let k = 0; k < this.ne; k++) {
          if (!this.EA[a + k]) { this.EA[b + k] = 0; continue; }
          let ex = this.EX[a + k], ey = this.EY[a + k], ed = this.ED[a + k];
          let ei = NBR[(ey * G + ex) * 4 + ed];
          if (ei < 0 || W[ei]) {
            const t1 = (ed + 1 + (k & 1) * 2) & 3, t2 = (ed + 3 - (k & 1) * 2) & 3;
            const i1 = NBR[(ey * G + ex) * 4 + t1], i2 = NBR[(ey * G + ex) * 4 + t2];
            if (i1 >= 0 && !W[i1]) { ed = t1; ei = i1; } else if (i2 >= 0 && !W[i2]) { ed = t2; ei = i2; } else ei = -1;
          }
          if (ei < 0) { this.EA[b + k] = 0; continue; }
          W[ei] = 8; U[un++] = ei;
          this.EX[b + k] = ei % G; this.EY[b + k] = (ei / G) | 0; this.ED[b + k] = ed; this.EA[b + k] = 1;
        }
        const ncool = (m ? cfg.interval : cool) - this.cellT;
        sc = this.rec(ply + 1, nx, ny, nd, ncool, hug + hb) - pen;
        for (let k = 0; k < un; k++) W[U[k]] = 0;
      }
      if (ply === 0) { sc += Math.random() * cfg.noise; if (sc > best) this.bestM = m; }
      if (sc > best) best = sc;
    }
    return best;
  }
  leaf(x, y, hug) {
    const W = this.W, lab = this.lab, q = this.q, cnt = this.cnt, cfg = this.cfg, ne = this.ne;
    lab.fill(0); cnt.fill(0);
    let h = 0, t = 0, minD = 99;
    const a = this.D * 4, me = y * G + x;
    for (let k = 0; k < ne; k++) if (this.EA[a + k]) {
      const i = this.EY[a + k] * G + this.EX[a + k]; lab[i] = 2 + k; q[t++] = i;
      minD = Math.min(minD, Math.abs(this.EX[a + k] - x) + Math.abs(this.EY[a + k] - y));
    }
    lab[me] = 1; q[t++] = me;
    while (h < t) {
      const c = q[h++], l = lab[c]; cnt[l]++;
      for (let d = 0; d < 4; d++) { const j = NBR[c * 4 + d]; if (j >= 0 && !W[j] && !lab[j]) { lab[j] = l; q[t++] = j; } }
    }
    let en = 0; for (let k = 0; k < ne; k++) en += cnt[2 + k];
    // cnt[l] counted sources too; fine (constant offset)
    return cnt[1] - cfg.w * en + cfg.hug * hug - (minD < 99 ? cfg.chase * minD : 0);
  }
}
const PILOT_STYLES = {
  'Territory': { depth: 4, w: 0.3, hug: 1.2, chase: 0, fear: 1 },
  'Hunter': { depth: 4, w: 0.8, hug: 0.6, chase: 1.2, fear: 0.8 },
  'Wall hugger': { depth: 4, w: 0.15, hug: 2.6, chase: 0, fear: 1.2 },
};
const SUPER_CFG = { depth: 5, w: 0.45, hug: 1.6, chase: 0, fear: 1, interval: 0.02, noise: 0.01 };
const NORMAL_BASE = { interval: 0.1, noise: 1.5 };

// ------------------------------------------------------------------ 4. game
function create(opts = {}) {
  const superAI = !!opts.superAI;
  const style = superAI ? 'Super AI' : rnd.pick(Object.keys(PILOT_STYLES));
  const pilot = new Pilot(superAI ? SUPER_CFG : Object.assign({}, NORMAL_BASE, PILOT_STYLES[style]));
  let twist = null;
  if (opts.twist) {
    const tw = typeof opts.twist === 'string' ? TWISTS.find(t => t.key === opts.twist) : null;
    twist = tw || rnd.pick(TWISTS);
  }
  const parts = new Particles();
  const grid = new Uint8Array(N);
  const scratch = new Int16Array(N), mark = new Uint8Array(N);
  let W = 1600, H = 900, L = null, cache = null;

  const cyc = CYC.map((c, i) => ({
    i, ...c, isAI: i === 0, wins: 0, alive: true, x: 0, y: 0, hx: 0, hy: 0, dir: 0, prog: 0, claimed: false,
    pts: [], cells: [], lastTurn: -9, minTurn: i === 0 ? pilot.cfg.interval : 0.08, boost: 0, ghost: 0, phasing: false,
    dx: 0, dy: 0, deadT: 0, derez: 0, bp: null, flash: 0, ghostFlash: 0, trailLen: 0, pending: -1,
  }));
  const S = {
    T: 0, t: 0, state: 'ready', stateT: 0, round: 0, ringK: 0, dispK: 0, ringFlash: 0, shake: 0, zoom: 0,
    lastWinner: -2, intro: 0, boostTimer: 8, over: false, camx: 0, camy: 0, msg: '',
  };
  const rings = [], calls = [];

  function addCall(txt, gx, gy, color, big) { calls.push({ txt, x: gx, y: gy, t: 0, color, big: !!big }); }
  const speedOf = c => baseSpeed(S.t, S.round) * (c.boost > 0 ? 1.2 : 1);

  function startRound() {
    grid.fill(0); S.state = 'ready'; S.stateT = 2.4; S.t = 0; S.ringK = 0; S.dispK = 0; S.boostTimer = rnd.float(6, 10);
    const order = rnd.shuffle([0, 1, 2, 3]);
    for (let s = 0; s < 4; s++) {
      const c = cyc[order[s]], [sx, sy, sd] = SLOTS[s];
      c.alive = true; c.x = c.hx = sx; c.y = c.hy = sy; c.dir = sd; c.prog = 0; c.claimed = false;
      c.pts = [[sx, sy]]; c.cells = [sy * G + sx]; c.lastTurn = -9; c.boost = 0; c.ghost = 0; c.phasing = false;
      c.deadT = 0; c.derez = 0; c.flash = 0; c.ghostFlash = 0; c.pending = -1;
      grid[sy * G + sx] = c.i + 1;
      if (!c.isAI) {
        const r = S.round;
        c.bp = { look: clamp(Math.floor(2 + r * 0.8 + rnd.float(0, 1.2)), 2, 6), smart: clamp(0.15 + r * 0.22, 0, 0.95), wander: rnd.float(0.015, 0.05), chase: rnd.float(0.05, 0.3) };
        if (twist && twist.key === 'ghost' && S.ghostPick.includes(c.i)) c.ghost = 1;
      }
    }
    parts.list.length = 0; rings.length = 0;
  }
  function pickGhosts() { S.ghostPick = rnd.shuffle([1, 2, 3]).slice(0, 1); }

  const free = (x, y) => x >= 0 && y >= 0 && x < G && y < G && grid[y * G + x] === 0;
  function runLen(x, y, d, max) { let n = 0; while (n < max) { x += DX[d]; y += DY[d]; if (!free(x, y)) break; n++; } return n; }
  function flood(x, y, cap) {
    mark.fill(0); let h = 0, t = 0; const s = y * G + x; if (grid[s]) return 0;
    scratch[t++] = s; mark[s] = 1;
    while (h < t && t < cap) {
      const c = scratch[h++];
      for (let d = 0; d < 4; d++) { const j = NBR[c * 4 + d]; if (j >= 0 && !grid[j] && !mark[j]) { mark[j] = 1; scratch[t++] = j; } }
    }
    return t;
  }

  // ---- 3. house bots: wall-avoid + random turns + light chasing (each bot sees the whole grid; they are the game's opponents)
  function botDecide(c) {
    const p = c.bp, d = c.dir;
    const canTurn = S.t - c.lastTurn >= c.minTurn;
    const ahead = runLen(c.x, c.y, d, p.look + 1);
    if (!canTurn) return d;
    const opts = [];
    for (const m of [1, 3]) {
      const nd = (d + m) & 3, run = runLen(c.x, c.y, nd, 14);
      let sc = Math.min(run, 14);
      if (run > 0 && Math.random() < p.smart) sc += flood(c.x + DX[nd], c.y + DY[nd], 140) * 0.35;
      opts.push({ nd, run, sc: sc + Math.random() * 2 });
    }
    opts.sort((a, b) => b.sc - a.sc);
    // ghost bots: take the wall (once) when boxed in or at random when the wall is thin
    if (c.ghost > 0 && ahead === 0) {
      const bx = c.x + DX[d] * 2, by = c.y + DY[d] * 2;
      const wl = grid[(c.y + DY[d]) * G + c.x + DX[d]] ;
      if (wl >= 1 && wl <= 4 && free(bx, by) && (opts[0].run < 5 || Math.random() < 0.5)) return d;
    }
    if (ahead < p.look) return opts[0].run > ahead || ahead === 0 ? opts[0].nd : d;
    if (Math.random() < p.wander && opts[0].run >= 5) return opts[0].nd;
    if (Math.random() < p.chase * 0.1) { // light chasing: lean toward the nearest rival head
      let bd = 99, bx = 0, by = 0;
      for (const o of cyc) if (o !== c && o.alive) { const dd = Math.abs(o.hx - c.x) + Math.abs(o.hy - c.y); if (dd < bd) { bd = dd; bx = o.hx; by = o.hy; } }
      if (bd < 16) for (const o of opts) {
        if (o.run >= 4 && Math.abs(bx - (c.x + DX[o.nd])) + Math.abs(by - (c.y + DY[o.nd])) < bd) return o.nd;
      }
    }
    return d;
  }

  function observe(c) {
    const g = grid.slice();
    if (pendingActive()) for (let i = 0; i < N; i++) if (!g[i] && ringIdx(i % G, (i / G) | 0) === S.ringK) g[i] = PENDING;
    return {
      grid: g, cellT: 1 / speedOf(c), cool: c.minTurn - (S.t - c.lastTurn),
      me: { x: c.x, y: c.y, dir: c.dir },
      others: cyc.filter(o => o !== c).map(o => ({ x: o.hx, y: o.hy, dir: o.dir, alive: o.alive })),
    };
  }
  const nextCollapseAt = () => COLLAPSE_FIRST + S.ringK * COLLAPSE_EVERY;
  const pendingActive = () => G - 2 * S.ringK > MIN_INNER && S.t >= nextCollapseAt() - COLLAPSE_WARN && S.state !== 'ready';

  function crash(c, why) {
    if (!c.alive) return;
    c.alive = false; c.deadT = 0; c.derez = c.cells.length - 1;
    const p = 0.42; c.dx = c.x + DX[c.dir] * p; c.dy = c.y + DY[c.dir] * p;
    if (why === 'crush') { c.dx = c.hx; c.dy = c.hy; }
    const u = (c.dx + 0.5) * L.cs, v = (c.dy + 0.5) * L.cs;
    parts.burst(u, v, 46, { color: [c.main, c.hi, '#fff'], speed: L.cs * 22, speedMin: L.cs * 4, life: 1.1, size: L.cs * 0.28, drag: 1.8 });
    parts.burst(u, v, 20, { color: c.main, speed: L.cs * 9, life: 1.6, size: L.cs * 0.5, drag: 3 });
    rings.push({ x: u, y: v, t: 0, color: c.main });
    S.shake = Math.min(1, S.shake + (c.isAI ? 0.9 : 0.55));
    addCall(c.name + ' DOWN', c.dx, c.dy, c.main);
  }

  function collapse() {
    const k = S.ringK;
    for (let i = 0; i < N; i++) {
      const x = i % G, y = (i / G) | 0;
      if (ringIdx(x, y) === k) {
        if (grid[i] !== 0 || true) {
          grid[i] = WALL;
          if (((x + y) & 1) === 0) parts.burst((x + 0.5) * L.cs, (y + 0.5) * L.cs, 1, { color: '#ff6a3d', speed: L.cs * 6, life: 0.8, size: L.cs * 0.3, angle: Math.atan2(G / 2 - y, G / 2 - x), spread: 0.8 });
        }
      }
    }
    for (const c of cyc) if (c.alive && (ringIdx(c.x, c.y) === k || ringIdx(c.hx, c.hy) === k)) crash(c, 'crush');
    S.ringK++; S.ringFlash = 1; S.shake = Math.min(1, S.shake + 0.25);
  }

  function endRound(winner) {
    S.state = 'roundEnd'; S.stateT = 2.4; S.lastWinner = winner;
    if (winner >= 0) {
      cyc[winner].wins++;
      const c = cyc[winner];
      addCall(winner === 0 ? 'ROUND WON' : c.name + ' TAKES IT', c.hx, c.hy, c.main, true);
    }
    S.round++;
    const best = cyc.reduce((m, c) => (c.wins > m.wins ? c : m), cyc[0]);
    if (best.wins >= WIN_ROUNDS) {
      S.over = true; inst.over = true; inst.won = best.isAI; S.matchWinner = best.i;
      const botBest = Math.max(cyc[1].wins, cyc[2].wins, cyc[3].wins);
      inst.msg = best.isAI ? `Won the match ${cyc[0].wins}–${botBest}` : `Lost the match ${cyc[0].wins}–${best.wins} to ${best.name}`;
    }
  }

  function stepCycles(dt) {
    const alive = cyc.filter(c => c.alive);
    for (const c of alive) {
      c.prog += speedOf(c) * dt;
      if (c.boost > 0) { c.boost -= dt; if (c.boost <= 0) c.boost = 0; }
    }
    // claims (front cell of each cycle at half a cell): same-step same-target claims kill both
    const claims = [];
    for (const c of alive) if (!c.claimed && c.prog >= 0.5) {
      const ni = NBR[(c.y * G + c.x) * 4 + c.dir];
      claims.push({ c, ni });
    }
    for (const a of claims) {
      let dead = a.ni < 0 || (grid[a.ni] !== 0);
      if (!dead) for (const b of claims) if (b !== a && b.ni === a.ni) dead = true;
      if (dead && a.ni >= 0 && a.c.ghost > 0 && grid[a.ni] >= 1 && grid[a.ni] <= 4) {
        const nx = a.c.x + DX[a.c.dir] * 2, ny = a.c.y + DY[a.c.dir] * 2;
        if (free(nx, ny)) { dead = false; a.c.ghost--; a.c.phasing = true; a.c.ghostFlash = 1; addCall('GHOST WALL', a.c.x + DX[a.c.dir], a.c.y + DY[a.c.dir], '#e8f4ff'); }
      }
      a.dead = dead;
    }
    for (const a of claims) {
      const c = a.c;
      if (a.dead) { crash(c, 'wall'); continue; }
      c.claimed = true;
      c.hx = c.x + DX[c.dir]; c.hy = c.y + DY[c.dir];
      if (!c.phasing) grid[a.ni] = c.i + 1;
    }
    // arrivals
    for (const c of alive) {
      if (!c.alive || c.prog < 1) continue;
      c.prog -= 1; c.x = c.hx; c.y = c.hy; c.claimed = false; c.phasing = false; c.cells.push(c.y * G + c.x);
      let nd;
      if (c.isAI) {
        const o = observe(c);
        nd = pilot.decide(o);
        if (c.minTurn > 0 && S.t - c.lastTurn < c.minTurn) nd = c.dir;
      } else nd = botDecide(c);
      if (nd !== c.dir) { c.lastTurn = S.t; c.dir = nd; c.pts.push([c.x, c.y]); }
    }
  }

  function trailPoint(c) {
    // polyline: pts..., head. Returned lazily in draw.
  }

  const inst = {
    over: false, won: false, style, superAI, twist: twist ? { key: twist.key, name: twist.name, desc: twist.desc } : null, msg: '',
    resize(w, h) { W = w; H = h; layout(); },
    step(dt) {
      S.T += dt; parts.update(dt);
      S.shake = Math.max(0, S.shake - dt * 2.2); S.ringFlash = Math.max(0, S.ringFlash - dt * 2);
      S.dispK += (S.ringK - S.dispK) * (1 - Math.exp(-dt * 9));
      S.intro = Math.min(1, S.intro + dt / 1.2);
      for (let i = rings.length - 1; i >= 0; i--) { rings[i].t += dt; if (rings[i].t > 1) rings.splice(i, 1); }
      for (let i = calls.length - 1; i >= 0; i--) { calls[i].t += dt; if (calls[i].t > 1.8) calls.splice(i, 1); }
      for (const c of cyc) {
        c.flash = Math.max(0, c.flash - dt * 3); c.ghostFlash = Math.max(0, c.ghostFlash - dt * 2.5);
        if (!c.alive) {
          c.deadT += dt;
          // trail derezzes from the crash point backwards, spraying sparks
          let n = Math.min(c.derez + 1, Math.ceil(70 * dt));
          while (n-- > 0 && c.derez >= 0) {
            const i = c.cells[c.derez--]; const u = ((i % G) + 0.5) * L.cs, v = (((i / G) | 0) + 0.5) * L.cs;
            parts.burst(u, v, 2, { color: [c.main, c.hi], speed: L.cs * 5, life: 0.7, size: L.cs * 0.2, drag: 3 });
          }
        }
      }
      if (S.over) { S.stateT += dt; return; }
      if (S.T > 460) { // safety cap
        S.over = true; inst.over = true; inst.won = false; inst.msg = 'Out of time'; return;
      }
      if (S.state === 'ready') {
        S.stateT -= dt;
        if (S.stateT <= 0) { S.state = 'run'; S.t = 0; }
        return;
      }
      if (S.state === 'roundEnd') {
        S.stateT -= dt;
        // survivors keep gliding a moment
        if (S.stateT <= 0) startRound();
        return;
      }
      S.t += dt;
      // collapse
      if (S.ringK < 30 && G - 2 * S.ringK > MIN_INNER && S.t >= nextCollapseAt()) collapse();
      // twist events
      if (twist && twist.key === 'overdrive') {
        S.boostTimer -= dt;
        if (S.boostTimer <= 0) {
          S.boostTimer = rnd.float(11, 18);
          const bots = cyc.filter(c => !c.isAI && c.alive && c.boost <= 0);
          if (bots.length) { const c = rnd.pick(bots); c.boost = 3.5; c.flash = 1; addCall('OVERDRIVE', c.x, c.y, c.main, true); }
        }
      }
      stepCycles(dt);
      // overdriven bots shed sparks
      for (const c of cyc) if (c.alive && c.boost > 0 && Math.random() < 0.6) {
        const u = (c.x + DX[c.dir] * c.prog + 0.5) * L.cs, v = (c.y + DY[c.dir] * c.prog + 0.5) * L.cs;
        parts.burst(u, v, 1, { color: [c.hi, c.main], speed: L.cs * 8, life: 0.5, size: L.cs * 0.22, angle: Math.atan2(-DY[c.dir], -DX[c.dir]), spread: 0.7 });
      }
      const alive = cyc.filter(c => c.alive);
      if (alive.length <= 1) {
        if (alive.length === 1) endRound(alive[0].i);
        else { S.state = 'roundEnd'; S.stateT = 2.4; S.lastWinner = -1; addCall('DRAW', G / 2 - 0.5, G / 2, '#ffffff', true); }
      } else if (S.t > 150) { S.state = 'roundEnd'; S.stateT = 2.4; S.lastWinner = -1; for (const c of alive) crash(c, 'wall'); }
    },
    hud() {
      const botBest = Math.max(cyc[1].wins, cyc[2].wins, cyc[3].wins);
      const alive = cyc.filter(c => c.alive).length;
      return { score: `${cyc[0].wins}–${botBest}`, detail: `Round ${Math.min(S.round + (S.state === 'roundEnd' ? 0 : 1), 9)} · ${alive} alive · ${baseSpeed(S.t, S.round).toFixed(0)} cells/s` };
    },
    result() { return inst.msg || 'Match ended'; },
    draw(ctx, w, h) { drawAll(ctx, w, h); },
  };

  // ---- layout + drawing
  function layout() {
    const top = Math.max(0.085 * H, 48), bottom = Math.max(0.09 * H, 70);
    const s = Math.max(100, Math.min(H - top - bottom, W * 0.94));
    L = { S: s, cs: s / G, ax: (W - s) / 2, ay: top + (H - top - bottom - s) / 2, top };
    cache = null;
  }
  const glowSprites = {};
  function glowSprite(c) {
    if (glowSprites[c.i]) return glowSprites[c.i];
    const cv = document.createElement('canvas'); cv.width = cv.height = 128;
    const g = cv.getContext('2d'), gr = g.createRadialGradient(64, 64, 0, 64, 64, 64);
    gr.addColorStop(0, `rgba(${c.rgb},0.9)`); gr.addColorStop(0.25, `rgba(${c.rgb},0.35)`); gr.addColorStop(1, `rgba(${c.rgb},0)`);
    g.fillStyle = gr; g.fillRect(0, 0, 128, 128);
    return (glowSprites[c.i] = cv);
  }
  function buildCache(dpr) {
    const bg = document.createElement('canvas'); bg.width = Math.ceil(W * dpr); bg.height = Math.ceil(H * dpr);
    let g = bg.getContext('2d'); g.scale(dpr, dpr);
    const gr = g.createRadialGradient(W / 2, H / 2, 0, W / 2, H / 2, Math.hypot(W, H) * 0.6);
    gr.addColorStop(0, '#080b18'); gr.addColorStop(0.6, '#03040a'); gr.addColorStop(1, '#010103');
    g.fillStyle = gr; g.fillRect(0, 0, W, H);
    // faint perspective-ish haze lines + dust
    g.strokeStyle = 'rgba(70,120,220,0.04)'; g.lineWidth = 1;
    for (let i = 0; i < 24; i++) { const y = H * (0.5 + 0.5 * Math.pow(i / 24, 2)); g.beginPath(); g.moveTo(0, y); g.lineTo(W, y); g.stroke(); }
    for (let i = 0; i < 90; i++) { g.fillStyle = `rgba(150,190,255,${rnd.float(0.03, 0.12)})`; g.fillRect(rnd.float(0, W), rnd.float(0, H), 1.5, 1.5); }
    const fl = document.createElement('canvas'); fl.width = fl.height = Math.ceil(L.S * dpr);
    g = fl.getContext('2d'); g.scale(dpr, dpr);
    const cs = L.cs, ss = L.S;
    g.fillStyle = '#04060d'; g.fillRect(0, 0, ss, ss);
    const fg = g.createRadialGradient(ss / 2, ss / 2, 0, ss / 2, ss / 2, ss * 0.75);
    fg.addColorStop(0, 'rgba(40,70,140,0.22)'); fg.addColorStop(1, 'rgba(10,20,50,0)');
    g.fillStyle = fg; g.fillRect(0, 0, ss, ss);
    for (let i = 0; i <= G; i++) {
      g.strokeStyle = i % 5 === 0 ? 'rgba(90,150,255,0.17)' : 'rgba(90,150,255,0.065)'; g.lineWidth = i % 5 === 0 ? 1.2 : 1;
      g.beginPath(); g.moveTo(i * cs, 0); g.lineTo(i * cs, ss); g.stroke();
      g.beginPath(); g.moveTo(0, i * cs); g.lineTo(ss, i * cs); g.stroke();
    }
    cache = { bg, fl, dpr, W, H, S: L.S };
  }

  const FONT_D = 'Big Shoulders Display, Impact, sans-serif', FONT_M = '"IBM Plex Mono", monospace';
  function headGrid(c, al) {
    if (!c.alive) return [c.dx, c.dy];
    const p = S.state === 'run' ? Math.min(1, c.prog + speedOf(c) / 60 * al) : c.prog;
    return [c.x + DX[c.dir] * p, c.y + DY[c.dir] * p];
  }

  function drawAll(ctx, w, h) {
    const dpr = Math.min(2, ctx.getTransform().a || 1);
    if (!L) layout();
    if (!cache || cache.dpr !== dpr || cache.W !== W || cache.H !== H || cache.S !== L.S) buildCache(dpr);
    const al = Math.max(0, Math.min(1, Arcade.alpha === undefined ? 1 : Arcade.alpha));
    const T = S.T + (S.over ? 0 : al / 60), cs = L.cs;
    ctx.drawImage(cache.bg, 0, 0, w, h);
    // camera: gentle zoom-in on intro, drift toward the Autopilot, shake
    const me = cyc[0], [mhx, mhy] = headGrid(me, al);
    const tx = (mhx - G / 2) * cs * 0.025, ty = (mhy - G / 2) * cs * 0.025;
    S.camx += (tx - S.camx) * 0.03; S.camy += (ty - S.camy) * 0.03;
    const zi = 1 + 0.07 * (1 - ease.outCubic(S.intro)) + 0.006 * Math.sin(T * 0.4);
    const sh = S.shake * S.shake * cs * 0.7;
    ctx.save();
    ctx.translate(L.ax + L.S / 2 - S.camx + Math.sin(T * 61) * sh, L.ay + L.S / 2 - S.camy + Math.cos(T * 53) * sh);
    ctx.scale(zi, zi); ctx.translate(-L.S / 2, -L.S / 2);
    ctx.drawImage(cache.fl, 0, 0, L.S, L.S);
    // light sweep
    ctx.save(); ctx.globalCompositeOperation = 'lighter';
    const sp = ((T * 0.05) % 1.6 - 0.3) * L.S * 2 - L.S * 0.4;
    const sg = ctx.createLinearGradient(sp, 0, sp + L.S * 0.5, L.S * 0.5);
    sg.addColorStop(0, 'rgba(100,170,255,0)'); sg.addColorStop(0.5, 'rgba(100,170,255,0.045)'); sg.addColorStop(1, 'rgba(100,170,255,0)');
    ctx.fillStyle = sg; ctx.fillRect(0, 0, L.S, L.S);
    // light pools under heads
    for (const c of cyc) if (c.alive) {
      const [hx, hy] = headGrid(c, al), u = (hx + 0.5) * cs, v = (hy + 0.5) * cs, r = cs * (c.boost > 0 ? 9 : 6.5);
      ctx.globalAlpha = 0.33 + 0.25 * c.flash; ctx.drawImage(glowSprite(c), u - r, v - r, r * 2, r * 2);
    }
    ctx.restore();
    // trails
    for (const c of cyc) drawTrail(ctx, c, al, T);
    // collapsed rim
    const k = S.dispK, o = k * cs, e = L.S - o;
    ctx.save();
    ctx.beginPath(); ctx.rect(-4, -4, L.S + 8, L.S + 8); ctx.rect(o, o, e - o, e - o);
    ctx.fillStyle = '#07070d'; ctx.fill('evenodd');
    ctx.clip('evenodd');
    ctx.strokeStyle = 'rgba(255,90,60,0.09)'; ctx.lineWidth = cs * 0.35;
    for (let i = -L.S; i < L.S * 2; i += cs * 1.6) { ctx.beginPath(); ctx.moveTo(i, 0); ctx.lineTo(i + L.S, L.S); ctx.stroke(); }
    ctx.restore();
    if (k > 0.02) {
      ctx.strokeStyle = `rgba(255,${110 + 90 * S.ringFlash | 0},70,${0.55 + 0.4 * S.ringFlash})`; ctx.lineWidth = Math.max(1.5, cs * 0.12);
      ctx.strokeRect(o, o, e - o, e - o);
    }
    // pending ring warning
    if (pendingActive()) {
      const n = S.ringK, a0 = n * cs, a1 = L.S - n * cs, th = cs;
      const left = Math.max(0, nextCollapseAt() - S.t), pulse = 0.5 + 0.5 * Math.sin(T * (6 + (COLLAPSE_WARN - left) * 3));
      ctx.fillStyle = `rgba(255,60,40,${0.16 + 0.26 * pulse})`;
      ctx.fillRect(a0, a0, a1 - a0, th); ctx.fillRect(a0, a1 - th, a1 - a0, th);
      ctx.fillRect(a0, a0 + th, th, a1 - a0 - 2 * th); ctx.fillRect(a1 - th, a0 + th, th, a1 - a0 - 2 * th);
      ctx.strokeStyle = `rgba(255,120,80,${0.5 + 0.4 * pulse})`; ctx.lineWidth = Math.max(1.2, cs * 0.1);
      ctx.strokeRect(a0 + th, a0 + th, a1 - a0 - 2 * th, a1 - a0 - 2 * th);
    }
    // frame
    ctx.save(); ctx.globalCompositeOperation = 'lighter';
    ctx.strokeStyle = 'rgba(110,190,255,0.14)'; ctx.lineWidth = cs * 0.9; ctx.strokeRect(0, 0, L.S, L.S);
    ctx.strokeStyle = 'rgba(190,230,255,0.85)'; ctx.lineWidth = Math.max(1.5, cs * 0.12); ctx.strokeRect(0, 0, L.S, L.S);
    ctx.restore();
    // heads
    for (const c of cyc) drawHead(ctx, c, al, T);
    ctx.save(); ctx.beginPath(); ctx.rect(0, 0, L.S, L.S); ctx.clip();
    parts.draw(ctx, 1);
    for (const r of rings) {
      const t = r.t, rr = cs * (0.5 + 9 * ease.outCubic(t));
      ctx.globalAlpha = (1 - t) * 0.8; ctx.strokeStyle = r.color; ctx.lineWidth = cs * 0.35 * (1 - t) + 1;
      ctx.beginPath(); ctx.arc(r.x, r.y, rr, 0, TAU); ctx.stroke();
    }
    ctx.restore();
    ctx.globalAlpha = 1;
    for (const cl of (S.over ? [] : calls)) {
      const a = cl.t < 0.15 ? cl.t / 0.15 : Math.max(0, 1 - (cl.t - 0.9) / 0.9);
      const u = clamp((cl.x + 0.5) * cs, cs * 5, L.S - cs * 5), v = clamp((cl.y + 0.5) * cs - ease.outCubic(Math.min(1, cl.t / 0.7)) * cs * 2.5 - cs * 1.2, cs * 3, L.S - cs * 2);
      ctx.globalAlpha = a; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.font = `800 ${cs * (cl.big ? 1.7 : 1.2)}px ${FONT_D}`;
      ctx.fillStyle = cl.color; ctx.fillText(cl.txt, u, v);
    }
    ctx.globalAlpha = 1;
    drawBanner(ctx, T);
    ctx.restore();
    // vignette
    const vg = ctx.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.35, w / 2, h / 2, Math.hypot(w, h) * 0.62);
    vg.addColorStop(0, 'rgba(0,0,0,0)'); vg.addColorStop(1, 'rgba(0,0,0,0.55)');
    ctx.fillStyle = vg; ctx.fillRect(0, 0, w, h);
    drawChips(ctx);
  }

  function drawTrail(ctx, c, al, T) {
    const cs = L.cs, [hx, hy] = headGrid(c, al);
    const p = new Path2D(); const pts = c.pts;
    p.moveTo((pts[0][0] + 0.5) * cs, (pts[0][1] + 0.5) * cs);
    for (let i = 1; i < pts.length; i++) p.lineTo((pts[i][0] + 0.5) * cs, (pts[i][1] + 0.5) * cs);
    p.lineTo((hx + 0.5) * cs, (hy + 0.5) * cs);
    const dead = !c.alive, fade = dead ? 1 - 0.55 * Math.min(1, c.deadT / 1.2) : 1;
    ctx.save();
    ctx.lineJoin = 'miter'; ctx.lineCap = 'butt'; ctx.miterLimit = 3;
    ctx.globalCompositeOperation = 'lighter';
    ctx.strokeStyle = c.main;
    ctx.globalAlpha = 0.10 * fade * (1 + c.flash); ctx.lineWidth = cs * 2.6; ctx.stroke(p);
    ctx.globalAlpha = 0.26 * fade; ctx.lineWidth = cs * 1.4; ctx.stroke(p);
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = (0.9 + 0.1 * c.flash) * fade; ctx.strokeStyle = c.main; ctx.lineWidth = cs * 0.62; ctx.stroke(p);
    ctx.globalAlpha = 0.85 * fade; ctx.strokeStyle = c.hi; ctx.lineWidth = cs * 0.22; ctx.stroke(p);
    if (!dead) {
      ctx.globalCompositeOperation = 'lighter'; ctx.globalAlpha = 0.7; ctx.strokeStyle = '#fff'; ctx.lineWidth = cs * 0.3;
      ctx.setLineDash([cs * 0.7, cs * 5.5]); ctx.lineDashOffset = -T * cs * (c.boost > 0 ? 26 : 15); ctx.stroke(p); ctx.setLineDash([]);
    }
    ctx.restore();
  }

  function drawHead(ctx, c, al, T) {
    const cs = L.cs;
    if (!c.alive && c.deadT > 0.15) return;
    const [hx, hy] = headGrid(c, al), u = (hx + 0.5) * cs, v = (hy + 0.5) * cs, ang = c.dir * Math.PI / 2;
    ctx.save(); ctx.translate(u, v); ctx.rotate(ang);
    // headlight cone
    if (c.alive) {
      const lg = ctx.createLinearGradient(0, 0, cs * 7, 0);
      lg.addColorStop(0, `rgba(${c.rgb},0.28)`); lg.addColorStop(1, `rgba(${c.rgb},0)`);
      ctx.globalCompositeOperation = 'lighter'; ctx.fillStyle = lg;
      ctx.beginPath(); ctx.moveTo(cs * 0.6, 0); ctx.lineTo(cs * 7, -cs * 1.8); ctx.lineTo(cs * 7, cs * 1.8); ctx.closePath(); ctx.fill();
      ctx.globalCompositeOperation = 'source-over';
    }
    const ghost = c.ghost > 0 || c.ghostFlash > 0;
    ctx.globalAlpha = c.alive ? 1 : Math.max(0, 1 - c.deadT / 0.15);
    ctx.beginPath(); // arrow-ish bike
    ctx.moveTo(cs * 1.1, 0); ctx.lineTo(cs * 0.1, -cs * 0.62); ctx.lineTo(-cs * 0.75, -cs * 0.45); ctx.lineTo(-cs * 0.75, cs * 0.45); ctx.lineTo(cs * 0.1, cs * 0.62); ctx.closePath();
    ctx.fillStyle = '#0a0c14'; ctx.fill();
    ctx.strokeStyle = ghost ? '#e8f4ff' : c.main; ctx.lineWidth = Math.max(1.5, cs * 0.16); ctx.lineJoin = 'round'; ctx.stroke();
    ctx.fillStyle = c.hi; ctx.beginPath(); ctx.arc(cs * 0.2, 0, cs * 0.2, 0, TAU); ctx.fill();
    if (ghost) { ctx.globalAlpha *= 0.5 + 0.3 * Math.sin(T * 10); ctx.strokeStyle = '#fff'; ctx.lineWidth = cs * 0.08; ctx.beginPath(); ctx.arc(0, 0, cs * 1.25, 0, TAU); ctx.stroke(); }
    ctx.restore();
  }

  function drawBanner(ctx, T) {
    const cs = L.cs, cx = L.S / 2, cy = L.S / 2;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    if (S.state === 'ready') {
      const left = S.stateT, n = Math.ceil(left / 0.6);
      const ph = (left % 0.6) / 0.6; // 1 -> 0
      const label = left > 0.6 ? String(Math.min(3, n - 1)) : 'GO';
      if (left > 0.6) {
        ctx.globalAlpha = Math.min(1, ph * 2.5); ctx.fillStyle = '#e9f6ff';
        ctx.font = `800 ${cs * 8 * (0.9 + 0.2 * ph)}px ${FONT_D}`; ctx.fillText(label, cx, cy);
      } else { ctx.globalAlpha = Math.min(1, left / 0.2); ctx.fillStyle = CYC[0].main; ctx.font = `800 ${cs * 8}px ${FONT_D}`; ctx.fillText('GO', cx, cy); }
      ctx.globalAlpha = 0.8 * Math.min(1, (2.4 - left) * 3); ctx.fillStyle = '#9fb7d6';
      ctx.font = `600 ${cs * 1.5}px ${FONT_D}`; ctx.fillText(`ROUND ${S.round + 1}`, cx, cy - cs * 6.8);
      ctx.globalAlpha = 1;
    } else if (S.state === 'run' && S.t < 0.7) {
      ctx.globalAlpha = 1 - S.t / 0.7; ctx.fillStyle = CYC[0].main; ctx.font = `800 ${cs * (8 + S.t * 6)}px ${FONT_D}`; ctx.fillText('GO', cx, cy); ctx.globalAlpha = 1;
    }
    if (S.over) {
      const k = ease.outCubic(Math.min(1, S.stateT / 0.8)), c = cyc[S.matchWinner];
      ctx.fillStyle = `rgba(0,0,0,${0.55 * k})`; ctx.fillRect(-cs, -cs, L.S + 2 * cs, L.S + 2 * cs);
      ctx.globalAlpha = k; ctx.fillStyle = c.main; ctx.font = `800 ${cs * 5.5}px ${FONT_D}`; ctx.fillText(c.name, cx, cy - cs * 1.2);
      ctx.fillStyle = '#e9f6ff'; ctx.font = `600 ${cs * 1.8}px ${FONT_D}`; ctx.fillText('WINS THE MATCH', cx, cy + cs * 3); ctx.globalAlpha = 1;
    }
  }

  function drawChips(ctx) {
    const y = L.ay - Math.max(L.cs * 1.3, 20), cw = L.S / 4;
    ctx.textBaseline = 'middle';
    for (let i = 0; i < 4; i++) {
      const c = cyc[i], x = L.ax + i * cw + cw * 0.04, fs = Math.max(11, L.cs * 0.95);
      ctx.globalAlpha = c.alive || S.state === 'ready' ? 1 : 0.4;
      ctx.fillStyle = c.main; ctx.beginPath(); ctx.arc(x + fs * 0.4, y, fs * 0.28, 0, TAU); ctx.fill();
      ctx.textAlign = 'left'; ctx.font = `800 ${fs}px ${FONT_D}`; ctx.fillStyle = '#cfe0f4'; ctx.fillText(c.name, x + fs * 0.95, y);
      const tw = ctx.measureText(c.name).width;
      for (let p = 0; p < WIN_ROUNDS; p++) {
        const px = x + fs * 0.95 + tw + fs * 0.7 + p * fs * 0.8;
        ctx.beginPath(); ctx.arc(px, y, fs * 0.25, 0, TAU);
        if (p < c.wins) { ctx.fillStyle = c.main; ctx.fill(); } else { ctx.strokeStyle = 'rgba(180,200,230,0.35)'; ctx.lineWidth = 1.5; ctx.stroke(); }
      }
    }
    ctx.globalAlpha = 1;
  }

  pickGhosts();
  startRound();
  S.state = 'ready';
  return inst;
}

const TWISTS = [
  { key: 'overdrive', name: 'Overdrive bots', desc: 'A rival cycle suddenly surges ahead at +20% speed for a few seconds.' },
  { key: 'ghost', name: 'Ghost walls', desc: 'One rival may phase through a wall, once per round.' },
];

Arcade.register({
  id: 'cycles', name: 'Afterglow Arena', genre: 'Arena duel',
  blurb: 'Four light cycles, solid walls of glowing light, and a shrinking grid. Last one riding wins.',
  bg: '#04060d', accent: '#27e7ff',
  aiNote: 'Sees the grid, every cycle head and the collapse warning; looks four moves ahead, scores the territory it can reach first, and can only turn every 0.1 s.',
  twists: TWISTS,
  create,
});
})();
