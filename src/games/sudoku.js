// sudoku.js — Ink & Paper. A hard sudoku solved by hand on a paper card under a desk lamp.
// The puzzle is generated at create() (unique solution; the solution itself is thrown away, only the
// givens are kept). THE AI is the `Pilot` object below: it is handed observe() = what is on the paper
// (the digits and the pencil marks) and answers with the next human technique, a guess, or a
// back-out. It never sees a solution and never runs a solver on hidden state. The game then performs
// the move at human pace (pen travel, handwriting reveal, batched eliminations).
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

  const SERIF = '"Fraunces", Georgia, "Times New Roman", serif';
  const MONO = '"IBM Plex Mono", ui-monospace, Menlo, Consolas, monospace';
  const LIMIT = 150;          // seconds of game time before the lamp is switched off (loss)
  const GUESSY = 0.82;        // chance that the puzzle needs bifurcation (not solvable by the technique list)

  // ------------------------------------------------------------------------------------ tables
  const ROW = new Uint8Array(81), COL = new Uint8Array(81), BOX = new Uint8Array(81);
  const UNITS = [];                    // 0-8 rows, 9-17 cols, 18-26 boxes
  for (let i = 0; i < 27; i++) UNITS.push([]);
  for (let i = 0; i < 81; i++) {
    ROW[i] = (i / 9) | 0; COL[i] = i % 9; BOX[i] = ((ROW[i] / 3) | 0) * 3 + ((COL[i] / 3) | 0);
    UNITS[ROW[i]].push(i); UNITS[9 + COL[i]].push(i); UNITS[18 + BOX[i]].push(i);
  }
  const SEES = new Uint8Array(81 * 81);
  const PEERS = [];
  for (let i = 0; i < 81; i++) {
    const p = [];
    for (let j = 0; j < 81; j++) {
      if (i !== j && (ROW[i] === ROW[j] || COL[i] === COL[j] || BOX[i] === BOX[j])) { p.push(j); SEES[i * 81 + j] = 1; }
    }
    PEERS.push(p);
  }
  const PC = new Uint8Array(512), LOW = new Uint8Array(512);
  for (let m = 1; m < 512; m++) { PC[m] = PC[m >> 1] + (m & 1); LOW[m] = (m & 1) ? 1 : LOW[m >> 1] + 1; }
  const BIT = d => 1 << (d - 1);
  const digs = m => { const a = []; for (let d = 1; m; d++, m >>= 1) if (m & 1) a.push(d); return '{' + a.join(' ') + '}'; };

  // ------------------------------------------------------------------------------------ generator
  function solveCount(g, limit) {
    const a = Uint8Array.from(g), rows = new Uint16Array(9), cols = new Uint16Array(9), boxes = new Uint16Array(9);
    for (let i = 0; i < 81; i++) if (a[i]) { const b = BIT(a[i]); rows[ROW[i]] |= b; cols[COL[i]] |= b; boxes[BOX[i]] |= b; }
    let count = 0;
    const rec = () => {
      let best = -1, bm = 0, bc = 10;
      for (let i = 0; i < 81; i++) {
        if (a[i]) continue;
        const m = ~(rows[ROW[i]] | cols[COL[i]] | boxes[BOX[i]]) & 511, c = PC[m];
        if (c < bc) { bc = c; best = i; bm = m; if (c <= 1) break; }
      }
      if (best < 0) { count++; return count >= limit; }
      if (bc === 0) return false;
      for (let d = 1; d <= 9; d++) {
        const b = BIT(d);
        if (!(bm & b)) continue;
        a[best] = d; rows[ROW[best]] |= b; cols[COL[best]] |= b; boxes[BOX[best]] |= b;
        const stop = rec();
        a[best] = 0; rows[ROW[best]] &= ~b; cols[COL[best]] &= ~b; boxes[BOX[best]] &= ~b;
        if (stop) return true;
      }
      return false;
    };
    rec();
    return count;
  }
  function fillRandom(a) {
    const rows = new Uint16Array(9), cols = new Uint16Array(9), boxes = new Uint16Array(9);
    const rec = () => {
      let best = -1, bm = 0, bc = 10;
      for (let i = 0; i < 81; i++) {
        if (a[i]) continue;
        const m = ~(rows[ROW[i]] | cols[COL[i]] | boxes[BOX[i]]) & 511, c = PC[m];
        if (c < bc) { bc = c; best = i; bm = m; if (c <= 1) break; }
      }
      if (best < 0) return true;
      if (bc === 0) return false;
      const ds = [];
      for (let d = 1; d <= 9; d++) if (bm & BIT(d)) ds.push(d);
      rnd.shuffle(ds);
      for (const d of ds) {
        const b = BIT(d);
        a[best] = d; rows[ROW[best]] |= b; cols[COL[best]] |= b; boxes[BOX[best]] |= b;
        if (rec()) return true;
        a[best] = 0; rows[ROW[best]] &= ~b; cols[COL[best]] &= ~b; boxes[BOX[best]] &= ~b;
      }
      return false;
    };
    rec();
  }
  // returns the givens only (Uint8Array(81), 0 = empty). The full grid is discarded here.
  function genPuzzle() {
    const sol = new Uint8Array(81);
    fillRandom(sol);
    const g = Uint8Array.from(sol);
    const order = [];
    for (let i = 0; i < 81; i++) order.push(i);
    rnd.shuffle(order);
    for (const i of order) {
      const a = g[i];
      g[i] = 0;
      if (solveCount(g, 2) !== 1) g[i] = a;
    }
    return g;
  }

  // ------------------------------------------------------------------------------------ technique solver
  // State S = { val: Uint8Array(81), cand: Uint16Array(81) } — exactly what is written on the paper.
  function placeIn(S, i, d) {
    S.val[i] = d; S.cand[i] = 0;
    const nb = ~BIT(d);
    const p = PEERS[i];
    for (let k = 0; k < p.length; k++) S.cand[p[k]] &= nb;
  }
  function stateFromGivens(g) {
    const S = { val: new Uint8Array(81), cand: new Uint16Array(81).fill(511) };
    for (let i = 0; i < 81; i++) if (g[i]) placeIn(S, i, g[i]);
    return S;
  }
  const mv = (lvl, label, o) => Object.assign({ lvl, label, place: null, elim: [], cells: [], units: [], keep: [] }, o);
  function combos(arr, N, fn) {
    const idx = [];
    const rec = s => {
      if (idx.length === N) return fn(idx.map(i => arr[i]));
      for (let i = s; i < arr.length; i++) { idx.push(i); const r = rec(i + 1); idx.pop(); if (r) return r; }
      return null;
    };
    return rec(0);
  }
  const marksOf = (c, m) => { const o = []; for (let d = 1; m; d++, m >>= 1) if (m & 1) o.push([c, d]); return o; };

  let NS_ORDER = Array.from({ length: 81 }, (_, i) => i);
  function fNakedSingle(S) {
    for (const i of NS_ORDER) {
      if (!S.val[i] && PC[S.cand[i]] === 1) return mv(0, 'Naked single', { place: [i, LOW[S.cand[i]]], cells: [i] });
    }
    return null;
  }
  let HS_ORDER = [18, 19, 20, 21, 22, 23, 24, 25, 26, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17];
  function fHiddenSingle(S) {
    for (const u of HS_ORDER) {
      const U = UNITS[u];
      for (let d = 1; d <= 9; d++) {
        const b = BIT(d);
        let n = 0, at = -1;
        for (let k = 0; k < 9; k++) if (S.cand[U[k]] & b) { n++; at = U[k]; }
        if (n === 1) return mv(1, 'Hidden single ' + d, { place: [at, d], cells: [at], units: [u] });
      }
    }
    return null;
  }
  function fNaked(S, N, lvl) {
    for (let u = 0; u < 27; u++) {
      const U = UNITS[u], cs = [];
      for (const c of U) if (!S.val[c]) { const n = PC[S.cand[c]]; if (n >= 2 && n <= N) cs.push(c); }
      if (cs.length < N) continue;
      const r = combos(cs, N, grp => {
        let un = 0;
        for (const c of grp) un |= S.cand[c];
        if (PC[un] !== N) return null;
        const el = [];
        for (const c of U) if (!S.val[c] && !grp.includes(c)) el.push(...marksOf(c, S.cand[c] & un));
        if (!el.length) return null;
        const keep = [];
        for (const c of grp) keep.push(...marksOf(c, S.cand[c]));
        return mv(lvl, (N === 2 ? 'Naked pair ' : 'Naked triple ') + digs(un), { cells: grp.slice(), units: [u], elim: el, keep });
      });
      if (r) return r;
    }
    return null;
  }
  function fHidden(S, N, lvl) {
    for (let u = 0; u < 27; u++) {
      const U = UNITS[u], pm = [], ds = [];
      for (let d = 1; d <= 9; d++) {
        const b = BIT(d);
        let m = 0;
        for (let k = 0; k < 9; k++) if (S.cand[U[k]] & b) m |= 1 << k;
        pm[d] = m;
        if (PC[m] >= 2 && PC[m] <= N) ds.push(d);
      }
      if (ds.length < N) continue;
      const r = combos(ds, N, grp => {
        let un = 0, dm = 0;
        for (const d of grp) { un |= pm[d]; dm |= BIT(d); }
        if (PC[un] !== N) return null;
        const el = [], keep = [], cells = [];
        for (let k = 0; k < 9; k++) {
          if (!((un >> k) & 1)) continue;
          const c = U[k];
          cells.push(c);
          el.push(...marksOf(c, S.cand[c] & ~dm));
          keep.push(...marksOf(c, S.cand[c] & dm));
        }
        if (!el.length) return null;
        return mv(lvl, (N === 2 ? 'Hidden pair ' : 'Hidden triple ') + digs(dm), { cells, units: [u], elim: el, keep });
      });
      if (r) return r;
    }
    return null;
  }
  function fPointing(S) {
    for (let b = 0; b < 9; b++) {
      const U = UNITS[18 + b];
      for (let d = 1; d <= 9; d++) {
        const m = BIT(d), cells = U.filter(c => S.cand[c] & m);
        if (cells.length < 2) continue;
        for (const [same, base] of [[ROW, 0], [COL, 9]]) {
          const k0 = same[cells[0]];
          if (!cells.every(c => same[c] === k0)) continue;
          const el = [];
          for (const c of UNITS[base + k0]) if (BOX[c] !== b && (S.cand[c] & m)) el.push([c, d]);
          if (el.length) return mv(4, 'Pointing ' + (cells.length === 2 ? 'pair ' : 'triple ') + d, { cells, units: [18 + b, base + k0], elim: el, keep: cells.map(c => [c, d]) });
        }
      }
    }
    return null;
  }
  function fBoxLine(S) {
    for (let u = 0; u < 18; u++) {
      const U = UNITS[u];
      for (let d = 1; d <= 9; d++) {
        const m = BIT(d), cells = U.filter(c => S.cand[c] & m);
        if (cells.length < 2) continue;
        const bx = BOX[cells[0]];
        if (!cells.every(c => BOX[c] === bx)) continue;
        const el = [];
        for (const c of UNITS[18 + bx]) if (!U.includes(c) && (S.cand[c] & m)) el.push([c, d]);
        if (el.length) return mv(5, 'Box-line reduction ' + d, { cells, units: [u, 18 + bx], elim: el, keep: cells.map(c => [c, d]) });
      }
    }
    return null;
  }
  function fFish(S, N, lvl) {
    for (let d = 1; d <= 9; d++) {
      const b = BIT(d);
      for (let o = 0; o < 2; o++) {
        const lines = [];
        for (let r = 0; r < 9; r++) {
          let m = 0;
          for (let c = 0; c < 9; c++) if (S.cand[o ? c * 9 + r : r * 9 + c] & b) m |= 1 << c;
          if (PC[m] >= 2 && PC[m] <= N) lines.push({ r, m });
        }
        if (lines.length < N) continue;
        const res = combos(lines, N, grp => {
          let un = 0;
          for (const l of grp) un |= l.m;
          if (PC[un] !== N) return null;
          const baseSet = grp.map(l => l.r), el = [], keep = [];
          for (let k = 0; k < 9; k++) {
            if (!((un >> k) & 1)) continue;
            for (let r = 0; r < 9; r++) {
              const cell = o ? k * 9 + r : r * 9 + k;
              if (!(S.cand[cell] & b)) continue;
              if (baseSet.includes(r)) keep.push([cell, d]); else el.push([cell, d]);
            }
          }
          if (!el.length) return null;
          const units = [];
          for (const l of grp) units.push((o ? 9 : 0) + l.r);
          for (let k = 0; k < 9; k++) if ((un >> k) & 1) units.push((o ? 0 : 9) + k);
          return mv(lvl, (N === 2 ? 'X-Wing ' : 'Swordfish ') + d, { cells: keep.map(x => x[0]), units, elim: el, keep });
        });
        if (res) return res;
      }
    }
    return null;
  }
  function fXYWing(S) {
    for (let p = 0; p < 81; p++) {
      if (S.val[p] || PC[S.cand[p]] !== 2) continue;
      const pm = S.cand[p], pr = PEERS[p];
      for (let ai = 0; ai < pr.length; ai++) {
        const a = pr[ai], ca = S.cand[a];
        if (S.val[a] || PC[ca] !== 2 || PC[ca & pm] !== 1) continue;
        const z = ca & ~pm, need = (pm & ~(ca & pm)) | z;
        for (let bi = ai + 1; bi < pr.length; bi++) {
          const b = pr[bi];
          if (S.val[b] || S.cand[b] !== need) continue;
          const el = [];
          for (let t = 0; t < 81; t++) {
            if (t === p || t === a || t === b || S.val[t] || !(S.cand[t] & z)) continue;
            if (SEES[t * 81 + a] && SEES[t * 81 + b]) el.push([t, LOW[z]]);
          }
          if (el.length) {
            return mv(10, 'XY-Wing ' + digs(pm | z), { cells: [p, a, b], units: [], elim: el, keep: [...marksOf(p, pm), ...marksOf(a, ca), ...marksOf(b, S.cand[b])] });
          }
        }
      }
    }
    return null;
  }
  const FIND = [
    fNakedSingle, fHiddenSingle, S => fNaked(S, 2, 2), S => fHidden(S, 2, 3), fPointing, fBoxLine,
    S => fNaked(S, 3, 6), S => fHidden(S, 3, 7), S => fFish(S, 2, 8), S => fFish(S, 3, 9), fXYWing,
  ];
  const DEF_HS = HS_ORDER, DEF_NS = NS_ORDER;
  // pencil-mark heavy: cleans the notes (pointing, box-line, pairs) before looking for hidden singles
  const FIND_PENCIL = [FIND[0], FIND[4], FIND[5], FIND[2], FIND[1], FIND[3], FIND[6], FIND[7], FIND[8], FIND[9], FIND[10]];
  function applyMove(S, m) {
    if (m.place) placeIn(S, m.place[0], m.place[1]);
    else for (const [c, d] of m.elim) S.cand[c] &= ~BIT(d);
  }
  function findContradiction(S) {
    for (let i = 0; i < 81; i++) if (!S.val[i] && S.cand[i] === 0) return { cell: i, unit: -1 };
    for (let u = 0; u < 27; u++) {
      let seen = 0;
      for (const c of UNITS[u]) seen |= S.val[c] ? BIT(S.val[c]) : S.cand[c];
      if (seen !== 511) {
        const miss = ~seen & 511;
        const c = UNITS[u].find(x => !S.val[x]) ?? UNITS[u][0];
        return { cell: c, unit: u, digit: LOW[miss] };
      }
    }
    return null;
  }
  function countEmpty(S) { let n = 0; for (let i = 0; i < 81; i++) if (!S.val[i]) n++; return n; }

  // Grade a puzzle by running the technique list with no guessing.
  function grade(g) {
    const S = stateFromGivens(g);
    let maxLvl = 0, est = 4;
    for (let n = 0; n < 300; n++) {
      if (!countEmpty(S)) return { solved: true, maxLvl, empties: 0, est };
      let m = null;
      for (let l = 0; l < FIND.length && !m; l++) m = FIND[l](S);
      if (!m) break;
      if (m.lvl > maxLvl) maxLvl = m.lvl;
      est += THINK[m.lvl] + Math.max(SHOWD[m.lvl], 0.2) + (m.place ? 0.2 : 0.2 + 0.075 * Math.min(m.elim.length, 8));
      applyMove(S, m);
    }
    return { solved: countEmpty(S) === 0, maxLvl, empties: countEmpty(S), est };
  }
  function makePuzzle(hard) {
    const t0 = performance.now(), wantGuess = hard ? true : Math.random() < GUESSY;
    let best = null, bestSc = -1;
    for (let n = 0; n < 400; n++) {
      const g = genPuzzle(), gr = grade(g);
      const ok = hard ? (wantGuess ? (!gr.solved && gr.empties >= 50) : false)
        : wantGuess ? (!gr.solved && gr.empties >= 42) : (gr.solved && gr.maxLvl >= 4);
      if (ok) return g;
      if (hard) { const sc = gr.solved ? gr.est + gr.maxLvl * 20 : 300 + gr.empties * 5; if (sc > bestSc) { bestSc = sc; best = g; } }
      else if (!best) best = g;
      if (performance.now() - t0 > (hard ? 2200 : 1100)) break;
    }
    return best;
  }

  // ------------------------------------------------------------------------------------ THE AI
  // Pilot.decide(obs): obs = { val: Uint8Array(81), cand: Uint16Array(81) } — the digits and pencil
  // marks currently visible on the paper (nothing else). It returns one of
  //   { type:'move', move }   a technique step (place a digit or strike pencil marks)
  //   { type:'guess', cell, d }   no technique applies: pick a bivalue cell and write a guess in red
  //   { type:'undo', val, cand, flash }   a contradiction is visible: erase back to before the last
  //                                       guess (its own notes of the page at that time) and cross
  //                                       the guessed digit out of that cell.
  const Pilot = {
    stack: [], style: 'Row scanner',
    // Styles: Row scanner (sweeps rows, then columns, then boxes), Tightest region (works the
    // unit with the fewest blanks), Note keeper (tidies pencil marks with pointing/box-line/pairs first).
    reset(sup) { this.stack.length = 0; this.style = sup ? 'Super AI' : ['Row scanner', 'Tightest region', 'Note keeper'][Math.floor(Math.random() * 3)]; },
    decide(obs) {
      const bad = findContradiction(obs);
      if (bad) {
        const top = this.stack.pop();
        if (!top) return { type: 'dead', flash: bad };
        const cand = top.cand.slice();
        cand[top.cell] &= ~BIT(top.d);
        return { type: 'undo', val: top.val.slice(), cand, flash: bad, cell: top.cell, d: top.d };
      }
      const sty = this.style, find = sty === 'Note keeper' ? FIND_PENCIL : FIND;
      if (sty === 'Row scanner') {
        HS_ORDER = Array.from({ length: 27 }, (_, k) => k);
      } else if (sty === 'Tightest region') {
        // work the unit (row/col/box) with the fewest empty cells first (random tie-break)
        const emp = u => UNITS[u].reduce((n, c) => n + (obs.val[c] ? 0 : 1), 0);
        const us = [...Array(27).keys()].map(u => ({ u, e: emp(u) || 99, r: Math.random() })).sort((a, b) => a.e - b.e || a.r - b.r);
        HS_ORDER = us.map(x => x.u);
        const ce = c => Math.min(emp(ROW[c]), emp(9 + COL[c]), emp(18 + BOX[c]));
        NS_ORDER = Array.from({ length: 81 }, (_, i) => ({ i, e: ce(i), r: Math.random() })).sort((a, b) => a.e - b.e || a.r - b.r).map(x => x.i);
      }
      try {
        for (let l = 0; l < find.length; l++) {
          const m = find[l](obs);
          if (m) return { type: 'move', move: m, lvl: m.lvl };
        }
      } finally { HS_ORDER = DEF_HS; NS_ORDER = DEF_NS; }
      // stuck: guess on a bivalue cell that is well connected to other bivalue cells
      let best = [], bs = -1;
      for (let i = 0; i < 81; i++) {
        if (obs.val[i]) continue;
        const n = PC[obs.cand[i]];
        let sc = (10 - n) * 100;
        for (const p of PEERS[i]) if (!obs.val[p] && PC[obs.cand[p]] === 2) sc += 3;
        if (sc > bs) { bs = sc; best = [i]; } else if (sc === bs) best.push(i);
      }
      const cell = rnd.pick(best), ds = [];
      for (let d = 1; d <= 9; d++) if (obs.cand[cell] & BIT(d)) ds.push(d);
      const d = rnd.pick(ds);
      this.stack.push({ val: obs.val.slice(), cand: obs.cand.slice(), cell, d });
      return { type: 'guess', cell, d };
    },
  };

  // ------------------------------------------------------------------------------------ pacing
  //            naked  hidden  NP    HP    point  boxln NT    HT    xwing swordf xy
  const THINK = [0.42, 1.5, 2.2, 2.5, 2.2, 2.2, 3.0, 3.3, 3.6, 4.0, 3.7];
  const SHOWD = [0.14, 0.45, 1.1, 1.1, 1.1, 1.1, 1.3, 1.3, 1.4, 1.6, 1.5];

  // ------------------------------------------------------------------------------------ helpers
  const mixRGB = (a, b, t) => `rgb(${(a[0] + (b[0] - a[0]) * t) | 0},${(a[1] + (b[1] - a[1]) * t) | 0},${(a[2] + (b[2] - a[2]) * t) | 0})`;
  const INK_WET = [52, 90, 214], INK_DRY = [28, 46, 126];
  const RED_WET = [226, 70, 50], RED_DRY = [168, 36, 28];
  const mmss = s => { s = Math.max(0, s | 0); return ((s / 60) | 0) + ':' + String(s % 60).padStart(2, '0'); };

  function buildDesk(W, H, s) {
    const c = document.createElement('canvas');
    c.width = Math.ceil(W * s); c.height = Math.ceil(H * s);
    const x = c.getContext('2d');
    x.scale(s, s);
    const g = x.createLinearGradient(0, 0, W, H);
    g.addColorStop(0, '#2b1b11'); g.addColorStop(0.5, '#22150d'); g.addColorStop(1, '#170e08');
    x.fillStyle = g; x.fillRect(0, 0, W, H);
    // wood grain
    for (let k = 0; k < 280; k++) {
      const y0 = Math.random() * H, amp = 2 + Math.random() * 10, f = 0.002 + Math.random() * 0.004, ph = Math.random() * 6;
      x.strokeStyle = Math.random() < 0.55 ? `rgba(255,190,130,${0.012 + Math.random() * 0.03})` : `rgba(0,0,0,${0.05 + Math.random() * 0.08})`;
      x.lineWidth = 0.6 + Math.random() * 2.2;
      x.beginPath();
      for (let px = -10; px <= W + 10; px += 24) {
        const py = y0 + Math.sin(px * f + ph) * amp + Math.sin(px * f * 3.1 + ph * 2) * amp * 0.25;
        if (px < 0) x.moveTo(px, py); else x.lineTo(px, py);
      }
      x.stroke();
    }
    // plank seams
    x.fillStyle = 'rgba(0,0,0,0.28)';
    const planks = Math.max(3, Math.round(H / 260));
    for (let k = 1; k < planks; k++) x.fillRect(0, (H / planks) * k + (Math.random() - 0.5) * 6, W, 2);
    // coffee ring
    const rx = W * 0.14, ry = H * 0.2, rr = Math.min(W, H) * 0.045;
    x.strokeStyle = 'rgba(20,8,2,0.30)'; x.lineWidth = rr * 0.09;
    x.beginPath(); x.arc(rx, ry, rr, 0.3, TAU - 0.5); x.stroke();
    x.strokeStyle = 'rgba(120,70,30,0.10)'; x.lineWidth = rr * 0.2;
    x.beginPath(); x.arc(rx, ry, rr * 0.96, 0.5, TAU - 0.9); x.stroke();
    // pencil
    x.save();
    x.translate(W * 0.9, H * 0.84); x.rotate(-0.36);
    const L = Math.min(W, H) * 0.34, T = Math.min(W, H) * 0.017;
    x.fillStyle = 'rgba(0,0,0,0.35)'; x.fillRect(-L / 2 + 5, -T / 2 + 7, L, T);
    x.fillStyle = '#c9902f'; x.fillRect(-L / 2, -T / 2, L * 0.86, T);
    x.fillStyle = '#e1a93e'; x.fillRect(-L / 2, -T / 2, L * 0.86, T * 0.36);
    x.fillStyle = '#a8731f'; x.fillRect(-L / 2, T * 0.18, L * 0.86, T * 0.32);
    x.fillStyle = '#9aa0a8'; x.fillRect(-L / 2 - T * 0.5, -T / 2, T * 0.5, T);
    x.fillStyle = '#c96a6a'; x.fillRect(-L / 2 - T * 1.1, -T / 2, T * 0.6, T);
    x.fillStyle = '#e6c58f';
    x.beginPath(); x.moveTo(L * 0.34, -T / 2); x.lineTo(L * 0.5, 0); x.lineTo(L * 0.34, T / 2); x.closePath(); x.fill();
    x.fillStyle = '#3a3a40';
    x.beginPath(); x.moveTo(L * 0.455, -T * 0.16); x.lineTo(L * 0.5, 0); x.lineTo(L * 0.455, T * 0.16); x.closePath(); x.fill();
    x.restore();
    // vignette
    const v = x.createRadialGradient(W * 0.45, H * 0.42, Math.min(W, H) * 0.3, W * 0.5, H * 0.5, Math.max(W, H) * 0.78);
    v.addColorStop(0, 'rgba(0,0,0,0)'); v.addColorStop(1, 'rgba(0,0,0,0.62)');
    x.fillStyle = v; x.fillRect(0, 0, W, H);
    return c;
  }
  function buildPaper(cw, ch, s) {
    const c = document.createElement('canvas');
    c.width = Math.ceil(cw * s); c.height = Math.ceil(ch * s);
    const x = c.getContext('2d');
    x.scale(s, s);
    const g = x.createLinearGradient(0, 0, cw, ch);
    g.addColorStop(0, '#f7f0de'); g.addColorStop(0.6, '#efe6cf'); g.addColorStop(1, '#e6dbc0');
    roundRect(x, 0, 0, cw, ch, 5); x.fillStyle = g; x.fill();
    x.save(); roundRect(x, 0, 0, cw, ch, 5); x.clip();
    const n = Math.round(cw * ch / 260);
    for (let k = 0; k < n; k++) {
      const px = Math.random() * cw, py = Math.random() * ch, len = 3 + Math.random() * 16, a = Math.random() * TAU;
      x.strokeStyle = Math.random() < 0.65 ? `rgba(110,88,56,${0.025 + Math.random() * 0.05})` : `rgba(255,255,255,${0.1 + Math.random() * 0.14})`;
      x.lineWidth = 0.5 + Math.random() * 0.5;
      x.beginPath(); x.moveTo(px, py);
      x.quadraticCurveTo(px + Math.cos(a + 1) * len * 0.5, py + Math.sin(a + 1) * len * 0.5, px + Math.cos(a) * len, py + Math.sin(a) * len);
      x.stroke();
    }
    for (let k = 0; k < n * 0.8; k++) {
      x.fillStyle = `rgba(100,80,50,${Math.random() * 0.08})`;
      x.fillRect(Math.random() * cw, Math.random() * ch, 1, 1);
    }
    const v = x.createRadialGradient(cw / 2, ch / 2, Math.min(cw, ch) * 0.35, cw / 2, ch / 2, Math.max(cw, ch) * 0.75);
    v.addColorStop(0, 'rgba(120,90,50,0)'); v.addColorStop(1, 'rgba(120,90,50,0.2)');
    x.fillStyle = v; x.fillRect(0, 0, cw, ch);
    x.restore();
    x.strokeStyle = 'rgba(255,255,255,0.5)'; x.lineWidth = 1;
    roundRect(x, 0.5, 0.5, cw - 1, ch - 1, 5); x.stroke();
    return c;
  }
  function buildShadow(cw, ch, pad) {
    const c = document.createElement('canvas');
    c.width = Math.ceil(cw + pad * 2); c.height = Math.ceil(ch + pad * 2);
    const x = c.getContext('2d');
    x.shadowColor = 'rgba(0,0,0,0.85)'; x.shadowBlur = pad * 0.7; x.shadowOffsetX = 4000;
    x.fillStyle = '#000';
    x.fillRect(pad - 4000, pad, cw, ch);
    return c;
  }

  // ------------------------------------------------------------------------------------ the game
  class SudokuGame {
    constructor(opts = {}) {
      this.sup = !!opts.superAI; if (this.sup) this.superAI = true;
      const TW = [{ key: 'hard', name: 'Hard puzzle', desc: 'A nastier puzzle that needs bold guesses, and a shorter deadline.' }];
      if (opts.twist) this.twist = TW[0];
      this.limit = this.twist ? 118 : LIMIT;
      this.givens = makePuzzle(!!this.twist);                 // givens only; there is no stored solution
      const S = stateFromGivens(this.givens);
      this.val = S.val; this.cand = S.cand;
      this.isGiven = new Uint8Array(81);
      for (let i = 0; i < 81; i++) this.isGiven[i] = this.givens[i] ? 1 : 0;
      this.nGivens = this.isGiven.reduce((a, b) => a + b, 0);
      // views
      this.tw = new Float32Array(81).fill(-1e9);       // time a hand-written digit started
      this.red = new Uint8Array(81);
      this.rot = new Float32Array(81); this.jx = new Float32Array(81); this.jy = new Float32Array(81);
      for (let i = 0; i < 81; i++) { this.rot[i] = rnd.float(-0.08, 0.08); this.jx[i] = rnd.float(-0.025, 0.025); this.jy[i] = rnd.float(-0.02, 0.025); }
      this.appT = new Float32Array(729).fill(Infinity);
      this.strT = new Float32Array(729).fill(-1);
      this.strK = new Uint8Array(729);
      this.flagKeep = new Uint8Array(729); this.flagElim = new Uint8Array(729);
      this.ghosts = [];
      this.hl = { cells: [], units: [], tgt: [], col: '255,222,70' };
      this.hlA = 0; this.hlGoal = 0;
      this.label = null;
      this.particles = new Particles();
      this.motes = [];
      for (let i = 0; i < 40; i++) this.motes.push({ x: Math.random(), y: Math.random(), s: rnd.float(0.8, 2.2), ph: Math.random() * 6, sp: rnd.float(0.03, 0.09), a: rnd.float(0.25, 0.8) });
      this.pen = { x: 4.5, y: -1.2, fx: 0, fy: 0, tx: 0, ty: 0, t: 0, dur: 1, act: false, lift: 0 };
      this.penTo(4.5, 4.5, 0.9);
      Pilot.reset(this.sup); this.style = Pilot.style;
      this.t = 0; this.time = 0; this.endT = 0;
      this.over = false; this.won = false; this.why = '';
      this.ph = 'start'; this.pt = 0; this.plan = null; this.thinkDur = 0; this.execDur = 0; this.execK = 0;
      this.sweepI = 0; this.sweepAcc = 0;
      this.guesses = 0; this.backouts = 0; this.moves = 0;
      this.stats = { maxLvl: 0 };
      this.W = 0; this.H = 0;
    }

    // ---------------- layout
    resize(W, H) {
      this.W = W; this.H = H;
      const g = Math.min(H * 0.86 / 1.14, W * 0.86 / 1.1);
      this.g = g; this.cs = g / 9; this.cw = g * 1.1; this.ch = g * 1.14;
      this.cx = W / 2; this.cy = H / 2 - H * 0.012;
      this.gx0 = -g / 2; this.gy0 = -this.ch / 2 + g * 0.078;
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      this.desk = buildDesk(W, H, Math.min(dpr, 1.5));
      this.paper = buildPaper(this.cw, this.ch, Math.min(dpr, 2));
      this.shadowPad = g * 0.12;
      this.shadow = buildShadow(this.cw, this.ch, this.shadowPad);
      const cs = this.cs;
      this.fGiven = `600 ${(cs * 0.64).toFixed(1)}px ${SERIF}`;
      this.fHand = `italic 500 ${(cs * 0.62).toFixed(1)}px ${SERIF}`;
      this.fMark = `500 ${(cs * 0.235).toFixed(1)}px ${MONO}`;
      this.fMarkB = `700 ${(cs * 0.25).toFixed(1)}px ${MONO}`;
      this.fLabel = `italic 600 ${(g * 0.034).toFixed(1)}px ${SERIF}`;
    }
    cellX(i) { return (COL[i] + 0.5); }
    cellY(i) { return (ROW[i] + 0.5); }
    toScreen(lx, ly) {
      const a = -0.026, ca = Math.cos(a), sa = Math.sin(a);
      return [this.cx + lx * ca - ly * sa, this.cy + lx * sa + ly * ca];
    }

    // ---------------- pen
    penTo(x, y, dur) {
      const p = this.pen;
      p.fx = p.x; p.fy = p.y; p.tx = x; p.ty = y; p.t = 0; p.dur = Math.max(0.001, dur); p.act = true;
    }
    penToCell(i, dur) {
      const d = dur ?? Math.min(0.5, 0.09 + 0.032 * Math.hypot(this.cellX(i) - this.pen.x, this.cellY(i) - this.pen.y));
      this.penTo(this.cellX(i), this.cellY(i), d);
      return d;
    }
    updatePen(dt) {
      const p = this.pen;
      if (!p.act) { p.lift = Math.max(0, p.lift - dt * 6); return; }
      p.t += dt;
      const k = clamp(p.t / p.dur, 0, 1), e = ease.inOutCubic(k);
      p.x = lerp(p.fx, p.tx, e); p.y = lerp(p.fy, p.ty, e);
      p.lift = Math.sin(k * Math.PI);
      if (k >= 1) p.act = false;
    }

    // ---------------- AI plumbing
    observe() { return { val: this.val.slice(), cand: this.cand.slice() }; }
    filled() { let n = 0; for (let i = 0; i < 81; i++) if (this.val[i]) n++; return n; }

    enterThink(extra = 0) {
      this.ph = 'think'; this.pt = 0;
      this.plan = Pilot.decide(this.observe());
      const pl = this.plan;
      if (pl.type === 'move') this.thinkDur = THINK[pl.lvl] + extra;
      else if (pl.type === 'guess') this.thinkDur = 2.6;
      else this.thinkDur = 0.45;
      this.thinkDur *= rnd.float(0.85, 1.15);
      this.thinkDur = this.sup ? 0.02 : Math.max(0.05, this.thinkDur);   // Super AI: no thinking time
      this.thinkPath = null;
      if (pl.type === 'move' && pl.move.units.length) {
        const U = UNITS[pl.move.units[0]];
        this.thinkPath = pl.move.units[0] >= 18 ? [U[0], U[2], U[3 + 0], U[5], U[6], U[8]] : U;
      }
      this.hlGoal = 0;
    }
    setLabel(text, col) { this.label = { text, t0: this.t, clear: -1, col: col || '#2a3560' }; }
    clearLabel() { if (this.label && this.label.clear < 0) this.label.clear = this.t; }

    setHighlight(cells, units, tgt, col, keep, elim) {
      this.hl = { cells, units, tgt, col };
      this.flagKeep.fill(0); this.flagElim.fill(0);
      for (const [c, d] of keep || []) this.flagKeep[c * 9 + d - 1] = 1;
      for (const [c, d] of elim || []) this.flagElim[c * 9 + d - 1] = 1;
      this.hlGoal = 1;
    }

    beginShow() {
      const pl = this.plan;
      this.ph = 'show'; this.pt = 0;
      if (pl.type === 'move') {
        const m = pl.move;
        this.setLabel(m.label);
        const tgt = [...new Set(m.elim.map(x => x[0]))];
        this.setHighlight(m.cells, m.units, tgt, '255,222,70', m.keep, m.elim);
        const first = m.place ? m.place[0] : (m.cells[0] ?? m.elim[0][0]);
        const trav = this.penToCell(m.place ? m.place[0] : first);
        this.showDur = this.sup ? Math.max(0.06, trav + 0.02) : Math.max(SHOWD[pl.lvl], trav + 0.02);
      } else if (pl.type === 'guess') {
        this.setLabel('Stuck. Try a guess', '#a8231a');
        this.setHighlight([pl.cell], [], [], '255,170,90', [], []);
        this.showDur = this.sup ? Math.max(0.15, this.penToCell(pl.cell) + 0.05) : Math.max(0.8, this.penToCell(pl.cell) + 0.3);
      } else if (pl.type === 'undo') {
        this.setLabel('Contradiction. Back out', '#a8231a');
        const cells = pl.flash.unit >= 0 ? [pl.flash.cell] : [pl.flash.cell];
        this.setHighlight(cells, pl.flash.unit >= 0 ? [pl.flash.unit] : [], [], '255,80,80', [], []);
        this.showDur = this.sup ? Math.max(0.25, this.penToCell(pl.flash.cell) + 0.1) : Math.max(1.0, this.penToCell(pl.flash.cell) + 0.5);
      } else {
        this.showDur = 0.5;
      }
    }

    applyPlace(i, d, red) {
      const t = this.t;
      // own pencil marks fade away, peers' marks for d are wiped in a quick ripple
      for (let k = 0; k < 9; k++) if ((this.cand[i] >> k) & 1) { this.strT[i * 9 + k] = t + 0.04; this.strK[i * 9 + k] = 2; }
      for (const p of PEERS[i]) {
        if (!this.val[p] && (this.cand[p] & BIT(d))) {
          const idx = p * 9 + d - 1;
          this.strT[idx] = t + 0.08 + 0.018 * Math.hypot(ROW[p] - ROW[i], COL[p] - COL[i]); this.strK[idx] = 2;
        }
      }
      placeIn({ val: this.val, cand: this.cand }, i, d);
      this.tw[i] = t; this.red[i] = red ? 1 : 0;
      this.rot[i] = rnd.float(-0.08, 0.08);
      this.penToCell(i, 0.001);
      this.moves++;
    }
    applyElims(list) {
      const t = this.t;
      let k = 0;
      for (const [c, d] of list) {
        this.cand[c] &= ~BIT(d);
        const idx = c * 9 + d - 1;
        this.strT[idx] = t + (this.sup ? 0.02 + k * 0.02 : 0.06 + k * 0.075); this.strK[idx] = 1;
        k++;
      }
      this.moves++;
    }
    applyUndo(pl) {
      const t = this.t;
      for (let i = 0; i < 81; i++) {
        if (this.val[i] && !pl.val[i] && !this.isGiven[i]) {
          this.ghosts.push({ i, d: this.val[i], red: this.red[i], t0: t + 0.02 * ((ROW[i] + COL[i]) % 5) });
          this.tw[i] = -1e9; this.red[i] = 0;
        }
      }
      for (let i = 0; i < 81; i++) {
        for (let k = 0; k < 9; k++) {
          const nowBit = (pl.cand[i] >> k) & 1, wasBit = (this.cand[i] >> k) & 1, idx = i * 9 + k;
          if (nowBit && !wasBit) { this.strT[idx] = -1; this.appT[idx] = t + 0.35 + 0.01 * ((i * 7 + k * 3) % 30); }
          if (!nowBit && (this.cand[i] === 0 || wasBit) && i === pl.cell && k === pl.d - 1) { this.strT[idx] = t + 0.5; this.strK[idx] = 1; }
        }
      }
      this.val.set(pl.val); this.cand.set(pl.cand);
      // the wrong guess digit must still be visible until crossed out
      this.backouts++;
    }

    finish(won, why) {
      if (this.over) return;
      this.over = true; this.won = won; this.why = why || ''; this.endT = 0;
      this.hlGoal = 0;
      this.clearLabel();
    }

    // ---------------- simulation
    _ipg() { return [[[this.pen], ['x', 'y'], 200], [[this], ['t'], 0, 't']]; }
    step(dt) {
      IP.snap(this._ipg());
      this.time += dt;
      this.particles.update(dt);
      this.hlA += (this.hlGoal - this.hlA) * Math.min(1, dt * 9);
      this.updatePen(dt);
      for (let i = this.ghosts.length - 1; i >= 0; i--) if (this.t - this.ghosts[i].t0 > 1.3) this.ghosts.splice(i, 1);
      if (this.over) {
        this.endT += dt;
        if (this.won && this.endT < 1.6 && Math.random() < 0.55) {
          const i = rnd.int(81), [sx, sy] = this.toScreen(this.gx0 + this.cellX(i) * this.cs, this.gy0 + this.cellY(i) * this.cs);
          this.particles.burst(sx, sy, 3, { speed: 90, speedMin: 20, life: 1.0, size: 2.4, color: ['#ffd98a', '#fff1c8', '#a7e6b8'], drag: 1.6, gravity: -10 });
        }
        return;
      }
      this.t += dt;
      this.pt += dt;
      if (this.t >= this.limit) { this.finish(false, 'Out of time'); return; }
      switch (this.ph) {
        case 'start':
          if (this.pt > (this.sup ? 0.4 : 1.0)) { this.ph = 'sweep'; this.pt = 0; this.sweepAcc = 0; this.sweepI = 0; }
          break;
        case 'sweep': {
          this.sweepAcc += dt;
          const sw = this.sup ? 0.008 : 0.032;
          while (this.sweepAcc >= sw && this.sweepI < 81) {
            this.sweepAcc -= sw;
            const i = this.sweepI++;
            if (this.isGiven[i]) continue;
            for (let d = 0; d < 9; d++) this.appT[i * 9 + d] = this.t + d * 0.012;
            this.penToCell(i, this.sup ? 0.01 : 0.05);
          }
          if (this.sweepI >= 81) this.enterThink(this.sup ? 0 : 0.2);
          break;
        }
        case 'think':
          if (this.thinkPath) {
            const P = this.thinkPath, f = clamp(this.pt / (this.thinkDur * 0.9), 0, 1) * (P.length - 1), k = Math.min(P.length - 2, f | 0), u = f - k;
            if (P.length > 1) {
              const a = P[k], b = P[k + 1];
              this.pen.act = false;
              this.pen.x = lerp(this.cellX(a), this.cellX(b), ease.inOutCubic(u)); this.pen.y = lerp(this.cellY(a), this.cellY(b), ease.inOutCubic(u));
            }
          }
          if (this.pt >= this.thinkDur) this.beginShow();
          break;
        case 'show':
          if (this.pt >= this.showDur) this.beginExec();
          break;
        case 'exec':
          if (this.plan.type === 'move' && !this.plan.move.place) {
            const el = this.plan.move.elim;
            const eg = this.sup ? 0.02 : 0.075;
            while (this.execK < el.length && this.pt >= (this.sup ? 0.02 : 0.06) + this.execK * eg) {
              this.penToCell(el[this.execK][0], this.sup ? 0.02 : 0.07); this.execK++;
            }
          }
          if (this.pt >= this.execDur) this.endExec();
          break;
      }
    }
    beginExec() {
      const pl = this.plan;
      this.ph = 'exec'; this.pt = 0; this.execK = 0;
      if (pl.type === 'move') {
        const m = pl.move;
        if (m.place) { this.applyPlace(m.place[0], m.place[1], false); this.execDur = this.sup ? 0.08 : 0.2; }
        else { this.applyElims(m.elim); this.execDur = this.sup ? 0.06 + 0.02 * Math.min(m.elim.length, 8) : 0.2 + 0.075 * Math.min(m.elim.length, 8); }
        if (pl.lvl > this.stats.maxLvl) this.stats.maxLvl = pl.lvl;
      } else if (pl.type === 'guess') {
        this.guesses++;
        this.applyPlace(pl.cell, pl.d, true);
        this.execDur = this.sup ? 0.12 : 0.4;
      } else if (pl.type === 'undo') {
        this.applyUndo(pl);
        this.execDur = this.sup ? 0.5 : 1.0;
      } else {
        this.finish(false, 'Dead end');
      }
    }
    endExec() {
      this.hlGoal = 0;
      this.clearLabel();
      if (this.filled() === 81 && !findContradiction({ val: this.val, cand: this.cand })) {
        this.ph = 'done';
        this.finish(true);
        return;
      }
      this.enterThink();
    }

    // ---------------- HUD
    hud() {
      return { score: `${this.filled()}/81`, detail: `${mmss(this.t)} · ${this.guesses} guess${this.guesses === 1 ? '' : 'es'}` };
    }
    result() {
      if (this.won) return `Solved in ${mmss(this.t)} with ${this.guesses} guess${this.guesses === 1 ? '' : 'es'}${this.backouts ? ` (${this.backouts} backed out)` : ''} (${this.style})`;
      if (this.why === 'Out of time') return `Out of time with ${81 - this.filled()} cells open after ${this.guesses} guesses (${this.style})`;
      return this.why || 'Puzzle unfinished';
    }

    // ---------------- drawing
    draw(ctx, W, H) {
      const a = IP.alpha();
      const st = IP.push(this._ipg(), a);
      try { this._draw(ctx, W, H); } finally { IP.pop(st); }
    }
    _draw(ctx, W, H) {
      if (W !== this.W || H !== this.H) this.resize(W, H);
      const t = this.t, tm = this.time;
      const lossK = this.over && !this.won ? ease.outCubic(clamp(this.endT / 1.6, 0, 1)) : 0;
      const winK = this.over && this.won ? ease.outCubic(clamp(this.endT / 0.9, 0, 1)) : 0;

      // desk
      ctx.drawImage(this.desk, 0, 0, W, H);
      // lamp pool
      const lx = W * (0.42 + Math.sin(tm * 0.17) * 0.006), ly = H * 0.36 + Math.cos(tm * 0.13) * 4;
      const flick = 1 + Math.sin(tm * 1.3) * 0.015 + Math.sin(tm * 7.1) * 0.006;
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      const lg = ctx.createRadialGradient(lx, ly, 0, lx, ly, Math.max(W, H) * 0.72);
      const la = 0.34 * flick * (1 - lossK * 0.75);
      lg.addColorStop(0, `rgba(255,205,140,${la})`); lg.addColorStop(0.45, `rgba(240,170,100,${la * 0.38})`); lg.addColorStop(1, 'rgba(200,120,60,0)');
      ctx.fillStyle = lg; ctx.fillRect(0, 0, W, H);
      ctx.restore();
      // dust motes in the lamp light
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      for (const m of this.motes) {
        const px = ((m.x + tm * m.sp * 0.25 + Math.sin(tm * 0.4 + m.ph) * 0.02) % 1) * W;
        const py = ((m.y - tm * m.sp * 0.4 + 10) % 1) * H;
        const d = Math.hypot(px - lx, py - ly) / (Math.max(W, H) * 0.55);
        const a = m.a * Math.max(0, 1 - d) * (0.5 + 0.5 * Math.sin(tm * 0.9 + m.ph)) * (1 - lossK);
        if (a < 0.02) continue;
        ctx.fillStyle = `rgba(255,225,170,${a * 0.6})`;
        ctx.beginPath(); ctx.arc(px, py, m.s, 0, TAU); ctx.fill();
      }
      ctx.restore();

      this.drawStopwatch(ctx, W, H, lossK);

      // card
      const g = this.g, cs = this.cs, cw = this.cw, ch = this.ch;
      const sway = Math.sin(tm * 0.31) * 0.0018;
      const rot = -0.026 + sway + winK * 0.012;
      const liftY = -winK * H * 0.012;
      const sc = 1 + winK * 0.018;
      ctx.save();
      ctx.translate(this.cx, this.cy + liftY);
      ctx.rotate(rot);
      ctx.scale(sc, sc);
      // shadow
      ctx.globalAlpha = 0.62 - winK * 0.12;
      const so = g * 0.016 + winK * g * 0.022, sp = this.shadowPad;
      ctx.drawImage(this.shadow, -cw / 2 - sp + so * 0.4, -ch / 2 - sp + so, cw + sp * 2, ch + sp * 2);
      ctx.globalAlpha = 1;
      ctx.drawImage(this.paper, -cw / 2, -ch / 2, cw, ch);
      if (lossK > 0) { ctx.fillStyle = `rgba(20,12,6,${lossK * 0.42})`; roundRect(ctx, -cw / 2, -ch / 2, cw, ch, 5); ctx.fill(); }

      ctx.translate(this.gx0, this.gy0);
      this.drawWash(ctx);
      this.drawGrid(ctx);
      this.drawDigits(ctx);
      this.drawMarks(ctx);
      this.drawGhosts(ctx);
      if (this.over && this.won) this.drawChecks(ctx);
      this.drawLabel(ctx);
      if (this.twist) this.drawTwist(ctx);
      if (this.over && !this.won) this.drawStamp(ctx, lossK);
      if (!(this.over && !this.won)) this.drawPen(ctx);
      ctx.restore();

      this.particles.draw(ctx, Math.max(0.8, g / 700));
    }

    drawStopwatch(ctx, W, H, lossK) {
      const r = clamp(Math.min(W, H) * 0.042, 22, 56), x = W - r * 1.7, y = r * 1.8;
      const left = clamp(1 - this.t / this.limit, 0, 1), urgent = left < 0.15;
      ctx.save();
      ctx.globalAlpha = 0.9 - lossK * 0.4;
      ctx.fillStyle = 'rgba(0,0,0,0.35)'; ctx.beginPath(); ctx.arc(x + 3, y + 5, r * 1.1, 0, TAU); ctx.fill();
      const bg = ctx.createRadialGradient(x - r * 0.3, y - r * 0.4, r * 0.1, x, y, r * 1.1);
      bg.addColorStop(0, '#c99a4b'); bg.addColorStop(1, '#6e4a1c');
      ctx.fillStyle = bg; ctx.beginPath(); ctx.arc(x, y, r * 1.08, 0, TAU); ctx.fill();
      ctx.fillStyle = '#f0e6cc'; ctx.beginPath(); ctx.arc(x, y, r * 0.88, 0, TAU); ctx.fill();
      ctx.fillStyle = '#b08a4c'; ctx.fillRect(x - r * 0.12, y - r * 1.32, r * 0.24, r * 0.28);
      // remaining time wedge
      ctx.fillStyle = urgent ? 'rgba(190,50,40,0.78)' : 'rgba(60,90,150,0.55)';
      ctx.beginPath(); ctx.moveTo(x, y); ctx.arc(x, y, r * 0.8, -Math.PI / 2, -Math.PI / 2 + TAU * left); ctx.closePath(); ctx.fill();
      ctx.strokeStyle = '#2b2218'; ctx.lineWidth = 1.2;
      for (let k = 0; k < 12; k++) {
        const a = k / 12 * TAU;
        ctx.beginPath(); ctx.moveTo(x + Math.cos(a) * r * 0.74, y + Math.sin(a) * r * 0.74); ctx.lineTo(x + Math.cos(a) * r * 0.86, y + Math.sin(a) * r * 0.86); ctx.stroke();
      }
      const ha = -Math.PI / 2 + TAU * (1 - left);
      ctx.lineWidth = 2; ctx.strokeStyle = '#1b1710';
      ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + Math.cos(ha) * r * 0.78, y + Math.sin(ha) * r * 0.78); ctx.stroke();
      ctx.fillStyle = '#1b1710'; ctx.beginPath(); ctx.arc(x, y, r * 0.07, 0, TAU); ctx.fill();
      ctx.restore();
    }

    drawWash(ctx) {
      const a = this.hlA;
      if (a < 0.01) return;
      const cs = this.cs, g = this.g, h = this.hl;
      ctx.save();
      ctx.globalCompositeOperation = 'multiply';
      ctx.fillStyle = `rgba(${h.col},${0.34 * a})`;
      for (const u of h.units) {
        let x, y, w, hh;
        if (u < 9) { x = 0; y = u * cs; w = g; hh = cs; }
        else if (u < 18) { x = (u - 9) * cs; y = 0; w = cs; hh = g; }
        else { x = ((u - 18) % 3) * 3 * cs; y = (((u - 18) / 3) | 0) * 3 * cs; w = hh = 3 * cs; }
        roundRect(ctx, x + 1.5, y + 1.5, w - 3, hh - 3, cs * 0.12); ctx.fill();
      }
      ctx.fillStyle = `rgba(${h.col},${0.5 * a})`;
      for (const c of h.cells) { roundRect(ctx, COL[c] * cs + 2, ROW[c] * cs + 2, cs - 4, cs - 4, cs * 0.1); ctx.fill(); }
      ctx.fillStyle = `rgba(255,130,95,${0.26 * a})`;
      for (const c of h.tgt) { roundRect(ctx, COL[c] * cs + 2, ROW[c] * cs + 2, cs - 4, cs - 4, cs * 0.1); ctx.fill(); }
      ctx.restore();
    }

    drawGrid(ctx) {
      const g = this.g, cs = this.cs, k = g / 760;
      ctx.save();
      ctx.lineCap = 'butt';
      ctx.strokeStyle = 'rgba(28,40,86,0.5)'; ctx.lineWidth = Math.max(1, 1.3 * k);
      ctx.beginPath();
      for (let i = 1; i < 9; i++) {
        if (i % 3 === 0) continue;
        ctx.moveTo(i * cs, 0); ctx.lineTo(i * cs, g); ctx.moveTo(0, i * cs); ctx.lineTo(g, i * cs);
      }
      ctx.stroke();
      ctx.strokeStyle = '#1a2756'; ctx.lineWidth = Math.max(2, 3.2 * k);
      ctx.beginPath();
      for (let i = 0; i <= 3; i++) { ctx.moveTo(i * 3 * cs, 0); ctx.lineTo(i * 3 * cs, g); ctx.moveTo(0, i * 3 * cs); ctx.lineTo(g, i * 3 * cs); }
      ctx.stroke();
      ctx.lineWidth = Math.max(3, 5 * k); ctx.lineJoin = 'miter';
      ctx.strokeRect(0, 0, g, g);
      ctx.restore();
    }

    drawDigits(ctx) {
      const cs = this.cs, t = this.t;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.font = this.fGiven; ctx.fillStyle = '#14214a';
      for (let i = 0; i < 81; i++) {
        if (!this.isGiven[i]) continue;
        ctx.fillText(String(this.val[i]), (COL[i] + 0.5) * cs, (ROW[i] + 0.53) * cs);
      }
      ctx.font = this.fHand;
      const w = cs * 0.5;
      for (let i = 0; i < 81; i++) {
        if (this.isGiven[i] || !this.val[i]) continue;
        const age = t - this.tw[i];
        if (age < 0) continue;
        const p = clamp(age / 0.27, 0, 1), dry = clamp(age / 1.4, 0, 1);
        const red = this.red[i];
        ctx.save();
        ctx.translate((COL[i] + 0.5 + this.jx[i]) * cs, (ROW[i] + 0.53 + this.jy[i]) * cs);
        ctx.rotate(this.rot[i]);
        ctx.beginPath(); ctx.rect(-w * 0.62, -cs * 0.5, (w * 1.24) * p, cs); ctx.clip();
        ctx.fillStyle = red ? mixRGB(RED_WET, RED_DRY, dry) : mixRGB(INK_WET, INK_DRY, dry);
        ctx.fillText(String(this.val[i]), 0, 0);
        ctx.restore();
      }
    }

    drawMarks(ctx) {
      const cs = this.cs, t = this.t, hA = this.hlA;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      for (let i = 0; i < 81; i++) {
        if (this.isGiven[i]) continue;
        const cb = this.cand[i], v = this.val[i];
        const bx = (COL[i] + 0.5) * cs, by = (ROW[i] + 0.5) * cs;
        for (let d = 0; d < 9; d++) {
          const idx = i * 9 + d, ap = this.appT[idx];
          if (ap > t) continue;
          const bit = (cb >> d) & 1, st = this.strT[idx];
          let a, struck = 0, kind = 0;
          if (bit && !v) a = clamp((t - ap) / 0.22, 0, 1);
          else if (st >= 0) {
            if (t < st) a = 1;
            else {
              const k = t - st;
              if (k > 0.6) continue;
              kind = this.strK[idx];
              struck = kind === 1 ? clamp(k / 0.12, 0, 1) : 0;
              a = k < 0.32 ? 1 : 1 - (k - 0.32) / 0.28;
              if (kind === 2) a = 1 - clamp(k / 0.25, 0, 1);
            }
          } else continue;
          const x = bx + ((d % 3) - 1) * cs * 0.285, y = by + (((d / 3) | 0) - 1) * cs * 0.265 + cs * 0.01;
          const keep = this.flagKeep[idx], el = this.flagElim[idx];
          ctx.globalAlpha = a;
          ctx.font = this.fMark; ctx.fillStyle = '#868d9d';
          ctx.fillText(String(d + 1), x, y);
          if (hA > 0.02 && (keep || el)) {
            ctx.globalAlpha = a * hA; ctx.font = this.fMarkB;
            ctx.fillStyle = el ? '#c0392b' : '#25346e';
            ctx.fillText(String(d + 1), x, y);
          }
          if (struck > 0) {
            ctx.globalAlpha = a; ctx.strokeStyle = '#c0392b'; ctx.lineWidth = Math.max(1.4, cs * 0.04);
            const hw = cs * 0.1;
            ctx.beginPath(); ctx.moveTo(x - hw, y + hw * 0.9); ctx.lineTo(x - hw + 2 * hw * struck, y + hw * 0.9 - 1.8 * hw * struck); ctx.stroke();
          }
        }
      }
      ctx.globalAlpha = 1;
    }

    drawGhosts(ctx) {
      if (!this.ghosts.length) return;
      const cs = this.cs, t = this.t;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.font = this.fHand;
      for (const gh of this.ghosts) {
        const p = (t - gh.t0) / 1.1;
        if (p < 0 || p > 1) continue;
        const x = (COL[gh.i] + 0.5) * cs, y = (ROW[gh.i] + 0.53) * cs;
        ctx.save();
        ctx.fillStyle = gh.red ? 'rgba(160,40,30,0.14)' : 'rgba(40,52,100,0.12)';
        ctx.beginPath(); ctx.ellipse(x, y, cs * (0.2 + 0.22 * p), cs * 0.17, -0.2, 0, TAU); ctx.fill();
        for (let k = 0; k < 6; k++) {
          ctx.globalAlpha = (1 - p) * 0.55 * (1 - k / 6);
          ctx.fillStyle = gh.red ? '#a8241c' : '#1b2a5e';
          ctx.save();
          ctx.translate(x + k * cs * 0.07 * p, y + Math.sin(k + gh.i) * cs * 0.02 * p);
          ctx.scale(1 + p * 0.5, 1 - p * 0.15);
          ctx.fillText(String(gh.d), 0, 0);
          ctx.restore();
        }
        ctx.restore();
      }
    }

    drawChecks(ctx) {
      const cs = this.cs, e = this.endT;
      ctx.save();
      ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      ctx.lineWidth = Math.max(2, cs * 0.075);
      const fade = 1 - clamp((e - 2.0) / 1.2, 0, 0.45);
      for (let i = 0; i < 81; i++) {
        const delay = (ROW[i] + COL[i]) * 0.045 + ((i * 13) % 7) * 0.006;
        const p = clamp((e - delay) / 0.26, 0, 1);
        if (p <= 0) continue;
        const x = COL[i] * cs, y = ROW[i] * cs;
        const pts = [[0.26, 0.54], [0.43, 0.7], [0.76, 0.3]];
        ctx.strokeStyle = `rgba(38,140,84,${0.82 * fade})`;
        ctx.beginPath();
        ctx.moveTo(x + pts[0][0] * cs, y + pts[0][1] * cs);
        const seg1 = Math.min(1, p / 0.35), seg2 = clamp((p - 0.35) / 0.65, 0, 1);
        ctx.lineTo(x + lerp(pts[0][0], pts[1][0], seg1) * cs, y + lerp(pts[0][1], pts[1][1], seg1) * cs);
        if (seg2 > 0) ctx.lineTo(x + lerp(pts[1][0], pts[2][0], seg2) * cs, y + lerp(pts[1][1], pts[2][1], seg2) * cs);
        ctx.stroke();
      }
      ctx.restore();
    }

    drawTwist(ctx) {   // red ink stamp: big for a moment, then a small one above the grid
      const g = this.g, t = this.t, big = clamp(1 - (t - 2.2) / 1.2, 0, 1);
      ctx.save();
      ctx.strokeStyle = '#a82820'; ctx.fillStyle = '#a82820'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      if (big > 0) {
        const s = ease.outBack(clamp(t * 3, 0, 1));
        ctx.save(); ctx.translate(g / 2, g / 2); ctx.rotate(-0.12); ctx.scale(s, s); ctx.globalAlpha = 0.8 * big; ctx.lineWidth = g * 0.012;
        const w = g * 0.74, h = g * 0.19; roundRect(ctx, -w / 2, -h / 2, w, h, g * 0.02); ctx.stroke();
        ctx.font = `700 ${(g * 0.086).toFixed(1)}px ${SERIF}`; ctx.fillText('HARD PUZZLE', 0, g * 0.005); ctx.restore();
      }
      ctx.translate(g * 0.84, -g * 0.045); ctx.rotate(-0.05); ctx.globalAlpha = 0.8; ctx.lineWidth = g * 0.004;
      const w = g * 0.26, h = g * 0.055; roundRect(ctx, -w / 2, -h / 2, w, h, g * 0.01); ctx.stroke();
      ctx.font = `700 ${(g * 0.032).toFixed(1)}px ${SERIF}`; ctx.fillText('HARD PUZZLE', 0, g * 0.002);
      ctx.restore();
    }

    drawStamp(ctx, k) {
      if (k <= 0) return;
      const g = this.g, s = ease.outBack(clamp(k * 1.2, 0, 1));
      ctx.save();
      ctx.translate(g / 2, g / 2); ctx.rotate(-0.16); ctx.scale(s, s);
      ctx.globalAlpha = 0.85 * k;
      ctx.strokeStyle = '#a82820'; ctx.fillStyle = '#a82820';
      ctx.lineWidth = g * 0.012;
      const w = g * 0.74, h = g * 0.19;
      roundRect(ctx, -w / 2, -h / 2, w, h, g * 0.02); ctx.stroke();
      ctx.font = `700 ${(g * 0.086).toFixed(1)}px ${SERIF}`;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText("TIME'S UP", 0, g * 0.005);
      ctx.restore();
    }

    drawLabel(ctx) {
      const L = this.label;
      if (!L) return;
      const g = this.g, t = this.t;
      let a = clamp((t - L.t0) / 0.18, 0, 1);
      if (L.clear >= 0) a *= 1 - clamp((t - L.clear - 0.35) / 0.4, 0, 1);
      if (a <= 0.01) { if (L.clear >= 0 && t - L.clear > 0.9) this.label = null; return; }
      const x = g * 0.004, y = -g * 0.036;
      ctx.save();
      ctx.globalAlpha = a;
      ctx.font = this.fLabel; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
      const w = ctx.measureText(L.text).width;
      // marker swipe behind the words
      ctx.globalCompositeOperation = 'multiply';
      ctx.fillStyle = 'rgba(255,222,70,0.55)';
      const sw = clamp((t - L.t0) / 0.3, 0, 1) * (w + g * 0.03);
      ctx.beginPath(); ctx.moveTo(x - g * 0.008, y + g * 0.02); ctx.lineTo(x - g * 0.008 + sw, y + g * 0.014); ctx.lineTo(x - g * 0.008 + sw, y - g * 0.012); ctx.lineTo(x - g * 0.008, y - g * 0.016); ctx.closePath(); ctx.fill();
      ctx.globalCompositeOperation = 'source-over';
      ctx.fillStyle = L.col;
      ctx.fillText(L.text, x, y);
      ctx.restore();
      // guess depth note on the right
      const depth = Pilot.stack.length;
      if (depth > 0 && !this.over) {
        ctx.save();
        ctx.font = this.fLabel; ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
        ctx.fillStyle = 'rgba(168,35,28,0.85)';
        ctx.fillText('guessing x' + depth, g - g * 0.004, y);
        ctx.restore();
      }
    }

    drawPen(ctx) {
      const cs = this.cs, p = this.pen, t = this.t;
      let x = p.x * cs, y = p.y * cs;
      // while a digit is being written the nib follows the strokes
      let writing = 0;
      for (let i = 0; i < 81; i++) {
        if (!this.isGiven[i] && this.val[i] && t - this.tw[i] < 0.3 && t - this.tw[i] >= 0 && Math.abs(p.x - this.cellX(i)) < 0.2 && Math.abs(p.y - this.cellY(i)) < 0.2) {
          const k = (t - this.tw[i]) / 0.27;
          x += (k - 0.5) * cs * 0.34; y += Math.sin(k * 11) * cs * 0.11 - cs * 0.02;
          writing = 1; break;
        }
      }
      const idle = this.ph === 'think' && !this.thinkPath ? 1 : 0;
      x += Math.sin(this.time * 1.7) * cs * 0.03 * idle; y += Math.cos(this.time * 1.3) * cs * 0.03 * idle;
      const lift = writing ? 0 : p.lift;
      const L = cs * 3.6, w = cs * 0.2, ang = -1.02;
      // contact shadow
      ctx.save();
      ctx.translate(x + cs * (0.07 + lift * 0.22), y + cs * (0.07 + lift * 0.3));
      ctx.rotate(ang);
      ctx.fillStyle = 'rgba(30,20,10,0.10)';
      ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(L * 0.14, -w * 0.5); ctx.lineTo(L, -w * 0.62); ctx.lineTo(L, w * 0.62); ctx.lineTo(L * 0.14, w * 0.5); ctx.closePath(); ctx.fill();
      ctx.restore();
      // ink glow at the tip
      ctx.save();
      ctx.translate(x, y - lift * cs * 0.28);
      const gl = ctx.createRadialGradient(0, 0, 0, 0, 0, cs * 0.3);
      gl.addColorStop(0, writing ? 'rgba(60,90,210,0.5)' : 'rgba(80,100,200,0.22)'); gl.addColorStop(1, 'rgba(60,90,200,0)');
      ctx.fillStyle = gl; ctx.beginPath(); ctx.arc(0, 0, cs * 0.3, 0, TAU); ctx.fill();
      ctx.rotate(ang);
      ctx.globalAlpha = 0.62;
      // barrel
      const bg = ctx.createLinearGradient(0, -w, 0, w);
      bg.addColorStop(0, '#2a3a78'); bg.addColorStop(0.35, '#4a62b6'); bg.addColorStop(0.55, '#1a2656'); bg.addColorStop(1, '#0e1534');
      ctx.fillStyle = bg;
      ctx.beginPath(); ctx.moveTo(L * 0.17, -w * 0.5); ctx.lineTo(L, -w * 0.62); ctx.lineTo(L, w * 0.62); ctx.lineTo(L * 0.17, w * 0.5); ctx.closePath(); ctx.fill();
      // grip ring and clip
      ctx.fillStyle = '#c9a24d'; ctx.fillRect(L * 0.17, -w * 0.52, L * 0.025, w * 1.04);
      ctx.fillStyle = '#d8b560'; ctx.fillRect(L * 0.6, -w * 0.64, L * 0.02, w * 1.28);
      // nib
      const ng = ctx.createLinearGradient(0, -w * 0.5, 0, w * 0.5);
      ng.addColorStop(0, '#f0d58a'); ng.addColorStop(1, '#a88636');
      ctx.fillStyle = ng;
      ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(L * 0.18, -w * 0.46); ctx.lineTo(L * 0.18, w * 0.46); ctx.closePath(); ctx.fill();
      ctx.strokeStyle = 'rgba(40,30,10,0.6)'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(L * 0.16, 0); ctx.stroke();
      ctx.restore();
    }
  }

  Arcade.register({
    id: 'sudoku',
    name: 'Ink & Paper',
    genre: 'Sudoku',
    aiNote: "Sees only the digits and pencil marks on the paper, applies human techniques, and writes a red guess only when none of them work.",
    blurb: 'A hard sudoku solved by hand, with pencil marks, fountain pen and the odd bold guess.',
    bg: '#22150d',
    accent: '#e0a04c',
    twists: [{ key: 'hard', name: 'Hard puzzle', desc: 'A nastier puzzle that needs bold guesses, and a shorter deadline.' }],
    create(opts = {}) { return new SudokuGame(opts); },
  });
})();
