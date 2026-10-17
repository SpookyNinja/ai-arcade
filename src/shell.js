// shell.js — start screen, rotation state machine, HUD, controls. Loaded last.
(() => {
  'use strict';

  const $ = id => document.getElementById(id);
  const LS = {
    get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* storage blocked */ } },
  };
  let P;
  try { P = new URLSearchParams(location.search); } catch (e) { P = new URLSearchParams(''); }

  const BG = '#0d1117', AMBER = '#f2a93b', CORAL = '#e8735f';
  const T_INTRO_PLAIN = 1.8, T_INTRO_NOTE = 3.4, T_ENDING = 2.5, T_CARD = 4, T_OUT = 0.35, T_IN = 0.4, DT = 1 / 60;
  const UPNEXT_EVERY = 45, UPNEXT_FOR = 6;   // HUD "Up next" swap: last 6 s of each 45 s window
  const MAX_GAME_SECONDS = 1500;            // watchdog: a game that never ends is skipped

  const canvas = $('stage');
  const ctx = canvas.getContext('2d');
  let W = 800, H = 600, dpr = 1;

  // ---- runtime state ----
  let state = 'menu';     // menu | intro | play | ending | card | out
  let t = 0;              // seconds in current state
  let cur = null, curDef = null, nextDef = null, broken = false;
  Arcade.alpha = 1; let alphaV = 1;
  let acc = 0, speed = Math.max(0.25, +P.get('speed') || 1);
  let paused = false, hudHidden = false, started = false, failCount = 0, lastId = null;
  let bag = [], menuT = 0, hudAge = 0, hudTick = 0, lastHud = '';
  let introDur = T_INTRO_PLAIN, playClock = 0, wipeIn = false, wipeColor = AMBER, wipeOn = false;

  // ---------------------------------------------------------------- storage
  const records = () => LS.get('aa.rec', {});
  const offSet = () => new Set(LS.get('aa.off', []));
  function record(id, won) {
    const r = records(); const e = r[id] || { w: 0, l: 0 };
    if (won) e.w++; else e.l++;
    r[id] = e; LS.set('aa.rec', r); updateRec(id); updateTotals();
  }
  function updateTotals() {
    let w = 0, l = 0; const r = records();
    for (const k in r) { w += r[k].w | 0; l += r[k].l | 0; }
    const n = w + l, el = $('totals');
    if (!el) return;
    el.textContent = n ? n + (n === 1 ? ' game' : ' games') + ' watched \u00b7 AI won ' + w : 'No games watched yet';
  }
  function enabledGames() {
    const off = offSet();
    const e = Arcade.games.filter(g => !off.has(g.id));
    return e.length ? e : Arcade.games.slice(0, 1);
  }
  function pickNext() {
    const en = enabledGames(), ids = new Set(en.map(g => g.id));
    bag = bag.filter(id => ids.has(id));
    if (!bag.length) {
      bag = rnd.shuffle(en.map(g => g.id));
      if (bag.length > 1 && bag[0] === lastId) { const x = bag.pop(); bag.unshift(x); }
    }
    let i = bag.findIndex(id => id !== lastId);
    if (i < 0) i = 0;
    return Arcade.get(bag.splice(i, 1)[0]);
  }

  // ---------------------------------------------------------------- start screen DOM
  const cardEls = {};
  function recHtml(id) {
    const e = records()[id];
    if (!e || (!e.w && !e.l)) return '<span class="none">No runs yet</span>';
    return `<b class="w">${e.w}</b> W &middot; <b class="l">${e.l}</b> L`;
  }
  function updateRec(id) {
    const c = cardEls[id]; if (!c) return;
    const el = c.querySelector('.rec');
    el.innerHTML = recHtml(id);
    el.className = 'rec' + (/none/.test(el.innerHTML) ? ' none' : '');
  }
  function updateCount() {
    const off = offSet(), n = Arcade.games.filter(g => !off.has(g.id)).length;
    $('rotCount').textContent = n + ' of ' + Arcade.games.length + ' active';
  }
  function toggle(id) {
    const off = offSet();
    if (off.has(id)) off.delete(id);
    else if (Arcade.games.filter(g => !off.has(g.id)).length > 1) off.add(id);
    else { // keep at least one on: nudge
      const c = cardEls[id]; c.animate([{ transform: 'translateX(0)' }, { transform: 'translateX(-5px)' }, { transform: 'translateX(5px)' }, { transform: 'none' }], { duration: 260 });
      return;
    }
    LS.set('aa.off', [...off]);
    paintToggles();
  }
  function paintToggles() {
    const off = offSet();
    for (const g of Arcade.games) {
      const c = cardEls[g.id], on = !off.has(g.id);
      c.classList.toggle('off', !on);
      c.querySelector('.tog').setAttribute('aria-checked', on ? 'true' : 'false');
    }
    updateCount();
  }
  const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  function buildMenu() {
    const grid = $('grid'); grid.innerHTML = '';
    const sorted = Arcade.games.slice().sort((a, b) => String(a.name).localeCompare(String(b.name), 'en', { sensitivity: 'base' }));
    sorted.forEach((g, i) => {
      const li = document.createElement('li');
      li.className = 'card'; li.dataset.id = g.id;
      li.style.setProperty('--a', g.accent || AMBER);
      li.style.setProperty('--b', g.bg || '#1a2230');
      li.style.setProperty('--i', i);
      li.innerHTML = `<div class="top"><div class="sw"></div><div class="titles"><div class="genre">${esc(g.genre)}</div><h3>${esc(g.name)}</h3></div></div>
        <p class="blurb">${esc(g.blurb || '')}</p>
        ${g.aiNote ? `<p class="ainote"><span>AI</span>${esc(g.aiNote)}</p>` : ''}
        <div class="foot"><span class="rec"></span><button class="tog" type="button" role="switch" aria-label="Include ${esc(g.name)} in rotation"></button></div>`;
      li.addEventListener('click', () => toggle(g.id));
      li.addEventListener('mouseenter', () => { hoverId = g.id; });
      li.addEventListener('mouseleave', () => { if (hoverId === g.id) hoverId = null; });
      grid.appendChild(li); cardEls[g.id] = li;
      updateRec(g.id);
    });
    paintToggles(); updateTotals();
    $('selAll').addEventListener('click', () => setAll(true));
    $('selNone').addEventListener('click', () => setAll(false));
  }
  function setAll(on) {
    if (on) LS.set('aa.off', []);
    else { // keep one game on (the first alphabetically that is currently on, else the first)
      const keep = Object.keys(cardEls).sort((a, b) => cardEls[a].style.getPropertyValue('--i') - cardEls[b].style.getPropertyValue('--i'));
      const off = offSet(); const stay = keep.find(id => !off.has(id)) || keep[0];
      LS.set('aa.off', Arcade.games.filter(g => g.id !== stay).map(g => g.id));
    }
    paintToggles();
  }

  // ---------------------------------------------------------------- backdrop (calm drifting blobs + faint grid)
  let hoverId = null;
  const sprites = {};
  function sprite(color) {
    if (sprites[color]) return sprites[color];
    const c = document.createElement('canvas'); c.width = c.height = 256;
    const x = c.getContext('2d');
    x.fillStyle = color; x.fillRect(0, 0, 256, 256);
    const g = x.createRadialGradient(128, 128, 0, 128, 128, 128);
    g.addColorStop(0, 'rgba(0,0,0,1)'); g.addColorStop(0.45, 'rgba(0,0,0,.45)'); g.addColorStop(1, 'rgba(0,0,0,0)');
    x.globalCompositeOperation = 'destination-in'; x.fillStyle = g; x.fillRect(0, 0, 256, 256);
    return (sprites[color] = c);
  }
  const boost = {};
  let vig = null, vigKey = '';
  function drawBackdrop(dt) {
    menuT += dt;
    ctx.fillStyle = BG; ctx.fillRect(0, 0, W, H);
    const m = Math.max(W, H);
    // blobs
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    const games = Arcade.games.length ? Arcade.games : [{ id: '_', accent: AMBER }];
    games.forEach((g, i) => {
      const k = i * 2.399;
      const x = W * (0.5 + 0.42 * Math.sin(menuT * 0.06 + k) + 0.1 * Math.sin(menuT * 0.11 + k * 2));
      const y = H * (0.5 + 0.40 * Math.cos(menuT * 0.05 + k * 1.3) + 0.08 * Math.sin(menuT * 0.09 + k));
      const r = m * (0.2 + 0.05 * Math.sin(menuT * 0.1 + k * 3));
      const want = hoverId === g.id ? 0.34 : 0.1;
      boost[g.id] = (boost[g.id] == null ? 0.1 : boost[g.id]) + (want - (boost[g.id] == null ? 0.1 : boost[g.id])) * Math.min(1, dt * 4);
      ctx.globalAlpha = boost[g.id] * (hoverId === g.id ? 1 : 1);
      ctx.drawImage(sprite(g.accent || AMBER), x - r, y - r, r * 2, r * 2);
    });
    ctx.restore();
    // grid
    const s = 56, off = (menuT * 5) % s;
    ctx.strokeStyle = 'rgba(239,232,218,0.035)'; ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = -off; x < W; x += s) { ctx.moveTo(Math.round(x) + 0.5, 0); ctx.lineTo(Math.round(x) + 0.5, H); }
    for (let y = -off; y < H; y += s) { ctx.moveTo(0, Math.round(y) + 0.5); ctx.lineTo(W, Math.round(y) + 0.5); }
    ctx.stroke();
    // vignette
    if (!vig || vigKey !== W + 'x' + H) {
      vig = ctx.createRadialGradient(W / 2, H / 2, m * 0.2, W / 2, H / 2, m * 0.8);
      vig.addColorStop(0, 'rgba(13,17,23,0)'); vig.addColorStop(1, 'rgba(13,17,23,.85)'); vigKey = W + 'x' + H;
    }
    ctx.fillStyle = vig; ctx.fillRect(0, 0, W, H);
  }

  // ---------------------------------------------------------------- sizing
  function resize() {
    dpr = Math.min(2, window.devicePixelRatio || 1);
    W = Math.max(1, window.innerWidth); H = Math.max(1, window.innerHeight);
    canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
    if (cur && !broken) { try { cur.resize(W, H); } catch (e) { fail(e); } }
  }

  // ---------------------------------------------------------------- game lifecycle
  function startGame(def) {
    dropCurrent();
    curDef = def; broken = false; nextDef = null; acc = 0; alphaV = 1; t = 0; playClock = 0;
    const viaWipe = state === 'out'; wipeIn = viaWipe;
    hideResult();
    try {
      cur = def.create(); cur.resize(W, H);
    } catch (e) { fail(e); return; }
    // pre-pick the following game so the HUD can announce it
    lastId = def.id; nextDef = pickNext();
    state = 'intro'; hudAge = 0; lastHud = '';
    const style = cur && cur.style ? String(cur.style) : '';
    introDur = (def.aiNote || style) ? T_INTRO_NOTE : T_INTRO_PLAIN;
    const hudEl = $('hud'); hudEl.classList.remove('dim');
    $('hudName').textContent = def.name;
    const intro = $('intro');
    $('introGenre').textContent = def.genre;
    $('introName').textContent = def.name;
    $('introNote').textContent = def.aiNote || '';
    let tac = $('introTactic');
    if (!tac) { tac = document.createElement('p'); tac.id = 'introTactic'; tac.className = 'intro-tactic'; $('introNote').after(tac); }
    tac.textContent = style ? 'Tactic: ' + style : '';
    intro.style.setProperty('--ac', def.accent || AMBER);
    intro.style.setProperty('--dur', introDur + 's');
    intro.classList.remove('run'); void intro.offsetWidth; intro.classList.add('run');
    syncChrome();
  }
  // release the finished game instance so nothing keeps it alive between games
  function dropCurrent() {
    const c = cur; cur = null;
    try { if (c && typeof c.destroy === 'function') c.destroy(); } catch (e) { /* noop */ }
  }
  function fail(e) {
    try { console.error('[arcade] game error in', curDef && curDef.id, e); } catch (_) { /* noop */ }
    broken = true; failCount++;
    if (failCount >= 4) { toMenu(); return; }
    goOut();
  }
  function goOut() {
    if (state === 'menu') return;
    if (!nextDef) { lastId = curDef ? curDef.id : lastId; nextDef = pickNext(); }
    hideResult();
    $('intro').classList.remove('run');
    wipeColor = nextDef.accent || AMBER;
    $('wipe').style.setProperty('--wc', wipeColor);
    state = 'out'; t = 0;
  }
  function showResult() {
    const won = !!cur.won;
    let text = '', score = '';
    try { text = cur.result(); } catch (e) { text = ''; }
    try { score = cur.hud().score; } catch (e) { score = ''; }
    const r = $('result');
    r.classList.toggle('lost', !won);
    r.style.setProperty('--rc', won ? (curDef.accent || AMBER) : CORAL);
    r.querySelector('.panel').style.setProperty('--rc', won ? (curDef.accent || AMBER) : CORAL);
    $('verdict').textContent = won ? 'AI won' : 'AI lost';
    $('rtext').textContent = text || '';
    $('rscore').textContent = score || '-';
    $('rnext').textContent = nextDef ? nextDef.name : '';
    $('rbar').style.transform = 'scaleX(0)';
    void r.offsetWidth; r.classList.add('show');
  }
  function hideResult() { $('result').classList.remove('show'); }

  function stepGame(dt, stopOnOver) {
    if (!cur || broken) return;
    acc += dt * speed;
    const cap = Math.max(5, Math.ceil(speed * 2));
    let n = 0;
    try {
      while (acc >= DT && n < cap) {
        cur.step(DT); acc -= DT; n++;
        if (stopOnOver && cur.over) break;
      }
    } catch (e) { fail(e); return; }
    if (acc > DT * 2) acc = DT;
    alphaV = Math.max(0, Math.min(1, acc / DT));
  }

  function update(dt) {
    if (state === 'menu') return;
    if (paused) return;
    t += dt;
    hudAge += dt;
    if (state === 'intro') {
      if (t >= introDur) { state = 'play'; t = 0; }
    } else if (state === 'play') {
      playClock += dt;
      stepGame(dt, true);
      if (state === 'play' && playClock > MAX_GAME_SECONDS) { console.warn('[arcade] watchdog skip', curDef && curDef.id); goOut(); return; }
      if (state === 'play' && cur && cur.over) {
        state = 'ending'; t = 0;
        if (!nextDef) { lastId = curDef.id; nextDef = pickNext(); }
        record(curDef.id, !!cur.won); failCount = 0;
      }
    } else if (state === 'ending') {
      stepGame(dt, false);
      t += dt * (speed - 1);
      if (state === 'ending' && t >= T_ENDING) { state = 'card'; t = 0; showResult(); }
    } else if (state === 'card') {
      $('rbar').style.transform = 'scaleX(' + Math.min(1, t / T_CARD) + ')';
      if (t >= T_CARD) goOut();
    } else if (state === 'out') {
      if (t >= T_OUT) startGame(nextDef || pickNext());
    }
  }

  // ---------------------------------------------------------------- render
  function render(dt) {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (state === 'menu') { drawBackdrop(dt); return; }
    ctx.fillStyle = (curDef && curDef.bg) || BG; ctx.fillRect(0, 0, W, H);
    if (cur && !broken) {
      try { Arcade.alpha = alphaV; ctx.save(); cur.draw(ctx, W, H); ctx.restore(); }
      catch (e) { try { ctx.restore(); } catch (_) { /* noop */ } ctx.setTransform(dpr, 0, 0, dpr, 0, 0); fail(e); }
    }
    let veil = 0;
    if (state === 'intro' && !wipeIn) veil = Math.max(0, 1 - t / T_IN);
    if (veil > 0) {
      const e = veil * veil * (3 - 2 * veil);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.fillStyle = 'rgba(13,17,23,' + e.toFixed(3) + ')'; ctx.fillRect(0, 0, W, H);
    }
    drawWipe();
    // HUD text (cheap, ~8 Hz)
    hudTick -= dt;
    if (hudTick <= 0 && cur && !broken) {
      hudTick = 0.12;
      try {
        const h = cur.hud() || {};
        const up = upNextOn();
        let detail = up ? 'Up next: ' + nextDef.name : (h.detail == null ? '' : h.detail);
        if (!up && cur.style && state === 'play' && playClock < 6) detail = 'Tactic: ' + cur.style + (detail ? ' \u00b7 ' + detail : '');
        const s = (h.score == null ? '' : h.score) + '|' + detail;
        if (s !== lastHud) {
          lastHud = s; $('hudScore').textContent = h.score == null ? '' : h.score;
          const de = $('hudDetail'); de.textContent = detail; de.classList.toggle('upnext', up);
        }
        $('hud').classList.toggle('dim', hudAge > 4 && !up);
      } catch (e) { /* ignore hud errors */ }
    }
  }

  // "Up next" shows during the last UPNEXT_FOR seconds of every UPNEXT_EVERY-second window of play
  function upNextOn() {
    if (state !== 'play' || !nextDef || nextDef === curDef || (curDef && nextDef.id === curDef.id)) return false;
    const c = playClock % UPNEXT_EVERY;
    return c >= UPNEXT_EVERY - UPNEXT_FOR;
  }

  // diagonal wipe in the next game's accent: covers during 'out', uncovers in the first T_OUT of 'intro'
  const ease = x => x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
  let wipeKey = '';
  function drawWipe() {
    let p = -1;
    if (state === 'out') p = 0.5 * Math.min(1, t / T_OUT);
    else if (state === 'intro' && wipeIn && t < T_OUT) p = 0.5 + 0.5 * Math.min(1, t / T_OUT);
    const el = $('wipe');
    if (p < 0) { if (wipeOn) { wipeOn = false; wipeKey = ''; el.style.display = 'none'; } return; }
    if (!wipeOn) { wipeOn = true; el.style.display = 'block'; }
    const k = 0.4, w = 1.12, D = W + k * H;
    const L = ease(p) * (1 + w), R = L - w;
    const a = Math.max(0, R) * D, b = Math.min(1, L) * D, sk = k * H;   // clamped to the visible range
    const key = Math.round(a) + ',' + Math.round(b) + ',' + W + ',' + H;
    if (key === wipeKey) return; wipeKey = key;
    el.style.clipPath = 'polygon(' + a + 'px 0,' + b + 'px 0,' + (b - sk) + 'px ' + H + 'px,' + (a - sk) + 'px ' + H + 'px)';
  }

  // ---------------------------------------------------------------- chrome (hud / bar visibility)
  function syncChrome() {
    const inGame = state !== 'menu';
    $('hud').classList.toggle('on', inGame && !hudHidden);
    $('bar').classList.toggle('on', inGame);
    document.body.classList.toggle('paused', paused && inGame);
    $('speedLbl').textContent = (Math.round(speed * 100) / 100) + 'x';
    if (!inGame) { $('bar').classList.remove('show'); document.body.classList.remove('idle'); }
  }
  let idleTimer = 0;
  function wake() {
    if (state === 'menu') return;
    $('bar').classList.add('show');
    document.body.classList.remove('idle');
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      if (state === 'menu') return;
      if ($('bar').matches(':hover')) { wake(); return; }
      $('bar').classList.remove('show'); document.body.classList.add('idle');
    }, 2500);
  }

  // ---------------------------------------------------------------- user actions
  let wakeLock = null;
  async function requestWake() {
    try {
      if (navigator.wakeLock && !wakeLock) {
        const lock = await navigator.wakeLock.request('screen');
        wakeLock = lock;
        lock.addEventListener('release', () => { if (wakeLock === lock) wakeLock = null; }, { once: true });
      }
    } catch (e) { wakeLock = null; }
  }
  function releaseWake() { try { if (wakeLock) wakeLock.release(); } catch (e) { /* noop */ } wakeLock = null; }
  function fullscreen() {
    try {
      const d = document, el = d.documentElement;
      if (d.fullscreenElement || d.webkitFullscreenElement) { (d.exitFullscreen || d.webkitExitFullscreen).call(d); }
      else { const p = (el.requestFullscreen || el.webkitRequestFullscreen).call(el); if (p && p.catch) p.catch(() => {}); }
    } catch (e) { /* unsupported */ }
  }
  const isFull = () => !!(document.fullscreenElement || document.webkitFullscreenElement);

  function start(firstDef) {
    if (!Arcade.games.length) return;
    started = true; failCount = 0; paused = false; bag = []; lastId = null;
    $('start').classList.add('gone');
    if (!P.get('autostart') && !firstDef) { try { const p = document.documentElement.requestFullscreen && document.documentElement.requestFullscreen(); if (p && p.catch) p.catch(() => {}); } catch (e) { /* ignore */ } }
    requestWake();
    startGame(firstDef || pickNext());
    wake();
  }
  function toMenu() {
    state = 'menu'; dropCurrent(); curDef = null; nextDef = null; paused = false; hoverId = null; wipeIn = false;
    hideResult(); $('intro').classList.remove('run');
    $('start').classList.remove('gone');
    releaseWake(); syncChrome();
    try { $('startBtn').focus({ preventScroll: true }); } catch (e) { /* noop */ }
  }
  function skip() { if (state !== 'menu') { paused = false; syncChrome(); if (state !== 'out') goOut(); } }
  function togglePause() { if (state === 'menu') return; paused = !paused; syncChrome(); }
  function setSpeed(v) { speed = v; syncChrome(); }
  function toggleHud() { hudHidden = !hudHidden; syncChrome(); }

  // ---------------------------------------------------------------- events
  $('startBtn').addEventListener('click', e => { e.stopPropagation(); start(); });
  $('bSkip').addEventListener('click', skip);
  $('bPause').addEventListener('click', togglePause);
  $('bSpeed').addEventListener('click', () => setSpeed(speed === 1 ? 2 : 1));
  $('bFull').addEventListener('click', fullscreen);
  $('bMenu').addEventListener('click', toMenu);
  window.addEventListener('mousemove', wake, { passive: true });
  window.addEventListener('mousedown', wake, { passive: true });
  window.addEventListener('touchstart', wake, { passive: true });
  window.addEventListener('resize', resize);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && started && state !== 'menu') requestWake();
  });
  window.addEventListener('keydown', e => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const k = e.key;
    if (state === 'menu') {
      if (k === ' ' || k === 'Enter') { if (document.activeElement && document.activeElement.classList.contains('start-btn') && k === 'Enter') return; e.preventDefault(); start(); }
      return;
    }
    wake();
    if (k === 'n' || k === 'N') skip();
    else if (k === ' ') { e.preventDefault(); togglePause(); }
    else if (k === 'f' || k === 'F') fullscreen();
    else if (k === 'h' || k === 'H') toggleHud();
    else if (k === 'Escape') { if (!isFull()) toMenu(); }
    else if (k === '1') setSpeed(1);
    else if (k === '2') setSpeed(2);
  });

  // ---------------------------------------------------------------- main loop
  let last = performance.now();
  function frame(now) {
    requestAnimationFrame(frame);
    const dt = Math.min(0.1, Math.max(0, (now - last) / 1000)); last = now;
    update(dt);
    render(dt);
  }

  window.__arcade = {
    get state() { return state; },
    get current() { return cur; },
    get def() { return curDef; },
    get speed() { return speed; },
    get next() { return nextDef; },
    get clock() { return playClock; },
    set clock(v) { playClock = v; },
    get paused() { return paused; },
    skip, start, toMenu,
  };

  buildMenu();
  resize();
  syncChrome();
  requestAnimationFrame(t0 => { last = t0; frame(t0); });

  const gid = P.get('game');
  if (gid && Arcade.get(gid)) start(Arcade.get(gid));
  else if (P.get('autostart') && Arcade.games.length) start();
})();
