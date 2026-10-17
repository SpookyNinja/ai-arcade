// Shell smoke test: builds, then screenshots start screen (desktop + phone), intro, play, result card.
// node tools/shell-test.mjs [outDir=/tmp/arcade-shell-shots]
import { createRequire } from 'module';
const require = createRequire('/opt/node22/lib/node_modules/');
const { chromium } = require('playwright');
import path from 'path';
import fs from 'fs';
import { execFileSync } from 'child_process';

const out = process.argv[2] || '/tmp/arcade-shell-shots';
fs.mkdirSync(out, { recursive: true });
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
execFileSync('python3', [path.join(root, 'build.py')], { stdio: 'inherit' });
const url = 'file://' + path.join(root, 'dist', 'ai-arcade.html');

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--disable-web-security', '--js-flags=--expose-gc', '--enable-precise-memory-info'] });
const errors = [];
const fails = [];
const check = (ok, msg) => { if (!ok) fails.push(msg); console.log((ok ? 'ok   ' : 'FAIL ') + msg); };
const watch = page => {
  page.on('pageerror', e => errors.push(String(e.stack || e)));
  page.on('console', m => { if (m.type() === 'error' && !/fonts\.g|ERR_|Failed to load resource/.test(m.text())) errors.push(m.text()); });
};

// force the running game to be over regardless of how it defines `over`/`won` (plain field or getter)
const FORCE = `(won) => { const c = __arcade.current;
  for (const [k, v] of [['over', true], ['won', won]]) {
    try { c[k] = v; } catch (e) { /* getter-only */ }
    if (c[k] !== v) Object.defineProperty(c, k, { get: () => v, set() {}, configurable: true });
  }
  return __arcade.def.id; }`;

// ---- phone start screen
{
  const page = await browser.newPage({ viewport: { width: 400, height: 800 } });
  watch(page);
  await page.goto(url); await page.waitForTimeout(1500);
  await page.screenshot({ path: `${out}/start-400.png` });
  const m = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth, s: document.getElementById('start').scrollWidth, sc: document.getElementById('start').clientWidth }));
  check(m.sw <= m.cw && m.s <= m.sc, `no horizontal scroll at 400px (${JSON.stringify(m)})`);
  await page.close();
}

// ---- desktop flow
{
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
  watch(page);
  await page.goto(url + '?twist=0&super=0'); await page.waitForTimeout(1500);
  await page.screenshot({ path: `${out}/start-1600.png` });
  const names = await page.$$eval('.card h3', els => els.map(e => e.textContent.trim()));
  check(names.join('|') === [...names].sort((a, b) => a.localeCompare(b, 'en', { sensitivity: 'base' })).join('|'), 'cards sorted alphabetically');
  check(/watched|No games/.test(await page.textContent('#totals')), 'totals footer present: ' + (await page.textContent('#totals')));
  check(await page.locator('.card .ainote').count() >= 20, 'start cards carry aiNote (' + await page.locator('.card .ainote').count() + ')');
  await page.click('#selNone');
  check(await page.locator('.card:not(.off)').count() === 1, 'Select none keeps exactly one game');
  await page.click('#selAll');
  check(await page.locator('.card.off').count() === 0, 'Select all enables every game');
  // toggles + records persistence
  const n = await page.locator('.card').count();
  check(n > 0, `start screen lists ${n} game cards`);
  if (n > 1) {
    await page.locator('.card .tog').nth(1).click();
    check(await page.locator('.card.off').count() === 1, 'toggle excludes a game');
    await page.screenshot({ path: `${out}/start-toggle.png` });
    await page.locator('.card .tog').nth(1).click();
  }
  await page.click('#startBtn');
  await page.waitForTimeout(900);
  check(await page.evaluate(() => __arcade.state) === 'intro', 'state intro after Start');
  await page.screenshot({ path: `${out}/intro.png` });
  const note = await page.textContent('#introNote');
  check(note.length > 20, 'intro card shows aiNote: ' + note);
  await page.waitForTimeout(2300);
  check(await page.evaluate(() => __arcade.state) === 'play', 'state play after intro');
  await page.mouse.move(800, 400); await page.waitForTimeout(400);
  await page.screenshot({ path: `${out}/play.png` });
  await page.keyboard.press('Space'); await page.waitForTimeout(200);
  check(await page.evaluate(() => __arcade.paused), 'Space pauses');
  await page.keyboard.press('Space');
  // force a game over
  // HUD "Up next" line
  await page.evaluate(() => { __arcade.clock = 41; }); await page.waitForTimeout(500);
  const hudTxt = await page.textContent('#hudDetail');
  check(/^Up next: /.test(hudTxt), 'HUD shows ' + hudTxt);
  await page.screenshot({ path: `${out}/hud-upnext.png`, clip: { x: 0, y: 700, width: 600, height: 200 } });
  await page.evaluate(() => { __arcade.clock = 0; });
  const name1 = await page.evaluate(`(${FORCE})(false)`);
  await page.waitForFunction(() => __arcade.state === 'ending', null, { timeout: 8000 });
  await page.waitForFunction(() => __arcade.state === 'card', null, { timeout: 5000 });
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${out}/result-lost.png` });
  await page.waitForFunction(() => __arcade.state === 'out', null, { timeout: 12000, polling: 15 });
  await page.waitForTimeout(215);
  await page.evaluate(() => document.getElementById('bPause').click());   // freeze mid-wipe
  await page.waitForTimeout(60);
  await page.screenshot({ path: `${out}/wipe-mid.png` });
  check(await page.evaluate(() => getComputedStyle(document.getElementById('wipe')).display) === 'block', 'wipe visible during transition');
  await page.evaluate(() => document.getElementById('bPause').click());
  await page.waitForFunction(() => __arcade.state === 'play', null, { timeout: 15000 });
  const id2 = await page.evaluate(() => __arcade.def.id);
  check(n < 2 || id2 !== name1, `next game differs (${name1} -> ${id2})`);
  // won result
  await page.evaluate(`(${FORCE})(true)`);
  await page.waitForFunction(() => __arcade.state === 'card', null, { timeout: 8000 });
  await page.waitForTimeout(1200);
  await page.screenshot({ path: `${out}/result-won.png` });
  const rec = await page.evaluate(() => localStorage.getItem('aa.rec'));
  check(!!rec, 'record saved ' + rec);
  // skip, menu
  await page.keyboard.press('n'); await page.waitForTimeout(1500);
  await page.evaluate(() => document.fullscreenElement && document.exitFullscreen()); await page.waitForTimeout(300);
  await page.keyboard.press('Escape'); await page.waitForTimeout(800);
  check(await page.evaluate(() => __arcade.state) === 'menu', 'Esc returns to menu');
  await page.screenshot({ path: `${out}/menu-after.png` });
  await page.close();
}

// ---- round 8: twist badge, 4x speed, endless high scores (games faked in page JS where they lack the feature)
{
  const FAKE = `(id, opts) => { const d = Arcade.get(id);
    if (!(d.twists && d.twists.length)) d.twists = [{ key: 'fake', name: 'Fake twist', desc: 'Something nasty may happen mid-game.' }];
    if (!d.__w) { d.__w = 1; const c0 = d.create; d.create = o => { window.__opts = o; const i = c0.call(d, o);
      if (o && o.twist && !i.twist) i.twist = { key: 'fake', name: 'Fake twist', desc: 'Something nasty may happen mid-game.' }; return i; }; }
    if (opts && opts.endless) { d.endless = true; d.parScore = opts.par; }
    return d.id; }`;
  const SETSCORE = `(sc) => { const c = __arcade.current; Object.defineProperty(c, 'score', { get: () => sc, configurable: true }); }`;
  const gameId = await (async () => { const p = await browser.newPage(); await p.goto(url); const id = await p.evaluate(() => Arcade.games[0].id); await p.close(); return id; })();

  // twist forced
  let page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
  watch(page);
  await page.goto(url + '?twist=1'); await page.waitForTimeout(1200);
  await page.evaluate(`(${FAKE})('${gameId}')`);
  await page.evaluate(`__arcade.start(Arcade.get('${gameId}'))`);
  await page.waitForTimeout(2600);
  check(await page.evaluate(() => !!window.__opts.twist), '?twist=1 passes opts.twist');
  check(await page.isVisible('#introTwist') && (await page.textContent('#introTwist .tw-name')).trim().length > 2, 'intro shows TWIST badge + name');
  check(await page.evaluate(() => __arcade.state) === 'intro', 'intro lasts long enough to read the twist');
  await page.screenshot({ path: `${out}/intro-twist.png` });
  await page.waitForFunction(() => __arcade.state === 'play', null, { timeout: 8000 });
  check(await page.isVisible('#hudTwist'), 'HUD TWIST tag visible during play');
  await page.mouse.move(800, 400); await page.waitForTimeout(300);
  await page.screenshot({ path: `${out}/hud-twist.png`, clip: { x: 0, y: 700, width: 600, height: 200 } });
  const lbl = () => page.textContent('#speedLbl');
  await page.keyboard.press('1');
  const seq = [];
  for (let i = 0; i < 3; i++) { await page.click('#bSpeed'); seq.push(await lbl()); }
  check(seq.join(',') === '2x,4x,1x', '4x cycle 1->2->4->1 (' + seq + ')');
  await page.keyboard.press('4');
  check(await lbl() === '4x' && await page.evaluate(() => __arcade.speed) === 4, 'key 4 sets 4x');
  await page.keyboard.press('1');
  await page.close();

  // special game runs at 1x and restores the previous speed afterwards
  page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  watch(page);
  await page.goto(url + '?twist=1&speed=4'); await page.waitForTimeout(1000);
  await page.evaluate(`(${FAKE})('${gameId}')`);
  await page.evaluate(`__arcade.start(Arcade.get('${gameId}'))`);
  check(await page.evaluate(() => __arcade.speed) === 1, 'twist game starts at 1x');
  await page.keyboard.press('2');
  check(await page.evaluate(() => __arcade.speed) === 2, 'manual speed change respected during special game');
  await page.evaluate(() => { __arcade.skip(); });
  await page.waitForFunction(() => __arcade.state === 'out' || __arcade.state === 'intro' || __arcade.state === 'play', null, { timeout: 5000 });
  check(await page.evaluate(() => __arcade.speed) === 4, 'previous speed (4x) restored after special game');
  await page.evaluate(`__arcade.start(Arcade.get('${gameId}'))`);
  await page.evaluate(() => __arcade.toMenu());
  check(await page.evaluate(() => __arcade.speed) === 4, 'speed restored on return to menu');
  await page.close();

  // twist disabled
  page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  watch(page);
  await page.goto(url + '?twist=0'); await page.waitForTimeout(1000);
  await page.evaluate(`(${FAKE})('${gameId}')`);
  let any = false;
  for (let i = 0; i < 12; i++) { await page.evaluate(`__arcade.start(Arcade.get('${gameId}'))`); if (await page.evaluate(() => !!window.__opts.twist)) any = true; }
  check(!any, '?twist=0 never passes a twist');
  await page.close();

  // endless high score + super + twist together
  page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
  watch(page);
  await page.goto(url + '?twist=1&super=1'); await page.waitForTimeout(1000);
  await page.evaluate(`(${FAKE})('${gameId}', { endless: true, par: 12000 })`);
  await page.evaluate(`__arcade.start(Arcade.get('${gameId}'))`);
  await page.waitForTimeout(2700);
  await page.screenshot({ path: `${out}/intro-twist-super.png` });
  check(await page.evaluate(() => window.__opts.best) === 12000 && await page.evaluate(() => window.__opts.superAI === true), 'create opts carry best=parScore and superAI');
  await page.waitForFunction(() => __arcade.state === 'play', null, { timeout: 8000 });
  check(/Best 12\s?000/.test((await page.textContent('#hudBest')).replace(/ /g, ' ')), 'HUD shows Best (par)');
  await page.evaluate(`(${SETSCORE})(15200)`);
  await page.evaluate(`(${FORCE})(false)`);
  await page.waitForFunction(() => __arcade.state === 'card', null, { timeout: 8000 });
  await page.waitForTimeout(1200);
  await page.screenshot({ path: `${out}/result-highscore-par.png` });
  check(await page.evaluate(() => __arcade.result.won === true), 'endless: score above par -> won (own won ignored)');
  check(/NEW HIGH SCORE/i.test(await page.textContent('#rhigh')), 'result card shows NEW HIGH SCORE');
  check(await page.evaluate((id) => localStorage.getItem('aa.bestS.' + id), gameId) === '15200' && await page.evaluate((id) => localStorage.getItem('aa.best.' + id), gameId) === null, 'Super AI best stored under its own key');
  await page.close();

  page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
  watch(page);
  await page.goto(url + '?twist=1&super=0'); await page.waitForTimeout(1000);
  await page.evaluate(`(${FAKE})('${gameId}', { endless: true, par: 12000 })`);
  await page.evaluate((id) => localStorage.setItem('aa.best.' + id, '15200'), gameId);
  await page.evaluate(`__arcade.start(Arcade.get('${gameId}'))`);
  await page.waitForFunction(() => __arcade.state === 'play', null, { timeout: 8000 });
  check(await page.evaluate(() => window.__opts.best) === 15200, 'stored best passed as opts.best');
  await page.evaluate(`(${SETSCORE})(9000)`);
  await page.evaluate(`(${FORCE})(true)`);
  await page.waitForFunction(() => __arcade.state === 'card', null, { timeout: 8000 });
  await page.waitForTimeout(1200);
  await page.screenshot({ path: `${out}/result-endless-lost.png` });
  check(await page.evaluate(() => __arcade.result.won === false), 'endless: score below best -> lost (own won ignored)');
  check(/Best:\s*15\s?200/.test((await page.textContent('#rhigh')).replace(/ /g, ' ')), 'result card shows Best: 15 200');
  check(/Twist/i.test(await page.textContent('#rtwist')), 'result card mentions the twist');
  const rec2 = await page.evaluate(() => JSON.parse(localStorage.getItem('aa.rec')));
  check(rec2 && rec2[gameId] && rec2[gameId].l === 1 && !rec2[gameId].w, 'W/L record uses the endless verdict');
  await page.waitForFunction(() => __arcade.state === 'play' && __arcade.def.id === Arcade.games[0].id, null, { timeout: 20000 }).catch(() => {});
  await page.evaluate(`__arcade.start(Arcade.get('${gameId}'))`);
  await page.waitForFunction(() => __arcade.state === 'play', null, { timeout: 8000 });
  await page.evaluate(`(${SETSCORE})(20000)`);
  await page.evaluate(`(${FORCE})(false)`);
  await page.waitForFunction(() => __arcade.state === 'card', null, { timeout: 8000 });
  await page.waitForTimeout(1200);
  await page.screenshot({ path: `${out}/result-highscore.png` });
  check(await page.evaluate((id) => localStorage.getItem('aa.best.' + id), gameId) === '20000', 'new normal best stored');
  check(await page.locator('#rhigh .hs-old s').count() === 1, 'old best shown struck through');
  await page.close();
}

// ---- long-run stability: many fast games must not grow DOM, heap or timers
{
  const page = await browser.newPage({ viewport: { width: 1000, height: 600 } });
  watch(page);
  await page.goto(url + '?autostart=1&speed=4'); await page.waitForTimeout(1500);
  const snap = () => page.evaluate(async () => { gc(); await new Promise(r => setTimeout(r, 50)); gc(); return { dom: document.getElementsByTagName('*').length, heap: performance.memory.usedJSHeapSize, id: __arcade.def && __arcade.def.id }; });
  const skipN = async n => { for (let i = 0; i < n; i++) { await page.evaluate(() => __arcade.skip()); await page.waitForFunction(() => __arcade.state === 'intro' || __arcade.state === 'play', null, { timeout: 8000 }); await page.waitForTimeout(250); } };
  await skipN(22);                                // warm up: every game created once
  const a = await snap();
  await skipN(44);
  const b = await snap();
  console.log('stability', JSON.stringify(a), JSON.stringify(b));
  check(b.dom === a.dom, `DOM node count stable (${a.dom} -> ${b.dom})`);
  check(b.heap < a.heap * 1.6 + 8e6, `JS heap stable (${(a.heap / 1e6).toFixed(1)} MB -> ${(b.heap / 1e6).toFixed(1)} MB)`);
  await page.close();
}

// ---- error isolation: a throwing step skips to the next game
{
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  watch(page);
  await page.goto(url + '?autostart=1&speed=2&twist=0&super=0'); await page.waitForTimeout(2800);
  const before = await page.evaluate(() => __arcade.def.id);
  await page.evaluate(() => { __arcade.current.step = () => { throw new Error('boom (expected test error)'); }; });
  await page.waitForTimeout(2500);
  const st = await page.evaluate(() => [__arcade.state, __arcade.def && __arcade.def.id, Arcade.games.length]);
  check(st[0] !== 'menu' && (st[1] !== before || st[2] < 2), `error skips game (${before} -> ${st})`);
  await page.close();
}

const real = errors.filter(e => !/boom/.test(e));
console.log(real.length ? 'PAGE ERRORS:\n' + [...new Set(real)].join('\n') : 'no page errors');
console.log('screenshots in ' + out);
await browser.close();
process.exit(fails.length || real.length ? 1 : 0);
