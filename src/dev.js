/* Daily Ascent — dev mode: unlock, dev tools panel, HUD.
   Locked behind a password (PBKDF2 hash in src/dev-lock.js). Until it is
   unlocked this file only listens for the two entry points; app.js hands over
   its hooks only after a correct password. Nothing here runs for players. */
(function () {
  'use strict';
  const LOCK = window.DA_DEV_LOCK;
  const CORE = window.DA_DEV_CORE;
  const UNLOCK_KEY = 'daily-ascent:dev-unlocked';   // sessionStorage only: clears with the tab

  let grant = null;   // app.js: () => hooks. Called once, after the password checks out.
  let H = null;       // the hooks
  let unlocked = false;

  const $ = (s, el) => (el || document).querySelector(s);
  const $$ = (s, el) => [...(el || document).querySelectorAll(s)];
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmt = (n) => Math.round(n).toLocaleString('en-US');
  const pad = (n, w) => String(n).padStart(w || 2, '0');
  const clockStr = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;

  window.DA_DEV = {
    init(g) { if (grant) return; grant = g; boot(); },
    open() { openLock(); },
  };

  // ===========================================================================
  // Entry points and unlock
  // ===========================================================================
  function boot() {
    let taps = [];
    const mark = $('.brand .wordmark');
    if (mark) {
      mark.addEventListener('pointerup', () => {
        const t = Date.now();
        taps = taps.filter((x) => t - x < 3000).concat(t);
        if (taps.length >= 5) { taps = []; openLock(); }
      });
    }
    let remembered = false;
    try { remembered = sessionStorage.getItem(UNLOCK_KEY) === '1'; } catch (e) { remembered = false; }
    if (remembered) activate();
    let wantDev = false;
    try { wantDev = new URLSearchParams(location.search).has('dev'); } catch (e) { wantDev = false; }
    if (wantDev) openLock();
    const pw = $('#dev-lock-pw');
    pw.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.keyCode !== 13) return;
      if (e.isComposing || e.keyCode === 229) return;
      e.preventDefault();
      tryUnlock();
    });
    $('#dev-lock-go').addEventListener('click', tryUnlock);
  }

  function openLock() {
    if (unlocked) { togglePanel(true); return; }
    const d = $('#dlg-dev-lock');
    $('#dev-lock-err').textContent = '';
    if (!d.open) { try { d.showModal(); } catch (e) { d.setAttribute('open', ''); } }
    setTimeout(() => $('#dev-lock-pw').focus(), 30);
  }

  let busy = false;
  async function tryUnlock() {
    if (busy) return;
    const input = $('#dev-lock-pw'), err = $('#dev-lock-err'), btn = $('#dev-lock-go');
    const pw = input.value;
    if (!pw) { err.textContent = 'Enter the password.'; return; }
    busy = true; btn.disabled = true; err.textContent = 'Checking…';
    let ok = false;
    try {
      ok = await CORE.verifyPassword(pw, LOCK, window.crypto && window.crypto.subtle);
    } catch (e) {
      err.textContent = 'Dev mode needs a secure (https) page.';
      busy = false; btn.disabled = false;
      return;
    }
    if (!ok) {
      await sleep(1000);   // slows guessing
      err.textContent = 'That password isn’t right.';
      input.select();
      busy = false; btn.disabled = false;
      return;
    }
    input.value = '';
    err.textContent = '';
    busy = false; btn.disabled = false;
    try { sessionStorage.setItem(UNLOCK_KEY, '1'); } catch (e) { /* this tab only, then */ }
    const d = $('#dlg-dev-lock');
    try { d.close(); } catch (e) { d.removeAttribute('open'); }
    activate();
    togglePanel(true);
    H.announce('Dev mode unlocked.');
  }

  // ===========================================================================
  // Activation: badge, home button, panel, HUD, shortcuts
  // ===========================================================================
  function activate() {
    if (unlocked || !grant) return;
    H = grant();
    unlocked = true;
    H.listen(onEvent);
    if (H.store !== H.DevStore) H.DevStore.load();   // so dev-save tools edit what's stored
    const badge = $('#dev-badge');
    badge.hidden = false;
    badge.addEventListener('click', () => togglePanel());
    const homeBtn = $('#btn-dev');
    homeBtn.hidden = false;
    homeBtn.addEventListener('click', () => { H.startDev(); renderActs(); });
    buildPanel();
    document.addEventListener('keydown', onShortcut, true);
    $('#scene').addEventListener('pointerdown', () => { if (document.body.classList.contains('dev-ui-hidden')) hideUI(false); });
    setInterval(live, 200);
    live();
  }

  function togglePanel(force) {
    const p = $('#dev-panel');
    const open = force == null ? p.hidden : !!force;
    p.hidden = !open;
    $('#dev-badge').setAttribute('aria-expanded', String(open));
    $('#dev-badge').setAttribute('aria-label', open ? 'Close dev tools' : 'Open dev tools');
    document.body.classList.toggle('dev-open', open);
    window.dispatchEvent(new Event('resize'));   // re-frame the mountain around the drawer
    if (open) renderTab();
  }

  function onShortcut(e) {
    if (!e.altKey || e.ctrlKey || e.metaKey) return;
    const k = e.code;
    if (k === 'KeyD') { e.preventDefault(); togglePanel(); }
    else if (k === 'KeyP') { e.preventDefault(); doPause(); }
    else if (k === 'KeyH') { e.preventDefault(); hideUI(!document.body.classList.contains('dev-ui-hidden')); }
    else if (k === 'BracketLeft' || k === 'BracketRight') {
      e.preventDefault();
      if ($('#dev-panel').hidden) togglePanel(true);
      goSection(tabIndex() + (k === 'BracketLeft' ? -1 : 1));
    }
  }

  // Panel buttons must not steal focus from the answer box during a climb
  // (the #btn-send trick); mouse clicks hand focus back to it afterwards.
  function refocusGame(e) {
    if (!H || (e && e.detail === 0)) return;   // keyboard activation keeps focus in the panel
    if (H.G.screen === 'play' && ['leg', 'countdown', 'settle', 'transition'].includes(H.G.state)) {
      setTimeout(() => H.ui.input.focus({ preventScroll: true }), 0);
    }
  }

  // ===========================================================================
  // Panel
  // ===========================================================================
  const TABS = [
    ['time', 'Time'], ['move', 'Move'], ['content', 'Content'], ['answers', 'Answers'], ['effects', 'Effects'],
    ['debug', 'Debugger'], ['checker', 'Checker'], ['save', 'Save & dates'], ['perf', 'Perf'],
  ];
  let tab = 'time';
  let secByPointer = false;
  const tabIndex = () => Math.max(0, TABS.findIndex(([id]) => id === tab));
  const sectionLabel = (i = tabIndex()) => `Section ${i + 1} of ${TABS.length} · ${TABS[i][1]}`;
  // moves to section i (slider, ‹ ›, Alt+[ / Alt+]) and says where it landed
  function goSection(i, quiet) {
    const n = Math.max(0, Math.min(TABS.length - 1, i));
    if (TABS[n][0] === tab) { if (!quiet) notice(sectionLabel(n)); return; }
    tab = TABS[n][0];
    renderTab();
    if (!quiet) notice(sectionLabel(n));
  }
  // a soft fade on whichever edge of the tab row has more tabs past it
  function tabFades() {
    const row = $('#dev-tabs'), wrap = $('#dev-tabs-wrap');
    if (!row || !wrap) return;
    wrap.classList.toggle('more-left', row.scrollLeft > 2);
    wrap.classList.toggle('more-right', row.scrollLeft + row.clientWidth < row.scrollWidth - 2);
  }
  // keeps the slider, its label and the tab row in step with the selected tab
  function syncSection() {
    const i = tabIndex(), r = $('#dev-section'), out = $('#dev-section-out');
    if (r) { if (Number(r.value) !== i) r.value = String(i); r.setAttribute('aria-valuetext', sectionLabel(i)); }
    if (out) out.textContent = sectionLabel(i);
    const b = $('#dev-tab-' + tab);
    if (b && !$('#dev-panel').hidden) { try { b.scrollIntoView({ inline: 'nearest', block: 'nearest' }); } catch (e) { /* old browsers */ } }
    tabFades();
  }

  function buildPanel() {
    const p = $('#dev-panel');
    p.innerHTML = `
      <div class="dev-head"><h2>Dev tools</h2><p class="dev-status" id="dev-status" role="status"></p>
        <button class="dlg-close" data-act="close-panel" aria-label="Close dev tools">✕</button></div>
      <div class="dev-acts" id="dev-acts"></div>
      <div class="dev-tabs-wrap" id="dev-tabs-wrap"><div class="dev-tabs" id="dev-tabs" role="tablist" aria-label="Dev tool groups">${TABS.map(([id, label]) =>
        `<button role="tab" id="dev-tab-${id}" aria-controls="dev-body" aria-selected="${id === tab}" data-tab="${id}">${label}</button>`).join('')}</div></div>
      <div class="dev-section" role="group" aria-label="Move through the dev tool sections">
        <output class="dev-section-out" id="dev-section-out" for="dev-section">${sectionLabel()}</output>
        <button class="dev-btn dev-section-step" data-act="sec-prev" aria-label="Previous section" title="Previous section (Alt+[)">‹</button>
        <input type="range" class="dev-range" id="dev-section" min="0" max="${TABS.length - 1}" step="1" value="${tabIndex()}" aria-label="Dev tools section" aria-valuetext="${sectionLabel()}">
        <button class="dev-btn dev-section-step" data-act="sec-next" aria-label="Next section" title="Next section (Alt+])">›</button>
      </div>
      <div class="dev-body" id="dev-body" role="tabpanel"></div>`;
    // the slider hands focus back to the answer box when a pointer lets go of it (not after arrow keys)
    const sec = $('#dev-section');
    sec.addEventListener('pointerdown', () => { secByPointer = true; });
    $('#dev-tabs').addEventListener('scroll', tabFades, { passive: true });
    p.addEventListener('pointerdown', (e) => { if (e.target.closest('button')) e.preventDefault(); });
    p.addEventListener('mousedown', (e) => { if (e.target.closest('button')) e.preventDefault(); });
    p.addEventListener('click', (e) => {
      const t = e.target.closest('[data-tab]');
      if (t) { tab = t.dataset.tab; renderTab(); return; }
      const b = e.target.closest('[data-act]');
      if (!b || b.disabled) return;
      act(b.dataset.act, b);
      refocusGame(e);
    });
    p.addEventListener('change', onChange);
    p.addEventListener('input', onInput);
    renderActs();
  }

  function renderActs() {
    const el = $('#dev-acts');
    if (!el || !H) return;
    const running = H.devActive();
    const inDev = H.G.mode === 'dev';
    const paused = !!(H.G.dev && H.G.dev.paused);
    el.innerHTML = `
      ${running ? '<button class="dev-btn danger" data-act="end-climb">End climb</button>' : `<button class="dev-btn primary" data-act="start-climb" ${['idle', 'results'].includes(H.G.state) ? '' : 'disabled'}>Start dev climb</button>`}
      <button class="dev-btn ${paused ? 'on' : ''}" data-act="pause" aria-pressed="${paused}" ${running ? '' : 'disabled'}>${paused ? 'Resume' : 'Pause'} <small>Alt+P</small></button>
      ${inDev && !running ? '<button class="dev-btn" data-act="exit-dev">Back to base</button>' : ''}
      <button class="dev-btn" data-act="lock">Lock dev mode</button>`;
  }

  function renderTab() {
    const body = $('#dev-body');
    if (!body || !H) return;
    $$('#dev-panel [data-tab]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === tab)));
    body.setAttribute('aria-labelledby', 'dev-tab-' + tab);
    body.innerHTML = ({ time: tabTime, move: tabMove, content: tabContent, answers: tabAnswers, effects: tabEffects, debug: tabDebug, checker: tabChecker, save: tabSave, perf: tabPerf })[tab]();
    afterRender[tab] && afterRender[tab]();
    syncSection();
  }
  const afterRender = {};

  let statusT = 0;
  function notice(msg) {
    const s = $('#dev-status');
    if (s) { s.textContent = msg; s.title = msg; }
    statusT = Date.now() + 6000;
    if (H) H.announce(msg);
  }
  const needClimb = () => { notice('Start a dev climb first.'); return false; };
  const needLeg = () => { notice('This works during a dev climb leg.'); return false; };

  // ---------------------------------------------------------------- actions
  function act(a, b) {
    const d = b.dataset;
    switch (a) {
      case 'close-panel': togglePanel(false); break;
      case 'sec-prev': goSection(tabIndex() - 1); break;
      case 'sec-next': goSection(tabIndex() + 1); break;
      case 'start-climb': H.startDev(); renderActs(); break;
      case 'end-climb': stopBot(); H.finishDev(); renderActs(); break;
      case 'exit-dev': H.exitDev(); renderActs(); break;
      case 'lock': lock(); break;
      case 'pause': doPause(); break;
      // time
      case 'freeze': H.setFreeze(!(H.G.dev && H.G.dev.freeze)); notice(H.G.dev.freeze ? 'Timer frozen (stays frozen across legs).' : 'Timer running.'); renderTab(); break;
      case 'infinite': if (!H.setInfinite(!(H.G.dev && H.G.dev.infinite))) needLeg(); else notice(H.G.dev.infinite ? 'Infinite time for this leg.' : 'Infinite time off.'); renderTab(); break;
      case 'speed': H.setSpeed(Number(d.v)); notice(`Game speed ${d.v}×.`); renderTab(); break;
      case 'end-leg': if (!H.endLegNow(false)) needLeg(); break;
      case 'add-time': if (!H.addTime(Number(d.v))) needLeg(); else notice(`${Number(d.v) > 0 ? '+' : '−'}${Math.abs(Number(d.v)) / 1000} s`); break;
      // move
      case 'jump-leg': {
        const pos = Number(d.v);
        const live = H.devLegLive();
        H.jumpLeg(pos);
        notice(live ? `Jumped to pattern leg ${pos + 1}.` : `The next leg will be pattern leg ${pos + 1}.`);
        break;
      }
      case 'goto-alt': {
        const v = Number($('#dev-alt').value);
        if (!H.setAltitude(v)) needClimb(); else notice(`Moved to ${fmt(v)} m.`);
        break;
      }
      case 'milestone': {
        const m = H.C.milestones.find((x) => x.id === d.v);
        const alt = m.alt >= H.C.summitAlt ? H.C.summitAlt - 0.5 : m.alt;
        if (!H.setAltitude(alt)) needClimb(); else notice(`Teleported to ${m.name}.`);
        break;
      }
      case 'sky-follow': H.Scene.setSkyOverride(null); notice('Sky follows the climber again.'); renderTab(); break;
      case 'night': H.setNight(d.v === 'auto' ? null : d.v === 'on'); notice(`Night panels: ${d.v}.`); renderTab(); break;
      case 'set-lap': { const n = Number($('#dev-lap-n').value); if (!H.setLap(n)) needClimb(); else notice(`Now on lap ${Math.max(1, Math.round(n))}.`); break; }
      // content
      case 'next-cat': {
        const id = $('#dev-cat-list').value;
        if (!id) { notice('Pick a category from the list.'); break; }
        H.setNextCat(id);
        notice(`Next leg: ${H.ALL.find((c) => c.id === id).text}.`);
        renderTab();
        break;
      }
      case 'clear-next-cat': H.setNextCat(null); notice('Next leg uses the normal pool.'); renderTab(); break;
      case 'bot': bot.on ? stopBot() : startBot(); renderTab(); break;
      // answers
      case 'ans-rank': { const i = Number(d.v); ans.ranks[i] = !ans.ranks[i]; b.setAttribute('aria-pressed', String(ans.ranks[i])); ans.shown = ANS_CHUNK; renderAnswers(true); break; }
      case 'ans-more': ans.shown += ANS_CHUNK; renderAnswers(false); break;
      case 'ans-csv': copyAnswersCsv(); break;
      // effects
      case 'rank-fx': H.fireRank(Number(d.v)); break;
      case 'sound': H.playSound(d.v); break;
      case 'flag': H.plantFlag(); notice('Flag planted (visual only; your next answer moves the climber back).'); break;
      case 'confetti': H.confetti(); break;
      case 'ride-fx': notice(H.playRide(Object.assign({}, rideFx))); break;
      case 'shake': H.rejectFx(); break;
      case 'outfit-reset': for (const [k] of OUTFIT_SLOTS) outfit[k] = ''; applyOutfit(true); renderTab(); notice('Outfit back to the default climber.'); break;
      // debugger
      case 'log-copy': copyText(LOG.map(logLine).join('\n'), 'Debugger log copied.'); break;
      case 'log-clear': LOG.length = 0; renderLog(); break;
      // checker
      case 'mock': mock.on ? mockOff() : mockOn(); renderTab(); break;
      case 'mock-queue': mock.queue.push({ kind: d.v, comm: Number($('#dev-mock-comm').value) }); renderTab(); break;
      case 'mock-queue-clear': mock.queue.length = 0; renderTab(); break;
      // save and dates
      case 'save-refresh': renderTab(); break;
      case 'save-copy': copyText($('#dev-real-json').textContent, 'Real save copied.'); break;
      case 'reset-real': openResetReal(); break;
      case 'reset-dev': notice(H.resetDevSave()); renderTab(); break;
      case 'fake-streak': applyFakeStreak(); break;
      case 'fake-rounds': genRounds(Number($('#dev-fake-n').value)); break;
      case 'clear-rounds': H.DevStore.data.rounds = {}; H.DevStore.save(); notice('Cleared the dev save’s rounds.'); renderTab(); break;
      case 'stats-dev': H.openStatsWith(H.DevStore); break;
      case 'record-day': { const s = H.recordClimbToday(H.DevStore); notice(`Dev streak after a climb on ${H.E.localDateStr()}: ${s.current} (best ${s.best}, rest days ${s.tokens}).`); renderTab(); break; }
      case 'reload': { const msg = H.simulateReload(d.v); notice(msg); renderActs(); break; }
      case 'clock-set': { const v = $('#dev-clock-in').value; if (!v) { notice('Pick a date and time first.'); break; } setFake(new Date(v).getTime()); break; }
      case 'clock-add': setFake(H.E.nowDate().getTime() + Number(d.v)); break;
      case 'clock-midnight': { const n = H.E.nowDate(); setFake(new Date(n.getFullYear(), n.getMonth(), n.getDate(), 23, 59, 50).getTime()); break; }
      case 'clock-clear': H.E.setClockOffset(0); notice('Fake clock off.'); clockChanged(); break;
      // perf
      case 'fps': fpsToggle(); renderTab(); break;
      case 'hide-ui': hideUI(true); break;
      case 'shot': screenshot(); break;
      default: break;
    }
  }

  function onChange(e) {
    const t = e.target;
    if (t.id === 'dev-section') {
      goSection(Number(t.value));
      if (secByPointer) { secByPointer = false; refocusGame({ detail: 1 }); }
      return;
    }
    if (t.id === 'dev-alt') act('goto-alt', t);
    else if (t.id === 'dev-bot-rank') { bot.rank = t.value; }
    else if (t.id === 'dev-bot-wrong') { bot.wrongEvery = Math.max(0, Math.round(Number(t.value) || 0)); }
    else if (t.id === 'dev-bot-typo') { bot.typoEvery = Math.max(0, Math.round(Number(t.value) || 0)); }
    else if (t.id === 'dev-mock-state') { mock.state = t.value; if (mock.on) applyMockState(); renderTab(); }
    else if (t.id === 'dev-mock-default') { mock.dflt = t.value; }
    else if (t.id === 'dev-mock-comm') { mock.comm = Number(t.value); }
    else if (t.id === 'dev-dbg-cat') { dbgCat = t.value; analyseNow(); }
    else if (t.id === 'dev-ride-style') rideFx.style = t.value;
    else if (t.id === 'dev-ride-band') rideFx.band = t.value;
    else if (t.id === 'dev-ride-m') rideFx.meters = Math.max(0, Math.min(1500, Math.round(Number(t.value) || 0)));
    else if (/^dev-ride-(golden|late|spit|reduced)$/.test(t.id)) rideFx[t.id.slice(9)] = t.checked;
    else if (/^dev-outfit-(hat|eyes|neck|over|suit)$/.test(t.id)) { outfit[t.id.slice(11)] = t.value; applyOutfit(true); }
    else if (t.id === 'dev-ans-cat') { ans.cat = t.value; ans.picked = true; ans.pos = null; ans.shown = ANS_CHUNK; renderAnswersControls(); renderAnswers(true); }
    else if (t.id === 'dev-ans-pos') { ans.pos = t.value === '' ? null : Number(t.value); renderAnswers(false); }
    else if (t.id === 'dev-ans-sort') { ans.sort = t.value; ans.shown = ANS_CHUNK; renderAnswers(false); }
    else if (t.id === 'dev-prev-date') { const n = H.E.puzzleNumber(t.value); $('#dev-prev-num').value = n; renderPreview(n); }
    else if (t.id === 'dev-prev-num') { renderPreview(Math.max(1, Math.round(Number(t.value) || 1))); }
  }
  function onInput(e) {
    const t = e.target;
    if (t.id === 'dev-section') { goSection(Number(t.value), true); return; }   // announced on release
    if (t.id === 'dev-sky') { H.Scene.setSkyOverride(Number(t.value)); $('#dev-sky-out').textContent = skyName(Number(t.value)); }
    else if (t.id === 'dev-alt') { $('#dev-alt-out').textContent = fmt(Number(t.value)) + ' m'; }
    else if (t.id === 'dev-bot-rate') { bot.rate = Number(t.value); $('#dev-bot-rate-out').textContent = bot.rate + '/s'; if (bot.on) startBot(); }
    else if (t.id === 'dev-mock-delay') { mock.delay = Number(t.value); $('#dev-mock-delay-out').textContent = (mock.delay / 1000).toFixed(1) + ' s'; }
    else if (t.id === 'dev-cat-search') { filterCats(t.value); }
    else if (t.id === 'dev-dbg-in') { dbgText = t.value; dbgSource = 'test box'; analyseNow(); }
    else if (t.id === 'dev-ans-q') { ans.q = t.value; ans.shown = ANS_CHUNK; renderAnswers(true); }
  }

  function doPause() {
    if (!H.devActive()) { needClimb(); return; }
    H.pause();
  }

  function lock() {
    stopBot();
    if (mock.on) mockOff();
    if (H.E.clockOffset()) H.E.setClockOffset(0);
    if (H.devActive()) H.finishDev();
    if (H.G.mode === 'dev') H.exitDev();
    H.Scene.setSkyOverride(null);
    H.setOutfit(null);
    fpsToggle(false);
    hideUI(false);
    try { sessionStorage.removeItem(UNLOCK_KEY); } catch (e) { /* ignore */ }
    H.announce('Dev mode locked. Reloading.');
    setTimeout(() => location.reload(), 150);
  }

  // ---------------------------------------------------------------- events from the game
  function onEvent(type, data) {
    switch (type) {
      case 'ride': logRide(data); break;
      case 'answer': logAnswer(data); if (tab === 'content') renderCheat(); if (tab === 'answers') renderAnswers(false); if (tab === 'checker' && data.kind === 'judged') renderMockLog(); break;
      case 'leg-start': if (tab === 'content') renderCheat(); if (tab === 'answers') { if (!ans.picked) { ans.cat = null; renderTab(); } else renderAnswers(false); } if (tab === 'debug') analyseNow(); if (tab === 'time') renderTab(); break;
      case 'lap': showLap(data); break;
      case 'pause': renderActs(); if (tab === 'time') renderTab(); break;
      case 'dev-start': case 'dev-end': case 'dev-exit': if (type !== 'dev-start') stopBot(); renderActs(); if (!$('#dev-panel').hidden) renderTab(); break;
      case 'daily-start':
        stopBot();
        if (mock.on) { mockOff(); notice('The real daily climb started, so the checker mock is off.'); }
        break;
      case 'notice': notice(data); break;
      default: break;
    }
  }

  // ---------------------------------------------------------------- live updates (5×/s)
  let lastActsKey = '';
  const STATE_LABEL = { countdown: 'counting down', leg: 'timer running', settle: 'waiting for checks', transition: 'between legs', idle: 'reloading', results: 'ended' };
  function live() {
    if (!H) return;
    const G = H.G, d = G.dev;
    // badge
    const off = H.E.clockOffset();
    const badge = $('#dev-badge');
    const extra = [];
    if (d && d.paused && G.mode === 'dev') extra.push('paused');
    if (off) extra.push('fake clock ' + H.E.nowDate().toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }));
    const label = 'Dev' + (extra.length ? `<small>${esc(extra.join(' · '))}</small>` : '');
    if (badge.innerHTML !== label) badge.innerHTML = label;
    // status
    if (Date.now() > statusT) {
      const s = $('#dev-status');
      if (s) {
        const txt = G.mode === 'dev'
          ? (H.devActive() ? `Dev climb · leg ${G.legIdx + 1} · ${STATE_LABEL[G.state] || G.state}${d && d.paused ? ' · paused' : ''}${d && d.speed !== 1 ? ` · ${d.speed}×` : ''}` : 'Dev climb ended')
          : `Real game · ${G.screen}${G.mode === 'practice' ? ' (practice)' : ''}`;
        if (s.textContent !== txt) s.textContent = txt;
      }
    }
    const key = [G.mode, G.state, H.devActive(), d && d.paused].join('|');
    if (key !== lastActsKey) { lastActsKey = key; renderActs(); }
    // HUD and pause overlay
    const hud = $('#dev-hud');
    const showHud = G.mode === 'dev' && G.screen === 'play' && !!G.round;
    hud.hidden = !showHud;
    if (showHud) {
      const st = H.devLap();
      const leg = H.curLeg();
      const raw = leg ? leg.raw : 0, eff = H.E.legEffective(raw);
      const html = `<span><b>Lap ${st.lap}</b></span><span>${fmt(st.total)} m climbed</span><span>Leg ${G.legIdx + 1} (pattern ${H.legPos(G.legIdx) + 1})</span>`
        + `<span>raw ${fmt(raw)} · eff ${fmt(eff)}</span><span>chain ${leg ? leg.chain : 0}</span><span>${fmt(Math.max(0, H.C.legCap - eff))} m to cap</span>`
        + (d && d.speed !== 1 ? `<span><b>${d.speed}×</b></span>` : '') + (d && (d.freeze || d.infinite) ? `<span><b>${d.infinite ? '∞ time' : 'frozen'}</b></span>` : '');
      if (hud.innerHTML !== html) hud.innerHTML = html;
    }
    $('#dev-pause').hidden = !(G.mode === 'dev' && d && d.paused && G.screen === 'play');
    // per-tab live bits
    if (!$('#dev-panel').hidden) {
      if (tab === 'save') { const n = $('#dev-clock-now'); if (n) n.textContent = clockLabel(); }
      if (tab === 'checker') { const c = $('#dev-mock-cool'); if (c) c.textContent = coolLabel(); }
      if (tab === 'move') { const a = $('#dev-move-now'); if (a) a.textContent = moveLabel(); }
    }
  }

  // ===========================================================================
  // Tabs
  // ===========================================================================
  const btn = (act, label, extra) => `<button class="dev-btn ${extra && extra.cls ? extra.cls : ''}" data-act="${act}"${extra && extra.v != null ? ` data-v="${esc(extra.v)}"` : ''}${extra && extra.pressed != null ? ` aria-pressed="${extra.pressed}"` : ''}>${label}</button>`;

  // ---------------------------------------------------------------- time
  function tabTime() {
    const d = H.G.dev || {};
    const speeds = [0.5, 1, 2, 4];
    return `<div class="dev-sec">
      <p class="dev-note">These work during a dev climb. Pause holds the leg clock and keeps whatever you've typed. Speed, freeze and infinite time all move the leg's deadline, so timers stay wall-clock based.</p>
      <div class="dev-row">${btn('pause', d.paused ? 'Resume' : 'Pause', { cls: d.paused ? 'on' : '', pressed: !!d.paused })}
        ${btn('freeze', 'Freeze timer', { pressed: !!d.freeze })}${btn('infinite', 'Infinite time this leg', { pressed: !!d.infinite })}</div>
      <h3>Game speed</h3>
      <div class="dev-row" role="group" aria-label="Game speed">${speeds.map((s) => btn('speed', s + '×', { v: s, pressed: (d.speed || 1) === s })).join('')}</div>
      <h3>This leg</h3>
      <div class="dev-row">${btn('add-time', '−5 s', { v: -5000 })}${btn('add-time', '+5 s', { v: 5000 })}${btn('end-leg', 'End leg now')}</div>
    </div>`;
  }

  // ---------------------------------------------------------------- move
  const SKY_NAMES = [[3900, 'Dawn'], [6300, 'Midday'], [7300, 'Golden hour'], [8000, 'Dusk'], [8500, 'Night'], [99999, 'Stars']];
  const skyName = (a) => `${fmt(a)} m · ${SKY_NAMES.find(([x]) => a < x)[1]}`;
  function moveLabel() {
    if (!H.devActive()) return 'No dev climb running.';
    const st = H.devLap();
    return `Lap ${st.lap}, ${fmt(st.alt)} m (${fmt(st.total)} m climbed in total).`;
  }
  function tabMove() {
    const C = H.C, d = H.G.dev || {};
    const sky = H.Scene.skyOverride;
    const night = d.night == null ? 'auto' : d.night ? 'on' : 'off';
    const st = H.devActive() ? H.devLap() : { lap: 1, alt: C.startAlt };
    return `<div class="dev-sec">
      <p class="dev-note" id="dev-move-now">${esc(moveLabel())}</p>
      <h3>Jump to leg</h3>
      <p class="dev-note">Ends the current leg and starts that position of the leg pattern straight away (before a leg starts, it sets the next one).</p>
      <div class="dev-row">${C.legs.map((l, i) => btn('jump-leg', `${i + 1} · ${C.legKinds[i]} · ${l.secs} s ×${l.mult}`, { v: i })).join('')}</div>
      <h3>Altitude</h3>
      <div class="dev-row"><label for="dev-alt" class="sr-only">Altitude</label>
        <input class="dev-in" type="range" id="dev-alt" min="${C.startAlt}" max="${C.summitAlt - 1}" step="1" value="${Math.round(st.alt)}">
        <output id="dev-alt-out" for="dev-alt">${fmt(st.alt)} m</output></div>
      <div class="dev-row">${C.milestones.map((m) => btn('milestone', `${esc(m.short)} ${fmt(m.alt)}`, { v: m.id })).join('')}</div>
      <h3>Lap</h3>
      <div class="dev-row"><label>Lap <input class="dev-in" type="number" id="dev-lap-n" min="1" step="1" value="${st.lap}"></label>${btn('set-lap', 'Set lap')}</div>
      <h3>Time of day</h3>
      <p class="dev-note">Scrubs the sky, sun, stars and weather without moving the climber.</p>
      <div class="dev-row"><label for="dev-sky" class="sr-only">Sky time of day</label>
        <input class="dev-in" type="range" id="dev-sky" min="${C.startAlt}" max="${C.summitAlt}" step="1" value="${Math.round(sky != null ? sky : st.alt)}">
        <output id="dev-sky-out" for="dev-sky">${sky != null ? skyName(sky) : 'Following the climber'}</output></div>
      <div class="dev-row">${btn('sky-follow', 'Follow the climber', { pressed: sky == null })}</div>
      <h3>Night panels</h3>
      <div class="dev-row" role="group" aria-label="Night panels">${['auto', 'on', 'off'].map((v) => btn('night', v[0].toUpperCase() + v.slice(1), { v, pressed: night === v })).join('')}</div>
    </div>`;
  }

  // ---------------------------------------------------------------- content
  function tabContent() {
    const d = H.G.dev || {};
    const next = d.nextCat ? H.ALL.find((c) => c.id === d.nextCat) : null;
    const today = H.E.localDateStr();
    const n = H.E.puzzleNumber(today);
    return `<div class="dev-sec">
      <h3>Next leg's category</h3>
      <p class="dev-note">${next ? `Queued: <strong>${esc(next.text)}</strong> (${esc(next.kind)}).` : 'Nothing queued: the next leg deals from its normal pool.'}</p>
      <label class="sr-only" for="dev-cat-search">Search categories</label>
      <input class="dev-in" type="search" id="dev-cat-search" placeholder="Search ${H.ALL.length} categories" autocomplete="off">
      <label class="sr-only" for="dev-cat-list">Categories</label>
      <select class="dev-in" id="dev-cat-list" size="6">${catOptions('')}</select>
      <div class="dev-row">${btn('next-cat', 'Use for next leg', { cls: 'primary' })}${next ? btn('clear-next-cat', 'Clear') : ''}</div>
      <h3>Autoplay bot</h3>
      <p class="dev-note">Types seed answers through the real submit path during a dev climb. It pauses with the game.</p>
      <div class="dev-row">
        <label>Rank <select class="dev-in" id="dev-bot-rank"><option value="mix"${bot.rank === 'mix' ? ' selected' : ''}>Random mix</option>${H.C.tiers.map((t, i) => `<option value="${i}"${bot.rank === String(i) ? ' selected' : ''}>${t.name}</option>`).join('')}</select></label>
        <label>Wrong every <input class="dev-in" type="number" id="dev-bot-wrong" min="0" step="1" value="${bot.wrongEvery}"> <span class="dev-note">(0 = never)</span></label>
        <label>Typo every <input class="dev-in" type="number" id="dev-bot-typo" min="0" step="1" value="${bot.typoEvery}"> <span class="dev-note">(0 = never; misspells a real answer)</span></label></div>
      <div class="dev-row"><label for="dev-bot-rate">Speed</label><input class="dev-in" type="range" id="dev-bot-rate" min="1" max="6" step="1" value="${bot.rate}"><output id="dev-bot-rate-out" for="dev-bot-rate">${bot.rate}/s</output>
        ${btn('bot', bot.on ? 'Stop bot' : 'Start bot', { cls: bot.on ? 'on' : 'primary', pressed: bot.on })}</div>
      <h3>Cheat sheet</h3>
      <div class="dev-cheat" id="dev-cheat"></div>
      <h3>Preview a day</h3>
      <div class="dev-row"><label>Date <input class="dev-in" type="date" id="dev-prev-date" value="${today}"></label>
        <label>Puzzle # <input class="dev-in" type="number" id="dev-prev-num" min="1" step="1" value="${n}"></label></div>
      <ol class="dev-log" id="dev-preview"></ol>
    </div>`;
  }
  afterRender.content = () => { renderCheat(); renderPreview(H.E.puzzleNumber(H.E.localDateStr())); };
  function catOptions(q) {
    const s = q.trim().toLowerCase();
    return H.ALL.filter((c) => !s || c.text.toLowerCase().includes(s) || c.id.includes(s) || c.kind.includes(s))
      .map((c) => `<option value="${esc(c.id)}">${esc(c.text)} · ${esc(c.kind)}${c.lane ? '/' + esc(c.lane) : ''}</option>`).join('');
  }
  function filterCats(q) { const l = $('#dev-cat-list'); if (l) l.innerHTML = catOptions(q); }
  function renderPreview(n) {
    const el = $('#dev-preview');
    if (!el) return;
    const cats = H.E.dailyCategories(H.DATA, n);
    el.innerHTML = cats.map((c, i) => `<li>Leg ${i + 1} · ${esc(c.kind)}${c.lane ? '/' + esc(c.lane) : ''} · <strong>${esc(c.text)}</strong></li>`).join('');
  }
  function renderCheat() {
    const el = $('#dev-cheat');
    if (!el) return;
    const G = H.G;
    const ix = G.index && G.index[G.legIdx];
    if (!ix || G.screen !== 'play') { el.innerHTML = '<p class="dev-note">Shows the current leg\'s full answer list during a climb.</p>'; return; }
    const leg = H.curLeg();
    const found = new Set(leg ? leg.answers.filter((a) => a.s === 'ok' && a.eid != null && !a.q).map((a) => a.eid) : []);
    const variants = leg ? leg.answers.filter((a) => a.s === 'ok' && a.q).map((a) => a.c) : [];
    const quals = H.E.qualifierList(ix.cat);
    el.innerHTML = `<p class="dev-note"><strong>${esc(ix.cat.text)}</strong>: ${found.size} of ${ix.entries.length} found. Found answers are bold, underlined and ticked.</p>`
      + H.C.tiers.map((t, i) => {
        const list = ix.entries.filter((e) => e.tier === i);
        const got = list.filter((e) => found.has(e.id)).length;
        return `<h4 class="t${i}">${H.ICON[i]}${t.name} <span class="dev-note">${got}/${list.length}</span></h4><p>${list.map((e) => found.has(e.id) ? `<span class="got">✓ ${esc(e.canon)}</span>` : esc(e.canon)).join(', ') || '—'}</p>`;
      }).join('')
      + `<h4>Qualifiers <span class="dev-note">${variants.length}/${H.C.maxQualifiedPerLeg} used this leg</span></h4>`
      + `<p>${quals.length ? quals.map(esc).join(', ') + ' (one in front of any answer above; scores at that answer\'s rank)' : 'None for this category.'}</p>`
      + (variants.length ? `<p>Found: ${variants.map((c) => `<span class="got">✓ ${esc(c)}</span>`).join(', ')}</p>` : '');
  }

  // autoplay bot
  const bot = { on: false, rank: 'mix', rate: 4, wrongEvery: 0, typoEvery: 0, n: 0, timer: null };
  // One realistic slip: drop one of a doubled letter, or swap a later letter for a QWERTY neighbour.
  const KB_ROWS = ['qwertyuiop', 'asdfghjkl', 'zxcvbnm'];
  function kbNeighbour(ch) {
    for (let r = 0; r < 3; r++) {
      const c = KB_ROWS[r].indexOf(ch);
      if (c < 0) continue;
      const opts = [KB_ROWS[r][c - 1], KB_ROWS[r][c + 1]].filter(Boolean);
      return opts[Math.floor(Math.random() * opts.length)];
    }
    return null;
  }
  function misspell(word) {
    const w = word.toLowerCase();
    const dbl = [];
    for (let i = 1; i < w.length; i++) if (w[i] === w[i - 1] && /[a-z]/.test(w[i])) dbl.push(i);
    if (dbl.length && Math.random() < 0.5) { const i = dbl[Math.floor(Math.random() * dbl.length)]; return w.slice(0, i) + w.slice(i + 1); }
    const spots = [];
    for (let i = 2; i < w.length - 1; i++) if (kbNeighbour(w[i])) spots.push(i);
    if (!spots.length) return w;
    const i = spots[Math.floor(Math.random() * spots.length)];
    return w.slice(0, i) + kbNeighbour(w[i]) + w.slice(i + 1);
  }
  function startBot() {
    clearInterval(bot.timer);
    bot.on = true;
    bot.timer = setInterval(botStep, Math.round(1000 / Math.max(1, bot.rate)));
    notice(`Bot on: ${bot.rank === 'mix' ? 'random mix' : H.C.tiers[Number(bot.rank)].name}, ${bot.rate}/s.`);
  }
  function stopBot() {
    if (!bot.on) return;
    clearInterval(bot.timer);
    bot.on = false;
    if (tab === 'content' && !$('#dev-panel').hidden) renderTab();
  }
  function botStep() {
    const G = H.G;
    if (!H.devLegLive() || (G.dev && G.dev.paused) || Date.now() < G.pauseUntil) return;
    const leg = H.curLeg(), ix = G.index[G.legIdx];
    if (!leg || !ix) return;
    bot.n += 1;
    if (bot.wrongEvery > 0 && bot.n % bot.wrongEvery === 0) { H.submit('zzq' + Math.random().toString(36).slice(2, 6)); return; }
    const found = new Set(leg.answers.filter((a) => a.s === 'ok').map((a) => a.eid));
    let pool = ix.entries.filter((e) => !found.has(e.id));
    const typo = bot.typoEvery > 0 && bot.n % bot.typoEvery === 0;
    if (typo) { const long = pool.filter((e) => H.E.normalize(e.canon).replace(/ /g, '').length >= 6); if (long.length) pool = long; }
    if (bot.rank !== 'mix') {
      const r = Number(bot.rank);
      const exact = pool.filter((e) => e.tier === r), lower = pool.filter((e) => e.tier < r);
      pool = exact.length ? exact : lower.length ? lower : pool;
    }
    if (!pool.length) return;
    const pick = pool[Math.floor(Math.random() * pool.length)].canon;
    H.submit(typo ? misspell(pick) : pick);
  }

  // ---------------------------------------------------------------- answers (the full answer bank)
  // Every category's answers with rank and score, from DA_DEV_CORE.answerTable().
  // Rows are built once per category and leg; search, rank filter and sort run in
  // memory, and the table renders in chunks so typing stays smooth on a phone.
  const ANS_CHUNK = 200;
  const ans = { cat: null, picked: false, q: '', ranks: null, pos: null, sort: 'rare', shown: ANS_CHUNK, cache: null, view: [], announceT: 0 };
  function ansCurrentCat() {
    const G = H.G, ix = G.index && G.index[G.legIdx];
    return G.screen === 'play' && ix ? ix.cat.id : null;
  }
  function ansCat() {
    if (!ans.cat) ans.cat = ansCurrentCat() || H.ALL[0].id;
    return H.ALL.find((c) => c.id === ans.cat) || H.ALL[0];
  }
  function ansGroups() {
    const groups = [['broad', 'Broad'], ['mid:geo', 'Mid · geography'], ['mid:nature', 'Mid · nature'], ['mid:culture', 'Mid · culture'], ['wild', 'Wildcard'], ['hard', 'Hard'], ['practice', 'Practice']];
    return groups.map(([key, label]) => {
      const [kind, lane] = key.split(':');
      const list = H.ALL.filter((c) => c.kind === kind && (!lane || c.lane === lane));
      return list.length ? `<optgroup label="${esc(label)}">${list.map((c) => `<option value="${esc(c.id)}"${c.id === ans.cat ? ' selected' : ''}>${esc(c.text)}</option>`).join('')}</optgroup>` : '';
    }).join('');
  }
  function ansPosOptions(cat) {
    const nat = Math.max(0, H.C.legKinds.indexOf(cat.kind));   // same rule as answerTable()
    return `<option value=""${ans.pos == null ? ' selected' : ''}>Natural leg (${nat + 1}, ×${H.C.legs[nat].mult})</option>`
      + H.C.legs.map((l, i) => `<option value="${i}"${ans.pos === i ? ' selected' : ''}>Leg ${i + 1} (×${l.mult})</option>`).join('');
  }
  function tabAnswers() {
    if (!ans.ranks) ans.ranks = H.C.tiers.map(() => true);
    const cat = ansCat();
    const sorts = [['rare', 'Rarest first'], ['common', 'Most common first'], ['az', 'A–Z'], ['list', 'List order']];
    return `<div class="dev-sec dev-ans">
      <p class="dev-note">Every answer in a category, with its rank (how rare it is) and what it scores. Works any time; during a climb it opens on the current leg and ticks what you've found.</p>
      <div class="dev-row"><label>Category <select class="dev-in" id="dev-ans-cat">${ansGroups()}</select></label></div>
      <label class="sr-only" for="dev-ans-q">Search answers and aliases</label>
      <input class="dev-in" type="search" id="dev-ans-q" placeholder="Search answers and aliases" autocomplete="off" autocapitalize="off" spellcheck="false" value="${esc(ans.q)}">
      <div class="dev-row" role="group" aria-label="Ranks shown">${H.C.tiers.map((t, i) => btn('ans-rank', `${H.ICON[i]}${esc(t.name)}`, { cls: 't' + i + ' dev-chip', v: i, pressed: ans.ranks[i] })).join('')}</div>
      <div class="dev-row" id="dev-ans-ctl">
        <label>Score at <select class="dev-in" id="dev-ans-pos">${ansPosOptions(cat)}</select></label>
        <label>Sort <select class="dev-in" id="dev-ans-sort">${sorts.map(([v, l]) => `<option value="${v}"${ans.sort === v ? ' selected' : ''}>${l}</option>`).join('')}</select></label>
        ${btn('ans-csv', 'Copy as CSV')}
      </div>
      <div id="dev-ans-sum" class="dev-ans-sum"></div>
      <div id="dev-ans-table"></div>
    </div>`;
  }
  afterRender.answers = () => renderAnswers(false);
  function renderAnswersControls() {
    const el = $('#dev-ans-pos');
    if (el) el.innerHTML = ansPosOptions(ansCat());
  }
  function ansTable() {
    const cat = ansCat();
    const key = cat.id + '|' + (ans.pos == null ? 'n' : ans.pos);
    if (!ans.cache || ans.cache.key !== key) {
      const t = CORE.answerTable(H.E, cat, ans.pos == null ? {} : { pos: ans.pos });
      t.rows.forEach((r) => { r.search = [r.norm, ...r.aliases.map((a) => H.E.normalize(a))].join('|'); });
      ans.cache = { key, t };
    }
    return ans.cache.t;
  }
  function ansFound(cat) {
    const leg = H.curLeg && H.curLeg();
    if (!leg || ansCurrentCat() !== cat.id) return null;
    return new Set(leg.answers.filter((a) => a.s === 'ok' && a.eid != null && !a.q).map((a) => a.eid));
  }
  function renderAnswers(announceCount) {
    const sumEl = $('#dev-ans-sum'), tblEl = $('#dev-ans-table');
    if (!sumEl || !tblEl || !H) return;
    const cat = ansCat();
    const t = ansTable(), S = t.summary, C = H.C;
    const q = H.E.normalize(ans.q || '');
    let view = t.rows.filter((r) => ans.ranks[r.tier] && (!q || r.search.includes(q)));
    const byName = (a, b) => a.canon.localeCompare(b.canon);
    if (ans.sort === 'rare') view.sort((a, b) => b.tier - a.tier || byName(a, b));
    else if (ans.sort === 'common') view.sort((a, b) => a.tier - b.tier || byName(a, b));
    else if (ans.sort === 'az') view.sort(byName);
    ans.view = view;
    const found = ansFound(cat);
    const max = Math.max(1, ...S.counts);
    const kind = S.kind + (S.lane ? ' · ' + S.lane : '');
    sumEl.innerHTML = `<p><strong>${esc(S.text)}</strong> <span class="dev-note">${esc(kind)} · ${fmt(S.total)} answers · scores at leg ${S.pos + 1} (×${S.mult})${S.pos === S.natural ? ', its natural leg' : ''}${found ? ` · ${found.size} found this leg` : ''}</span></p>
      <ul class="dev-ans-ranks">${C.tiers.map((tier, i) => `<li class="t${i}"><span class="rk">${H.ICON[i]}${esc(tier.name)}</span><b>${fmt(S.counts[i])}</b><span class="bar" aria-hidden="true"><i style="width:${Math.round(100 * S.counts[i] / max)}%"></i></span><small>${esc(S.bands[i])} · +${tier.gain} m</small></li>`).join('')}</ul>
      ${S.qualifiers.length ? `<p class="dev-note">Plus up to ${C.maxQualifiedPerLeg} variants per leg: ${esc(S.qualifiers.join(', '))} (one in front of any answer, at that answer's rank).</p>` : ''}`;
    const rows = view.slice(0, ans.shown);
    tblEl.innerHTML = `<table class="dev-ans-table">
      <caption>${fmt(view.length)} of ${fmt(S.total)} answers${view.length > rows.length ? `, showing the first ${fmt(rows.length)}` : ''}</caption>
      <thead><tr><th scope="col">Rank</th><th scope="col">Answer</th><th scope="col" class="num">Base</th><th scope="col" class="num">Leg ${S.pos + 1}</th><th scope="col" class="num c-max">Max chain</th></tr></thead>
      <tbody>${rows.map((r) => `<tr class="t${r.tier}${found && found.has(r.id) ? ' got' : ''}" data-tier="${r.tier}">
        <td class="rk">${H.ICON[r.tier]}${esc(r.rank)}</td>
        <td>${found && found.has(r.id) ? '<span class="got-mark" aria-label="found">✓ </span>' : ''}${esc(r.canon)}${r.aliases.length ? `<span class="al">also: ${esc(r.aliases.join(', '))}</span>` : ''}</td>
        <td class="num">${fmt(r.base)}</td><td class="num">${fmt(r.atPos)}</td><td class="num c-max">${fmt(r.atPosMax)}</td></tr>`).join('')}</tbody>
    </table>${view.length > rows.length ? `<div class="dev-row">${btn('ans-more', `Show ${fmt(Math.min(ANS_CHUNK, view.length - rows.length))} more`)}</div>` : ''}${!view.length ? '<p class="dev-note">No answers match.</p>' : ''}`;
    if (announceCount) {
      clearTimeout(ans.announceT);
      ans.announceT = setTimeout(() => notice(`${fmt(view.length)} answer${view.length === 1 ? '' : 's'} shown`), 450);
    }
  }
  function copyAnswersCsv() {
    const t = ansTable(), S = t.summary;
    const cell = (v) => { const x = String(v); return /[",\n]/.test(x) ? '"' + x.replace(/"/g, '""') + '"' : x; };
    const lines = [['category', 'answer', 'aliases', 'rank', 'base', `score at leg ${S.pos + 1}`, 'score at max chain'].join(',')]
      .concat(ans.view.map((r) => [S.text, r.canon, r.aliases.join('; '), r.rank, r.base, r.atPos, r.atPosMax].map(cell).join(',')));
    const text = lines.join('\n');
    const done = () => notice(`Copied ${fmt(ans.view.length)} answers as CSV.`);
    const fallback = () => {
      const dlg = $('#dlg-dev-csv'), ta = $('#dev-csv-text');
      ta.value = text;
      try { dlg.showModal(); } catch (e) { dlg.setAttribute('open', ''); }
      ta.focus(); ta.select();
      notice('Copying is blocked here: the CSV is selected in the dialog, copy it from there.');
    };
    try { navigator.clipboard.writeText(text).then(done, fallback); } catch (e) { fallback(); }
  }

  // ---------------------------------------------------------------- effects
  // alpaca ride preview settings (Effects tab)
  const rideFx = { style: 'auto', band: 'auto', golden: false, late: false, spit: false, reduced: false, meters: 625 };
  // draft climber cosmetics (preview only: never saved, gone on lock or reload). '' = the slot's default.
  const outfit = { hat: '', eyes: '', neck: '', over: '', suit: '' };
  const OUTFIT_SLOTS = [['hat', 'Hat', 'Default beanie', 'None (bare head)'], ['eyes', 'Eyes', 'None'], ['neck', 'Neck', 'None'], ['over', 'Over-layer', 'None'], ['suit', 'Suit', 'Default down suit']];
  function applyOutfit(log) {
    const o = {}; let any = false;
    for (const [k] of OUTFIT_SLOTS) { if (outfit[k] === '-') { o[k] = null; any = true; } else if (outfit[k]) { o[k] = outfit[k]; any = true; } }
    H.setOutfit(any ? o : null);
    if (log) {
      const names = OUTFIT_SLOTS.map(([k]) => (outfit[k] === '-' ? 'no hat' : outfit[k] ? H.cosmetics[outfit[k]].name.toLowerCase() : '')).filter(Boolean);
      LOG.unshift({ t: new Date(), kind: 'note', text: '', line: 'outfit: ' + (names.length ? names.join(' + ') : 'default') });
      if (LOG.length > 300) LOG.length = 300;
    }
  }
  function tabEffects() {
    const kinds = ['t0', 't1', 't2', 't3', 't4', 'bad', 'dup', 'tick', 'count', 'go', 'end', 'hooves', 'alpaca', 'golden', 'splat'];
    const opt = (list, cur) => list.map(([v, l]) => `<option value="${v}"${cur === v ? ' selected' : ''}>${l}</option>`).join('');
    const chk = (id, label, on) => `<label class="dev-check"><input type="checkbox" id="${id}"${on ? ' checked' : ''}> ${label}</label>`;
    return `<div class="dev-sec">
      <p class="dev-note">Fires the full find feedback for a rank without changing the score. The spotlight and the "+N m" pop appear on the play screen; elsewhere you get the sound, canvas burst and flash. Sound buttons play even when sound is off.</p>
      <h3>Rank finds</h3>
      <div class="dev-row">${H.C.tiers.map((t, i) => `<button class="dev-btn t${i}" data-act="rank-fx" data-v="${i}">${H.ICON[i]}${t.name}</button>`).join('')}</div>
      <h3>Sounds</h3>
      <div class="dev-row">${kinds.map((k) => btn('sound', k, { v: k })).join('')}</div>
      <h3>Moments</h3>
      <div class="dev-row">${btn('flag', 'Plant summit flag')}${btn('confetti', 'Prayer-flag confetti')}${btn('shake', 'Wrong-answer shake')}</div>
      <h3>Alpaca ride</h3>
      <p class="dev-note">Plays the Sherpa alpaca ride without changing the score or holding the clock. Unticked rare variants are off, so each preview shows exactly what you pick.</p>
      <div class="dev-row">
        <label>Style <select class="dev-in" id="dev-ride-style">${opt([['auto', 'Random']].concat(H.C.ride.styles.map((st) => [st.id, st.id])), rideFx.style)}</select></label>
        <label>Band <select class="dev-in" id="dev-ride-band">${opt([['auto', 'Current altitude'], ['grass', 'Grass'], ['trail', 'Trail'], ['glacier', 'Glacier'], ['deathzone', 'Death Zone']], rideFx.band)}</select></label>
        <label>Meters <input class="dev-in" type="number" id="dev-ride-m" min="0" max="1500" step="25" value="${rideFx.meters}"></label>
      </div>
      <div class="dev-row">${chk('dev-ride-golden', 'Golden alpaca', rideFx.golden)}${chk('dev-ride-late', 'Late alpaca', rideFx.late)}${chk('dev-ride-spit', 'Farewell spit', rideFx.spit)}${chk('dev-ride-reduced', 'Reduced-motion preview', rideFx.reduced)}</div>
      <div class="dev-row">${btn('ride-fx', 'Play alpaca ride', { cls: 'primary' })}</div>
      <h3>Climber outfit (draft)</h3>
      <p class="dev-note">Draft cosmetics, for checking how items layer on the climber. Preview only: never saved and never shown to players. It resets when dev mode locks or the page reloads.</p>
      <div class="dev-row">${OUTFIT_SLOTS.map(([k, label, dflt, none]) => {
        const items = Object.entries(H.cosmetics).filter(([, c]) => c.slot === k);
        const list = [['', dflt]].concat(none ? [['-', none]] : [], items.map(([id, c]) => [id, c.name]));
        return `<label>${label} <select class="dev-in" id="dev-outfit-${k}">${opt(list, outfit[k])}</select></label>`;
      }).join('')}</div>
      <div class="dev-row">${btn('outfit-reset', 'Reset outfit')}</div>
    </div>`;
  }

  // ---------------------------------------------------------------- answer debugger
  const LOG = [];
  let dbgText = '', dbgSource = 'answer box', dbgCat = 'current';
  function tabDebug() {
    return `<div class="dev-sec">
      <p class="dev-note">Analyses whatever you type in the answer box (live) or in the test box below. Every submission is logged with how it matched and what it scored.</p>
      <div class="dev-row"><label>Category <select class="dev-in" id="dev-dbg-cat"><option value="current"${dbgCat === 'current' ? ' selected' : ''}>Current leg</option>${H.ALL.map((c) => `<option value="${esc(c.id)}"${dbgCat === c.id ? ' selected' : ''}>${esc(c.text)}</option>`).join('')}</select></label></div>
      <label class="sr-only" for="dev-dbg-in">Test an answer</label>
      <input class="dev-in" id="dev-dbg-in" type="text" placeholder="Test an answer" autocomplete="off" autocapitalize="off" spellcheck="false" value="${esc(dbgSource === 'test box' ? dbgText : '')}">
      <dl class="dev-kv" id="dev-dbg-out"></dl>
      <h3>Submissions</h3>
      <div class="dev-row">${btn('log-copy', 'Copy log')}${btn('log-clear', 'Clear')}</div>
      <ol class="dev-log" id="dev-dbg-log" aria-label="Submission log, newest first"></ol>
    </div>`;
  }
  afterRender.debug = () => { analyseNow(); renderLog(); };

  function dbgIndex() {
    const G = H.G;
    if (dbgCat !== 'current') { const c = H.ALL.find((x) => x.id === dbgCat); return c ? H.E.buildIndex(c) : null; }
    return (G.index && G.index[G.legIdx]) || null;
  }
  let ixCache = { id: null, ix: null };
  function cachedIndex() {
    if (dbgCat === 'current') return dbgIndex();
    if (ixCache.id !== dbgCat) ixCache = { id: dbgCat, ix: dbgIndex() };
    return ixCache.ix;
  }

  function analyse(text, ix) {
    const E = H.E;
    const norm = E.normalize(text || '');
    const out = { text, norm, keys: norm ? E.candidateKeys(norm) : [], bare: '', bareKeys: [], m: null, competitors: [] };
    if (!norm || !ix) return out;
    out.bare = E.stripAffixes(norm, ix.cat);
    if (out.bare !== norm) out.bareKeys = E.candidateKeys(out.bare);
    out.m = E.match(ix, text);
    // Stage 3 (autocorrect) runs only when the list itself has no match.
    const listed = E.match(ix, text, { noFuzzy: true });
    if (!(listed && listed.entry && !listed.qualifier)) {
      const base = out.m && out.m.qualifier ? norm.slice(out.m.qualifier.length + 1) : norm;
      out.corr = E.corrections(ix, base, true);
      out.corrInput = base;
    }
    if (out.m && out.m.ambiguous && out.corr) out.competitors = out.corr.ranked.filter((r) => r.allowed).slice(0, 4).map((r) => r.entry);
    return out;
  }
  function resultText(r) {
    if (!r.norm) return 'empty after normalizing';
    if (!r.m) return 'no match (rejected, or sent to the checker if it is on)';
    if (r.m.ambiguous) return 'ambiguous: too close to call between ' + r.competitors.map((e) => `${e.canon} (${H.tierName(e.tier)})`).join(', ');
    const how = r.m.fix ? `corrected (${r.m.fix})` : r.m.via;
    if (r.m.qualifier) return `qualified → ${r.m.canon} · base ${r.m.entry.canon} (${how}) · ${H.tierName(r.m.entry.tier)}`;
    return `${how} → ${r.m.entry.canon} · ${H.tierName(r.m.entry.tier)}`;
  }
  function analyseNow() {
    const out = $('#dev-dbg-out');
    if (!out) return;
    const ix = cachedIndex();
    const r = analyse(dbgText, ix);
    const rows = [
      ['Source', `${dbgSource}${ix ? ' · ' + ix.cat.text : ' · no category (start a leg or pick one)'}`],
      ['Raw', JSON.stringify(dbgText || '')],
      ['normalize()', JSON.stringify(r.norm)],
      ['candidateKeys()', r.keys.map((k) => JSON.stringify(k)).join(', ') || '—'],
      ['Affix-stripped', r.bare && r.bare !== r.norm ? `${JSON.stringify(r.bare)} → ${r.bareKeys.map((k) => JSON.stringify(k)).join(', ')}` : '—'],
      ['Qualifiers', ix ? (H.E.qualifierList(ix.cat).join(', ') || 'none for this category') : '—'],
      ['Match', ix ? resultText(r) : '—'],
    ];
    if (ix && r.norm) {
      if (!r.corr) rows.push(['Correction', 'not needed: the list matched directly']);
      else {
        const K = H.C.correct, c = r.corr;
        const fmtC = (x) => (x === Infinity ? '∞' : String(Math.round(x * 100) / 100));
        rows.push(['Correction input', `${JSON.stringify(r.corrInput)} · phonetic key ${JSON.stringify(c.key)}`]);
        c.ranked.slice(0, 3).forEach((x, i) => rows.push([`Candidate ${i + 1}`,
          `${x.entry.canon} via ${JSON.stringify(x.form)} · cost ${fmtC(x.cost)}${x.fix ? ' (' + x.fix + ')' : ''} · allowance ${fmtC(x.allow)} · key ${JSON.stringify(x.formKey)} · ${x.allowed ? 'within' : 'out: ' + x.reason}`]));
        if (!c.ranked.length) rows.push(['Candidates', 'none']);
        const ok = c.ranked.filter((x) => x.allowed);
        rows.push(['Margin check', ok.length < 2 ? (ok.length ? 'only one candidate within its allowance' : '—')
          : `runner-up ${ok[1].entry.canon} is ${fmtC(ok[1].cost - ok[0].cost)} behind (needs ${K.margin}, or the winner alone sounds the same)`]);
        const v = c.verdict;
        rows.push(['Verdict', v && v.entry ? `corrected to ${v.entry.canon} (${v.fix})` : v && v.ambiguous ? `ambiguous between ${v.ambiguous.map((e) => e.canon).join(' and ')}`
          : `no candidate${c.ranked[0] ? ' (closest ' + c.ranked[0].entry.canon + ': ' + (c.ranked[0].reason || 'over the allowance') + ')' : ''}`]);
      }
    }
    if (r.m && r.m.qualifier) {
      const rest = r.norm.slice(r.m.qualifier.length + 1);
      rows.push(['Qualifier step', `stripped ${JSON.stringify(r.m.qualifier)} → base ${JSON.stringify(rest)} → ${r.m.entry.canon} (${r.m.via})`]);
      rows.push(['Dedupe key', H.E.answerKey(r.m.entry.id, r.m.qualifier)]);
    }
    if (r.m && r.m.entry) {
      const e = r.m.entry;
      rows.push(['Entry', `#${e.id} ${e.canon}${e.aliases.length ? ' (aliases: ' + e.aliases.join(', ') + ')' : ''}`]);
      const G = H.G, leg = H.curLeg();
      if (dbgCat === 'current' && leg && G.state === 'leg') {
        const raw = H.E.answerGain(e.tier, leg.chain, H.legPos(G.legIdx));
        const eff = H.E.legEffective(leg.raw + raw) - H.E.legEffective(leg.raw);
        const key = H.E.answerKey(e.id, r.m.qualifier);
        const dupe = leg.answers.some((a) => a.s === 'ok' && H.E.answerKey(a.eid, a.q) === key);
        const capped = !dupe && r.m.qualifier && leg.answers.filter((a) => a.s === 'ok' && a.q).length >= H.C.maxQualifiedPerLeg;
        rows.push(['Would gain', dupe ? 'nothing: already found this leg' : capped ? 'nothing: variant limit reached this leg' : `+${fmt(raw)} raw · +${fmt(eff)} m effective (chain ${leg.chain})`]);
      } else rows.push(['Base gain', `+${H.C.tiers[e.tier].gain} m before chain and leg multipliers`]);
    }
    out.innerHTML = rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('');
  }
  // live: the real answer box
  document.addEventListener('input', (e) => {
    if (!H || e.target.id !== 'answer') return;
    dbgText = e.target.value; dbgSource = 'answer box';
    if (tab === 'debug' && !$('#dev-panel').hidden) analyseNow();
  }, true);

  function logAnswer(d) {
    const G = H.G;
    const ix = G.index && G.index[d.legIdx != null ? d.legIdx : G.legIdx];
    const text = d.text != null ? d.text : d.ans ? d.ans.t : '';
    const r = analyse(text, ix);
    const e = { t: new Date(), kind: d.kind, text, match: ix ? resultText(r) : '—', cat: ix ? ix.cat.text : '' };
    if (d.kind === 'ok') Object.assign(e, { canon: d.ans.c, tier: d.ans.tier, raw: d.rawGain, eff: d.eff, fix: d.ans.x || null, via: d.ans.k === 'judge' ? 'checker' : d.ans.q ? 'qualified (' + d.ans.q + ')' : r.m && r.m.via });
    if (d.kind === 'dup') e.canon = d.ans.c || d.ans.t;
    if (d.kind === 'rejected') e.penalized = d.penalized;
    if (d.kind === 'judged') { e.decision = d.decision; e.verdict = d.verdict; }
    LOG.unshift(e);
    if (LOG.length > 300) LOG.length = 300;
    if (tab === 'debug' && !$('#dev-panel').hidden) renderLog();
  }
  function logRide(d) {
    const p = d.plan || {};
    const what = p.reduced ? 'reduced motion, no ride' : [p.style, p.band, p.golden && 'golden', p.late && 'late', p.spit && 'spit', p.shortHop && 'short hop', p.noMove && 'no move'].filter(Boolean).join(' · ');
    LOG.unshift({ t: new Date(), kind: 'ride', text: d.ans ? d.ans.c : '', line: `alpaca ride${d.test ? ' (effect test)' : ''}: ${what} · +${fmt(d.eff || 0)} m` });
    if (LOG.length > 300) LOG.length = 300;
    if (tab === 'debug' && !$('#dev-panel').hidden) renderLog();
  }
  function logLine(e) {
    const head = `${clockStr(e.t)}  ${JSON.stringify(e.text)}`;
    switch (e.kind) {
      case 'ok': return e.fix
        ? `${clockStr(e.t)}  corrected (${e.fix}): ${e.text} → ${e.canon}${e.via && e.via.startsWith('qualified') ? ' · ' + e.via : ''} · ${H.tierName(e.tier)} · +${fmt(e.raw)} raw / +${fmt(e.eff)} m`
        : `${head} → ACCEPTED via ${e.via || 'seed'} → ${e.canon} · ${H.tierName(e.tier)} · +${fmt(e.raw)} raw / +${fmt(e.eff)} m`;
      case 'ride': case 'note': return `${clockStr(e.t)}  ${e.line}`;
      case 'dup': return `${head} → DUPLICATE of ${e.canon} (no penalty)`;
      case 'variant-limit': return `${head} → VARIANT LIMIT reached (no points, no penalty) · ${e.match}`;
      case 'rejected': return `${head} → REJECTED${e.penalized ? ' · −1 s' : ''} · ${e.match}`;
      case 'pending': return `${head} → sent to the answer checker`;
      case 'judged': return `${head} → checker verdict ${JSON.stringify(e.verdict)} → ${e.decision.kind}${e.decision.kind === 'accept' ? ' as ' + H.tierName(e.decision.tier) : e.decision.kind === 'reject' ? (e.decision.penalize ? ' with −1 s' : ' without penalty') : ' (unchecked)'}`;
      default: return head;
    }
  }
  function renderLog() {
    const el = $('#dev-dbg-log');
    if (!el) return;
    el.innerHTML = LOG.length ? LOG.slice(0, 120).map((e) => `<li>${esc(logLine(e))}</li>`).join('') : '<li class="dev-note">No submissions yet.</li>';
  }

  // ---------------------------------------------------------------- answer checker simulator
  const mock = { on: false, orig: null, state: 'on', queue: [], dflt: 'valid-sure', comm: 0.2, delay: 600, calls: [] };
  const VERDICTS = [['valid-sure', 'Valid, sure'], ['valid-unsure', 'Valid, unsure (capped at Hiker)'], ['invalid-sure', 'Invalid, sure (−1 s)'], ['invalid-unsure', 'Invalid, unsure (no penalty)'], ['malformed', 'Malformed (unchecked)']];
  const COMMONNESS = [[0.5, 'Crawler (0.5)'], [0.2, 'Hiker (0.2)'], [0.05, 'Climber (0.05)'], [0.02, 'Mountaineer (0.02)'], [0.005, 'Sherpa (0.005)']];
  function verdictFor(kind, comm, text) {
    const canonical = String(text).trim().replace(/\b\w/g, (c) => c.toUpperCase());
    switch (kind) {
      case 'valid-sure': return { i: 1, valid: true, canonical, commonness: comm, confidence: 0.95 };
      case 'valid-unsure': return { i: 1, valid: true, canonical, commonness: comm, confidence: 0.3 };
      case 'invalid-sure': return { i: 1, valid: false, canonical, commonness: 0, confidence: 0.95 };
      case 'invalid-unsure': return { i: 1, valid: false, canonical, commonness: 0, confidence: 0.3 };
      default: return { i: 1, valid: 'maybe' };
    }
  }
  function mockOn() {
    const J = H.Judge;
    if (mock.on) return;
    mock.orig = { state: J.state, ready: J.ready, check: J.check, enable: J.enable, cooldownUntil: J.cooldownUntil };
    // Never reaches window.claude; never writes the real verdict cache.
    J.ready = function () { return this.state === 'on' && Date.now() > this.cooldownUntil; };
    J.check = function (cat, text) {
      const item = mock.queue.length ? mock.queue.shift() : { kind: mock.dflt, comm: mock.comm };
      const v = verdictFor(item.kind, item.comm, text);
      mock.calls.unshift({ t: new Date(), cat: cat.text, text, v });
      if (tab === 'checker' && !$('#dev-panel').hidden) renderTab();
      return new Promise((res) => setTimeout(() => res(v), mock.delay));
    };
    J.enable = function () { this.state = 'on'; this.cooldownUntil = 0; H.renderJudge(); if (tab === 'checker') renderTab(); };
    mock.on = true;
    applyMockState();
    notice('Answer checker mocked.');
  }
  function applyMockState() {
    const J = H.Judge;
    J.cooldownUntil = 0;
    if (mock.state === 'rate_limited') { J.state = 'on'; J.cooldownUntil = Date.now() + 60000; }
    else J.state = mock.state;
    H.renderJudge();
  }
  function mockOff() {
    if (!mock.on) return;
    Object.assign(H.Judge, mock.orig);
    mock.on = false;
    H.renderJudge();
    notice('Answer checker back to normal.');
  }
  function coolLabel() {
    if (!mock.on) return '';
    const left = H.Judge.cooldownUntil - Date.now();
    return left > 0 ? `Rate limited: checks resume in ${Math.ceil(left / 1000)} s.` : `State: ${H.Judge.state}${H.Judge.ready() ? ' (ready)' : ''}.`;
  }
  function tabChecker() {
    return `<div class="dev-sec">
      <p class="dev-note">Fakes the Claude answer checker anywhere, including GitHub Pages. Only answers that aren't on the word list reach it, at most ${H.C.judge.maxPerLeg} per leg. Verdicts go through the game's real verdict handling.</p>
      <div class="dev-row">${btn('mock', 'Mock the checker', { pressed: mock.on, cls: mock.on ? 'on' : '' })}<span class="dev-note" id="dev-mock-cool">${esc(coolLabel())}</span></div>
      <div class="dev-row"><label>State <select class="dev-in" id="dev-mock-state">${['off', 'prompt', 'on', 'denied', 'rate_limited'].map((s) => `<option value="${s}"${mock.state === s ? ' selected' : ''}>${s === 'rate_limited' ? 'rate limited (60 s)' : s}</option>`).join('')}</select></label></div>
      <div class="dev-row"><label>Default verdict <select class="dev-in" id="dev-mock-default">${VERDICTS.map(([v, l]) => `<option value="${v}"${mock.dflt === v ? ' selected' : ''}>${l}</option>`).join('')}</select></label>
        <label>Commonness <select class="dev-in" id="dev-mock-comm">${COMMONNESS.map(([v, l]) => `<option value="${v}"${mock.comm === v ? ' selected' : ''}>${l}</option>`).join('')}</select></label></div>
      <h3>Queue the next verdicts</h3>
      <div class="dev-row">${VERDICTS.map(([v, l]) => btn('mock-queue', '+ ' + l, { v })).join('')}</div>
      <p class="dev-note">${mock.queue.length ? 'Queued: ' + mock.queue.map((q, i) => `${i + 1}. ${VERDICTS.find((x) => x[0] === q.kind)[1]}${q.kind.startsWith('valid') ? ' @ ' + q.comm : ''}`).join(' · ') : 'Queue empty: every check gets the default verdict.'}</p>
      ${mock.queue.length ? `<div class="dev-row">${btn('mock-queue-clear', 'Clear queue')}</div>` : ''}
      <div class="dev-row"><label for="dev-mock-delay">Response delay</label><input class="dev-in" type="range" id="dev-mock-delay" min="0" max="10000" step="100" value="${mock.delay}"><output id="dev-mock-delay-out" for="dev-mock-delay">${(mock.delay / 1000).toFixed(1)} s</output></div>
      <p class="dev-note">Longer than ${(H.C.judge.settleWaitMs / 1000).toFixed(0)} s tests the settle wait: checks still pending then show as "unchecked".</p>
      <h3>Checks</h3>
      <ol class="dev-log" id="dev-mock-log"></ol>
    </div>`;
  }
  afterRender.checker = () => renderMockLog();
  function renderMockLog() {
    const el = $('#dev-mock-log');
    if (!el) return;
    const outcomes = LOG.filter((e) => e.kind === 'judged');
    el.innerHTML = mock.calls.length ? mock.calls.slice(0, 40).map((c) => {
      const o = outcomes.find((e) => e.text === c.text && e.t >= c.t);
      return `<li>${clockStr(c.t)} ${esc(JSON.stringify(c.text))} (${esc(c.cat)}) → ${esc(JSON.stringify(c.v))}${o ? ' → ' + esc(o.decision.kind) : ' → waiting'}</li>`;
    }).join('') : '<li class="dev-note">No checks yet.</li>';
  }

  // ---------------------------------------------------------------- save data and dates
  const readRaw = (k) => { try { return localStorage.getItem(k); } catch (e) { return null; } };
  const pretty = (raw) => { if (raw == null) return '(nothing saved)'; try { return JSON.stringify(JSON.parse(raw), null, 2); } catch (e) { return raw; } };
  function clockLabel() {
    const off = H.E.clockOffset();
    return off ? `Fake now: ${H.E.nowDate().toLocaleString('en-US')} (${off > 0 ? '+' : '−'}${fmtDur(Math.abs(off))})` : 'Real time (no fake clock).';
  }
  function fmtDur(ms) {
    const m = Math.round(ms / 60000), d = Math.floor(m / 1440), h = Math.floor((m % 1440) / 60), mm = m % 60;
    return [d && d + 'd', h && h + 'h', (mm || (!d && !h)) && mm + 'm'].filter(Boolean).join(' ');
  }
  function localInput(d) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`; }
  function tabSave() {
    const real = readRaw(H.KEY), dev = readRaw(H.DEV_KEY), jraw = readRaw(H.JKEY);
    let jn = 0; try { jn = Object.keys(JSON.parse(jraw || '{}')).length; } catch (e) { jn = 0; }
    const ds = H.DevStore.data.streak || { current: 0, best: 0, tokens: 0, last: null };
    const yest = H.E.nowDate(); yest.setDate(yest.getDate() - 1);
    return `<div class="dev-sec">
      <h3>Fake clock</h3>
      <p class="dev-note" id="dev-clock-now">${esc(clockLabel())}</p>
      <p class="dev-note">Shifts the calendar only: puzzle number, streaks, the home date and the midnight countdown. Leg timers stay real. While it's on, the real daily climb is blocked so nothing is saved under a fake date. It resets on reload.</p>
      <div class="dev-row"><label class="sr-only" for="dev-clock-in">Fake date and time</label><input class="dev-in" type="datetime-local" id="dev-clock-in" value="${localInput(H.E.nowDate())}">${btn('clock-set', 'Set')}</div>
      <div class="dev-row">${btn('clock-add', '−1 day', { v: -86400000 })}${btn('clock-add', '+1 hour', { v: 3600000 })}${btn('clock-add', '+1 day', { v: 86400000 })}${btn('clock-midnight', '23:59:50 today')}${btn('clock-clear', 'Clear')}</div>
      <h3>Simulate a reload mid-climb</h3>
      <p class="dev-note">Re-reads the dev climb from the dev save, then forfeits it (what a real reload does) or resumes it (what an artifact hot reload does).</p>
      <div class="dev-row">${btn('reload', 'Reload → forfeit', { v: 'forfeit' })}${btn('reload', 'Reload → resume', { v: 'resume' })}</div>
      <h3>Dev save (${esc(H.DEV_KEY)})</h3>
      <p class="dev-note">Streak ${ds.current} (best ${ds.best}, rest days ${ds.tokens}, last ${esc(ds.last || 'never')}) · live streak today ${H.liveStreakOf(H.DevStore)} · ${Object.keys(H.DevStore.data.rounds || {}).length} rounds</p>
      <div class="dev-row"><label>Current <input class="dev-in" type="number" id="dev-st-cur" min="0" value="${ds.current}"></label><label>Best <input class="dev-in" type="number" id="dev-st-best" min="0" value="${ds.best}"></label>
        <label>Rest days <select class="dev-in" id="dev-st-tok"><option value="0"${ds.tokens ? '' : ' selected'}>0</option><option value="1"${ds.tokens ? ' selected' : ''}>1</option></select></label>
        <label>Last climb <input class="dev-in" type="date" id="dev-st-last" value="${esc(ds.last || H.E.localDateStr(yest))}"></label>${btn('fake-streak', 'Apply')}</div>
      <div class="dev-row"><label>Fake past rounds <input class="dev-in" type="number" id="dev-fake-n" min="1" max="90" value="10"></label>${btn('fake-rounds', 'Generate')}${btn('clear-rounds', 'Clear rounds')}</div>
      <div class="dev-row">${btn('stats-dev', 'Open Stats with the dev save', { cls: 'primary' })}${btn('record-day', 'Record a climb today')}${btn('reset-dev', 'Reset dev save')}</div>
      <details><summary>Dev save JSON</summary><pre class="dev-pre">${esc(pretty(dev))}</pre></details>
      <h3>Real save (${esc(H.KEY)})</h3>
      <p class="dev-note">Read-only view.</p>
      <div class="dev-row">${btn('save-refresh', 'Refresh')}${btn('save-copy', 'Copy')}${btn('reset-real', 'Reset real save…', { cls: 'danger' })}</div>
      <pre class="dev-pre" id="dev-real-json">${esc(pretty(real))}</pre>
      <details><summary>Answer-checker cache (${esc(H.JKEY)}): ${jn} entries</summary><pre class="dev-pre">${esc(pretty(jraw))}</pre></details>
    </div>`;
  }
  function setFake(target) {
    if (!Number.isFinite(target)) { notice('That date and time isn’t valid.'); return; }
    H.E.setClockOffset(target - Date.now());
    notice('Fake clock set.');
    clockChanged();
  }
  function clockChanged() {
    const G = H.G;
    if (G.mode === 'daily' && (G.state === 'idle' || (G.state === 'results' && G.screen === 'home'))) H.renderHome();
    if (tab === 'save') renderTab();
    live();
  }
  function applyFakeStreak() {
    const cur = Math.max(0, Math.round(Number($('#dev-st-cur').value) || 0));
    const best = Math.max(cur, Math.round(Number($('#dev-st-best').value) || 0));
    const tok = $('#dev-st-tok').value === '1' ? 1 : 0;
    const last = $('#dev-st-last').value || null;
    H.DevStore.data.streak = { current: cur, best, last, tokens: tok };
    H.DevStore.save();
    notice(`Dev streak set: ${cur} (best ${best}, rest days ${tok}, last ${last || 'never'}).`);
    renderTab();
  }
  function genRounds(n) {
    const E = H.E, C = H.C;
    const count = Math.max(1, Math.min(90, Math.round(n) || 10));
    const W = [0.45, 0.27, 0.16, 0.08, 0.04];
    const rounds = H.DevStore.data.rounds || (H.DevStore.data.rounds = {});
    let aid = 1e6;
    for (let k = 1; k <= count; k++) {
      const day = E.nowDate(); day.setDate(day.getDate() - k);
      const date = E.localDateStr(day);
      const cats = E.dailyCategories(H.DATA, 1 + ((E.dayIndex(date) % 997) + 997) % 997);
      const t0 = day.getTime();
      const legs = cats.map((c, li) => {
        const ix = E.buildIndex(c);
        const picked = new Set();
        const m = 2 + Math.floor(Math.random() * 7);
        let raw = 0, chain = 0;
        const answers = [];
        for (let a = 0; a < m; a++) {
          let x = Math.random(), tier = 0;
          for (; tier < 4; tier++) { x -= W[tier]; if (x < 0) break; }
          const pool = ix.entries.filter((e) => e.tier === tier && !picked.has(e.id));
          if (!pool.length) continue;
          const e = pool[Math.floor(Math.random() * pool.length)];
          picked.add(e.id);
          const before = E.legEffective(raw), g = E.answerGain(e.tier, chain, li);
          raw += g; chain += 1;
          answers.push({ id: ++aid, t: e.canon, n: e.norm, s: 'ok', eid: e.id, c: e.canon, tier: e.tier, k: 'seed', raw: g, g: E.legEffective(raw) - before });
        }
        const secs = C.legs[li].secs * 1000;
        return { catId: c.id, start: t0, deadline: t0 + secs, total: secs, raw, chain, invalid: 0, judged: 0, answers, eff: E.legEffective(raw), ended: t0 + secs };
      });
      rounds[date] = { v: 2, date, puzzle: E.puzzleNumber(date), catIds: cats.map((c) => c.id), startedAt: t0, extra: false, legs, completed: true,
        final: E.finalAltitude(legs.map((l) => l.raw)), finishedAt: t0 + 120000, fake: true };
    }
    H.DevStore.save();
    notice(`Generated ${count} fake rounds in the dev save, ending yesterday.`);
    renderTab();
  }
  function openResetReal() {
    let d = {};
    try { d = JSON.parse(readRaw(H.KEY) || '{}') || {}; } catch (e) { d = {}; }
    const dates = Object.keys(d.rounds || {}).sort();
    const s = d.streak || {};
    const st = d.settings || {};
    let jn = 0; try { jn = Object.keys(JSON.parse(readRaw(H.JKEY) || '{}')).length; } catch (e) { jn = 0; }
    $('#dev-confirm-body').innerHTML = `
      <p>This deletes <strong>${esc(H.KEY)}</strong> from this browser. It can't be undone. It holds:</p>
      <ul>
        <li>${dates.length} saved climb${dates.length === 1 ? '' : 's'}${dates.length ? ` (${esc(dates[0])}${dates.length > 1 ? ' to ' + esc(dates[dates.length - 1]) : ''})` : ''}</li>
        <li>Your streak: current ${s.current || 0}, best ${s.best || 0}, rest days ${s.tokens || 0}</li>
        <li>Your settings: sound ${st.sound ? 'on' : 'off'}, reduce motion ${st.reduced == null ? 'follow system' : st.reduced ? 'on' : 'off'}, extra time ${st.extra ? 'on' : 'off'}</li>
        <li>Whether the how-to-play dialog has been shown</li>
      </ul>
      <label class="setting"><div><strong>Also delete the answer-checker cache</strong><span>${esc(H.JKEY)}: ${jn} saved verdict${jn === 1 ? '' : 's'}.</span></div><input type="checkbox" class="switch" id="dev-confirm-judge"></label>`;
    const dlg = $('#dlg-dev-confirm');
    $('#dev-confirm-go').onclick = () => {
      const msg = H.resetRealSave($('#dev-confirm-judge').checked);
      try { dlg.close(); } catch (e) { dlg.removeAttribute('open'); }
      notice(msg);
      renderTab();
    };
    try { dlg.showModal(); } catch (e) { dlg.setAttribute('open', ''); }
  }

  // ---------------------------------------------------------------- performance and screenshots
  function tabPerf() {
    return `<div class="dev-sec">
      <div class="dev-row">${btn('fps', 'FPS meter', { pressed: fps.on, cls: fps.on ? 'on' : '' })}${btn('hide-ui', 'Hide UI (Alt+H)')}${btn('shot', 'Screenshot the mountain')}</div>
      <p class="dev-note">Hide UI leaves only the mountain canvas. Press Alt+H or tap the screen to bring everything back.</p>
      <h3>Shortcuts</h3>
      <dl class="dev-kv"><dt>Alt+D</dt><dd>Open or close the dev tools</dd><dt>Alt+P</dt><dd>Pause or resume a dev climb</dd><dt>Alt+H</dt><dd>Hide or show the UI</dd><dt>Alt+[ / Alt+]</dt><dd>Previous or next section</dd></dl>
    </div>`;
  }
  const fps = { on: false, raf: 0, last: 0, times: [] };
  function fpsToggle(force) {
    fps.on = force == null ? !fps.on : !!force;
    $('#dev-fps').hidden = !fps.on;
    cancelAnimationFrame(fps.raf);
    if (!fps.on) return;
    fps.last = performance.now(); fps.times = [];
    const cv = $('#dev-fps-graph'), cx = cv.getContext('2d'), txt = $('#dev-fps-text');
    let shown = 0;
    const loop = (t) => {
      const dt = t - fps.last; fps.last = t;
      fps.times.push(dt); if (fps.times.length > 120) fps.times.shift();
      if (t - shown > 250) {
        shown = t;
        const avg = fps.times.reduce((a, b) => a + b, 0) / fps.times.length;
        const max = Math.max(...fps.times);
        txt.textContent = `${Math.round(1000 / avg)} fps · ${avg.toFixed(1)} ms (max ${max.toFixed(0)})`;
      }
      cx.clearRect(0, 0, cv.width, cv.height);
      cx.fillStyle = 'rgba(255,255,255,.18)'; cx.fillRect(0, cv.height - (16.7 / 50) * cv.height, cv.width, 1);
      fps.times.forEach((v, i) => {
        const h = Math.min(cv.height, (v / 50) * cv.height);
        cx.fillStyle = v > 34 ? '#ff7468' : v > 18 ? '#f2c14e' : '#5cc985';
        cx.fillRect(i * 2, cv.height - h, 2, h);
      });
      fps.raf = requestAnimationFrame(loop);
    };
    fps.raf = requestAnimationFrame(loop);
  }
  function hideUI(on) {
    document.body.classList.toggle('dev-ui-hidden', !!on);
    if (H) H.announce(on ? 'Interface hidden. Press Alt+H or tap the screen to bring it back.' : 'Interface shown.');
  }
  function screenshot() {
    const cv = $('#scene');
    let url = '';
    // the scene canvas holds one pixel per art pixel; scale it up crisply to its on-screen size
    try {
      const k = Math.max(1, Math.round(cv.getBoundingClientRect().width * (window.devicePixelRatio || 1) / cv.width));
      const big = document.createElement('canvas'); big.width = cv.width * k; big.height = cv.height * k;
      const g = big.getContext('2d'); g.imageSmoothingEnabled = false; g.drawImage(cv, 0, 0, big.width, big.height);
      url = big.toDataURL('image/png');
    } catch (e) { notice('Couldn’t capture the canvas.'); return; }
    const d = new Date();
    const name = `daily-ascent-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}.png`;
    let framed = true;
    try { framed = window.top !== window; } catch (e) { framed = true; }
    if (!framed) {
      try {
        const a = document.createElement('a');
        a.href = url; a.download = name;
        document.body.appendChild(a); a.click(); a.remove();
        notice('Screenshot saved as ' + name + '.');
        return;
      } catch (e) { /* fall through to the dialog */ }
    }
    $('#dev-shot-img').src = url;
    const dl = $('#dev-shot-dl'); dl.href = url; dl.download = name;
    const dlg = $('#dlg-dev-shot');
    try { dlg.showModal(); } catch (e) { dlg.setAttribute('open', ''); }
    notice('Screenshot ready to save.');
  }

  // ---------------------------------------------------------------- lap banner, copy helper
  let lapT = 0;
  function showLap(n) {
    const el = $('#dev-lap');
    el.innerHTML = `Summit · Lap ${n}<small>Back to Lukla, the climb goes on</small>`;
    el.hidden = false;
    el.style.animation = 'none'; void el.offsetWidth; el.style.animation = '';
    clearTimeout(lapT);
    lapT = setTimeout(() => { el.hidden = true; }, 2400);
  }
  async function copyText(text, ok) {
    try { await navigator.clipboard.writeText(text); notice(ok); }
    catch (e) {
      const ta = document.createElement('textarea');
      ta.value = text; ta.setAttribute('readonly', ''); ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      let done = false; try { done = document.execCommand('copy'); } catch (er) { done = false; }
      ta.remove();
      notice(done ? ok : 'Copying is blocked here. Select the text and copy it manually.');
    }
  }
})();
