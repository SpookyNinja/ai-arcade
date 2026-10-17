// solitaire.js — Brass & Burgundy (Klondike, draw 1, unlimited passes).
// The AI (see "THE AI" section) only reads observe(): face-up cards, the waste top, foundation
// heights and the number of cards left in stock/waste. Face-down identities and the unseen stock
// order are never exposed to it. It acts through single "click/drag" moves at a human cadence.
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

  // ---------------------------------------------------------------- constants
  const BRASS = '#c9a24b', BRASS_L = '#ecd28a';
  const FELT = '#3a0f17';
  const INK_RED = '#b3202e', INK_BLK = '#1b1a21';
  const SERIF = 'Fraunces, Georgia, "Times New Roman", serif';
  const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
  const U = 999;                       // "unknown face-up card" marker inside the AI search
  const CAP_SECONDS = 360;
  const FLY = 0.22;                    // seconds per card flight
  const FLIP = 0.28;
  const PI = Math.PI;

  const rankOf = c => (c % 13) + 1;
  const suitOf = c => (c / 13) | 0;    // 0 spade, 1 heart, 2 diamond, 3 club
  const redS = s => s === 1 || s === 2;

  // ---------------------------------------------------------------- suit glyphs
  // Draws suit `s` centred at (cx,cy) with half-extent k, optionally rotated 180deg.
  function suitGlyph(g, s, cx, cy, k, rot) {
    g.save();
    g.translate(cx, cy);
    if (rot) g.rotate(PI);
    g.scale(k, k);
    g.beginPath();
    if (s === 1) {
      g.moveTo(0, 0.95);
      g.bezierCurveTo(-1.4, -0.05, -0.95, -1.0, 0, -0.38);
      g.bezierCurveTo(0.95, -1.0, 1.4, -0.05, 0, 0.95);
    } else if (s === 2) {
      g.moveTo(0, -1);
      g.bezierCurveTo(0.18, -0.55, 0.5, -0.2, 0.74, 0);
      g.bezierCurveTo(0.5, 0.2, 0.18, 0.55, 0, 1);
      g.bezierCurveTo(-0.18, 0.55, -0.5, 0.2, -0.74, 0);
      g.bezierCurveTo(-0.5, -0.2, -0.18, -0.55, 0, -1);
    } else if (s === 0) {
      g.moveTo(0, -0.98);
      g.bezierCurveTo(-1.4, 0.05, -0.95, 0.9, 0, 0.32);
      g.bezierCurveTo(0.95, 0.9, 1.4, 0.05, 0, -0.98);
      g.moveTo(0, 0.2);
      g.lineTo(-0.34, 0.98);
      g.lineTo(0.34, 0.98);
      g.closePath();
    } else {
      g.arc(0, -0.5, 0.42, 0, PI * 2);
      g.moveTo(-0.1, 0.2); g.arc(-0.52, 0.2, 0.42, 0, PI * 2);
      g.moveTo(0.94, 0.2); g.arc(0.52, 0.2, 0.42, 0, PI * 2);
      g.moveTo(0, 0.05);
      g.lineTo(-0.34, 0.98);
      g.lineTo(0.34, 0.98);
      g.closePath();
      g.moveTo(-0.3, -0.1); g.lineTo(0.3, -0.1); g.lineTo(0.2, 0.45); g.lineTo(-0.2, 0.45); g.closePath();
    }
    g.fill();
    g.restore();
  }

  // ---------------------------------------------------------------- sprites
  const PIPS = {
    1: [[0.5, 0.5]],
    2: [[0.5, 0.2], [0.5, 0.8]],
    3: [[0.5, 0.2], [0.5, 0.5], [0.5, 0.8]],
    4: [[0.0, 0.2], [1, 0.2], [0, 0.8], [1, 0.8]],
    5: [[0, 0.2], [1, 0.2], [0.5, 0.5], [0, 0.8], [1, 0.8]],
    6: [[0, 0.2], [1, 0.2], [0, 0.5], [1, 0.5], [0, 0.8], [1, 0.8]],
    7: [[0, 0.2], [1, 0.2], [0.5, 0.35], [0, 0.5], [1, 0.5], [0, 0.8], [1, 0.8]],
    8: [[0, 0.2], [1, 0.2], [0.5, 0.35], [0, 0.5], [1, 0.5], [0.5, 0.65], [0, 0.8], [1, 0.8]],
    9: [[0, 0.2], [1, 0.2], [0, 0.4], [1, 0.4], [0.5, 0.5], [0, 0.6], [1, 0.6], [0, 0.8], [1, 0.8]],
    10: [[0, 0.2], [1, 0.2], [0.5, 0.3], [0, 0.4], [1, 0.4], [0, 0.6], [1, 0.6], [0.5, 0.7], [0, 0.8], [1, 0.8]],
  };

  function paintFace(g, w, h, code) {
    const s = suitOf(code), r = rankOf(code), col = redS(s) ? INK_RED : INK_BLK;
    const rr = w * 0.085;
    const gr = g.createLinearGradient(0, 0, w * 0.4, h);
    gr.addColorStop(0, '#fffaf0'); gr.addColorStop(1, '#eee3c9');
    roundRect(g, 0.5, 0.5, w - 1, h - 1, rr);
    g.fillStyle = gr; g.fill();
    g.lineWidth = Math.max(1, w * 0.012); g.strokeStyle = 'rgba(70,45,25,0.6)'; g.stroke();
    roundRect(g, w * 0.04, w * 0.04, w * 0.92, h - w * 0.08, rr * 0.7);
    g.strokeStyle = 'rgba(176,138,60,0.28)'; g.lineWidth = Math.max(1, w * 0.008); g.stroke();
    g.fillStyle = col;
    g.textAlign = 'center'; g.textBaseline = 'middle';
    const label = RANKS[r - 1];
    const fs = w * (r === 10 ? 0.17 : 0.2);
    for (let f = 0; f < 2; f++) {
      g.save();
      if (f) { g.translate(w, h); g.rotate(PI); }
      g.font = `600 ${fs}px ${SERIF}`;
      g.fillText(label, w * 0.14, h * 0.082);
      suitGlyph(g, s, w * 0.14, h * 0.082 + w * 0.2, w * 0.075, false);
      g.restore();
    }
    if (r >= 11) {
      const px = w * 0.27, py = h * 0.14, pw = w * 0.46, ph = h * 0.72;
      roundRect(g, px, py, pw, ph, w * 0.05);
      const pg = g.createLinearGradient(px, py, px + pw, py + ph);
      pg.addColorStop(0, 'rgba(201,162,75,0.20)'); pg.addColorStop(1, 'rgba(201,162,75,0.06)');
      g.fillStyle = pg; g.fill();
      g.strokeStyle = 'rgba(160,118,40,0.65)'; g.lineWidth = Math.max(1, w * 0.012); g.stroke();
      roundRect(g, px + w * 0.025, py + w * 0.025, pw - w * 0.05, ph - w * 0.05, w * 0.03);
      g.strokeStyle = 'rgba(160,118,40,0.3)'; g.lineWidth = Math.max(1, w * 0.007); g.stroke();
      g.fillStyle = col;
      suitGlyph(g, s, w * 0.5, h * 0.3, w * 0.085, false);
      suitGlyph(g, s, w * 0.5, h * 0.7, w * 0.085, true);
      g.font = `700 ${w * 0.4}px ${SERIF}`;
      g.fillText(label, w * 0.5, h * 0.5 + w * 0.02);
      g.fillStyle = 'rgba(160,118,40,0.55)';
      g.fillRect(w * 0.36, h * 0.395, w * 0.28, Math.max(1, w * 0.008));
      g.fillRect(w * 0.36, h * 0.605, w * 0.28, Math.max(1, w * 0.008));
    } else if (r === 1) {
      g.fillStyle = col;
      suitGlyph(g, s, w * 0.5, h * 0.5, w * 0.27, false);
      g.strokeStyle = 'rgba(160,118,40,0.35)'; g.lineWidth = Math.max(1, w * 0.01);
      g.beginPath(); g.arc(w * 0.5, h * 0.5, w * 0.34, 0, PI * 2); g.stroke();
    } else {
      g.fillStyle = col;
      const k = w * 0.105;
      for (const [fx, fy] of PIPS[r]) {
        suitGlyph(g, s, w * (0.37 + 0.26 * fx), h * fy, k, fy > 0.5);
      }
    }
  }

  function paintBack(g, w, h) {
    const rr = w * 0.085;
    roundRect(g, 0.5, 0.5, w - 1, h - 1, rr);
    g.fillStyle = '#f2e9d2'; g.fill();
    g.lineWidth = Math.max(1, w * 0.012); g.strokeStyle = 'rgba(70,45,25,0.6)'; g.stroke();
    const m = w * 0.06;
    roundRect(g, m, m, w - 2 * m, h - 2 * m, rr * 0.6);
    const gr = g.createLinearGradient(0, 0, w, h);
    gr.addColorStop(0, '#1b3158'); gr.addColorStop(1, '#0d1a33');
    g.fillStyle = gr; g.fill();
    g.save();
    roundRect(g, m, m, w - 2 * m, h - 2 * m, rr * 0.6);
    g.clip();
    g.strokeStyle = 'rgba(201,162,75,0.6)'; g.lineWidth = Math.max(1, w * 0.01);
    const sp = w * 0.17;
    g.beginPath();
    for (let i = -h; i < w + h; i += sp) {
      g.moveTo(i, 0); g.lineTo(i + h, h);
      g.moveTo(i, h); g.lineTo(i + h, 0);
    }
    g.stroke();
    g.fillStyle = 'rgba(236,210,138,0.85)';
    // dots where the two diagonal families cross: x = i + y and x = i2 + h - y
    for (let y = 0; y <= h; y += sp / 2) {
      for (let i = -h; i < w + h; i += sp) {
        const x = i + y;
        // crossing with a family-2 line when (x - i2 - h + y) = 0 -> check alignment
        const k2 = (x + y - h) / sp;
        if (Math.abs(k2 - Math.round(k2)) < 0.02 && x > 0 && x < w) { g.beginPath(); g.arc(x, y, w * 0.012, 0, PI * 2); g.fill(); }
      }
    }
    g.restore();
    g.save();
    g.translate(w / 2, h / 2);
    g.fillStyle = '#12213f';
    g.beginPath(); g.arc(0, 0, w * 0.2, 0, PI * 2); g.fill();
    g.strokeStyle = BRASS; g.lineWidth = Math.max(1, w * 0.016); g.stroke();
    g.lineWidth = Math.max(1, w * 0.008);
    g.beginPath(); g.arc(0, 0, w * 0.15, 0, PI * 2); g.stroke();
    g.fillStyle = BRASS_L;
    g.beginPath(); g.moveTo(0, -w * 0.1); g.lineTo(w * 0.065, 0); g.lineTo(0, w * 0.1); g.lineTo(-w * 0.065, 0); g.closePath(); g.fill();
    g.restore();
    roundRect(g, m, m, w - 2 * m, h - 2 * m, rr * 0.6);
    g.strokeStyle = BRASS; g.lineWidth = Math.max(1, w * 0.014); g.stroke();
  }

  let feltTile = null;
  function getFeltTile() {
    if (feltTile) return feltTile;
    const n = 192, c = document.createElement('canvas');
    c.width = c.height = n;
    const g = c.getContext('2d');
    g.fillStyle = FELT; g.fillRect(0, 0, n, n);
    const id = g.getImageData(0, 0, n, n), d = id.data;
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
      const i = (y * n + x) * 4;
      const weave = ((x >> 1) + (y >> 1)) & 1 ? 4 : -4;
      const nz = (Math.random() - 0.5) * 16 + weave;
      d[i] = clamp(d[i] + nz * 1.1, 0, 255); d[i + 1] = clamp(d[i + 1] + nz * 0.35, 0, 255); d[i + 2] = clamp(d[i + 2] + nz * 0.45, 0, 255);
    }
    g.putImageData(id, 0, 0);
    feltTile = c;
    return c;
  }

  // =====================================================================================
  // THE AI. Sees only: for each column the number of face-down cards and the list of face-up
  // card codes (bottom to top), the 4 foundation heights, the waste top card (or -1) and the
  // number of cards left in stock+waste. It never sees face-down cards or the stock order.
  // It plans with a small depth-limited search over *visible* information; a card it would
  // reveal becomes an "unknown" marker (U). To avoid loops it remembers visited visible
  // states since its last irreversible progress and declares itself stuck on a repeat.
  // =====================================================================================
  const AI = (() => {
    const STEP = 2.2;
    const BASE = { found: 45, fd: 100, fd2: 8, empty: 22, king: 18, dig: 2.5, sw: 9, unsafe: 46 };
    const W = Object.assign({}, BASE);
    // Styles re-weight the evaluation: what the AI values most.
    const STYLES = {
      'Foundation first': { found: 62, fd: 92, unsafe: 38 },
      'Reveal first': { found: 40, fd: 120, fd2: 9, dig: 2.8 },
      'Column builder': { empty: 30, king: 24, dig: 2.0, sw: 7 },
    };
    function setStyle(name) { Object.assign(W, BASE, STYLES[name]); }

    function fromObs(o) {
      return {
        down: o.cols.map(c => c.down),
        up: o.cols.map(c => c.up),
        f: o.found.slice(),
        w: o.waste,
        sw: o.stockCount + o.wasteCount,
      };
    }
    const clone = S => ({ down: S.down.slice(), up: S.up.slice(), f: S.f.slice(), w: S.w, sw: S.sw });
    const canStack = (c, onto) => onto !== U && rankOf(onto) === rankOf(c) + 1 && redS(suitOf(onto)) !== redS(suitOf(c));

    function allShown(S) { let d = 0; for (let i = 0; i < 7; i++) d += S.down[i]; return d === 0; }
    function safeF(S, c) {
      const r = rankOf(c);
      if (r <= 2) return true;
      const red = redS(suitOf(c));
      for (let t = 0; t < 4; t++) if (redS(t) !== red && S.f[t] < r - 1) return false;
      return true;
    }

    function gen(S) {
      const out = [];
      const w = S.w;
      for (let c = 0; c < 7; c++) {
        const u = S.up[c], n = u.length;
        if (!n) continue;
        const top = u[n - 1];
        if (top !== U && S.f[suitOf(top)] === rankOf(top) - 1) out.push({ k: 'tf', from: c });
        for (let i = 0; i < n; i++) {
          const base = u[i];
          if (base === U) continue;
          for (let d = 0; d < 7; d++) {
            if (d === c) continue;
            const ud = S.up[d];
            if (!ud.length) {
              if (S.down[d] === 0 && rankOf(base) === 13 && !(i === 0 && S.down[c] === 0)) out.push({ k: 'tt', from: c, n: n - i, to: d });
            } else if (canStack(base, ud[ud.length - 1])) out.push({ k: 'tt', from: c, n: n - i, to: d });
          }
        }
      }
      if (w >= 0) {
        if (S.f[suitOf(w)] === rankOf(w) - 1) out.push({ k: 'wf' });
        for (let d = 0; d < 7; d++) {
          const ud = S.up[d];
          if (!ud.length) { if (S.down[d] === 0 && rankOf(w) === 13) out.push({ k: 'wt', to: d }); }
          else if (canStack(w, ud[ud.length - 1])) out.push({ k: 'wt', to: d });
        }
      }
      return out;
    }

    function flipTop(T, c) {
      if (T.up[c].length === 0 && T.down[c] > 0) { T.down[c]--; T.up[c] = [U]; }
    }
    // returns [newState, penalty]
    function apply(S, m, shown) {
      const T = clone(S);
      let pen = 0;
      if (m.k === 'wf') {
        const c = S.w;
        T.f[suitOf(c)]++; T.w = -1; T.sw--;
        if (!shown && !safeF(S, c)) pen = W.unsafe;
      } else if (m.k === 'wt') {
        T.up[m.to] = S.up[m.to].concat(S.w); T.w = -1; T.sw--;
      } else if (m.k === 'tf') {
        const u = S.up[m.from], c = u[u.length - 1];
        T.up[m.from] = u.slice(0, -1); T.f[suitOf(c)]++;
        if (!shown && !safeF(S, c)) pen = W.unsafe;
        flipTop(T, m.from);
      } else {
        const u = S.up[m.from];
        T.up[m.to] = S.up[m.to].concat(u.slice(u.length - m.n));
        T.up[m.from] = u.slice(0, u.length - m.n);
        flipTop(T, m.from);
      }
      return [T, pen];
    }

    function evalS(S) {
      let v = 0;
      for (let s = 0; s < 4; s++) v += S.f[s] * W.found;
      for (let c = 0; c < 7; c++) {
        const fd = S.down[c], u = S.up[c];
        v -= fd * W.fd + fd * fd * W.fd2;
        if (fd === 0) {
          if (u.length === 0) v += W.empty;
          else if (u[0] !== U && rankOf(u[0]) === 13) v += W.king;
        } else v -= W.dig * u.length;
      }
      v -= S.sw * W.sw;
      return v;
    }

    function best(S, depth, ctx, shown) {
      let b = evalS(S);
      if (depth === 0 || ctx.nodes > ctx.max) return b;
      const ms = gen(S);
      for (const m of ms) {
        ctx.nodes++;
        const r = apply(S, m, shown);
        const v = best(r[0], depth - 1, ctx, shown) - r[1] - STEP;
        if (v > b) b = v;
      }
      return b;
    }

    const hashS = S => S.down.join('') + '|' + S.up.map(u => u.join(',')).join('/') + '|' + S.f.join(',') + '|' + S.w + '|' + S.sw;

    const visited = new Set();
    let lastProg = '';
    function reset() { visited.clear(); lastProg = ''; }

    // returns {k:'wf'|'wt'|'tf'|'tt'|'draw'|'recycle'|'stuck', ...}
    function decide(obs) {
      const S = fromObs(obs);
      const prog = S.f.join(',') + '#' + S.down.join('') + '#' + S.sw;
      if (prog !== lastProg) { visited.clear(); lastProg = prog; }
      const h = hashS(S);
      if (visited.has(h)) return { k: 'stuck' };
      visited.add(h);
      const shown = allShown(S);
      const base = evalS(S);
      const ctx = { nodes: 0, max: 2600 };
      const cands = [];
      for (const m of gen(S)) {
        const [T, pen] = apply(S, m, shown);
        const v = best(T, 2, ctx, shown) - pen - STEP + Math.random() * 0.4;
        cands.push({ m, v, T });
      }
      cands.sort((a, b) => b.v - a.v);
      for (const c of cands) {
        if (c.v <= base + 1.5) break;
        if (visited.has(hashS(c.T))) continue;
        return c.m;
      }
      if (obs.stockCount > 0) return { k: 'draw' };
      if (obs.wasteCount > 0) return { k: 'recycle' };
      return { k: 'stuck' };
    }
    return { decide, reset, W, STYLES, setStyle };
  })();

  // =====================================================================================
  // THE GAME
  // =====================================================================================
  function create() {
    const G = {
      over: false, won: false,
      W: 1600, H: 900, t: 0, dpr: 1,
      cards: [], stock: [], waste: [], found: [[], [], [], []], tab: [[], [], [], [], [], [], []],
      L: null, moves: 0, particles: new Particles(), pulses: [], motes: [],
      cool: 0.2, pending: null, dealt: false, dealT: 0, seq: 0, lastKey: -1, autoFinish: false,
      cascade: null, cascEnd: null, lostT: 0, endNote: '', progMoves: 0,
      sprites: new Map(), spriteKey: '', trail: null, trailScale: 1,
    };
    AI.reset();
    G.style = rnd.pick(Object.keys(AI.STYLES)); AI.setStyle(G.style);

    // ---- deck: a fully random shuffle, all face down in the stock
    const deck = [];
    for (let i = 0; i < 52; i++) deck.push(i);
    rnd.shuffle(deck);
    for (const code of deck) {
      const c = { code, up: false, x: 0, y: 0, tx: 0, ty: 0, fly: null, flip: null, fseq: 0 };
      G.cards.push(c); G.stock.push(c);
    }
    for (let i = 0; i < 40; i++) G.motes.push({ x: Math.random(), y: Math.random(), s: rnd.float(0.6, 2), v: rnd.float(0.004, 0.012), p: Math.random() * 7 });

    // ---------------------------------------------------------------- layout
    G.resize = function (W, H) {
      this.W = W; this.H = H;
      const mx = W * 0.05, avW = W - 2 * mx;
      const gxr = 0.17;
      const cw = Math.min(avW / (7 + 6 * gxr), (0.215 * H) / 1.42);
      const ch = cw * 1.42;
      const gx = clamp((avW - 7 * cw) / 6, cw * gxr, cw * 0.45);
      const bw = 7 * cw + 6 * gx;
      const x0 = (W - bw) / 2;
      const topY = H * 0.055;
      const colX = []; for (let i = 0; i < 7; i++) colX.push(x0 + i * (cw + gx));
      // the shell HUD box sits bottom-left (~360x100 px): when column 0 is under it, end the tableau above it
      const bottom = x0 < 370 ? Math.min(H * 0.955, H - 104) : H * 0.955;
      this.L = { cw, ch, gx, x0, bw, topY, colX, tabY: topY + ch + cw * 0.3, bottom };
      this.dpr = Math.min(2, (typeof window !== 'undefined' && window.devicePixelRatio) || 1);
      this.trail = null;
      this.layoutTargets();
      for (const c of this.cards) { c.x = c.tx; c.y = c.ty; }
      for (const c of this.cards) if (c.fly) { c.fly.sx = c.x; c.fly.sy = c.y; }
    };

    G.layoutTargets = function () {
      const L = this.L; if (!L) return;
      const { cw, ch, colX, topY, tabY } = L;
      const px = cw * 0.006;
      const sn = this.stock.length;
      this.stock.forEach((c, i) => { const d = Math.min(sn - 1 - i, 3); c.tx = colX[0] + d * px; c.ty = topY + d * px; });
      this.waste.forEach(c => { c.tx = colX[1]; c.ty = topY; });
      for (let s = 0; s < 4; s++) this.found[s].forEach(c => { c.tx = colX[3 + s]; c.ty = topY; });
      const dd = ch * 0.11, du = ch * 0.27;
      for (let k = 0; k < 7; k++) {
        const col = this.tab[k];
        let nd = 0, nu = 0;
        for (const c of col) c.up ? nu++ : nd++;
        const nat = nd * dd + Math.max(nu - 1, 0) * du;
        const avail = L.bottom - tabY - ch;
        const sc = nat > avail ? Math.max(avail / nat, 0.35) : 1;
        let y = tabY;
        for (const c of col) { c.tx = colX[k]; c.ty = y; y += (c.up ? du : dd) * sc; }
      }
    };

    // ---------------------------------------------------------------- motion helpers
    G.launch = function (c, delay, onLand) {
      const dist = Math.hypot(c.tx - c.x, c.ty - c.y);
      c.fly = { sx: c.x, sy: c.y, t: -delay, dur: FLY + 0.1 * clamp(dist / this.W, 0, 1), arc: Math.min(dist * 0.1, this.L.ch * 0.3), onLand };
      c.fseq = ++this.seq;
    };
    G.setFlip = function (c, delay, from) { c.flip = { t: -delay, from }; };

    G.stepCards = function (dt) {
      const k = 1 - Math.exp(-16 * dt);
      for (const c of this.cards) {
        const f = c.fly;
        if (f) {
          f.t += dt;
          if (f.t < 0) { c.x = f.sx; c.y = f.sy; }
          else {
            const u = clamp(f.t / f.dur, 0, 1), e = ease.outCubic(u);
            c.x = lerp(f.sx, c.tx, e);
            c.y = lerp(f.sy, c.ty, e) - f.arc * Math.sin(PI * Math.pow(u, 0.85));
            if (u >= 1) { c.fly = null; c.x = c.tx; c.y = c.ty; if (f.onLand) f.onLand(c); }
          }
        } else {
          c.x += (c.tx - c.x) * k; c.y += (c.ty - c.y) * k;
          if (Math.abs(c.tx - c.x) < 0.05) c.x = c.tx;
          if (Math.abs(c.ty - c.y) < 0.05) c.y = c.ty;
        }
        if (c.flip) {
          c.flip.t += dt;
          if (c.flip.t >= FLIP) c.flip = null;
        }
      }
    };

    // ---------------------------------------------------------------- rules / actions
    G.landFound = function (c) {
      const L = this.L;
      this.particles.burst(c.tx + L.cw / 2, c.ty + L.ch / 2, 16, { color: [BRASS, BRASS_L, '#fff3d0'], speed: L.cw * 2.4, speedMin: L.cw * 0.5, life: 0.8, size: L.cw * 0.035, drag: 3.2 });
      this.pulses.push({ x: c.tx + L.cw / 2, y: c.ty + L.ch / 2, t: 0 });
    };

    G.flipUp = function (c, delay) { c.up = true; this.setFlip(c, delay, false); };

    G.doDeal = function () {
      let k = 0;
      for (let i = 0; i < 7; i++) {
        for (let j = i; j < 7; j++) {
          const c = this.stock.pop();
          this.tab[j].push(c);
          this.layoutTargets();
          const d = k * 0.05;
          this.launch(c, d);
          if (i === j) { c.up = true; this.setFlip(c, d + 0.17, false); }
          k++;
        }
      }
      this.layoutTargets();
      this.dealT = k * 0.05 + 0.7;
    };

    G.counts = function () {
      let fd = 0; for (const col of this.tab) for (const c of col) if (!c.up) fd++;
      return { fd, fnd: this.found.reduce((a, p) => a + p.length, 0) };
    };

    // What a human sees: face-up cards, waste top, foundation heights, counts of stock/waste.
    G.observe = function () {
      return {
        cols: this.tab.map(col => {
          let down = 0; const up = [];
          for (const c of col) c.up ? up.push(c.code) : down++;
          return { down, up };
        }),
        found: this.found.map(p => p.length),
        waste: this.waste.length ? this.waste[this.waste.length - 1].code : -1,
        wasteCount: this.waste.length,
        stockCount: this.stock.length,
      };
    };

    G.cardsForMove = function (m) {
      if (m.k === 'wf' || m.k === 'wt') return [this.waste[this.waste.length - 1]];
      if (m.k === 'tf') { const col = this.tab[m.from]; return [col[col.length - 1]]; }
      if (m.k === 'tt') { const col = this.tab[m.from]; return col.slice(col.length - m.n); }
      if (m.k === 'draw') return this.stock.length ? [this.stock[this.stock.length - 1]] : [];
      return [];
    };

    G.exec = function (m) {
      this.moves++;
      if (m.k === 'draw') {
        const c = this.stock.pop();
        this.waste.push(c); c.up = true;
        this.layoutTargets(); this.launch(c, 0); this.setFlip(c, 0, false);
        return;
      }
      if (m.k === 'recycle') {
        const w = this.waste.splice(0, this.waste.length).reverse();
        for (const c of w) { c.up = false; this.stock.push(c); }
        this.layoutTargets();
        w.forEach((c, i) => { this.launch(c, i * 0.012); this.setFlip(c, i * 0.012, true); });
        return;
      }
      let cards, srcCol = -1;
      if (m.k === 'wf' || m.k === 'wt') cards = [this.waste.pop()];
      else if (m.k === 'tf') { srcCol = m.from; cards = [this.tab[m.from].pop()]; }
      else { srcCol = m.from; const col = this.tab[m.from]; cards = col.splice(col.length - m.n, m.n); }
      const toFound = m.k === 'wf' || m.k === 'tf';
      if (toFound) this.found[suitOf(cards[0].code)].push(cards[0]);
      else this.tab[m.to].push(...cards);
      this.layoutTargets();
      cards.forEach((c, i) => this.launch(c, i * 0.035, toFound ? (cc => this.landFound(cc)) : null));
      if (srcCol >= 0) {
        const col = this.tab[srcCol];
        if (col.length && !col[col.length - 1].up) {
          this.flipUp(col[col.length - 1], 0.12 + (cards.length - 1) * 0.02);
          this.layoutTargets();
        }
      }
    };

    G.stepAI = function (dt) {
      if (this.pending) {
        this.pending.t -= dt;
        if (this.pending.t <= 0) {
          const m = this.pending.m; this.pending = null;
          this.exec(m);
          const o = this.counts();
          const key = o.fnd * 100 + o.fd;
          if (key !== this.lastKey) { this.lastKey = key; this.progMoves = 0; } else this.progMoves++;
          this.cool = this.autoFinish ? 0.24 : (m.k === 'draw' ? 0.54 : (m.k === 'recycle' ? 1.1 : 0.7));
        }
        return;
      }
      this.cool -= dt;
      if (this.cool > 0) return;
      const obs = this.observe();
      this.autoFinish = obs.stockCount + obs.wasteCount === 0 && obs.cols.every(c => c.down === 0);
      const m = AI.decide(obs);
      if (m.k === 'stuck' || this.progMoves > 400) {
        this.stuckT = (this.stuckT || 0) + 1;   // linger a moment before conceding
        this.cool = 2.5; if (this.stuckT >= 2) this.endLoss();
        return;
      }
      const hover = (m.k === 'draw' || m.k === 'recycle') ? 0.02 : (this.autoFinish ? 0.0 : 0.35);
      this.pending = { m, t: hover, hover, cards: this.cardsForMove(m) };
    };

    G.endLoss = function () {
      this.over = true; this.won = false;
      this.endNote = `No moves left, ${this.counts().fnd} of 52 cards home`;
    };

    G.startCascade = function () {
      const ord = [];
      for (let r = 12; r >= 0; r--) for (const s of [0, 1, 3, 2]) ord.push(this.found[s][r]);
      this.cascade = { t: 0, cards: [], order: ord, next: 0 };
    };

    G.stepCascade = function (dt) {
      const C = this.cascade, L = this.L, W = this.W, H = this.H;
      C.t += dt;
      while (C.next < C.order.length && C.t >= 0.07 * C.next) {
        const c = C.order[C.next++];
        const pile = this.found[suitOf(c.code)];
        const idx = pile.indexOf(c); if (idx >= 0) pile.splice(idx, 1);
        const dir = Math.random() < 0.5 ? -1 : 1;
        C.cards.push({
          code: c.code, x: c.x, y: c.y, sx: c.x, sy: c.y, first: true,
          vx: dir * rnd.float(0.13, 0.32) * W, vy: -rnd.float(150, 700) * (H / 900),
          rot: 0, vr: dir * rnd.float(-0.8, 0.8),
        });
        this.particles.burst(c.x + L.cw / 2, c.y + L.ch / 2, 10, { color: [BRASS, BRASS_L, '#fff'], speed: L.cw * 2, life: 0.7, size: L.cw * 0.03, drag: 3 });
        const i = this.cards.indexOf(c); if (i >= 0) this.cards.splice(i, 1);
      }
      const g = H * 2.3;
      for (let i = C.cards.length - 1; i >= 0; i--) {
        const k = C.cards[i];
        k.vy += g * dt;
        k.x += k.vx * dt; k.y += k.vy * dt;
        k.rot += k.vr * dt * 0.3;
        if (k.y + L.ch > H) {
          k.y = H - L.ch;
          k.vy = -Math.abs(k.vy) * 0.84;
          if (Math.abs(k.vy) < 60) k.vy = -H * 0.35;
        }
        if (k.x < -L.cw * 1.5 || k.x > W + L.cw * 1.5) C.cards.splice(i, 1);
      }
      if (!this.over && C.t > 1.3) { this.over = true; this.won = true; }
      if (this.cascEnd == null && C.next >= C.order.length && C.cards.length === 0) this.cascEnd = C.t;
    };

    // ---------------------------------------------------------------- step
    const ipg = () => [[G.cards, ['x', 'y'], 300], [[G], ['t'], 0, 't'], [G.cards.map(c => c.flip).filter(Boolean), ['t'], 0, 't']];
    G.step = function (dt) {
      IP.snap(ipg());
      this.t += dt;
      this.particles.update(dt);
      for (let i = this.pulses.length - 1; i >= 0; i--) { this.pulses[i].t += dt; if (this.pulses[i].t > 0.7) this.pulses.splice(i, 1); }
      if (!this.dealt) { this.dealt = true; this.doDeal(); }
      this.layoutTargets();
      this.stepCards(dt);
      if (this.cascade) { this.stepCascade(dt); return; }
      if (this.over) { this.lostT += dt; return; }
      if (this.dealT > 0) { this.dealT -= dt; return; }
      if (this.t > CAP_SECONDS) { this.endLoss(); this.endNote = 'Out of time, no moves left'; return; }
      if (this.counts().fnd === 52) {
        if (!this.cards.some(c => c.fly)) this.startCascade();
        return;
      }
      this.stepAI(dt);
    };

    // ---------------------------------------------------------------- drawing
    G.sprite = function (code, faceUp) {
      const { cw, ch } = this.L;
      const fontOk = typeof document !== 'undefined' && document.fonts && document.fonts.check ? document.fonts.check('600 20px Fraunces') : false;
      const key = Math.round(cw * this.dpr) + (fontOk ? 'f' : 'n');
      if (key !== this.spriteKey) { this.sprites.clear(); this.spriteKey = key; }
      const id = faceUp ? code : -1;
      let s = this.sprites.get(id);
      if (!s) {
        s = document.createElement('canvas');
        s.width = Math.ceil(cw * this.dpr); s.height = Math.ceil(ch * this.dpr);
        const g = s.getContext('2d');
        g.scale(s.width / cw, s.height / ch);
        if (faceUp) paintFace(g, cw, ch, code); else paintBack(g, cw, ch);
        this.sprites.set(id, s);
      }
      return s;
    };

    G.drawCardRaw = function (ctx, code, faceUp, x, y, sx, sy, lift, rot) {
      const { cw, ch } = this.L;
      ctx.save();
      ctx.translate(x + cw / 2, y + ch / 2);
      if (rot) ctx.rotate(rot);
      ctx.scale(sx, sy);
      const rr = cw * 0.085;
      ctx.fillStyle = `rgba(0,0,0,${0.2 - 0.06 * Math.min(lift, 1)})`;
      roundRect(ctx, -cw / 2 + lift * cw * 0.04, -ch / 2 + cw * 0.012 + lift * cw * 0.09, cw, ch, rr);
      ctx.fill();
      if (lift > 0.05) {
        ctx.fillStyle = `rgba(0,0,0,${0.16 * Math.min(lift, 1)})`;
        roundRect(ctx, -cw / 2 + lift * cw * 0.07 - cw * 0.03, -ch / 2 + cw * 0.03 + lift * cw * 0.15, cw * 1.06, ch * 1.02, rr * 1.4);
        ctx.fill();
      }
      ctx.drawImage(this.sprite(code, faceUp), -cw / 2, -ch / 2, cw, ch);
      ctx.restore();
    };

    G.drawCard = function (ctx, c) {
      let sx = 1, lift = 0, up = c.up;
      const f = c.fly;
      if (f && f.t >= 0) {
        const u = clamp(f.t / f.dur, 0, 1);
        lift = Math.sin(PI * Math.pow(u, 0.9));
        sx = 1 + 0.05 * lift;
      }
      const fl = c.flip;
      if (fl) {
        if (fl.t >= 0) {
          const u = fl.t / FLIP;
          sx *= Math.max(Math.abs(Math.cos(PI * u)), 0.02);
          up = u >= 0.5 ? c.up : fl.from;
          lift = Math.max(lift, Math.sin(PI * u) * 0.7);
        } else up = fl.from;
      }
      this.drawCardRaw(ctx, c.code, up, c.x, c.y, sx, f && f.t >= 0 ? sx : 1, lift, 0);
    };

    G.drawSlots = function (ctx, t) {
      const { cw, ch, colX, topY, tabY } = this.L;
      const rr = cw * 0.085;
      ctx.lineWidth = Math.max(1.5, cw * 0.014);
      for (let k = 0; k < 7; k++) {
        roundRect(ctx, colX[k], tabY, cw, ch, rr);
        ctx.fillStyle = 'rgba(0,0,0,0.12)'; ctx.fill();
        ctx.strokeStyle = 'rgba(201,162,75,0.16)'; ctx.stroke();
      }
      for (let s = 0; s < 4; s++) {
        const x = colX[3 + s];
        roundRect(ctx, x, topY, cw, ch, rr);
        ctx.fillStyle = 'rgba(0,0,0,0.2)'; ctx.fill();
        ctx.strokeStyle = 'rgba(201,162,75,0.62)'; ctx.stroke();
        roundRect(ctx, x + cw * 0.05, topY + cw * 0.05, cw * 0.9, ch - cw * 0.1, rr * 0.7);
        ctx.strokeStyle = 'rgba(201,162,75,0.16)'; ctx.lineWidth = Math.max(1, cw * 0.007); ctx.stroke();
        ctx.lineWidth = Math.max(1.5, cw * 0.014);
        ctx.fillStyle = 'rgba(201,162,75,0.2)';
        suitGlyph(ctx, s, x + cw / 2, topY + ch / 2, cw * 0.22, false);
      }
      roundRect(ctx, colX[1], topY, cw, ch, rr);
      ctx.strokeStyle = 'rgba(201,162,75,0.2)'; ctx.stroke();
      roundRect(ctx, colX[0], topY, cw, ch, rr);
      ctx.fillStyle = 'rgba(0,0,0,0.2)'; ctx.fill();
      ctx.strokeStyle = 'rgba(201,162,75,0.5)'; ctx.stroke();
      if (!this.stock.length) {
        const cx = colX[0] + cw / 2, cy = topY + ch / 2, r = cw * 0.2;
        ctx.strokeStyle = 'rgba(201,162,75,0.5)'; ctx.lineWidth = cw * 0.035; ctx.lineCap = 'round';
        const a0 = -PI * 0.15 + t * 0.4;
        ctx.beginPath(); ctx.arc(cx, cy, r, a0, a0 + PI * 1.6); ctx.stroke();
        const ae = a0 + PI * 1.6, ex = cx + Math.cos(ae) * r, ey = cy + Math.sin(ae) * r;
        ctx.fillStyle = 'rgba(201,162,75,0.5)';
        ctx.save(); ctx.translate(ex, ey); ctx.rotate(ae + PI / 2);
        ctx.beginPath(); ctx.moveTo(0, -r * 0.5); ctx.lineTo(r * 0.5, r * 0.15); ctx.lineTo(-r * 0.5, r * 0.15); ctx.closePath(); ctx.fill();
        ctx.restore();
        ctx.lineCap = 'butt';
      }
    };

    G.drawBackground = function (ctx, W, H) {
      const t = this.t, L = this.L;
      ctx.fillStyle = ctx.createPattern(getFeltTile(), 'repeat');
      ctx.fillRect(0, 0, W, H);
      const cx = W * (0.5 + 0.04 * Math.sin(t * 0.11)), cy = H * (0.42 + 0.03 * Math.sin(t * 0.083 + 1));
      let g = ctx.createRadialGradient(cx, cy, 0, cx, cy, Math.max(W, H) * 0.8);
      g.addColorStop(0, 'rgba(190,70,70,0.30)');
      g.addColorStop(0.45, 'rgba(120,30,40,0.10)');
      g.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
      g = ctx.createRadialGradient(W / 2, H * 0.48, Math.min(W, H) * 0.3, W / 2, H * 0.48, Math.max(W, H) * 0.78);
      g.addColorStop(0, 'rgba(10,0,4,0)');
      g.addColorStop(1, 'rgba(10,0,4,0.72)');
      ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
      ctx.strokeStyle = 'rgba(201,162,75,0.10)'; ctx.lineWidth = 1.5;
      roundRect(ctx, L.x0 - L.cw * 0.28, L.topY - L.cw * 0.28, L.bw + L.cw * 0.56, H * 0.955 - L.topY + L.cw * 0.46, L.cw * 0.2);
      ctx.stroke();
      ctx.fillStyle = '#ffd9a0';
      for (const m of this.motes) {
        const x = (((m.x + Math.sin(t * 0.05 + m.p) * 0.03) % 1) + 1) % 1 * W;
        const y = (((m.y - t * m.v) % 1) + 1) % 1 * H;
        const a = 0.12 + 0.1 * Math.sin(t * 0.7 + m.p);
        ctx.globalAlpha = Math.max(0, a) * (1 - Math.abs(y / H - 0.45));
        ctx.beginPath(); ctx.arc(x, y, m.s * (W / 1600 + 0.4), 0, PI * 2); ctx.fill();
      }
      ctx.globalAlpha = 1;
    };

    const drawRaw = function (ctx, W, H) {
      if (!this.L || this.W !== W || this.H !== H) this.resize(W, H);
      const L = this.L;
      this.drawBackground(ctx, W, H);
      this.drawSlots(ctx, this.t);
      const flying = [];
      const drawPile = (pile, depthMax) => {
        const n = pile.length;
        for (let i = 0; i < n; i++) {
          const c = pile[i];
          if (c.fly) { flying.push(c); continue; }
          if (n - 1 - i >= depthMax) continue;
          this.drawCard(ctx, c);
        }
      };
      drawPile(this.stock, 4);
      drawPile(this.waste, 3);
      for (let s = 0; s < 4; s++) drawPile(this.found[s], 3);
      for (let k = 0; k < 7; k++) drawPile(this.tab[k], 99);
      const p = this.pending;
      if (p && p.cards.length && p.hover > 0.05) {
        const a = clamp(1 - p.t / p.hover, 0, 1);
        ctx.save();
        ctx.strokeStyle = `rgba(236,210,138,${0.3 + 0.55 * a})`;
        ctx.lineWidth = Math.max(2, L.cw * 0.03);
        for (const c of p.cards) {
          if (c.fly) continue;
          roundRect(ctx, c.x - 2, c.y - 2, L.cw + 4, L.ch + 4, L.cw * 0.1);
          ctx.stroke();
        }
        ctx.restore();
      }
      flying.sort((a, b) => a.fseq - b.fseq);
      for (const c of flying) this.drawCard(ctx, c);
      for (const q of this.pulses) {
        const u = q.t / 0.7;
        ctx.strokeStyle = `rgba(236,210,138,${0.55 * (1 - u)})`;
        ctx.lineWidth = Math.max(1.5, L.cw * 0.03 * (1 - u));
        const e = u * L.cw * 0.18;
        roundRect(ctx, q.x - L.cw / 2 - e, q.y - L.ch / 2 - e, L.cw + 2 * e, L.ch + 2 * e, L.cw * 0.1 + e);
        ctx.stroke();
      }
      if (this.cascade) this.drawCascade(ctx, W, H);
      this.particles.draw(ctx, 1);
      if (this.over && !this.won) {
        ctx.fillStyle = `rgba(16,2,8,${Math.min(0.5, this.lostT * 0.3)})`;
        ctx.fillRect(0, 0, W, H);
      }
    };

    G.drawCascade = function (ctx, W, H) {
      const C = this.cascade, L = this.L;
      if (!this.trail) {
        const sc = Math.min(1.5, this.dpr);
        const c = document.createElement('canvas');
        c.width = Math.ceil(W * sc); c.height = Math.ceil(H * sc);
        this.trail = c; this.trailScale = sc;
      }
      const tg = this.trail.getContext('2d'), sc = this.trailScale;
      tg.setTransform(sc, 0, 0, sc, 0, 0);
      const stampStep = L.cw * 0.5;
      for (const k of C.cards) {
        const dx = k.x - k.sx, dy = k.y - k.sy, dist = Math.hypot(dx, dy);
        // stamp a ghost of the card every `stampStep` px of travel (classic cascade trail)
        let d = k.first ? 0 : (k.carry || 0);
        while (d <= dist) {
          const u = dist ? d / dist : 0;
          tg.save();
          tg.translate(k.sx + dx * u + L.cw / 2, k.sy + dy * u + L.ch / 2);
          if (k.rot) tg.rotate(k.rot);
          tg.drawImage(this.sprite(k.code, true), -L.cw / 2, -L.ch / 2, L.cw, L.ch);
          tg.restore();
          d += stampStep;
        }
        k.carry = d - dist;
        k.first = false; k.sx = k.x; k.sy = k.y;
      }
      ctx.save();
      ctx.globalAlpha = clamp(1 - (C.t - 7) / 2.5, 0, 1);
      ctx.drawImage(this.trail, 0, 0, W, H);
      ctx.restore();
      for (const k of C.cards) this.drawCardRaw(ctx, k.code, true, k.x, k.y, 1, 1, 0.5, k.rot);
    };

    G.draw = function (ctx, W, H) { const a = IP.alpha(), st = IP.push(ipg(), a); try { return drawRaw.call(G, ctx, W, H); } finally { IP.pop(st); } };

    G.hud = function () {
      const o = this.counts();
      return { score: `${this.won ? 52 : o.fnd} / 52`, detail: `Move ${this.moves} · ${o.fd} face-down` };
    };
    G.result = function () {
      if (this.won) return `Cleared all 52 cards in ${this.moves} moves (${this.style})`;
      return (this.endNote || 'No moves left') + ` (${this.style})`;
    };

    return G;
  }

  Arcade.register({
    id: 'solitaire', name: 'Solitaire', genre: 'Card game',
    aiNote: "Sees face-up cards and pile counts but never face-down cards or the stock order, and plays one move at a time at a human pace.",
    blurb: 'Klondike on burgundy felt. The AI plays only what it can see.',
    bg: '#3a0f17', accent: '#c9a24b', create,
  });
})();
