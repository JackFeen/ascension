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
  // 8 x 8 pixel icons (crisp at 16 px): dot, tree, diamond, sparkle, peak with a flag
  const pxIcon = (d) => `<svg viewBox="0 0 8 8" aria-hidden="true" fill="currentColor" shape-rendering="crispEdges"><path d="${d}"/></svg>`;
  const ICON = [
    pxIcon('M3 2h2v1h1v2h-1v1h-2v-1h-1v-2h1z'),
    pxIcon('M3 0h2v2h1v2h1v2h-2v2h-2v-2h-2v-2h1v-2h1z'),
    pxIcon('M3 0h2v1h1v1h1v1h1v2h-1v1h-1v1h-1v1h-2v-1h-1v-1h-1v-1h-1v-2h1v-1h1v-1h1z'),
    pxIcon('M3 0h2v3h3v2h-3v3h-2v-3h-3v-2h3z'),
    pxIcon('M4 0h3v2h-2v1h-1zM3 3h2v1h1v1h1v1h1v2h-8v-2h1v-1h1v-1h1z'),
  ];
  // a tiny pixel yak for the results' "Yak rides" row
  const ALPACA_ICON = '<svg viewBox="0 0 10 10" aria-hidden="true" fill="currentColor" shape-rendering="crispEdges"><path d="M6 0h1v1h-1zM9 0h1v1h-1zM6 1h4v1h-4zM2 2h3v1h-3zM6 2h4v1h-4zM1 3h9v1h-9zM0 4h10v1h-10zM0 5h9v1h-9zM0 6h9v1h-9zM1 7h7v1h-7zM1 8h2v1h-2zM6 8h2v1h-2zM1 9h2v1h-2zM6 9h2v1h-2z"/></svg>';
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
        // yak ride
        case 'hooves': // clip-clop gallop
          for (let i = 0; i < 12; i++) { const tt = t + i * 0.13 + (i % 2 ? 0.05 : 0); this.tone(i % 2 ? 180 : 230, tt, 0.05, { vol: 0.08, type: 'triangle', attack: 0.002 }); this.hiss(tt, 0.03, 0.05, 2600); }
          break;
        case 'alpaca': // the yak: two low grunts (the sound kind keeps its old name)
          this.tone(150, t, 0.28, { vol: 0.09, type: 'sawtooth', attack: 0.03, glide: 110 });
          this.tone(130, t + 0.34, 0.4, { vol: 0.08, type: 'sawtooth', attack: 0.04, glide: 90 }); break;
        case 'golden': // bright fanfare for the golden yak
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
  // Scene — the mountain as cozy pixel art (CLAUDE.md §8.4)
  // #scene is a low-res "art canvas" (1 art pixel = PX CSS px) that CSS scales up crisply.
  // Built for 60 fps: cached layers redrawn a strip at a time, a sub-pixel CSS shift for
  // smooth motion, and draws capped at 60 a second.
  // ===========================================================================
  const Scene = (() => {
    const K = window.DA_PIXEL;
    const cv = $('#scene');
    // the visible canvas is the art canvas; CSS scales it up (image-rendering: pixelated), so there is no
    // full-screen upscale copy each frame. A whole-device-pixel CSS shift adds sub-pixel smoothness.
    const art = cv, mainCtx = cv.getContext('2d');
    let actx = mainCtx;
    const skyCv = document.createElement('canvas'), skyCtx = skyCv.getContext('2d');
    let W = 0, H = 0, DPR = 1;                  // viewport, CSS px
    let PX = 2, UP = 2, AW = 0, AH = 0, LX = 0, LY = 0;   // art pixel size, integer upscale, art size, canvas origin (device px)
    const bdCv = document.createElement('canvas'), bdG = bdCv.getContext('2d');
    let bdKey = '';
    let skyPix = null, skyAt0 = 0, wLight = null, dLight = null;
    let skyKey = '', shX = 0, shY = 0, shKey = '';         // sub-pixel shift of the canvas (device px)
    let tops = null, rtops = null; // per-column terrain tops, range tops
    // cached layers (world: terrain, scenery, dashed route; and the three ranges), each with a front copy
    // that is drawn and a back copy that is redrawn a strip per frame, then swapped in
    const WMX = 48, WMY = 120, RMX = 40, RMY = 120;
    const mkBuf = () => { const u = document.createElement('canvas'), t = document.createElement('canvas'); return { u, ug: u.getContext('2d'), t, tg: t.getContext('2d'), wr: new Int16Array(64), tops: new Int16Array(64), valid: false, key: '' }; };
    let wFront = mkBuf(), wBack = mkBuf(), wJob = null;
    const RF = [0, 1, 2].map(() => ({ front: mkBuf(), back: mkBuf(), job: null }));
    const cam = { p: 0.5, alt: 5800, sx: 400, sy: 0.1 };
    const tgt = { p: 0.5, alt: 5800, sx: 400, sy: 0.1 };
    let view = 'overview', rect = null, snap = true;
    let climb = C.startAlt, climbTarget = C.startAlt, ghost = null;
    let moving = false, cheerUntil = 0, reduced = false, time = 0, last = performance.now();
    let onFrame = null, skyOverride = null, outfit = null;
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
    // world ↔ art pixels. The camera offset is rounded to whole art pixels each frame
    // so terrain and texture move in pixel steps instead of shimmering.
    let oxA = 0, oyA = 0, sxA = 1, syA = 1;
    function mapCamera() {
      const k = DPR / UP;
      sxA = cam.sx * k; syA = cam.sy * k;
      const fx = ((W / 2 - cam.p * cam.sx) * DPR - LX) / UP, fy = ((H / 2 + cam.alt * cam.sy) * DPR - LY) / UP;
      oxA = Math.floor(fx); oyA = Math.floor(fy);
      shX = Math.round((fx - oxA) * UP); shY = Math.round((fy - oyA) * UP);
      if (shX >= UP) { oxA++; shX = 0; }
      if (shY >= UP) { oyA++; shY = 0; }
    }
    const X = (p) => oxA + p * sxA;
    const Y = (a) => oyA - a * syA;
    const pAt = (x) => (x - oxA) / sxA;
    const altAt = (y) => (oyA - y) / syA;
    const cssToArt = (v) => v * DPR / UP;
    const cssXToArt = (v) => (v * DPR - LX - shX) / UP, cssYToArt = (v) => (v * DPR - LY - shY) / UP;

    // --- colour --------------------------------------------------------------
    const hex = K.rgb, mixc = (a, b, t) => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
    const css = (c, al) => al == null ? `rgb(${c[0] | 0},${c[1] | 0},${c[2] | 0})` : `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${al})`;
    let AMB = [1, 1, 1], HAZE = [200, 220, 240], ambKey = '';
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
    // terrain ramps by altitude band (dark → light)
    const RAMP = {
      grass: K.ramp('#4a7c38', '#60963f', '#78aa4a', '#92be58'),
      scrub: K.ramp('#56583a', '#6e7046', '#888654', '#a29e68'),
      rock: K.ramp('#5c4a52', '#7e6668', '#a08480', '#c49e92'),
      ice: K.ramp('#7896c8', '#a0bee4', '#cce0f4', '#ecf4fc', '#fcfeff'),
      snow: K.ramp('#94a4cc', '#bccae6', '#e2eaf8', '#fafcff'),
    };

    // --- seeded decorations ---------------------------------------------------
    const R = E.rng(2026);
    // fewer trees and houses right by the trail...
    const TRAIL_TREES = [];
    for (let i = 0; i < 7; i++) { const t = { p: 0.01 + i * 0.045 + R() * 0.02, d: 8 + R() * 14, seed: i % 7 }; if (i % 2 === 0) TRAIL_TREES.push(t); }
    TRAIL_TREES.sort((a, b) => a.d - b.d);
    const HOUSES = [{ p: 0.232, d: 34, seed: 5 }, { p: 0.214, d: 12, seed: 9, big: true }];
    HOUSES.sort((a, b) => a.d - b.d);
    // ...and more scenery spread across the face of the mountain (seeded by world position)
    const SCAPE = [];
    {
      // Pieces are placed one by one in "climb view" space (about 1,300 CSS px per unit of p, depth
      // in CSS px below the trail) and a piece is kept only if it has room: 80 px from anything,
      // 190 px from the same kind. So nothing bunches, and no kind repeats in a clump.
      const RS = E.rng(4417), KX = 1300, SYF = 0.556;
      const kept = [];
      const room = (p, d, kind, r0, r1) => {
        for (const o of kept) {
          const dx = (o.p - p) * KX, dy = o.d - d, dd = dx * dx + dy * dy;
          const need = Math.max(r0, o.r, o.kind === kind ? r1 : 0);
          if (dd < need * need) return false;
        }
        return true;
      };
      const keep = (it, r) => { it.r = r; kept.push(it); SCAPE.push(it); };
      // a farmstead and a grazing yak first, with the most room
      const fp = 0.11 + RS() * 0.06, fd = 230 + RS() * 80;
      keep({ p: fp, d: fd, kind: 'farm', seed: 1 }, 120);
      SCAPE.push({ p: fp + 0.016, d: fd + 18, kind: 'plot', seed: 1 });
      keep({ p: 0.035 + RS() * 0.03, d: 190 + RS() * 60, kind: 'yak', seed: 0 }, 110);
      // singles: the kind comes from the altitude band the piece lands in
      const pick = (alt, r) => {
        if (alt < 3450) return r < 46 ? 'tree' : r < 60 ? 'bush' : r < 70 ? 'stone' : r < 76 ? 'cairn' : r < 84 ? 'pair' : null;
        if (alt < 3920) return r < 55 ? 'pine' : r < 66 ? 'stone' : r < 72 ? 'cairn' : r < 80 ? 'pair' : null;
        if (alt < 4300) return r < 16 ? 'cairn' : r < 28 ? 'stone' : r < 38 ? 'chorten' : r < 48 ? 'flagPole' : r < 54 ? 'stoneHut' : null;
        if (alt < 5300) return r < 26 ? 'outcrop' : r < 46 ? 'stone' : r < 52 ? 'maniWall' : r < 58 ? 'cairn' : null;
        if (alt < 8050) return r < 22 ? 'crevasse' : r < 34 ? 'iceRock' : null;
        return r < 16 ? 'snowRock' : null;
      };
      for (let i = 0; i < 900 && kept.length < 90; i++) {
        const p = -0.08 + RS() * 1.1, d = 95 + Math.pow(RS(), 0.9) * 430, seed = Math.floor(RS() * 1000);
        const kind = pick(ground(p) - d / SYF, seed % 100);
        if (!kind || !room(p, d, kind, 80, 190)) continue;
        keep({ p, d, kind, seed }, kind === 'pair' ? 90 : 70);
      }
      SCAPE.sort((a, b) => a.p - b.p);
    }
    const scapeFrom = (p) => { let lo = 0, hi = SCAPE.length; while (lo < hi) { const m = (lo + hi) >> 1; if (SCAPE[m].p < p) lo = m + 1; else hi = m; } return lo; };
    const TENT = ['#f2b81f', '#ef7a1a', '#f2b81f', '#d94f2a', '#3d6fc0', '#f2b81f'];
    function tents(p0, p1, n, seed) { const r = E.rng(seed), out = []; for (let i = 0; i < n; i++) out.push({ p: p0 + (n > 1 ? i / (n - 1) : 0.5) * (p1 - p0) + (r() - 0.5) * 0.002, d: r() * 16, c: TENT[(i + seed) % TENT.length] }); return out.sort((a, b) => a.d - b.d); }
    // overview signs, most important first (they give way in this order when space is short)
    const SIGN_SMALL = { small: true };
    const PLATE_ORDER = ['summit', 'basecamp', 'lukla', 'deathzone', 'camp2', 'camp1', 'teahouse']
      .map((id) => C.milestones.find((m) => m.id === id)).filter(Boolean)
      .concat(C.milestones.filter((m) => !['summit', 'basecamp', 'lukla', 'deathzone', 'camp2', 'camp1', 'teahouse'].includes(m.id)));
    const CAMPS = [tents(0.538, 0.556, 3, 11), tents(0.62, 0.63, 2, 12), tents(0.662, 0.672, 2, 13), tents(0.735, 0.735, 1, 14), tents(0.79, 0.8, 2, 15)];
    const SERACS = [];
    for (let i = 0; i < 9; i++) { const sr = { p: 0.562 + R() * 0.046, d: R() * 14, w: 5 + R() * 9, h: 6 + R() * 10, shade: i % 3 }; if (i % 2 === 0 && i < 8) SERACS.push(sr); }
    SERACS.sort((a, b) => a.d - b.d);
    for (let i = 0; i < 160; i++) R();   // (draws once used by trailside boulders: keeps the stars and clouds where they were)
    const STARS = [];
    for (let i = 0; i < 170; i++) STARS.push({ x: R(), y: Math.pow(R(), 1.3) * 0.75, big: R() < 0.08, ph: R() * 6.28, sp: 0.6 + R() * 2 });
    const CLOUDS = [];
    for (let i = 0; i < 18; i++) CLOUDS.push({ u: -0.4 + R() * 2.2, a: 4350 + R() * 420, w: 70 + R() * 110, seed: i % 5 });

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

    // forested foothills in front of the mid range (low altitudes only)
    function nearAlt(u) { return 2950 + 330 * Math.sin(u * 5.3 + 1) + 170 * Math.sin(u * 13 + 2) + 50 * Math.sin(u * 41 + 0.5); }

    // --- view framing (CSS px, as before) ------------------------------------------
    // where the climber's feet are framed on screen (CSS px), mirrored on the element for tests
    let climberY = -1;
    function noteClimberY(y) { const r = Math.round(y); if (r !== climberY) { climberY = r; cv.dataset.climberY = r; } }
    // the follow (and ride) zoom: metres shown top to bottom, and the p-span left to right. Phones pull
    // out a little further, so the open strip under the answer card shows the slope ahead, not one field
    function followSpan() {
      // phones pull out 1.44× (1.2 × a further 20%); at this zoom sizeClass() drops phones to the
      // medium sprite size class, so scenery and the climber read smaller along with the terrain
      const z = W < 600 ? 1.44 : 1;
      return { range: clamp(H * 1.8 * z, 1350, 2100 * z), wp: clamp(0.3 * (W / H) / 0.462 * z, 0.24, 0.6) };
    }
    function computeTarget() {
      if (view === 'ride') {
        // same zoom as the climb (pixel sprites never scale, so zooming only stretched the terrain,
        // and every zoom frame is a full redraw); the camera pans to frame the herd
        const { range, wp } = followSpan();
        tgt.sy = H / range;
        tgt.sx = W / wp;
        const vv = window.visualViewport;
        const vh = vv && vv.height > 100 ? Math.min(H, vv.height) : H, vTop = vv ? vv.offsetTop : 0;
        tgt.p = pFor(climbTarget) + (0.5 - 0.42) * W / tgt.sx;
        // the herd and its banner need about 110 px above the climber; keep its feet above the keyboard
        let y = vTop + 0.6 * vh;
        if (rect) { const lo = (rect.hud || 80) + 110, hi = rect.y1 - 18; y = hi < lo ? hi : clamp(y, lo, hi); }
        noteClimberY(y);
        tgt.alt = climbTarget - (H / 2 - y) / tgt.sy;
        return;
      }
      if (view === 'follow') {
        const { range, wp } = followSpan();
        tgt.sy = H / range;
        tgt.sx = W / wp;
        tgt.p = pFor(climbTarget) + 0.02 * wp;
        // the climber stands at 72% of the screen, moved up into the open strip below the answer card
        // when the phone keyboard covers the bottom (rect comes from layoutScene()); the zoom never changes
        let y = 0.72 * H;
        if (rect) { const lo = rect.y0 + 60, hi = rect.y1 - 26; y = hi < lo ? hi : clamp(y, lo, hi); }
        noteClimberY(y);
        tgt.alt = climbTarget + (y - H / 2) / tgt.sy;
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
      DPR = Math.min(3, window.devicePixelRatio || 1);
      W = window.innerWidth; H = window.innerHeight;
      PX = Math.min(W, H) >= 900 ? 3 : 2;
      UP = Math.max(1, Math.round(PX * DPR));
      const dw = Math.round(W * DPR), dh = Math.round(H * DPR);
      // one spare art pixel on every side, so the sub-pixel shift never shows an edge
      AW = Math.ceil(dw / UP) + 2; AH = Math.ceil(dh / UP) + 2;
      LX = Math.floor((dw - AW * UP) / 2); LY = Math.floor((dh - AH * UP) / 2);
      for (const c of [art, skyCv]) { c.width = AW; c.height = AH; }
      Object.assign(cv.style, { position: 'fixed', left: LX / DPR + 'px', top: LY / DPR + 'px', right: 'auto', bottom: 'auto', width: AW * UP / DPR + 'px', height: AH * UP / DPR + 'px', imageRendering: 'pixelated', transformOrigin: '0 0', willChange: 'transform' });
      shKey = '';
      const n = AW + 2 * WMX + 2 * M + 8;
      tops = new Int32Array(n); rtops = [new Float32Array(n), new Float32Array(n), new Float32Array(n)];
      skyKey = ''; wFront.valid = false; wJob = null; for (const R of RF) { R.front.valid = false; R.job = null; }
      // mirrored on the element (read-only) so tests can check the art canvas without reaching inside the Scene
      cv.dataset.artW = AW; cv.dataset.artH = AH; cv.dataset.artPx = PX;
      computeTarget();
    }

    // --- drawing helpers (all coordinates in art pixels) -------------------------------
    const tintCache = new WeakMap();
    // draws a sprite at its anchor; tinted sprites follow the time of day (multiply by AMB)
    function tintOf(s) {
      if (!s || !s.cv || !(AMB[0] < 0.995 || AMB[1] < 0.995 || AMB[2] < 0.995)) return s && s.cv;
      let t = tintCache.get(s);
      if (!t || t.key !== ambKey) {
        const c = t ? t.cv : K.canvas(s.w, s.h), g = c.getContext('2d');
        g.globalCompositeOperation = 'source-over'; g.clearRect(0, 0, s.w, s.h); g.drawImage(s.cv, 0, 0);
        g.globalCompositeOperation = 'multiply'; g.fillStyle = css([AMB[0] * 255, AMB[1] * 255, AMB[2] * 255]); g.fillRect(0, 0, s.w, s.h);
        g.globalCompositeOperation = 'destination-in'; g.drawImage(s.cv, 0, 0);
        t = { cv: c, key: ambKey }; tintCache.set(s, t);
      }
      return t.cv;
    }
    function draw(s, x, y, tinted, alpha) {
      if (!s) return;
      const img = tinted ? tintOf(s) : s.cv;
      if (alpha != null) actx.globalAlpha = alpha;
      actx.drawImage(img, Math.round(x - s.ax), Math.round(y - s.ay));
      if (alpha != null) actx.globalAlpha = 1;
    }
    function px(x, y, c, w, h) { actx.fillStyle = c; actx.fillRect(Math.round(x), Math.round(y), w || 1, h || 1); }
    function pline(x0, y0, x1, y1, c) {
      const n = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0), 1) | 0;
      actx.fillStyle = c;
      for (let i = 0; i <= n; i++) actx.fillRect(Math.round(x0 + (x1 - x0) * i / n), Math.round(y0 + (y1 - y0) * i / n), 1, 1);
    }
    const visible = (p, m) => { const x = X(p); return x > -(m || 40) && x < AW + (m || 40); };
    const sizeClass = () => { const s = clamp(cam.sy / 0.55, 0.3, 1.35); return s >= 0.8 ? 'L' : s >= 0.45 ? 'M' : 'S'; };
    const depth = (d) => cssToArt(d * clamp(cam.sy / 0.55, 0.3, 1.35));
    // prayer flags strung between two points, fluttering
    const FLAG = ['#3c78dc', '#faf8f0', '#dc3c3c', '#3caa5a', '#fad23c'];
    function flags(x1, y1, x2, y2, step) {
      const n = Math.max(2, Math.round(Math.abs(x2 - x1)));
      const sag = Math.max(2, n * 0.12), st = step || 3;
      actx.fillStyle = 'rgba(70,60,56,0.9)';
      const pts = [];
      for (let i = 0; i <= n; i++) {
        const t = i / n, x = Math.round(lerp(x1, x2, t)), y = Math.round(lerp(y1, y2, t) + Math.sin(t * Math.PI) * sag);
        actx.fillRect(x, y, 1, 1);
        if (i > 1 && i < n - 1 && i % st === 0) pts.push(x, y, i);
      }
      for (let c = 0; c < 5; c++) {
        actx.fillStyle = FLAG[c];
        for (let q = 0; q < pts.length; q += 3) {
          const i = pts[q + 2]; if (((i / st) % 5 | 0) !== c) continue;
          const fl = reduced ? 0 : Math.round(Math.sin(time * 6 + i) * 0.6);
          actx.fillRect(pts[q], pts[q + 1] + 1, 2, 2 + fl);
        }
      }
    }


    // scenery across the face: each item lands at (p, depth d) and takes the band of the
    // altitude it is drawn at; drawn top to bottom so nearer things overlap farther ones
    const scapeList = [];
    const SMALL = { bush: 1, stone: 1, cairn: 1, crevasse: 1 };
    function drawScape(cls) {
      scapeList.length = 0;
      const ds = clamp(cam.sy / 0.55, 0.3, 1.35);
      const pEnd = pAt(AW + 34);
      for (let si = scapeFrom(pAt(-34)); si < SCAPE.length; si++) {
        const it = SCAPE[si];
        if (it.p > pEnd) break;
        // the far-away overview keeps the bigger pieces only (small ones would just be specks)
        if (cls === 'S' && SMALL[it.kind]) continue;
        const x = X(it.p);
        if (x < -30 || x > AW + 30) continue;
        if (it.g === undefined) it.g = ground(it.p);
        const y = Y(it.g) + cssToArt(it.d * ds);
        if (y < -10 || y > AH + 30) continue;
        scapeList.push(it, x, y);
      }
      const order = [];
      for (let i = 0; i < scapeList.length; i += 3) order.push(i);
      order.sort((a, b) => scapeList[a + 2] - scapeList[b + 2]);
      const S = cls === 'S', L = cls === 'L';
      for (const i of order) {
        const it = scapeList[i], x = scapeList[i + 1], y = scapeList[i + 2];
        const a = altAt(y), sd = it.seed;
        let s = null;
        const k = it.kind, st = L ? 2.4 : 1.5;
        if (k === 'farm') { if (a < 3700) s = K.teahouse(L ? 'L' : 'S', 20 + sd); else if (a < 4600) s = K.stoneHut(cls, sd); }
        else if (k === 'plot') { if (a < 3700 && !S) s = K.field(L ? 14 : 8, 2); }
        else if (k === 'yak') { if (a < 4300 && L) s = K.buildAlpaca(sd % K.COATS.length, 'stand', { seed: 20 + sd }); }
        else if (k === 'tree') s = K.tree(cls, sd % 7);
        else if (k === 'pine') s = K.pine(cls, sd % 7);
        else if (k === 'pair') {   // two trees side by side, the only "group" left
          const t = a < 3450 ? K.tree : K.pine;
          draw(t(cls, (sd + 3) % 7), x - (L ? 7 : 4), y - (L ? 3 : 2), true);
          s = t(cls, sd % 7);
        }
        else if (k === 'bush') s = K.bush(sd % 2);
        else if (k === 'stone') s = K.stone(st, sd % 5);
        else if (k === 'cairn') s = K.cairn(cls);
        else if (k === 'chorten') s = K.chorten(cls);
        else if (k === 'flagPole') s = K.flagPole(cls, sd);
        else if (k === 'stoneHut') s = K.stoneHut(cls, sd);
        else if (k === 'maniWall') s = K.maniWall(cls);
        else if (k === 'outcrop') s = K.outcrop(cls, sd % 4, 0);
        else if (k === 'crevasse') s = K.crevasse(cls, sd % 3);
        else if (k === 'iceRock') s = K.outcrop(cls, sd % 4, 1);
        else if (k === 'snowRock') s = K.outcrop(cls, sd % 4, 2);
        if (s) draw(s, x, y, true);
      }
    }

    // --- sky (cached, rebuilt when the colour moves a step) -------------------------
    function renderSky(sky, timeAlt) {
      const key = AW + 'x' + AH + ':' + Math.round((timeAlt - C.startAlt) / ((C.summitAlt - C.startAlt) / 64));
      if (key === skyKey) return;
      // while moving, the sky steps at most every quarter second (each step redraws the whole sky)
      if (skyKey && skyKey.split(':')[0] === key.split(':')[0] && !still && time - skyAt0 < 0.25) return;
      skyAt0 = time;
      skyKey = key;
      const img = skyCtx.createImageData(AW, AH), d32 = new Uint32Array(img.data.buffer);
      skyPix = d32;
      const s1 = mixc(sky.top, sky.bot, 0.78), s2 = mixc(sky.bot, [255, 248, 236], 0.18);
      const LV = 14;
      const colAt = (t) => (t < 0.62 ? mixc(sky.top, s1, t / 0.62) : mixc(s1, s2, (t - 0.62) / 0.38));
      const pal = []; for (let l = 0; l <= LV; l++) { const c = colAt(l / LV); pal.push((255 << 24) | ((c[2] | 0) << 16) | ((c[1] | 0) << 8) | (c[0] | 0)); }
      for (let y = 0; y < AH; y++) {
        const f = (y / Math.max(1, AH - 1)) * LV, base = f | 0, fr = f - base;
        for (let x = 0; x < AW; x++) d32[y * AW + x] = pal[Math.min(LV, base + (fr > K.dither(x, y) ? 1 : 0))];
      }
      // a soft aurora band near the summit at night
      if (sky.star > 0.5) {
        const a = (sky.star - 0.5) / 0.5 * 0.75;
        for (let x = 0; x < AW; x++) {
          const cy = AH * 0.12 + Math.sin(x * 0.045) * AH * 0.035 + Math.sin(x * 0.13) * 4;
          for (let y = Math.max(0, cy - 24 | 0); y < Math.min(AH, cy + 6); y++) {
            const t = (cy - y) / 30, v = t < 0 ? 1 + t * 4 : 1 - t;
            if (v * a <= K.dither(x, y) * 1.1) continue;
            const c = v > 0.5 ? K.mix([90, 240, 180], [150, 110, 230], clamp(t, 0, 1)) : K.mix([50, 150, 140], [80, 70, 150], clamp(t, 0, 1));
            const i = y * AW + x, o = d32[i], m = 0.7;
            const r0 = o & 255, g0 = (o >> 8) & 255, b0 = (o >> 16) & 255;
            d32[i] = (255 << 24) | ((b0 + (c[2] - b0) * m) << 16) | ((g0 + (c[1] - g0) * m) << 8) | (r0 + (c[0] - r0) * m);
          }
        }
      }
      skyCtx.putImageData(img, 0, 0);
    }

    // --- ranges and terrain (per pixel, into two buffers) ------------------------------
    const M = 76, SL = 34; // column margin for trace-back lookups; lead-in so facet runs match across strips
    const pack = (c) => (255 << 24) | ((c[2] | 0) << 16) | ((c[1] | 0) << 8) | (c[0] | 0);
    const amb = (c) => [c[0] * AMB[0], c[1] * AMB[1], c[2] * AMB[2]];
    // ranges are flat-shaded column runs: a lit or shaded face, a snow cap, a hazed foot
    const cssOf = (c) => `rgb(${c[0] | 0},${c[1] | 0},${c[2] | 0})`;
    // facets as broad runs: a lit/shaded flag per column, with runs shorter than `min` folded into their neighbours
    const LIT = new Uint8Array(4096);
    function settleRuns(n, min, A = LIT) {
      let i = 0;
      while (i < n) {
        let j = i; while (j + 1 < n && A[j + 1] === A[i]) j++;
        if (j - i + 1 < min && i > 0) for (let k = i; k <= j; k++) A[k] = A[i - 1];
        i = j + 1;
      }
    }
    const RANGES = [
      { fn: farAlt, fx: 0.22, fy: 0.17, base: [150, 160, 182], haze: 0.55, snow: 6000 },
      { fn: midAlt, fx: 0.45, fy: 0.3, base: [104, 112, 126], haze: 0.32, snow: 5300 },
      { fn: nearAlt, fx: 0.7, fy: 0.62, base: [70, 112, 66], haze: 0.12, snow: 99999, forest: true },
    ];
    // the background ranges as in the original look: broad faces whose edges run diagonally
    // down from the ridges (traced back up the slope), a dithered 4-step ramp, a dithered snow
    // line and a hazy foot. Drawn per pixel, but only into the range caches a strip at a time.
    const RG = [0, 1, 2].map(() => ({ T: null, U: new Float32Array(4096), w: 0, sy0: 0, kY: 1, wx0: 0, P: null }));
    function rangeCols(ri, w, mx, my) {
      const r = RANGES[ri], T = rtops[ri], G0 = RG[ri];
      const par = cam.sx * r.fx, hs = Math.max(par, 20000 * cam.sy * r.fy);
      const sy0 = ((H / 2 + cam.alt * cam.sy * r.fy) * DPR - LY - shY) / UP + my, kY = cam.sy * r.fy * DPR / UP;
      for (let i = 0; i < w + 2 * M; i++) {
        const xc = ((i - M - mx + 0.5) * UP + LX + shX) / DPR;
        const u = (cam.p * par + xc - W / 2) / hs;
        T[i] = sy0 - r.fn(u) * kY;
        if (r.forest) { G0.U[i] = u; T[i] -= Math.abs(Math.sin(u * 2600)) * 2.5; }
      }
      G0.T = T; G0.w = w; G0.sy0 = sy0; G0.kY = kY; G0.yo = Math.round(sy0);
      G0.wx0 = Math.round(-mx + cam.p * par * DPR / UP);   // world-anchored column origin for wobble and dither
      if (G0.key !== ambKey + '|' + HAZE.join(',')) {
        G0.key = ambKey + '|' + HAZE.join(',');
        const shadowC = [38, 50, 104];
        const base4 = r.forest ? [[38, 74, 50], [52, 98, 56], [76, 128, 64], [112, 160, 78]] : [mixc(r.base, shadowC, 0.5), mixc(r.base, shadowC, 0.22), r.base, mixc(r.base, [255, 255, 255], 0.25)];
        const rock = base4.map((c) => amb(mixc(c, HAZE, r.haze * 0.85)));
        const snow = [[150, 168, 206], [186, 202, 232], [222, 232, 246], [246, 250, 255]].map((c) => amb(mixc(c, HAZE, r.haze * 0.5)));
        const hz = amb(HAZE);
        G0.P = {
          rock: rock.map(pack), snow: snow.map(pack), edge: pack(mixc(rock[0], hz, 0.2)),
          rockH: rock.map((c) => pack(mixc(c, hz, 0.55))), snowH: snow.map((c) => pack(mixc(c, hz, 0.55))),
        };
      }
      return G0;
    }
    // writes rows y0..y1 of column x (local, 0..w-1) of range ri into d32 (stride, offset)
    function rangeColumn(ri, G0, x, y0, y1, d32, stride, off) {
      const r = RANGES[ri], T = G0.T, P = G0.P, n = G0.w + 2 * M;
      const tx = T[x + M], top = Math.ceil(tx), wx = x + G0.wx0;
      const snowY = G0.sy0 - (r.snow + Math.sin(wx * 0.7) * 25 + Math.sin(wx * 0.23) * 60) * G0.kY;
      const hazeY = G0.sy0 - 5200 * G0.kY, hazeK = 1 / (1300 * G0.kY);
      for (let y = Math.max(y0, top), i = off + y * stride; y < y1; y++, i += stride) {
        if (y === top) { d32[i] = P.edge; continue; }
        const dpt = y - tx;
        let xr = x + M - Math.round(0.35 * dpt); xr = xr < 3 ? 3 : xr > n - 4 ? n - 4 : xr;
        xr = x + M - Math.round(0.35 * (y - T[xr])); xr = xr < 3 ? 3 : xr > n - 4 ? n - 4 : xr;
        const sl = T[xr - 3] - T[xr + 3];
        let v = (sl > 0.4 ? 0.82 : sl < -0.4 ? 0.3 : 0.56) - dpt / 400;
        const yw = y - G0.yo, dth = K.dither(wx, yw);
        const snowy = y < snowY + (dth - 0.5) * 80 * G0.kY;
        const hazy = !r.forest && y > hazeY && Math.min(1, (y - hazeY) * hazeK) > K.dither(wx + 2, yw + 1);
        let pal = snowy ? (hazy ? P.snowH : P.snow) : (hazy ? P.rockH : P.rock);
        if (r.forest) {   // canopy clumps: a lit top on each round crown, darker gaps between
          const cx = Math.round(G0.U[x + M] * 2600 / Math.PI * 2), cy = Math.round(dpt);
          const cl = K.hash2(cx >> 2, cy >> 2, 11), inner = ((cy & 3) === 0) ? 0.25 : ((cx & 3) === 0 ? -0.2 : 0);
          v = 0.6 + (cl - 0.5) * 0.7 + inner - dpt / 200;
        }
        const f = (v < 0 ? 0 : v > 0.9999 ? 0.9999 : v) * 3; let ci = f | 0; if (ci < 3 && f - ci > dth) ci++;
        d32[i] = pal[ci];
      }
    }
    // draws columns x0..x0+sw of range ri into buffer B (each column filled to the bottom)
    const stripImg = new Map();
    function renderRangeStrip(ri, B, J, x0, sw) {
      const h = J.h, k = sw + 'x' + h;
      let img = stripImg.get(k);
      if (!img) { img = new ImageData(sw, h); img.d32 = new Uint32Array(img.data.buffer); stripImg.set(k, img); if (stripImg.size > 12) stripImg.delete(stripImg.keys().next().value); }
      const d32 = img.d32; d32.fill(0);
      const G0 = rangeCols(ri, sw, J.mx - x0, J.my);
      for (let j = 0; j < sw; j++) {
        const top = Math.ceil(G0.T[j + M]);
        B.tops[x0 + j] = clamp(top, -30000, 30000);
        if (top < h) rangeColumn(ri, G0, j, 0, h, d32, sw, j);
      }
      B.ug.putImageData(img, x0, 0);
    }
    // while zooming: all three ranges in one pass, each clipped by the one in front and by the ground,
    // written straight into pixel memory (no overdraw), then one copy
    let flatImg = null, flat32 = null, flatCv = null, flatN = 0;
    const skyTop = new Int32Array(4096);
    // the per-pixel faces cost a few ms, so while zooming they are redrawn every other frame
    // (the ranges move slowly behind the ground; each column runs a few pixels past it to hide the lag)
    function renderRangesFlat() {
      if (!flatCv) flatCv = document.createElement('canvas');
      if (flatN++ & 1 && flatCv.width === AW && flatCv.height === AH) { actx.drawImage(flatCv, 0, 0); return; }
      if (!flatImg || flatImg.width !== AW || flatImg.height !== AH) { flatImg = new ImageData(AW, AH); flat32 = new Uint32Array(flatImg.data.buffer); }
      if (skyPix && skyPix.length === flat32.length) flat32.set(skyPix); else flat32.fill(0);
      terrainTops();
      const Gs = [0, 1, 2].map((ri) => { const g = rangeCols(ri, AW, 0, 0); return { T: Float32Array.from(g.T.subarray(0, AW + 2 * M)), U: Float32Array.from(g.U.subarray(0, AW + 2 * M)), w: g.w, sy0: g.sy0, kY: g.kY, wx0: g.wx0, yo: g.yo, P: g.P }; });
      for (let x = 0; x < AW; x++) {
        let limit = Math.min(AH, tops[x + M] + 6);
        for (let ri = 2; ri >= 0; ri--) {
          const g = Gs[ri], top = Math.max(0, Math.ceil(g.T[x + M]));
          if (top < limit) { rangeColumn(ri, g, x, top, limit, flat32, AW, x); limit = top; }
        }
        skyTop[x] = Math.max(0, limit);
      }
      if (flatCv.width !== AW || flatCv.height !== AH) { flatCv.width = AW; flatCv.height = AH; }
      flatCv.getContext('2d').putImageData(flatImg, 0, 0);
      actx.drawImage(flatCv, 0, 0);
    }
    // each range layer is cached and slid by its parallax while the zoom holds still
    let still = true, stillFrames = 0, lastCamKey = '';
    // caches get more room ahead: the camera moves up and right as you climb
    const BIAS = 0.6;
    let stripBudget = 1;
    const rangeKey = () => cam.sx + ':' + cam.sy + ':' + AW + 'x' + AH;
    const rangeColKey = () => ambKey + '|' + HAZE.join(',');
    function rangeOffset(ri, B) {
      const r = RANGES[ri], k = DPR / UP;
      return [-(cam.p - B.p0) * cam.sx * r.fx * k + (B.sh0x - shX) / UP, (cam.alt - B.a0) * cam.sy * r.fy * k + (B.sh0y - shY) / UP];
    }
    const covers = (B, dx, dy) => { const l = Math.round(dx) - B.mx, t = Math.round(dy) - B.my; return l <= 0 && t <= 0 && l + B.u.width >= AW && t + B.u.height >= AH; };
    function rangeFrontOk(ri) {
      const B = RF[ri].front;
      if (!B.valid || B.key !== rangeKey()) return false;
      const [dx, dy] = rangeOffset(ri, B);
      return covers(B, dx, dy);
    }
    // a range job freezes the camera and colours it was started with, so its strips line up
    function startRangeJob(ri) {
      const R = RF[ri], w = AW + 2 * RMX, h = AH + 2 * RMY;
      const B = R.back;
      if (B.u.width !== w || B.u.height !== h) { B.u.width = w; B.u.height = h; }
      if (B.tops.length < w) B.tops = new Int16Array(w + 64);
      // more room ahead: climbing slides the ranges left and down
      R.job = { key: rangeKey(), ck: rangeColKey(), p: cam.p, alt: cam.alt, shX, shY, AMB, ambKey, HAZE, w, h, mx: RMX - Math.round(RMX * 0.5), my: RMY + Math.round(RMY * 0.5), i: 0, n: 6 };
    }
    function stepRangeJob(ri) {
      const R = RF[ri], J = R.job, B = R.back;
      const x0 = Math.floor(J.i * J.w / J.n), x1 = Math.floor((J.i + 1) * J.w / J.n);
      const sv = [cam.p, cam.alt, shX, shY, AMB, ambKey, HAZE];
      cam.p = J.p; cam.alt = J.alt; shX = J.shX; shY = J.shY; AMB = J.AMB; ambKey = J.ambKey; HAZE = J.HAZE;
      try { renderRangeStrip(ri, B, J, x0, x1 - x0); } finally { [cam.p, cam.alt, shX, shY, AMB, ambKey, HAZE] = sv; }
      if (++J.i >= J.n) {
        Object.assign(B, { valid: true, key: J.key, ck: J.ck, p0: J.p, a0: J.alt, sh0x: J.shX, sh0y: J.shY, mx: J.mx, my: J.my });
        R.back = R.front; R.front = B; R.job = null;
      }
    }
    // schedules range work; returns true when all three fronts can draw this frame
    function rangesPlan(settled) {
      if (!settled) { for (const R of RF) R.job = null; return false; }
      const key = rangeKey(), ck = rangeColKey();
      for (let ri = 0; ri < 3; ri++) {
        const R = RF[ri];
        if (R.job && R.job.key !== key) R.job = null;
        if (R.job) continue;
        const B = R.front;
        let need = !B.valid || B.key !== key || !rangeFrontOk(ri) || (still && B.ck !== ck);
        if (!need) { const [dx, dy] = rangeOffset(ri, B); need = dx < -24 || dx > 12 || dy > 60 || dy < -30; }
        if (need) startRangeJob(ri);
      }
      return RF.every((R, ri) => rangeFrontOk(ri));
    }
    function stepRangeJobs() {
      // the layer that can no longer draw goes first
      for (let pass = 0; pass < 2 && stripBudget > 0; pass++) for (let ri = 0; ri < 3 && stripBudget > 0; ri++) {
        const R = RF[ri]; if (!R.job) continue;
        if (pass === 0 && rangeFrontOk(ri)) continue;
        stripBudget--; stepRangeJob(ri);
      }
    }
    let FT = null, wDX = null, wDY = 0, WRtarget = null, WRoff = 0; const RTOP = new Float32Array(3 * 512);
    // draws the three range fronts, each copied only over the rows where it can be seen
    function drawRangeFronts(noGround) {
      const n = Math.ceil(AW / 2) + 1;
      if (!FT || FT.length < n) FT = new Float32Array(n + 8);
      for (let i = 0; i < n; i++) FT[i] = noGround ? AH : Y(ground(pAt(Math.min(AW - 1, i * 2) + 0.5))) - 2;
      const off = RF.map((R, ri) => { const [dx, dy] = rangeOffset(ri, R.front); return [Math.round(dx) - R.front.mx, Math.round(dy) - R.front.my]; });
      const rows = [];
      for (let ri = 2; ri >= 0; ri--) {
        const B = RF[ri].front, [ox, oy] = off[ri];
        let top = 1e9, bot = -1e9;
        for (let i = 0; i < n; i++) {
          const x = Math.min(AW - 1, i * 2), t = B.tops[x - ox] + oy;
          if (t < top) top = t;
          if (FT[i] > bot) bot = FT[i];
          RTOP[ri * 512 + i] = t;
        }
        rows[ri] = [Math.max(0, Math.floor(top)), Math.min(AH, Math.ceil(bot) + 2)];
        for (let i = 0; i < n; i++) FT[i] = Math.min(FT[i], RTOP[ri * 512 + i]);
      }
      for (let ri = 0; ri < 3; ri++) {
        const B = RF[ri].front, [ox, oy] = off[ri], [y0, y1] = rows[ri], h = y1 - y0;
        if (h > 0) actx.drawImage(B.u, -ox, y0 - oy, AW, h, 0, y0, AW, h);
      }
    }
    function terrainTops() {
      for (let i = 0; i < AW + 2 * M; i++) tops[i] = Math.round(Y(ground(pAt(i - M + 0.5))));
    }
    // terrain is calm flat colour: a 1 px highlight on top, a lit outer band, then a darker inner
    // part per altitude band, with 2-row dithered seams between them; beyond the summit, one
    // ridge line puts the far face in shade. Nothing depends on the column, so there are no vertical stripes.
    const BANDS = [[3900, 'grass'], [4300, 'scrub'], [5300, 'rock'], [8050, 'ice'], [1e9, 'snow']];
    const RIM = 34, DEEP = 1e6, SUMMIT_P = 0.868;
    const bandAt = (y, yb, wob) => { for (let bi = 0; bi < BANDS.length - 1; bi++) if (y > Math.round(yb[bi]) + wob) return BANDS[bi][1]; return BANDS[BANDS.length - 1][1]; };
    let bandKey = '', BC = null;
    function renderTerrain() {
      if (bandKey !== ambKey) {
        bandKey = ambKey; BC = {};
        for (const k in RAMP) { const R = RAMP[k], n = R.length; const SH = [38, 50, 104]; BC[k] = { hi: cssOf(amb(R[n - 1])), lit: cssOf(amb(R[n - 2])), body: cssOf(amb(R[n - 3])), deep: cssOf(amb(R[Math.max(0, n - 4)])), shTop: cssOf(amb(mixc(R[n - 3], SH, 0.12))), sh: cssOf(amb(mixc(R[n - 3], SH, 0.26))), shDeep: cssOf(amb(mixc(R[Math.max(0, n - 4)], SH, 0.26))) }; }
      }
      const yb = BANDS.map(([a]) => Y(a));
      const runs = new Map(), dots = new Map();
      const add = (st, x, y, h) => { let r = runs.get(st); if (!r) runs.set(st, (r = [])); r.push(x, y, h); };
      const dot = (st, x, y) => { let r = dots.get(st); if (!r) dots.set(st, (r = [])); r.push(x, y); };
      // a seam: the colour above spills 2 rows into the one below (50% then 25%), world-anchored
      const seam = (st, x, y, lim) => {
        const wx = x - oxA, wy = y - oyA;
        if (y < lim && (wx + wy) & 1) dot(st, x, y);
        if (y + 1 < lim && ((wx & 1) === 0 && ((wy + 1) & 3) === ((wx >> 1) & 1) * 2)) dot(st, x, y + 1);
      };
      // one ridge splits light from shade: the far side of the summit, below a line running
      // down and to the right from the top (the way light falls across a pyramid face)
      const sX = X(SUMMIT_P), sYr = Y(C.summitAlt);
      for (let x = 0; x < AW; x++) {
        const top = tops[x + M], ty = Math.max(0, top);
        if (ty >= AH) continue;
        const wob = Math.round(Math.sin((x - oxA) * 0.06) * 4 + Math.sin((x - oxA) * 0.023 + 1) * 6);
        const yShade = x > sX ? Math.round(sYr + (x - sX) / 0.15) : -1e9;   // rows above this are in shade
        let y = ty;
        for (let bi = BANDS.length - 1; bi >= 0 && y < AH; bi--) {
          const lower = bi > 0 ? Math.round(yb[bi - 1]) + wob : AH;
          if (lower <= y) continue;
          const c = BC[BANDS[bi][1]], end = Math.min(AH, lower);
          const segs = [[top, top + 1, c.hi, c.shTop], [top + 1, top + RIM, c.lit, c.sh], [top + RIM, top + DEEP, c.body, c.sh], [top + DEEP, 1e9, c.deep, c.shDeep]];
          for (let si = 0; si < segs.length && y < end; si++) {
            const [a, b, st, sh] = segs[si];
            if (b <= y) continue;
            const e = Math.min(end, b), y0 = Math.max(y, a);
            const ys = clamp(yShade, y0, e);
            if (ys > y0) add(sh, x, y0, ys - y0);
            if (e > ys) add(st, x, ys, e - ys);
            if (e === b && si > 0 && si < 3 && b >= yShade) seam(st, x, b, end);   // rim → body → deep
            y = e;
          }
          if (bi > 0 && end < AH) {   // band seam: this band's tone at that depth spills into the next
            const d = end - top, st = end < yShade ? c.sh : d < RIM ? c.lit : d < DEEP ? c.body : c.deep;
            seam(st, x, end, AH);
          }
        }
        if (yShade > ty && yShade < AH) seam(BC[bandAt(yShade, yb, wob)].sh, x, yShade, AH);   // soften the ridge line
      }
      for (const [st, r] of runs) { actx.fillStyle = st; for (let q = 0; q < r.length; q += 3) actx.fillRect(r[q], r[q + 1], 1, r[q + 2]); }
      for (const [st, r] of dots) { actx.fillStyle = st; for (let q = 0; q < r.length; q += 2) actx.fillRect(r[q], r[q + 1], 1, 1); }
    }

    // --- yak ride (§8.6) ------------------------------------------------------------
    // After a Sherpa spotlight, a herd carries the climber up by the meters earned.
    // The plan (style, band, rare variants, timing) comes from E.ridePlan(); this
    // only draws it. The timeline runs on u = elapsed / duration:
    //   enter 0–.18 · scoop .18–.26 · gallop .26–.78 · drop .78–.86 · exit .86–1
    const PUFF = { grass: '#b09670', trail: '#96928c', glacier: '#fafcff', deathzone: '#ecf0fa' };
    const puffs = [];
    for (let i = 0; i < 48; i++) puffs.push({ on: false, x: 0, y: 0, vx: 0, vy: 0, r: 1, life: 0, max: 1, c: PUFF.trail });
    let ride = null;          // the running ride, or null
    let splat = null;         // { x, y, t } art-space spit, outlives the ride a little
    const easeIO = (k) => (k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2);
    const seg = (u, a, b) => clamp((u - a) / (b - a), 0, 1);
    const GY_OFF = 2048, gyMemo = new Float32Array(4096), gyStamp = new Int32Array(4096);
    let gyFrame = 1;
    function groundY(x) {
      const i = (x | 0) + GY_OFF;
      if (x !== (x | 0) || i < 0 || i >= 4096) return Math.round(Y(ground(pAt(x))));
      if (gyStamp[i] !== gyFrame) { gyStamp[i] = gyFrame; gyMemo[i] = Math.round(Y(ground(pAt(x)))); }
      return gyMemo[i];
    }
    function puff(x, y, band) {
      for (const p of puffs) {
        if (p.on) continue;
        p.on = true; p.x = x; p.y = y; p.vx = -10 - Math.random() * 20; p.vy = -4 - Math.random() * 9;
        p.r = 1 + Math.floor(Math.random() * 2.5); p.life = 0; p.max = 0.45 + Math.random() * 0.3; p.c = PUFF[band] || PUFF.trail;
        return;
      }
    }
    function startRide(plan, o) {
      const P = Object.assign({}, plan);
      const n = clamp(P.herd || 5, 1, 8);
      const r = E.rng(E.hashStr('herd:' + (o.seed || '') + ':' + n));
      const herd = [];
      const goldAt = P.golden ? Math.floor(r() * n) : -1;
      for (let i = 0; i < n; i++) herd.push({ coat: Math.floor(r() * K.COATS.length), gold: i === goldAt, ph: r() * 6, bob: r() * 6, seed: i });
      return new Promise((resolve) => {
        if (ride) ride.resolve(false);
        ride = {
          P, herd, from: o.fromAlt, to: P.noMove ? o.fromAlt : clamp(o.toAlt, C.startAlt, C.summitAlt),
          answer: String(o.answer || '').toUpperCase().trim() + '!', t: 0, dur: Math.max(0.3, (P.durationMs || 3000) / 1000),
          resolve, on: o.on || null, fired: {}, prevView: view, prevRect: rect, banner: null,
        };
        climb = climbTarget = ride.from;
        view = 'ride'; cv.dataset.view = view; computeTarget();
      });
    }
    function endRide(done) {
      if (!ride) return;
      const R0 = ride; ride = null;
      climb = climbTarget = R0.to;
      view = R0.prevView === 'ride' ? 'follow' : R0.prevView; rect = R0.prevRect; cv.dataset.view = view; computeTarget();
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
      if (P.spit && u >= 0.9) { rideEvent('spit'); if (!splat) splat = { x: AW * (0.38 + Math.random() * 0.24), y: Math.max(35, AH * 0.22), t: 0 }; }
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
    // walks along the ground from art x0 by d pixels of trail (signed)
    function alongX(x0, d) {
      if (!d) return x0;
      const dir = d > 0 ? 1 : -1, target = Math.abs(d);
      let x = x0, y = groundY(x0), dist = 0, guard = 0;
      while (dist < target && guard++ < 600) {
        const nx = x + dir, ny = groundY(nx);
        dist += Math.hypot(nx - x, ny - y); x = nx; y = ny;
      }
      return x;
    }
    // The answer banner: Silkscreen capitals on a parchment strip between two poles.
    function bannerSprite(text) {
      const fit = AW - 16;
      let t = K.text(text, { color: '#281e16', bold: true });
      if (t.w > fit - 8) t = K.text(text, { color: '#281e16' });
      if (t.w > fit - 8) {
        let s = text;
        while (s.length > 2 && K.text(s + '…', { color: '#281e16' }).w > fit - 8) s = s.slice(0, -1);
        t = K.text(s.replace(/[\s!]+$/, '') + '…', { color: '#281e16' });
      }
      return t;
    }
    function banner(cx, yb, text, holders) {
      const t = ride.banner || (ride.banner = bannerSprite(text));
      const span = holders ? Math.abs(holders[1].x - holders[0].x) + 8 : 0;
      const w = clamp(Math.max(t.w + 10, span), 30, AW - 8), h = t.h + 6;
      const x = Math.round(clamp(cx - w / 2, 4, AW - w - 4)), y = Math.round(yb - h);
      if (holders) for (const hp of holders) {   // two wooden poles from each holder's head up to the banner
        const hx = Math.round(hp.x + 7), px2 = clamp(hx, x + 2, x + w - 3);
        pline(hx, hp.y - 20, px2, y + h, '#966c42'); pline(hx + 1, hp.y - 20, px2 + 1, y + h, '#5b3a22');
      }
      if (!ride.strip || ride.strip.w !== w) {
        const c = K.canvas(w + 2, h + 3), g = c.getContext('2d');
        const P1 = (xx, yy, col, hh) => { g.fillStyle = col; g.fillRect(xx, yy, 1, hh || 1); };
        for (let i = 0; i < w; i++) {
          const sg = Math.round(Math.sin(i / w * Math.PI) * 1.5);
          P1(i + 1, sg, '#281e16'); P1(i + 1, sg + 1, '#fff7e0'); P1(i + 1, sg + 2, '#f4e7c8', h - 4);
          P1(i + 1, sg + h - 2, '#d8c08f'); P1(i + 1, sg + h - 1, '#281e16');
        }
        P1(0, 1, '#281e16', h - 2); P1(w + 1, 1, '#281e16', h - 2);
        g.drawImage(t.cv, Math.round(1 + (w - t.w) / 2), 4);
        ride.strip = { cv: c, w };
      }
      actx.drawImage(ride.strip.cv, x - 1, y);
      const sg = K.sign('YAK EXPRESS', null);   // the express sign rides on top of the banner
      actx.drawImage(sg.cv, Math.round(clamp(x + (w - sg.w) / 2, 2, AW - sg.w - 2)), y - sg.h + 1);
    }
    function climberSprite(pose, o) {
      const op = o || {};
      const of = op.hatless ? Object.assign({}, outfit || {}, { hat: null }) : outfit;
      return K.buildClimber(pose, of, { ghost: op.ghost });
    }
    function drawRide(dt, cx0, cy0) {
      const R0 = ride, P = R0.P, u = clamp(R0.t / R0.dur, 0, 1);
      const gap = 26;
      const n = R0.herd.length, H0 = R0.herd;
      const style = P.style, band = P.band, tucked = band === 'glacier' && style !== 'paraglide';
      const galloping = !P.noMove && u > 0.26 && u < 0.78;
      const walking = u < 0.18 || u > 0.86 || galloping;
      const legRate = galloping ? 9 : 5;
      const enter = easeIO(seg(u, 0, 0.18)), exit = seg(u, 0.86, 1);
      const baseX = alongX(cx0, -(1 - enter) * AW * 0.9 + exit * exit * AW * 0.9);
      const lead = n - 1;
      const carrier = style === 'conga' ? Math.floor(n / 2) : lead;
      const lift = seg(u, 0.18, 0.26), drop = seg(u, 0.78, 0.86), carried = lift * (1 - drop);
      const shrugging = (P.noMove && u > 0.26 && u < 0.8) || (P.shortHop && u > 0.2 && u < 0.3);
      const mapUp = P.shortHop && u > 0.16 && u < 0.27;
      const line = R0.line || (R0.line = new Array(n));
      for (let i = 0; i < n; i++) {
        const x = alongX(baseX, (i - carrier) * gap);
        const bounce = galloping ? Math.round(Math.abs(Math.sin(time * 11 + H0[i].bob)) * 2) : 0;
        line[i] = { x, y: groundY(x) - bounce, row: 0 };
      }
      let pos = line, climberX = line[carrier].x - 2, climberY = line[carrier].y - 14, lying = false;
      if (style === 'pyramid') {
        const rows = []; let left = n, w = Math.min(3, n);
        while (left > 0) { const k = Math.min(w, left); rows.push(k); left -= k; w = Math.max(1, w - 1); }
        const pyr = []; let idx = 0, prev = null;
        rows.forEach((k, ri) => {
          const cur = [];
          for (let j = 0; j < k; j++) {
            let x, y;
            if (!ri) { x = alongX(baseX, (j - (k - 1) / 2) * gap * 0.95); y = groundY(x); }
            else { const a = prev[Math.min(j, prev.length - 1)], b = prev[Math.min(j + 1, prev.length - 1)]; x = (a.x + b.x) / 2; y = Math.min(a.y, b.y) - 14; }
            const wob = galloping && ri ? Math.round(Math.sin(time * 8 + ri * 1.3) * ri) : 0;
            cur.push({ x: x + wob, y, row: ri });
          }
          for (const c of cur) pyr[idx++] = c;
          prev = cur;
        });
        pos = pyr.map((p, i) => ({ x: lerp(line[i].x, p.x, carried), y: lerp(line[i].y, p.y, carried), row: p.row }));
        const top = pos[n - 1]; climberX = top.x - 4; climberY = top.y - 14;
      } else if (style === 'paraglide') {
        const fly = carried * (40 + (galloping ? Math.sin(time * 2) * 4 : 0));
        const hx = baseX, hy = groundY(baseX) - fly;
        pos = line.map((p, i) => { const tx = hx + (i - (n - 1) / 2) * 14, ty = hy - (i % 2) * 6; return { x: lerp(p.x, tx, carried), y: lerp(p.y, ty, carried), row: carried > 0.5 ? 1 : 0 }; });
        climberX = hx; climberY = hy - 16;
      } else if (style === 'crowdsurf') {
        const k = galloping ? (Math.sin(seg(u, 0.26, 0.78) * Math.PI * 3) + 1) / 2 : 0.5;
        const fi = k * (n - 1), i0 = Math.floor(fi), i1 = Math.min(n - 1, i0 + 1), f = fi - i0;
        climberX = lerp(line[i0].x, line[i1].x, f); climberY = lerp(line[i0].y, line[i1].y, f) - 13; lying = true;
      }
      let topY = Infinity;
      for (const p of pos) topY = Math.min(topY, p.y);
      // dust, gravel or snow from the hooves
      if (galloping && !reduced && style !== 'paraglide' && Math.random() < 0.6) { const i = Math.floor(Math.random() * n); puff(pos[i].x - 9, pos[i].y - 1, band); }
      for (const p of puffs) {
        if (!p.on) continue;
        p.life += dt; if (p.life >= p.max) { p.on = false; continue; }
        p.x += p.vx * dt; p.y += p.vy * dt; p.vy += 6 * dt;
        draw(K.puff(p.r + (p.life > p.max * 0.5 ? 1 : 0), p.c), p.x, p.y, true, 0.85 * (1 - p.life / p.max));
      }
      // paraglider canopy and lines
      if (style === 'paraglide' && carried > 0.05) {
        const cyc = climberY - 28;
        actx.globalAlpha = Math.min(1, carried * 2);
        for (let i = 0; i < n; i++) pline(climberX + (i - (n - 1) / 2) * 14, cyc, pos[i].x - 2, pos[i].y - 11, 'rgba(40,40,40,0.55)');
        draw(K.overlay('canopy'), climberX, cyc);
        actx.globalAlpha = 1;
      }
      // the herd
      for (let i = 0; i < n; i++) {
        const p = pos[i], h = H0[i];
        const coat = h.gold ? 'gold' : h.coat;
        const frame = tucked && !p.row ? 'sled' : walking && Math.floor(time * legRate + h.ph) % 2 ? 'run' : 'stand';
        const ax = Math.round(p.x), ay = Math.round(p.y);
        if (P.headlamps) draw(K.overlay('beam'), ax + 11, ay - 14);
        draw(K.buildAlpaca(coat, frame, { seed: h.seed }), ax, ay, false);
        if (band === 'deathzone') draw(K.overlay('mask'), ax, ay);
        if (P.headlamps) draw(K.overlay('lamp'), ax, ay);
        if (h.gold && !reduced) for (let s = 0; s < 4; s++) {
          const a = time * 3 + s * 1.6, r = 13 + Math.sin(time * 5 + s) * 2;
          if (Math.sin(time * 9 + s) > -0.3) draw(K.overlay('sparkle'), ax - 1 + Math.cos(a) * r, ay - 12 + Math.sin(a) * r * 0.7);
        }
        if (mapUp && i === lead) draw(K.overlay('map'), ax + 8, ay - 22);
      }
      // YAK EXPRESS: a wood sign over the banner (or over the lead yak when there is no banner)
      const bannerOn = !P.noMove && u > 0.2 && u < 0.84;
      if (!bannerOn) {
        const lp = pos[lead], sg = K.sign('YAK EXPRESS', null);
        const sx = Math.round(clamp(lp.x + 4 - sg.w / 2, 2, AW - sg.w - 2)), sy = Math.round(lp.y - 38);
        pline(Math.round(lp.x + 6), Math.round(lp.y - 12), Math.round(lp.x + 6), sy + sg.h, '#5b3a22');
        actx.drawImage(sg.cv, sx, sy);
      }
      if (shrugging) { const q = K.text('?', { color: '#ffffff', outline: '#281e16', bold: true }); draw(q, (P.noMove ? baseX : pos[lead].x) + 9, topY - 34); }
      // the answer banner on two poles, above the herd
      if (bannerOn) {
        const k = seg(u, 0.2, 0.28) * (1 - seg(u, 0.78, 0.84));
        actx.globalAlpha = k;
        if (style === 'paraglide') banner(climberX, climberY + 34, R0.answer, null);
        else {
          const ground0 = pos.filter((p) => !p.row);
          const a = ground0[0], b = ground0[ground0.length - 1];
          const by = Math.min(topY - 24, climberY - 26) - 4;
          banner((a.x + b.x) / 2 + 6, by, R0.answer, [a, b]);
        }
        actx.globalAlpha = 1;
      }
      // the climber: surprised, carried with arms up, dropped off dizzy, thumbs up
      const cx = Math.round(lerp(cx0, climberX, carried)), cy = Math.round(lerp(cy0, climberY, carried));
      const hatOff = u > 0.19 && u < 0.84;
      const thumbs = u > 0.92 || (P.noMove && u > 0.86);
      if (lying && carried > 0.3) {
        const s = climberSprite('stand', { hatless: hatOff });
        actx.save(); actx.translate(cx, cy); actx.rotate(-Math.PI / 2); actx.drawImage(s.cv, -s.ax, -Math.round(s.h / 2)); actx.restore();
      } else {
        const pose = carried > 0.3 ? 'sit' : thumbs || (galloping && Math.floor(time * 6) % 2) ? 'cheer' : 'stand';
        draw(climberSprite(pose, { hatless: hatOff }), cx, cy);
      }
      if (hatOff) {   // the hat flies up, tumbles above the ride in 90° steps, and drops back on
        const hs = K.hatSprites(outfit);
        if (hs) {
          const up = seg(u, 0.19, 0.3), back = seg(u, 0.74, 0.84);
          const hy = cy - 26 - (up - back) * 14 - Math.sin(time * 5) * 2 * (1 - back);
          const q = back > 0.6 ? 0 : Math.floor(time * 6) % 4;
          draw(hs[q], cx + (up - back) * (10 + Math.sin(time * 4) * 3), hy);
        }
      }
      if (u > 0.84 && u < 0.97) for (let i = 0; i < 3; i++) { const a = time * 6 + i * 2.1; draw(K.overlay('dizzy'), cx + Math.cos(a) * 7, cy - 27 + Math.sin(a) * 2); }
      // the late yak: sprints in after the herd has gone, skids, slumps
      if (P.late && u > 0.84) {
        const k = seg(u, 0.84, 0.94);
        const lx = alongX(cx0, -lerp(AW * 0.7, 28, easeIO(k)));
        if (k < 1 && !reduced && Math.random() < 0.5) puff(lx - 9, groundY(lx) - 1, band);
        const fr = k >= 1 ? 'stand' : Math.floor(time * 12) % 2 ? 'run' : 'stand';
        if (P.headlamps) draw(K.overlay('beam'), lx + 11, groundY(lx) - 14);
        draw(K.buildAlpaca(1, fr, { sad: k >= 1 }), lx, groundY(lx));
        if (band === 'deathzone') draw(K.overlay('mask'), lx, groundY(lx));
      }
    }
    function drawSplat(dt) {
      if (!splat) return;
      splat.t += dt;
      const k = splat.t / 1.6;
      if (k >= 1) { splat = null; return; }
      const y = splat.y + k * k * AH * 0.12, a = k < 0.7 ? 0.9 : 0.9 * (1 - (k - 0.7) / 0.3);
      draw(K.overlay('splat'), splat.x, y, false, a);
    }

    // --- the frame ------------------------------------------------------------------
    // the static world: terrain, scenery, landmarks and the dashed route (drawn into the world cache)
    // the home overview keeps the original look: per pixel, facets traced diagonally back to the
    // ridge, a dithered ramp that darkens with depth, flowers and the Yellow Band. It is only drawn
    // into the cached world (home and results stand still), never per frame while zooming.
    const FLOWERS = K.ramp('#fffcf0', '#ffdc5a', '#faaac8', '#c8b4ff');
    let origImg = null, origCv = null;
    function renderTerrainOriginal() {
      if (!origImg || origImg.width !== AW || origImg.height !== AH) { origImg = new ImageData(AW, AH); origImg.d32 = new Uint32Array(origImg.data.buffer); }
      if (!origCv) origCv = document.createElement('canvas');
      if (origCv.width !== AW || origCv.height !== AH) { origCv.width = AW; origCv.height = AH; }
      const terr32 = origImg.d32; terr32.fill(0);
      const ramps = {}; for (const kname in RAMP) ramps[kname] = RAMP[kname].map((c) => pack(amb(c)));
      const flowerP = FLOWERS.map((c) => pack(amb(c))), gold = pack(amb([255, 200, 60]));
      const crev = pack(amb([70, 100, 160])), lip = pack(amb([214, 232, 250])), white = pack(amb([255, 255, 255])), outcrop = pack(amb([88, 80, 96]));
      const ochre = amb([201, 170, 104]);
      const pick = (P, v, x, y) => { const f = clamp(v, 0, 0.9999) * (P.length - 1); let i = f | 0; if (i < P.length - 1 && f - i > K.dither(x, y)) i++; return P[i]; };
      const rowAlt = new Float32Array(AH); for (let y = 0; y < AH; y++) rowAlt[y] = altAt(y + 0.5);
      const xb0 = X(0.73), xb1 = X(0.94), NN = AW + 2 * M;
      for (let x = 0; x < AW; x++) {
        const ty = tops[x + M];
        const wx = x - oxA, wob = Math.sin(wx * 0.31) * 18 + Math.sin(wx * 0.11 + 1) * 26;
        for (let y = Math.max(0, ty); y < AH; y++) {
          const d = y - ty, wy = oyA - y, a = rowAlt[y] + wob;
          const dz = (K.dither(wx, wy) - 0.5) * 90;
          const band = a + dz < 3900 ? 'grass' : a + dz < 4300 ? 'scrub' : a + dz < 5300 ? 'rock' : a + dz < 8050 ? 'ice' : 'snow';
          let xr = x + M - Math.round(0.35 * d); xr = Math.max(4, Math.min(NN - 5, xr));
          xr = x + M - Math.round(0.35 * (y - tops[xr])); xr = Math.max(4, Math.min(NN - 5, xr));
          const sl = (tops[xr - 4] - tops[xr + 4]) - (tops[Math.max(0, xr - 24)] - tops[Math.min(NN - 1, xr + 24)]) / 6;
          let v = 0.62 + (sl > 1.5 ? 0.16 : sl < -1.5 ? -0.2 : 0) - Math.min(0.3, d / 110);
          if (d === 0) v += 0.4;
          let c = 0;
          if (band === 'grass' || band === 'scrub') {
            if (K.hash2(wx, wy, 1) < 0.035) v -= 0.3;
            else if (K.hash2(wx, wy - 1, 1) < 0.035) v += 0.3;
            if (band === 'grass' && d > 3) {
              if (K.hash2(wx, wy, 2) < 0.004) c = gold;
              else {
                let pc = null;
                if (K.hash2(wx - 1, wy, 2) < 0.004) pc = wx - 1 + wy * 7;
                else if (K.hash2(wx + 1, wy, 2) < 0.004) pc = wx + 1 + wy * 7;
                else if (K.hash2(wx, wy - 1, 2) < 0.004) pc = wx + (wy - 1) * 7;
                if (pc !== null) c = flowerP[((pc % 4) + 4) % 4];
              }
            }
          } else if (band === 'rock') {
            if (K.hash2(wx >> 2, wy, 3) < 0.05) v -= 0.25;
            else if (K.hash2(wx, wy, 4) < 0.04) v += 0.25;
          } else if (band === 'ice' && d > 4) {
            const cr = (q) => { const run = ((wx + q) / 9) | 0; return K.hash2(run, q, 5) < 0.0035 && K.hash2(run, q, 8) > 0.2; };
            if (cr(wy)) c = crev; else if (cr(wy + 1)) c = lip;
            else if (K.hash2(wx, wy, 6) < 0.004) c = white;
          } else if (band === 'snow' && d > 3) {
            const oc = K.hash2(wx >> 3, wy >> 3, 7);
            if (oc < 0.035 && K.hash2(wx >> 1, wy >> 1, 9) < 0.7 - Math.abs(((wx & 7) - 3.5) / 7) - Math.abs(((wy & 7) - 3.5) / 6)) c = outcrop;
            else if (K.hash2(wx, wy, 6) < 0.006) c = white;
          }
          if (!c) {
            c = pick(ramps[band], v, wx, wy);
            if (x > xb0 && x < xb1) {   // the Yellow Band across the Lhotse face
              const sl2 = (x - xb0) / Math.max(1, xb1 - xb0);
              const lo = 7540 - sl2 * 60, hi = 7780 - sl2 * 60, aa = rowAlt[y];
              if (aa > lo && aa < hi) {
                const e = Math.min(aa - lo, hi - aa) / 60;
                if (Math.min(1, e) * 0.5 > K.dither(wx, wy) * 0.9) { const o = c; c = pack(mixc([o & 255, (o >> 8) & 255, (o >> 16) & 255], ochre, 0.45)); }
              }
            }
          }
          terr32[y * AW + x] = c;
        }
      }
      origCv.getContext('2d').putImageData(origImg, 0, 0);
      actx.drawImage(origCv, 0, 0);
    }
    let directing = false;
    const originalLook = () => view === 'overview' && !directing;
    function staticWorld() {
      const cls = sizeClass();
      terrainTops();
      if (originalLook()) renderTerrainOriginal(); else renderTerrain();
      const gy = (p) => Y(ground(p));
      // scenery across the face of the mountain, nearest (lowest on screen) last
      drawScape(cls);
      // a few trees right by the trail
      for (const tr of TRAIL_TREES) {
        if (!visible(tr.p)) continue;
        const a = ground(tr.p); if (a > 3920) continue;
        draw(a < 3450 ? K.tree(cls, tr.seed) : K.pine(cls, tr.seed), X(tr.p), gy(tr.p) + depth(tr.d), true);
      }
      // Lukla: the uphill airstrip and a little plane
      if (visible(0.074, 60)) {
        for (let x = Math.round(X(0.062)); x <= Math.round(X(0.086)); x++) {
          const y = Math.round(gy(pAt(x))) + 1;
          px(x, y, 'rgb(88,92,99)', 1, cls === 'S' ? 1 : 2);
          if (cls !== 'S' && ((x - oxA) % 4 + 4) % 4 < 2) px(x, y, 'rgba(255,255,255,0.85)');
        }
        if (cls !== 'S') draw(K.plane(), X(0.08), gy(0.08) - 1, true);
        draw(K.teahouse('S', 3), X(0.058), gy(0.058) + 1, true);
      }
      // Namche Bazaar: a few teahouses, the field, the pond, a grazing yak
      if (visible(0.205, 80)) {
        if (cls !== 'S') {
          draw(K.pond(cls === 'L' ? 9 : 5, cls === 'L' ? 3 : 2), X(0.172), gy(0.172) + depth(78), true);
        }
        for (const hs of HOUSES) {
          const sz = hs.big ? (cls === 'L' ? 'XL' : cls === 'M' ? 'L' : 'S') : (cls === 'L' ? 'L' : 'S');
          draw(K.teahouse(sz, hs.seed), X(hs.p), gy(hs.p) + depth(hs.d), true);
        }
        if (cls === 'L') draw(K.buildAlpaca(1, 'stand', { seed: 9 }), X(0.244), gy(0.244) + depth(64), true);
        if (cls !== 'S') { const fx = Math.round(X(0.232)), fy = Math.round(gy(0.232) + depth(12)); pline(fx, fy - 12, fx, fy, '#966c42'); }
      }
      if (visible(0.3, 60)) draw(K.monastery(cls === 'S' ? 'S' : 'L'), X(0.3), gy(0.3) + 1, true);
      // the Khumbu Icefall: seracs and a ladder over a crevasse
      if (visible(0.585, 80)) {
        const sA = clamp(cam.sy / 0.55, 0.3, 1.35) * DPR / UP;
        for (const sr of SERACS) {
          const w = Math.max(2, Math.round(sr.w * sA * 1.3)), h = Math.max(3, Math.round(sr.h * sA * 1.3));
          draw(K.serac(w, h, sr.shade), X(sr.p), gy(sr.p) + depth(sr.d), true);
        }
        if (cls !== 'S') {
          const lx1 = Math.round(X(0.588)), ly1 = Math.round(gy(0.588)) - 2, lx2 = Math.round(X(0.596)), ly2 = Math.round(gy(0.596)) - 2;
          pline(lx1, ly1, lx2, ly2, '#bcc2cc'); pline(lx1, ly1 - 3, lx2, ly2 - 3, '#bcc2cc');
          for (let i = 0; i <= 6; i++) { const tt = i / 6, x = Math.round(lerp(lx1, lx2, tt)), y = Math.round(lerp(ly1, ly2, tt)); pline(x, y, x, y - 3, '#8e96a4'); }
        }
      }
      if (cls !== 'S') for (let p = 0.565; p < 0.8; p += 0.06) if (visible(p)) draw(K.wand(), X(p) + 2, gy(p) + 2, true);
      for (const camp of CAMPS) {
        if (!visible(camp[0].p, 60)) continue;
        for (const tn of camp) draw(K.tent(tn.c, cls), X(tn.p), gy(tn.p) + depth(tn.d), true);
      }
      // the route ahead: dashed, world-anchored
      const x0 = Math.max(Math.round(X(P0)), 0), x1 = Math.min(Math.round(X(PS)), AW - 1);
      const dash = [], under = [];
      for (let x = x0; x <= x1; x++) if (((x - oxA) % 5 + 5) % 5 < 3) { const y = Math.round(gy(pAt(x))) - 2; dash.push(x, y); }
      actx.fillStyle = '#ff702e'; for (let q = 0; q < dash.length; q += 2) actx.fillRect(dash[q], dash[q + 1], 1, 1);
      actx.fillStyle = 'rgba(110,40,14,0.6)'; for (let q = 0; q < dash.length; q += 2) actx.fillRect(dash[q], dash[q + 1] + 1, 1, 1);
      if (WRtarget) for (let x = 0; x < AW; x++) WRtarget[WRoff + x] = clamp(Math.round(gy(pAt(x))) - 2, -30000, 30000);
    }
    // world cache: rebuilt when the zoom, light, size class or screen changes, or when the camera
    // slides past the margin; while zooming it is drawn without a margin every frame
    const isLit = (A) => A[0] < 0.995 || A[1] < 0.995 || A[2] < 0.995;
    const worldKey = () => cam.sx + ':' + cam.sy + ':' + sizeClass() + ':' + AW + 'x' + AH + ':' + (view === 'overview' ? 'o' : 'c');
    const worldCovers = (B) => B.valid && Math.abs(oxA - B.ox) <= B.mx && Math.abs(oyA - B.oy) <= B.my;
    // a world job: render (strips of terrain + scenery, untinted) and/or tint (strips of one multiply pass)
    function startWorldJob(render) {
      const mx = WMX, my = WMY, bx = Math.round(BIAS * mx), by = Math.round(BIAS * my);
      const F = wFront;
      const J = render
        ? { render: true, key: worldKey(), ox: oxA - bx, oy: oyA + by, mx, my, w: AW + 2 * mx, h: AH + 2 * my }
        : { render: false, key: F.key, ox: F.ox, oy: F.oy, mx: F.mx, my: F.my, w: F.u.width, h: F.u.height };
      J.AMB = wLight.AMB; J.amb = wLight.ambKey; J.lit = isLit(J.AMB); J.i = 0; J.n = render ? 8 : 3;
      const B = wBack;
      if (render) { if (B.u.width !== J.w || B.u.height !== J.h) { B.u.width = J.w; B.u.height = J.h; } if (B.wr.length < J.w) B.wr = new Int16Array(J.w + 64); }
      if (J.lit && (B.t.width !== J.w || B.t.height !== J.h)) { B.t.width = J.w; B.t.height = J.h; }
      wJob = J;
    }
    function stepWorldJob() {
      const J = wJob, B = wBack, src = J.render ? B.u : wFront.u;
      const x0 = Math.floor(J.i * J.w / J.n), x1 = Math.floor((J.i + 1) * J.w / J.n), sw = x1 - x0;
      if (J.render) {
        const g = B.ug;
        g.save(); g.beginPath(); g.rect(x0, 0, sw, J.h); g.clip(); g.clearRect(x0, 0, sw, J.h); g.translate(x0, 0);
        const sv = [AW, AH, oxA, oyA, actx, AMB, ambKey];
        AW = sw; AH = J.h; oxA = J.ox + J.mx - x0; oyA = J.oy + J.my; actx = g; AMB = [1, 1, 1]; ambKey = '24,24,24'; WRtarget = B.wr; WRoff = x0;
        try { staticWorld(); } finally { [AW, AH, oxA, oyA, actx, AMB, ambKey] = sv; WRtarget = null; g.restore(); }
      }
      if (J.lit) {   // the light: one multiply over the strip, alpha kept
        const g = B.tg;
        g.save(); g.beginPath(); g.rect(x0, 0, sw, J.h); g.clip();
        g.globalCompositeOperation = 'copy'; g.drawImage(src, 0, 0);
        g.globalCompositeOperation = 'multiply'; g.fillStyle = css([J.AMB[0] * 255, J.AMB[1] * 255, J.AMB[2] * 255]); g.fillRect(x0, 0, sw, J.h);
        g.globalCompositeOperation = 'destination-in'; g.drawImage(src, 0, 0);
        g.restore();
      }
      if (++J.i >= J.n) {
        if (J.render) {
          Object.assign(B, { valid: true, key: J.key, ox: J.ox, oy: J.oy, mx: J.mx, my: J.my, amb: J.amb, lit: J.lit });
          wBack = wFront; wFront = B;
        } else {   // tint only: swap the tinted copies
          const t = wFront.t, tg = wFront.tg; wFront.t = B.t; wFront.tg = B.tg; B.t = t; B.tg = tg;
          wFront.amb = J.amb; wFront.lit = J.lit;
        }
        wJob = null;
      }
    }
    function directWorld() {
      const sA = AMB, sK = ambKey;
      AMB = dLight.AMB; ambKey = dLight.ambKey; directing = true;
      try { staticWorld(); } finally { AMB = sA; ambKey = sK; directing = false; }
    }
    function drawWorld(settled) {
      const sA = AMB, sK = ambKey;
      AMB = wLight.AMB; ambKey = wLight.ambKey;
      try { drawWorld0(settled); } finally { AMB = sA; ambKey = sK; }
    }
    function drawWorld0(settled) {
      // while zooming, caches would be thrown away next frame: draw straight onto the screen
      if (!settled) { wJob = null; wDX = null; directWorld(); return; }
      const key = worldKey(), F = wFront;
      if (wJob && wJob.render && wJob.key !== key) wJob = null;
      if (wJob && !wJob.render && (F.key !== key || !F.valid)) wJob = null;
      const ok = F.valid && F.key === key && worldCovers(F);
      if (!wJob) {
        const recentre = ok && (Math.abs(oxA - F.ox - BIAS * F.mx) > F.mx * 0.4 || Math.abs(oyA - F.oy + BIAS * F.my) > F.my * 0.4);
        if (!ok || recentre) startWorldJob(true);
        else if ((isLit(AMB) || F.lit) && F.amb !== ambKey) startWorldJob(false);
      }
      // the front that can't draw gets the strip first
      while (wJob && stripBudget > 0 && (!ok || stripBudget > 1 || !RF.some((R) => R.job))) { stripBudget--; stepWorldJob(); if (!still || stripBudget < 2) break; }
      const G = wFront;
      if (!(G.valid && G.key === key && worldCovers(G))) { wDX = null; directWorld(); return; }
      const dx = oxA - G.ox, dy = oyA - G.oy;
      let gTop = AH;
      for (let x = 0; x < AW; x += 4) { const y = Y(ground(pAt(x + 0.5))); if (y < gTop) gTop = y; }
      { const y = Y(ground(pAt(AW - 0.5))); if (y < gTop) gTop = y; }
      const y0 = clamp(Math.floor(gTop) - 52, 0, AH), hh = AH - y0;
      const src = G.lit ? G.t : G.u;
      if (hh > 0) actx.drawImage(src, -(dx - G.mx), y0 - (dy - G.my), AW, hh, 0, y0, AW, hh);
      wDX = dx - G.mx; wDY = dy - G.my;
    }

    const STAR_A = [0.2, 0.35, 0.5, 0.65, 0.8, 0.95];
    function render(dt) {
      mapCamera();
      gyFrame++;
      const camKey = oxA + ',' + oyA + ',' + cam.sx + ',' + cam.sy + ',' + Math.round(climb);
      stillFrames = camKey === lastCamKey ? stillFrames + 1 : 0; lastCamKey = camKey;
      // still: nothing has moved for a few frames, the camera has arrived, and no ride is running
      still = stillFrames >= 3 && !ride && cam.p === tgt.p && cam.alt === tgt.alt && cam.sx === tgt.sx && cam.sy === tgt.sy;
      const settled = cam.sx === tgt.sx && cam.sy === tgt.sy;
      const timeAlt = clamp(skyOverride != null ? skyOverride : climb, C.startAlt, C.summitAlt);
      const sky = skyAt(timeAlt);
      AMB = sky.amb; HAZE = sky.bot;
      ambKey = AMB.map((v) => Math.round(v * 24)).join(',');
      AMB = ambKey.split(',').map((v) => Number(v) / 24);
      // the cached world re-tints in strips at any time; the direct-draw fallback (which tints sprite by
      // sprite) keeps its light until the scene is still
      wLight = { AMB, ambKey };
      if (still || !dLight) dLight = wLight;
      // haze follows the same 64 sky steps as the cached sky, so range caches don't rebuild every frame
      const hq = Math.round((timeAlt - C.startAlt) / ((C.summitAlt - C.startAlt) / 64)) * ((C.summitAlt - C.startAlt) / 64) + C.startAlt;
      HAZE = skyAt(hq).bot.map((v) => Math.round(v));
      renderSky(sky, timeAlt);
      actx.globalCompositeOperation = 'source-over'; actx.globalAlpha = 1;
      const celestial = () => {

      if (sky.star > 0.02) {
        // stars in a few brightness buckets, so the fill style changes only a handful of times
        const buckets = [[], [], [], [], [], []];
        for (const s of STARS) {
          const tw = reduced ? 1 : 0.6 + 0.4 * Math.sin(Math.floor(time * 8) / 8 * s.sp + s.ph);
          const al = sky.star * tw, bi = clamp(Math.round(al * 6) - 1, 0, 5);
          if (al < 0.1) continue;
          const x = Math.floor(s.x * AW), y = Math.floor(s.y * AH);
          buckets[bi].push(x, y);
          if (s.big && tw > 0.85) { const b2 = clamp(bi - 3, 0, 5); buckets[b2].push(x - 1, y, x + 1, y, x, y - 1, x, y + 1); }
        }
        for (let bi = 0; bi < 6; bi++) { const a = buckets[bi]; if (!a.length) continue; actx.fillStyle = `rgba(255,252,236,${STAR_A[bi]})`; for (let q = 0; q < a.length; q += 2) actx.fillRect(a[q], a[q + 1], 1, 1); }
      }
      const t = clamp((timeAlt - C.startAlt) / (C.summitAlt - C.startAlt), 0, 1);
      const sunA = clamp((0.93 - t) / 0.1, 0, 1);
      if (sunA > 0) {
        const sx = AW * (0.14 + 0.76 * t), sy = AH * (0.5 - 0.4 * Math.sin(Math.PI * Math.min(t, 0.98)));
        const scol = t < 0.25 ? mixc(hex('#ffc9a0'), hex('#fff4d6'), t / 0.25) : t < 0.7 ? hex('#fff4d6') : mixc(hex('#ffd08a'), hex('#ff7a59'), (t - 0.7) / 0.3);
        const q = (c) => '#' + c.map((v) => Math.min(255, Math.round(v / 16) * 16).toString(16).padStart(2, '0')).join('');
        const glow = mixc(scol, sky.bot, 0.5);
        draw(K.disc(7, q(scol), q(mixc(scol, [255, 160, 120], 0.25)), q(glow)), sx, sy, false, Math.round(sunA * 10) / 10);
      }
      const moonA = clamp((t - 0.82) / 0.12, 0, 1);
      if (moonA > 0) {
        const mx = Math.round(AW * 0.22), my = Math.round(AH * 0.17);
        draw(K.moon(), mx, my, false, Math.round(0.95 * moonA * 10) / 10);
      }

      };
      // the caches serve the frame when they can; while moving they are never rebuilt (a dropped frame
      // only shows in motion), so a frame they can't cover is drawn directly instead
      stripBudget = still ? 4 : 1;
      const rangesOk = rangesPlan(settled);
      if (rangesOk) {
        const offs = RF.map((R, ri) => { const [dx, dy] = rangeOffset(ri, R.front); return (Math.round(dx) - R.front.mx) + ',' + (Math.round(dy) - R.front.my) + ',' + R.front.key + R.front.ck; });
        const bk = skyKey + '|' + offs.join('|') + '|' + (sky.star > 0.02 && !reduced ? Math.floor(time * 8) : 0) + '|' + Math.round(timeAlt / 15) + '|' + AW + 'x' + AH;
        if (bk !== bdKey) {
          if (bdCv.width !== AW || bdCv.height !== AH) { bdCv.width = AW; bdCv.height = AH; }
          const sv = actx; actx = bdG;
          try { actx.drawImage(skyCv, 0, 0); celestial(); drawRangeFronts(true); } finally { actx = sv; }
          bdKey = bk;
        }
        actx.drawImage(bdCv, 0, 0);
      } else bdKey = '';
      if (!rangesOk) {
        // zooming or out of cache: sky and ranges go down in one pixel write; stars, sun and moon are clipped to the open sky
        renderRangesFlat();
        actx.save(); actx.beginPath(); actx.moveTo(0, 0);
        for (let x = 0; x < AW; x++) { actx.lineTo(x, skyTop[x]); actx.lineTo(x + 1, skyTop[x]); }
        actx.lineTo(AW, 0); actx.closePath(); actx.clip();
        celestial(); actx.restore();
      }

      const cls = sizeClass();
      if (cam.sy > 0.2) {
        for (const c of CLOUDS) {
          const x = cssXToArt(W / 2 + (c.u - cam.p) * cam.sx * 0.75 + (reduced ? 0 : (time * 4) % 60));
          const y = cssYToArt(H / 2 - (c.a - cam.alt) * cam.sy * 0.72);
          if (x < -60 || x > AW + 60 || y < -30 || y > AH + 30) continue;
          draw(K.cloud(cls === 'L' && c.w > 120 ? 'L' : cls === 'S' ? 'S' : 'M', c.seed), x, y, true, 0.92);
        }
      }

      drawWorld(settled);
      if (settled) stepRangeJobs();

      const gy = (p) => Y(ground(p));
      // animated bits of the villages: prayer flags and chimney smoke
      if (visible(0.205, 80) && cls !== 'S') {
        const big = HOUSES.find((h) => h.big), sz = cls === 'L' ? 'XL' : 'L', s = K.teahouse(sz, big.seed);
        const bx = X(big.p), by = gy(big.p) + depth(big.d);
        const rx = bx + s.ridge[0], ry = by + s.ridge[1];
        const fx = X(0.232), fy = gy(0.232) + depth(12);
        flags(rx, ry, fx, fy - 12, 3);
        if (!reduced) for (let i = 0; i < 4; i++) { const k = ((time * 0.35 + i / 4) % 1); draw(K.smokePuff(Math.round(1 + k * 2.4)), bx - 4 + k * 6, ry - 3 - k * 16, true, Math.round((1 - k) * 8) / 8); }
      }
      if (visible(0.548, 60) && cls !== 'S') flags(X(0.538), gy(0.538) - 8, X(0.558), gy(0.558) - 9, 3);
      if (visible(PS, 60)) {
        const sx = X(PS), sy = gy(PS);
        const r = cls === 'S' ? 10 : 22;
        flags(sx, sy - 2, sx - r, sy + r * 0.8, 3);
        flags(sx, sy - 2, sx + r * 0.9, sy + r * 0.9, 3);
      }
      // the route behind the climber: solid orange
      const pc = pFor(climb);
      {
        const x0 = Math.max(Math.round(X(P0)), 0), xc = Math.min(Math.round(X(pc)), AW - 1);
        if (xc >= x0) {
          const ys = [];
          if (wDX !== null) for (let x = x0; x <= xc; x++) ys.push(wFront.wr[x - wDX] + wDY);
          else for (let x = x0; x <= xc; x++) ys.push(Math.round(gy(pAt(x))) - 2);
          actx.fillStyle = '#ff702e'; for (let x = x0; x <= xc; x++) actx.fillRect(x, ys[x - x0] - 1, 1, 2);
          actx.fillStyle = 'rgba(110,40,14,0.7)'; for (let x = x0; x <= xc; x++) actx.fillRect(x, ys[x - x0] + 1, 1, 1);
        }
      }

      // altitude scale while climbing
      const overview = cam.sy < 0.2;
      if (!overview) {
        const aTop = altAt(0), aBot = altAt(AH);
        for (let a = Math.ceil(aBot / 100) * 100; a <= aTop; a += 100) {
          const y = Math.round(Y(a)), major = a % 500 === 0;
          px(1, y, major ? 'rgba(255,255,255,0.85)' : 'rgba(255,255,255,0.5)', major ? 5 : 3, 1);
          if (major) { const s = K.text(fmt(a), { color: '#ffffff', outline: '#281e16' }); actx.drawImage(s.cv, 8, y - Math.floor(s.h / 2)); }
        }
      }
      const dzy = Math.round(Y(8000));
      if (dzy > -4 && dzy < AH + 4) { actx.fillStyle = 'rgba(255,110,90,0.75)'; for (let x = 0; x < AW; x++) if (((x - oxA) % 6 + 6) % 6 < 3) actx.fillRect(x, dzy, 1, 1); }
      const wide = W >= 700;
      // landmark signs step aside during a yak ride, so the herd and its banner have the stage
      // overview: signs are placed in priority order, each on its preferred side, else the other side,
      // else left out, so they never pile up when the mountain is small (a phone above a card)
      const cx0 = Math.round(X(pc)), cy0 = Math.round(gy(pc));
      const taken = [];
      const hits = (a) => taken.some((b) => a.x < b.x + b.w + 2 && b.x < a.x + a.w + 2 && a.y < b.y + b.h + 1 && b.y < a.y + a.h + 1);
      if (overview && !ride) {
        taken.push({ x: cx0 - 8, y: cy0 - 24, w: 16, h: 24 });   // the climber
        if (view === 'overview' && showPin) { const s = K.sign(fmt(Math.round(climbTarget)) + ' m', null, { accent: true }); taken.push({ x: clamp(cx0 - s.w / 2, 2, AW - s.w - 2), y: cy0 - 30 - s.h, w: s.w, h: s.h }); }
      }
      // phones: milestone signs about 10% smaller (tighter padding and word spacing; see K.sign)
      const SIGN_O = W < 900 ? SIGN_SMALL : undefined;
      if (!ride) for (const m of (overview ? PLATE_ORDER : C.milestones)) {
        const p = m._p != null ? m._p : (m._p = pFor(m.alt)), x = Math.round(X(p)), y = Math.round(gy(p));
        if (m.id === 'deathzone') {
          if (dzy < -30 || dzy > AH + 30) continue;
          const s = K.sign('8,000 m', 'Death Zone', SIGN_O), r = { x: AW - s.w - 5, y: dzy - s.h - 3, w: s.w, h: s.h };
          if (overview && hits(r)) continue;
          taken.push(r); actx.drawImage(s.cv, r.x, r.y); continue;
        }
        if (x < -80 || x > AW + 80 || y < -30 || y > AH + 30) continue;
        if (overview) {
          const s = K.sign(m.short, wide ? fmt(m.alt) + ' m' : null, SIGN_O);
          const yy = Math.round(y - (m.id === 'summit' ? 9 : m.id === 'teahouse' ? 8 : 4) - Math.floor(s.h / 2));
          // keep signs inside the framed rect (not under the home card or the results sheet)
          const xL = rect ? Math.max(2, Math.round((rect.x0 * DPR - LX - shX) / UP)) : 2;
          const xR = rect ? Math.min(AW - 2, Math.round((rect.x1 * DPR - LX - shX) / UP)) : AW - 2;
          const lx = Math.round(clamp(x - 4 - s.w, xL, xR - s.w)), rx = Math.round(clamp(x + 4, xL, xR - s.w));
          const sides = ['lukla', 'camp1'].includes(m.id) ? [rx, lx] : [lx, rx];
          // the summit sign may also sit straight above the peak
          if (m.id === 'summit') sides.push({ x: Math.round(clamp(x - s.w / 2, xL, xR - s.w)), y: y - 12 - s.h });
          for (const sd of sides) {
            const r = typeof sd === 'number' ? { x: sd, y: yy, w: s.w, h: s.h } : { x: sd.x, y: sd.y, w: s.w, h: s.h };
            if (hits(r)) continue;
            taken.push(r); actx.drawImage(s.cv, r.x, r.y); break;
          }
        } else {
          pline(x, y, x, y - 14, 'rgba(40,30,22,0.85)');
          const s = K.sign(m.short, fmt(m.alt) + ' m', SIGN_O);
          actx.drawImage(s.cv, Math.round(clamp(x - 2 - s.w, 2, AW - s.w - 2)), y - 15 - s.h);
        }
      }
      if (ghost && ghost > C.startAlt + 20) {
        const gp = pFor(ghost), gx = Math.round(X(gp)), gyy = Math.round(gy(gp));
        draw(climberSprite('stand', { ghost: true }), gx, gyy, false, 0.35);
        const s = K.sign('Your best', fmt(ghost) + ' m');
        actx.globalAlpha = 0.9; actx.drawImage(s.cv, Math.round(clamp(gx + 8, 2, AW - s.w - 2)), gyy - 22); actx.globalAlpha = 1;
      }
      const cx = Math.round(X(pc)), cy = Math.round(gy(pc));
      if (overview) {
        const pr = reduced ? 0 : (time * 1.2) % 1;
        draw(K.ring(Math.round(4 + pr * 8), '#ff702e'), cx, cy - 6, false, Math.round(0.85 * (1 - pr) * 10) / 10);
      }
      if (ride) drawRide(dt, cx, cy);
      else {
        const cheer = time < cheerUntil;
        const pose = cheer ? 'cheer' : moving && !reduced && Math.floor(time * 6) % 2 ? 'walk' : 'stand';
        if (climb >= C.summitAlt - 1) draw(K.overlay('flag'), cx - 7, cy);
        draw(climberSprite(climb >= C.summitAlt - 1 && !reduced && Math.floor(time * 2) % 2 ? 'cheer' : pose), cx, cy);
      }
      // the pin shows where the climb lands (one sign, not one per animated metre)
      if (overview && view === 'overview' && showPin) { const s = K.sign(fmt(Math.round(climbTarget)) + ' m', null, { accent: true }); actx.drawImage(s.cv, Math.round(clamp(cx - s.w / 2, 2, AW - s.w - 2)), cy - 30 - s.h); }

      const BCOL = ['#c8cdd4', '#5cc580', '#63aaf5', '#b58cf3', '#ffc846'];
      for (let i = bursts.length - 1; i >= 0; i--) {
        const b = bursts[i]; b.t += dt;
        const k = b.t / b.dur; if (k >= 1) { bursts.splice(i, 1); continue; } if (k < 0) continue;
        draw(K.ring(Math.round(4 + k * b.r), BCOL[b.tier]), cx, cy - 12, false, (1 - k) * 0.95);
        actx.globalAlpha = 1 - k; actx.fillStyle = BCOL[b.tier];
        for (const sp of b.sparks) { const d = k * sp.v; actx.fillRect(Math.round(cx + Math.cos(sp.a) * d - 1), Math.round(cy - 12 + Math.sin(sp.a) * d - 1), 2, 2); }
        actx.globalAlpha = 1;
      }
      if (!reduced) {
        const snowAmt = timeAlt > 5300 && timeAlt < 8300 ? 50 : 0;
        while (flakes.length < snowAmt) flakes.push({ x: Math.random() * AW, y: Math.random() * AH, v: 7 + Math.random() * 15, big: Math.random() < 0.3 });
        if (flakes.length > snowAmt) flakes.length = snowAmt;
        if (flakes.length) { actx.fillStyle = 'rgba(255,255,255,0.85)'; for (const f of flakes) { f.y += f.v * dt; f.x += (9 + f.v * 0.3) * dt; if (f.y > AH) { f.y = -2; f.x = Math.random() * AW; } if (f.x > AW) f.x = 0; actx.fillRect(Math.round(f.x), Math.round(f.y), f.big ? 2 : 1, f.big ? 2 : 1); } }
        const windAmt = timeAlt > 7000 ? Math.round(6 + (timeAlt - 7000) / 70) : 0;
        while (streaks.length < windAmt) streaks.push({ x: Math.random() * AW, y: Math.random() * AH * 0.9, l: 15 + Math.random() * 45, v: 150 + Math.random() * 200 });
        if (streaks.length > windAmt) streaks.length = windAmt;
        if (streaks.length) { actx.fillStyle = 'rgba(255,255,255,0.28)'; for (const w of streaks) { w.x += w.v * dt; if (w.x - w.l > AW) { w.x = -5; w.y = Math.random() * AH * 0.9; } actx.fillRect(Math.round(w.x - w.l), Math.round(w.y), Math.round(w.l), 1); } }
      }
      // prayer-flag confetti, drawn in batches of one colour and fade step
      if (confetti.length) {
        const B = {};
        for (let i = confetti.length - 1; i >= 0; i--) {
          const c = confetti[i]; c.life -= dt;
          if (c.life <= 0) { confetti.splice(i, 1); continue; }
          c.vy += 30 * dt; c.x += (c.vx + Math.sin(time * 3 + c.ph) * 15) * dt; c.y += c.vy * dt; c.rot += c.vr * dt;
          const k = c.col + '|' + Math.ceil(Math.min(1, c.life) * 4);
          (B[k] || (B[k] = [])).push(c);
        }
        for (const k in B) {
          const [col, a] = k.split('|'); actx.fillStyle = col; actx.globalAlpha = Number(a) / 4;
          for (const c of B[k]) { const flip = Math.floor(c.rot) % 2 === 0; actx.fillRect(Math.round(c.x), Math.round(c.y), flip ? 3 : 2, flip ? 2 : 3); }
        }
        actx.globalAlpha = 1;
      }
      drawSplat(dt);

      // sub-pixel smoothness: shift the whole canvas by whole device pixels
      const k2 = shX + ',' + shY;
      if (k2 !== shKey) { shKey = k2; cv.style.transform = `translate(${shX / DPR}px,${shY / DPR}px)`; }
    }

    let showPin = false;
    // capped at 60 fps: on 90/120 Hz screens extra animation frames are skipped (the next draw is due
    // 1/60 s after the last one was due, with a little slack so a 60 Hz screen never skips)
    let nextDue = 0;
    function frame(ts) {
      if (ts < nextDue - 2) { requestAnimationFrame(frame); return; }
      nextDue = Math.max(nextDue + 1000 / 60, ts);
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
      // the zoom snaps home once it is within 0.4%, so the cached layers stop rebuilding
      if (Math.abs(cam.sx - tgt.sx) <= tgt.sx * 0.004) cam.sx = tgt.sx;
      // the slide ends once it is within a third of a CSS pixel, so the scene really comes to rest
      if (Math.abs(cam.p - tgt.p) * cam.sx < 0.33 && Math.abs(cam.alt - tgt.alt) * cam.sy < 0.33) { cam.p = tgt.p; cam.alt = tgt.alt; }
      if (Math.abs(cam.sy - tgt.sy) <= tgt.sy * 0.004) cam.sy = tgt.sy;
      snap = false;
      if (AW > 0 && AH > 0) render(dt);
      if (onFrame) onFrame(climb, dt);
      requestAnimationFrame(frame);
    }

    // build every scenery sprite size ahead of time in small idle slices, so the first zoom into a new
    // size class doesn't stall a frame building them
    function warmSprites() {
      const jobs = [];
      for (const z of ['L', 'M', 'S']) {
        for (let i = 0; i < 7; i++) jobs.push(() => K.tree(z, i), () => K.pine(z, i));
        for (let i = 0; i < 3; i++) jobs.push(() => K.stoneHut(z, i), () => K.crevasse(z, i));
        for (let i = 0; i < 4; i++) for (let t = 0; t < 3; t++) jobs.push(() => K.outcrop(z, i, t));
        for (let i = 0; i < 2; i++) jobs.push(() => K.flagPole(z, i));
        jobs.push(() => K.chorten(z), () => K.cairn(z), () => K.maniWall(z), () => K.monastery(z === 'S' ? 'S' : 'L'));
        for (const c of TENT) jobs.push(() => K.tent(c, z));
        for (let i = 0; i < 5; i++) jobs.push(() => K.cloud(z, i));
      }
      for (const z of ['XL', 'L', 'S']) for (const h of HOUSES) jobs.push(() => K.teahouse(z, h.seed));
      for (let i = 0; i < 8; i++) jobs.push(() => K.teahouse('L', 20 + i), () => K.teahouse('S', 20 + i));
      for (let i = 0; i < 5; i++) jobs.push(() => K.stone(2.2, i), () => K.stone(2.4, i), () => K.stone(2.6, i), () => K.stone(1.4, i), () => K.stone(1.5, i));
      for (let i = 0; i < 4; i++) jobs.push(() => K.flowers(i));
      jobs.push(() => K.bush(0), () => K.bush(1), () => K.field(14, 2), () => K.field(8, 2), () => K.field(22, 3), () => K.field(12, 2), () => K.pond(9, 3), () => K.pond(5, 2), () => K.plane(), () => K.moon());
      for (let i = 0; i < 5; i++) jobs.push(() => K.buildAlpaca(i % K.COATS.length, 'stand', { seed: 20 + i }));
      // the yak ride's sprites, so the first ride doesn't build them mid-gallop
      for (let c = 0; c < K.COATS.length; c++) for (const f of ['stand', 'run', 'sled']) for (let sd = 0; sd < 8; sd++) jobs.push(() => K.buildAlpaca(c, f, { seed: sd }));
      for (const f of ['stand', 'run', 'sled']) for (let sd = 0; sd < 8; sd++) jobs.push(() => K.buildAlpaca('gold', f, { seed: sd }));
      jobs.push(() => K.buildAlpaca(1, 'stand', { sad: true }), () => K.buildAlpaca(1, 'run', {}), () => K.buildAlpaca(1, 'stand', {}));
      for (const o of ['mask', 'lamp', 'beam', 'map', 'sparkle', 'dizzy', 'flag', 'canopy', 'splat']) jobs.push(() => K.overlay(o));
      for (const pose of ['stand', 'walk', 'cheer', 'sit']) jobs.push(() => climberSprite(pose), () => climberSprite(pose, { hatless: true }));
      jobs.push(() => climberSprite('stand', { ghost: true }), () => K.hatSprites(null), () => K.sign('YAK EXPRESS', null), () => K.text('?', { color: '#ffffff', outline: '#281e16', bold: true }));
      for (const c of Object.values({ grass: '#b09670', trail: '#96928c', glacier: '#fafcff', deathzone: '#ecf0fa' })) for (let r = 1; r <= 4; r++) jobs.push(() => K.puff(r, c));
      const step = (dl) => {
        const t0 = performance.now();
        while (jobs.length && (dl ? dl.timeRemaining() > 2 : performance.now() - t0 < 3)) { try { tintOf(jobs.shift()()); } catch (e) { /* skip */ } }
        if (jobs.length) schedule();
      };
      const schedule = () => (window.requestIdleCallback ? requestIdleCallback(step, { timeout: 300 }) : setTimeout(step, 16));
      schedule();
    }

    // web fonts arrive after the first frames: rebuild the cached text sprites then
    try {
      if (document.fonts) {
        document.fonts.load('8px Silkscreen').then(() => K.clearTextCaches(), () => {});
        document.fonts.ready.then(() => K.clearTextCaches(), () => {});
      }
    } catch (e) { /* no font loading API */ }

    return {
      start() { resize(); window.addEventListener('resize', resize); requestAnimationFrame((t) => { last = t; frame(t); }); warmSprites(); },
      resize,
      // the view is mirrored on the element (#scene[data-view], read by the smoke test); written on view changes, never per frame
      setView(v, r, opts) { view = v; rect = r || null; showPin = !!(opts && opts.pin); if (cv.dataset.view !== v) cv.dataset.view = v; computeTarget(); if (opts && opts.snap) snap = true; },
      setClimb(a, opts) { climbTarget = clamp(a, C.startAlt, C.summitAlt); if (opts && opts.snap) { climb = climbTarget; snap = true; } },
      setGhost(a) { ghost = a || null; },
      setReduced(v) { reduced = !!v; },
      setSkyOverride(a) { skyOverride = a == null ? null : clamp(Number(a), C.startAlt, C.summitAlt); },
      get skyOverride() { return skyOverride; },
      // cosmetics: dev preview only for now; the game always passes null (the default climber)
      setOutfit(o) { outfit = o && typeof o === 'object' ? Object.assign({}, o) : null; },
      get outfit() { return outfit ? Object.assign({}, outfit) : null; },
      get artSize() { return { w: AW, h: AH, px: PX, up: UP }; },
      onFrame(fn) { onFrame = fn; },
      get alt() { return climb; },
      // yak ride: resolves true when it finishes, false if cancelled
      ride(plan, o) { return startRide(plan, o || {}); },
      cancelRide() { if (ride) endRide(false); splat = null; },
      get riding() { return !!ride; },
      rideState,
      get night() { return skyAt(clamp(skyOverride != null ? skyOverride : climb, C.startAlt, C.summitAlt)).star > 0.3; },
      burst(tier) {
        if (reduced) return;
        const s = tier * 1.4, n = 6 + Math.round(s * 5), sparks = [];
        for (let i = 0; i < n; i++) sparks.push({ a: Math.random() * Math.PI * 2, v: 15 + Math.random() * (20 + s * 14) });
        bursts.push({ t: 0, dur: 0.7 + s * 0.15, r: 15 + s * 11, tier, sparks });
        if (tier >= 3) bursts.push({ t: -0.15, dur: 1.2 + s * 0.12, r: 30 + s * 15, tier, sparks: [] });
        if (tier >= 2) cheerUntil = time + (tier >= 3 ? 1.6 : 0.9);
      },
      confetti() {
        if (reduced) return;
        const cols = ['#3c78dc', '#faf8f0', '#dc3c3c', '#3caa5a', '#fad23c'];
        for (let i = 0; i < 140; i++) confetti.push({ x: Math.random() * AW, y: -10 - Math.random() * AH * 0.4, vx: (Math.random() - 0.5) * 30, vy: 20 + Math.random() * 40, rot: Math.random() * 6, vr: (Math.random() - 0.5) * 8, col: cols[i % 5], ph: Math.random() * 6, life: 2.6 + Math.random() * 1.2 });
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
    legIdx: 0, aid: 0, lastSubmit: 0, camp: false, campGo: null, campT: 0, lastSec: -1, pauseUntil: 0,
    rideQ: [], rideActive: null, slotT: 0, slotTxt: '',   // yak rides (queued, playing) and the slot-machine altimeter
    dev: null,   // dev climb tool state (mode 'dev' only), see the dev mode section
  };
  // camp report and gain-pop states as classes (see the stylesheet: cheaper than :has())
  try {
    const tr = $('#transition'), play = $('#play'), form = $('#answer-form');
    new MutationObserver(() => play.classList.toggle('camp-report', !tr.hidden)).observe(tr, { attributes: true, attributeFilter: ['hidden'] });
    new MutationObserver(() => form.classList.toggle('popping', !!form.querySelector('.gain-pop'))).observe(form, { childList: true });
  } catch (e) { /* no observers: the states just don't restyle */ }
  const ui = {
    home: $('#home'), play: $('#play'), results: $('#results'), app: $('#app'),
    input: $('#answer'), chips: $('#chips'), feedback: $('#feedback'), category: $('#category'),
    fill: $('#timer-fill'), timer: $('#timer'), secs: $('#secs'), alt: $('#alt-num'), air: $('#air'), next: $('#next-mark'),
    legs: $('#legs'), live: $('#sr-live'),
  };
  const announce = (t) => { ui.live.textContent = ''; setTimeout(() => { ui.live.textContent = t; }, 30); };
  // Dev climbs run legs forever; each leg uses one position (0 to NL−1) of the normal
  // pattern for its timer, multiplier and category pool. Daily legs: pos = index.
  const NL = C.legs.length;   // legs in a daily climb
  const legWord = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'][NL] || String(NL);
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
    } else {
      // play: frame the climber in the open strip below the answer card (and the room its tags can
      // take), above the phone keyboard; during a ride the card fades, so the strip starts under the HUD
      measureKeyboard();
      const vv = window.visualViewport;
      const visTop = vv ? vv.offsetTop : 0, visBot = vv ? vv.offsetTop + vv.height : H;
      const hud = $('.hud').getBoundingClientRect();
      const card = $('.play-card').getBoundingClientRect(), chips = ui.chips.getBoundingClientRect();
      const chipsMax = parseFloat(getComputedStyle(ui.chips).maxHeight) || 0;
      const top = Math.max(card.bottom, chips.top + chipsMax, visTop);
      const nm = ui.next.getBoundingClientRect();
      const bot = nm.height > 0 && nm.top > top && nm.top < visBot ? nm.top - 4 : visBot;
      if (G.camp) {
        // camp break: pull out to the whole mountain in the space the camp report leaves (above it on
        // phones, beside it on wide screens), with the pin on where the climb has reached
        const tc = $('.trans-card').getBoundingClientRect();
        const y0 = Math.max(hud.bottom, visTop) + 10;
        if (W >= 900 && tc.width) Scene.setView('overview', { x0: 24, y0, x1: tc.left - 24, y1: visBot - 24 }, { pin: true });
        else Scene.setView('overview', { x0: 8, y0, x1: W - 8, y1: Math.max(y0 + 80, (tc.height ? tc.top : visBot) - 10) }, { pin: true });
      } else Scene.setView('follow', { x0: 0, y0: top, x1: W, y1: bot, hud: Math.max(hud.bottom, visTop) });
    }
  }
  // The phone keyboard covers the bottom of the layout viewport (the visual viewport shrinks); how much is
  // kept in --kb, and .kb-open on <html> compacts the leg screen so the climber's strip stays clear.
  let kbPx = 0;
  function measureKeyboard() {
    const vv = window.visualViewport;
    const covered = vv ? window.innerHeight - (vv.height + vv.offsetTop) : 0;
    const k = covered > 80 ? Math.round(covered) : 0;
    if (k !== kbPx) {
      kbPx = k;
      document.documentElement.style.setProperty('--kb', k + 'px');
      document.documentElement.classList.toggle('kb-open', k > 0);
    }
    return k;
  }
  window.addEventListener('resize', () => requestAnimationFrame(layoutScene));
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', () => requestAnimationFrame(layoutScene));
    window.visualViewport.addEventListener('scroll', () => requestAnimationFrame(layoutScene));
  }

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
    $('#fact-today').innerHTML = done ? fmt(r.final) + '<small> m</small>' : NL + ' legs';
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
    const n = G.mode === 'practice' ? 1 : NL;
    for (let i = 0; i < n; i++) { const li = document.createElement('li'); li.setAttribute('aria-label', 'Leg ' + (i + 1)); ui.legs.appendChild(li); }
    renderLegDots();
    ui.input.focus({ preventScroll: true });
  }
  function renderLegDots() {
    const at = legPos(G.legIdx);   // dev climbs: the position in the leg pattern
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
    const who = G.mode === 'practice' ? 'Practice' : G.mode === 'dev' ? `Dev leg ${i + 1}` : `Leg ${i + 1} of ${NL}`;
    announce(`${who}: ${G.cats[i].text}. ${Math.round(secs)} seconds.`);
    devEmit('leg-start', i);
    requestAnimationFrame(layoutScene);   // the category's height can change the climber's strip
  }
  function setLegHeader(i, secs, mult) {
    ui.category.textContent = G.cats[i].text;
    ui.category.classList.remove('veiled');
    $('#leg-label').textContent = G.mode === 'practice' ? 'Practice climb' : G.mode === 'dev' ? `Dev leg ${i + 1} · pattern ${legPos(i) + 1} of ${NL}` : `Leg ${i + 1} of ${NL}`;
    $('#leg-mult').textContent = `${Math.round(secs)} s  ×${mult}`;
  }
  function setNight() {
    const alt = Scene.alt;
    let night = (G.screen === 'play' && G.mode === 'daily' && (G.legIdx >= NL - 2 || alt >= 8000)) || (G.screen === 'results' && G.mode === 'daily' && G.round && G.round.final >= 8000);
    if (G.mode === 'dev' && G.dev) night = G.dev.night != null ? G.dev.night : (G.screen === 'play' && (legPos(G.legIdx) >= NL - 2 || alt >= 8000));
    ui.app.classList.toggle('night', !!night);
  }

  // ---------------------------------------------------------------- per frame
  // the HUD writes to the page only when something it shows has changed: rewriting the same
  // HTML every frame forced a style recalc and layout 60 times a second
  const hudLast = {};
  const hudSet = (k, el, v, html) => { if (hudLast[k] === v) return; hudLast[k] = v; if (html) el.innerHTML = v; else el.textContent = v; };
  // the altimeter rolls every frame while climbing: change one text node, not the element's HTML
  function setAlt(str, slot) {
    const key = (slot ? 's' : 'n') + str;
    if (hudLast.alt === key) return;
    const wasNum = hudLast.alt && hudLast.alt[0] === 'n';
    hudLast.alt = key;
    if (!slot && wasNum && ui.alt.firstChild && ui.alt.firstChild.nodeType === 3) { ui.alt.firstChild.nodeValue = str; return; }
    ui.alt.innerHTML = slot ? `<span class="slot">${str}</span><small>m</small>` : `${str}<small>m</small>`;
  }
  Scene.onFrame((alt) => {
    devTick();
    if (G.screen === 'play') {
      // while the numbers roll, the text updates at most 20 times a second; when they stop, at once
      const tNow = performance.now(), rolling = alt !== hudLast.prevAlt;
      hudLast.prevAlt = alt;
      const textDue = !rolling || tNow - (hudLast.tText || 0) >= 50;
      if (textDue) hudLast.tText = tNow;
      const rs = Scene.rideState();
      if (rs && rs.phase === 'gallop' && !isReduced()) {
        // slot machine: the digits spin while the herd gallops, then land on the drop-off
        const t = performance.now();
        if (t - G.slotT > 55) { G.slotT = t; G.slotTxt = fmt(Math.round(rs.to)).replace(/\d/g, () => String(Math.floor(Math.random() * 10))); }
        setAlt(G.slotTxt, true);
      } else if (textDue) setAlt(fmt(alt), false);
      if (textDue) {
        hudSet('air', ui.air, 'Air ' + E.airPercent(alt) + '%');
        const nx = E.nextMilestone(alt + 0.5);
        hudSet('next', ui.next, nx ? `Next: <b>${esc(nx.short)}</b> in ${fmt(Math.ceil((nx.alt - alt) / 10) * 10)} m` : '<b>On the summit</b>', true);
      }
      if (G.state === 'leg') {
        const leg = curLeg();
        const paused = devPaused();
        const rem = Math.max(0, leg.deadline - Math.max(paused ? G.dev.pausedAt : now(), G.pauseUntil));
        const k = Math.min(1, rem / leg.total);
        // one step per ~0.6 device px of bar: no visible difference, far fewer style writes
        hudSet('k', { set textContent(v) { ui.fill.style.setProperty('--k', v); ui.fill.style.transform = `scaleX(${v})`; } }, (Math.round(k * 800) / 800).toFixed(4));
        const inf = G.mode === 'dev' && G.dev.infinite;
        const sec = inf ? '∞' : Math.ceil(rem / 1000);
        if (sec !== G.lastSec) { ui.secs.textContent = sec; if (!inf && sec <= 3 && sec > 0 && G.lastSec !== -1) Sound.play('tick'); G.lastSec = sec; }
        const urgent = !inf && rem <= 3000;
        if (hudLast.urgent !== urgent) { hudLast.urgent = urgent; ui.timer.classList.toggle('urgent', urgent); }
        if (rem <= 0 && !paused) endLeg();
      }
    } else if (hudLast.alt !== undefined) { for (const k in hudLast) delete hudLast[k]; }
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
    li.innerHTML = `${ICON[a.tier]}<span class="txt"></span><span class="rk">${tierName(a.tier)}</span><span class="gain">+${fmt(a.g)}</span>`;
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
    // Sherpa: the yaks carry the climber after the spotlight, so the climb waits for them
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
      setFeedback(`Carried up by yaks · +${fmt(eff)} m`);
      announce(rideSentence(altBefore, lapUp ? C.summitAlt : totalAltitude(), eff, null));
    }
    setNight();
    devEmit('answer', { kind: 'ok', ans, rawGain, eff, legIdx });
  }

  // ---------------------------------------------------------------- yak ride
  // After a Sherpa spotlight the herd carries the climber up by the meters earned
  // (Scene.ride draws it, E.ridePlan decides it). The clock is held for the ride
  // with holdClock(), Enter waits (G.pauseUntil), the leg card fades (.riding) and
  // rides queue: a judge result can land mid-ride.
  function rideSentence(from, to, eff, plan) {
    if (plan && plan.noMove) return 'Yak express! The herd shrugs: this leg is already at its limit.';
    const m0 = E.milestoneFor(from), m1 = E.milestoneFor(to);
    const to1 = m1 && m0 && m1.id !== m0.id ? `, to ${m1.short}` : '';
    return `Yak express! Carried up ${fmt(eff)} meters${to1}.${plan && plan.golden ? ' Golden yak!' : ''}`;
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
    // phones: drop the keyboard when the leg ends so it isn't covering the camp break; Next brings it back
    if (isPhone()) ui.input.blur();
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
    if (G.mode !== 'dev' && G.legIdx >= G.cats.length - 1) return finishRound();
    if (G.mode === 'dev' && G.dev.skipTransition) {   // dev "jump to leg": straight on
      G.dev.skipTransition = false;
      $('#transition').hidden = true;
      startLeg(G.legIdx + 1);
      return layoutScene();
    }
    G.state = 'transition';
    showTransition({});
    G.camp = true; layoutScene();   // after the card is shown, so the mountain is framed around it
    await campWait();
    if (G.round !== round || G.state !== 'transition') return;
    G.camp = false;
    $('#transition').hidden = true;
    startLeg(G.legIdx + 1);
    layoutScene();
  }
  // The camp break waits for Next (the button, or Enter in the answer box, which keeps focus so the
  // phone keyboard stays up). Next unlocks after campLockMs so an Enter mashed at time-up can't skip it.
  function campWait() {
    const btn = $('#tr-go-next');
    btn.hidden = false; btn.disabled = true;
    return new Promise((resolve) => {
      G.campGo = null;
      G.campT = setTimeout(() => {
        if (G.state !== 'transition') return;
        btn.disabled = false;
        ui.input.placeholder = 'Enter for the next leg';
        G.campGo = () => { G.campGo = null; btn.hidden = true; resolve(); };
        announce(`Leg ${G.legIdx + 2} ready. Press Next to continue.`);
      }, C.campLockMs);
    });
  }
  function campNext() { if (G.state === 'transition' && G.campGo) { G.campGo(); return true; } return false; }
  function campClear() { clearTimeout(G.campT); G.campGo = null; $('#tr-go-next').hidden = true; }

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
    const showLeg = !o.checking && ((nxt < G.cats.length && G.mode === 'daily') || G.mode === 'dev');
    $('#tr-leg-row').hidden = !showLeg;
    if (showLeg) {
      const np = G.mode === 'dev' ? devNextPos() : nxt;
      const c = C.legs[np];
      $('#tr-leg').textContent = G.mode === 'dev' ? `Dev leg ${nxt + 1} · pattern ${np + 1}` : nxt >= NL - 2 ? `Leg ${nxt + 1}, summit push` : `Leg ${nxt + 1}`;
      $('#tr-leg-info').textContent = `${Math.round(c.secs * (G.round.extra ? C.extraTimeFactor : 1))} s  ×${c.mult}`;
    }
    const acts = $('#tr-actions'); acts.hidden = true; acts.innerHTML = '';
    campClear();
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
    const row = Array.from({ length: r.catIds.length }, (_, i) => { const t = legRarest(r.legs[i]); return t >= 0 ? C.tiers[t].emoji : C.noFindEmoji; }).join('');
    const url = shareUrl();
    const llamas = E.shareAlpacas(alpacaRides(r).n);   // one 🐂 per Sherpa ride: no letters, so never answers
    return `Daily Ascent #${r.puzzle} ⛰️\n${m.emoji} ${m.short} · ${fmt(r.final)} m\n${row}${llamas ? '\n' + llamas : ''}${url ? '\n' + url : ''}`;
  }
  // Yak rides in a round: its ok Sherpa answers (judge-accepted ones too).
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
    const legRows = r.legs.length ? Array.from({ length: cats.length }, (_, i) => {
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
      ${alpacaRides(r).n ? `<p class="res-note res-rides">${ALPACA_ICON}<span>Yak rides: <b>${alpacaRides(r).n}</b></span></p>` : ''}
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
  function refocus() { if (G.screen === 'play' && !keepKbDown()) ui.input.focus({ preventScroll: true }); }
  // a touch phone under the phone breakpoint: the keyboard is put away between legs
  function isPhone() { try { return window.innerWidth < 900 && window.matchMedia('(pointer: coarse)').matches; } catch (e) { return false; } }
  const keepKbDown = () => isPhone() && (G.state === 'settle' || G.state === 'transition');

  // Help copy is generated from CONFIG so tuning never leaves stale numbers behind.
  function renderHelp() {
    const secs = C.legs.map((l) => l.secs), mults = C.legs.map((l) => l.mult);
    const pen = C.invalidPenaltySecs;
    $('#rules').innerHTML = [
      `Every day, everyone gets the same ${legWord} categories. You get one scored climb.`,
      'Each category is a timed leg. Type an answer and press Enter. Keep going until time runs out.',
      `Rarer valid answers climb higher. Each answer in a row adds a ${Math.round(C.chainStep * 100)}% bonus, up to ${Math.round(C.chainMax * 100)}%.`,
      `A wrong answer costs ${pen} second${pen === 1 ? '' : 's'} and resets that bonus. Repeats cost nothing.`,
      `Small typos and sound-alike spellings are corrected automatically, for answers of ${C.correct.shortLen} letters or more.`,
      `Some categories accept a variant of an answer, like “women’s soccer” in Sports. A variant scores like the answer it’s based on, up to ${C.maxQualifiedPerLeg} per leg.`,
      `The air thins: timers shrink from ${Math.max(...secs)} to ${Math.min(...secs)} seconds, but later legs score up to ${Math.max(...mults)}×.`,
      `Each leg counts in full up to ${fmt(C.legFullUpTo)} m, then at ${Math.round(C.legOverRate * 100)}%, to a limit of ${fmt(C.legCap)} m.`,
    ].map((t) => `<li>${t}</li>`).join('');
    $('#help-miles').textContent = 'Milestones: ' + C.milestones.map((m) => `${m.name} (${fmt(m.alt)} m)`).join(', ') + '.';
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
        <div class="fact"><dt>Yak rides</dt><dd>${rides}</dd></div>
        <div class="fact"><dt>Longest ride</dt><dd>${longestRide ? fmt(longestRide.g) + '<small> m</small>' : '—'}</dd></div>
      </div>
      ${longestRide ? `<p class="res-note"><span aria-hidden="true">🐂</span> Longest yak ride: +${fmt(longestRide.g)} m for <b>${esc(longestRide.c)}</b> (${esc(longestRide.cat)}).</p>` : ''}
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
    if (G.state === 'transition') { campNext(); ui.input.value = ''; return; }
    submit();
  });
  // Next (camp break): like the send button, it never takes focus from the answer box
  const goNext = $('#tr-go-next');
  goNext.addEventListener('pointerdown', (e) => e.preventDefault());
  goNext.addEventListener('mousedown', (e) => e.preventDefault());
  goNext.addEventListener('click', () => { campNext(); ui.input.focus({ preventScroll: true }); });
  const send = $('#btn-send');
  send.addEventListener('pointerdown', (e) => e.preventDefault());
  send.addEventListener('mousedown', (e) => e.preventDefault());
  send.addEventListener('click', () => { submit(); ui.input.focus({ preventScroll: true }); });
  ui.input.addEventListener('paste', (e) => { if (G.state === 'leg') { e.preventDefault(); setFeedback('Pasting is off during a leg.', 'dup'); } });
  ui.input.addEventListener('drop', (e) => e.preventDefault());
  ui.play.addEventListener('pointerdown', (e) => {
    if (e.target === ui.input || e.target.closest('button')) return;
    if (['leg', 'countdown', 'settle', 'transition'].includes(G.state) && !keepKbDown()) setTimeout(() => ui.input.focus({ preventScroll: true }), 0);
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
    return last ? (last.pos + 1) % NL : 0;
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
    G.camp = false; campClear();
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
    G.state = 'idle'; G.camp = false; campClear(); G.round = null;
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
  // Effects tab: plays a yak ride without changing the score or holding the clock.
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
      if (G.screen === 'play') setFeedback(`Carried up by yaks · +${fmt(to - from)} m`);
      announce(rideSentence(from, to, to - from, null));
      devEmit('ride', { plan: { reduced: true }, ans: { c: answer }, eff: to - from, test: true });
      return `Reduced-motion preview: "Carried up by yaks · +${fmt(to - from)} m", no ride.`;
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
    return `Yak ride: ${plan.style} · ${plan.band}${plan.golden ? ' · golden' : ''}${plan.late ? ' · late' : ''}${plan.spit ? ' · spit' : ''} · +${fmt(to - from)} m (${(plan.durationMs / 1000).toFixed(1)} s)`;
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
      // draft cosmetics preview (Effects tab); the game itself never sets an outfit
      cosmetics: window.DA_PIXEL.COSMETICS, setOutfit(o) { Scene.setOutfit(o); },
      submit: devSubmit,
      campNext,   // the autoplay bot presses Next at camp breaks
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
      $('#leg-label').textContent = `Leg ${G.legIdx + 1} of ${G.cats.length}`;
      $('#leg-mult').textContent = `${Math.round(leg.total / 1000)} s  ×${C.legs[G.legIdx].mult}`;
      leg.answers.filter((a) => a.s === 'ok').forEach((a) => ui.chips.prepend(chipEl(a)));
      renderLegDots(); setNight();
    } else if (G.legIdx >= G.cats.length - 1 && leg && leg.ended) finishRound();
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
