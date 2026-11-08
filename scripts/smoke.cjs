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

  const browser = await chromium.launch();
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
    return cats.map((c) => { const ix = E.buildIndex(c); return { text: c.text, words: [0, 1, 2, 3].map((t) => (ix.entries.find((e) => e.tier === t) || {}).canon).filter(Boolean) }; });
  });
  await f.click('#btn-begin');
  await page.waitForTimeout(1300);

  for (let i = 0; i < 7; i++) {
    const shown = await f.textContent('#category');
    if (shown !== legs[i].text) fail(`leg ${i + 1} shows "${shown}", expected "${legs[i].text}"`);
    await f.click('#answer');
    for (const w of legs[i].words) { await page.keyboard.type(w); await page.keyboard.press('Enter'); await page.waitForTimeout(170); }
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

  if (errors.length) fail('page errors:\n' + errors.join('\n'));
  await browser.close();
  console.log(process.exitCode ? 'SMOKE FAILED' : 'SMOKE PASSED');
})();
