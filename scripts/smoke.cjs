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
  await page.screenshot({ path: path.join(SHOTS, 'newlook-home.png') });
  // The scene is pixel art: drawn on a low-res art canvas (1 art pixel = 2 or 3 CSS px), then scaled up.
  const art = await f.evaluate(() => { const c = document.querySelector('#scene'); return { w: Number(c.dataset.artW), h: Number(c.dataset.artH), px: Number(c.dataset.artPx), vw: innerWidth }; });
  // the art canvas is the visible canvas, with one spare art pixel on each side for the sub-pixel shift
  if (![2, 3].includes(art.px) || Math.abs(art.w - (art.vw / art.px + 2)) > 1.5) fail(`art canvas ${art.w}×${art.h} at ${art.px} px doesn't match a ${art.vw} px viewport`);
  else console.log(`art canvas: ${art.w}×${art.h} art pixels at ${art.px} CSS px each`);
  // typed answers use the lighter weight (500); everything else keeps its font
  const answerWeight = await f.evaluate(() => getComputedStyle(document.querySelector('#answer')).fontWeight);
  if (answerWeight !== '500') fail(`answer box font weight is ${answerWeight}, want 500`);
  // Speed the climb up: short legs, fast transitions.
  await f.evaluate(() => { const C = DA_ENGINE.CONFIG; C.legs.forEach((l) => (l.secs = 6)); C.transitionMs = 700; C.countdownSecs = 1; C.ride.speed = 3; });
  const legs = await f.evaluate(() => {
    const E = DA_ENGINE;
    const cats = E.dailyCategories({ categories: DA_CATS.filter((c) => c.kind !== 'practice') }, E.puzzleNumber(E.localDateStr()));
    return cats.map((c) => { const ix = E.buildIndex(c); return { text: c.text, words: [0, 1, 2, 3, 4].map((t) => { const e = ix.entries.find((x) => x.tier === t); return e && { w: e.canon, t }; }).filter(Boolean) }; });
  });
  await f.click('#btn-begin');
  await page.waitForTimeout(1300);
  // phone keyboard: with the visual viewport 300 px shorter, the leg screen compacts and the climber is
  // framed above the keyboard (the test browser has no on-screen keyboard, so the viewport is simulated)
  const kb = await f.evaluate(async () => {
    const real = window.visualViewport, H = innerHeight;
    const stub = { width: innerWidth, height: H - 300, offsetTop: 0, offsetLeft: 0, scale: 1, addEventListener() {}, removeEventListener() {} };
    Object.defineProperty(window, 'visualViewport', { configurable: true, get: () => stub });
    window.dispatchEvent(new Event('resize'));
    await new Promise((r) => setTimeout(r, 250));
    const out = { y: Number(document.querySelector('#scene').dataset.climberY), open: document.documentElement.classList.contains('kb-open'), top: H - 300 };
    Object.defineProperty(window, 'visualViewport', { configurable: true, get: () => real });
    window.dispatchEvent(new Event('resize'));
    await new Promise((r) => setTimeout(r, 250));
    out.closed = !document.documentElement.classList.contains('kb-open');
    out.yAfter = Number(document.querySelector('#scene').dataset.climberY);
    return out;
  });
  if (!kb.open || !(kb.y > 0 && kb.y < kb.top - 10)) fail(`keyboard: climber framed at ${kb.y} px with the keyboard from ${kb.top} px (kb-open ${kb.open})`);
  else if (!kb.closed || kb.yAfter <= kb.y) fail('keyboard: the leg screen did not return when the keyboard closed');
  else console.log(`keyboard: climber framed at ${kb.y} px, above a keyboard from ${kb.top} px (${kb.yAfter} px without it)`);

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
        if (t === 4) {
          // the alpaca ride follows the Sherpa spotlight: clock held, card faded, focus and typed text kept
          try { await f.waitForSelector('#play.riding', { timeout: 1500 }); } catch (e) { fail(`leg ${i + 1}: no alpaca ride after the Sherpa spotlight`); continue; }
          const sa = await f.textContent('#secs');
          if (i === 0) { await page.keyboard.type('ab'); await page.waitForTimeout(250); await page.screenshot({ path: path.join(SHOTS, 'ride-daily.png') }); await page.screenshot({ path: path.join(SHOTS, 'newlook-ride.png') }); }
          await page.waitForTimeout(300);
          const sb = await f.textContent('#secs');
          if (await f.evaluate(() => document.querySelector('#play').classList.contains('riding')) && sa !== sb) fail(`leg ${i + 1}: the clock ran during the ride (${sa} → ${sb})`);
          await f.waitForFunction(() => !document.querySelector('#play').classList.contains('riding'), null, { timeout: 5000 });
          if (await f.evaluate(() => document.activeElement && document.activeElement.id) !== 'answer') fail(`leg ${i + 1}: the answer box lost focus after the ride`);
          if (i === 0) {
            const kept = await f.inputValue('#answer');
            if (kept !== 'ab') fail(`text typed during the ride was not kept ("${kept}")`);
            await f.fill('#answer', '');
          }
        }
      }
      await page.waitForTimeout(170);
    }
    await page.keyboard.type('zzqxv'); await page.keyboard.press('Enter'); await page.waitForTimeout(170);
    const chips = await f.locator('.chip:not(.rejected)').count();
    if (chips !== legs[i].words.length) fail(`leg ${i + 1}: ${chips} chips for ${legs[i].words.length} valid answers`);
    if (i === 0) { await page.screenshot({ path: path.join(SHOTS, 'leg1.png') }); await page.screenshot({ path: path.join(SHOTS, 'newlook-leg1.png') }); }
    if (i === 5) {
      // legs 6–7 are the summit push: night panels
      if (!(await f.evaluate(() => document.querySelector('#app').classList.contains('night')))) fail('leg 6 is not on night panels');
      await page.screenshot({ path: path.join(SHOTS, 'newlook-leg6.png') });
    }
    await f.waitForFunction(() => !document.querySelector('#transition').hidden || !document.querySelector('#results').hidden, null, { timeout: 20000 });
    if (i < 6) await f.waitForFunction(() => document.querySelector('#transition').hidden, null, { timeout: 20000 });
  }
  await f.waitForSelector('#results:not([hidden])', { timeout: 20000 });
  await page.waitForTimeout(1500);
  await page.screenshot({ path: path.join(SHOTS, 'results.png') });
  await page.screenshot({ path: path.join(SHOTS, 'newlook-results.png') });
  const share = await f.textContent('#share-box');
  if (!/^Daily Ascent #\d+/.test(share)) fail('share text missing: ' + share);
  if (!/🦙/.test(share)) fail('share text has no 🦙 for the Sherpa rides');
  const leaked = legs.flatMap((l) => l.words.map((x) => x.w)).filter((w) => share.toLowerCase().includes(w.toLowerCase()));
  if (leaked.length) fail('share text contains answers: ' + leaked.join(', '));
  if (!/Alpaca rides/.test(await f.textContent('#sheet'))) fail('results do not show alpaca rides');
  console.log(share);

  await page.reload(); await page.waitForTimeout(1200);
  const label = await page.frames()[1].textContent('#btn-begin');
  if (label !== 'View Results') fail('after reload the button says "' + label + '"');

  // ---- reduced motion: a Sherpa answer gets the words, not the ride
  {
    const setReduced = async (v) => {
      await page.frames()[1].evaluate((on) => { const k = 'daily-ascent:v1'; const d = JSON.parse(localStorage.getItem(k)); d.settings.reduced = on; localStorage.setItem(k, JSON.stringify(d)); }, v);
      await page.reload(); await page.waitForTimeout(1000);
    };
    await setReduced(true);
    const r = page.frames()[1];
    const sherpa = await r.evaluate(() => DA_ENGINE.buildIndex(DA_CATS.find((c) => c.kind === 'practice')).entries.find((e) => e.tier === 4).canon);
    await r.evaluate(() => { DA_ENGINE.CONFIG.countdownSecs = 1; });
    await r.click('#btn-practice');
    await r.waitForFunction(() => document.querySelector('#category').textContent && !/Get ready/.test(document.querySelector('#category').textContent), null, { timeout: 6000 });
    await page.waitForTimeout(1300);
    await r.click('#answer'); await page.keyboard.type(sherpa); await page.keyboard.press('Enter');
    let rode = false;
    for (let k = 0; k < 12; k++) { await page.waitForTimeout(200); if (await r.evaluate(() => document.querySelector('#play').classList.contains('riding'))) rode = true; }
    if (rode) fail('reduced motion: the alpaca ride played');
    const fb = await r.textContent('#feedback');
    if (!/Carried up by alpacas/.test(fb)) fail('reduced motion: no "Carried up by alpacas" line (' + fb + ')');
    await setReduced(false);
  }

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
    // set the password without passing it through a call that could echo it in an error message
    await d.evaluate((pw) => { const i = document.querySelector('#dev-lock-pw'); i.value = pw; i.dispatchEvent(new Event('input', { bubbles: true })); }, DEV_PASSWORD).catch(() => fail('could not enter the dev password'));
    await d.press('#dev-lock-pw', 'Enter');
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
    // the section slider steps through the tabs (the tab row runs off the edge on a phone)
    await d.evaluate(() => { const r = document.querySelector('#dev-section'); r.value = '3'; r.dispatchEvent(new Event('input', { bubbles: true })); r.dispatchEvent(new Event('change', { bubbles: true })); });
    try { await d.waitForSelector('#dev-body #dev-ans-table', { timeout: 3000 }); } catch (e) { fail('section slider did not open the Answers section'); }
    if (await d.getAttribute('#dev-tab-answers', 'aria-selected') !== 'true') fail('section slider: Answers tab not selected');
    await d.click('[data-act="sec-next"]');
    if (await d.getAttribute('#dev-tab-effects', 'aria-selected') !== 'true') fail('section › button did not move to Effects');
    if (await d.$eval('#dev-section', (r) => r.value) !== '4') fail('section slider did not follow the › button');
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
    // alpaca ride effect trigger: once per band, with the rare variants spread across the runs.
    // The bot stops first, and Alt+H hides the UI so the screenshot shows the herd.
    await d.click('#dev-tab-content');
    if (await d.evaluate(() => /Stop/i.test((document.querySelector('[data-act="bot"]') || {}).textContent || ''))) await d.click('[data-act="bot"]');
    await d.click('#dev-tab-effects');
    const runs = [['grass', ['golden']], ['trail', ['late']], ['glacier', ['spit']], ['deathzone', ['golden', 'late']]];
    for (const [band, extras] of runs) {
      await d.selectOption('#dev-ride-band', band);
      for (const v of ['golden', 'late', 'spit']) await d.setChecked('#dev-ride-' + v, extras.includes(v));
      for (const v of ['golden', 'late', 'spit']) await d.dispatchEvent('#dev-ride-' + v, 'change');
      await d.click('[data-act="ride-fx"]');
      await page.keyboard.press('Alt+KeyH');
      const fps = await d.evaluate(() => new Promise((res) => { let n = 0; const t0 = performance.now(); const tick = () => { n++; if (performance.now() - t0 < 1400) requestAnimationFrame(tick); else res(Math.round(n / ((performance.now() - t0) / 1000))); }; requestAnimationFrame(tick); }));
      await page.screenshot({ path: path.join(SHOTS, `alpaca-${band}.png`) });
      console.log(`alpaca ride ${band} (${extras.join('+')}): ${fps} fps`);
      if (fps < 30) fail(`the ${band} alpaca ride ran at ${fps} fps (needs 30 or more)`);
      await page.keyboard.press('Alt+KeyH');
      await page.waitForTimeout(3200);
    }
    // Draft cosmetics (dev preview only): the climber in the bobble hat, summit shades and prayer-flag scarf.
    await d.selectOption('#dev-outfit-hat', 'bobble_hat');
    await d.selectOption('#dev-outfit-eyes', 'summit_shades');
    await d.selectOption('#dev-outfit-neck', 'flag_scarf');
    await page.keyboard.press('Alt+KeyH'); await page.waitForTimeout(500);
    await page.screenshot({ path: path.join(SHOTS, 'newlook-outfit.png') });
    await page.keyboard.press('Alt+KeyH');
    await d.click('[data-act="outfit-reset"]');
    if (realBefore !== await d.evaluate(() => localStorage.getItem('daily-ascent:v1'))) fail('the outfit preview touched the real save');
    if (/bobble|shades|scarf/.test(await d.evaluate(() => localStorage.getItem('daily-ascent:dev:v1') || ''))) fail('the outfit preview was saved to the dev save');
    await d.click('#dev-tab-debug');
    if (!/alpaca ride \(effect test\)/.test(await d.textContent('#dev-dbg-log'))) fail('the dev log has no alpaca ride line');
    if (!/outfit: yak-wool bobble hat \+ summit shades \+ prayer-flag scarf/.test(await d.textContent('#dev-dbg-log'))) fail('the dev log has no outfit line');
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
