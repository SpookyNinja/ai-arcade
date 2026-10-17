// Headless test runner for one game.
// node tools/run.mjs <gameId> [rounds=5] [maxSecondsPerRound=600] [shotDir]
// Plays `rounds` games via the dev harness' simulate() API (no rendering, fast), prints
// win/loss, duration and result for each, and reports page errors. Also saves screenshots of
// live rendering (after 3s and 12s of real-time play) to shotDir (default /tmp/arcade-shots).
import { createRequire } from 'module';
const require = createRequire('/opt/node22/lib/node_modules/');
const { chromium } = require('playwright');
import path from 'path';
import fs from 'fs';

const [id, rounds = '5', maxSec = '600', shotDir = '/tmp/arcade-shots'] = process.argv.slice(2);
if (!id) { console.error('usage: node tools/run.mjs <gameId> [rounds] [maxSec] [shotDir]'); process.exit(1); }
fs.mkdirSync(shotDir, { recursive: true });
const here = path.dirname(new URL(import.meta.url).pathname);
const url = 'file://' + path.join(here, 'dev.html') + '?game=' + id;

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--disable-web-security'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
const errors = [];
page.on('pageerror', e => errors.push(String(e.stack || e)));
page.on('console', m => { if (m.type() === 'error' && !/fonts\.g/.test(m.text())) errors.push(m.text()); });
await page.goto(url + '&loop=0');
await page.waitForFunction(() => window.__test, null, { timeout: 10000 });
await page.waitForTimeout(3000);
await page.screenshot({ path: `${shotDir}/${id}-a.png` });
await page.waitForTimeout(9000);
await page.screenshot({ path: `${shotDir}/${id}-b.png` });

const out = [];
for (let r = 0; r < +rounds; r++) {
  await page.evaluate(() => window.__test.newGame());
  const t0 = Date.now();
  let s;
  for (let k = 0; k < +maxSec / 10; k++) {
    s = await page.evaluate(() => window.__test.simulate(10));
    if (s.over) break;
  }
  const line = `round ${r + 1}: ${s.over ? (s.won ? 'WON ' : 'LOST') : 'TIMEOUT'} game-time=${s.t.toFixed(0)}s cpu=${((Date.now() - t0) / 1000).toFixed(1)}s ${s.hud.score} | ${s.hud.detail} | ${s.result ?? ''}`;
  console.log(line); out.push(s);
}
await page.screenshot({ path: `${shotDir}/${id}-end.png` });
const wins = out.filter(s => s.won).length;
console.log(`\n${id}: ${wins}/${out.length} won, avg game-time ${(out.reduce((a, s) => a + s.t, 0) / out.length).toFixed(0)}s`);
console.log(errors.length ? 'ERRORS:\n' + [...new Set(errors)].slice(0, 10).join('\n') : 'no page errors');
console.log(`screenshots: ${shotDir}/${id}-a.png, -b.png, -end.png`);
await browser.close();
