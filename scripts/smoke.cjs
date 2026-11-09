// End-to-end smoke test: plays a full daily climb in headless Chromium.
// The page runs inside a sandboxed iframe, like the claude.ai artifact viewer,
// so regressions such as "Enter does nothing" show up here.
//
//   npm run build && npm run smoke
//   (first time: npm install && npx playwright install chromium)
//
// Screenshots land in ./shots (git-ignored). Exits non-zero on failure.
const path = require('node:path');
const fs = require('node:fs');
const { chromium } = require('playwright');

const ROOT = path.join(__dirname, '..');
const SHOTS = path.join(ROOT, 'shots');
const PAGE = 'file://' + path.join(ROOT, 'index.html');

(async () => {
  fs.mkdirSync(SHOTS, { recursive: true });
  const wrapper = path.join(SHOTS, 'sandbox.html');
  fs.writeFileSync(wrapper, `<!doctype html><body style="margin:0"><iframe sandbox="allow-scripts allow-same-origin" src="${PAGE}" style="width:390px;height:844px;border:0"></iframe></body>`);

  // CHROME_PATH lets the smoke run on an installed Chrome when Playwright's own browser isn't downloaded.
  const browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {});
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('file://' + wrapper);
  await page.waitForTimeout(800);
  const f = page.frames()[1];
  const fail = (msg) => { console.error('FAIL', msg); process.exitCode = 1; };

  await f.click('#dlg-help [data-close]');
  await page.screenshot({ path: path.join(SHOTS, 'home.png') });
  // Speed the climb up: short legs, fast transitions.
  await f.evaluate(() => { const C = DA_ENGINE.CONFIG; C.legs.forEach((l) => (l.secs = 6)); C.transitionMs = 700; C.countdownSecs = 1; });
  const legs = await f.evaluate(() => {
    const E = DA_ENGINE;
    const cats = E.dailyCategories({ categories: DA_CATS.filter((c) => c.kind !== 'practice') }, E.puzzleNumber(E.localDateStr()));
    return cats.map((c) => { const ix = E.buildIndex(c); return { text: c.text, words: [0, 1, 2, 3, 4].map((t) => { const e = ix.entries.find((x) => x.tier === t); return e && { w: e.canon, t }; }).filter(Boolean) }; });
  });
  await f.click('#btn-begin');
  await page.waitForTimeout(1300);

  for (let i = 0; i < 7; i++) {
    const shown = await f.textContent('#category');
    if (shown !== legs[i].text) fail(`leg ${i + 1} shows "${shown}", expected "${legs[i].text}"`);
    await f.click('#answer');
    for (const { w, t } of legs[i].words) {
      await page.keyboard.type(w); await page.keyboard.press('Enter');
      if (t >= 3) {
        // Mountaineer / Sherpa: the spotlight must appear, hold the clock, then clear.
        try { await f.waitForSelector('#spot:not([hidden])', { timeout: 1500 }); } catch (e) { fail(`leg ${i + 1}: no spotlight for "${w}"`); continue; }
        const rank = await f.textContent('#spot-rank');
        if (rank !== (t === 3 ? 'Mountaineer' : 'Sherpa')) fail(`leg ${i + 1}: spotlight rank "${rank}"`);
        if (i === 0) await page.screenshot({ path: path.join(SHOTS, `spot-t${t}.png`) });
        await f.waitForSelector('#spot', { state: 'hidden', timeout: 4000 });
      }
      await page.waitForTimeout(170);
    }
    await page.keyboard.type('zzqxv'); await page.keyboard.press('Enter'); await page.waitForTimeout(170);
    const chips = await f.locator('.chip:not(.rejected)').count();
    if (chips !== legs[i].words.length) fail(`leg ${i + 1}: ${chips} chips for ${legs[i].words.length} valid answers`);
    if (i === 0) await page.screenshot({ path: path.join(SHOTS, 'leg1.png') });
    await f.waitForFunction(() => !document.querySelector('#transition').hidden || !document.querySelector('#results').hidden, null, { timeout: 20000 });
    if (i < 6) await f.waitForFunction(() => document.querySelector('#transition').hidden, null, { timeout: 20000 });
  }
  await f.waitForSelector('#results:not([hidden])', { timeout: 20000 });
  await page.waitForTimeout(1500);
  await page.screenshot({ path: path.join(SHOTS, 'results.png') });
  const share = await f.textContent('#share-box');
  if (!/^Daily Ascent #\d+/.test(share)) fail('share text missing: ' + share);
  console.log(share);

  await page.reload(); await page.waitForTimeout(1200);
  const label = await page.frames()[1].textContent('#btn-begin');
  if (label !== 'View Results') fail('after reload the button says "' + label + '"');

  // ---- dev mode: unlock with ?dev, play a full lap with the autoplay bot, and
  // confirm the real save (daily-ascent:v1) is untouched. Needs the private
  // dev.local.mjs for the password; skipped without it.
  const priv = path.join(ROOT, 'dev.local.mjs');
  if (!fs.existsSync(priv)) console.log('skip dev mode smoke: no dev.local.mjs');
  else {
    const { DEV_PASSWORD } = await import('file://' + priv);
    const devWrap = path.join(SHOTS, 'sandbox-dev.html');
    fs.writeFileSync(devWrap, `<!doctype html><body style="margin:0"><iframe sandbox="allow-scripts allow-same-origin" src="${PAGE}?dev" style="width:390px;height:844px;border:0"></iframe></body>`);
    await page.goto('file://' + devWrap);
    await page.waitForTimeout(900);
    const d = page.frames()[1];
    if (!(await d.evaluate(() => document.querySelector('#dlg-dev-lock').open))) fail('?dev did not open the password dialog');
    await d.fill('#dev-lock-pw', 'not-the-password'); await d.press('#dev-lock-pw', 'Enter');
    await page.waitForTimeout(1600);
    if (!/isn’t right/.test(await d.textContent('#dev-lock-err'))) fail('wrong dev password was not rejected');
    await d.fill('#dev-lock-pw', DEV_PASSWORD); await d.press('#dev-lock-pw', 'Enter');
    try { await d.waitForSelector('#dev-badge:not([hidden])', { timeout: 5000 }); } catch (e) { fail('dev mode did not unlock'); }
    const realBefore = await d.evaluate(() => localStorage.getItem('daily-ascent:v1'));
    await d.evaluate(() => { const C = DA_ENGINE.CONFIG; C.legs.forEach((l) => (l.secs = 6)); C.transitionMs = 700; C.countdownSecs = 1; });
    await d.click('#dev-acts [data-act="start-climb"]');
    await d.waitForFunction(() => /^Dev leg 1/.test(document.querySelector('#leg-label').textContent), null, { timeout: 5000 });
    // pause holds the clock
    await d.click('#dev-acts [data-act="pause"]');
    const s1 = await d.textContent('#secs'); await page.waitForTimeout(1500); const s2 = await d.textContent('#secs');
    if (s1 !== s2) fail(`pause did not hold the clock (${s1} → ${s2})`);
    if (await d.evaluate(() => document.querySelector('#dev-pause').hidden)) fail('no PAUSED overlay');
    await page.screenshot({ path: path.join(SHOTS, 'dev-paused.png') });
    await d.click('#dev-acts [data-act="pause"]');
    // autoplay bot until the climber passes the summit
    await d.click('#dev-tab-content');
    await d.selectOption('#dev-bot-rank', '2');
    await d.evaluate(() => { const r = document.querySelector('#dev-bot-rate'); r.value = '6'; r.dispatchEvent(new Event('input', { bubbles: true })); });
    await d.fill('#dev-bot-typo', '3'); await d.dispatchEvent('#dev-bot-typo', 'change');   // every 3rd answer misspelled
    await d.click('[data-act="bot"]');
    try {
      await d.waitForFunction(() => /Lap 2/.test(document.querySelector('#dev-hud').textContent), null, { timeout: 120000 });
      await page.waitForTimeout(400);
      await page.screenshot({ path: path.join(SHOTS, 'dev-lap2.png') });
    } catch (e) { fail('dev climb never reached lap 2: ' + await d.textContent('#dev-hud')); }
    // autocorrect: the bot's typos were corrected, and the debugger explains a correction
    await d.click('#dev-tab-debug');
    if (!/corrected \(/.test(await d.textContent('#dev-dbg-log'))) fail('the typo bot produced no corrected answers');
    await d.selectOption('#dev-dbg-cat', 'colors');
    await d.fill('#dev-dbg-in', 'fuschia');
    const dbg = await d.textContent('#dev-dbg-out');
    if (!/corrected to Fuchsia \(sound\)/.test(dbg)) fail('debugger did not explain the fuschia correction: ' + dbg.slice(0, 300));
    await page.screenshot({ path: path.join(SHOTS, 'dev-debugger.png') });
    // answer bank: the Answers tab lists every answer with its rank
    await d.click('#dev-tab-answers');
    await d.selectOption('#dev-ans-cat', 'islands');
    const want = await d.evaluate(() => DA_ENGINE.buildIndex(DA_CATS.find((c) => c.id === 'islands')).entries.length);
    const cap = await d.textContent('.dev-ans-table caption');
    if (!cap.includes(`${want.toLocaleString('en-US')} of ${want.toLocaleString('en-US')} answers`)) fail(`Answers tab count is off: "${cap}" (want ${want})`);
    // search "ice" (only Iceland, a Crawler), then Sherpa only: every visible row must be Sherpa
    await d.fill('#dev-ans-q', 'ice');
    if ((await d.$$eval('.dev-ans-table tbody tr', (r) => r.length)) < 1) fail('Answers search for "ice" found nothing');
    for (const i of [0, 1, 2, 3]) await d.click(`[data-act="ans-rank"][data-v="${i}"]`);
    const onlySherpa = async () => (await d.$$eval('.dev-ans-table tbody tr', (r) => r.map((x) => x.dataset.tier))).every((t) => t === '4');
    if (!(await onlySherpa())) fail('Answers rank filter let a non-Sherpa row through ("ice")');
    // and a search that does have Sherpa answers, so the filter is checked on real rows
    await d.fill('#dev-ans-q', 'island');
    const n = await d.$$eval('.dev-ans-table tbody tr', (r) => r.length);
    if (!n || !(await onlySherpa())) fail(`Answers rank filter: ${n} rows for "island", not all Sherpa`);
    await page.screenshot({ path: path.join(SHOTS, 'dev-answers.png') });
    await d.click('#dev-acts [data-act="end-climb"]');
    await d.waitForSelector('#results:not([hidden])', { timeout: 5000 });
    if (!/Dev climb/.test(await d.textContent('#sheet'))) fail('no dev results summary');
    const realAfter = await d.evaluate(() => localStorage.getItem('daily-ascent:v1'));
    if (realBefore !== realAfter) fail('dev mode changed the real save');
    if (!(await d.evaluate(() => !!localStorage.getItem('daily-ascent:dev:v1')))) fail('dev climb did not use the dev save');
    console.log('dev mode: unlocked, paused, lapped with typos corrected, debugger explained a correction, answer bank listed and filtered, and left the real save alone');
  }

  if (errors.length) fail('page errors:\n' + errors.join('\n'));
  await browser.close();
  console.log(process.exitCode ? 'SMOKE FAILED' : 'SMOKE PASSED');
})();
