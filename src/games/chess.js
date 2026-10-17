(() => {
'use strict';
// =====================================================================================
// Marble & Brass — chess, Autopilot vs. a house engine.
// Sections: 1) rules + move generation (0x88)  2) evaluation + time-sliced search
//           3) the two "brains" (Autopilot / house)  4) the game, animation and drawing
// =====================================================================================

// ------------------------------------------------------------------ 1. rules
// Piece codes: white P N B R Q K = 1..6, black = 9..14 (bit 3 = colour). Squares are 0x88 (rank*16+file).
const FILES = 'abcdefgh';
const KN = [33, 31, 18, 14, -33, -31, -18, -14];
const KG = [1, -1, 16, -16, 15, 17, -15, -17];
const BD = [15, 17, -15, -17];
const RD = [1, -1, 16, -16];
const sqName = s => FILES[s & 7] + ((s >> 4) + 1);
const mFrom = m => m & 127, mTo = m => (m >> 7) & 127, mPromo = m => (m >> 14) & 7, mFlag = m => m >> 17;
const mk = (f, t, promo = 0, fl = 0) => f | (t << 7) | (promo << 14) | (fl << 17);

// Zobrist keys (fixed seed => deterministic)
const Z = (() => {
  let s = 0x9e3779b9 | 0;
  const rn = () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return s | 0; };
  const pc = new Int32Array(16 * 128); for (let i = 0; i < pc.length; i++) pc[i] = rn();
  const cas = new Int32Array(16); for (let i = 0; i < 16; i++) cas[i] = rn();
  const ep = new Int32Array(8); for (let i = 0; i < 8; i++) ep[i] = rn();
  return { pc, cas, ep, side: rn() };
})();
const CM = new Uint8Array(128).fill(15);
CM[4] &= ~3; CM[0] &= ~2; CM[7] &= ~1; CM[116] &= ~12; CM[112] &= ~8; CM[119] &= ~4;

class Pos {
  constructor() {
    this.b = new Int8Array(128); this.side = 0; this.castle = 15; this.ep = -1; this.half = 0;
    this.hash = 0; this.king = [4, 116]; this.sp = 0;
    this.hh = new Int32Array(1024);
    this.sCap = new Int8Array(1024); this.sCas = new Uint8Array(1024); this.sEp = new Int16Array(1024);
    this.sHalf = new Int16Array(1024); this.sHash = new Int32Array(1024);
    this.mv = new Int32Array(80 * 256);
  }
  setStart() {
    const back = [4, 2, 3, 5, 6, 3, 2, 4];
    this.b.fill(0);
    for (let f = 0; f < 8; f++) {
      this.b[f] = back[f]; this.b[16 + f] = 1; this.b[96 + f] = 9; this.b[112 + f] = back[f] | 8;
    }
    this.side = 0; this.castle = 15; this.ep = -1; this.half = 0; this.king = [4, 116]; this.sp = 0;
    this.hash = this.computeHash(); this.hh[0] = this.hash;
  }
  computeHash() {
    let h = 0;
    for (let r = 0; r < 8; r++) for (let f = 0; f < 8; f++) { const s = r * 16 + f, p = this.b[s]; if (p) h ^= Z.pc[p * 128 + s]; }
    if (this.side) h ^= Z.side;
    h ^= Z.cas[this.castle];
    if (this.ep >= 0) h ^= Z.ep[this.ep & 7];
    return h;
  }
  // what a spectator can see: the board, whose turn, castling rights, e.p. square, clock, past positions
  snapshot() {
    return { b: this.b.slice(), side: this.side, castle: this.castle, ep: this.ep, half: this.half, hh: Array.from(this.hh.subarray(0, this.sp + 1)) };
  }
  static fromSnapshot(s) {
    const p = new Pos(); p.b.set(s.b); p.side = s.side; p.castle = s.castle; p.ep = s.ep; p.half = s.half;
    for (let r = 0; r < 8; r++) for (let f = 0; f < 8; f++) { const q = p.b[r * 16 + f]; if (q === 6) p.king[0] = r * 16 + f; else if (q === 14) p.king[1] = r * 16 + f; }
    p.sp = s.hh.length - 1; for (let i = 0; i < s.hh.length; i++) p.hh[i] = s.hh[i];
    p.hash = p.hh[p.sp];
    return p;
  }
  attacked(sq, by) {
    const b = this.b; let s;
    if (by === 0) {
      s = sq - 15; if (!(s & 0x88) && b[s] === 1) return true;
      s = sq - 17; if (!(s & 0x88) && b[s] === 1) return true;
    } else {
      s = sq + 15; if (!(s & 0x88) && b[s] === 9) return true;
      s = sq + 17; if (!(s & 0x88) && b[s] === 9) return true;
    }
    const o = by << 3;
    for (let i = 0; i < 8; i++) { s = sq + KN[i]; if (!(s & 0x88) && b[s] === (2 | o)) return true; }
    for (let i = 0; i < 8; i++) { s = sq + KG[i]; if (!(s & 0x88) && b[s] === (6 | o)) return true; }
    for (let i = 0; i < 4; i++) {
      const d = BD[i]; s = sq + d;
      while (!(s & 0x88)) { const q = b[s]; if (q) { if (q === (3 | o) || q === (5 | o)) return true; break; } s += d; }
    }
    for (let i = 0; i < 4; i++) {
      const d = RD[i]; s = sq + d;
      while (!(s & 0x88)) { const q = b[s]; if (q) { if (q === (4 | o) || q === (5 | o)) return true; break; } s += d; }
    }
    return false;
  }
  inCheck() { return this.attacked(this.king[this.side], this.side ^ 1); }
  // pseudo-legal moves into this.mv[base..]; returns the end index. caps = captures + queen promotions only.
  gen(base, caps) {
    const b = this.b, us = this.side, mv = this.mv, col = us << 3; let n = base;
    const dir = us ? -16 : 16, sr = us ? 6 : 1, pr = us ? 1 : 6;
    for (let r = 0; r < 8; r++) for (let f = 0; f < 8; f++) {
      const from = r * 16 + f, p = b[from];
      if (!p || (p & 8) !== col) continue;
      const t = p & 7;
      if (t === 1) {
        let s = from + dir;
        if (!(s & 0x88) && b[s] === 0) {
          if (r === pr) {
            if (caps) mv[n++] = mk(from, s, 5);
            else { mv[n++] = mk(from, s, 5); mv[n++] = mk(from, s, 4); mv[n++] = mk(from, s, 3); mv[n++] = mk(from, s, 2); }
          } else if (!caps) {
            mv[n++] = mk(from, s);
            if (r === sr) { const s2 = s + dir; if (b[s2] === 0) mv[n++] = mk(from, s2, 0, 4); }
          }
        }
        for (let k = -1; k <= 1; k += 2) {
          s = from + dir + k; if (s & 0x88) continue;
          const q = b[s];
          if (q && (q & 8) !== col) {
            if (r === pr) { mv[n++] = mk(from, s, 5); if (!caps) { mv[n++] = mk(from, s, 4); mv[n++] = mk(from, s, 3); mv[n++] = mk(from, s, 2); } }
            else mv[n++] = mk(from, s);
          } else if (!q && s === this.ep) mv[n++] = mk(from, s, 0, 1);
        }
      } else if (t === 2 || t === 6) {
        const D = t === 2 ? KN : KG;
        for (let i = 0; i < 8; i++) {
          const s = from + D[i]; if (s & 0x88) continue;
          const q = b[s];
          if (q === 0) { if (!caps) mv[n++] = mk(from, s); } else if ((q & 8) !== col) mv[n++] = mk(from, s);
        }
        if (t === 6 && !caps) {
          const en = us ^ 1;
          if (us === 0 && from === 4) {
            if ((this.castle & 1) && !b[5] && !b[6] && !this.attacked(4, en) && !this.attacked(5, en) && !this.attacked(6, en)) mv[n++] = mk(4, 6, 0, 2);
            if ((this.castle & 2) && !b[3] && !b[2] && !b[1] && !this.attacked(4, en) && !this.attacked(3, en) && !this.attacked(2, en)) mv[n++] = mk(4, 2, 0, 2);
          } else if (us === 1 && from === 116) {
            if ((this.castle & 4) && !b[117] && !b[118] && !this.attacked(116, en) && !this.attacked(117, en) && !this.attacked(118, en)) mv[n++] = mk(116, 118, 0, 2);
            if ((this.castle & 8) && !b[115] && !b[114] && !b[113] && !this.attacked(116, en) && !this.attacked(115, en) && !this.attacked(114, en)) mv[n++] = mk(116, 114, 0, 2);
          }
        }
      } else {
        const D = t === 3 ? BD : t === 4 ? RD : KG, nd = t === 5 ? 8 : 4;
        for (let i = 0; i < nd; i++) {
          const d = D[i]; let s = from + d;
          while (!(s & 0x88)) {
            const q = b[s];
            if (q === 0) { if (!caps) mv[n++] = mk(from, s); }
            else { if ((q & 8) !== col) mv[n++] = mk(from, s); break; }
            s += d;
          }
        }
      }
    }
    return n;
  }
  make(m) {
    const b = this.b, from = m & 127, to = (m >> 7) & 127, promo = (m >> 14) & 7, fl = m >> 17, us = this.side;
    const p = b[from]; let cap = b[to]; const s = this.sp;
    this.sCas[s] = this.castle; this.sEp[s] = this.ep; this.sHalf[s] = this.half; this.sHash[s] = this.hash;
    let h = this.hash;
    if (this.ep >= 0) h ^= Z.ep[this.ep & 7];
    h ^= Z.cas[this.castle];
    h ^= Z.pc[p * 128 + from];
    if (fl & 1) { const cs = us ? to + 16 : to - 16; cap = b[cs]; b[cs] = 0; h ^= Z.pc[cap * 128 + cs]; }
    else if (cap) h ^= Z.pc[cap * 128 + to];
    this.sCap[s] = cap;
    const np = promo ? (promo | (us << 3)) : p;
    b[from] = 0; b[to] = np; h ^= Z.pc[np * 128 + to];
    if (fl & 2) {
      const rf = to > from ? from + 3 : from - 4, rt = (from + to) >> 1, rk = b[rf];
      b[rf] = 0; b[rt] = rk; h ^= Z.pc[rk * 128 + rf] ^ Z.pc[rk * 128 + rt];
    }
    this.castle &= CM[from] & CM[to];
    h ^= Z.cas[this.castle];
    if (fl & 4) { this.ep = (from + to) >> 1; h ^= Z.ep[this.ep & 7]; } else this.ep = -1;
    this.half = ((p & 7) === 1 || cap) ? 0 : this.half + 1;
    if ((p & 7) === 6) this.king[us] = to;
    this.side = us ^ 1; h ^= Z.side;
    this.hash = h; this.sp = s + 1; this.hh[s + 1] = h;
    if (this.attacked(this.king[us], us ^ 1)) { this.unmake(m); return false; }
    return true;
  }
  unmake(m) {
    const b = this.b, from = m & 127, to = (m >> 7) & 127, promo = (m >> 14) & 7, fl = m >> 17;
    const s = --this.sp; this.side ^= 1; const us = this.side;
    this.castle = this.sCas[s]; this.ep = this.sEp[s]; this.half = this.sHalf[s]; this.hash = this.sHash[s];
    const p = promo ? (1 | (us << 3)) : b[to];
    b[from] = p;
    if (fl & 1) { b[to] = 0; b[us ? to + 16 : to - 16] = this.sCap[s]; } else b[to] = this.sCap[s];
    if (fl & 2) { const rf = to > from ? from + 3 : from - 4, rt = (from + to) >> 1; b[rf] = b[rt]; b[rt] = 0; }
    if ((p & 7) === 6) this.king[us] = from;
  }
  makeNull() {
    const s = this.sp; this.sEp[s] = this.ep; this.sHalf[s] = this.half; this.sHash[s] = this.hash;
    let h = this.hash; if (this.ep >= 0) h ^= Z.ep[this.ep & 7];
    this.ep = -1; this.side ^= 1; h ^= Z.side; this.half++; this.hash = h; this.sp = s + 1; this.hh[s + 1] = h;
  }
  unmakeNull() {
    const s = --this.sp; this.side ^= 1; this.ep = this.sEp[s]; this.half = this.sHalf[s]; this.hash = this.sHash[s];
  }
  isRep() {
    const sp = this.sp, h = this.hash; let lim = sp - this.half; if (lim < 0) lim = 0;
    for (let i = sp - 2; i >= lim; i -= 2) if (this.hh[i] === h) return true;
    return false;
  }
  repCount() {
    const sp = this.sp, h = this.hash; let c = 1, lim = sp - this.half; if (lim < 0) lim = 0;
    for (let i = sp - 2; i >= lim; i -= 2) if (this.hh[i] === h) c++;
    return c;
  }
  legal() {
    const n = this.gen(0, false), out = [];
    for (let i = 0; i < n; i++) { const m = this.mv[i]; if (this.make(m)) { this.unmake(m); out.push(m); } }
    return out;
  }
  hasLegal() {
    const n = this.gen(0, false);
    for (let i = 0; i < n; i++) { const m = this.mv[i]; if (this.make(m)) { this.unmake(m); return true; } }
    return false;
  }
  insufficient() {
    let minors = 0, bishopsW = 0, bishopsB = 0;
    for (let r = 0; r < 8; r++) for (let f = 0; f < 8; f++) {
      const p = this.b[r * 16 + f] & 7; if (!p || p === 6) continue;
      if (p === 1 || p === 4 || p === 5) return false;
      minors++; if (p === 3) ((r + f) & 1 ? bishopsW++ : bishopsB++);
    }
    if (minors <= 1) return true;
    return minors === bishopsW + bishopsB && (bishopsW === 0 || bishopsB === 0);
  }
}
function perft(pos, d) {
  if (d === 0) return 1;
  const base = d * 256, n = pos.gen(base, false); let c = 0;
  for (let i = base; i < n; i++) { const m = pos.mv[i]; if (pos.make(m)) { c += perft(pos, d - 1); pos.unmake(m); } }
  return c;
}

// ------------------------------------------------------------------ 2. evaluation + search
const VAL = [0, 100, 320, 330, 500, 900, 0];
const PST = [null,
  [0,0,0,0,0,0,0,0, 50,50,50,50,50,50,50,50, 10,10,20,30,30,20,10,10, 5,5,10,25,25,10,5,5, 0,0,0,20,20,0,0,0, 5,-5,-10,0,0,-10,-5,5, 5,10,10,-20,-20,10,10,5, 0,0,0,0,0,0,0,0],
  [-50,-40,-30,-30,-30,-30,-40,-50, -40,-20,0,0,0,0,-20,-40, -30,0,10,15,15,10,0,-30, -30,5,15,20,20,15,5,-30, -30,0,15,20,20,15,0,-30, -30,5,10,15,15,10,5,-30, -40,-20,0,5,5,0,-20,-40, -50,-40,-30,-30,-30,-30,-40,-50],
  [-20,-10,-10,-10,-10,-10,-10,-20, -10,0,0,0,0,0,0,-10, -10,0,5,10,10,5,0,-10, -10,5,5,10,10,5,5,-10, -10,0,10,10,10,10,0,-10, -10,10,10,10,10,10,10,-10, -10,5,0,0,0,0,5,-10, -20,-10,-10,-10,-10,-10,-10,-20],
  [0,0,0,0,0,0,0,0, 5,10,10,10,10,10,10,5, -5,0,0,0,0,0,0,-5, -5,0,0,0,0,0,0,-5, -5,0,0,0,0,0,0,-5, -5,0,0,0,0,0,0,-5, -5,0,0,0,0,0,0,-5, 0,0,0,5,5,0,0,0],
  [-20,-10,-10,-5,-5,-10,-10,-20, -10,0,0,0,0,0,0,-10, -10,0,5,5,5,5,0,-10, -5,0,5,5,5,5,0,-5, 0,0,5,5,5,5,0,-5, -10,5,5,5,5,5,0,-10, -10,0,5,0,0,0,0,-10, -20,-10,-10,-5,-5,-10,-10,-20],
];
const KMG = [-30,-40,-40,-50,-50,-40,-40,-30, -30,-40,-40,-50,-50,-40,-40,-30, -30,-40,-40,-50,-50,-40,-40,-30, -30,-40,-40,-50,-50,-40,-40,-30, -20,-30,-30,-40,-40,-30,-30,-20, -10,-20,-20,-20,-20,-20,-20,-10, 20,20,0,0,0,0,20,20, 20,30,10,0,0,10,30,20];
const KEG = [-50,-40,-30,-20,-20,-30,-40,-50, -30,-20,-10,0,0,-10,-20,-30, -30,-10,20,30,30,20,-10,-30, -30,-10,30,40,40,30,-10,-30, -30,-10,30,40,40,30,-10,-30, -30,-10,20,30,30,20,-10,-30, -30,-30,0,0,0,0,-30,-30, -50,-30,-30,-30,-30,-30,-30,-50];
const PASSED = [0, 5, 10, 20, 35, 60, 100, 0];
const MATE = 30000, INF = 32000, MAXP = 64;
const wMin = new Int8Array(10), bMax = new Int8Array(10), wCnt = new Int8Array(10), bCnt = new Int8Array(10);
const pawnSq = new Int16Array(20), rookSq = new Int16Array(8);

// Autopilot styles tune a few evaluation weights (the house opponent always uses NEUTRAL).
//  pawn: multiplier on pawn-structure / rook-file terms   bp: bishop-pair bonus
//  king: bonus per piece for closeness to the enemy king   trade: pushes to swap pieces when ahead, avoid swaps when behind
const NEUTRAL = { pawn: 1, bp: 30, king: 0, trade: 0, me: 1 };
const CHESS_STYLES = {
  'Attacker': { pawn: 1, bp: 30, king: 1.3, trade: 0, book: ['e2e4', 'd2d4', 'g1f3'] },
  'Positional': { pawn: 2, bp: 45, king: 0, trade: 0, book: ['d2d4', 'c2c4', 'g1f3'] },
  'Trader': { pawn: 1, bp: 30, king: 0, trade: 0.012, book: ['e2e4', 'd2d4', 'g1f3', 'c2c4'] },
};
// Super AI: strongest known blend (pawn structure, bishop pair, simplify when ahead), never a stylistic whim.
const SUPER_STY = { pawn: 1.3, bp: 40, king: 0, trade: 0.01, book: ['e2e4', 'd2d4'] };
let STY = NEUTRAL;
const KTW = [0, 0, 1, 1, 1.3, 2, 0];

function evaluate(p) {
  const b = p.b;
  wMin.fill(8); bMax.fill(-1); wCnt.fill(0); bCnt.fill(0);
  let s = 0, npmW = 0, npmB = 0, matW = 0, matB = 0, bishW = 0, bishB = 0, pawnsW = 0, pawnsB = 0, np = 0, nr = 0;
  for (let r = 0; r < 8; r++) for (let f = 0; f < 8; f++) {
    const sq = r * 16 + f, pc = b[sq]; if (!pc) continue;
    const t = pc & 7;
    if (pc < 8) {
      if (t === 6) continue;
      s += VAL[t] + PST[t][(7 - r) * 8 + f]; matW += VAL[t];
      if (STY.king && t > 1) s += STY.king * KTW[t] * (14 - Math.abs(f - (p.king[1] & 7)) - Math.abs(r - (p.king[1] >> 4)));
      if (t === 1) { pawnsW++; wCnt[f + 1]++; if (r < wMin[f + 1]) wMin[f + 1] = r; pawnSq[np++] = sq; }
      else { npmW += VAL[t]; if (t === 3) bishW++; else if (t === 4) rookSq[nr++] = sq; }
    } else {
      if (t === 6) continue;
      s -= VAL[t] + PST[t][r * 8 + f]; matB += VAL[t];
      if (STY.king && t > 1) s -= STY.king * KTW[t] * (14 - Math.abs(f - (p.king[0] & 7)) - Math.abs(r - (p.king[0] >> 4)));
      if (t === 1) { pawnsB++; bCnt[f + 1]++; if (r > bMax[f + 1]) bMax[f + 1] = r; pawnSq[np++] = sq; }
      else { npmB += VAL[t]; if (t === 3) bishB++; else if (t === 4) rookSq[nr++] = sq; }
    }
  }
  if (bishW > 1) s += STY.bp; if (bishB > 1) s -= STY.bp;
  for (let f = 1; f <= 8; f++) {
    const cw = wCnt[f], cb = bCnt[f];
    if (cw > 1) s -= 12 * STY.pawn * (cw - 1); if (cb > 1) s += 12 * STY.pawn * (cb - 1);
    if (cw && !wCnt[f - 1] && !wCnt[f + 1]) s -= 10 * STY.pawn * cw;
    if (cb && !bCnt[f - 1] && !bCnt[f + 1]) s += 10 * STY.pawn * cb;
  }
  for (let i = 0; i < np; i++) {
    const sq = pawnSq[i], r = sq >> 4, f = (sq & 7) + 1;
    if (b[sq] < 8) { if (bMax[f - 1] <= r && bMax[f] <= r && bMax[f + 1] <= r) s += PASSED[r] * (STY.pawn > 1 ? 1.4 : 1); }
    else if (wMin[f - 1] >= r && wMin[f] >= r && wMin[f + 1] >= r) s -= PASSED[7 - r] * (STY.pawn > 1 ? 1.4 : 1);
  }
  for (let i = 0; i < nr; i++) {
    const sq = rookSq[i], f = (sq & 7) + 1;
    if (b[sq] < 8) { if (!wCnt[f]) s += bCnt[f] ? 8 : 15; } else if (!bCnt[f]) s -= wCnt[f] ? 8 : 15;
  }
  const wk = p.king[0], bk = p.king[1];
  let ph = (npmW + npmB - 1500) / 3500; ph = ph < 0 ? 0 : ph > 1 ? 1 : ph;
  const wi = (7 - (wk >> 4)) * 8 + (wk & 7), bi = (bk >> 4) * 8 + (bk & 7);
  s += ph * (KMG[wi] - KMG[bi]) + (1 - ph) * (KEG[wi] - KEG[bi]);
  // mop-up: a clear material lead against a pawnless king => drive it to the edge and bring the king closer
  const diff = matW - matB;
  if (STY.trade) {   // Trader: when ahead, simplify; when behind, keep pieces on
    const lead = STY.me * diff, tt = STY.trade * (6400 - npmW - npmB) * STY.me;
    if (lead >= 100) s += tt; else if (lead <= -100) s -= tt;
  }
  if (diff >= 300 && pawnsB === 0) s += mop(bk, wk);
  else if (diff <= -300 && pawnsW === 0) s -= mop(wk, bk);
  s += p.side ? -8 : 8;
  return p.side ? -s : s;
}
function mop(loser, winner) {
  const lf = loser & 7, lr = loser >> 4, wf = winner & 7, wr = winner >> 4;
  const cmd = Math.max(3 - lf, lf - 4) + Math.max(3 - lr, lr - 4);
  return 10 * cmd + 4 * (14 - (Math.abs(lf - wf) + Math.abs(lr - wr)));
}

class Searcher {
  constructor(bits) {
    const N = 1 << bits; this.mask = N - 1;
    this.tk = new Int32Array(N); this.tm = new Int32Array(N); this.ts = new Int32Array(N); this.td = new Int8Array(N); this.tf = new Int8Array(N);
    this.killers = new Int32Array(MAXP * 2); this.hist = new Int32Array(16 * 128);
    this.p = null; this.nodes = 0; this.stop = false; this.hard = 1e9; this.sliceEnd = 0;
    this.bestMove = 0; this.depthDone = 0; this.score = 0;
  }
  clear() { this.tk.fill(0); this.td.fill(-1); this.hist.fill(0); this.killers.fill(0); }
  ord(m, tt, ply) {
    if (m === tt) return 1e7;
    const p = this.p, b = p.b, to = (m >> 7) & 127, fl = m >> 17, promo = (m >> 14) & 7;
    const cap = fl & 1 ? 1 : (b[to] & 7);
    if (cap) return 1e6 + cap * 16 - (b[m & 127] & 7);
    if (promo) return 9e5 + promo;
    if (m === this.killers[ply * 2]) return 8e5;
    if (m === this.killers[ply * 2 + 1]) return 7e5;
    const h = this.hist[b[m & 127] * 128 + to]; return h > 6e5 ? 6e5 : h;
  }
  qs(alpha, beta, ply) {
    const p = this.p; this.nodes++;
    const stand = evaluate(p);
    if (ply >= MAXP - 1 || stand >= beta) return stand;
    if (stand > alpha) alpha = stand;
    const base = ply * 256, n = p.gen(base, true), mv = p.mv;
    const sc = this.sc || (this.sc = new Int32Array(80 * 256));
    for (let i = base; i < n; i++) sc[i] = this.ord(mv[i], 0, 0);
    for (let i = base; i < n; i++) {
      let bi = i; for (let j = i + 1; j < n; j++) if (sc[j] > sc[bi]) bi = j;
      if (bi !== i) { let t = mv[i]; mv[i] = mv[bi]; mv[bi] = t; t = sc[i]; sc[i] = sc[bi]; sc[bi] = t; }
      const m = mv[i];
      if (!p.make(m)) continue;
      const v = -this.qs(-beta, -alpha, ply + 1);
      p.unmake(m);
      if (v >= beta) return v;
      if (v > alpha) alpha = v;
    }
    return alpha;
  }
  ab(depth, alpha, beta, ply, canNull) {
    const p = this.p; this.nodes++;
    if (this.stop) return 0;
    if (this.nodes > this.hard) { this.stop = true; return 0; }
    if (ply > 0 && (p.half >= 100 || p.isRep())) return 0;
    const inCheck = p.attacked(p.king[p.side], p.side ^ 1);
    if (inCheck && ply < 40) depth++;
    if (depth <= 0) return this.qs(alpha, beta, ply);
    if (ply >= MAXP - 1) return evaluate(p);
    const alpha0 = alpha;
    const idx = (p.hash >>> 0) & this.mask; let ttMove = 0;
    if (this.tk[idx] === p.hash && this.td[idx] >= 0) {
      ttMove = this.tm[idx];
      if (this.td[idx] >= depth && ply > 0) {
        let v = this.ts[idx]; if (v > MATE - 200) v -= ply; else if (v < -MATE + 200) v += ply;
        const fg = this.tf[idx];
        if (fg === 0) return v; if (fg === 1 && v >= beta) return v; if (fg === 2 && v <= alpha) return v;
      }
    }
    if (canNull && !inCheck && depth >= 3 && beta < MATE - 200) {
      let pm = 0; const o = p.side << 3;
      for (let r = 0; r < 8 && !pm; r++) for (let f = 0; f < 8; f++) { const q = p.b[r * 16 + f]; if (q && (q & 8) === o) { const t = q & 7; if (t > 1 && t < 6) { pm = 1; break; } } }
      if (pm) {
        p.makeNull();
        const v = -this.ab(depth - 3, -beta, -beta + 1, ply + 1, false);
        p.unmakeNull();
        if (this.stop) return 0;
        if (v >= beta) return v >= MATE - 200 ? beta : v;
      }
    }
    const base = ply * 256, n = p.gen(base, false), mv = p.mv;
    const sc = this.sc || (this.sc = new Int32Array(80 * 256));
    for (let i = base; i < n; i++) sc[i] = this.ord(mv[i], ttMove, ply);
    let best = -INF, bestMove = 0, legal = 0;
    for (let i = base; i < n; i++) {
      let bi = i; for (let j = i + 1; j < n; j++) if (sc[j] > sc[bi]) bi = j;
      if (bi !== i) { let t = mv[i]; mv[i] = mv[bi]; mv[bi] = t; t = sc[i]; sc[i] = sc[bi]; sc[bi] = t; }
      const m = mv[i], to = (m >> 7) & 127;
      const quiet = !p.b[to] && !(m >> 17 & 1) && !((m >> 14) & 7);
      const pc = p.b[m & 127];
      if (!p.make(m)) continue;
      legal++;
      let v;
      if (legal === 1) v = -this.ab(depth - 1, -beta, -alpha, ply + 1, true);
      else {
        let d2 = depth - 1;
        if (legal > 4 && depth >= 3 && quiet && !inCheck && !p.inCheck()) d2--;
        v = -this.ab(d2, -alpha - 1, -alpha, ply + 1, true);
        if (v > alpha && (d2 < depth - 1 || v < beta)) v = -this.ab(depth - 1, -beta, -alpha, ply + 1, true);
      }
      p.unmake(m);
      if (this.stop) return 0;
      if (v > best) {
        best = v; bestMove = m;
        if (v > alpha) {
          alpha = v;
          if (alpha >= beta) {
            if (quiet) {
              if (this.killers[ply * 2] !== m) { this.killers[ply * 2 + 1] = this.killers[ply * 2]; this.killers[ply * 2] = m; }
              const hi = pc * 128 + to; this.hist[hi] = Math.min(600000, this.hist[hi] + depth * depth);
            }
            break;
          }
        }
      }
    }
    if (!legal) return inCheck ? -MATE + ply : 0;
    let sv = best; if (sv > MATE - 200) sv += ply; else if (sv < -MATE + 200) sv -= ply;
    this.tk[idx] = p.hash; this.tm[idx] = bestMove; this.ts[idx] = sv; this.td[idx] = depth;
    this.tf[idx] = best >= beta ? 1 : best > alpha0 ? 0 : 2;
    return best;
  }
  // ply-1 and ply-2 nodes are generators: they yield to the caller whenever the current time slice is used up
  *node1(depth, alpha, beta, ply = 1) {
    const p = this.p; this.nodes++;
    if (p.half >= 100 || p.isRep()) return 0;
    const inCheck = p.attacked(p.king[p.side], p.side ^ 1);
    if (inCheck) depth++;
    if (depth <= 0) return this.qs(alpha, beta, ply);
    const base = ply * 256, n = p.gen(base, false), mv = p.mv;
    const sc = this.sc || (this.sc = new Int32Array(80 * 256));
    for (let i = base; i < n; i++) sc[i] = this.ord(mv[i], 0, ply);
    let best = -INF, legal = 0;
    const kp = ply * 2;
    for (let i = base; i < n; i++) {
      let bi = i; for (let j = i + 1; j < n; j++) if (sc[j] > sc[bi]) bi = j;
      if (bi !== i) { let t = mv[i]; mv[i] = mv[bi]; mv[bi] = t; t = sc[i]; sc[i] = sc[bi]; sc[bi] = t; }
      const m = mv[i], to = (m >> 7) & 127;
      const quiet = !p.b[to] && !(m >> 17 & 1) && !((m >> 14) & 7);
      const pc = p.b[m & 127];
      if (!p.make(m)) continue;
      legal++;
      let v;
      if (ply < 2) {
        if (legal === 1) v = -(yield* this.node1(depth - 1, -beta, -alpha, ply + 1));
        else {
          v = -(yield* this.node1(depth - 1, -alpha - 1, -alpha, ply + 1));
          if (v > alpha && v < beta && !this.stop) v = -(yield* this.node1(depth - 1, -beta, -alpha, ply + 1));
        }
      } else if (legal === 1) v = -this.ab(depth - 1, -beta, -alpha, ply + 1, true);
      else {
        v = -this.ab(depth - 1, -alpha - 1, -alpha, ply + 1, true);
        if (v > alpha && v < beta) v = -this.ab(depth - 1, -beta, -alpha, ply + 1, true);
      }
      p.unmake(m);
      if (this.stop) return 0;
      if (v > best) {
        best = v;
        if (v > alpha) {
          alpha = v;
          if (alpha >= beta) {
            if (quiet) {
              if (this.killers[kp] !== m) { this.killers[kp + 1] = this.killers[kp]; this.killers[kp] = m; }
              const hi = pc * 128 + to; this.hist[hi] = Math.min(600000, this.hist[hi] + depth * depth);
            }
            break;
          }
        }
      }
      if (performance.now() > this.sliceEnd) yield 0;
    }
    if (!legal) return inCheck ? -MATE + ply : 0;
    return best;
  }
  // iterative deepening at the root (also a generator). cfg: {maxDepth, soft, hard, noise}
  *think(pos, cfg) {
    const p = this.p = pos; this.stop = false; this.nodes = 0; this.hard = cfg.hard || 1e9;
    this.bestMove = 0; this.depthDone = 0; this.score = 0; this.killers.fill(0);
    const legal = p.legal();
    if (!legal.length) return { move: 0, score: 0, depth: 0, nodes: 0 };
    // random root order: moves that tie exactly are tried (and therefore chosen) in a different order each game
    for (let i = legal.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); const t = legal[i]; legal[i] = legal[j]; legal[j] = t; }
    // opening variety: in the first plies every root move gets an exact score, and the final pick is random
    // among the moves within `open.cp` centipawns of the best
    const wide = !!(cfg.open && p.sp <= cfg.open.plies);
    let rm = legal.map(m => ({ m, o: this.ord(m, 0, 0), ns: 0, cur: 0 })).sort((a, b) => b.o - a.o);
    this.bestMove = rm[0].m;
    if (rm.length === 1) return { move: rm[0].m, score: 0, depth: 0, nodes: 0 };
    for (let d = 1; d <= cfg.maxDepth; d++) {
      let alpha = -INF, complete = true, bestI = 0;
      for (let i = 0; i < rm.length; i++) {
        const r = rm[i]; p.make(r.m);
        let v;
        if (cfg.noise || wide) v = -(yield* this.node1(d - 1, -INF, INF));
        else if (i === 0) v = -(yield* this.node1(d - 1, -INF, -alpha));
        else {
          v = -(yield* this.node1(d - 1, -alpha - 1, -alpha));
          if (v > alpha && !this.stop) v = -(yield* this.node1(d - 1, -INF, -alpha));
        }
        p.unmake(r.m);
        if (this.stop) { complete = false; break; }
        r.cur = v;
        if (!wide) r.ns = v;
        if (v > alpha || i === 0) { alpha = v; bestI = i; }
      }
      if (!complete) break;
      if (wide) for (const r of rm) r.ns = r.cur;
      const top = rm[bestI];
      rm.splice(bestI, 1); rm.sort((a, b) => b.ns - a.ns); rm.unshift(top);
      this.bestMove = top.m; this.score = top.ns; this.depthDone = d;
      if (Math.abs(top.ns) > MATE - 100) break;
      if (this.nodes >= (cfg.soft || 1e9)) break;
      yield 0;
    }
    let pick = rm[0];
    if (wide && this.depthDone >= 2 && Math.abs(rm[0].ns) < MATE - 100) {
      const pool = rm.filter(r => r.ns >= rm[0].ns - cfg.open.cp);
      pick = pool[Math.floor(Math.random() * pool.length)];
    } else if (cfg.noise) {
      let bv = -1e9;
      for (const r of rm) { const v = r.ns + rnd.gauss() * cfg.noise; if (v > bv) { bv = v; pick = r; } }
    }
    return { move: pick.m, score: rm[0].ns, depth: this.depthDone, nodes: this.nodes };
  }
  quick(pos) { this.p = pos; this.stop = false; this.hard = 1e9; return this.qs(-INF, INF, 0); }
}

// ------------------------------------------------------------------ 3. the brains
// A Brain only ever receives an observe() snapshot: board, side to move, castling rights, e.p. square,
// half-move clock and the hashes of earlier positions (everything a spectator sees on the board and in the
// move list). It returns a legal move after thinking in small time slices; it has no other access to the game.
class Brain {
  constructor(cfg, style) { this.cfg = cfg; this.style = style || null; this.sty = style === 'Super AI' ? SUPER_STY : style ? CHESS_STYLES[style] : NEUTRAL; this.s = new Searcher(cfg.ttBits); this.s.clear(); this.gen = null; this.done = true; this.result = null; this.active = false; }
  start(snap) {
    this.active = true; this.done = false; this.result = null;
    const pos = Pos.fromSnapshot(snap);
    this.sty = Object.assign({}, this.sty, { me: snap.side ? -1 : 1 });
    this.s.bestMove = 0; this.s.depthDone = 0; this.s.nodes = 0;
    if (this.cfg.book && snap.side === 0 && snap.hh.length === 1) {   // a few sensible first moves, like a human repertoire
      const mvs = pos.legal().filter(m => (this.sty.book || ['e2e4', 'd2d4', 'g1f3', 'c2c4']).includes(sqName(mFrom(m)) + sqName(mTo(m))));
      if (mvs.length) { this.done = true; this.result = { move: rnd.pick(mvs), score: 20, depth: 0, nodes: 0 }; return; }
    }
    const c = this.cfg, strong = c.strongP && Math.random() < c.strongP;
    this.gen = this.s.think(pos, strong ? { maxDepth: c.strongDepth, soft: 20000, hard: 60000 } : c);
  }
  tick(ms) {
    if (this.done) return;
    this.s.sliceEnd = performance.now() + ms;
    STY = this.sty;
    let r;
    try { r = this.gen.next(); } finally { STY = NEUTRAL; }
    if (r.done) { this.done = true; this.result = r.value; }
  }
}
const AUTOPILOT_CFG = { maxDepth: 6, soft: 150000, hard: 320000, ttBits: 17, book: true, open: { plies: 8, cp: 20 } };
// Super AI: far deeper and wider search, no opening randomisation, a big transposition table.
const SUPER_CFG = { maxDepth: 14, soft: 500000, hard: 1200000, ttBits: 20, book: true, open: null };
const HOUSE_CFG = { maxDepth: 2, noise: 55, strongP: 0.35, strongDepth: 4, ttBits: 15 };

// ------------------------------------------------------------------ 4. game, animation, drawing
const BRASS = '#c9a45c', BRASS_L = '#e8cf8f';
const TYPE_LETTER = { 2: 'N', 3: 'B', 4: 'R', 5: 'Q', 6: 'K' };
const PIECE_VAL = [0, 1, 3, 3, 5, 9, 0];

function mulberry(a) { return () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }

// ---- piece silhouettes (100x100 box, base at y=92). Lathe-turned profile + extras, outline drawn first so overlaps vanish.
function lathe(pts) {
  const full = [];
  for (const [dx, y] of pts) full.push([50 + dx, y]);
  for (let i = pts.length - 1; i >= 0; i--) full.push([50 - pts[i][0], pts[i][1]]);
  const P = new Path2D(), n = full.length;
  P.moveTo((full[n - 1][0] + full[0][0]) / 2, (full[n - 1][1] + full[0][1]) / 2);
  for (let i = 0; i < n; i++) { const a = full[i], b = full[(i + 1) % n]; P.quadraticCurveTo(a[0], a[1], (a[0] + b[0]) / 2, (a[1] + b[1]) / 2); }
  P.closePath(); return P;
}
const dup = a => [a, a];
const TAIL = [[20, 72], [25, 77], ...dup([29, 79]), ...dup([29, 83]), ...dup([34, 84]), ...dup([34, 90]), ...dup([32, 92])];
function pieceShapes(kind) {
  const body = new Path2D(), detail = new Path2D();
  const add = (p, tf) => body.addPath(p);
  const circle = (x, y, r) => { const c = new Path2D(); c.arc(x, y, r, 0, TAU); body.addPath(c); };
  const ell = (x, y, rx, ry, rot = 0) => { const c = new Path2D(); c.ellipse(x, y, rx, ry, rot, 0, TAU); body.addPath(c); };
  const line = (x1, y1, x2, y2) => { detail.moveTo(x1, y1); detail.lineTo(x2, y2); };
  switch (kind) {
    case 1:
      circle(50, 29, 11.5);
      add(lathe([[6, 38], [6, 40], [13, 43], [13, 46], ...dup([8, 48]), [9, 54], [13, 63], ...TAIL]));
      line(37, 46, 63, 46); line(29, 78.5, 71, 78.5);
      break;
    case 2: { // knight (faces left)
      const k = new Path2D();
      k.moveTo(74, 80); k.bezierCurveTo(78, 56, 70, 30, 52, 17); k.lineTo(50, 7); k.lineTo(43, 15);
      k.bezierCurveTo(34, 17, 27, 27, 19, 42); k.bezierCurveTo(16, 48, 20, 53, 27, 51);
      k.bezierCurveTo(31, 50, 34, 47, 39, 45); k.bezierCurveTo(46, 49, 38, 58, 32, 64);
      k.bezierCurveTo(27, 70, 25, 75, 26, 80); k.closePath(); body.addPath(k);
      add(lathe([[20, 72], [25, 77], ...dup([29, 79]), ...dup([29, 83]), ...dup([34, 84]), ...dup([34, 90]), ...dup([32, 92])]));
      body.addPath(lathe([[24, 74], [27, 78], [27, 80]]));
      detail.moveTo(52, 20); detail.bezierCurveTo(64, 30, 66, 50, 64, 64);
      detail.moveTo(57, 24); detail.bezierCurveTo(68, 36, 70, 54, 68, 66);
      circle(0, 0, 0); // placeholder keeps path valid
      break; }
    case 3:
      ell(50, 31, 11.5, 15); circle(50, 13.5, 4.4);
      add(lathe([[6, 42], [6, 45], [16, 48], [16, 51], ...dup([9, 54]), [11, 60], [16, 68], ...TAIL]));
      line(37, 50.5, 63, 50.5); line(29, 78.5, 71, 78.5);
      detail.moveTo(54, 20); detail.lineTo(46, 33);
      break;
    case 4:
      body.addPath(rectPath(27, 13, 46, 17, 1.5));
      add(lathe([[16, 29], ...dup([16, 31]), [15, 46], [18, 64], [23, 72], ...TAIL.slice(2)]));
      body.addPath(rectPath(30, 28, 40, 6, 2));
      line(28, 22, 72, 22); line(33, 31, 67, 31); line(29, 78.5, 71, 78.5);
      detail.moveTo(40, 13); detail.lineTo(40, 22); detail.moveTo(60, 13); detail.lineTo(60, 22);
      break;
    case 5: {
      const c = new Path2D();
      c.moveTo(31, 41); c.lineTo(25, 21); c.lineTo(37, 31); c.lineTo(40, 15); c.lineTo(46, 30); c.lineTo(50, 12);
      c.lineTo(54, 30); c.lineTo(60, 15); c.lineTo(63, 31); c.lineTo(75, 21); c.lineTo(69, 41); c.closePath(); body.addPath(c);
      circle(25, 20, 3.8); circle(40, 14, 3.6); circle(50, 11, 3.8); circle(60, 14, 3.6); circle(75, 20, 3.8);
      add(lathe([[13, 39], ...dup([18, 41]), [17, 46], ...dup([9, 50]), [11, 58], [16, 67], ...TAIL]));
      line(33, 44.5, 67, 44.5); line(29, 78.5, 71, 78.5);
      break; }
    default: {
      const c = new Path2D();
      c.moveTo(31, 42); c.bezierCurveTo(27, 22, 73, 22, 69, 42); c.closePath(); body.addPath(c);
      body.addPath(rectPath(46.2, 5, 7.6, 24, 1.5)); body.addPath(rectPath(39.5, 11.5, 21, 7.6, 1.5));
      add(lathe([[13, 39], ...dup([19, 41]), [17, 46], ...dup([9, 50]), [11, 58], [16, 67], ...TAIL]));
      line(33, 44.5, 67, 44.5); line(29, 78.5, 71, 78.5);
      detail.moveTo(38, 32); detail.bezierCurveTo(44, 36, 56, 36, 62, 32);
    }
  }
  return { body, detail };
}
function rectPath(x, y, w, h, r) { const p = new Path2D(); p.roundRect ? p.roundRect(x, y, w, h, r) : p.rect(x, y, w, h); return p; }
const PAL = [
  { stops: ['#fffaf0', '#ece0c6', '#b7a47d'], line: '#4a3b24', edge: '#ffffff', shade: '#6b5530', det: 'rgba(80,58,24,0.55)' },
  { stops: ['#5d5864', '#2b2831', '#0c0b0f'], line: '#050406', edge: '#a29bb0', shade: '#000000', det: 'rgba(200,190,215,0.28)' },
];
function makeSprite(kind, color, px) {
  const cv = document.createElement('canvas'); cv.width = cv.height = px;
  const g = cv.getContext('2d'); g.scale(px / 100, px / 100);
  const { body, detail } = pieceShapes(kind), pal = PAL[color];
  g.lineJoin = 'round';
  g.lineWidth = 4.4; g.strokeStyle = pal.line; g.stroke(body);
  const gr = g.createLinearGradient(22, 0, 78, 0);
  gr.addColorStop(0, pal.stops[0]); gr.addColorStop(0.45, pal.stops[1]); gr.addColorStop(1, pal.stops[2]);
  g.fillStyle = gr; g.fill(body);
  g.save(); g.clip(body);
  const vg = g.createLinearGradient(0, 8, 0, 92);
  vg.addColorStop(0, 'rgba(255,255,255,0.16)'); vg.addColorStop(0.5, 'rgba(255,255,255,0)'); vg.addColorStop(1, 'rgba(0,0,0,0.22)');
  g.fillStyle = vg; g.fillRect(0, 0, 100, 100);
  g.lineWidth = 3.2;
  g.save(); g.translate(1.9, 1.9); g.strokeStyle = pal.edge; g.globalAlpha = color ? 0.5 : 0.85; g.stroke(body); g.restore();
  g.save(); g.translate(-2.1, -2.1); g.strokeStyle = pal.shade; g.globalAlpha = 0.5; g.stroke(body); g.restore();
  g.restore();
  g.lineWidth = 1.3; g.strokeStyle = pal.det; g.lineCap = 'round'; g.stroke(detail);
  if (kind === 2) { g.fillStyle = color ? '#cfc7da' : '#2c2217'; g.beginPath(); g.arc(37, 29, 2.3, 0, TAU); g.fill(); g.beginPath(); g.arc(23, 46, 1.2, 0, TAU); g.fill(); }
  return cv;
}

function create(opts = {}) {
  const superAI = !!opts.superAI;
  const aiColor = rnd.int(2), houseColor = aiColor ^ 1;
  const pos = new Pos(); pos.setStart();
  const dbg = typeof globalThis !== 'undefined' ? globalThis.__chessDbg : null;
  const style = superAI ? 'Super AI' : (dbg && dbg.style) || rnd.pick(Object.keys(CHESS_STYLES));
  const brains = []; brains[aiColor] = new Brain(superAI ? SUPER_CFG : AUTOPILOT_CFG, style); brains[houseColor] = new Brain(HOUSE_CFG);
  const evalSearcher = new Searcher(4);
  const particles = new Particles();
  const rng = mulberry(rnd.int(1e9));

  // --- display pieces: one object per piece, animated independently of the logical board
  const at = new Array(128).fill(null), pieces = [];
  for (let r = 0; r < 8; r++) for (let f = 0; f < 8; f++) {
    const sq = r * 16 + f, p = pos.b[sq];
    if (p) { const o = { kind: p & 7, color: p >> 3, sq, from: sq, t0: -9, dur: 0.35, cap: null, promo: 0, promoAt: 0, hop: false }; pieces.push(o); at[sq] = o; }
  }
  const captured = [[], []]; // captured[byColor] = piece objects
  const st = {
    T: 0, wait: 1.1, history: [], last: null, evalTarget: 0, evalShown: 0, evalTxt: '0.0', scroll: 0,
    over: false, won: false, endT: 0, resultText: '', outcome: '', plies: 0, fall: null, checkSq: -1, checkT: -9,
    arrowA: 0, thinkInfo: '',
  };
  let W = 1600, H = 900, L = null, cache = null, sprites = null, spriteKey = '';

  function layout() {
    const c = Math.max(24, Math.min(0.88 * H / 8.7, 0.92 * W / 15.3));
    const frame = 0.36 * c, barW = 0.26 * c, gapBar = 0.42 * c, gapPanel = 0.6 * c, panelW = Math.min(5.3 * c, 0);
    const total = barW + gapBar + frame + 8 * c + frame + gapPanel + 5.3 * c;
    const x0 = (W - total) / 2, cy = H * 0.482;
    L = { c, frame, barX: x0, barW, bx: x0 + barW + gapBar + frame, by: cy - 4 * c, panelX: x0 + barW + gapBar + 2 * frame + 8 * c + gapPanel, panelW: 5.3 * c, ph: 8 * c + 2 * frame, flip: aiColor === 1 };
    L.panelY = L.by - frame;
    cache = null;
  }
  const sqXY = sq => {
    const f = sq & 7, r = sq >> 4, col = L.flip ? 7 - f : f, row = L.flip ? r : 7 - r;
    return [L.bx + (col + 0.5) * L.c, L.by + (row + 0.5) * L.c];
  };
  const trayXY = (by, idx) => {
    const bottom = by === aiColor, step = Math.min(0.36 * L.c, (L.panelW - 1.6 * L.c) / 15);
    return [L.panelX + 0.55 * L.c + idx * step, bottom ? L.panelY + L.ph - 1.12 * L.c : L.panelY + 1.12 * L.c];
  };

  // ---------- caches (table, marble board, sprites)
  function buildCache(dpr) {
    const c = L.c, fr = L.frame, M = 0.7 * c;
    // table (css-px resolution is plenty for low-frequency wood)
    const bg = document.createElement('canvas'); bg.width = Math.ceil(W); bg.height = Math.ceil(H);
    let g = bg.getContext('2d');
    const wg = g.createLinearGradient(0, 0, 0, H); wg.addColorStop(0, '#2b1b11'); wg.addColorStop(1, '#1b100a');
    g.fillStyle = wg; g.fillRect(0, 0, W, H);
    const R = mulberry(77);
    for (let i = 0; i < 180; i++) {
      const y0 = R() * H, amp = 2 + R() * 9, ph = R() * 6, fq = 0.002 + R() * 0.004, light = R() < 0.5;
      g.strokeStyle = light ? `rgba(150,100,60,${0.025 + R() * 0.05})` : `rgba(0,0,0,${0.05 + R() * 0.09})`;
      g.lineWidth = 0.6 + R() * 2.4; g.beginPath();
      for (let x = -10; x <= W + 10; x += 24) { const y = y0 + Math.sin(x * fq + ph) * amp + Math.sin(x * fq * 3.1 + ph) * amp * 0.3; x < 0 ? g.moveTo(x, y) : g.lineTo(x, y); }
      g.stroke();
    }
    const vg = g.createRadialGradient(W / 2, H * 0.48, Math.min(W, H) * 0.25, W / 2, H * 0.5, Math.max(W, H) * 0.75);
    vg.addColorStop(0, 'rgba(0,0,0,0)'); vg.addColorStop(1, 'rgba(0,0,0,0.62)'); g.fillStyle = vg; g.fillRect(0, 0, W, H);
    // board: shadow, walnut frame, brass inlay, marble squares, coordinates
    const size = 8 * c + 2 * fr + 2 * M;
    const bd = document.createElement('canvas'); bd.width = bd.height = Math.ceil(size * dpr);
    g = bd.getContext('2d'); g.scale(dpr, dpr); g.translate(M, M);
    const FS = 8 * c + 2 * fr;
    g.save(); g.shadowColor = 'rgba(0,0,0,0.7)'; g.shadowBlur = 0.55 * c; g.shadowOffsetY = 0.2 * c; g.fillStyle = '#000';
    roundRect(g, 0, 0, FS, FS, 0.12 * c); g.fill(); g.restore();
    const fg = g.createLinearGradient(0, 0, FS, FS); fg.addColorStop(0, '#5b3a22'); fg.addColorStop(0.5, '#3e2616'); fg.addColorStop(1, '#2d1b10');
    g.fillStyle = fg; roundRect(g, 0, 0, FS, FS, 0.12 * c); g.fill();
    for (let i = 0; i < 30; i++) { g.strokeStyle = `rgba(0,0,0,${0.06 + R() * 0.08})`; g.lineWidth = 0.7; g.beginPath(); const y = R() * FS; g.moveTo(0, y); g.bezierCurveTo(FS * 0.3, y + R() * 8 - 4, FS * 0.6, y + R() * 8 - 4, FS, y + R() * 6 - 3); g.stroke(); }
    g.strokeStyle = BRASS; g.globalAlpha = 0.85; g.lineWidth = Math.max(1, 0.025 * c); roundRect(g, 0.09 * c, 0.09 * c, FS - 0.18 * c, FS - 0.18 * c, 0.08 * c); g.stroke();
    g.globalAlpha = 1; g.strokeStyle = 'rgba(0,0,0,0.55)'; g.lineWidth = Math.max(1, 0.03 * c); g.strokeRect(fr - 0.015 * c, fr - 0.015 * c, 8 * c + 0.03 * c, 8 * c + 0.03 * c);
    // coordinates
    g.fillStyle = BRASS; g.globalAlpha = 0.8; g.font = `600 ${0.2 * c}px Fraunces, Georgia, serif`; g.textAlign = 'center'; g.textBaseline = 'middle';
    for (let i = 0; i < 8; i++) {
      const col = L.flip ? 7 - i : i;
      g.fillText(FILES[col], fr + (i + 0.5) * c, FS - fr * 0.45);
      g.fillText(String(L.flip ? i + 1 : 8 - i), fr * 0.45, fr + (i + 0.5) * c);
    }
    g.globalAlpha = 1;
    // marble
    g.translate(fr, fr);
    for (let row = 0; row < 8; row++) for (let col = 0; col < 8; col++) {
      const light = (row + col) % 2 === 0, x = col * c, y = row * c;
      g.save(); g.beginPath(); g.rect(x, y, c, c); g.clip();
      const a = R() * TAU, cx = x + c / 2, cyy = y + c / 2;
      const mg = g.createLinearGradient(cx + Math.cos(a) * c * 0.7, cyy + Math.sin(a) * c * 0.7, cx - Math.cos(a) * c * 0.7, cyy - Math.sin(a) * c * 0.7);
      if (light) { mg.addColorStop(0, '#efe8d8'); mg.addColorStop(1, '#d6cbb4'); } else { mg.addColorStop(0, '#68717e'); mg.addColorStop(1, '#434c59'); }
      g.fillStyle = mg; g.fillRect(x, y, c, c);
      for (let k = 0; k < 3; k++) { // soft clouds
        const rg = g.createRadialGradient(x + R() * c, y + R() * c, 0, x + R() * c, y + R() * c, c * (0.5 + R() * 0.5));
        rg.addColorStop(0, light ? 'rgba(150,135,105,0.10)' : 'rgba(190,205,225,0.08)'); rg.addColorStop(1, 'rgba(0,0,0,0)');
        g.fillStyle = rg; g.fillRect(x, y, c, c);
      }
      const nv = 2 + (R() * 3 | 0);
      for (let k = 0; k < nv; k++) {
        const thick = R() < 0.3;
        g.strokeStyle = light ? (thick ? 'rgba(140,125,98,0.16)' : 'rgba(110,98,78,0.20)') : (thick ? 'rgba(20,26,36,0.28)' : 'rgba(190,202,220,0.20)');
        g.lineWidth = Math.max(0.5, c * (thick ? 0.03 : 0.012)); g.beginPath();
        let px = x + (R() < 0.5 ? 0 : c), py = y + R() * c; g.moveTo(px, py);
        for (let s = 0; s < 3; s++) { const nx = x + R() * c, ny = y + R() * c; g.quadraticCurveTo(x + R() * c, y + R() * c, nx, ny); }
        g.stroke();
      }
      g.restore();
      g.strokeStyle = 'rgba(0,0,0,0.10)'; g.lineWidth = 1; g.strokeRect(x + 0.5, y + 0.5, c - 1, c - 1);
    }
    cache = { bg, bd, M, dpr, W, H };
  }
  function getSprite(kind, color, dpr) {
    const px = Math.max(16, Math.round(L.c * dpr * 1.05));
    const key = px + ':' + dpr;
    if (key !== spriteKey) { sprites = {}; spriteKey = key; }
    const k = kind * 2 + color;
    return sprites[k] || (sprites[k] = makeSprite(kind, color, px));
  }

  // ---------- rules helpers
  function sanOf(m) {
    const b = pos.b, from = mFrom(m), to = mTo(m), promo = mPromo(m), fl = mFlag(m), t = b[from] & 7;
    const isCap = b[to] || (fl & 1);
    let fig = 0, txt = '';
    if (fl & 2) txt = to > from ? 'O-O' : 'O-O-O';
    else if (t === 1) { if (isCap) txt += FILES[from & 7] + 'x'; txt += sqName(to); if (promo) txt += '=' + TYPE_LETTER[promo]; }
    else {
      fig = t;
      const others = pos.legal().filter(o => o !== m && mTo(o) === to && (b[mFrom(o)] & 7) === t && mFrom(o) !== from);
      let dis = '';
      if (others.length) {
        const sameFile = others.some(o => (mFrom(o) & 7) === (from & 7)), sameRank = others.some(o => (mFrom(o) >> 4) === (from >> 4));
        if (!sameFile) dis = FILES[from & 7]; else if (!sameRank) dis = String((from >> 4) + 1); else dis = sqName(from);
      }
      txt = dis + (isCap ? 'x' : '') + sqName(to);
    }
    pos.make(m);
    if (pos.inCheck()) txt += pos.hasLegal() ? '+' : '#';
    pos.unmake(m);
    return { fig, txt };
  }
  const material = col => {
    let s = 0; for (let r = 0; r < 8; r++) for (let f = 0; f < 8; f++) { const p = pos.b[r * 16 + f]; if (p && (p >> 3) === col) s += PIECE_VAL[p & 7]; }
    return s;
  };
  function observe() { return pos.snapshot(); }
  function setEvalFromWhite(cp) { cp = Math.max(-1500, Math.min(1500, cp)); st.evalTarget = cp; st.evalTxt = (cp >= 0 ? '+' : '−') + (Math.abs(cp) / 100).toFixed(1); }
  function quickEval() { const v = evalSearcher.quick(Pos.fromSnapshot(observe())); setEvalFromWhite(pos.side ? -v : v); }

  function finish(outcome, text, winnerColor) {
    st.over = true; st.outcome = outcome; st.resultText = text; st.endT = 0;
    inst.won = winnerColor === aiColor;
    inst.over = true;
    if (winnerColor !== undefined && outcome === 'mate') {
      const loserKing = pieces.find(p => p.kind === 6 && p.color !== winnerColor && !p.cap);
      const winKing = pieces.find(p => p.kind === 6 && p.color === winnerColor && !p.cap);
      st.fall = { piece: loserKing, t0: st.T + 0.55, dir: rng() < 0.5 ? 1 : -1 };
      st.winKing = winKing;
      setEvalFromWhite(winnerColor === 0 ? 1500 : -1500);
      setTimeout0(() => { const [x, y] = sqXY(winKing.sq); particles.burst(x, y - L.c * 0.2, 46, { speed: 380, speedMin: 90, life: 1.8, size: L.c * 0.07, color: [BRASS_L, '#fff3d0', BRASS, '#ffd98a'], gravity: 220, drag: 1.4 }); }, st.T + 0.7);
    } else if (outcome === 'win') setEvalFromWhite(winnerColor === 0 ? 1500 : -1500);
    else setEvalFromWhite(0);
  }
  const pendingFx = [];
  function setTimeout0(fn, at) { pendingFx.push({ fn, at }); }

  function play(m) {
    const from = mFrom(m), to = mTo(m), promo = mPromo(m), fl = mFlag(m), us = pos.side;
    const mover = at[from];
    const entry = sanOf(m);
    if (dbg && dbg.log && dbg.log.length < 8) dbg.log.push(sqName(from) + sqName(to));
    const prevScore = brains[us].result && us === aiColor ? brains[us].result.score : null;
    const capSq = fl & 1 ? (us ? to + 16 : to - 16) : to;
    const victim = at[capSq];
    if (!pos.make(m)) { // should never happen; recover with any legal move
      const l = pos.legal(); if (!l.length) return; return play(l[0]);
    }
    st.plies++;
    const [tx, ty] = sqXY(to);
    if (victim) {
      at[capSq] = null; victim.cap = { t0: st.T + 0.26, sq: capSq, idx: captured[us].length, by: us }; victim.sq = -1; captured[us].push(victim);
      const [vx, vy] = sqXY(capSq);
      setTimeout0(() => particles.burst(vx, vy, 16, { speed: 210, speedMin: 40, life: 0.8, size: L.c * 0.045, color: [BRASS_L, BRASS, '#fff1c8'], gravity: 60, drag: 2.2 }), st.T + 0.28);
    }
    at[from] = null; at[to] = mover; mover.from = from; mover.sq = to; mover.t0 = st.T; mover.dur = mover.kind === 2 ? 0.42 : 0.36; mover.hop = mover.kind === 2;
    if (fl & 2) {
      const rf = to > from ? from + 3 : from - 4, rt = (from + to) >> 1, rk = at[rf];
      at[rf] = null; at[rt] = rk; rk.from = rf; rk.sq = rt; rk.t0 = st.T + 0.05; rk.dur = 0.36;
    }
    if (promo) { mover.promo = promo; mover.promoAt = st.T + mover.dur * 0.85; setTimeout0(() => particles.burst(tx, ty, 26, { speed: 240, life: 1, size: L.c * 0.05, color: [BRASS_L, '#fff', '#ffe9a8'], gravity: -30, drag: 2 }), st.T + mover.dur * 0.85); }
    st.last = { from, to, T: st.T };
    st.history.push({ color: us, fig: entry.fig, txt: entry.txt });
    st.checkSq = -1;
    if (pos.inCheck()) { st.checkSq = pos.king[pos.side]; st.checkT = st.T + 0.3; }
    // evaluation bar
    if (prevScore !== null) setEvalFromWhite(us === 0 ? prevScore : -prevScore); else quickEval();
    // end of game?
    const hasMove = pos.hasLegal();
    if (!hasMove) {
      if (pos.inCheck()) finish('mate', `Checkmate: Autopilot ${us === aiColor ? 'mated the house' : 'was mated'} in ${Math.ceil(st.plies / 2)} moves`, us);
      else finish('draw', 'Draw by stalemate');
    } else if (pos.insufficient()) finish('draw', 'Draw: not enough material');
    else if (pos.half >= 100) finish('draw', 'Draw by the fifty-move rule');
    else if (pos.repCount() >= 3) finish('draw', 'Draw by threefold repetition');
    else if (st.plies >= 160) adjudicate();
    if (st.over && st.outcome === 'mate') st.resultText = `Checkmate: Autopilot ${us === aiColor ? 'mated the house' : 'was mated'} in ${Math.ceil(st.plies / 2)} moves`;
    brains[us].active = false;
    st.wait = superAI ? 0.45 : 1.25 + rnd.float(0, 0.45);
  }
  function adjudicate() {
    const d = material(aiColor) - material(houseColor);
    if (d > 3) finish('win', `Adjudicated on material, up ${d} points`, aiColor);
    else if (d < -3) finish('loss', `Adjudicated on material, down ${-d} points`, houseColor);
    else finish('draw', 'Draw: no breakthrough after 80 moves');
  }

  const inst = {
    over: false, won: false, style, superAI,
    debug: { Pos, Searcher, perft, Brain, HOUSE_CFG, AUTOPILOT_CFG, aiColor },
    resize(w, h) { W = w; H = h; layout(); },
    step(dt) {
      st.T += dt; particles.update(dt);
      for (let i = pendingFx.length - 1; i >= 0; i--) if (st.T >= pendingFx[i].at) { pendingFx[i].fn(); pendingFx.splice(i, 1); }
      st.evalShown += (st.evalTarget - st.evalShown) * (1 - Math.exp(-dt * 3.5));
      const rows = Math.ceil(st.history.length / 2);
      st.scroll += (Math.max(0, rows - 1) - st.scroll) * (1 - Math.exp(-dt * 6));
      if (st.over) { st.endT += dt; return; }
      if (st.T > 330) { adjudicate(); return; }
      st.wait -= dt;
      const side = pos.side, br = brains[side];
      if (!br.active) br.start(observe());
      if (!br.done) br.tick(superAI && side === aiColor ? 3.5 : 2.2);
      if (side === aiColor) {
        const s = br.s;
        st.thinkInfo = s.depthDone ? `depth ${s.depthDone} · ${s.nodes >= 1000 ? Math.round(s.nodes / 1000) + 'k' : s.nodes} nodes` : '';
        if (!br.done && s.depthDone >= 2) setEvalFromWhite(aiColor === 0 ? s.score : -s.score);
      }
      if (br.done && st.wait <= 0) play(br.result.move);
      // arrow fade
      const showArrow = !st.over && pos.side === aiColor && !brains[aiColor].done;
      st.arrowA += ((showArrow ? 1 : 0) - st.arrowA) * (1 - Math.exp(-dt * 8));
    },
    hud() {
      const mv = Math.floor(st.plies / 2) + 1;
      return { score: `Move ${mv}`, detail: `${aiColor === 0 ? 'White' : 'Black'} · ${st.evalTxt}` };
    },
    result() { return st.resultText || 'Game ended'; },
    draw(ctx, w, h) {
      const dpr = Math.min(2, ctx.getTransform().a || 1);
      if (!L) layout();
      if (!cache || cache.dpr !== dpr || cache.W !== W || cache.H !== H) buildCache(dpr);
      const c = L.c, fr = L.frame;
      const al = Math.max(0, Math.min(1, Arcade.alpha === undefined ? 0 : Arcade.alpha)) / 60;
      const T = st.T + (st.over ? 0 : al);
      ctx.drawImage(cache.bg, 0, 0, w, h);
      // lamp pool
      const cxm = L.bx + 4 * c, cym = L.by + 4 * c;
      const lg = ctx.createRadialGradient(cxm, cym - c, c, cxm, cym, 9 * c);
      lg.addColorStop(0, 'rgba(255,214,150,0.16)'); lg.addColorStop(0.5, 'rgba(255,190,110,0.05)'); lg.addColorStop(1, 'rgba(255,190,110,0)');
      ctx.fillStyle = lg; ctx.fillRect(0, 0, w, h);
      // board
      ctx.drawImage(cache.bd, L.bx - fr - cache.M, L.by - fr - cache.M, 8 * c + 2 * fr + 2 * cache.M, 8 * c + 2 * fr + 2 * cache.M);
      // last move glow
      if (st.last) {
        const k = Math.min(1, (T - st.last.T) / 0.4), pulse = 0.75 + 0.25 * Math.sin(T * 2.2);
        for (const sq of [st.last.from, st.last.to]) {
          const [x, y] = sqXY(sq); const a = (sq === st.last.to ? 1 : 0.65) * k * pulse;
          const g = ctx.createRadialGradient(x, y, c * 0.1, x, y, c * 0.75);
          g.addColorStop(0, `rgba(240,200,110,${0.55 * a})`); g.addColorStop(1, 'rgba(240,200,110,0)');
          ctx.fillStyle = g; ctx.fillRect(x - c / 2, y - c / 2, c, c);
          ctx.strokeStyle = `rgba(232,207,143,${0.7 * a})`; ctx.lineWidth = Math.max(1.5, c * 0.04); ctx.strokeRect(x - c / 2 + c * 0.03, y - c / 2 + c * 0.03, c * 0.94, c * 0.94);
        }
      }
      if (st.checkSq >= 0 && !st.over) {
        const [x, y] = sqXY(st.checkSq), a = Math.min(1, Math.max(0, (T - st.checkT + 0.3) / 0.3)) * (0.6 + 0.4 * Math.sin(T * 5));
        const g = ctx.createRadialGradient(x, y, 0, x, y, c * 0.7); g.addColorStop(0, `rgba(230,70,60,${0.6 * a})`); g.addColorStop(1, 'rgba(230,70,60,0)');
        ctx.fillStyle = g; ctx.fillRect(x - c, y - c, 2 * c, 2 * c);
      }
      // thinking arrow (Autopilot's current best move)
      if (st.arrowA > 0.02 && brains[aiColor].s.bestMove) {
        const m = brains[aiColor].s.bestMove, [x1, y1] = sqXY(mFrom(m)), [x2, y2] = sqXY(mTo(m));
        const dx = x2 - x1, dy = y2 - y1, d = Math.hypot(dx, dy) || 1, ux = dx / d, uy = dy / d, hw = c * 0.17, hl = c * 0.32;
        ctx.save(); ctx.globalAlpha = 0.5 * st.arrowA; ctx.fillStyle = BRASS_L; ctx.strokeStyle = 'rgba(60,40,10,0.5)'; ctx.lineWidth = 1;
        const sx = x1 + ux * c * 0.25, sy = y1 + uy * c * 0.25, ex = x2 - ux * c * 0.12, ey = y2 - uy * c * 0.12, bx2 = ex - ux * hl, by2 = ey - uy * hl, nw = c * 0.06;
        ctx.beginPath(); ctx.moveTo(sx - uy * nw, sy + ux * nw); ctx.lineTo(bx2 - uy * nw, by2 + ux * nw); ctx.lineTo(bx2 - uy * hw, by2 + ux * hw); ctx.lineTo(ex, ey);
        ctx.lineTo(bx2 + uy * hw, by2 - ux * hw); ctx.lineTo(bx2 + uy * nw, by2 - ux * nw); ctx.lineTo(sx + uy * nw, sy - ux * nw); ctx.closePath(); ctx.fill(); ctx.stroke(); ctx.restore();
      }
      // pieces (static first, movers on top)
      const drawList = [];
      for (const p of pieces) {
        let x, y, lift = 0, sc = 1, rot = 0, a = 1;
        if (p.cap) {
          const [bx, by] = sqXY(p.cap.sq), [tx, ty] = trayXY(p.cap.by, p.cap.idx), u = (T - p.cap.t0) / 0.55;
          if (u <= 0) { x = bx; y = by; } else { const e = ease.inOutCubic(Math.min(1, u)); x = lerp(bx, tx, e); y = lerp(by, ty, e); sc = lerp(1, 0.5, e); lift = Math.sin(Math.PI * Math.min(1, u)) * 0.35; }
          drawList.push({ p, x, y, lift, sc, rot, z: u > 0 ? 3 : 0 }); continue;
        }
        const [x2, y2] = sqXY(p.sq);
        const u = Math.min(1, Math.max(0, (T - p.t0) / p.dur));
        if (u < 1) {
          const [x1, y1] = sqXY(p.from), e = ease.inOutCubic(u);
          x = lerp(x1, x2, e); y = lerp(y1, y2, e); lift = Math.sin(Math.PI * u) * (p.hop ? 0.5 : 0.18); sc = 1 + lift * 0.22;
        } else { x = x2; y = y2; }
        const z = u < 1 && u > 0 ? 2 : 1;
        if (st.fall && st.fall.piece === p && T > st.fall.t0) { const f = Math.min(1, (T - st.fall.t0) / 0.9); rot = st.fall.dir * (ease.outBack(f) * 1.45); y += c * 0.06 * f; }
        drawList.push({ p, x, y, lift, sc, rot, z });
      }
      drawList.sort((a, b) => a.z - b.z);
      for (const d of drawList) {
        const { p } = d, kind = p.promo && T >= p.promoAt ? p.promo : p.kind;
        const size = c * d.sc;
        // shadow
        ctx.fillStyle = `rgba(0,0,0,${0.32 - d.lift * 0.25})`;
        ctx.beginPath(); ctx.ellipse(d.x + d.lift * c * 0.12, d.y + c * 0.4 + d.lift * c * 0.1, c * 0.27 * d.sc, c * 0.07 * d.sc, 0, 0, TAU); ctx.fill();
        const spr = getSprite(kind, p.color, dpr);
        ctx.save();
        ctx.translate(d.x, d.y + c * 0.42 - d.lift * c * 0.12);
        if (d.rot) ctx.rotate(d.rot);
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(spr, -size / 2, -size * 0.92, size, size);
        ctx.restore();
      }
      // winner's king halo
      if (st.over && st.outcome === 'mate' && st.winKing) {
        const [x, y] = sqXY(st.winKing.sq), k = Math.min(1, Math.max(0, (st.endT - 0.5) / 0.8));
        const g = ctx.createRadialGradient(x, y - c * 0.1, 0, x, y - c * 0.1, c * (1.1 + 0.1 * Math.sin(T * 3)));
        g.addColorStop(0, `rgba(255,225,150,${0.5 * k})`); g.addColorStop(1, 'rgba(255,225,150,0)');
        ctx.fillStyle = g; ctx.fillRect(x - 2 * c, y - 2 * c, 4 * c, 4 * c);
      }
      particles.draw(ctx);
      // dust motes in the lamp light
      ctx.save(); ctx.globalCompositeOperation = 'lighter';
      for (let i = 0; i < 26; i++) {
        const ph = i * 1.7, x = cxm + Math.sin(T * 0.07 + ph) * 6 * c + Math.sin(T * 0.31 + ph * 3) * c * 0.3, y = cym + Math.cos(T * 0.05 + ph * 1.3) * 4.2 * c + ((T * 4 + i * 37) % 30) * 0 ;
        ctx.fillStyle = `rgba(255,220,160,${0.05 + 0.05 * Math.sin(T * 0.8 + ph)})`; ctx.beginPath(); ctx.arc(x, y, c * (0.012 + (i % 3) * 0.008), 0, TAU); ctx.fill();
      }
      ctx.restore();
      drawEvalBar(ctx, T);
      drawPanel(ctx, T, dpr);
    },
  };

  function drawEvalBar(ctx, T) {
    const x = L.barX, w = L.barW, y = L.by - L.frame, h = 8 * L.c + 2 * L.frame;
    const v = 1 / (1 + Math.exp(-st.evalShown / 280)); // white share
    ctx.save();
    roundRect(ctx, x, y, w, h, w / 2); ctx.clip();
    const whiteBottom = !L.flip;
    ctx.fillStyle = '#1b1a20'; ctx.fillRect(x, y, w, h);
    const wh = h * v;
    const wg = ctx.createLinearGradient(x, 0, x + w, 0); wg.addColorStop(0, '#fffaf0'); wg.addColorStop(1, '#cdbd98');
    ctx.fillStyle = wg;
    if (whiteBottom) ctx.fillRect(x, y + h - wh, w, wh); else ctx.fillRect(x, y, w, wh);
    ctx.fillStyle = BRASS; const ly = whiteBottom ? y + h - wh : y + wh; ctx.fillRect(x, ly - 1.5, w, 3);
    ctx.strokeStyle = 'rgba(201,164,92,0.5)'; ctx.lineWidth = 1;
    for (let i = 1; i < 8; i++) { ctx.beginPath(); ctx.moveTo(x, y + h * i / 8); ctx.lineTo(x + w * (i === 4 ? 0.7 : 0.35), y + h * i / 8); ctx.stroke(); }
    ctx.restore();
    ctx.strokeStyle = 'rgba(201,164,92,0.55)'; ctx.lineWidth = 1.2; roundRect(ctx, x, y, w, h, w / 2); ctx.stroke();
    ctx.font = `600 ${Math.max(10, L.c * 0.17)}px "IBM Plex Mono", monospace`; ctx.textAlign = 'center'; ctx.fillStyle = BRASS_L; ctx.textBaseline = 'middle';
    ctx.fillText(st.evalTxt, x + w / 2, y - L.c * 0.2);
  }

  function drawFig(ctx, kind, color, x, y, size, dpr) {
    const spr = getSprite(kind, color, dpr);
    ctx.drawImage(spr, x - size / 2, y - size * 0.55, size, size);
  }

  function drawPanel(ctx, T, dpr) {
    const c = L.c, x0 = L.panelX, y0 = L.panelY, w = L.panelW, h = L.ph;
    ctx.save();
    const pg = ctx.createLinearGradient(x0, y0, x0 + w, y0 + h); pg.addColorStop(0, 'rgba(46,29,18,0.78)'); pg.addColorStop(1, 'rgba(24,15,10,0.82)');
    ctx.fillStyle = pg; roundRect(ctx, x0, y0, w, h, 0.2 * c); ctx.fill();
    ctx.strokeStyle = 'rgba(201,164,92,0.4)'; ctx.lineWidth = 1.2; roundRect(ctx, x0, y0, w, h, 0.2 * c); ctx.stroke();
    // player blocks
    const blocks = [
      { color: houseColor, name: 'House engine', info: 'depth 2 · plays on instinct', top: true },
      { color: aiColor, name: 'Autopilot', info: st.thinkInfo || 'depth 5 · alpha-beta', top: false },
    ];
    for (const b of blocks) {
      const ny = b.top ? y0 + 0.5 * c : y0 + h - 0.5 * c, ty = b.top ? y0 + 1.12 * c : y0 + h - 1.12 * c;
      const active = !st.over && pos.side === b.color;
      drawFig(ctx, 6, b.color, x0 + 0.52 * c, ny + 0.12 * c, 0.62 * c, dpr);
      ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
      ctx.fillStyle = active ? BRASS_L : '#d9cdb5'; ctx.font = `600 ${0.3 * c}px Fraunces, Georgia, serif`;
      ctx.fillText(b.name, x0 + 0.95 * c, ny - 0.05 * c);
      ctx.fillStyle = 'rgba(217,205,181,0.55)'; ctx.font = `400 ${0.17 * c}px "IBM Plex Mono", monospace`;
      ctx.fillText(b.info, x0 + 0.95 * c, ny + 0.24 * c);
      if (active) {
        const dx = x0 + w - 0.5 * c;
        for (let i = 0; i < 3; i++) { ctx.fillStyle = `rgba(232,207,143,${0.25 + 0.75 * Math.max(0, Math.sin(T * 5 - i * 0.9))})`; ctx.beginPath(); ctx.arc(dx - i * 0.2 * c, ny, c * 0.055, 0, TAU); ctx.fill(); }
      }
      // material difference next to the tray row
      const d = material(b.color) - material(b.color ^ 1);
      if (d > 0) { ctx.textAlign = 'right'; ctx.fillStyle = BRASS; ctx.font = `600 ${0.2 * c}px "IBM Plex Mono", monospace`; ctx.fillText('+' + d, x0 + w - 0.4 * c, ty); }
      ctx.strokeStyle = 'rgba(201,164,92,0.16)'; ctx.lineWidth = 1; ctx.beginPath();
      const dy = b.top ? y0 + 1.5 * c : y0 + h - 1.5 * c; ctx.moveTo(x0 + 0.3 * c, dy); ctx.lineTo(x0 + w - 0.3 * c, dy); ctx.stroke();
    }
    // tray slots (faint)
    for (const by of [0, 1]) {
      for (let i = 0; i < 15; i++) { const [tx, ty] = trayXY(by, i); ctx.fillStyle = 'rgba(0,0,0,0.18)'; ctx.beginPath(); ctx.arc(tx, ty + 0.1 * c, c * 0.04, 0, TAU); ctx.fill(); }
    }
    // move list
    const ly0 = y0 + 1.62 * c, ly1 = y0 + h - 1.62 * c, rowH = 0.5 * c, fs = Math.max(11, 0.27 * c);
    ctx.save(); ctx.beginPath(); ctx.rect(x0, ly0, w, ly1 - ly0); ctx.clip();
    const vis = Math.floor((ly1 - ly0) / rowH), rows = Math.ceil(st.history.length / 2);
    const first = Math.max(0, st.scroll - vis + 1); // smooth bottom-aligned scrolling
    const startRow = Math.max(0, Math.floor(first) - 1), top0 = ly0 + 0.1 * c;
    for (let r = startRow; r < rows; r++) {
      const ry = top0 + (r - first) * rowH + rowH / 2;
      if (ry > ly1 + rowH) break;
      if (r % 2 === 0) { ctx.fillStyle = 'rgba(255,235,200,0.035)'; ctx.fillRect(x0 + 0.2 * c, ry - rowH / 2, w - 0.4 * c, rowH); }
      ctx.textBaseline = 'middle'; ctx.textAlign = 'right'; ctx.fillStyle = 'rgba(201,164,92,0.6)'; ctx.font = `400 ${fs * 0.8}px "IBM Plex Mono", monospace`;
      ctx.fillText((r + 1) + '.', x0 + 1.0 * c, ry);
      for (let k = 0; k < 2; k++) {
        const e = st.history[r * 2 + k]; if (!e) continue;
        const ex = x0 + (1.25 + k * 2.0) * c, isLast = r * 2 + k === st.history.length - 1;
        if (isLast) { ctx.fillStyle = 'rgba(201,164,92,0.22)'; roundRect(ctx, ex - 0.12 * c, ry - rowH * 0.42, 1.85 * c, rowH * 0.84, 0.1 * c); ctx.fill(); }
        let tx = ex;
        if (e.fig) { drawFig(ctx, e.fig, e.color, tx + 0.15 * c, ry + 0.02 * c, 0.42 * c, dpr); tx += 0.36 * c; }
        ctx.textAlign = 'left'; ctx.fillStyle = isLast ? BRASS_L : '#e6dcc6'; ctx.font = `600 ${fs}px Fraunces, Georgia, serif`;
        ctx.fillText(e.txt, tx, ry);
      }
    }
    ctx.restore();
    // top / bottom fade of the list
    for (const [yy, dir] of [[ly0, 1], [ly1, -1]]) {
      const fg = ctx.createLinearGradient(0, yy, 0, yy + dir * 0.4 * c); fg.addColorStop(0, 'rgba(34,21,13,0.9)'); fg.addColorStop(1, 'rgba(34,21,13,0)');
      ctx.fillStyle = fg; ctx.fillRect(x0 + 2, dir > 0 ? yy : yy - 0.4 * c, w - 4, 0.4 * c);
    }
    if (st.over) {
      const k = Math.min(1, st.endT / 0.8);
      ctx.globalAlpha = k; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillStyle = BRASS_L; ctx.font = `600 ${0.34 * c}px Fraunces, Georgia, serif`;
      const score = st.outcome === 'draw' ? '½–½' : (inst.won === (aiColor === 0) ? '1–0' : '0–1');
      const sc2 = st.outcome === 'draw' ? '½–½' : ((st.won || inst.won) ? (aiColor === 0 ? '1–0' : '0–1') : (aiColor === 0 ? '0–1' : '1–0'));
      ctx.fillText(sc2, x0 + w / 2, ly1 - 0.35 * c);
    }
    ctx.restore();
  }

  layout();
  quickEval();
  st.evalShown = st.evalTarget;
  if (dbg) dbg.last = inst;
  return inst;
}

Arcade.register({
  id: 'chess', name: 'Marble & Brass', genre: 'Chess',
  blurb: 'A marble board, brass trim and a quietly thinking engine.',
  bg: '#2b1b11', accent: '#c9a45c',
  aiNote: 'Searches about five moves ahead with alpha-beta and plays one move every second or two; it only sees the board and the move list, like a spectator.',
  create,
});
})();
