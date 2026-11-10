/* Daily Ascent — app: scene, audio, judge, game flow, UI. */
(function () {
  'use strict';
  const E = window.DA_ENGINE;
  const C = E.CONFIG;
  const ALL = window.DA_CATS;
  const DATA = { categories: ALL.filter((c) => c.kind !== 'practice') };
  const PRACTICE = ALL.find((c) => c.kind === 'practice');

  const $ = (s, el) => (el || document).querySelector(s);
  const fmt = (n) => Math.round(n).toLocaleString('en-US');
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const lerp = (a, b, t) => a + (b - a) * t;
  const now = () => Date.now();
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const buzz = (p) => { try { if (navigator.vibrate) navigator.vibrate(p); } catch (e) { /* unsupported */ } };

  // ===========================================================================
  // Storage (per-device, wrapped: storage can be missing or throw)
  // ===========================================================================
  const KEY = 'daily-ascent:v1';
  const JKEY = 'daily-ascent:judge:v1';
  const DEV_KEY = 'daily-ascent:dev:v1';   // dev mode's own save; never touches KEY
  const makeStore = (key) => ({
    key,
    data: {},
    load() {
      let d = null;
      try { d = JSON.parse(localStorage.getItem(key) || 'null'); } catch (e) { d = null; }
      if (!d || typeof d !== 'object') d = {};
      d.settings = Object.assign({ sound: false, reduced: null, extra: false }, d.settings);
      d.rounds = d.rounds && typeof d.rounds === 'object' ? d.rounds : {};
      d.streak = Object.assign({ current: 0, best: 0, last: null, tokens: 0 }, d.streak);
      // v1 rounds used six tiers (common…legendary); fold them onto the five ranks.
      const OLD = [0, 0, 1, 2, 3, 4];
      for (const r of Object.values(d.rounds)) {
        if (!r || r.v !== 1) continue;
        (r.legs || []).forEach((l) => l && (l.answers || []).forEach((a) => { if (typeof a.tier === 'number') a.tier = OLD[a.tier] != null ? OLD[a.tier] : 4; }));
        r.v = 2;
      }
      this.data = d;
    },
    save() { try { localStorage.setItem(key, JSON.stringify(this.data)); } catch (e) { /* private mode */ } },
    clear() { try { localStorage.removeItem(key); } catch (e) { /* blocked */ } this.load(); },
  });
  // `Store` is the active save. It is the real one except during a dev climb,
  // when it points at DevStore so nothing a dev run does reaches KEY.
  const RealStore = makeStore(KEY);
  const DevStore = makeStore(DEV_KEY);
  let Store = RealStore;

  // ===========================================================================
  // Tier icons — shape + color + label, never color alone
  // ===========================================================================
  const ICON = [
    '<svg viewBox="0 0 14 14" aria-hidden="true"><circle cx="7" cy="7" r="3.3" fill="currentColor"/></svg>',
    '<svg viewBox="0 0 14 14" aria-hidden="true" fill="currentColor"><path d="M7 .6 11.8 7H9.3l3.1 4.6H8v1.9H6v-1.9H1.6l3.1-4.6H2.2Z"/></svg>',
    '<svg viewBox="0 0 14 14" aria-hidden="true" fill="currentColor"><path d="M7 .5 13.5 7 7 13.5.5 7Z"/></svg>',
    '<svg viewBox="0 0 14 14" aria-hidden="true" fill="currentColor"><path d="M7 .2c.6 4.3 2.2 5.9 6.8 6.8C9.2 7.9 7.6 9.5 7 13.8 6.4 9.5 4.8 7.9.2 7 4.8 6.1 6.4 4.5 7 .2Z"/></svg>',
    '<svg viewBox="0 0 14 14" aria-hidden="true" fill="currentColor"><path d="M.4 13.6 5.4 4.4l2.4 4 1.5-2.2 4.3 7.4Z"/><path d="M5 4.6V.4h.9v.5l3.4 1.1-3.4 1.2v1.4Z"/></svg>',
  ];
  const tierName = (t) => C.tiers[t].name;

  // ===========================================================================
  // Sound — synthesized, off by default
  // ===========================================================================
  const Sound = {
    ctx: null, master: null, windSrc: null, windGain: null, windFilter: null, noiseBuf: null, nextGust: 0,
    force: false,   // dev mode's sound buttons play even with sound off
    get on() { return this.force || !!Store.data.settings.sound; },
    ensure() {
      if (!this.ctx) {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return null;
        try { this.ctx = new AC(); } catch (e) { return null; }
        this.master = this.ctx.createGain();
        this.master.gain.value = 0.55;
        this.master.connect(this.ctx.destination);
        const len = this.ctx.sampleRate * 2;
        this.noiseBuf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
        const ch = this.noiseBuf.getChannelData(0);
        let last = 0;
        for (let i = 0; i < len; i++) { const w = Math.random() * 2 - 1; last = (last + 0.02 * w) / 1.02; ch[i] = last * 3.2; }
      }
      if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
      return this.ctx;
    },
    tone(f, t0, dur, o) {
      const opt = Object.assign({ type: 'sine', vol: 0.15, attack: 0.006, glide: 0 }, o);
      const c = this.ctx, osc = c.createOscillator(), g = c.createGain();
      osc.type = opt.type;
      osc.frequency.setValueAtTime(f, t0);
      if (opt.glide) osc.frequency.exponentialRampToValueAtTime(opt.glide, t0 + dur);
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(opt.vol, t0 + opt.attack);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
      osc.connect(g); g.connect(this.master);
      osc.start(t0); osc.stop(t0 + dur + 0.05);
    },
    bell(f, t0, dur, vol) {
      [[1, 1], [2.76, 0.42], [5.4, 0.22], [8.93, 0.1]].forEach(([r, a]) => this.tone(f * r, t0, dur / (r * 0.5 + 0.5), { vol: vol * a, attack: 0.004 }));
    },
    hiss(t0, dur, vol, freq) {
      const c = this.ctx, s = c.createBufferSource(), f = c.createBiquadFilter(), g = c.createGain();
      s.buffer = this.noiseBuf; f.type = 'lowpass'; f.frequency.value = freq;
      g.gain.setValueAtTime(vol, t0); g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
      s.connect(f); f.connect(g); g.connect(this.master); s.start(t0); s.stop(t0 + dur + 0.05);
    },
    play(kind) {
      if (!this.on) return;
      const c = this.ensure();
      if (!c) return;
      const t = c.currentTime + 0.01;
      switch (kind) {
        case 't0': this.tone(988, t, 0.12, { vol: 0.09 }); this.tone(1319, t + 0.05, 0.1, { vol: 0.05 }); break;
        case 't1': [523, 659, 784].forEach((f, i) => this.tone(f, t + i * 0.06, 0.24, { vol: 0.1, type: 'triangle' })); break;
        case 't2': [784, 988, 1175, 1568].forEach((f, i) => this.bell(f, t + i * 0.06, 0.9, 0.08)); break;
        case 't3': // Mountaineer: low thump, rising bell arpeggio, sparkle on top
          this.tone(110, t, 0.35, { vol: 0.18, glide: 55 });
          [587, 740, 880, 1175, 1480].forEach((f, i) => this.bell(f, t + 0.05 + i * 0.07, 1.4, 0.08));
          [2349, 2960].forEach((f, i) => this.bell(f, t + 0.45 + i * 0.08, 1.2, 0.04)); break;
        case 't4': // Sherpa: singing bowl, brass-ish fanfare chord, shimmer
          this.tone(82, t, 0.5, { vol: 0.22, glide: 41 }); this.hiss(t, 0.5, 0.05, 3000);
          this.bell(196, t, 4.6, 0.22); this.bell(293.7, t + 0.04, 4, 0.12);
          [392, 494, 587, 784].forEach((f, i) => this.tone(f, t + 0.12 + i * 0.08, 0.5, { vol: 0.07, type: 'sawtooth', attack: 0.02 }));
          [523, 659, 784, 1047].forEach((f) => this.tone(f, t + 0.5, 2.2, { vol: 0.05, type: 'triangle', attack: 0.06 }));
          [1568, 1976, 2349, 3136].forEach((f, i) => this.bell(f, t + 0.7 + i * 0.09, 1.6, 0.04)); break;
        case 'bad': this.tone(150, t, 0.22, { vol: 0.22, glide: 60 }); this.hiss(t, 0.12, 0.08, 900); break;
        case 'dup': this.tone(440, t, 0.1, { vol: 0.06 }); break;
        case 'tick': this.tone(1320, t, 0.04, { vol: 0.05, type: 'square' }); break;
        case 'count': this.tone(660, t, 0.12, { vol: 0.09 }); break;
        case 'go': this.tone(587, t, 0.14, { vol: 0.09 }); this.tone(880, t + 0.11, 0.3, { vol: 0.11 }); break;
        case 'end': this.bell(330, t, 1.6, 0.1); break;
        // alpaca ride
        case 'hooves': // clip-clop gallop
          for (let i = 0; i < 12; i++) { const tt = t + i * 0.13 + (i % 2 ? 0.05 : 0); this.tone(i % 2 ? 180 : 230, tt, 0.05, { vol: 0.08, type: 'triangle', attack: 0.002 }); this.hiss(tt, 0.03, 0.05, 2600); }
          break;
        case 'alpaca': // a hum, then a "mwaa"
          this.tone(330, t, 0.45, { vol: 0.06, type: 'triangle', attack: 0.05, glide: 290 });
          this.tone(520, t + 0.45, 0.35, { vol: 0.05, type: 'sawtooth', attack: 0.03, glide: 400 }); break;
        case 'golden': // bright fanfare for the golden alpaca
          [784, 988, 1175, 1568, 1976].forEach((f, i) => this.bell(f, t + i * 0.07, 1.4, 0.07));
          [523, 659, 784].forEach((f) => this.tone(f, t + 0.35, 1.2, { vol: 0.06, type: 'triangle', attack: 0.04 })); break;
        case 'splat': this.hiss(t, 0.25, 0.12, 1200); this.tone(120, t, 0.16, { vol: 0.12, glide: 60 }); break;
        default: break;
      }
    },
    wind(alt, active) {
      if (!this.ctx) { if (!this.on || !active) return; if (!this.ensure()) return; }
      const c = this.ctx;
      if (!this.windSrc) {
        this.windSrc = c.createBufferSource(); this.windSrc.buffer = this.noiseBuf; this.windSrc.loop = true;
        this.windFilter = c.createBiquadFilter(); this.windFilter.type = 'bandpass'; this.windFilter.Q.value = 0.7;
        this.windGain = c.createGain(); this.windGain.gain.value = 0;
        this.windSrc.connect(this.windFilter); this.windFilter.connect(this.windGain); this.windGain.connect(this.master);
        this.windSrc.start();
      }
      const frac = clamp((alt - C.startAlt) / (C.summitAlt - C.startAlt), 0, 1);
      const t = c.currentTime;
      let target = this.on && active ? 0.03 + 0.09 * frac : 0;
      if (target && t > this.nextGust) { this.nextGust = t + 1.5 + Math.random() * 3; target *= 1.4 + Math.random() * 0.6; }
      this.windGain.gain.setTargetAtTime(target, t, 0.9);
      this.windFilter.frequency.setTargetAtTime(260 + 900 * frac + Math.random() * 200, t, 1.2);
    },
  };

  // ===========================================================================
  // Scene — the mountain, drawn on canvas each frame
  // ===========================================================================
  const Scene = (() => {
    const cv = $('#scene');
    const ctx = cv.getContext('2d');
    let W = 0, H = 0, DPR = 1;
    const cam = { p: 0.5, alt: 5800, sx: 400, sy: 0.1 };
    const tgt = { p: 0.5, alt: 5800, sx: 400, sy: 0.1 };
    let view = 'overview', rect = null, snap = true;
    let climb = C.startAlt, climbTarget = C.startAlt, ghost = null;
    let moving = false, cheerUntil = 0, reduced = false, time = 0, last = performance.now();
    let onFrame = null, skyOverride = null;
    const bursts = [], confetti = [], flakes = [], streaks = [];

    // --- ground profile: monotone cubic through (p, altitude) points -------
    const CP = [[-0.12, 2050], [-0.04, 2300], [0, 2450], [0.04, 2760], [0.06, 2850], [0.07, 2860], [0.085, 2880], [0.11, 2960], [0.15, 3200], [0.185, 3410], [0.2, 3440], [0.215, 3460], [0.25, 3650], [0.29, 3860], [0.3, 3867], [0.34, 4150], [0.39, 4410], [0.44, 4700], [0.48, 4940], [0.52, 5250], [0.54, 5364], [0.556, 5380], [0.585, 5650], [0.61, 5950], [0.625, 6065], [0.65, 6250], [0.667, 6400], [0.69, 6650], [0.72, 7000], [0.735, 7160], [0.765, 7600], [0.78, 7800], [0.795, 7950], [0.802, 8000], [0.82, 8300], [0.832, 8450], [0.85, 8749], [0.858, 8790], [0.868, 8849], [0.874, 8805], [0.885, 8650], [0.91, 8000], [0.95, 6800], [1.0, 5600], [1.06, 4900], [1.15, 4300], [1.3, 3800], [1.5, 3500]];
    const xs = CP.map((c) => c[0]), ys = CP.map((c) => c[1]), N = xs.length;
    const dd = [], mm = new Array(N);
    for (let i = 0; i < N - 1; i++) dd[i] = (ys[i + 1] - ys[i]) / (xs[i + 1] - xs[i]);
    mm[0] = dd[0]; mm[N - 1] = dd[N - 2];
    for (let i = 1; i < N - 1; i++) {
      if (dd[i - 1] * dd[i] <= 0) mm[i] = 0;
      else {
        const h0 = xs[i] - xs[i - 1], h1 = xs[i + 1] - xs[i];
        const w1 = 2 * h1 + h0, w2 = h1 + 2 * h0;
        mm[i] = (w1 + w2) / (w1 / dd[i - 1] + w2 / dd[i]);
      }
    }
    function smooth(p) {
      if (p <= xs[0]) return ys[0] + dd[0] * (p - xs[0]);
      if (p >= xs[N - 1]) return ys[N - 1] + dd[N - 2] * (p - xs[N - 1]);
      let lo = 0, hi = N - 1;
      while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (xs[mid] <= p) lo = mid; else hi = mid; }
      const h = xs[hi] - xs[lo], t = (p - xs[lo]) / h, t2 = t * t, t3 = t2 * t;
      return (2 * t3 - 3 * t2 + 1) * ys[lo] + (t3 - 2 * t2 + t) * h * mm[lo] + (-2 * t3 + 3 * t2) * ys[hi] + (t3 - t2) * h * mm[hi];
    }
    const SHELVES = [0.075, 0.205, 0.3, 0.548, 0.625, 0.667, 0.735, 0.796, 0.868];
    function rough(p) {
      const a = smooth(p);
      let amp = 7 + clamp((a - 3600) / 2400, 0, 1) * 30 + clamp((a - 6800) / 1500, 0, 1) * 18;
      for (const s of SHELVES) { const d = Math.abs(p - s); if (d < 0.013) amp *= 0.15 + 0.85 * (d / 0.013); }
      const v = Math.sin(p * 190 + 1.3) * 0.5 + Math.sin(p * 433 + 0.7) * 0.3 + Math.abs(Math.sin(p * 917 + 2.1)) * 0.36 - 0.18 + Math.sin(p * 2011 + 0.4) * 0.08;
      return amp * v;
    }
    const ground = (p) => smooth(p) + rough(p);
    const P0 = 0.07, PS = 0.868;
    function pFor(alt) {
      let lo = P0, hi = PS;
      if (alt <= smooth(lo)) return lo;
      if (alt >= smooth(hi)) return hi;
      for (let i = 0; i < 40; i++) { const mid = (lo + hi) / 2; if (smooth(mid) < alt) lo = mid; else hi = mid; }
      return (lo + hi) / 2;
    }
    const X = (p) => W / 2 + (p - cam.p) * cam.sx;
    const Y = (a) => H / 2 - (a - cam.alt) * cam.sy;

    // --- color helpers ------------------------------------------------------
    const hex = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
    const mixc = (a, b, t) => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
    const css = (c, al) => al == null ? `rgb(${c[0] | 0},${c[1] | 0},${c[2] | 0})` : `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${al})`;
    let AMB = [1, 1, 1], HAZE = [200, 220, 240];
    const tint = (c) => [c[0] * AMB[0], c[1] * AMB[1], c[2] * AMB[2]];

    const SKY = [
      [2860, '#3b4c8c', '#f3a88a', [1.0, 0.87, 0.84], 0],
      [3900, '#4a79c4', '#f6d3b8', [1.0, 0.95, 0.92], 0],
      [5000, '#3f86d6', '#c6e3f6', [1, 1, 1], 0],
      [6300, '#2e6fc6', '#aad5f3', [1, 1, 1], 0],
      [7300, '#4b5e9e', '#f1b56c', [1.0, 0.88, 0.72], 0],
      [8000, '#1f2657', '#c36b6e', [0.72, 0.64, 0.8], 0.35],
      [8500, '#0b1030', '#3b3a72', [0.48, 0.5, 0.72], 0.8],
      [8849, '#050818', '#22285a', [0.4, 0.44, 0.68], 1],
    ].map((k) => [k[0], hex(k[1]), hex(k[2]), k[3], k[4]]);
    function skyAt(a) {
      let i = 0;
      while (i < SKY.length - 2 && a > SKY[i + 1][0]) i++;
      const A = SKY[i], B = SKY[i + 1];
      const t = clamp((a - A[0]) / (B[0] - A[0]), 0, 1);
      return { top: mixc(A[1], B[1], t), bot: mixc(A[2], B[2], t), amb: mixc(A[3], B[3], t), star: lerp(A[4], B[4], t) };
    }
    const TERRAIN = [[9300, '#f7fafd'], [7000, '#eef3f9'], [5600, '#e0e8f1'], [5320, '#cbd6e2'], [5180, '#8f877d'], [4600, '#7c746a'], [4250, '#88845d'], [3950, '#6c8d52'], [3500, '#4e7e45'], [3000, '#497941'], [2500, '#5a934f'], [1500, '#5a934f']].map((k) => [k[0], hex(k[1])]);

    // --- seeded decorations ---------------------------------------------------
    const R = E.rng(2026);
    const TREES = [];
    for (let i = 0; i < 170; i++) { const p = 0.0 + R() * 0.31; TREES.push({ p, d: Math.pow(R(), 1.6) * 46, h: 9 + R() * 8, c: R() < 0.5 ? '#2c5a33' : '#386b3b' }); }
    TREES.sort((a, b) => a.d - b.d);
    const HOUSES = [];
    for (let i = 0; i < 14; i++) HOUSES.push({ p: 0.19 + R() * 0.028, d: 4 + R() * 26, roof: ['#2f6db5', '#3c8a4d', '#b5432f', '#2f6db5', '#d08a1a', '#3c8a4d'][i % 6], w: 8 + R() * 4 });
    HOUSES.sort((a, b) => a.d - b.d);
    const TENT = ['#f2b81f', '#ef7a1a', '#f2b81f', '#d94f2a', '#3d6fc0', '#f2b81f'];
    function tents(p0, p1, n, seed) { const r = E.rng(seed), out = []; for (let i = 0; i < n; i++) out.push({ p: p0 + r() * (p1 - p0), d: r() * 10, c: TENT[(i + seed) % TENT.length], w: 7 + r() * 3 }); return out.sort((a, b) => a.d - b.d); }
    const CAMPS = [tents(0.534, 0.561, 18, 11), tents(0.62, 0.63, 5, 12), tents(0.661, 0.673, 7, 13), tents(0.731, 0.739, 3, 14), tents(0.79, 0.8, 6, 15)];
    const SERACS = [];
    for (let i = 0; i < 26; i++) SERACS.push({ p: 0.562 + R() * 0.046, d: R() * 14, w: 5 + R() * 9, h: 6 + R() * 10, rot: (R() - 0.5) * 0.7, c: ['#e8f4fc', '#cbe6f6', '#b4d9f0'][i % 3] });
    const STARS = [];
    for (let i = 0; i < 170; i++) STARS.push({ x: R(), y: Math.pow(R(), 1.3) * 0.75, r: 0.4 + R() * 1.2, ph: R() * 6.28, sp: 0.6 + R() * 2 });
    const CLOUDS = [];
    for (let i = 0; i < 18; i++) CLOUDS.push({ u: -0.4 + R() * 2.2, a: 4350 + R() * 420, w: 70 + R() * 110, h: 16 + R() * 18 });

    const FAR = [[-0.35, 8188, 0.09], [-0.05, 7200, 0.06], [0.16, 6623, 0.045], [0.28, 6782, 0.05], [0.44, 6812, 0.028], [0.6, 7161, 0.05], [0.76, 7861, 0.07], [0.97, 8516, 0.075], [1.22, 7400, 0.06], [1.45, 8485, 0.08], [1.75, 7000, 0.07], [2.0, 8586, 0.09]];
    function farAlt(u) {
      let a = 5150 + 420 * Math.sin(u * 9.1 + 0.4) + 240 * Math.sin(u * 23 + 1.1) + 70 * Math.sin(u * 140);
      for (const [c, h, w] of FAR) { const pk = h - (Math.abs(u - c) / w) * (h - 5150) * 0.9 + 40 * Math.sin(u * 300); if (pk > a) a = pk; }
      return a;
    }
    const MID = [[0.08, 5200, 0.06], [0.33, 5650, 0.07], [0.58, 5050, 0.06], [0.88, 5900, 0.08], [1.18, 5350, 0.07], [1.5, 5600, 0.08]];
    function midAlt(u) {
      let a = 3650 + 480 * Math.sin(u * 7.3) + 260 * Math.sin(u * 19 + 2) + 60 * Math.sin(u * 95 + 1);
      for (const [c, h, w] of MID) { const pk = h - (Math.abs(u - c) / w) * (h - 3700) * 0.85; if (pk > a) a = pk; }
      return a;
    }

    // --- view framing ----------------------------------------------------------
    function computeTarget() {
      if (view === 'ride') {
        // tighter than follow, with the climber in the upper part of what's visible
        // (above the leg card and, on phones, the keyboard)
        const range = clamp(H * 1.15, 800, 1300);
        tgt.sy = H / range;
        const wp = clamp(0.3 * (W / H) / 0.462, 0.24, 0.6) * 0.45;
        tgt.sx = W / wp;
        const vv = window.visualViewport;
        const vh = vv && vv.height > 100 ? Math.min(H, vv.height) : H;
        tgt.p = pFor(climbTarget) + (0.5 - 0.42) * W / tgt.sx;
        tgt.alt = climbTarget - (H / 2 - 0.6 * vh) / tgt.sy;
        return;
      }
      if (view === 'follow' || view === 'peek') {
        const range = clamp(H * 1.8, 1350, 2100);
        tgt.sy = H / range;
        const wp = clamp(0.3 * (W / H) / 0.462, 0.24, 0.6);
        tgt.sx = W / wp;
        tgt.p = pFor(climbTarget) + 0.02 * wp;
        tgt.alt = climbTarget + 0.22 * range + (view === 'peek' ? 0.3 * range : 0);
      } else {
        const r = rect || { x0: 0, y0: 0, x1: W, y1: H };
        const rw = Math.max(80, r.x1 - r.x0), rh = Math.max(80, r.y1 - r.y0);
        const pLo = -0.02, pHi = 1.04, aLo = 2350, aHi = 9150;
        const mw = Math.min(rw, rh * 1.3);
        tgt.sx = mw / (pHi - pLo);
        tgt.sy = rh / (aHi - aLo);
        const cx = (r.x0 + r.x1) / 2, cy = (r.y0 + r.y1) / 2;
        tgt.p = (pLo + pHi) / 2 - (cx - W / 2) / tgt.sx;
        tgt.alt = (aLo + aHi) / 2 - (H / 2 - cy) / tgt.sy;
      }
    }

    function resize() {
      DPR = Math.min(2, window.devicePixelRatio || 1);
      W = window.innerWidth; H = window.innerHeight;
      cv.width = Math.round(W * DPR); cv.height = Math.round(H * DPR);
      ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
      computeTarget();
    }

    // --- drawing helpers ----------------------------------------------------------
    function rr(x, y, w, h, r) {
      ctx.beginPath();
      ctx.moveTo(x + r, y); ctx.lineTo(x + w - r, y); ctx.quadraticCurveTo(x + w, y, x + w, y + r);
      ctx.lineTo(x + w, y + h - r); ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
      ctx.lineTo(x + r, y + h); ctx.quadraticCurveTo(x, y + h, x, y + h - r);
      ctx.lineTo(x, y + r); ctx.quadraticCurveTo(x, y, x + r, y); ctx.closePath();
    }
    function range(fn, fx, fy, base, haze, snowLine, shade) {
      const yOf = (a) => H / 2 - (a - cam.alt) * cam.sy * fy;
      const rp = [];
      const par = cam.sx * fx, hs = Math.max(par, 20000 * cam.sy * fy);
      for (let x = -4; x <= W + 8; x += 4) { const u = (cam.p * par + x - W / 2) / hs; rp.push([x, yOf(fn(u))]); }
      ctx.beginPath(); ctx.moveTo(-4, H + 4);
      for (const q of rp) ctx.lineTo(q[0], q[1]);
      ctx.lineTo(W + 8, H + 4); ctx.closePath();
      const g = ctx.createLinearGradient(0, yOf(8800), 0, yOf(3000));
      const snow = mixc(tint([244, 248, 252]), HAZE, haze), rock = mixc(tint(base), HAZE, haze * 0.85);
      const s1 = clamp((8800 - snowLine - 150) / 5800, 0, 1), s2 = clamp((8800 - snowLine + 150) / 5800, 0, 1);
      g.addColorStop(0, css(snow)); g.addColorStop(s1, css(snow)); g.addColorStop(s2, css(rock));
      g.addColorStop(1, css(mixc(rock, HAZE, 0.35)));
      ctx.fillStyle = g; ctx.fill();
      // shadow faces: every stretch of ridge that falls away to the right is in shade
      ctx.save(); ctx.clip();
      ctx.beginPath();
      // one polygon per continuous shaded run (gaps of a sample or two are bridged)
      const depth = Math.max(60, H * (fy > 0.25 ? 0.16 : 0.22));
      const n = rp.length - 1, sh = new Array(n);
      for (let i = 0; i < n; i++) { const lo = rp[Math.max(0, i - 3)], hi = rp[Math.min(n, i + 4)]; sh[i] = hi[1] - lo[1] > 2.5; }
      for (let i = 1; i < n - 2; i++) if (!sh[i] && sh[i - 1] && (sh[i + 1] || sh[i + 2])) sh[i] = true;
      for (let i = 0; i < n; i++) {
        if (!sh[i]) continue;
        let j = i; while (j + 1 < n && sh[j + 1]) j++;
        // the shadow hugs the ridge, as deep as the face falls, so it ends in a slant, not a column
        const drop = rp[j + 1][1] - rp[i][1];
        if (j - i >= 4 && drop > 12) {
          const dp = Math.min(depth, drop * 1.6);
          for (let k = i; k <= j + 1; k++) k === i ? ctx.moveTo(rp[k][0], rp[k][1]) : ctx.lineTo(rp[k][0], rp[k][1]);
          for (let k = j + 1; k >= i; k--) ctx.lineTo(rp[k][0] - dp * 0.35, rp[k][1] + dp);
          ctx.closePath();
        }
        i = j;
      }
      ctx.fillStyle = css(mixc(tint([38, 50, 104]), HAZE, haze * 0.6), shade);
      ctx.fill();
      // aerial perspective: the foot of each range dissolves into haze
      const hg = ctx.createLinearGradient(0, yOf(5200), 0, yOf(3300));
      hg.addColorStop(0, css(HAZE, 0)); hg.addColorStop(1, css(HAZE, 0.55));
      ctx.fillStyle = hg; ctx.fillRect(-4, yOf(5200), W + 12, H);
      ctx.restore();
    }
    function plate(x, y, title, sub, opts) {
      const o = Object.assign({ align: 'left', small: false, accent: false }, opts);
      const fs = o.small ? 11 : 12.5;
      const fT = `700 ${fs}px "Atkinson Hyperlegible", system-ui, sans-serif`, fS = `400 ${fs}px "Atkinson Hyperlegible", system-ui, sans-serif`;
      ctx.font = fT; const tw = ctx.measureText(title).width;
      ctx.font = fS; const sw = sub ? ctx.measureText(sub).width + 6 : 0;
      const pw = tw + sw + 14, ph = fs + 10;
      let px = o.align === 'right' ? x - pw : o.align === 'center' ? x - pw / 2 : x;
      px = clamp(px, 4, W - pw - 4);
      ctx.fillStyle = o.accent ? '#ff5a1f' : 'rgba(20,28,52,0.82)';
      rr(px, y - ph / 2, pw, ph, 3); ctx.fill();
      ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
      ctx.font = fT; ctx.fillStyle = '#fff'; ctx.fillText(title, px + 7, y + 0.5);
      if (sub) { ctx.font = fS; ctx.fillStyle = o.accent ? 'rgba(255,255,255,0.85)' : 'rgba(255,255,255,0.66)'; ctx.fillText(sub, px + 7 + tw + 6, y + 0.5); }
      return { x: px, w: pw, h: ph };
    }
    function flags(x1, y1, x2, y2, s, n) {
      const cols = ['#2f6fd0', '#f4f2ea', '#d8382b', '#2f9b4a', '#f2c230'];
      ctx.strokeStyle = 'rgba(40,40,40,0.55)'; ctx.lineWidth = 0.8;
      ctx.beginPath();
      const sag = 6 * s;
      for (let i = 0; i <= 20; i++) { const t = i / 20; const x = lerp(x1, x2, t), y = lerp(y1, y2, t) + Math.sin(t * Math.PI) * sag; i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); }
      ctx.stroke();
      for (let i = 1; i < n; i++) {
        const t = i / n; const x = lerp(x1, x2, t), y = lerp(y1, y2, t) + Math.sin(t * Math.PI) * sag;
        const fl = reduced ? 0 : Math.sin(time * 6 + i * 1.7) * 1.2 * s;
        ctx.fillStyle = cols[i % 5];
        ctx.fillRect(x - 2 * s, y, 4 * s, 5 * s + fl);
      }
    }
    // o (alpaca ride): flail (arms waving), thumbs (thumbs-up), hatless, sit (riding)
    function climber(x, y, s, t, o) {
      const op = o || {};
      const walk = moving && !reduced && !op.sit ? Math.sin(t * 10) : 0;
      const cheer = time < cheerUntil && !op.flail && !op.thumbs;
      ctx.save(); ctx.translate(x, y); ctx.scale(s, s);
      ctx.fillStyle = 'rgba(0,0,0,0.2)'; ctx.beginPath(); ctx.ellipse(0, 0, 7, 1.8, 0, 0, Math.PI * 2); ctx.fill();
      ctx.lineCap = 'round';
      ctx.strokeStyle = '#262b40'; ctx.lineWidth = 2.8;
      ctx.beginPath();
      if (op.sit) { ctx.moveTo(-0.5, -9); ctx.lineTo(5, -6); ctx.lineTo(5.5, -1.5); ctx.moveTo(1.8, -9); ctx.lineTo(7, -6.5); ctx.lineTo(7.5, -2); }
      else { ctx.moveTo(-0.5, -9); ctx.lineTo(-0.5 - walk * 3, -0.5); ctx.moveTo(1.8, -9); ctx.lineTo(1.8 + walk * 3, -0.5); }
      ctx.stroke();
      ctx.fillStyle = '#2b4a9c'; rr(-7, -20, 5.2, 9.5, 1.6); ctx.fill();
      ctx.fillStyle = '#ff6a1a'; rr(-3, -21, 7.6, 12.5, 3); ctx.fill();
      ctx.strokeStyle = '#ff6a1a'; ctx.lineWidth = 2.4;
      ctx.beginPath();
      if (op.flail) {
        const a = Math.sin(time * 24) * 4, b = Math.cos(time * 21) * 4;
        ctx.moveTo(-1, -18.5); ctx.lineTo(-6 + a, -26 + b * 0.5); ctx.moveTo(3.5, -18.5); ctx.lineTo(8 - b, -26 + a * 0.5);
      } else if (op.thumbs) { ctx.moveTo(3.5, -18.5); ctx.lineTo(7.5, -26); }
      else if (cheer) { ctx.moveTo(-1, -18.5); ctx.lineTo(-4.5, -27); ctx.moveTo(3.5, -18.5); ctx.lineTo(7, -27); }
      else { ctx.moveTo(3, -18); ctx.lineTo(6 + walk * 1.5, -12); }
      ctx.stroke();
      if (op.thumbs) { ctx.fillStyle = '#f1c39a'; ctx.beginPath(); ctx.arc(7.8, -27, 1.6, 0, Math.PI * 2); ctx.fill(); ctx.fillRect(7.1, -30.5, 1.4, 3); }
      if (!cheer && !op.flail && !op.thumbs && !op.sit) { ctx.strokeStyle = '#cfd5df'; ctx.lineWidth = 1.2; ctx.beginPath(); ctx.moveTo(6 + walk * 1.5, -13); ctx.lineTo(8.5 + walk * 2, 0); ctx.stroke(); }
      ctx.fillStyle = '#f1c39a'; ctx.beginPath(); ctx.arc(1.2, -24.2, 3.6, 0, Math.PI * 2); ctx.fill();
      if (!op.hatless) {
        ctx.fillStyle = '#ffd23f'; ctx.beginPath(); ctx.arc(1.2, -24.6, 3.8, Math.PI, 0); ctx.fill();
        ctx.fillStyle = '#1c2233'; ctx.fillRect(1.6, -24.6, 3.6, 1.6);
      }
      if (climb >= C.summitAlt - 1) {
        ctx.strokeStyle = '#3a3a3a'; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(-9, 0); ctx.lineTo(-9, -30); ctx.stroke();
        ctx.fillStyle = '#ff6a1a'; ctx.beginPath(); ctx.moveTo(-9, -30); ctx.lineTo(-1, -27); ctx.lineTo(-9, -24); ctx.fill();
      }
      ctx.restore();
    }

    // --- alpaca ride (§8.6) ---------------------------------------------------------
    // After a Sherpa spotlight, a herd carries the climber up by the meters earned.
    // The plan (style, band, rare variants, timing) comes from E.ridePlan(); this
    // only draws it. The timeline runs on u = elapsed / duration:
    //   enter 0–.18 · scoop .18–.26 · gallop .26–.78 · drop .78–.86 · exit .86–1
    const AL = {   // alpaca coats (canvas constants, CLAUDE.md §4.13)
      coats: [[243, 230, 207], [217, 180, 138], [154, 107, 69], [251, 247, 239], [226, 200, 160], [186, 140, 98]],
      gold: [242, 194, 48], dark: [58, 44, 34], mask: [120, 150, 190], tank: [96, 112, 140],
      banner: [243, 246, 249], ink: [23, 32, 58], plate: [23, 32, 58], splat: [226, 236, 206],
    };
    const PUFF = { grass: [176, 150, 112], trail: [150, 146, 140], glacier: [250, 252, 255], deathzone: [236, 240, 250] };
    const puffs = [];
    for (let i = 0; i < 48; i++) puffs.push({ on: false, x: 0, y: 0, vx: 0, vy: 0, r: 0, life: 0, max: 1 });
    let ride = null;          // the running ride, or null
    let splat = null;         // { x, y, t, r } screen-space spit, outlives the ride a little
    const easeIO = (k) => (k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2);
    const seg = (u, a, b) => clamp((u - a) / (b - a), 0, 1);
    const groundY = (x) => Y(ground(cam.p + (x - W / 2) / cam.sx));
    function slopeAt(x) { const a = groundY(x - 6), b = groundY(x + 6); return Math.atan2(b - a, 12); }
    function puff(x, y, s, band) {
      for (const p of puffs) {
        if (p.on) continue;
        p.on = true; p.x = x; p.y = y; p.vx = -20 - Math.random() * 40; p.vy = -8 - Math.random() * 18;
        p.r = (2 + Math.random() * 3) * s; p.life = 0; p.max = 0.45 + Math.random() * 0.3; p.c = PUFF[band] || PUFF.trail;
        return;
      }
    }
    // One alpaca, facing right, feet at (x, y). o: coat, gold, phase, tucked, mask,
    // lamp, sad, shrug, head (neck tilt), map, sign.
    function alpaca(x, y, s, o) {
      ctx.save(); ctx.translate(x, y); ctx.rotate(o.tilt || 0); ctx.scale(s, s);
      const col = o.gold ? AL.gold : o.coat;
      const body = css(tint(col)), shade = css(tint(mixc(col, AL.dark, 0.22))), deep = css(tint(mixc(col, AL.dark, 0.55)));
      const ph = o.phase || 0, tucked = !!o.tucked;
      // legs
      if (!tucked) {
        ctx.strokeStyle = shade; ctx.lineWidth = 2.2; ctx.lineCap = 'round';
        ctx.beginPath();
        for (let i = 0; i < 4; i++) {
          const lx = i < 2 ? -6 + i * 3 : 4 + (i - 2) * 3;
          const sw = Math.sin(ph + (i % 2 ? Math.PI : 0) + (i > 1 ? 0.6 : 0)) * 3;
          ctx.moveTo(lx, -9); ctx.lineTo(lx + sw * 0.6, -4.5); ctx.lineTo(lx + sw, 0);
        }
        ctx.stroke();
      } else {   // belly-sledding: legs tucked forward, a little snow at the belly
        ctx.fillStyle = 'rgba(255,255,255,0.8)'; ctx.beginPath(); ctx.ellipse(-2, -1, 12, 1.6, 0, 0, Math.PI * 2); ctx.fill();
      }
      const by = tucked ? -6 : -12;
      // body: overlapping fluff
      ctx.fillStyle = body;
      ctx.beginPath(); ctx.ellipse(0, by, 11, 6.2, 0, 0, Math.PI * 2); ctx.fill();
      for (let i = -2; i <= 2; i++) { ctx.beginPath(); ctx.arc(i * 4.2, by - 5 + (i % 2 ? 0.8 : 0), 3.2, 0, Math.PI * 2); ctx.fill(); }
      ctx.beginPath(); ctx.arc(-11, by - 1, 2.6, 0, Math.PI * 2); ctx.fill();   // tail puff
      ctx.fillStyle = shade; ctx.beginPath(); ctx.ellipse(0, by + 3.2, 9, 2.4, 0, 0, Math.PI); ctx.fill();
      // saddle sign: ALPACA EXPRESS plate and a tiny prayer flag on the lead alpaca
      if (o.sign) {
        ctx.fillStyle = css(AL.plate); rr(-7.5, by - 1.8, 15, 5.2, 1); ctx.fill();
        ctx.fillStyle = '#ffffff'; ctx.font = '700 3.1px "Big Shoulders Stencil Display", "Big Shoulders Display", sans-serif';
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText('ALPACA EXPRESS', 0, by + 0.8);
        ctx.strokeStyle = '#3a3a3a'; ctx.lineWidth = 0.6; ctx.beginPath(); ctx.moveTo(-8, by - 5); ctx.lineTo(-8, by - 15); ctx.stroke();
        const fc = ['#2f6fd0', '#f4f2ea', '#d8382b', '#2f9b4a', '#f2c230'];
        for (let i = 0; i < 5; i++) { ctx.fillStyle = fc[i]; ctx.fillRect(-7.6 + i * 1.9, by - 15 + Math.sin(time * 7 + i) * 0.4, 1.7, 2.4); }
      }
      // neck and head
      const hd = o.sad ? 0.9 : o.shrug ? 0.25 : (o.head || 0);
      ctx.save(); ctx.translate(7.5, by - 3); ctx.rotate(hd);
      ctx.fillStyle = body; rr(-2.6, -13, 5.2, 14, 2.4); ctx.fill();
      ctx.beginPath(); ctx.ellipse(1.5, -14, 4.4, 3.1, 0, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = shade; ctx.beginPath(); ctx.ellipse(5, -13.2, 1.8, 1.5, 0, 0, Math.PI * 2); ctx.fill();
      // banana ears
      ctx.fillStyle = deep;
      ctx.beginPath(); ctx.ellipse(-1, -18.3, 0.9, 2.6, -0.25 - (o.shrug ? 0.5 : 0), 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.ellipse(1.4, -18.6, 0.9, 2.6, 0.18 + (o.shrug ? 0.5 : 0), 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#1c1c22'; ctx.beginPath(); ctx.arc(2.3, -14.8, 0.75, 0, Math.PI * 2); ctx.fill();
      if (o.sad) { ctx.strokeStyle = '#1c1c22'; ctx.lineWidth = 0.6; ctx.beginPath(); ctx.moveTo(1.2, -16.3); ctx.lineTo(3.2, -15.6); ctx.stroke(); }
      if (o.mask) {   // Death Zone: a tiny oxygen mask with a tube back to a tank
        ctx.fillStyle = css(tint(AL.mask)); ctx.beginPath(); ctx.ellipse(5.2, -12.9, 2.3, 2, 0, 0, Math.PI * 2); ctx.fill();
        ctx.strokeStyle = css(tint(AL.tank)); ctx.lineWidth = 0.8; ctx.beginPath(); ctx.moveTo(4.5, -11); ctx.quadraticCurveTo(0, -4, -4, 1); ctx.stroke();
      }
      if (o.lamp) {   // night: headlamp and a soft beam
        ctx.fillStyle = 'rgba(255,240,180,0.18)'; ctx.beginPath(); ctx.moveTo(3, -16.5); ctx.lineTo(28, -24); ctx.lineTo(28, -8); ctx.closePath(); ctx.fill();
        ctx.fillStyle = '#fff6c8'; ctx.beginPath(); ctx.arc(2.8, -16.6, 1.1, 0, Math.PI * 2); ctx.fill();
      }
      ctx.restore();
      if (o.mask) { ctx.fillStyle = css(tint(AL.tank)); rr(-6, by - 9, 5, 3, 1.2); ctx.fill(); }
      if (o.map) {    // short hop: a tiny map held up
        ctx.fillStyle = '#f7efd8'; ctx.fillRect(9, by - 22, 8, 6);
        ctx.strokeStyle = '#b4542c'; ctx.lineWidth = 0.5; ctx.beginPath(); ctx.moveTo(10, by - 20); ctx.lineTo(13, by - 18); ctx.lineTo(16, by - 21); ctx.stroke();
      }
      if (o.gold && !reduced) {   // shimmer
        for (let i = 0; i < 4; i++) {
          const a = time * 3 + i * 1.6, r = 13 + Math.sin(time * 5 + i) * 2;
          const sx = Math.cos(a) * r, sy = by - 4 + Math.sin(a) * r * 0.7, k = 1.2 + Math.sin(time * 9 + i) * 0.8;
          ctx.fillStyle = 'rgba(255,240,170,0.95)';
          ctx.beginPath(); ctx.moveTo(sx, sy - 2.4 * k); ctx.lineTo(sx + 0.6, sy - 0.6); ctx.lineTo(sx + 2.4 * k, sy); ctx.lineTo(sx + 0.6, sy + 0.6);
          ctx.lineTo(sx, sy + 2.4 * k); ctx.lineTo(sx - 0.6, sy + 0.6); ctx.lineTo(sx - 2.4 * k, sy); ctx.lineTo(sx - 0.6, sy - 0.6); ctx.fill();
        }
      }
      ctx.restore();
    }
    function hat(x, y, s, rot) {
      ctx.save(); ctx.translate(x, y); ctx.rotate(rot); ctx.scale(s, s);
      ctx.fillStyle = '#ffd23f'; ctx.beginPath(); ctx.arc(0, 0, 3.8, Math.PI, 0); ctx.fill();
      ctx.fillStyle = '#1c2233'; ctx.fillRect(0.4, 0, 3.6, 1.6);
      ctx.restore();
    }
    function dizzy(x, y, s) {
      for (let i = 0; i < 3; i++) {
        const a = time * 6 + i * 2.1;
        ctx.fillStyle = '#ffe28a';
        ctx.font = `${Math.round(8 * s)}px sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText('★', x + Math.cos(a) * 7 * s, y + Math.sin(a) * 2.5 * s);
      }
    }
    function questionMark(x, y, s) {
      ctx.fillStyle = '#ffffff'; ctx.strokeStyle = 'rgba(23,32,58,0.8)'; ctx.lineWidth = 2;
      ctx.font = `800 ${Math.round(13 * s)}px "Big Shoulders Display", sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
      ctx.strokeText('?', x, y); ctx.fillText('?', x, y);
    }
    // The answer banner: stencil capitals on a snowfield strip, as wide as the
    // answer needs (up to a cap), shrunk to fit, then cut with an ellipsis.
    // holders: two alpaca positions whose poles hold it up (null under the canopy).
    function banner(cx, y, s, text, holders) {
      const font = (f) => `800 ${f.toFixed(1)}px "Big Shoulders Stencil Display", "Big Shoulders Display", sans-serif`;
      const maxW = Math.min(W - 24, 170 * s), h = 15 * s, pad = 8 * s;
      let fs = 11 * s; const min = 7 * s;
      ctx.font = font(fs);
      let t = text;
      while (ctx.measureText(t).width > maxW - pad && fs > min) { fs -= 0.5; ctx.font = font(fs); }
      if (ctx.measureText(t).width > maxW - pad) {
        while (t.length > 2 && ctx.measureText(t + '…').width > maxW - pad) t = t.slice(0, -1);
        t = t.replace(/[\s!]+$/, '') + '…';
      }
      const span = holders ? Math.abs(holders[1].x - holders[0].x) + 10 * s : 0;
      const w = clamp(Math.max(ctx.measureText(t).width + pad, span), 40 * s, maxW);
      const x = clamp(cx - w / 2, 6, W - w - 6);
      if (holders) {   // two poles, from each holder's back up to the banner
        ctx.strokeStyle = '#6b4a2c'; ctx.lineWidth = 1.3 * s;
        ctx.beginPath();
        for (const hp of holders) { const px = clamp(hp.x + 3 * s, x + 3 * s, x + w - 3 * s); ctx.moveTo(hp.x + 3 * s, hp.y - 14 * s); ctx.lineTo(px, y); }
        ctx.stroke();
      }
      ctx.fillStyle = css(tint(AL.banner)); rr(x, y - h, w, h, 2 * s); ctx.fill();
      ctx.strokeStyle = css(tint([206, 216, 226])); ctx.lineWidth = 1; ctx.stroke();
      ctx.fillStyle = css(AL.ink); ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(t, x + w / 2, y - h / 2 + 0.5);
    }
    function startRide(plan, o) {
      const P = Object.assign({}, plan);
      const n = clamp(P.herd || 5, 1, 8);
      const r = E.rng(E.hashStr('herd:' + (o.seed || '') + ':' + n));
      const herd = [];
      const goldAt = P.golden ? Math.floor(r() * n) : -1;
      for (let i = 0; i < n; i++) herd.push({ coat: AL.coats[Math.floor(r() * AL.coats.length)], gold: i === goldAt, ph: r() * 6, bob: r() * 6 });
      return new Promise((resolve) => {
        if (ride) ride.resolve(false);
        ride = {
          P, herd, from: o.fromAlt, to: P.noMove ? o.fromAlt : clamp(o.toAlt, C.startAlt, C.summitAlt),
          answer: String(o.answer || '').toUpperCase().trim() + '!', t: 0, dur: Math.max(0.3, (P.durationMs || 3000) / 1000),
          resolve, on: o.on || null, fired: {}, prevView: view, prevRect: rect,
        };
        climb = climbTarget = ride.from;
        view = 'ride'; computeTarget();
      });
    }
    function endRide(done) {
      if (!ride) return;
      const R0 = ride; ride = null;
      climb = climbTarget = R0.to;
      view = R0.prevView === 'ride' ? 'follow' : R0.prevView; rect = R0.prevRect; computeTarget();
      R0.resolve(done !== false);
    }
    function rideEvent(name) { if (ride && !ride.fired[name]) { ride.fired[name] = true; if (ride.on) try { ride.on(name, ride.P); } catch (e) { /* never break a frame */ } } }
    // advances the ride clock and drives the climber's altitude (called from frame())
    function stepRide(dt) {
      const R0 = ride; R0.t += dt;
      const u = R0.t / R0.dur, P = R0.P;
      if (u >= 0) rideEvent('enter');
      if (u >= 0.18) rideEvent('scoop');
      if (u >= 0.26) rideEvent(P.noMove ? 'shrug' : 'gallop');
      if (u >= 0.78) rideEvent('drop');
      if (P.late && u >= 0.84) rideEvent('late');
      if (P.spit && u >= 0.9) { rideEvent('spit'); if (!splat) splat = { x: W * (0.38 + Math.random() * 0.24), y: Math.max(70, H * 0.22), t: 0, r: Math.min(W, H) * 0.09 }; }
      const g = P.noMove ? 0 : easeIO(seg(u, 0.26, 0.78));
      climb = climbTarget = R0.from + (R0.to - R0.from) * g;
      if (u >= 1) endRide(true);
    }
    // where the ride is, for the HUD (slot-machine altimeter) and dev mode
    function rideState() {
      if (!ride) return null;
      const u = ride.t / ride.dur;
      const phase = u < 0.18 ? 'enter' : u < 0.26 ? 'scoop' : u < 0.78 ? (ride.P.noMove ? 'shrug' : 'gallop') : u < 0.86 ? 'drop' : 'exit';
      return { phase, u, from: ride.from, to: ride.to, plan: ride.P };
    }
    // walks along the ground from screen x0 by d pixels of trail (signed)
    function alongX(x0, d) {
      if (!d) return x0;
      const dir = d > 0 ? 1 : -1, target = Math.abs(d);
      let x = x0, y = groundY(x0), dist = 0, guard = 0;
      while (dist < target && guard++ < 400) {
        const nx = x + dir * 1.5, ny = groundY(nx);
        dist += Math.hypot(nx - x, ny - y); x = nx; y = ny;
      }
      return x;
    }
    function drawRide(dt, cx0, cy0, cs) {
      const R0 = ride, P = R0.P, u = clamp(R0.t / R0.dur, 0, 1);
      const s = cs * 1.05, gap = 24 * s;
      const n = R0.herd.length, H0 = R0.herd;
      const style = P.style, band = P.band, tucked = band === 'glacier' && style !== 'paraglide';
      const galloping = !P.noMove && u > 0.26 && u < 0.78;
      const legRate = galloping ? 22 : 11;
      // the herd enters along the trail from the left, waits at the climber, leaves to the right
      const enter = easeIO(seg(u, 0, 0.18)), exit = seg(u, 0.86, 1);
      const baseX = alongX(cx0, -(1 - enter) * W * 0.9 + exit * exit * W * 0.9);
      const lead = n - 1;
      const carrier = style === 'conga' ? Math.floor(n / 2) : lead;
      const lift = seg(u, 0.18, 0.26), drop = seg(u, 0.78, 0.86), carried = lift * (1 - drop);
      const shrugging = (P.noMove && u > 0.26 && u < 0.8) || (P.shortHop && u > 0.2 && u < 0.3);
      const mapUp = P.shortHop && u > 0.16 && u < 0.27;
      // a line along the trail first; styles form out of it
      const line = R0.line || (R0.line = new Array(n));
      for (let i = 0; i < n; i++) {
        const x = alongX(baseX, (i - carrier) * gap);
        const bounce = galloping ? Math.abs(Math.sin(time * 11 + H0[i].bob)) * 2.2 * s : 0;
        line[i] = { x, y: groundY(x) - bounce, tilt: slopeAt(x) * 0.6, row: 0 };
      }
      let pos = line, climberX = line[carrier].x - 1 * s, climberY = line[carrier].y - 17 * s, lying = false;
      if (style === 'pyramid') {
        // rows of 3-2-1 stacked on the bottom row, rising as the climber is lifted
        const rows = []; let left = n, w = Math.min(3, n);
        while (left > 0) { const k = Math.min(w, left); rows.push(k); left -= k; w = Math.max(1, w - 1); }
        const pyr = []; let idx = 0, prev = null;
        rows.forEach((k, ri) => {
          const cur = [];
          for (let j = 0; j < k; j++) {
            let x, y;
            if (!ri) { x = alongX(baseX, (j - (k - 1) / 2) * gap * 0.95); y = groundY(x); }
            else { const a = prev[Math.min(j, prev.length - 1)], b = prev[Math.min(j + 1, prev.length - 1)]; x = (a.x + b.x) / 2; y = Math.min(a.y, b.y) - 13 * s; }
            const wob = galloping && ri ? Math.sin(time * 8 + ri * 1.3) * 0.06 * ri : 0;
            cur.push({ x, y, tilt: ri ? wob : slopeAt(x) * 0.6, row: ri });
          }
          for (const c of cur) pyr[idx++] = c;
          prev = cur;
        });
        pos = pyr.map((p, i) => ({ x: lerp(line[i].x, p.x, carried), y: lerp(line[i].y, p.y, carried), tilt: lerp(line[i].tilt, p.tilt, carried), row: p.row }));
        const top = pos[n - 1]; climberX = top.x; climberY = top.y - 15 * s;
      } else if (style === 'paraglide') {
        const fly = carried * (42 * s + (galloping ? Math.sin(time * 2) * 4 * s : 0));
        const hx = baseX, hy = groundY(baseX) - fly;
        pos = line.map((p, i) => { const tx = hx + (i - (n - 1) / 2) * 12 * s, ty = hy - (i % 2) * 6 * s; return { x: lerp(p.x, tx, carried), y: lerp(p.y, ty, carried), tilt: lerp(p.tilt, Math.sin(time * 3 + i) * 0.15, carried), row: carried > 0.5 ? 1 : 0 }; });
        climberX = hx; climberY = hy - 10 * s;
      } else if (style === 'crowdsurf') {
        // lying on the herd's backs, passed back and forth along the line
        const k = galloping ? (Math.sin(seg(u, 0.26, 0.78) * Math.PI * 3) + 1) / 2 : 0.5;
        const fi = k * (n - 1), i0 = Math.floor(fi), i1 = Math.min(n - 1, i0 + 1), f = fi - i0;
        climberX = lerp(line[i0].x, line[i1].x, f); climberY = lerp(line[i0].y, line[i1].y, f) - 19 * s; lying = true;
      }
      let topY = Infinity;
      for (const p of pos) topY = Math.min(topY, p.y);
      // dust, gravel or snow from the hooves
      if (galloping && !reduced && style !== 'paraglide' && Math.random() < 0.6) { const i = Math.floor(Math.random() * n); puff(pos[i].x - 6 * s, pos[i].y, s, band); }
      for (const p of puffs) {
        if (!p.on) continue;
        p.life += dt; if (p.life >= p.max) { p.on = false; continue; }
        p.x += p.vx * dt; p.y += p.vy * dt; p.vy += 12 * dt;
        ctx.fillStyle = css(tint(p.c), 0.55 * (1 - p.life / p.max)); ctx.beginPath(); ctx.arc(p.x, p.y, p.r * (1 + p.life * 2), 0, Math.PI * 2); ctx.fill();
      }
      // paraglider canopy (suit orange with white cells)
      if (style === 'paraglide' && carried > 0.05) {
        const cyc = climberY - 50 * s;
        ctx.globalAlpha = Math.min(1, carried * 2);
        ctx.fillStyle = '#ff5a1f'; ctx.beginPath(); ctx.ellipse(climberX, cyc, 46 * s, 12 * s, 0, Math.PI, 0); ctx.fill();
        ctx.fillStyle = '#ffffff'; for (let k = -2; k <= 2; k += 2) { ctx.beginPath(); ctx.ellipse(climberX + k * 9 * s, cyc - 1, 3.2 * s, 10 * s, 0, Math.PI, 0); ctx.fill(); }
        ctx.strokeStyle = 'rgba(40,40,40,0.45)'; ctx.lineWidth = 0.7; ctx.beginPath();
        for (let i = 0; i < n; i++) { ctx.moveTo(climberX + (i - (n - 1) / 2) * 18 * s, cyc); ctx.lineTo(pos[i].x, pos[i].y - 20 * s); }
        ctx.stroke(); ctx.globalAlpha = 1;
      }
      // the herd
      for (let i = 0; i < n; i++) {
        const p = pos[i];
        alpaca(p.x, p.y, s, {
          coat: H0[i].coat, gold: H0[i].gold, phase: H0[i].ph + time * legRate, tucked: tucked && !p.row, tilt: p.tilt,
          mask: band === 'deathzone', lamp: P.headlamps, shrug: shrugging, map: mapUp && i === lead,
          sign: i === lead, head: galloping ? -0.25 : 0,
        });
      }
      if (shrugging) questionMark((P.noMove ? baseX : pos[lead].x) + 10 * s, topY - 36 * s, s);
      // the answer banner on two poles, above the herd
      if (!P.noMove && u > 0.2 && u < 0.84) {
        const k = seg(u, 0.2, 0.28) * (1 - seg(u, 0.78, 0.84));
        ctx.globalAlpha = k;
        if (style === 'paraglide') banner(climberX, climberY + 44 * s, s, R0.answer, null);
        else {
          const ground0 = pos.filter((p) => !p.row);
          const a = ground0[0], b = ground0[ground0.length - 1];
          const by = Math.min(topY, climberY - 12 * s) - 30 * s;
          banner((a.x + b.x) / 2 + 3 * s, by, s, R0.answer, [a, b]);
        }
        ctx.globalAlpha = 1;
      }
      // the climber: surprised, carried with flailing arms, dropped off dizzy, thumbs up
      const cx = lerp(cx0, climberX, carried), cy = lerp(cy0, climberY, carried);
      const hatOff = u > 0.19 && u < 0.84;
      const thumbs = u > 0.92 || (P.noMove && u > 0.86);
      if (lying && carried > 0.3) {
        ctx.save(); ctx.translate(cx, cy); ctx.rotate(-Math.PI / 2 * Math.min(1, carried * 1.2));
        climber(0, 0, cs, time, { flail: galloping, hatless: hatOff }); ctx.restore();
      } else climber(cx, cy, cs, time, { flail: galloping, thumbs, hatless: hatOff, sit: carried > 0.3 });
      if (hatOff) {   // the hat flies up, tumbles above the ride, and drops back on
        const up = seg(u, 0.19, 0.3), back = seg(u, 0.74, 0.84);
        const hy = cy - 24 * cs - (up - back) * 15 * cs - Math.sin(time * 5) * 2 * cs * (1 - back);
        hat(cx + 1.2 * cs + (up - back) * (11 + Math.sin(time * 4) * 3) * cs, hy, cs, time * 6 * (1 - back));
      }
      if (u > 0.84 && u < 0.97) dizzy(cx + 1.2 * cs, cy - 32 * cs, cs);
      // the late alpaca: sprints in after the herd has gone, skids, slumps
      if (P.late && u > 0.84) {
        const k = seg(u, 0.84, 0.94);
        const lx = alongX(cx0, -lerp(W * 0.7, 28 * s, easeIO(k)));
        if (k < 1 && !reduced && Math.random() < 0.5) puff(lx - 8 * s, groundY(lx), s, band);
        alpaca(lx, groundY(lx), s, { coat: AL.coats[1], phase: time * (k < 1 ? 26 : 0), tilt: k >= 1 ? 0 : -0.12, sad: k >= 1, mask: band === 'deathzone', lamp: P.headlamps });
      }
    }
    function drawSplat(dt) {
      if (!splat) return;
      splat.t += dt;
      const k = splat.t / 1.6;
      if (k >= 1) { splat = null; return; }
      const y = splat.y + k * k * H * 0.12, a = k < 0.7 ? 0.85 : 0.85 * (1 - (k - 0.7) / 0.3);
      ctx.fillStyle = css(AL.splat, a);
      ctx.beginPath(); ctx.arc(splat.x, y, splat.r * 0.6, 0, Math.PI * 2); ctx.fill();
      for (let i = 0; i < 7; i++) { const an = i * 0.9; ctx.beginPath(); ctx.arc(splat.x + Math.cos(an) * splat.r * 0.62, y + Math.sin(an) * splat.r * 0.5, splat.r * (0.16 + (i % 3) * 0.05), 0, Math.PI * 2); ctx.fill(); }
      for (let i = -1; i <= 1; i++) { ctx.fillRect(splat.x + i * splat.r * 0.3 - 2, y, 4, splat.r * (0.5 + k * 1.2) * (1 - Math.abs(i) * 0.3)); }
    }

    // --- the frame ------------------------------------------------------------------
    function draw(dt) {
      const timeAlt = clamp(skyOverride != null ? skyOverride : climb, C.startAlt, C.summitAlt);
      const sky = skyAt(timeAlt);
      AMB = sky.amb; HAZE = sky.bot;
      const g = ctx.createLinearGradient(0, 0, 0, H);
      g.addColorStop(0, css(sky.top)); g.addColorStop(0.62, css(mixc(sky.top, sky.bot, 0.78))); g.addColorStop(1, css(mixc(sky.bot, [255, 248, 236], 0.18)));
      ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);

      if (sky.star > 0.02) {
        for (const s of STARS) {
          const tw = reduced ? 1 : 0.6 + 0.4 * Math.sin(time * s.sp + s.ph);
          ctx.fillStyle = `rgba(255,255,255,${sky.star * tw})`;
          ctx.fillRect(s.x * W, s.y * H, s.r, s.r);
        }
      }
      // sun and moon
      const t = clamp((timeAlt - C.startAlt) / (C.summitAlt - C.startAlt), 0, 1);
      const sunA = clamp((0.93 - t) / 0.1, 0, 1);
      if (sunA > 0) {
        const sx = W * (0.14 + 0.76 * t), sy = H * (0.5 - 0.4 * Math.sin(Math.PI * Math.min(t, 0.98)));
        const scol = t < 0.25 ? mixc(hex('#ffc9a0'), hex('#fff4d6'), t / 0.25) : t < 0.7 ? hex('#fff4d6') : mixc(hex('#ffd08a'), hex('#ff7a59'), (t - 0.7) / 0.3);
        const gr = Math.max(180, Math.min(W, H) * 0.5);
        const glow = ctx.createRadialGradient(sx, sy, 0, sx, sy, gr);
        glow.addColorStop(0, css(scol, 0.55 * sunA)); glow.addColorStop(0.18, css(scol, 0.22 * sunA)); glow.addColorStop(1, css(scol, 0));
        ctx.fillStyle = glow; ctx.fillRect(sx - gr, sy - gr, gr * 2, gr * 2);
        ctx.fillStyle = css(scol, sunA); ctx.beginPath(); ctx.arc(sx, sy, 15, 0, Math.PI * 2); ctx.fill();
      }
      const moonA = clamp((t - 0.82) / 0.12, 0, 1);
      if (moonA > 0) {
        const mx = W * 0.22, my = H * 0.17;
        ctx.fillStyle = `rgba(240,242,255,${0.9 * moonA})`; ctx.beginPath(); ctx.arc(mx, my, 13, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = css(sky.top, moonA); ctx.beginPath(); ctx.arc(mx + 6, my - 3, 12, 0, Math.PI * 2); ctx.fill();
      }

      range(farAlt, 0.22, 0.17, [150, 160, 182], 0.55, 6000, 0.16);
      range(midAlt, 0.45, 0.3, [104, 112, 126], 0.32, 5300, 0.24);

      // cloud sea
      if (cam.sy > 0.2) {
        for (const c of CLOUDS) {
          const x = W / 2 + (c.u - cam.p) * cam.sx * 0.75 + (reduced ? 0 : (time * 4) % 60);
          const y = H / 2 - (c.a - cam.alt) * cam.sy * 0.72;
          if (x < -c.w * 2 || x > W + c.w * 2 || y < -60 || y > H + 60) continue;
          const cg = ctx.createRadialGradient(x, y, 2, x, y, c.w);
          cg.addColorStop(0, `rgba(255,255,255,${0.5 * AMB[1]})`); cg.addColorStop(1, 'rgba(255,255,255,0)');
          ctx.fillStyle = cg; ctx.save(); ctx.translate(x, y); ctx.scale(1, c.h / c.w); ctx.translate(-x, -y);
          ctx.fillRect(x - c.w, y - c.w, c.w * 2, c.w * 2); ctx.restore();
        }
      }

      // main terrain
      const step = 3;
      const pts = [];
      for (let x = -6; x <= W + 9; x += step) { const p = cam.p + (x - W / 2) / cam.sx; pts.push([x, Y(ground(p)), p]); }
      ctx.beginPath(); ctx.moveTo(-6, H + 10);
      for (const q of pts) ctx.lineTo(q[0], q[1]);
      ctx.lineTo(W + 9, H + 10); ctx.closePath();
      const tg = ctx.createLinearGradient(0, Y(9300), 0, Y(1500));
      for (const [a, c] of TERRAIN) tg.addColorStop(clamp((9300 - a) / 7800, 0, 1), css(tint(c)));
      ctx.fillStyle = tg; ctx.fill();
      ctx.save(); ctx.clip();
      const s = clamp(cam.sy / 0.55, 0.3, 1.35);
      // yellow band on the Lhotse face
      {
        const bx0 = X(0.73), bx1 = X(0.94), y0 = Y(7780), y1 = Y(7540);
        if (bx1 > 0 && bx0 < W && y1 > y0) {
          const bc = tint([201, 170, 104]);
          const bg = ctx.createLinearGradient(0, y0, 0, y1);
          bg.addColorStop(0, css(bc, 0)); bg.addColorStop(0.3, css(bc, 0.34)); bg.addColorStop(0.7, css(bc, 0.34)); bg.addColorStop(1, css(bc, 0));
          ctx.fillStyle = bg;
          ctx.save(); ctx.globalAlpha = 0.9;
          ctx.beginPath(); ctx.moveTo(bx0, y0 + 10); ctx.lineTo(bx1, y0 - 6); ctx.lineTo(bx1, y1 - 6); ctx.lineTo(bx0, y1 + 10); ctx.closePath(); ctx.fill();
          ctx.restore();
        }
      }
      // rock facets: short ridges falling away to the right sit in shade
      ctx.beginPath();
      for (let i = 0; i < pts.length - 1; i++) {
        const a = pts[i], b = pts[i + 1];
        const lo = pts[Math.max(0, i - 2)], hi = pts[Math.min(pts.length - 1, i + 3)];
        if (hi[1] - lo[1] > 1.5) { ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0] + 0.5, b[1]); ctx.lineTo(b[0] + 0.5, b[1] + 46 * s); ctx.lineTo(a[0], a[1] + 46 * s); ctx.closePath(); }
      }
      ctx.fillStyle = 'rgba(22,34,78,0.13)'; ctx.fill();
      // shaded body under a lit rim
      for (const [depth, al] of [[22, 0.16], [70, 0.12], [160, 0.1]]) {
        ctx.beginPath(); ctx.moveTo(-6, H + 10);
        for (const q of pts) ctx.lineTo(q[0], q[1] + depth * s);
        ctx.lineTo(W + 9, H + 10); ctx.closePath();
        ctx.fillStyle = `rgba(22,34,78,${al})`; ctx.fill();
      }
      ctx.restore();
      // snow cornice along the ridge
      ctx.strokeStyle = css(tint([255, 255, 255]), 0.85); ctx.lineWidth = 1.6; ctx.beginPath();
      let pen = false;
      for (const q of pts) { const a = smooth(q[2]); if (a > 5250) { pen ? ctx.lineTo(q[0], q[1]) : ctx.moveTo(q[0], q[1]); pen = true; } else pen = false; }
      ctx.stroke();

      const visible = (p) => { const x = X(p); return x > -60 && x < W + 60; };
      // forest
      for (const tr of TREES) {
        if (!visible(tr.p)) continue;
        const a = ground(tr.p); if (a > 3920) continue;
        const x = X(tr.p), y = Y(a) + tr.d * s, h = tr.h * s, w = h * 0.55;
        ctx.fillStyle = css(tint(hex(tr.c)));
        ctx.beginPath(); ctx.moveTo(x, y - h); ctx.lineTo(x + w / 2, y); ctx.lineTo(x - w / 2, y); ctx.closePath(); ctx.fill();
      }
      // Lukla airstrip (the famous uphill runway)
      if (visible(0.074)) {
        ctx.strokeStyle = css(tint([88, 92, 99])); ctx.lineWidth = 4.5 * s; ctx.lineCap = 'butt';
        ctx.beginPath(); ctx.moveTo(X(0.062), Y(ground(0.062)) + 2 * s); ctx.lineTo(X(0.086), Y(ground(0.086)) + 2 * s); ctx.stroke();
        ctx.strokeStyle = 'rgba(255,255,255,0.8)'; ctx.lineWidth = 0.9 * s; ctx.setLineDash([3 * s, 3 * s]);
        ctx.beginPath(); ctx.moveTo(X(0.063), Y(ground(0.063)) + 2 * s); ctx.lineTo(X(0.085), Y(ground(0.085)) + 2 * s); ctx.stroke(); ctx.setLineDash([]);
        const bx = X(0.058), by = Y(ground(0.058));
        ctx.fillStyle = css(tint([236, 230, 218])); ctx.fillRect(bx - 5 * s, by - 6 * s, 9 * s, 6 * s);
        ctx.fillStyle = css(tint([181, 67, 47])); ctx.fillRect(bx - 6 * s, by - 7.5 * s, 11 * s, 2 * s);
      }
      // Namche Bazaar houses and flags
      if (visible(0.2)) {
        for (const hs of HOUSES) {
          const x = X(hs.p), y = Y(ground(hs.p)) + hs.d * s, w = hs.w * s, h = w * 0.62;
          ctx.fillStyle = css(tint([242, 236, 224])); ctx.fillRect(x - w / 2, y - h, w, h);
          ctx.fillStyle = css(tint(hex(hs.roof))); ctx.beginPath(); ctx.moveTo(x - w / 2 - 1.2 * s, y - h); ctx.lineTo(x, y - h - 4 * s); ctx.lineTo(x + w / 2 + 1.2 * s, y - h); ctx.closePath(); ctx.fill();
          ctx.fillStyle = 'rgba(40,50,70,0.55)'; ctx.fillRect(x - 1 * s, y - h * 0.6, 2 * s, 2 * s);
        }
        flags(X(0.196), Y(ground(0.196)) - 12 * s, X(0.212), Y(ground(0.212)) - 14 * s, s, 12);
      }
      // Tengboche monastery
      if (visible(0.3)) {
        const x = X(0.3), y = Y(ground(0.3));
        ctx.fillStyle = css(tint([244, 238, 226])); ctx.fillRect(x - 8 * s, y - 9 * s, 16 * s, 9 * s);
        ctx.fillStyle = css(tint([178, 52, 40])); ctx.fillRect(x - 8 * s, y - 9 * s, 16 * s, 2 * s);
        ctx.fillStyle = css(tint([214, 162, 40])); ctx.beginPath(); ctx.moveTo(x - 9 * s, y - 9 * s); ctx.lineTo(x, y - 15 * s); ctx.lineTo(x + 9 * s, y - 9 * s); ctx.closePath(); ctx.fill();
      }
      // icefall seracs and a ladder
      if (visible(0.585)) {
        for (const sr of SERACS) {
          const x = X(sr.p), y = Y(ground(sr.p)) + sr.d * s;
          ctx.save(); ctx.translate(x, y); ctx.rotate(sr.rot);
          ctx.fillStyle = css(tint(hex(sr.c))); ctx.fillRect(-sr.w * s / 2, -sr.h * s, sr.w * s, sr.h * s);
          ctx.strokeStyle = css(tint([120, 170, 210]), 0.6); ctx.lineWidth = 0.8; ctx.strokeRect(-sr.w * s / 2, -sr.h * s, sr.w * s, sr.h * s);
          ctx.restore();
        }
        const lx1 = X(0.588), ly1 = Y(ground(0.588)) - 3 * s, lx2 = X(0.596), ly2 = Y(ground(0.596)) - 3 * s;
        ctx.strokeStyle = 'rgba(70,70,80,0.9)'; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(lx1, ly1); ctx.lineTo(lx2, ly2); ctx.moveTo(lx1, ly1 - 3 * s); ctx.lineTo(lx2, ly2 - 3 * s);
        for (let i = 0; i <= 6; i++) { const tt = i / 6; ctx.moveTo(lerp(lx1, lx2, tt), lerp(ly1, ly2, tt)); ctx.lineTo(lerp(lx1, lx2, tt), lerp(ly1, ly2, tt) - 3 * s); }
        ctx.stroke();
      }
      // camps
      for (const camp of CAMPS) {
        if (!visible(camp[0].p)) continue;
        for (const tn of camp) {
          const x = X(tn.p), y = Y(ground(tn.p)) + tn.d * s, w = tn.w * s, h = w * 0.72;
          ctx.fillStyle = css(tint(hex(tn.c))); ctx.beginPath(); ctx.moveTo(x - w / 2, y); ctx.quadraticCurveTo(x, y - h * 1.5, x + w / 2, y); ctx.closePath(); ctx.fill();
          ctx.strokeStyle = 'rgba(0,0,0,0.18)'; ctx.lineWidth = 0.7; ctx.stroke();
        }
      }
      if (visible(0.548)) flags(X(0.538), Y(ground(0.538)) - 16 * s, X(0.558), Y(ground(0.558)) - 18 * s, s, 14);
      if (visible(PS)) {
        const sx = X(PS), sy = Y(ground(PS));
        flags(sx, sy - 3 * s, sx - 22 * s, sy + 18 * s, s, 9);
        flags(sx, sy - 3 * s, sx + 20 * s, sy + 20 * s, s, 9);
      }

      // route: dashed trail, climbed part solid
      const pc = pFor(climb);
      const yAt = (p) => Y(ground(p)) - 2.5 * s;
      ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      ctx.strokeStyle = css(tint([255, 255, 255]), 0.75); ctx.lineWidth = 1.4; ctx.setLineDash([4, 5]);
      ctx.beginPath();
      let started = false;
      for (let x = Math.max(X(P0), -10); x <= Math.min(X(PS), W + 10); x += 3) { const p = cam.p + (x - W / 2) / cam.sx; if (p < pc) continue; started ? ctx.lineTo(x, yAt(p)) : ctx.moveTo(x, yAt(p)); started = true; }
      ctx.stroke(); ctx.setLineDash([]);
      ctx.strokeStyle = '#ff6a1a'; ctx.lineWidth = 2.6; ctx.beginPath(); started = false;
      for (let x = Math.max(X(P0), -10); x <= Math.min(X(pc), W + 10); x += 3) { const p = cam.p + (x - W / 2) / cam.sx; started ? ctx.lineTo(x, yAt(p)) : ctx.moveTo(x, yAt(p)); started = true; }
      if (started) { ctx.lineTo(X(pc), yAt(pc)); ctx.stroke(); }

      // altitude scale while climbing
      const overview = cam.sy < 0.2;
      if (!overview) {
        ctx.font = '700 11px "Atkinson Hyperlegible", system-ui, sans-serif'; ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
        const aTop = cam.alt + (H / 2) / cam.sy, aBot = cam.alt - (H / 2) / cam.sy;
        for (let a = Math.ceil(aBot / 100) * 100; a <= aTop; a += 100) {
          const y = Y(a), major = a % 500 === 0;
          ctx.fillStyle = `rgba(255,255,255,${major ? 0.8 : 0.45})`;
          ctx.fillRect(0, y, major ? 12 : 6, 1);
          if (major) { ctx.fillStyle = 'rgba(255,255,255,0.85)'; ctx.shadowColor = 'rgba(0,0,0,0.45)'; ctx.shadowBlur = 3; ctx.fillText(fmt(a), 15, y); ctx.shadowBlur = 0; }
        }
      }
      // the Death Zone line
      const dzy = Y(8000);
      if (dzy > -10 && dzy < H + 10) {
        ctx.strokeStyle = 'rgba(255,96,80,0.6)'; ctx.lineWidth = 1.2; ctx.setLineDash([6, 6]);
        ctx.beginPath(); ctx.moveTo(0, dzy); ctx.lineTo(W, dzy); ctx.stroke(); ctx.setLineDash([]);
      }
      // milestone plates
      for (const m of C.milestones) {
        const p = pFor(m.alt), x = X(p), y = Y(ground(p));
        if (x < -120 || x > W + 120 || y < -40 || y > H + 40) continue;
        if (m.id === 'deathzone') { plate(W - 8, dzy - 12, '8,000 m', 'Death Zone', { align: 'right', small: overview }); continue; }
        if (overview) {
          const left = !['lukla', 'camp1'].includes(m.id);
          plate(left ? x - 8 : x + 8, y - (m.id === 'summit' ? 14 : m.id === 'teahouse' ? 13 : 6), m.short, fmt(m.alt) + ' m', { align: left ? 'right' : 'left', small: true });
        } else {
          ctx.strokeStyle = 'rgba(20,28,52,0.75)'; ctx.lineWidth = 1.4;
          ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x, y - 30); ctx.stroke();
          ctx.fillStyle = 'rgba(20,28,52,0.75)'; ctx.beginPath(); ctx.ellipse(x, y, 3, 1.2, 0, 0, Math.PI * 2); ctx.fill();
          plate(x - 4, y - 38, m.short, fmt(m.alt) + ' m', { align: 'right' });
        }
      }
      // ghost of personal best
      if (ghost && ghost > C.startAlt + 20) {
        const gp = pFor(ghost), gx = X(gp), gy = Y(ground(gp));
        ctx.globalAlpha = 0.75;
        ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 1.2; ctx.setLineDash([2, 2]);
        ctx.beginPath(); ctx.moveTo(gx, gy); ctx.lineTo(gx, gy - 22); ctx.stroke(); ctx.setLineDash([]);
        ctx.fillStyle = 'rgba(255,255,255,0.9)'; ctx.beginPath(); ctx.moveTo(gx, gy - 22); ctx.lineTo(gx + 9, gy - 19); ctx.lineTo(gx, gy - 16); ctx.fill();
        ctx.globalAlpha = 1;
        plate(gx + 12, gy - 19, 'Your best', fmt(ghost) + ' m', { small: true });
      }
      // the climber
      const cx = X(pc), cy = Y(ground(pc));
      const cs = clamp(cam.sy / 0.55, 0.42, 1.35) * 1.1;
      if (overview) {
        const pr = reduced ? 0 : (time * 1.2) % 1;
        ctx.strokeStyle = `rgba(255,106,26,${0.8 * (1 - pr)})`; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(cx, cy - 6, 8 + pr * 16, 0, Math.PI * 2); ctx.stroke();
      }
      if (ride) drawRide(dt, cx, cy, cs); else climber(cx, cy, cs, time);
      if (overview && view === 'overview' && showPin) plate(cx, cy - 44, fmt(climb) + ' m', null, { align: 'center', accent: true });

      // bursts on rare finds
      for (let i = bursts.length - 1; i >= 0; i--) {
        const b = bursts[i]; b.t += dt;
        const k = b.t / b.dur; if (k >= 1) { bursts.splice(i, 1); continue; } if (k < 0) continue;
        ctx.strokeStyle = css(b.c, (1 - k) * 0.9); ctx.lineWidth = 3 * (1 - k) + 1;
        ctx.beginPath(); ctx.arc(cx, cy - 12 * cs, 8 + k * b.r, 0, Math.PI * 2); ctx.stroke();
        for (const sp of b.sparks) {
          const d = k * sp.v;
          ctx.fillStyle = css(b.c, 1 - k);
          ctx.fillRect(cx + Math.cos(sp.a) * d - 1.5, cy - 12 * cs + Math.sin(sp.a) * d - 1.5, 3, 3);
        }
      }
      // weather: snow and high wind
      if (!reduced) {
        const snowAmt = timeAlt > 5300 && timeAlt < 8300 ? 50 : 0;
        while (flakes.length < snowAmt) flakes.push({ x: Math.random() * W, y: Math.random() * H, v: 14 + Math.random() * 30, r: 0.8 + Math.random() * 1.6 });
        if (flakes.length > snowAmt) flakes.length = snowAmt;
        ctx.fillStyle = 'rgba(255,255,255,0.75)';
        for (const f of flakes) { f.y += f.v * dt; f.x += (18 + f.v * 0.3) * dt; if (f.y > H) { f.y = -4; f.x = Math.random() * W; } if (f.x > W) f.x = 0; ctx.fillRect(f.x, f.y, f.r, f.r); }
        const windAmt = timeAlt > 7000 ? Math.round(6 + (timeAlt - 7000) / 70) : 0;
        while (streaks.length < windAmt) streaks.push({ x: Math.random() * W, y: Math.random() * H * 0.9, l: 30 + Math.random() * 90, v: 300 + Math.random() * 400 });
        if (streaks.length > windAmt) streaks.length = windAmt;
        ctx.strokeStyle = 'rgba(255,255,255,0.22)'; ctx.lineWidth = 1; ctx.beginPath();
        for (const w of streaks) { w.x += w.v * dt; if (w.x - w.l > W) { w.x = -10; w.y = Math.random() * H * 0.9; } ctx.moveTo(w.x - w.l, w.y); ctx.lineTo(w.x, w.y + 1); }
        ctx.stroke();
      }
      // prayer-flag confetti for Sherpa finds and summits
      for (let i = confetti.length - 1; i >= 0; i--) {
        const c = confetti[i]; c.life -= dt;
        if (c.life <= 0) { confetti.splice(i, 1); continue; }
        c.vy += 60 * dt; c.x += (c.vx + Math.sin(time * 3 + c.ph) * 30) * dt; c.y += c.vy * dt; c.rot += c.vr * dt;
        ctx.save(); ctx.translate(c.x, c.y); ctx.rotate(c.rot); ctx.globalAlpha = Math.min(1, c.life);
        ctx.fillStyle = c.col; ctx.fillRect(-4, -3, 8, 6); ctx.restore();
      }
      ctx.globalAlpha = 1;
      drawSplat(dt);
    }

    let showPin = false;
    function frame(ts) {
      const dt = Math.min(0.05, Math.max(0, (ts - last) / 1000));
      last = ts; time += dt;
      if (ride) stepRide(dt);
      const diff = climbTarget - climb;
      if (ride || reduced || snap) climb = climbTarget;
      else climb += diff * (1 - Math.exp(-dt * 3.2));
      if (Math.abs(climbTarget - climb) < 0.5) climb = climbTarget;
      moving = Math.abs(diff) > 3;
      computeTarget();
      const k = reduced || snap ? 1 : 1 - Math.exp(-dt * (view === 'ride' ? 5 : view === 'follow' ? 4.5 : 2.4));
      cam.p = lerp(cam.p, tgt.p, k); cam.alt = lerp(cam.alt, tgt.alt, k);
      cam.sx = lerp(cam.sx, tgt.sx, k); cam.sy = lerp(cam.sy, tgt.sy, k);
      snap = false;
      if (W > 0 && H > 0) draw(dt);
      if (onFrame) onFrame(climb, dt);
      requestAnimationFrame(frame);
    }

    return {
      start() { resize(); window.addEventListener('resize', resize); requestAnimationFrame((t) => { last = t; frame(t); }); },
      resize,
      setView(v, r, opts) { view = v; rect = r || null; showPin = !!(opts && opts.pin); computeTarget(); if (opts && opts.snap) snap = true; },
      setClimb(a, opts) { climbTarget = clamp(a, C.startAlt, C.summitAlt); if (opts && opts.snap) { climb = climbTarget; snap = true; } },
      setGhost(a) { ghost = a || null; },
      setReduced(v) { reduced = !!v; },
      setSkyOverride(a) { skyOverride = a == null ? null : clamp(Number(a), C.startAlt, C.summitAlt); },
      get skyOverride() { return skyOverride; },
      onFrame(fn) { onFrame = fn; },
      get alt() { return climb; },
      // alpaca ride: resolves true when it finishes, false if cancelled
      ride(plan, o) { return startRide(plan, o || {}); },
      cancelRide() { if (ride) endRide(false); splat = null; },
      get riding() { return !!ride; },
      rideState,
      get night() { return skyAt(clamp(skyOverride != null ? skyOverride : climb, C.startAlt, C.summitAlt)).star > 0.3; },
      burst(tier) {
        if (reduced) return;
        const cols = [[200, 205, 212], [92, 197, 128], [99, 170, 245], [181, 140, 243], [255, 200, 70]];
        const s = tier * 1.4, n = 6 + Math.round(s * 5), sparks = [];
        for (let i = 0; i < n; i++) sparks.push({ a: Math.random() * Math.PI * 2, v: 30 + Math.random() * (40 + s * 28) });
        bursts.push({ t: 0, dur: 0.7 + s * 0.15, r: 30 + s * 22, c: cols[tier], sparks });
        if (tier >= 3) bursts.push({ t: -0.15, dur: 1.2 + s * 0.12, r: 60 + s * 30, c: cols[tier], sparks: [] });
        if (tier >= 2) cheerUntil = time + (tier >= 3 ? 1.6 : 0.9);
      },
      confetti() {
        if (reduced) return;
        const cols = ['#2f6fd0', '#f4f2ea', '#d8382b', '#2f9b4a', '#f2c230'];
        for (let i = 0; i < 140; i++) confetti.push({ x: Math.random() * W, y: -20 - Math.random() * H * 0.4, vx: (Math.random() - 0.5) * 60, vy: 40 + Math.random() * 80, rot: Math.random() * 6, vr: (Math.random() - 0.5) * 8, col: cols[i % 5], ph: Math.random() * 6, life: 2.6 + Math.random() * 1.2 });
      },
    };
  })();

  // ===========================================================================
  // LLM judge (spec §5.5) — uses the viewer's Claude account when the page is
  // opened as a claude.ai artifact; absent everywhere else.
  // ===========================================================================
  const Judge = {
    state: 'off', sample: null, perms: null, queue: [], inflight: 0, timer: null, cooldownUntil: 0, cache: {},
    async init() {
      try { this.cache = JSON.parse(localStorage.getItem(JKEY) || '{}') || {}; } catch (e) { this.cache = {}; }
      const cl = window.claude;
      if (!cl || typeof cl.use !== 'function') { this.state = 'off'; return renderJudge(); }
      try { this.sample = await cl.use('sample'); } catch (e) { this.sample = null; }
      if (!this.sample) { this.state = 'off'; return renderJudge(); }
      try { this.perms = await cl.use('permissions'); } catch (e) { this.perms = null; }
      if (this.perms) {
        let st = 'prompt';
        try { st = await this.perms.state('sample'); } catch (e) { st = 'prompt'; }
        this.state = st === 'granted' ? 'on' : st === 'denied' ? 'denied' : st === 'unavailable' ? 'off' : 'prompt';
      } else this.state = 'prompt';
      renderJudge();
    },
    async enable() {
      if (this.state === 'denied' && this.perms) { try { await this.perms.manage(); } catch (e) { /* panel unavailable */ } return this.init(); }
      if (this.perms) {
        try { const r = await this.perms.request(['sample']); this.state = r && r.sample === 'granted' ? 'on' : r && r.sample === 'denied' ? 'denied' : this.state; } catch (e) { /* keep state */ }
      } else if (this.sample) {
        try { await this.sample.json('Reply with only this JSON array: [1]', { modelTier: 'quick' }); this.state = 'on'; } catch (e) { this.state = e && e.code === 'not_granted' ? 'denied' : 'off'; }
      }
      renderJudge();
    },
    ready() { return this.state === 'on' && now() > this.cooldownUntil; },
    check(cat, text, norm) {
      const key = cat.id + '|' + norm;
      const hit = this.cache[key];
      if (hit && hit.v) return Promise.resolve(hit.v);
      return new Promise((res) => { this.queue.push({ cat, text, key, res }); this.schedule(); });
    },
    schedule() { if (!this.timer) this.timer = setTimeout(() => { this.timer = null; this.flush(); }, C.judge.batchDelayMs); },
    saveCache() {
      const keys = Object.keys(this.cache);
      if (keys.length > 1500) keys.sort((a, b) => this.cache[a].t - this.cache[b].t).slice(0, keys.length - 1200).forEach((k) => delete this.cache[k]);
      try { localStorage.setItem(JKEY, JSON.stringify(this.cache)); } catch (e) { /* storage full or blocked */ }
    },
    async flush() {
      if (!this.queue.length) return;
      if (this.inflight >= 2) return this.schedule();
      const cat = this.queue[0].cat, batch = [];
      for (let i = 0; i < this.queue.length && batch.length < C.judge.maxBatch;) {
        if (this.queue[i].cat.id === cat.id) batch.push(this.queue.splice(i, 1)[0]); else i++;
      }
      if (this.queue.length) this.schedule();
      this.inflight++;
      try {
        const out = await this.sample.json(E.judgePrompt(cat.text, batch.map((b) => b.text)), { modelTier: 'quick' });
        const arr = Array.isArray(out) ? out : out && Array.isArray(out.answers) ? out.answers : [];
        batch.forEach((b, i) => {
          const v = arr.find((x) => x && Number(x.i) === i + 1) || arr[i];
          if (v && typeof v.valid === 'boolean') { this.cache[b.key] = { v, t: now() }; b.res(v); } else b.res(null);
        });
        this.saveCache();
      } catch (e) {
        const code = e && e.code;
        if (code === 'rate_limited') this.cooldownUntil = now() + 60000;
        else if (code === 'not_granted') this.state = 'denied';
        else if (['sampling_disabled', 'not_declared', 'capability_disabled', 'capability_removed'].includes(code)) this.state = 'off';
        renderJudge();
        batch.forEach((b) => b.res(null));
      } finally {
        this.inflight--;
        if (this.queue.length) this.schedule();
      }
    },
  };

  function renderJudge() {
    const st = Judge.state;
    const row = $('#judge-row'), dot = $('#judge-dot'), txt = $('#judge-text'), btn = $('#btn-judge');
    const stxt = $('#set-judge-text'), sbtn = $('#set-judge');
    row.hidden = st === 'off';
    dot.classList.toggle('off', st !== 'on');
    const copy = {
      off: 'Only answers on the word list count.',
      prompt: 'Claude can check answers that aren’t on the word list. Checks use your Claude account.',
      on: 'Answer checking is on. Claude checks answers that aren’t on the word list.',
      denied: 'Answer checking is off, so only word-list answers count.',
    }[st];
    txt.textContent = copy; stxt.textContent = copy;
    const label = st === 'prompt' ? 'Allow' : st === 'denied' && Judge.perms ? 'Manage' : '';
    btn.hidden = !label; sbtn.hidden = !label;
    btn.textContent = label; sbtn.textContent = label;
  }

  // ===========================================================================
  // Game state
  // ===========================================================================
  const G = {
    screen: 'home', state: 'idle', mode: 'daily', today: '', puzzle: 1, cats: [], index: [], round: null,
    legIdx: 0, aid: 0, lastSubmit: 0, peek: false, lastSec: -1, pauseUntil: 0,
    rideQ: [], rideActive: null, slotT: 0, slotTxt: '',   // alpaca rides (queued, playing) and the slot-machine altimeter
    dev: null,   // dev climb tool state (mode 'dev' only), see the dev mode section
  };
  const ui = {
    home: $('#home'), play: $('#play'), results: $('#results'), app: $('#app'),
    input: $('#answer'), chips: $('#chips'), feedback: $('#feedback'), category: $('#category'),
    fill: $('#timer-fill'), timer: $('#timer'), secs: $('#secs'), alt: $('#alt-num'), air: $('#air'), next: $('#next-mark'),
    legs: $('#legs'), live: $('#sr-live'),
  };
  const announce = (t) => { ui.live.textContent = ''; setTimeout(() => { ui.live.textContent = t; }, 30); };
  // Dev climbs run legs forever; each leg uses one position (0–6) of the normal
  // pattern for its timer, multiplier and category pool. Daily legs: pos = index.
  const legPos = (i) => (G.mode === 'dev' && G.round && G.round.legs[i] ? G.round.legs[i].pos : i);
  const legConf = (i) => (G.mode === 'practice' ? { secs: 20, mult: 1 } : C.legs[legPos(i)]);
  const curLeg = () => G.round && G.round.legs[G.legIdx];
  const save = () => { if (G.mode === 'daily' || G.mode === 'dev') Store.save(); };
  // Dev mode listens here once unlocked; with no listener this does nothing.
  let devListener = null;
  const devEmit = (type, data) => { if (devListener) { try { devListener(type, data); } catch (e) { /* dev UI only */ } } };

  function show(screen) {
    for (const s of ['home', 'play', 'results']) ui[s].hidden = s !== screen;
    G.screen = screen;
    requestAnimationFrame(layoutScene);
  }
  function layoutScene() {
    const W = window.innerWidth, H = window.innerHeight;
    if (G.screen === 'home') {
      const top = $('.topbar').getBoundingClientRect().bottom + 16;
      const card = $('.home-card').getBoundingClientRect();
      if (W >= 900) Scene.setView('overview', { x0: card.right + 24, y0: top, x1: W - 24, y1: H - 24 });
      else Scene.setView('overview', { x0: 8, y0: top + 10, x1: W - 8, y1: card.top - 18 });
    } else if (G.screen === 'results') {
      const sh = $('#sheet').getBoundingClientRect();
      if (W >= 900) Scene.setView('overview', { x0: 24, y0: 70, x1: sh.left - 24, y1: H - 40 }, { pin: true });
      else Scene.setView('overview', { x0: 8, y0: 62, x1: W - 8, y1: Math.max(180, sh.top - 6) }, { pin: true });
    } else Scene.setView(G.peek ? 'peek' : 'follow');
  }
  window.addEventListener('resize', () => requestAnimationFrame(layoutScene));

  function totalAltitude() {
    const r = G.round;
    if (!r) return C.startAlt;
    if (G.mode === 'dev') return devLap().alt;
    let sum = 0;
    r.legs.forEach((l) => { if (l) sum += E.legEffective(l.raw); });
    return Math.min(C.summitAlt, C.startAlt + sum);
  }
  // Dev climbs: uncapped total climbed (plus any offset from the move tools).
  function devTotal() {
    const r = G.round;
    if (!r) return 0;
    let sum = r.offset || 0;
    r.legs.forEach((l) => { if (l) sum += E.legEffective(l.raw); });
    return Math.max(0, sum);
  }
  function devLap(total) { return window.DA_DEV_CORE.lapState(total == null ? devTotal() : total, C.startAlt, C.summitAlt); }

  // ---------------------------------------------------------------- streaks/stats
  function updateStreak(date) {
    const s = Store.data.streak;
    if (s.last === date) return;
    const gap = s.last ? E.dayIndex(date) - E.dayIndex(s.last) : Infinity;
    if (gap === 1) s.current += 1;
    else if (gap === 2 && s.tokens > 0) { s.tokens -= 1; s.current += 1; }
    else s.current = 1;
    if (s.current > 0 && s.current % 14 === 0) s.tokens = Math.min(1, s.tokens + 1);
    s.best = Math.max(s.best, s.current);
    s.last = date;
  }
  function liveStreak() {
    const s = Store.data.streak;
    if (!s.last) return 0;
    const gap = E.dayIndex(E.localDateStr()) - E.dayIndex(s.last);
    if (gap <= 1) return s.current;
    if (gap === 2 && s.tokens > 0) return s.current;
    return 0;
  }
  function completedRounds() { return Object.values(Store.data.rounds).filter((r) => r && r.completed && typeof r.final === 'number'); }
  function bestAltitude(excludeDate) {
    let b = 0;
    for (const r of completedRounds()) if (r.date !== excludeDate) b = Math.max(b, r.final);
    return b;
  }

  // ---------------------------------------------------------------- home
  function renderHome() {
    G.today = E.localDateStr();
    G.puzzle = E.puzzleNumber(G.today);
    $('#home-num').textContent = 'No. ' + G.puzzle;
    $('#home-date').textContent = E.nowDate().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
    const r = Store.data.rounds[G.today];
    const done = !!(r && r.completed);
    const best = bestAltitude();
    const st = liveStreak();
    $('#fact-streak').innerHTML = st + '<small> day' + (st === 1 ? '' : 's') + '</small>';
    $('#fact-best').innerHTML = best ? fmt(best) + '<small> m</small>' : '—';
    $('#fact-today').innerHTML = done ? fmt(r.final) + '<small> m</small>' : '7 legs';
    $('#btn-begin').textContent = done ? 'View Results' : 'Begin Climb';
    $('#next-climb').hidden = !done;
    Scene.setClimb(done ? r.final : C.startAlt, { snap: true });
    Scene.setGhost(best && (!done || best > r.final) ? best : null);
    G.state = 'idle';
    show('home');
    ui.app.classList.toggle('night', false);
  }

  // ---------------------------------------------------------------- play setup
  function enterPlay() {
    show('play');
    ui.chips.innerHTML = '';
    ui.feedback.textContent = '';
    ui.input.value = '';
    ui.category.textContent = 'Get ready';
    ui.category.classList.add('veiled');
    ui.legs.innerHTML = '';
    const n = G.mode === 'practice' ? 1 : 7;
    for (let i = 0; i < n; i++) { const li = document.createElement('li'); li.setAttribute('aria-label', 'Leg ' + (i + 1)); ui.legs.appendChild(li); }
    renderLegDots();
    ui.input.focus({ preventScroll: true });
  }
  function renderLegDots() {
    const at = legPos(G.legIdx);   // dev climbs: the position in the 7-leg pattern
    [...ui.legs.children].forEach((li, i) => {
      li.classList.toggle('done', i < at || (i === at && G.state === 'settle'));
      li.classList.toggle('current', i === at && G.state !== 'settle');
    });
  }
  async function countdown() {
    const ov = $('#countdown'), el = $('#count');
    ov.hidden = false;
    for (let i = C.countdownSecs; i >= 1; i--) {
      el.textContent = i; el.style.animation = 'none'; void el.offsetWidth; el.style.animation = '';
      Sound.play('count');
      await sleep(1000);
    }
    ov.hidden = true;
  }

  function beginDaily() {
    if (G.mode === 'dev') return;
    // A fake calendar date must never create or finish a real round.
    if (E.clockOffset()) { devEmit('notice', 'The fake clock is on. Clear it to play the real daily climb.'); return; }
    devEmit('daily-start');
    G.today = E.localDateStr();
    const existing = Store.data.rounds[G.today];
    if (existing && existing.completed) return showResults(existing);
    if (Store.data.settings.sound) Sound.ensure();
    G.mode = 'daily';
    G.puzzle = E.puzzleNumber(G.today);
    G.cats = E.dailyCategories(DATA, G.puzzle);
    G.index = G.cats.map(E.buildIndex);
    G.round = null; G.legIdx = 0; G.state = 'countdown';
    Scene.setClimb(C.startAlt, { snap: true });
    Scene.setGhost(null);
    enterPlay();
    countdown().then(() => {
      G.round = { v: 2, date: G.today, puzzle: G.puzzle, catIds: G.cats.map((c) => c.id), startedAt: now(), extra: !!Store.data.settings.extra, legs: [], completed: false };
      Store.data.rounds[G.today] = G.round;
      startLeg(0);
    });
  }
  function beginPractice() {
    closeDialogs();
    if (Store.data.settings.sound) Sound.ensure();
    G.mode = 'practice';
    G.cats = [PRACTICE];
    G.index = [E.buildIndex(PRACTICE)];
    G.round = { practice: true, legs: [], extra: !!Store.data.settings.extra };
    G.legIdx = 0; G.state = 'countdown';
    Scene.setClimb(C.startAlt, { snap: true });
    Scene.setGhost(null);
    enterPlay();
    countdown().then(() => startLeg(0));
  }

  function startLeg(i) {
    G.legIdx = i;
    let pos = i;
    if (G.mode === 'dev') pos = devPrepareLeg(i);
    const conf = G.mode === 'dev' ? C.legs[pos] : legConf(i);
    const secs = conf.secs * (G.round.extra ? C.extraTimeFactor : 1);
    const t = now();
    G.round.legs[i] = { catId: G.cats[i].id, start: t, deadline: t + secs * 1000, total: secs * 1000, raw: 0, chain: 0, invalid: 0, judged: 0, answers: [] };
    if (G.mode === 'dev') { G.round.legs[i].pos = pos; if (G.dev.paused) G.dev.pausedAt = t; }
    save();
    G.state = 'leg';
    G.lastSec = -1;
    cancelRides();
    clearSpotlight();
    setLegHeader(i, secs, conf.mult);
    ui.chips.innerHTML = '';
    ui.feedback.textContent = '';
    ui.feedback.className = 'feedback';
    ui.input.placeholder = 'Type an answer';
    ui.input.value = '';
    ui.input.focus({ preventScroll: true });
    renderLegDots();
    setNight();
    Sound.play('go');
    const who = G.mode === 'practice' ? 'Practice' : G.mode === 'dev' ? `Dev leg ${i + 1}` : `Leg ${i + 1} of 7`;
    announce(`${who}: ${G.cats[i].text}. ${Math.round(secs)} seconds.`);
    devEmit('leg-start', i);
  }
  function setLegHeader(i, secs, mult) {
    ui.category.textContent = G.cats[i].text;
    ui.category.classList.remove('veiled');
    $('#leg-label').textContent = G.mode === 'practice' ? 'Practice climb' : G.mode === 'dev' ? `Dev leg ${i + 1} · pattern ${legPos(i) + 1} of 7` : `Leg ${i + 1} of 7`;
    $('#leg-mult').textContent = `${Math.round(secs)} s  ×${mult}`;
  }
  function setNight() {
    const alt = Scene.alt;
    let night = (G.screen === 'play' && G.mode === 'daily' && (G.legIdx >= 5 || alt >= 8000)) || (G.screen === 'results' && G.mode === 'daily' && G.round && G.round.final >= 8000);
    if (G.mode === 'dev' && G.dev) night = G.dev.night != null ? G.dev.night : (G.screen === 'play' && (legPos(G.legIdx) >= 5 || alt >= 8000));
    ui.app.classList.toggle('night', !!night);
  }

  // ---------------------------------------------------------------- per frame
  Scene.onFrame((alt) => {
    devTick();
    if (G.screen === 'play') {
      const rs = Scene.rideState();
      if (rs && rs.phase === 'gallop' && !isReduced()) {
        // slot machine: the digits spin while the herd gallops, then land on the drop-off
        const t = performance.now();
        if (t - G.slotT > 55) { G.slotT = t; G.slotTxt = fmt(Math.round(rs.to)).replace(/\d/g, () => String(Math.floor(Math.random() * 10))); }
        ui.alt.innerHTML = `<span class="slot">${G.slotTxt}</span><small>m</small>`;
      } else ui.alt.innerHTML = fmt(alt) + '<small>m</small>';
      ui.air.textContent = 'Air ' + E.airPercent(alt) + '%';
      const nx = E.nextMilestone(alt + 0.5);
      ui.next.innerHTML = nx ? `Next: <b>${esc(nx.short)}</b> in ${fmt(nx.alt - alt)} m` : '<b>On the summit</b>';
      if (G.state === 'leg') {
        const leg = curLeg();
        const paused = devPaused();
        const rem = Math.max(0, leg.deadline - Math.max(paused ? G.dev.pausedAt : now(), G.pauseUntil));
        const k = Math.min(1, rem / leg.total);
        ui.fill.style.setProperty('--k', k.toFixed(4));
        ui.fill.style.transform = `scaleX(${k.toFixed(4)})`;
        const inf = G.mode === 'dev' && G.dev.infinite;
        const sec = inf ? '∞' : Math.ceil(rem / 1000);
        if (sec !== G.lastSec) { ui.secs.textContent = sec; if (!inf && sec <= 3 && sec > 0 && G.lastSec !== -1) Sound.play('tick'); G.lastSec = sec; }
        ui.timer.classList.toggle('urgent', !inf && rem <= 3000);
        if (rem <= 0 && !paused) endLeg();
      }
    }
  });
  setInterval(() => { devTick(); if (G.state === 'leg' && !devPaused()) { const leg = curLeg(); if (leg && now() >= leg.deadline) endLeg(); } }, 200);
  setInterval(() => {
    Sound.wind(Scene.alt, G.screen === 'play' || G.screen === 'home' || G.screen === 'results');
    const ms = msToMidnight();
    const txt = clock(ms);
    const a = $('#next-time'); if (a) a.textContent = txt;
    const b = $('#res-next'); if (b) b.textContent = hm(ms);
    if (E.localDateStr() !== G.today && (G.state === 'idle' || G.state === 'results') && G.mode === 'daily') renderHome();
  }, 1000);
  function msToMidnight() { const d = E.nowDate(); const m = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1); return m - d; }
  function hm(ms) { const m = Math.max(0, Math.ceil(ms / 60000)); return Math.floor(m / 60) + 'h ' + (m % 60) + 'm'; }
  function clock(ms) { const s = Math.max(0, Math.floor(ms / 1000)); return [Math.floor(s / 3600), Math.floor(s / 60) % 60, s % 60].map((x) => String(x).padStart(2, '0')).join(':'); }

  // ---------------------------------------------------------------- answers
  function setFeedback(text, cls) { ui.feedback.textContent = text; ui.feedback.className = 'feedback' + (cls ? ' ' + cls : ''); }

  function chipEl(a) {
    const li = document.createElement('li');
    li.dataset.id = a.id;
    fillChip(li, a);
    return li;
  }
  function fillChip(li, a) {
    if (a.s === 'pending') {
      li.className = 'chip pending';
      li.innerHTML = `<span class="txt"></span><span class="gain">checking</span>`;
      li.querySelector('.txt').textContent = a.t;
      li.setAttribute('aria-label', a.t + ', checking');
      return;
    }
    if (a.s === 'rejected' || a.s === 'unchecked') {
      li.className = 'chip ' + a.s;
      li.innerHTML = `<span class="txt"></span><span class="gain">${a.s === 'rejected' ? '✕' : '?'}</span>`;
      li.querySelector('.txt').textContent = a.t;
      return;
    }
    li.className = `chip t${a.tier}` + (a.x ? ' fixed' : '');
    li.innerHTML = `${ICON[a.tier]}<span class="txt"></span><span class="gain">+${fmt(a.g)}</span><span class="sr-only">${tierName(a.tier)}</span>`;
    const txt = li.querySelector('.txt');
    if (a.x) {
      // Autocorrected: the answer as listed, with what was typed underneath.
      txt.innerHTML = '<span class="w"></span><span class="typed"></span>';
      txt.querySelector('.w').textContent = a.c;
      txt.querySelector('.typed').textContent = 'you typed ' + a.t;
    } else txt.textContent = a.c;
    li.title = `${tierName(a.tier)} · ${C.tiers[a.tier].theme}` + (a.x ? ` · corrected from “${a.t}”` : '');
  }
  function chipFor(a) { return ui.chips.querySelector(`[data-id="${a.id}"]`); }
  function pulse(a) {
    const el = chipFor(a);
    if (!el) return;
    el.classList.remove('pulse'); void el.offsetWidth; el.classList.add('pulse');
  }

  function submit() {
    const raw = ui.input.value;
    if (G.state !== 'leg') { ui.input.value = ''; return; }
    const leg = curLeg();
    const t = now();
    if (t < G.pauseUntil) return;   // spotlight up: keep the typed text for after
    if (devPaused()) return;          // dev pause: same, keep the text
    if (t > leg.deadline) return;
    if (t - G.lastSubmit < C.minSubmitGapMs) return;
    const text = raw.trim();
    if (!text) return;
    G.lastSubmit = t;
    ui.input.value = '';
    const norm = E.normalize(text);
    if (!norm) return reject(leg, text, norm, true);
    if (leg.answers.filter((a) => a.s === 'ok').length >= C.maxAcceptedPerLeg) return setFeedback('Leg limit reached: 30 answers.', 'dup');
    const m = E.match(G.index[G.legIdx], text);
    if (m && m.entry) {
      const q = m.qualifier || null;
      // Qualified answers ("womens soccer") score at the base tier, a few per leg.
      const out = E.hitOutcome(leg.answers, m.entry.id, q);
      if (out.kind === 'dup') return duplicate(out.prior, text);
      if (out.kind === 'limit') return variantLimit(text);
      const a = { t: text, n: norm, eid: m.entry.id, c: q ? m.canon : m.entry.canon, tier: m.entry.tier, k: 'seed' };
      if (q) a.q = q;
      if (m.fix) a.x = m.fix;   // autocorrected: 'typo' | 'keyboard' | 'sound' | 'words'
      return accept(leg, G.legIdx, a);
    }
    const prior = leg.answers.find((a) => a.n === norm);
    if (prior && (prior.s === 'ok' || prior.s === 'pending')) return duplicate(prior, text);
    if (!(prior && prior.s === 'rejected') && Judge.ready() && E.judgeEligible(text) && leg.judged < C.judge.maxPerLeg) return judgeAnswer(leg, text, norm);
    reject(leg, text, norm, true);
  }

  function accept(leg, legIdx, a, existing) {
    const altBefore = totalAltitude();
    const before = E.legEffective(leg.raw);
    const rawGain = E.answerGain(a.tier, leg.chain, legPos(legIdx));
    leg.chain += 1;
    leg.raw += rawGain;
    const eff = E.legEffective(leg.raw) - before;
    const ans = existing || { id: ++G.aid };
    Object.assign(ans, a, { s: 'ok', raw: rawGain, g: eff });
    if (!existing) leg.answers.push(ans);
    save();
    if (legIdx === G.legIdx && G.screen === 'play') {
      const el = chipFor(ans);
      if (el) fillChip(el, ans); else ui.chips.prepend(chipEl(ans));
      if (G.state === 'leg' && eff < rawGain) setFeedback(E.legEffective(leg.raw) >= C.legCap ? `Leg limit reached: ${fmt(C.legCap)} m this leg.` : `Past ${fmt(C.legFullUpTo)} m this leg: further gains count at ${Math.round(C.legOverRate * 100)}%.`);
      else if (G.state === 'leg') setFeedback('');
    }
    const lapUp = G.mode === 'dev' && devLap().lap > devLap(devTotal() - eff).lap;
    const live = legIdx === G.legIdx && G.screen === 'play';
    // Sherpa: the alpacas carry the climber after the spotlight, so the climb waits for them
    const sherpaRide = ans.tier === 4 && live && G.state === 'leg';
    if (sherpaRide && !isReduced()) queueRide({ ans, eff, legIdx, lapUp, from: altBefore, to: lapUp ? C.summitAlt : totalAltitude() });
    else if (lapUp) devLapUp(); else Scene.setClimb(totalAltitude());
    Sound.play('t' + ans.tier);
    Scene.burst(ans.tier);
    if (ans.tier === 2) buzz(15);
    if (ans.tier === 3) { flash('m'); buzz([15, 40, 25]); }
    if (ans.tier === 4) { Scene.confetti(); flash('s'); buzz([20, 50, 20, 50, 40]); }
    if (live && C.tiers[ans.tier].pause && G.state === 'leg') spotlight(ans, eff);
    else if (live) gainPop(ans, eff);
    if (sherpaRide && !isReduced() && $('#spot').hidden) runNextRide();
    announce(ans.x ? `Corrected to ${ans.c}. ${tierName(ans.tier)}, plus ${eff} meters` : `${ans.c}, ${tierName(ans.tier)}, plus ${eff} meters`);
    if (sherpaRide && isReduced()) {   // reduced motion: no ride, just the words
      setFeedback(`Carried up by alpacas · +${fmt(eff)} m`);
      announce(rideSentence(altBefore, lapUp ? C.summitAlt : totalAltitude(), eff, null));
    }
    setNight();
    devEmit('answer', { kind: 'ok', ans, rawGain, eff, legIdx });
  }

  // ---------------------------------------------------------------- alpaca ride
  // After a Sherpa spotlight the herd carries the climber up by the meters earned
  // (Scene.ride draws it, E.ridePlan decides it). The clock is held for the ride
  // with holdClock(), Enter waits (G.pauseUntil), the leg card fades (.riding) and
  // rides queue: a judge result can land mid-ride.
  function rideSentence(from, to, eff, plan) {
    if (plan && plan.noMove) return 'Alpaca express! The herd shrugs: this leg is already at its limit.';
    const m0 = E.milestoneFor(from), m1 = E.milestoneFor(to);
    const to1 = m1 && m0 && m1.id !== m0.id ? `, to ${m1.short}` : '';
    return `Alpaca express! Carried up ${fmt(eff)} meters${to1}.${plan && plan.golden ? ' Golden alpaca!' : ''}`;
  }
  // the spotlight's timer starts the ride (runNextRide); accept() starts it at once if no spotlight is up
  function queueRide(job) { G.rideQ.push(job); }
  function runNextRide() {
    if (G.rideActive || !G.rideQ.length) return;
    const job = G.rideQ.shift();
    if (G.state !== 'leg' || job.legIdx !== G.legIdx || G.screen !== 'play' || !G.round) { landRide(job, false); runNextRide(); return; }
    const seed = `${G.round.date || G.mode}|${job.legIdx}|${job.ans.id}`;
    const plan = E.ridePlan({ fromAlt: job.from, toAlt: job.to, meters: job.eff, night: Scene.night || ui.app.classList.contains('night'), seed, force: job.force });
    job.plan = plan;
    job.until = holdClock(plan.durationMs + 120);
    G.rideActive = job;
    $('#play').classList.add('riding');
    announce(rideSentence(job.from, job.to, job.eff, plan));
    devEmit('ride', { plan, ans: job.ans, eff: job.eff });
    Scene.ride(plan, { fromAlt: job.from, toAlt: job.to, answer: job.ans.c, seed, on: rideCue }).then((done) => {
      if (G.rideActive === job) G.rideActive = null;
      $('#play').classList.remove('riding');
      if ($('#spot').hidden && G.pauseUntil <= now() + 150) G.pauseUntil = 0;
      landRide(job, done);
      runNextRide();
    });
  }
  // the climber ends exactly where the answer put it, ride or no ride
  function landRide(job, done) {
    if (!G.round) return;
    if (job.lapUp && G.mode === 'dev') { if (done) devLapUp(); else Scene.setClimb(totalAltitude(), { snap: true }); }
    else Scene.setClimb(totalAltitude(), done ? { snap: true } : undefined);
    setNight();
  }
  function rideCue(name, plan) {
    switch (name) {
      case 'enter': Sound.play('alpaca'); break;
      case 'scoop': if (plan.golden) Sound.play('golden'); break;
      case 'gallop': Sound.play('hooves'); buzz([30, 60, 30, 60, 30, 60, 30, 60, 30]); break;
      case 'shrug': Sound.play('alpaca'); break;
      case 'late': Sound.play('alpaca'); break;
      case 'spit': Sound.play('splat'); buzz(40); break;
      default: break;
    }
  }
  function cancelRides() {
    G.rideQ.length = 0;
    const a = G.rideActive;
    G.rideActive = null;
    const pl = $('#play'); if (pl) pl.classList.remove('riding');
    if (a) Scene.cancelRide();
  }

  function flash(kind) {
    const f = $('#flash');
    f.className = ''; void f.offsetWidth; f.className = 'on ' + kind;
  }

  // Floating "+N m" over the answer box for every find below the spotlight ranks.
  function gainPop(ans, eff) {
    const card = $('.answer-form');
    if (!card) return;
    const el = document.createElement('div');
    el.className = `gain-pop t${ans.tier}`;
    el.setAttribute('aria-hidden', 'true');
    el.innerHTML = `${ICON[ans.tier]}+${fmt(eff)}<small> m</small>`;
    card.appendChild(el);
    setTimeout(() => el.remove(), 1100);
  }

  // Mountaineer and Sherpa finds freeze the leg and put the answer centre stage.
  // The clock is held (deadline pushed back by the pause), Enter is ignored, and
  // the input keeps focus so the keyboard stays up.
  // Holds the leg clock for `ms`: the deadline moves back by the new pause time
  // and G.pauseUntil freezes the timer display. Overlapping holds extend.
  function holdClock(ms) {
    const leg = curLeg();
    const t = now();
    const from = Math.max(t, G.pauseUntil);
    const until = Math.max(G.pauseUntil, t + ms);
    if (leg) leg.deadline += until - from;
    G.pauseUntil = until;
    save();
    return until;
  }
  // o.noHold: show the overlay without holding the clock (dev effect triggers).
  function spotlight(ans, eff, o) {
    const ms = C.tiers[ans.tier].pause;
    const t = now();
    const until = o && o.noHold ? t + ms : holdClock(ms);
    const box = $('#spot');
    box.className = `overlay spot t${ans.tier}`;
    $('#spot-rank').innerHTML = `${ICON[ans.tier]}<span>${tierName(ans.tier)}</span>`;
    $('#spot-word').textContent = ans.c;
    $('#spot-cat').textContent = G.cats[G.legIdx] ? G.cats[G.legIdx].text : '';
    const num = $('#spot-gain');
    box.hidden = false;
    void box.offsetWidth;
    box.classList.add('on');
    $('.play-inner').classList.remove('quake'); void box.offsetWidth;
    if (ans.tier >= 4 && !isReduced()) $('.play-inner').classList.add('quake');
    // count the meters up
    const t0 = performance.now(), dur = isReduced() ? 0 : Math.min(600, ms * 0.5);
    const tick = (ts) => {
      const k = dur ? Math.min(1, (ts - t0) / dur) : 1;
      num.innerHTML = `+${fmt(Math.round(eff * (1 - Math.pow(1 - k, 3))))}<small> m</small>`;
      if (k < 1 && !box.hidden) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    clearTimeout(G.spotT);
    G.spotT = setTimeout(() => { clearSpotlight(); runNextRide(); }, until - t);
  }
  function clearSpotlight() {
    clearTimeout(G.spotT);
    G.pauseUntil = G.rideActive && G.rideActive.until > now() ? G.rideActive.until : 0;   // a ride keeps holding the clock
    const box = $('#spot');
    if (box) { box.hidden = true; box.classList.remove('on'); }
    const pi = $('.play-inner'); if (pi) pi.classList.remove('quake');
  }

  function reject(leg, text, norm, penalize) {
    leg.chain = 0;
    leg.invalid += 1;
    if (norm) leg.answers.push({ id: ++G.aid, t: text, n: norm, s: 'rejected' });
    let note = '';
    if (penalize && G.state === 'leg' && leg === curLeg()) { leg.deadline -= C.invalidPenaltySecs * 1000; note = ' · −1 s'; }
    save();
    rejectFx(text, note);
    devEmit('answer', { kind: 'rejected', text, norm, penalized: !!note });
  }
  // The wrong-answer feedback on its own: shake, red line, thud, buzz.
  function rejectFx(text, note) {
    if (note) { ui.secs.classList.add('hit'); setTimeout(() => ui.secs.classList.remove('hit'), 600); }
    ui.input.classList.remove('shake'); void ui.input.offsetWidth; ui.input.classList.add('shake');
    clearTimeout(G.shakeT); G.shakeT = setTimeout(() => ui.input.classList.remove('shake'), 420);
    setFeedback(`“${text}” isn’t a match${note}`, 'bad');
    Sound.play('bad');
    buzz(30);
    announce(`${text} is not a match${note ? ', minus one second' : ''}`);
  }

  // Past the per-leg qualifier cap: like a duplicate (no points, no penalty, chain kept).
  function variantLimit(text) {
    setFeedback(`Variant limit reached: ${C.maxQualifiedPerLeg} per leg.`, 'dup');
    Sound.play('dup');
    announce(`${text}: variant limit reached, no points, no penalty`);
    devEmit('answer', { kind: 'variant-limit', text });
  }

  function duplicate(a, text) {
    pulse(a);
    setFeedback(`Already found: ${a.c || a.t}`, 'dup');
    Sound.play('dup');
    devEmit('answer', { kind: 'dup', ans: a, text });
  }

  function judgeAnswer(leg, text, norm) {
    leg.judged += 1;
    const ans = { id: ++G.aid, t: text, n: norm, s: 'pending' };
    leg.answers.push(ans);
    ui.chips.prepend(chipEl(ans));
    setFeedback('Checking “' + text + '”…');
    devEmit('answer', { kind: 'pending', text, norm, ans });
    const legIdx = G.legIdx, cat = G.cats[legIdx], round = G.round;
    Judge.check(cat, text, norm).then((v) => resolveJudged(round, legIdx, ans, v));
  }

  function resolveJudged(round, legIdx, ans, verdict) {
    if (round !== G.round || ans.s !== 'pending') return;
    const leg = round.legs[legIdx];
    const d = E.interpretVerdict(verdict);
    devEmit('answer', { kind: 'judged', ans, verdict, decision: d });
    const el = legIdx === G.legIdx ? chipFor(ans) : null;
    if (d.kind === 'accept') {
      let eid = null, q = null, canon = d.canonical || ans.t, tier = d.tier;
      // Map the judge's canonical back onto the list (or a qualified form of a
      // listed answer), never through fuzzy matching.
      const m = d.canonical ? E.match(G.index[legIdx], d.canonical, { noFuzzy: true }) : null;
      if (m && m.entry) { eid = m.entry.id; q = m.qualifier || null; canon = q ? m.canon : m.entry.canon; tier = m.entry.tier; }
      const key = E.normalize(canon);
      const out = E.hitOutcome(leg.answers, eid, q, ans);
      const dupe = out.kind === 'dup' ? out.prior : leg.answers.find((a) => a !== ans && a.s === 'ok' && E.normalize(a.c || '') === key);
      if (dupe) { ans.s = 'dup'; if (el) el.remove(); pulse(dupe); save(); return; }
      if (out.kind === 'limit') { ans.s = 'dup'; if (el) el.remove(); if (legIdx === G.legIdx && G.state === 'leg') variantLimit(ans.t); save(); return; }
      const a = { t: ans.t, n: ans.n, eid, c: canon, tier, k: 'judge' };
      if (q) a.q = q;
      accept(leg, legIdx, a, ans);
      return;
    }
    if (d.kind === 'reject') {
      ans.s = 'rejected';
      leg.chain = 0; leg.invalid += 1;
      const live = G.state === 'leg' && legIdx === G.legIdx;
      if (d.penalize && live) leg.deadline -= C.invalidPenaltySecs * 1000;
      if (live) { setFeedback(`“${ans.t}” doesn’t fit${d.penalize ? ' · −1 s' : ''}`, 'bad'); Sound.play('bad'); }
    } else {
      ans.s = 'unchecked';
      if (legIdx === G.legIdx && G.state === 'leg') setFeedback(`Couldn’t check “${ans.t}”. No penalty.`);
    }
    save();
    if (el) { fillChip(el, ans); setTimeout(() => el.remove(), 1400); }
  }

  // ---------------------------------------------------------------- leg end
  async function endLeg() {
    if (G.state !== 'leg') return;
    G.state = 'settle';
    cancelRides();
    clearSpotlight();
    const leg = curLeg();
    ui.fill.style.transform = 'scaleX(0)';
    ui.secs.textContent = '0';
    ui.timer.classList.remove('urgent');
    ui.input.value = '';
    ui.input.placeholder = 'Time!';
    setFeedback('');
    renderLegDots();
    Sound.play('end');
    const pending = () => leg.answers.some((a) => a.s === 'pending');
    const round = G.round;
    if (pending()) {
      showTransition({ checking: true });
      const until = now() + C.judge.settleWaitMs;
      while (pending() && now() < until) await sleep(120);
      leg.answers.forEach((a) => { if (a.s === 'pending') a.s = 'unchecked'; });
    }
    if (G.round !== round || G.state !== 'settle') return;   // a dev climb ended or reloaded meanwhile
    leg.eff = E.legEffective(leg.raw);
    leg.ended = now();
    save();
    if (G.mode === 'practice') return finishPractice();
    if (G.mode !== 'dev' && G.legIdx >= 6) return finishRound();
    if (G.mode === 'dev' && G.dev.skipTransition) {   // dev "jump to leg": straight on
      G.dev.skipTransition = false;
      $('#transition').hidden = true;
      startLeg(G.legIdx + 1);
      return layoutScene();
    }
    G.state = 'transition';
    G.peek = true; layoutScene();
    showTransition({});
    await sleep(C.transitionMs);
    if (G.round !== round || G.state !== 'transition') return;
    G.peek = false;
    $('#transition').hidden = true;
    startLeg(G.legIdx + 1);
    layoutScene();
  }

  function showTransition(o) {
    const tr = $('#transition');
    const leg = curLeg();
    const alt = totalAltitude();
    const nx = E.nextMilestone(alt);
    const nxt = G.legIdx + 1;
    $('#tr-eyebrow').textContent = o.checking ? 'Time' : `${G.mode === 'dev' ? 'Dev leg' : 'Leg'} ${G.legIdx + 1} complete`;
    $('#tr-gain').innerHTML = o.checking ? 'Checking<small>…</small>' : `+${fmt(E.legEffective(leg.raw))}<small> m</small>`;
    const found = leg.answers.filter((a) => a.s === 'ok');
    const rare = found.reduce((m, a) => Math.max(m, a.tier), -1);
    $('#tr-note').textContent = o.checking ? 'Waiting for answer checks' : found.length ? `${found.length} answer${found.length === 1 ? '' : 's'}, best find ${tierName(rare)}` : 'No answers this leg';
    $('#tr-alt').textContent = fmt(alt) + ' m';
    $('#tr-next-row').hidden = !nx;
    $('#tr-next').hidden = !nx;
    if (nx) { $('#tr-next-dist').textContent = fmt(nx.alt - alt) + ' m to go'; $('#tr-next').textContent = nx.name; }
    const showLeg = !o.checking && ((nxt < 7 && G.mode === 'daily') || G.mode === 'dev');
    $('#tr-leg-row').hidden = !showLeg;
    if (showLeg) {
      const np = G.mode === 'dev' ? devNextPos() : nxt;
      const c = C.legs[np];
      $('#tr-leg').textContent = G.mode === 'dev' ? `Dev leg ${nxt + 1} · pattern ${np + 1}` : nxt >= 5 ? `Leg ${nxt + 1}, summit push` : `Leg ${nxt + 1}`;
      $('#tr-leg-info').textContent = `${Math.round(c.secs * (G.round.extra ? C.extraTimeFactor : 1))} s  ×${c.mult}`;
    }
    const acts = $('#tr-actions'); acts.hidden = true; acts.innerHTML = '';
    tr.hidden = false;
    if (!o.checking) announce(`${G.mode === 'dev' ? 'Dev leg' : 'Leg'} ${G.legIdx + 1} complete. Plus ${fmt(E.legEffective(leg.raw))} meters. Altitude ${fmt(alt)} meters.`);
  }

  function finishPractice() {
    const leg = curLeg();
    G.state = 'transition';
    showTransition({});
    $('#tr-eyebrow').textContent = 'Practice complete';
    $('#tr-leg-row').hidden = true;
    const acts = $('#tr-actions');
    const done = Store.data.rounds[E.localDateStr()] && Store.data.rounds[E.localDateStr()].completed;
    acts.innerHTML = `<button class="btn btn-primary" id="tr-go">${done ? 'View today’s results' : 'Begin today’s climb'}</button><button class="btn btn-ghost" id="tr-home">Back to base</button>`;
    acts.hidden = false;
    Store.data.seenIntro = true; Store.save();
    $('#tr-go').onclick = () => { $('#transition').hidden = true; G.mode = 'daily'; G.round = null; beginDaily(); };
    $('#tr-home').onclick = () => { $('#transition').hidden = true; G.mode = 'daily'; G.round = null; renderHome(); };
    $('#tr-go').focus();
    announce(`Practice complete. You climbed ${fmt(E.legEffective(leg.raw))} meters.`);
  }

  function finishRound(opts) {
    const r = G.round;
    r.legs.forEach((l) => l && l.answers.forEach((a) => { if (a.s === 'pending') a.s = 'unchecked'; }));
    r.completed = true;
    r.final = E.finalAltitude(r.legs.map((l) => (l ? l.raw : 0)));
    r.finishedAt = now();
    if (opts && opts.forfeit) r.forfeited = true;
    updateStreak(r.date);
    Store.data.rounds[r.date] = r;
    Store.save();
    $('#transition').hidden = true;
    showResults(r, { fresh: true });
  }

  // ---------------------------------------------------------------- results
  function legRarest(l) { let t = -1; if (l) l.answers.forEach((a) => { if (a.s === 'ok' && a.tier > t) t = a.tier; }); return t; }
  function shareText(r) {
    const m = E.milestoneFor(r.final);
    const row = Array.from({ length: 7 }, (_, i) => { const t = legRarest(r.legs[i]); return t >= 0 ? C.tiers[t].emoji : C.noFindEmoji; }).join('');
    const url = shareUrl();
    const llamas = E.shareAlpacas(alpacaRides(r).n);   // one 🦙 per Sherpa ride: no letters, so never answers
    return `Daily Ascent #${r.puzzle} ⛰️\n${m.emoji} ${m.short} · ${fmt(r.final)} m\n${row}${llamas ? '\n' + llamas : ''}${url ? '\n' + url : ''}`;
  }
  // Alpaca rides in a round: its ok Sherpa answers (judge-accepted ones too).
  // The longest is the one that climbed the most effective meters.
  function alpacaRides(r) {
    let n = 0, longest = null;
    (r && r.legs || []).forEach((l, i) => l && l.answers.forEach((a) => {
      if (a.s !== 'ok' || a.tier !== 4) return;
      n++;
      if (!longest || (a.g || 0) > longest.g) longest = { g: a.g || 0, c: a.c, date: r.date, cat: (DATA.categories.find((c) => c.id === r.catIds[i]) || {}).text || '' };
    }));
    return { n, longest };
  }
  function shareUrl() {
    if (window.DA_SHARE_URL) return window.DA_SHARE_URL;
    try { if (/github\.io$/.test(location.hostname) || (location.protocol === 'https:' && window.top === window && !/claude|anthropic/.test(location.hostname))) return location.origin + location.pathname; } catch (e) { /* cross-origin frame */ }
    return '';
  }

  function showResults(r, o) {
    G.round = r;
    G.mode = 'daily';
    G.state = 'results';
    G.today = E.localDateStr();
    const cats = r.catIds.map((id) => DATA.categories.find((c) => c.id === id) || { id, text: id, a: {} });
    const m = E.milestoneFor(r.final);
    const nx = E.nextMilestone(r.final);
    const prevBest = bestAltitude(r.date);
    const isPB = r.final > prevBest && prevBest > 0;
    const answers = [];
    r.legs.forEach((l, i) => l && l.answers.forEach((a) => { if (a.s === 'ok') answers.push(Object.assign({ cat: cats[i].text }, a)); }));
    const best = answers.slice().sort((a, b) => b.tier - a.tier || b.raw - a.raw).slice(0, 3);
    // missed gems: one Climber or Mountaineer answer per category the player did not find
    const gems = [];
    const rng = E.rng(E.hashStr('gems:' + r.puzzle));
    const order = E.shuffled(cats.map((_, i) => i), E.hashStr('gem-order:' + r.puzzle));
    for (const i of order) {
      if (gems.length >= 4) break;
      const ix = E.buildIndex(cats[i]);
      const found = new Set((r.legs[i] ? r.legs[i].answers : []).filter((a) => a.s === 'ok' && !a.q).map((a) => a.eid));
      const pool = ix.entries.filter((e) => (e.tier === 2 || e.tier === 3) && !found.has(e.id));
      if (pool.length) gems.push({ e: pool[Math.floor(rng() * pool.length)], cat: cats[i].text });
    }
    const st = liveStreak();
    const dateLabel = new Date(r.date + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
    const legRows = r.legs.length ? Array.from({ length: 7 }, (_, i) => {
      const l = r.legs[i];
      const eff = l ? E.legEffective(l.raw) : 0;
      const t = legRarest(l);
      return `<li class="legrow ${t >= 0 ? 't' + t : ''}"><span class="n">${i + 1}</span><span class="cat"><span>${esc(cats[i].text)}</span><span class="bar"><i style="width:${clamp((eff / C.legCap) * 100, 0, 100).toFixed(1)}%"></i></span></span><span class="g">+${fmt(eff)}</span>${t >= 0 ? ICON[t].replace('<svg', `<svg aria-label="Rarest find: ${tierName(t)}"`) : '<span></span>'}</li>`;
    }).join('') : '';
    const note = r.final >= C.summitAlt ? 'You stood on the roof of the world.' : nx ? `${fmt(nx.alt - r.final)} m short of ${nx.name}.` : '';
    const html = `
      <header class="res-head">
        <p class="eyebrow">Climb ${r.puzzle}, ${esc(dateLabel)}</p>
        <h2 class="res-mile">${esc(m.name)}</h2>
        <p class="res-alt">${fmt(r.final)}<small> m</small></p>
        <p class="res-note">${isPB ? '<span class="pb">Personal best</span>' : ''}${esc(note)}</p>
      </header>
      ${r.forfeited ? '<p class="forfeit">You left mid-climb, so this round was scored on the answers you’d entered.</p>' : ''}
      ${r.extra ? '<p class="res-note">Extra time was on for this climb.</p>' : ''}
      ${alpacaRides(r).n ? `<p class="res-note res-rides"><span aria-hidden="true">🦙</span> Alpaca rides: <b>${alpacaRides(r).n}</b></p>` : ''}
      <section aria-label="The climb"><h3>The climb</h3><ol class="legrows">${legRows}</ol></section>
      <section aria-label="Best finds"><h3>Best finds</h3>${best.length ? `<ul class="finds">${best.map((a) => `<li class="find"><span class="chip t${a.tier}">${ICON[a.tier]}<span class="txt">${esc(a.c)}</span></span><span class="where">${tierName(a.tier)} · ${esc(a.cat)}</span></li>`).join('')}</ul>` : '<p class="res-note">No answers found this time.</p>'}</section>
      ${gems.length ? `<section aria-label="Missed gems"><h3>Missed gems</h3><ul class="finds">${gems.map((g) => `<li class="find"><span class="chip t${g.e.tier}">${ICON[g.e.tier]}<span class="txt">${esc(g.e.canon)}</span></span><span class="where">${tierName(g.e.tier)} · ${esc(g.cat)}</span></li>`).join('')}</ul></section>` : ''}
      <section aria-label="Share"><h3>Share</h3><pre class="share-box" id="share-box">${esc(shareText(r))}</pre>
        <div class="res-actions"><button class="btn btn-primary" id="btn-copy">Copy result</button><button class="btn btn-ghost" id="btn-res-home">Back to base</button></div></section>
      <section aria-label="Expedition"><div class="res-foot">
        <div class="fact"><dt>Streak</dt><dd>${st}<small> day${st === 1 ? '' : 's'}</small></dd></div>
        <div class="fact"><dt>Best</dt><dd>${fmt(Math.max(prevBest, r.final))}<small> m</small></dd></div>
        <div class="fact"><dt>Next climb</dt><dd id="res-next">${hm(msToMidnight())}</dd></div>
      </div><button class="btn-link" id="btn-res-stats">See your expedition log</button></section>`;
    const sheet = $('#sheet');
    sheet.innerHTML = html;
    sheet.scrollTop = 0;
    show('results');
    Scene.setGhost(prevBest && prevBest > r.final ? prevBest : null);
    Scene.setClimb(r.final, { snap: !(o && o.fresh) });
    setNight();
    $('#btn-copy').onclick = copyShare;
    $('#btn-res-home').onclick = renderHome;
    $('#btn-res-stats').onclick = openStats;
    if (o && o.fresh) {
      announce(`Climb complete. ${fmt(r.final)} meters, ${m.name}.`);
      if (r.final >= C.summitAlt) { Scene.confetti(); Sound.play('t4'); }
    }
    $('.res-mile').setAttribute('tabindex', '-1');
    $('.res-mile').focus({ preventScroll: true });
  }

  async function copyShare() {
    const btn = $('#btn-copy');
    const text = shareText(G.round);
    try {
      await navigator.clipboard.writeText(text);
      btn.textContent = 'Copied';
    } catch (e) {
      const box = $('#share-box');
      const sel = window.getSelection(); const rg = document.createRange(); rg.selectNodeContents(box); sel.removeAllRanges(); sel.addRange(rg);
      btn.textContent = 'Selected: press Ctrl+C or ⌘C';
    }
    setTimeout(() => { if (btn.isConnected) btn.textContent = 'Copy result'; }, 2400);
  }

  // ---------------------------------------------------------------- dialogs
  function openDialog(id) { const d = $(id); if (!d.open) { try { d.showModal(); } catch (e) { d.setAttribute('open', ''); } } }
  function closeDialogs() { document.querySelectorAll('dialog[open]').forEach((d) => { try { d.close(); } catch (e) { d.removeAttribute('open'); } }); }
  document.querySelectorAll('dialog').forEach((d) => {
    d.addEventListener('click', (e) => { if (e.target === d || e.target.closest('[data-close]')) { d.close(); refocus(); } });
    d.addEventListener('close', refocus);
  });
  function refocus() { if (G.screen === 'play') ui.input.focus({ preventScroll: true }); }

  // Help copy is generated from CONFIG so tuning never leaves stale numbers behind.
  function renderHelp() {
    const secs = C.legs.map((l) => l.secs), mults = C.legs.map((l) => l.mult);
    const pen = C.invalidPenaltySecs;
    $('#rules').innerHTML = [
      'Every day, everyone gets the same seven categories. You get one scored climb.',
      'Each category is a timed leg. Type an answer and press Enter. Keep going until time runs out.',
      `Rarer valid answers climb higher. Each answer in a row adds a ${Math.round(C.chainStep * 100)}% bonus, up to ${Math.round(C.chainMax * 100)}%.`,
      `A wrong answer costs ${pen} second${pen === 1 ? '' : 's'} and resets that bonus. Repeats cost nothing.`,
      `Small typos and sound-alike spellings are corrected automatically, for answers of ${C.correct.shortLen} letters or more.`,
      `Some categories accept a variant of an answer, like “women’s soccer” in Sports. A variant scores like the answer it’s based on, up to ${C.maxQualifiedPerLeg} per leg.`,
      `The air thins: timers shrink from ${Math.max(...secs)} to ${Math.min(...secs)} seconds, but later legs score up to ${Math.max(...mults)}×.`,
      `Each leg counts in full up to ${fmt(C.legFullUpTo)} m, then at ${Math.round(C.legOverRate * 100)}%, to a limit of ${fmt(C.legCap)} m.`,
    ].map((t) => `<li>${t}</li>`).join('');
    $('#help-miles').textContent = 'Milestones: ' + C.milestones.map((m) => `${m.name} ${fmt(m.alt)} m`).join(', ') + '.';
    $('#tier-table').innerHTML = '<tbody>' + C.tiers.map((t, i) => `<tr class="t${i}"><td><span class="badge">${ICON[i]}${t.name}</span></td><td class="theme">${t.theme}</td><td>+${t.gain} m</td></tr>`).join('') + '</tbody>';
  }
  function openStats() {
    const rs = completedRounds();
    const n = rs.length;
    const avg = n ? rs.reduce((s, r) => s + r.final, 0) / n : 0;
    const best = n ? Math.max(...rs.map((r) => r.final)) : 0;
    const summits = rs.filter((r) => r.final >= C.summitAlt).length;
    const dist = C.tiers.map(() => 0);
    let rarest = null;
    rs.forEach((r) => r.legs.forEach((l, i) => l && l.answers.forEach((a) => {
      if (a.s !== 'ok') return;
      dist[a.tier]++;
      if (!rarest || a.tier > rarest.tier || (a.tier === rarest.tier && r.date > rarest.date)) rarest = { tier: a.tier, c: a.c, date: r.date, cat: (DATA.categories.find((c) => c.id === r.catIds[i]) || {}).text || '' };
    })));
    const maxD = Math.max(1, ...dist);
    let rides = 0, longestRide = null;
    rs.forEach((r) => { const ar = alpacaRides(r); rides += ar.n; if (ar.longest && (!longestRide || ar.longest.g > longestRide.g)) longestRide = ar.longest; });
    const s = Store.data.streak;
    $('#stats-body').innerHTML = `
      <div class="stat-grid">
        <div class="fact"><dt>Climbs</dt><dd>${n}</dd></div>
        <div class="fact"><dt>Average</dt><dd>${n ? fmt(avg) + '<small> m</small>' : '—'}</dd></div>
        <div class="fact"><dt>Best</dt><dd>${n ? fmt(best) + '<small> m</small>' : '—'}</dd></div>
        <div class="fact"><dt>Summits</dt><dd>${summits}</dd></div>
        <div class="fact"><dt>Streak</dt><dd>${liveStreak()}</dd></div>
        <div class="fact"><dt>Rest days</dt><dd>${s.tokens}</dd></div>
        <div class="fact"><dt>Alpaca rides</dt><dd>${rides}</dd></div>
        <div class="fact"><dt>Longest ride</dt><dd>${longestRide ? fmt(longestRide.g) + '<small> m</small>' : '—'}</dd></div>
      </div>
      ${longestRide ? `<p class="res-note"><span aria-hidden="true">🦙</span> Longest alpaca ride: +${fmt(longestRide.g)} m for <b>${esc(longestRide.c)}</b> (${esc(longestRide.cat)}).</p>` : ''}
      <p>Longest streak: ${s.best} day${s.best === 1 ? '' : 's'}. You earn one rest day for every 14 days in a row; it covers a single missed day.</p>
      ${rarest ? `<div class="find"><span class="chip t${rarest.tier}">${ICON[rarest.tier]}<span class="txt">${esc(rarest.c)}</span></span><span class="where">Rarest find · ${esc(rarest.cat)}</span></div>` : ''}
      <div class="dist" aria-label="Finds by rarity">${C.tiers.map((t, i) => `<div class="dist-row t${i}"><span class="badge">${ICON[i]}${t.name}</span><span class="bar"><i style="width:${((dist[i] / maxD) * 100).toFixed(1)}%"></i></span><span class="v">${dist[i]}</span></div>`).join('')}</div>`;
    openDialog('#dlg-stats');
  }
  function openSettings() {
    const st = Store.data.settings;
    $('#set-sound').checked = !!st.sound;
    $('#set-motion').checked = isReduced();
    $('#set-extra').checked = !!st.extra;
    $('#set-extra').disabled = G.screen === 'play';
    renderJudge();
    openDialog('#dlg-settings');
  }
  function isReduced() {
    const v = Store.data.settings.reduced;
    if (v === true || v === false) return v;
    try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (e) { return false; }
  }
  function applyMotion() { const r = isReduced(); Scene.setReduced(r); document.documentElement.classList.toggle('reduced', r); }
  function applySound() {
    const b = $('#btn-sound');
    b.setAttribute('aria-pressed', String(!!Store.data.settings.sound));
    b.setAttribute('aria-label', Store.data.settings.sound ? 'Sound on' : 'Sound off');
  }

  // ---------------------------------------------------------------- wiring
  // Enter is handled on the key itself: sandboxed frames (like the claude.ai viewer)
  // can block form submission before any submit event fires.
  $('#answer-form').addEventListener('submit', (e) => { e.preventDefault(); submit(); });
  ui.input.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.keyCode !== 13) return;
    if (e.isComposing || e.keyCode === 229) return;
    e.preventDefault();
    submit();
  });
  const send = $('#btn-send');
  send.addEventListener('pointerdown', (e) => e.preventDefault());
  send.addEventListener('mousedown', (e) => e.preventDefault());
  send.addEventListener('click', () => { submit(); ui.input.focus({ preventScroll: true }); });
  ui.input.addEventListener('paste', (e) => { if (G.state === 'leg') { e.preventDefault(); setFeedback('Pasting is off during a leg.', 'dup'); } });
  ui.input.addEventListener('drop', (e) => e.preventDefault());
  ui.play.addEventListener('pointerdown', (e) => {
    if (e.target === ui.input || e.target.closest('button')) return;
    if (['leg', 'countdown', 'settle', 'transition'].includes(G.state)) setTimeout(() => ui.input.focus({ preventScroll: true }), 0);
  });
  $('#btn-begin').addEventListener('click', beginDaily);
  $('#btn-practice').addEventListener('click', beginPractice);
  $('#help-practice').addEventListener('click', beginPractice);
  $('#btn-help').addEventListener('click', () => openDialog('#dlg-help'));
  $('#btn-stats').addEventListener('click', openStats);
  $('#btn-settings').addEventListener('click', openSettings);
  $('#btn-sound').addEventListener('click', () => {
    Store.data.settings.sound = !Store.data.settings.sound; Store.save(); applySound();
    if (Store.data.settings.sound) { Sound.ensure(); Sound.play('t1'); }
  });
  $('#btn-judge').addEventListener('click', () => Judge.enable());
  $('#set-judge').addEventListener('click', () => Judge.enable());
  $('#set-sound').addEventListener('change', (e) => { Store.data.settings.sound = e.target.checked; Store.save(); applySound(); if (e.target.checked) Sound.ensure(); });
  $('#set-motion').addEventListener('change', (e) => { Store.data.settings.reduced = e.target.checked; Store.save(); applyMotion(); });
  $('#set-extra').addEventListener('change', (e) => { Store.data.settings.extra = e.target.checked; Store.save(); });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && G.screen === 'home' && document.activeElement === document.body) beginDaily();
  });

  // ===========================================================================
  // Dev mode (password-locked; the tools live in src/dev.js)
  // Everything here runs only in G.mode 'dev' or when src/dev.js calls it after
  // an unlock. A dev climb is the normal game with endless legs and laps, saved
  // to DevStore; it never writes the real save, streak or daily round.
  // ===========================================================================
  const findCat = (id) => ALL.find((c) => c.id === id);
  const devPaused = () => G.mode === 'dev' && !!G.dev && G.dev.paused;
  const devActive = () => G.mode === 'dev' && !!G.round && !G.round.completed;
  const devLegLive = () => devActive() && G.state === 'leg' && !!curLeg();

  function ensureDev() {
    if (!G.dev) G.dev = { speed: 1, freeze: false, night: null, nextPos: null, nextCat: null };
    Object.assign(G.dev, { paused: false, pausedAt: 0, holdAtPause: 0, infinite: false, skipTransition: false, lastTick: now() });
    return G.dev;
  }

  // Wall-clock speed, freeze and infinite time work by moving the leg deadline.
  function devTick() {
    if (G.mode !== 'dev' || !G.dev) return;
    const d = G.dev, t = now(), dt = t - (d.lastTick || t);
    d.lastTick = t;
    if (G.state !== 'leg' || d.paused || dt <= 0) return;
    const leg = curLeg();
    if (!leg) return;
    if (d.freeze || d.infinite) { leg.deadline += dt; return; }
    if (d.speed !== 1 && t >= G.pauseUntil) leg.deadline -= (d.speed - 1) * dt;
  }

  function devNextPos() {
    if (G.dev.nextPos != null) return G.dev.nextPos;
    const legs = G.round.legs, last = legs[legs.length - 1];
    return last ? (last.pos + 1) % 7 : 0;
  }
  function devPrepareLeg(i) {
    const d = G.dev;
    const pos = devNextPos();
    d.nextPos = null;
    d.infinite = false;
    if (!G.cats[i]) {
      const prev = i > 0 && G.cats[i - 1] ? G.cats[i - 1].id : null;
      G.cats[i] = (d.nextCat && findCat(d.nextCat)) || devPickCat(pos, prev);
      d.nextCat = null;
      G.index[i] = E.buildIndex(G.cats[i]);
    }
    return pos;
  }
  // Each pool is dealt in shuffled cycles, so every category comes up once per
  // cycle and never twice in a row.
  function devPickCat(pos, prevId) {
    const kind = C.legKinds[pos], d = G.dev;
    const ids = DATA.categories.filter((c) => c.kind === kind).map((c) => c.id).sort();
    const perm = (cycle) => E.shuffled(ids, E.hashStr(`dev:${d.seed}:${kind}:${cycle}`));
    const q = d.queues[kind] || (d.queues[kind] = { cycle: 0, at: 0, perm: perm(0) });
    for (let guard = 0; guard < ids.length * 2 + 2; guard++) {
      if (q.at >= q.perm.length) { q.cycle += 1; q.at = 0; q.perm = perm(q.cycle); }
      const id = q.perm[q.at++];
      if (id !== prevId || ids.length === 1) return findCat(id);
    }
    return findCat(ids[0]);
  }

  // Passing the summit: hold the clock, climb to the top, plant the flag,
  // celebrate, then drop back to Lukla and climb on to where the total says.
  function devLapUp() {
    const st = devLap(), d = G.dev;
    if (G.state === 'leg') holdClock(2200);
    const instant = isReduced();
    Scene.setClimb(C.summitAlt, instant ? { snap: true } : undefined);
    Scene.confetti();
    Sound.play('t4');
    announce(`Summit. Lap ${st.lap} begins.`);
    devEmit('lap', st.lap);
    clearTimeout(d.lapT1); clearTimeout(d.lapT2);
    d.lapT1 = setTimeout(() => { if (G.mode === 'dev') Scene.setClimb(C.summitAlt, { snap: true }); }, instant ? 0 : 1000);
    d.lapT2 = setTimeout(() => {
      if (G.mode !== 'dev' || !G.round) return;
      Scene.setClimb(C.startAlt, { snap: true });
      Scene.setClimb(totalAltitude(), instant ? { snap: true } : undefined);
      setNight();
    }, 2000);
  }

  function startDev() {
    if (devActive()) return;
    if (!['idle', 'results'].includes(G.state)) return;
    closeDialogs();
    const settings = Object.assign({}, RealStore.data.settings);
    Store = DevStore;
    DevStore.load();
    DevStore.data.settings = settings;
    if (settings.sound) Sound.ensure();
    G.mode = 'dev';
    const d = ensureDev();
    d.queues = {};
    d.seed = Math.floor(Math.random() * 1e9);
    G.cats = []; G.index = [];
    G.round = { v: 2, dev: true, startedAt: now(), extra: !!settings.extra, legs: [], offset: 0, completed: false };
    DevStore.data.devRound = G.round;
    DevStore.save();
    G.legIdx = 0; G.state = 'countdown';
    Scene.setClimb(C.startAlt, { snap: true });
    Scene.setGhost(null);
    enterPlay();
    devEmit('dev-start');
    const round = G.round;
    countdown().then(() => { if (G.round === round && G.state === 'countdown' && !round.completed) startLeg(0); });
  }

  function finishDev(o) {
    if (G.mode !== 'dev' || !G.round) return;
    const r = G.round, d = ensureDev();
    clearTimeout(d.lapT1); clearTimeout(d.lapT2);
    cancelRides();
    clearSpotlight();
    $('#transition').hidden = true;
    $('#countdown').hidden = true;
    G.peek = false;
    r.legs.forEach((l) => {
      if (!l) return;
      l.answers.forEach((a) => { if (a.s === 'pending') a.s = 'unchecked'; });
      if (!l.ended) { l.eff = E.legEffective(l.raw); l.ended = now(); }
    });
    r.completed = true;
    r.finishedAt = now();
    if (o && o.forfeit) r.forfeited = true;
    G.state = 'results';
    save();
    showDevResults(r);
    devEmit('dev-end');
  }

  function showDevResults(r) {
    const st = devLap();
    const answers = [];
    r.legs.forEach((l) => l && l.answers.forEach((a) => { if (a.s === 'ok') answers.push(Object.assign({ cat: (findCat(l.catId) || { text: l.catId }).text }, a)); }));
    const legsPlayed = r.legs.filter(Boolean).length;
    const rows = C.tiers.map((t, i) => {
      const mine = answers.filter((a) => a.tier === i).sort((a, b) => b.raw - a.raw);
      const top = mine[0];
      return `<li class="find"><span class="badge t${i}">${ICON[i]}${t.name}</span>${top ? `<span class="chip t${i}"><span class="txt">${esc(top.c)}</span></span><span class="where">${esc(top.cat)} · ${mine.length} found</span>` : '<span class="where">None found</span>'}</li>`;
    }).join('');
    $('#sheet').innerHTML = `
      <header class="res-head">
        <p class="eyebrow">Dev climb · not saved to your real stats</p>
        <h2 class="res-mile">Lap ${st.lap}</h2>
        <p class="res-alt">${fmt(st.total)}<small> m climbed</small></p>
        <p class="res-note">Ended at ${fmt(st.alt)} m on lap ${st.lap}.</p>
      </header>
      ${r.forfeited ? '<p class="forfeit">Simulated reload: this dev climb was forfeited and scored on the answers entered.</p>' : ''}
      <section aria-label="The climb"><div class="res-foot">
        <div class="fact"><dt>Laps done</dt><dd>${st.lap - 1}</dd></div>
        <div class="fact"><dt>Legs played</dt><dd>${legsPlayed}</dd></div>
        <div class="fact"><dt>Answers</dt><dd>${answers.length}</dd></div>
      </div></section>
      <section aria-label="Best find per rank"><h3>Best find per rank</h3><ul class="finds">${rows}</ul></section>
      <div class="res-actions"><button class="btn btn-primary" id="btn-dev-again">New dev climb</button><button class="btn btn-ghost" id="btn-dev-home">Back to base</button></div>`;
    $('#sheet').scrollTop = 0;
    show('results');
    Scene.setGhost(null);
    Scene.setClimb(totalAltitude(), { snap: true });
    setNight();
    $('#btn-dev-again').onclick = startDev;
    $('#btn-dev-home').onclick = exitDev;
    announce(`Dev climb ended. ${fmt(st.total)} meters climbed over ${legsPlayed} legs, lap ${st.lap}.`);
    $('.res-mile').setAttribute('tabindex', '-1');
    $('.res-mile').focus({ preventScroll: true });
  }

  function exitDev() {
    if (devActive()) finishDev();
    if (G.dev) { clearTimeout(G.dev.lapT1); clearTimeout(G.dev.lapT2); G.dev.paused = false; }
    Store = RealStore;
    G.mode = 'daily';
    G.round = null; G.cats = []; G.index = [];
    renderHome();
    devEmit('dev-exit');
  }

  function resumeDev(r) {
    G.mode = 'dev';
    G.round = r;
    ensureDev();
    G.cats = r.legs.map((l) => l && findCat(l.catId));
    G.index = G.cats.map((c) => c && E.buildIndex(c));
    r.legs.forEach((l) => l && l.answers.forEach((a) => { if (a.s === 'pending') a.s = 'unchecked'; }));
    G.legIdx = Math.max(0, r.legs.length - 1);
    Scene.setClimb(totalAltitude(), { snap: true });
    G.state = 'countdown';
    enterPlay();
    const leg = r.legs[G.legIdx];
    if (leg && !leg.ended && leg.deadline > now()) {
      G.state = 'leg';
      G.lastSec = -1;
      setLegHeader(G.legIdx, leg.total / 1000, C.legs[leg.pos].mult);
      leg.answers.filter((a) => a.s === 'ok').forEach((a) => ui.chips.prepend(chipEl(a)));
      renderLegDots(); setNight();
      devEmit('leg-start', G.legIdx);
    } else if (leg && !leg.ended) { G.state = 'leg'; endLeg(); }
    else startLeg(leg ? G.legIdx + 1 : 0);
  }

  // Tears the climb down, re-reads the dev save from storage and then either
  // forfeits it (like a real reload) or resumes it (like an artifact hot reload).
  function devSimulateReload(kind) {
    if (!devActive()) return 'Start a dev climb first.';
    save();
    cancelRides();
    clearSpotlight();
    clearTimeout(G.dev.lapT1); clearTimeout(G.dev.lapT2);
    $('#transition').hidden = true;
    $('#countdown').hidden = true;
    G.state = 'idle'; G.peek = false; G.round = null;
    DevStore.load();
    const r = DevStore.data.devRound;
    if (!r || !Array.isArray(r.legs)) { exitDev(); return 'The dev save could not be read back. Storage may be blocked here.'; }
    G.dev.paused = false;
    if (kind === 'forfeit') {
      G.round = r;
      finishDev({ forfeit: true });
      return 'Reloaded from the dev save: the climb was forfeited and scored as it stood.';
    }
    resumeDev(r);
    return 'Reloaded from the dev save: the climb resumed where it was.';
  }

  // ---------------------------------------------------------------- dev tools
  function devPause(on) {
    if (G.mode !== 'dev' || !G.dev) return false;
    const d = G.dev, want = on == null ? !d.paused : !!on;
    if (want === d.paused) return d.paused;
    const t = now();
    if (want) { d.paused = true; d.pausedAt = t; d.holdAtPause = G.pauseUntil; }
    else {
      const leg = curLeg();
      // Credit the paused time, minus any part a spotlight hold already covered.
      if (leg && G.state === 'leg') leg.deadline += Math.max(0, t - Math.max(d.pausedAt, Math.min(d.holdAtPause || 0, t)));
      d.paused = false;
      d.lastTick = t;
      save();
    }
    announce(want ? 'Paused' : 'Resumed');
    devEmit('pause', d.paused);
    return d.paused;
  }
  function devEndLegNow(skipTransition) {
    if (!devLegLive()) return false;
    if (G.dev.paused) devPause(false);
    G.dev.infinite = false;
    if (skipTransition) G.dev.skipTransition = true;
    curLeg().deadline = now();
    endLeg();
    return true;
  }
  function devAddTime(ms) {
    if (!devLegLive()) return false;
    const leg = curLeg();
    leg.deadline += ms;
    const rem = leg.deadline - Math.max(now(), G.pauseUntil);
    if (rem > leg.total) leg.total = rem;
    save();
    return true;
  }
  function devSetAltitude(a) {
    if (!devActive()) return false;
    const st = devLap();
    const alt = clamp(Number(a) || C.startAlt, C.startAlt, C.summitAlt - 0.5);
    G.round.offset = (G.round.offset || 0) + ((st.lap - 1) * st.span + (alt - C.startAlt) - st.total);
    Scene.setClimb(totalAltitude());
    setNight(); save();
    return true;
  }
  function devSetLap(n) {
    if (!devActive()) return false;
    const st = devLap();
    const lap = Math.max(1, Math.round(Number(n) || 1));
    G.round.offset = (G.round.offset || 0) + (lap - st.lap) * st.span;
    save();
    return true;
  }
  function devFireRank(tier) {
    Sound.force = true; Sound.play('t' + tier); Sound.force = false;
    Scene.burst(tier);
    if (tier === 2) buzz(15);
    if (tier === 3) { flash('m'); buzz([15, 40, 25]); }
    if (tier === 4) { Scene.confetti(); flash('s'); buzz([20, 50, 20, 50, 40]); }
    const ix = G.index[G.legIdx];
    const pick = ix && ix.entries.find((e) => e.tier === tier);
    const fake = { id: -1, c: pick ? pick.canon : 'Test find', tier };
    const eff = C.tiers[tier].gain;
    if (G.screen === 'play') {
      if (C.tiers[tier].pause) spotlight(fake, eff, { noHold: true });
      else gainPop(fake, eff);
    }
    announce(`Effect test: ${tierName(tier)}`);
  }
  function devPlaySound(kind) { Sound.force = true; Sound.play(kind); Sound.force = false; }
  // Effects tab: plays an alpaca ride without changing the score or holding the clock.
  // o: { style, band ('auto' or a band), golden, late, spit, meters, reduced }
  const RIDE_BAND_ALT = { grass: 3300, trail: 4500, glacier: 6000, deathzone: 8100 };
  function devPlayRide(o) {
    const meters = clamp(Math.round(Number(o.meters) || 0), 0, 1500);
    const back = Scene.alt;
    const from = o.band && o.band !== 'auto' ? RIDE_BAND_ALT[o.band] : back;
    const to = Math.min(C.summitAlt, from + meters);
    const ix = G.index && G.index[G.legIdx];
    const pick = ix && ix.entries.find((e) => e.tier === 4);
    const answer = pick ? pick.canon : 'Test find';
    if (o.reduced) {
      if (G.screen === 'play') setFeedback(`Carried up by alpacas · +${fmt(to - from)} m`);
      announce(rideSentence(from, to, to - from, null));
      devEmit('ride', { plan: { reduced: true }, ans: { c: answer }, eff: to - from, test: true });
      return `Reduced-motion preview: "Carried up by alpacas · +${fmt(to - from)} m", no ride.`;
    }
    const force = { golden: !!o.golden, late: !!o.late, spit: !!o.spit };
    if (o.style && o.style !== 'auto') force.style = o.style;
    if (o.band && o.band !== 'auto') force.band = o.band;
    const seed = 'dev:' + Date.now();
    const plan = E.ridePlan({ fromAlt: from, toAlt: to, meters: to - from, night: Scene.night || ui.app.classList.contains('night'), seed, force });
    Scene.cancelRide();
    Scene.setClimb(from, { snap: true });
    const pl = $('#play'); if (G.screen === 'play') pl.classList.add('riding');
    devEmit('ride', { plan, ans: { c: answer }, eff: to - from, test: true });
    Scene.ride(plan, { fromAlt: from, toAlt: to, answer, seed, on: (n, p) => { Sound.force = true; rideCue(n, p); Sound.force = false; } }).then(() => {
      if (!G.rideActive) pl.classList.remove('riding');
      Scene.setClimb(G.round && G.screen === 'play' ? totalAltitude() : back, { snap: true });
    });
    return `Alpaca ride: ${plan.style} · ${plan.band}${plan.golden ? ' · golden' : ''}${plan.late ? ' · late' : ''}${plan.spit ? ' · spit' : ''} · +${fmt(to - from)} m (${(plan.durationMs / 1000).toFixed(1)} s)`;
  }
  function devPlantFlag() {
    Scene.setClimb(C.summitAlt, { snap: true });
    Scene.burst(4); Scene.confetti();
    devPlaySound('t4');
  }
  function devSubmit(text) {
    if (!devLegLive()) return false;
    const keep = ui.input.value;
    ui.input.value = text;
    submit();
    ui.input.value = keep;
    return true;
  }
  function withStore(store, fn) { const prev = Store; Store = store; try { return fn(); } finally { Store = prev; } }
  function devResetRealSave(withJudge) {
    if (G.mode === 'daily' && G.round && !G.round.completed && G.screen === 'play') return 'Finish or leave the daily climb first.';
    RealStore.clear();
    if (withJudge) { try { localStorage.removeItem(JKEY); } catch (e) { /* blocked */ } Judge.cache = {}; }
    if (Store === RealStore) { applyMotion(); applySound(); }
    if (G.mode === 'daily' && (G.screen === 'home' || G.screen === 'results')) renderHome();
    return 'Deleted the real save' + (withJudge ? ' and the answer-checker cache.' : '.');
  }
  function devResetDevSave() {
    DevStore.clear();
    if (devActive()) { DevStore.data.settings = Object.assign({}, RealStore.data.settings); DevStore.data.devRound = G.round; DevStore.save(); }
    return 'Deleted the dev save.';
  }

  let devHookObj = null;
  function devHooks() {
    if (devHookObj) return devHookObj;
    devHookObj = {
      E, C, ALL, DATA, ICON, Scene, Sound, Judge, RealStore, DevStore, G, ui, KEY, JKEY, DEV_KEY,
      get store() { return Store; },
      listen(fn) { devListener = fn; },
      fmt, esc, tierName, announce, isReduced, renderJudge, renderHome, curLeg, legPos,
      devTotal, devLap, devActive, devLegLive,
      startDev, finishDev, exitDev, simulateReload: devSimulateReload,
      pause: devPause, endLegNow: devEndLegNow, addTime: devAddTime,
      setSpeed(x) { if (!G.dev) ensureDev(); G.dev.speed = x; G.dev.lastTick = now(); },
      setFreeze(on) { if (!G.dev) ensureDev(); G.dev.freeze = !!on; },
      setInfinite(on) { if (!devLegLive()) return false; G.dev.infinite = !!on; return true; },
      jumpLeg(pos) { if (!G.dev) ensureDev(); G.dev.nextPos = pos; if (devLegLive()) devEndLegNow(true); },
      setNextCat(id) { if (!G.dev) ensureDev(); G.dev.nextCat = id || null; },
      setAltitude: devSetAltitude, setLap: devSetLap,
      setNight(v) { if (!G.dev) ensureDev(); G.dev.night = v; setNight(); },
      fireRank: devFireRank, playSound: devPlaySound, plantFlag: devPlantFlag, playRide: devPlayRide,
      confetti() { Scene.confetti(); }, rejectFx() { rejectFx('zzq', ' · −1 s'); },
      submit: devSubmit,
      openStatsWith(store) { withStore(store, openStats); },
      recordClimbToday(store) { return withStore(store, () => { updateStreak(E.localDateStr()); store.save(); return Object.assign({}, store.data.streak); }); },
      liveStreakOf(store) { return withStore(store, liveStreak); },
      resetRealSave: devResetRealSave, resetDevSave: devResetDevSave,
    };
    return devHookObj;
  }
  // Hands src/dev.js a way to get the hooks. It asks only after a correct password.
  function devInit() {
    const D = window.DA_DEV;
    if (devInit.done || !D || typeof D.init !== 'function') return;
    devInit.done = true;
    try { D.init(devHooks); } catch (e) { /* dev mode is optional */ }
  }

  // ---------------------------------------------------------------- boot
  function resumeRound(r) {
    G.mode = 'daily'; G.round = r; G.today = r.date; G.puzzle = r.puzzle;
    G.cats = r.catIds.map((id) => DATA.categories.find((c) => c.id === id));
    G.index = G.cats.map(E.buildIndex);
    r.legs.forEach((l) => l && l.answers.forEach((a) => { if (a.s === 'pending') a.s = 'unchecked'; }));
    G.legIdx = Math.max(0, r.legs.length - 1);
    Scene.setClimb(totalAltitude(), { snap: true });
    G.state = 'countdown';
    enterPlay();
    const leg = r.legs[G.legIdx];
    if (leg && !leg.ended && leg.deadline > now()) {
      G.state = 'leg';
      ui.category.textContent = G.cats[G.legIdx].text; ui.category.classList.remove('veiled');
      $('#leg-label').textContent = `Leg ${G.legIdx + 1} of 7`;
      $('#leg-mult').textContent = `${Math.round(leg.total / 1000)} s  ×${C.legs[G.legIdx].mult}`;
      leg.answers.filter((a) => a.s === 'ok').forEach((a) => ui.chips.prepend(chipEl(a)));
      renderLegDots(); setNight();
    } else if (G.legIdx >= 6 && leg && leg.ended) finishRound();
    else if (leg && !leg.ended) { G.state = 'leg'; endLeg(); }
    else startLeg(leg ? G.legIdx + 1 : 0);
  }

  function start(hot) {
    Store.load();
    applyMotion(); applySound(); renderHelp();
    Scene.start();
    G.today = E.localDateStr();
    // finalize abandoned rounds (spec §8.1: leaving mid-round forfeits)
    let forfeitToday = null;
    for (const [date, r] of Object.entries(Store.data.rounds)) {
      if (!r || r.completed) continue;
      if (date === G.today && hot && hot.resume) { resumeRound(r); Judge.init(); devInit(); return; }
      r.legs.forEach((l) => l && l.answers.forEach((a) => { if (a.s === 'pending') a.s = 'unchecked'; }));
      r.completed = true; r.forfeited = true;
      r.final = E.finalAltitude(r.legs.map((l) => (l ? l.raw : 0)));
      updateStreak(r.date);
      if (date === G.today) forfeitToday = r;
    }
    Store.save();
    renderHome();
    if (forfeitToday) showResults(forfeitToday);
    else if (!Store.data.seenIntro) { openDialog('#dlg-help'); Store.data.seenIntro = true; Store.save(); }
    Judge.init();
    devInit();
  }

  const hot = window.claude && window.claude.hot;
  if (hot && typeof hot.snapshot === 'function') {
    try { hot.snapshot(() => ({ resume: G.mode === 'daily' && !!G.round && !G.round.completed })); } catch (e) { /* optional */ }
  }
  if (hot && typeof hot.ready === 'function') hot.ready(start);
  else start((hot && hot.data) || {});
})();
