/* Daily Ascent — pixel sprite kit (CLAUDE.md §8.4).
   Helpers that turn string maps and a few shape recipes into crisp pixel sprites,
   drawn once into small canvases and reused every frame. Uses DOM canvas only; no
   game state. Exposes window.DA_PIXEL. */
(function () {
  'use strict';

  // --- maths and colour ------------------------------------------------------
  const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
  /** Ordered-dither threshold for an art pixel, in (0, 1). */
  const dither = (x, y) => (BAYER[((y & 3) << 2) | (x & 3)] + 0.5) / 16;
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const rgb = (h) => (Array.isArray(h) ? h : [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)]);
  const mix = (a, b, t) => [Math.round(a[0] + (b[0] - a[0]) * t), Math.round(a[1] + (b[1] - a[1]) * t), Math.round(a[2] + (b[2] - a[2]) * t)];
  const ramp = (...hs) => hs.map(rgb);
  const INK = rgb('#2e201c');
  /** Picks from a dark→light ramp at brightness v (0–1), dithering between the two nearest steps. */
  function rampPick(r, v, x, y) {
    const n = r.length - 1;
    const f = clamp(v, 0, 0.9999) * n;
    let i = f | 0;
    if (i < n && f - i > dither(x, y)) i++;
    return r[i];
  }
  /** Small integer hash in [0, 1): stable per (x, y, salt), used for world-seeded texture. */
  function hash2(x, y, s) {
    let h = (x * 374761393 + y * 668265263 + (s | 0) * 2147483647) | 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    h ^= h >>> 16;
    return (h >>> 0) / 4294967296;
  }
  function rng(seed) {
    let a = seed >>> 0;
    return () => { a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  }

  // --- pixel buffers ----------------------------------------------------------
  function canvas(w, h) { const c = document.createElement('canvas'); c.width = Math.max(1, w); c.height = Math.max(1, h); return c; }
  function buf(w, h) { return { w, h, d: new Uint8ClampedArray(w * h * 4) }; }
  function put(b, x, y, c, a) {
    x |= 0; y |= 0;
    if (x < 0 || y < 0 || x >= b.w || y >= b.h) return;
    const i = (y * b.w + x) * 4;
    b.d[i] = c[0]; b.d[i + 1] = c[1]; b.d[i + 2] = c[2]; b.d[i + 3] = a == null ? 255 : a;
  }
  const alphaAt = (b, x, y) => (x < 0 || y < 0 || x >= b.w || y >= b.h ? 0 : b.d[(y * b.w + x) * 4 + 3]);
  const colAt = (b, x, y) => { const i = (y * b.w + x) * 4; return [b.d[i], b.d[i + 1], b.d[i + 2]]; };
  /** The outline: each empty pixel next to a filled one becomes a darkened copy of that
   *  neighbour, darkest underneath (light from the top left). */
  function selout(b, o) {
    const k = Object.assign({ bottom: 0.72, left: 0.6, right: 0.66, top: 0.48, ink: INK }, o);
    const out = { w: b.w, h: b.h, d: new Uint8ClampedArray(b.d) };
    const N = [[0, -1, k.bottom], [-1, 0, k.left], [1, 0, k.right], [0, 1, k.top]];
    for (let y = 0; y < b.h; y++) {
      for (let x = 0; x < b.w; x++) {
        if (alphaAt(b, x, y)) continue;
        let best = null, bk = -1;
        for (const [dx, dy, kk] of N) if (alphaAt(b, x + dx, y + dy) > 127 && kk > bk) { best = colAt(b, x + dx, y + dy); bk = kk; }
        if (best) put(out, x, y, mix(best, k.ink, bk));
      }
    }
    return out;
  }
  function toCanvas(b) {
    const c = canvas(b.w, b.h);
    c.getContext('2d').putImageData(new ImageData(b.d, b.w, b.h), 0, 0);
    return c;
  }
  /** A finished sprite: canvas plus the anchor point that sits on (x, y) when drawn. */
  const sprite = (b, ax, ay, outline, o) => {
    const fb = outline === false ? b : selout(b, o);
    return { cv: toCanvas(fb), w: b.w, h: b.h, ax, ay };
  };
  /** Draws a string map into a buffer. pal maps a character to a colour; '.' and unknown are empty. */
  function fromMap(b, x0, y0, rows, pal, flip) {
    rows.forEach((row, j) => {
      const r = flip ? row.split('').reverse().join('') : row;
      for (let i = 0; i < r.length; i++) { const c = pal[r[i]]; if (c) put(b, x0 + i, y0 + j, rgb(c)); }
    });
  }
  /** A lit, dithered sphere: the building block of trees, clouds, bushes, stones and glows. */
  function blob(b, cx, cy, r, rp, squash, lift) {
    const sq = squash || 1, lf = lift || 0;
    for (let y = Math.floor(cy - r * sq) - 1; y <= Math.ceil(cy + r * sq) + 1; y++) {
      for (let x = Math.floor(cx - r) - 1; x <= Math.ceil(cx + r) + 1; x++) {
        const dx = (x + 0.5 - cx) / r, dy = (y + 0.5 - cy) / (r * sq), d2 = dx * dx + dy * dy;
        if (d2 > 1) continue;
        const nz = Math.sqrt(1 - d2);
        const v = 0.5 - (dx * -0.62 + dy * -0.78) * 0.42 + (nz - 0.5) * 0.35 + lf;
        put(b, x, y, rampPick(rp, v, x, y));
      }
    }
  }
  function rect(b, x, y, w, h, c) { for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) put(b, x + i, y + j, c); }
  function line(b, x0, y0, x1, y1, c) {
    const n = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0), 1);
    for (let i = 0; i <= n; i++) put(b, Math.round(x0 + (x1 - x0) * i / n), Math.round(y0 + (y1 - y0) * i / n), c);
  }

  // --- palettes ------------------------------------------------------------------
  const P = {
    canopy: ramp('#26462c', '#346232', '#4e843a', '#72a646', '#a0c65c', '#cee284'),
    pine: ramp('#1e3c34', '#2a5440', '#3a704c', '#568e5a'),
    straw: ramp('#6c4a2c', '#926838', '#b88a50', '#d6ac6a', '#eccc8c'),
    stone: ramp('#5c6068', '#80848a', '#a6a8aa', '#ccccc8'),
    cloud: ramp('#baceec', '#dce8f8', '#f8fbff', '#ffffff'),
    ice: ramp('#7896c8', '#a0bee4', '#cce0f4', '#ecf4fc', '#fcfeff'),
    flags: ramp('#3c78dc', '#faf8f0', '#dc3c3c', '#3caa5a', '#fad23c'),
    wood: rgb('#8a5a34'), woodHi: rgb('#b07a4c'), woodLo: rgb('#5b3a22'),
    parch: rgb('#f4e7c8'), parchLo: rgb('#d8c08f'), parchHi: rgb('#fff7e0'),
    ink: rgb('#281e16'), cream: rgb('#fff3d6'), orange: rgb('#ff702e'), orangeLo: rgb('#c4501c'),
  };

  // --- climber (16 x 24, facing right, built in layers) -----------------------------
  const CLIMBER_PAL = { h: '#5c3a28', H: '#7c5238', s: '#f3c8a0', S: '#d6a078', e: '#221c24', c: '#f0968c', n: '#e2ac84', J: '#ff702e', L: '#ffa064', j: '#d44a1c', q: '#e85c24', B: '#3a60b2', b: '#264084', r: '#22283c', P: '#343a56', p: '#24283e', K: '#3c2c24', k: '#624a38', g: '#e6dcc8', G: '#3c404c', O: '#b0b6c0', o: '#787e8a', Y: '#ffce40', y: '#dea01e', w: '#fcf8ec', W: '#d6d0c4' };
  const HEAD = [ // rows 0-9
    '................',
    '......hhhh......',
    '....hhHHHHhh....',
    '...hhHHHHHHHh...',
    '...hhsssssssh...',
    '...hsssssssss...',
    '...hssesssesss..',
    '...hssesssesss..',
    '...hscssSsscs...',
    '....SSssssSS....',
  ];
  const BODY_STAND = [ // rows 10-23
    '.....JJJJJJ.....',
    '..BBJLLJJJJJ....',
    '.BBBJLJJJJJJG...',
    '.BBrJJqqqqJJGO..',
    '.bBrJLJJJJJjGO..',
    '.bBrJJqqqqJjO...',
    '.bbrJJJJJJJjO...',
    '..bbjjjjjjjjO...',
    '....PPPPPPP.O...',
    '....PPPpPPPPO...',
    '....PPp..PPpO...',
    '....PPp..PPp.O..',
    '...KKKk..KKKk...',
    '...gggg..gggg...',
  ];
  const BODY_WALK = BODY_STAND.slice(0, 8).concat([
    '....PPPPPPP.O...',
    '...PPPp.PPPPO...',
    '..PPp....PPpO...',
    '..PPp.....PPpO..',
    '.KKKk.....KKKk..',
    '.gggg.....gggg..',
  ]);
  const BODY_CHEER = [
    '.J...JJJJJJ...J.',
    '.JBBJLLJJJJJJJJ.',
    '..JBJLJJJJJJJJ..',
    '.BBrJJqqqqJJ....',
    '.bBrJLJJJJJj....',
    '.bBrJJqqqqJj....',
    '.bbrJJJJJJJj....',
    '..bbjjjjjjjj....',
  ].concat(BODY_STAND.slice(8, 12), ['...KKKk..KKKk...', '...gggg..gggg...']);
  const CHEER_ARMS = [ // rows 4-9
    'GG............GG',
    '.G............G.',
    '.J............J.',
    '.J............J.',
    '.J............J.',
    '.J............J.',
  ];
  const BODY_SIT = [ // rows 10-17
    '.....JJJJJJ.....',
    '..BBJLLJJJJJG...',
    '.BBBJLJJJJJJJ...',
    '.BBrJJqqqqJJ....',
    '.bBrJLJJJJJj....',
    '.bbrjjjjjjjjPPP.',
    '..bbPPPPPPPPPPPK',
    '.....PPPPPPPPpKk',
  ];
  const DEFAULT_HAT = [ // rows 0-5
    '.......wW.......',
    '.....YYYYYY.....',
    '....YYyYYyYY....',
    '...YYyYYyYYyY...',
    '...wwwwwwwwww...',
    '...WWWWWWWWWW...',
  ];
  /** Draft cosmetics: dev preview only for now (CLAUDE.md §15). Row 0 = row 0 of the climber grid. */
  const COSMETICS = {
    summit_shades: { name: 'Summit shades', slot: 'eyes', rows: ['', '', '', '', '', '', '...xmMmxxmMmx...', '....mmm..mmm....'], pal: { x: '#28242c', m: '#78bef0', M: '#e6f6ff' } },
    bobble_hat: { name: 'Yak-wool bobble hat', slot: 'hat', rows: ['......rRr.......', '.....wwwwww.....', '....rrrrrrrr....', '...wwwwwwwwww...', '...rrrrrrrrrr...', '...ff.......f...', '...ff...........', '...F............'], pal: { r: '#d6343c', R: '#fa6e6e', w: '#faf4e8', f: '#c42832', F: '#faf4e8' } },
    summit_crown: { name: 'Summit crown', slot: 'hat', rows: ['...z..z..z..z...', '...zz.zz.zz.zz..', '...ZzzzzzzzzZ...', '...ZzRzzBzzRZ...', '...ZZZZZZZZZZ...'], pal: { z: '#ffd646', Z: '#d69c1e', R: '#e63c50', B: '#50a0f0' } },
    flag_scarf: { name: 'Prayer-flag scarf', slot: 'neck', rows: ['', '', '', '', '', '', '', '', '', '....bbwwrrggy...', '..ybbwwrrggyy...', '.gg.bw..........', 'rr..bw..........', '....b...........'], pal: { b: '#3c78dc', w: '#faf8f0', r: '#dc3c3c', g: '#3caa5a', y: '#fad23c' } },
    alpaca_poncho: { name: 'Alpaca-wool poncho', slot: 'over', rows: ['', '', '', '', '', '', '', '', '', '', '.....aaaaaa.....', '....aaaaaaaaa...', '...rrrrrrrrrrr..', '...aaaaaaaaaaa..', '...ttttttttttt..', '...aaaaaaaaaaa..', '...f.f.f.f.f.f..'], pal: { a: '#ecd6b0', r: '#d2463c', t: '#289696', f: '#c4ac82' } },
    night_suit: { name: 'Starlight suit', slot: 'suit', suit: { J: '#30346e', L: '#565ca8', j: '#1e204c', q: '#464c8c' }, rows: ['', '', '', '', '', '', '', '', '', '', '', '......*...', '..........*.', '.....*.....', '.........*', '......*...'], pal: { '*': '#ffe682' } },
  };
  const BODIES = { stand: BODY_STAND, walk: BODY_WALK, cheer: BODY_CHEER, sit: BODY_SIT };
  /** outfit: { hat, eyes, neck, over, suit } of COSMETICS keys. hat: null = bare head, undefined = default beanie. */
  function outfitKey(o) { return o ? ['hat', 'eyes', 'neck', 'over', 'suit'].map((k) => (o[k] === null ? '-' : o[k] || '')).join('|') : ''; }
  const climberCache = new Map();
  function buildClimber(pose, outfit, o) {
    const opt = o || {};
    const key = pose + '#' + outfitKey(outfit) + (opt.flip ? '#f' : '') + (opt.ghost ? '#g' : '');
    if (climberCache.has(key)) return climberCache.get(key);
    const ofit = outfit || {};
    const pal = Object.assign({}, CLIMBER_PAL, ofit.suit && COSMETICS[ofit.suit] ? COSMETICS[ofit.suit].suit : null);
    const b = buf(18, 26), F = !!opt.flip;
    const lay = (rows, p, y0) => fromMap(b, 1, 1 + (y0 || 0), rows, p, F);
    lay(HEAD, pal);
    lay(BODIES[pose] || BODY_STAND, pal, 10);
    if (pose === 'cheer') lay(CHEER_ARMS, pal, 4);
    for (const slot of ['neck', 'over', 'eyes']) { const c = COSMETICS[ofit[slot]]; if (c) lay(c.rows, c.pal); }
    const sc = COSMETICS[ofit.suit]; if (sc) lay(sc.rows, sc.pal);
    if (ofit.hat !== null) { const hc = COSMETICS[ofit.hat]; if (hc) lay(hc.rows, hc.pal); else lay(DEFAULT_HAT, pal); }
    const s = sprite(b, 9, pose === 'sit' ? 19 : 25, !opt.ghost);
    climberCache.set(key, s);
    return s;
  }
  /** The hat layer alone (for the alpaca ride's flying hat), in four 90° rotations. */
  const hatCache = new Map();
  function hatSprites(outfit) {
    const ofit = outfit || {};
    const key = ofit.hat === null ? '-' : ofit.hat || '';
    if (hatCache.has(key)) return hatCache.get(key);
    let out = null;
    if (ofit.hat !== null) {
      const hc = COSMETICS[ofit.hat];
      const rows = hc ? hc.rows : DEFAULT_HAT, pal = hc ? hc.pal : CLIMBER_PAL;
      const b = buf(18, 18);
      fromMap(b, 1, 5, rows, pal);
      const base = toCanvas(selout(b));
      out = [0, 1, 2, 3].map((q) => {
        const c = canvas(18, 18), g = c.getContext('2d');
        g.translate(9, 9); g.rotate(q * Math.PI / 2); g.drawImage(base, -9, -9);
        return { cv: c, w: 18, h: 18, ax: 9, ay: 9 };
      });
    }
    hatCache.set(key, out);
    return out;
  }

  // --- alpacas (24 x 22, facing right) ------------------------------------------------
  const ALPACA = [
    '.................e..e...',
    '.................ee.ee..',
    '................tFFFFF..',
    '...............tFFFFFFF.',
    '...............FFFFoFFF.',
    '...............FFFFFFFmn',
    '................FFFFFmm.',
    '................FFFFFF..',
    '................FFFFF...',
    '...............tFFFFF...',
    '...............FFFFFF...',
    '...tt.tt.tt.tt.FFFFFF...',
    '..tFFFFFFFFFFFFFFFFFF...',
    '.tFFFFFFFFFFFFFFFFFFF...',
    'tFFFFFFFFFFFFFFFFFFFF...',
    'tFFFFFFFFFFFFFFFFFFF....',
    '.FFFFFFFFFFFFFFFFFFF....',
    '..FFFFFFFFFFFFFFFFF.....',
    '...dFd.dFd...dFd.dFd....',
    '...dFd.dFd...dFd.dFd....',
    '...dd..dd....dd..dd.....',
    '...kk..kk....kk..kk.....',
  ];
  const ALPACA_RUN = ALPACA.slice(0, 18).concat(['..dFd...dFd.dFd...dFd...', '.dFd.....dFdFd.....dFd..', 'dd.........dd.......dd..', 'kk.........kk.......kk..']);
  const ALPACA_SLED = ['', '', ''].concat(ALPACA.slice(0, 18), ['.SSSSSSSSSSSSSSSSSSS....']);
  const COATS = [['#f8eeda', '#d8c6a8'], ['#e2bc8e', '#ba9266'], ['#a6744e', '#7c5436'], ['#fcfaf4', '#ded8ce'], ['#463e3c', '#302a2a']];
  const GOLD_COAT = ['#fcd048', '#d49a1e'];
  const alpacaCache = new Map();
  /** coat: index into COATS or 'gold'; frame: 'stand' | 'run' | 'sled'; sad droops the ears. */
  function buildAlpaca(coat, frame, o) {
    const opt = o || {};
    const key = coat + ':' + frame + ':' + (opt.sad ? 's' : '') + (opt.seed || 0);
    if (alpacaCache.has(key)) return alpacaCache.get(key);
    const pair = coat === 'gold' ? GOLD_COAT : COATS[coat] || COATS[0];
    const c = rgb(pair[0]), sh = rgb(pair[1]), hi = mix(c, [255, 255, 255], 0.45), deep = mix(sh, [40, 30, 30], 0.15);
    const R4 = [deep, sh, c, hi];
    const rows = frame === 'run' ? ALPACA_RUN : frame === 'sled' ? ALPACA_SLED : ALPACA;
    const rnd = rng(7 + (opt.seed || 0) * 31 + (coat === 'gold' ? 99 : coat * 13));
    const b = buf(26, 24);
    rows.forEach((row, j) => {
      for (let i = 0; i < row.length; i++) {
        const ch = row[i]; let col = null;
        if (ch === 'F' || ch === 't') {
          const v = 0.62 - (j / 22) * 0.55 + (ch === 't' ? 0.25 : 0) + (rnd() - 0.5) * 0.24;
          col = rampPick(R4, v, i, j);
        } else if (ch === 'd') col = deep;
        else if (ch === 'e') col = opt.sad && j === 0 ? null : mix(sh, [60, 40, 40], 0.2);
        else if (ch === 'o') col = [30, 24, 26];
        else if (ch === 'm') col = mix(c, [230, 190, 170], 0.5);
        else if (ch === 'n') col = [90, 60, 56];
        else if (ch === 'k') col = [60, 46, 40];
        else if (ch === 'S') col = [236, 244, 252];
        if (col) put(b, i + 1, j + 1, col);
      }
    });
    if (opt.sad) { put(b, 19, 3, mix(sh, [60, 40, 40], 0.2)); put(b, 22, 3, mix(sh, [60, 40, 40], 0.2)); put(b, 19, 5, [30, 24, 26]); }
    const s = sprite(b, 13, 23);
    alpacaCache.set(key, s);
    return s;
  }
  // overlays drawn at the alpaca's anchor (feet centre); offsets in art pixels
  const overlayCache = new Map();
  function overlay(kind) {
    if (overlayCache.has(kind)) return overlayCache.get(kind);
    let s = null;
    if (kind === 'mask') {         // Death Zone: oxygen mask on the muzzle, tank on the back
      const b = buf(26, 24);
      rect(b, 21, 6, 3, 3, rgb('#7896be')); put(b, 22, 7, rgb('#b6cce4'));
      for (let i = 0; i < 9; i++) put(b, 20 - i, 8 + Math.round(i * 0.45), rgb('#60708c'));
      rect(b, 6, 9, 6, 3, rgb('#60708c')); rect(b, 6, 9, 6, 1, rgb('#8ea0bc'));
      s = sprite(b, 13, 23);
    } else if (kind === 'lamp') {  // night: a 2 px headlamp
      const b = buf(26, 24);
      rect(b, 17, 3, 3, 1, rgb('#323240')); rect(b, 20, 3, 2, 2, rgb('#fff6c8'));
      s = sprite(b, 13, 23);
    } else if (kind === 'map') {   // short hop: a tiny map
      const b = buf(12, 9);
      rect(b, 1, 1, 9, 6, rgb('#f7efd8')); line(b, 2, 5, 4, 3, rgb('#b4542c')); line(b, 4, 3, 6, 5, rgb('#b4542c')); line(b, 6, 5, 8, 2, rgb('#b4542c'));
      s = sprite(b, 1, 8);
    } else if (kind === 'beam') {  // dithered headlamp cone (no outline)
      const b = buf(36, 24);
      for (let i = 1; i < 36; i++) for (let d = -Math.floor(i / 3); d <= Math.floor(i / 3); d++) {
        const x = i, y = 12 + d;
        if (dither(x, y) < 0.55 - i / 80) put(b, x, y, [255, 246, 190], 150);
      }
      s = sprite(b, 0, 12, false);
    } else if (kind === 'sparkle') { // golden shimmer, 5 px four-point star
      const b = buf(7, 7);
      const c = [255, 240, 170];
      put(b, 3, 1, c); put(b, 3, 2, c); put(b, 1, 3, c); put(b, 2, 3, c); put(b, 3, 3, [255, 255, 255]); put(b, 4, 3, c); put(b, 5, 3, c); put(b, 3, 4, c); put(b, 3, 5, c);
      s = sprite(b, 3, 3, false);
    } else if (kind === 'dizzy') {
      const b = buf(5, 5); const c = [255, 226, 138];
      put(b, 2, 0, c); put(b, 1, 1, c); put(b, 2, 1, c); put(b, 3, 1, c); put(b, 0, 2, c); put(b, 2, 2, [255, 255, 255]); put(b, 4, 2, c); put(b, 1, 3, c); put(b, 3, 3, c);
      s = sprite(b, 2, 2, false);
    } else if (kind === 'flag') {  // summit flag on a pole, anchor at the pole's foot
      const b = buf(10, 18);
      for (let y = 1; y < 17; y++) put(b, 1, y, rgb('#c8c8ce'));
      for (let j = 0; j < 4; j++) for (let i = 1; i < 8 - j * 1.5; i++) put(b, 1 + i, 1 + j, j < 3 ? P.orange : P.orangeLo);
      s = sprite(b, 1, 17);
    } else if (kind === 'canopy') { // paraglider wing, suit orange with white cells
      const b = buf(84, 16);
      for (let y = 0; y < 14; y++) for (let x = 0; x < 82; x++) {
        const dx = (x - 41) / 41, dy = (13 - y) / 13;
        if (dx * dx + dy * dy > 1) continue;
        const cell = Math.abs(((x - 41) % 18 + 18) % 18 - 9) < 2.2 && y < 11;
        put(b, x + 1, y + 1, cell ? [255, 255, 255] : y > 10 ? P.orangeLo : rampPick([P.orangeLo, P.orange, rgb('#ffa064')], 0.85 - y / 14, x, y));
      }
      s = sprite(b, 42, 14);
    } else if (kind === 'splat') {
      const b = buf(40, 50), c = ramp('#b8c49c', '#d4dcbc', '#e2ecce', '#f4f8ea');
      blob(b, 20, 16, 11, c); for (let i = 0; i < 7; i++) { const a = i * 0.9; blob(b, 20 + Math.cos(a) * 12, 16 + Math.sin(a) * 10, 3 + (i % 3), c); }
      for (let i = -1; i <= 1; i++) rect(b, 19 + i * 5, 24, 3, 18 - Math.abs(i) * 6, c[2]);
      s = sprite(b, 20, 16);
    }
    overlayCache.set(kind, s);
    return s;
  }

  // --- text (Silkscreen, thresholded so letters stay crisp) ---------------------------
  const textCache = new Map();
  /** Crisp pixel text: drawn at 1:1, alpha thresholded, optionally outlined. */
  function text(str, o) {
    const opt = Object.assign({ color: '#ffffff', outline: null, size: 8, bold: false, space: 0 }, o);
    const key = [str, opt.color, opt.outline, opt.size, opt.bold, opt.space].join('|');
    if (textCache.has(key)) return textCache.get(key);
    if (textCache.size > 400) textCache.clear();   // bounded: a changing label never grows the cache forever
    // without Silkscreen (fonts blocked or still loading) a fallback face is drawn a touch larger and
    // thresholded more gently, so thin strokes survive
    let fontOk = true;
    try { fontOk = !document.fonts || document.fonts.check(`${opt.size}px Silkscreen`); } catch (e) { fontOk = true; }
    const size = fontOk ? opt.size : opt.size + 1, cut = fontOk ? 110 : 60;
    const font = fontOk ? `${opt.bold ? 700 : 400} ${size}px Silkscreen, monospace` : `700 ${size}px "Pixelify Sans", ui-monospace, monospace`;
    const m = canvas(4, 4).getContext('2d'); m.font = font;
    // space > 0: words are drawn one by one with that gap (art px) instead of the face's own space
    const words = opt.space ? str.split(' ') : [str];
    const ww = words.map((wd) => Math.ceil(m.measureText(wd).width));
    const tw = ww.reduce((a, v) => a + v, 0) + (words.length - 1) * opt.space + 4, th = size * 2;
    const c = canvas(tw, th), g = c.getContext('2d');
    g.font = font; g.textBaseline = 'alphabetic'; g.fillStyle = '#000';
    let tx0 = 2;
    words.forEach((wd, i) => { g.fillText(wd, tx0, Math.round(size * 1.25)); tx0 += ww[i] + opt.space; });
    const id = g.getImageData(0, 0, tw, th), col = rgb(opt.color);
    let x0 = tw, x1 = -1, y0 = th, y1 = -1;
    for (let y = 0; y < th; y++) for (let x = 0; x < tw; x++) {
      const i = (y * tw + x) * 4;
      if (id.data[i + 3] >= cut) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
    }
    if (x1 < 0) { const e = { cv: canvas(1, 1), w: 1, h: 1, ax: 0, ay: 0 }; textCache.set(key, e); return e; }
    const pad = opt.outline ? 1 : 0;
    const b = buf(x1 - x0 + 1 + pad * 2, y1 - y0 + 1 + pad * 2);
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) if (id.data[(y * tw + x) * 4 + 3] >= cut) put(b, x - x0 + pad, y - y0 + pad, col);
    const s = opt.outline ? sprite(b, 0, 0, true, { bottom: 1, left: 1, right: 1, top: 1, ink: rgb(opt.outline) }) : sprite(b, 0, 0, false);
    textCache.set(key, s);
    return s;
  }
  /** A wood sign (or an orange accent tag) holding one or two lines of text. */
  const signCache = new Map();
  function sign(title, sub, o) {
    const opt = Object.assign({ accent: false, night: false, small: false }, o);
    const key = [title, sub, opt.accent, opt.night, opt.small].join('|');
    if (signCache.has(key)) return signCache.get(key);
    if (signCache.size > 200) signCache.clear();
    // small (phones): about 10% smaller. Pixel text can't be scaled and stay crisp, so the 8 px face
    // stays and the padding, the gap between the lines and the word spaces are trimmed instead
    const padX = opt.small ? 6 : 8, padY = opt.small ? 5 : 7, gap = opt.small ? 3 : 4, sp = opt.small ? 2 : 0;
    const t = text(title, { color: opt.accent ? '#281e16' : '#fff3d6', bold: false, space: sp });
    const s2 = sub ? text(sub, { color: opt.accent ? '#5b2a10' : '#ffe2b0', space: sp }) : null;
    const w = t.w + (s2 ? s2.w + gap : 0) + padX, h = Math.max(t.h, s2 ? s2.h : 0) + padY;
    const b = buf(w, h);
    const base = opt.accent ? rgb('#ff5a1f') : P.wood, hi = opt.accent ? rgb('#ff9a6a') : P.woodHi, lo = opt.accent ? rgb('#b23c0e') : P.woodLo;
    rect(b, 0, 0, w, h, base); rect(b, 0, 0, w, 1, hi); rect(b, 0, h - 2, w, 2, lo);
    put(b, 0, 0, [0, 0, 0], 0); put(b, w - 1, 0, [0, 0, 0], 0); put(b, 0, h - 1, [0, 0, 0], 0); put(b, w - 1, h - 1, [0, 0, 0], 0);
    const spr = sprite(b, 0, 0, true, { bottom: 0.8, left: 0.75, right: 0.75, top: 0.75 });
    const c = canvas(spr.w, spr.h), g = c.getContext('2d');
    g.drawImage(spr.cv, 0, 0);
    const ty = Math.floor((h - 1 - t.h) / 2) + 1;
    const tx = Math.floor(padX / 2);
    g.drawImage(t.cv, tx, ty);
    if (s2) g.drawImage(s2.cv, tx + t.w + gap, Math.floor((h - 1 - s2.h) / 2) + 1);
    const out = { cv: c, w: spr.w, h: spr.h, ax: 0, ay: 0 };
    signCache.set(key, out);
    return out;
  }
  function clearTextCaches() { textCache.clear(); signCache.clear(); }

  // --- scenery sprites ---------------------------------------------------------------
  const cache = new Map();
  const memo = (key, fn) => { if (!cache.has(key)) cache.set(key, fn()); return cache.get(key); };
  /** Round puffy tree: trunk plus 3–4 lit puffs, each over a darker ring so the clumps read. */
  function tree(size, seed) {
    return memo('tree:' + size + ':' + seed, () => {
      const r = size === 'L' ? 6 + (seed % 3) : size === 'M' ? 4 + (seed % 2) * 0.6 : 2.4 + (seed % 2) * 0.5;
      const W = Math.ceil(r * 4) + 6, H = Math.ceil(r * 3.6) + 6;
      const b = buf(W, H), cx = W / 2, gy = H - 2, rnd = rng(seed * 977 + 13);
      const th = Math.max(2, Math.round(r * 0.7));
      for (let y = gy - th - 2; y <= gy; y++) { put(b, Math.floor(cx) - 1, y, rgb('#785032')); put(b, Math.floor(cx), y, rgb('#785032')); if (r > 3) put(b, Math.floor(cx) + 1, y, rgb('#583a26')); }
      const cy = gy - th - r * 0.8;
      const parts = r < 3 ? [[0, 0, r]] : [[-r * 0.65, r * 0.25, r * 0.66], [r * 0.7, r * 0.3, r * 0.62], [r * 0.05, -r * 0.55, r * 0.7], [0, 0.15 * r, r]];
      for (const [dx, dy, rr] of parts) { blob(b, cx + dx, cy + dy, rr + 0.9, [P.canopy[0], P.canopy[0]]); blob(b, cx + dx, cy + dy, rr, P.canopy.slice(1)); }
      for (let n = 0; n < r * r * 0.9; n++) {
        const x = Math.floor(cx + (rnd() - 0.5) * r * 3), y = Math.floor(cy + (rnd() - 0.6) * r * 2.4);
        if (alphaAt(b, x, y) < 255) continue;
        const cc = colAt(b, x, y), i = P.canopy.findIndex((q) => q[0] === cc[0] && q[1] === cc[1] && q[2] === cc[2]);
        if (i > 0) put(b, x, y, P.canopy[clamp(i + (rnd() < 0.5 ? 1 : -1), 1, 5)]);
      }
      if (r >= 3) for (const [dx, dy, rr] of parts) { const hx = cx + dx - rr * 0.35, hy = cy + dy - rr * 0.45; put(b, hx - 1, hy + 1, P.canopy[5]); put(b, hx, hy, P.canopy[5]); put(b, hx + 1, hy + 1, P.canopy[5]); }
      return sprite(b, Math.floor(cx), gy);
    });
  }
  function pine(size, seed) {
    return memo('pine:' + size + ':' + seed, () => {
      const h = size === 'L' ? 12 + (seed % 4) : size === 'M' ? 8 + (seed % 3) : 5 + (seed % 2);
      const W = Math.ceil(h * 0.9) + 4, b = buf(W, h + 5), cx = Math.floor(W / 2), gy = h + 3;
      for (let y = gy - 2; y <= gy; y++) put(b, cx, y, rgb('#583a26'));
      for (let j = 0; j < h; j++) {
        const y = gy - 2 - j, hw = (h - j) * 0.42 + (j % 4 === 0 ? 1.2 : 0);
        for (let x = Math.round(cx - hw); x <= Math.round(cx + hw); x++) put(b, x, y, rampPick(P.pine, 0.8 - (x - cx + hw) / (2 * hw + 1) * 0.65, x, y));
      }
      return sprite(b, cx, gy);
    });
  }
  function bush(seed) {
    return memo('bush:' + seed, () => { const b = buf(10, 7); blob(b, 5, 4, 3 + (seed % 2) * 0.5, P.canopy.slice(1), 0.75); return sprite(b, 5, 6); });
  }
  function stone(r, seed) {
    return memo('stone:' + r + ':' + seed, () => { const n = Math.ceil(r * 2) + 4, b = buf(n, n); blob(b, n / 2, n / 2, r, P.stone, 0.62); return sprite(b, Math.floor(n / 2), Math.floor(n / 2) + 1); });
  }
  /** Thatched teahouse after the reference farmhouse. size 'XL' ≈ 30 px wide, 'L' ≈ 20, 'S' ≈ 11. */
  function teahouse(size, seed) {
    return memo('house:' + size + ':' + seed, () => {
      const L = size === 'L' || size === 'XL', w = size === 'XL' ? 28 : L ? 18 : 9, wallH = size === 'XL' ? 8 : L ? 6 : 3, roofH = size === 'XL' ? 11 : L ? 8 : 4, over = L ? 2 : 1;
      const Wd = w + 4, Ht = wallH + roofH + (L ? 6 : 3), b = buf(Wd, Ht), gy = Ht - 2;
      const x0 = 2, wx0 = x0 + over, wx1 = x0 + w - over - 1;
      if (L) for (let y = gy - 2; y <= gy; y++) for (let x = wx0 - 1; x <= wx1 + 1; x++) put(b, x, y, (x + y * 2) % 5 ? P.stone[1] : P.stone[0]);
      const wb = L ? gy - 3 : gy;
      const PL = ramp('#d6c4a2', '#ecdec0', '#f8eed6');
      for (let y = wb - wallH + 1; y <= wb; y++) for (let x = wx0; x <= wx1; x++) {
        let c = rampPick(PL, 0.75 - (x - wx0) / (wx1 - wx0 + 1) * 0.5, x, y);
        if (L && (x === wx0 || x === wx1 || x === Math.floor((wx0 + wx1) / 2) || y === wb - wallH + 1)) c = rgb('#785032');
        put(b, x, y, c);
      }
      if (L) {
        const dx = Math.floor((wx0 + wx1) / 2) + 2;
        rect(b, dx, wb - 5, 4, 6, rgb('#825634')); put(b, dx + 3, wb - 2, rgb('#f0c85a'));
        rect(b, wx0 + 2, wb - 6, 5, 3, rgb('#465a78')); put(b, wx0 + 3, wb - 6, rgb('#b4d2e6'));
        for (let x = wx0 + 2; x < wx0 + 7; x++) put(b, x, wb - 3, x % 2 ? rgb('#e6505a') : rgb('#ffd246'));
      } else put(b, wx0 + 1, wb - 1, rgb('#465a78'));
      const ry1 = wb - wallH + 1, ry0 = ry1 - roofH, rnd = rng(seed * 31 + 5);
      const fib = []; for (let i = 0; i < Wd; i++) fib.push(rnd());
      for (let y = ry0; y <= ry1; y++) {
        const t = (y - ry0) / roofH, hw = (w * 0.2) + (w / 2 + 0.5 - w * 0.2) * Math.min(1, t * 1.25), cx = x0 + w / 2;
        for (let x = Math.round(cx - hw); x <= Math.round(cx + hw - 1); x++) {
          const side = (x - (cx - hw)) / (2 * hw);
          let c = rampPick(P.straw, 0.86 - side * 0.5 + (fib[x] - 0.5) * 0.35 - t * 0.12, x, y);
          if (L && y >= ry1 - 1) c = y === ry1 ? P.straw[0] : P.straw[1];
          if (L && y === ry1 - 2) c = P.straw[4];
          put(b, x, y, c);
        }
      }
      const rcx = x0 + w / 2, rw = Math.max(2, Math.round(w * 0.2));
      for (let x = Math.round(rcx - rw); x <= Math.round(rcx + rw - 1); x++) { put(b, x, ry0 - 1, rgb('#543c2c')); if (L) put(b, x, ry0 - 2, rgb('#785a40')); }
      return Object.assign(sprite(b, Math.floor(Wd / 2), gy), { ridge: [Math.round(rcx + rw) - Math.floor(Wd / 2), ry0 - 2 - gy] });
    });
  }
  function monastery(size) {
    return memo('mon:' + size, () => {
      const L = size === 'L', w = L ? 22 : 9, wh = L ? 9 : 4;
      const b = buf(w + 4, wh + (L ? 12 : 6)), gy = b.h - 2, x0 = 2;
      const WL = ramp('#d8d2c4', '#eee8dc', '#fbf8f0');
      for (let y = gy - wh + 1; y <= gy; y++) for (let x = x0; x < x0 + w; x++) put(b, x, y, rampPick(WL, 0.8 - (x - x0) / w * 0.5, x, y));
      rect(b, x0, gy - wh + 1, w, L ? 2 : 1, rgb('#9a3a2a'));
      if (L) { for (let i = 0; i < 4; i++) rect(b, x0 + 3 + i * 5, gy - 4, 2, 3, rgb('#4a3a34')); rect(b, x0 + w / 2 - 2, gy - 4, 4, 5, rgb('#7a2c22')); }
      const ry = gy - wh, rh = L ? 5 : 2;
      for (let j = 0; j < rh; j++) for (let x = x0 - 1 + j; x <= x0 + w - j; x++) put(b, x, ry - j, j === 0 ? rgb('#b07a1c') : rgb('#d6a228'));
      const fx = Math.floor(x0 + w / 2);
      for (let j = 0; j < (L ? 4 : 2); j++) put(b, fx, ry - rh - j, rgb('#f2c84a'));
      return sprite(b, Math.floor(b.w / 2), gy);
    });
  }
  function tent(color, size) {
    return memo('tent:' + color + ':' + size, () => {
      const n = size === 'L' ? 6 : size === 'M' ? 4 : 2, c = rgb(color), dk = mix(c, [0, 0, 0], 0.3);
      const b = buf(n * 2 + 3, n + 3), cx = n + 1, gy = n + 1;
      for (let j = 0; j < n; j++) for (let i = -j; i <= j; i++) put(b, cx + i, gy - n + 1 + j, i < 1 ? c : dk);
      if (n > 3) { put(b, cx, gy, rgb('#3c2c24')); put(b, cx, gy - 1, rgb('#3c2c24')); }
      return sprite(b, cx, gy);
    });
  }
  function serac(w, h, shade) {
    return memo('serac:' + w + ':' + h + ':' + shade, () => {
      const b = buf(w + 2, h + 2);
      for (let y = 1; y <= h; y++) for (let x = 1; x <= w; x++) {
        const c = y <= 1 ? P.ice[4] : x <= w * 0.45 ? P.ice[3 - shade] : P.ice[Math.max(0, 1 - shade)];
        put(b, x, y, c);
      }
      return sprite(b, Math.floor((w + 2) / 2), h + 1, true, { ink: rgb('#46649a') });
    });
  }
  function plane() {
    return memo('plane', () => {
      const b = buf(16, 8), wht = rgb('#f2f0ea'), red = rgb('#c8463a');
      rect(b, 2, 3, 11, 2, wht); put(b, 13, 4, wht); rect(b, 1, 1, 2, 3, red); rect(b, 6, 2, 3, 1, wht); rect(b, 6, 5, 3, 1, wht);
      put(b, 11, 3, rgb('#4a6488')); put(b, 10, 3, rgb('#4a6488')); rect(b, 3, 4, 9, 1, mix(wht, [0, 0, 0], 0.15));
      return sprite(b, 8, 6);
    });
  }
  function cloud(size, seed) {
    return memo('cloud:' + size + ':' + seed, () => {
      const s = size === 'L' ? 1 : size === 'M' ? 0.7 : 0.45, rnd = rng(seed * 7 + 1);
      const W = Math.ceil(44 * s) + 6, H = Math.ceil(22 * s) + 6, b = buf(W, H), cx = W / 2, cy = H / 2 + 1;
      const CR = ramp('#baceec', '#dce8f8', '#f8fbff', '#ffffff');
      const parts = [[-9, 2, 5], [9, 2, 5.5], [-3, -2, 7], [4, -3, 6], [0, 3, 6]];
      for (const [dx, dy, r] of parts) blob(b, cx + (dx + (rnd() - 0.5) * 3) * s, cy + dy * s, r * s + 0.5, CR, 0.85);
      return sprite(b, Math.floor(cx), Math.floor(cy), true, { ink: rgb('#7896c8'), bottom: 0.45, left: 0.35, right: 0.35, top: 0.25 });
    });
  }
  /** A lit disc with a one-step glow ring (sun, moon). */
  function disc(r, core, glow, ring) {
    return memo('disc:' + r + core + glow + ring, () => {
      const n = Math.ceil(r + 4) * 2 + 2, b = buf(n, n), c = n / 2;
      if (ring) blob(b, c, c, r + 3, [rgb(ring), rgb(ring)]);
      blob(b, c, c, r, [rgb(glow), rgb(core), rgb(core)]);
      return sprite(b, Math.floor(c), Math.floor(c), false);
    });
  }
  /** Pixel circle outline (bursts, the overview pin pulse). */
  function ring(r, color) {
    return memo('ring:' + r + color, () => {
      const n = r * 2 + 3, b = buf(n, n), c = rgb(color), m = r + 1;
      for (let a = 0; a < 360; a += 1) { const t = a * Math.PI / 180; put(b, Math.round(m + Math.cos(t) * r), Math.round(m + Math.sin(t) * r), c); }
      return sprite(b, m, m, false);
    });
  }
  /** Soft puff for dust, gravel and snow (a tiny blob, no outline). */
  function puff(r, color) {
    return memo('puff:' + r + color, () => { const n = r * 2 + 3, b = buf(n, n), c = rgb(color); blob(b, n / 2, n / 2, r + 0.4, [mix(c, [0, 0, 0], 0.12), c, mix(c, [255, 255, 255], 0.35)]); return sprite(b, Math.floor(n / 2), Math.floor(n / 2), false); });
  }
  function wand() {
    return memo('wand', () => { const b = buf(6, 12); for (let y = 1; y < 11; y++) put(b, 1, y, rgb('#5a4638')); for (let j = 0; j < 3; j++) for (let i = 1; i < 4 - j; i++) put(b, 1 + i, 1 + j, P.orange); return sprite(b, 1, 10); });
  }
  function smokePuff(r) {
    return memo('smoke:' + r, () => { const n = Math.ceil(r) * 2 + 3, b = buf(n, n); blob(b, n / 2, n / 2, r, ramp('#c8ccd6', '#e2e6ee', '#f4f6fa')); return sprite(b, Math.floor(n / 2), Math.floor(n / 2), true, { ink: rgb('#969cac'), bottom: 0.4, left: 0.3, right: 0.3, top: 0.2 }); });
  }

  /** Potato field: soil rows with round plant clumps, behind a wooden fence. */
  function field(w, rows) {
    return memo('field:' + w + ':' + rows, () => {
      const H = rows * 4 + 8, b = buf(w + 2, H), rnd = rng(w * 7 + rows), SOIL = ramp('#5c3c28', '#765034', '#8e6440');
      for (let r = 0; r < rows; r++) for (let x = 1; x <= w; x++) for (let j = 0; j < 3; j++) put(b, x, 6 + r * 4 + j, rampPick(SOIL, 0.8 - j * 0.3, x, j));
      for (let r = 0; r < rows; r++) for (let x = 2; x < w; x += 3) { blob(b, x + 0.5, 6 + r * 4, 1.6 + rnd() * 0.3, P.canopy.slice(1, 5), 0.8); if (rnd() < 0.25) put(b, x, 5 + r * 4, [250, 250, 240]); }
      for (let x = 1; x <= w; x++) { put(b, x, 2, rgb('#b08454')); put(b, x, 4, rgb('#966c42')); if ((x - 1) % 5 === 0) for (let y = 1; y <= 5; y++) put(b, x, y, rgb('#966c42')); }
      return sprite(b, 1, H - 1);
    });
  }
  /** Stone-ringed pond with a lily pad. */
  function pond(rx, ry) {
    return memo('pond:' + rx + ':' + ry, () => {
      const Wd = rx * 2 + 10, Hd = ry * 2 + 9, b = buf(Wd, Hd), cx = Wd / 2, cy = Hd / 2;
      const WATER = ramp('#30609a', '#4280ba', '#64a6d6', '#a8d6f0');
      for (let y = 0; y < Hd; y++) for (let x = 0; x < Wd; x++) {
        const d = ((x + 0.5 - cx) / rx) ** 2 + ((y + 0.5 - cy) / ry) ** 2;
        if (d <= 1) put(b, x, y, d > 0.7 && y < cy ? WATER[0] : rampPick(WATER, 0.15 + (y - cy + ry) / (2 * ry) * 0.5, x, y));
      }
      put(b, cx - 3, cy - 1, WATER[3]); put(b, cx - 2, cy - 1, WATER[3]); put(b, cx + 2, cy + 1, WATER[3]);
      const n = Math.max(8, Math.round(rx * 1.1));
      for (let i = 0; i < n; i++) { const a = i / n * Math.PI * 2; blob(b, cx + Math.cos(a) * (rx + 1.4), cy + Math.sin(a) * (ry + 1.1), 1.6 + (i % 3) * 0.3, P.stone, 0.75); }
      blob(b, cx + rx * 0.35, cy - 0.5, 1.5, P.canopy.slice(2), 0.6); put(b, Math.round(cx + rx * 0.35), Math.round(cy - 1), [250, 170, 200]);
      return sprite(b, Math.floor(cx), Hd - 1);
    });
  }

  // --- scenery spread across the mountain face (small, cached once) -------------------
  const SZ = (size, l, m, sm) => (size === 'L' ? l : size === 'M' ? m : sm);
  /** Herder's stone hut: dry-stone walls, a flat slate roof, a dark door. */
  function stoneHut(size, seed) {
    const sd = seed % 3;
    return memo('shut:' + size + ':' + sd, () => {
      const w = SZ(size, 14, 10, 6) + (size === 'S' ? 0 : sd), wh = SZ(size, 6, 4, 2), rh = SZ(size, 3, 2, 1);
      const b = buf(w + 4, wh + rh + 4), gy = b.h - 2, x0 = 2, rnd = rng(sd * 41 + w);
      const ST = ramp('#6e6a66', '#8e8882', '#aaa49c', '#c6c0b4');
      for (let y = gy - wh + 1; y <= gy; y++) for (let x = x0; x < x0 + w; x++) {
        const course = size !== 'S' && (gy - y) % 3 === 2;
        put(b, x, y, course ? ST[0] : rampPick(ST, 0.78 - (x - x0) / w * 0.45 + (rnd() - 0.5) * 0.25, x, y));
      }
      if (size !== 'S') { const dw = size === 'L' ? 2 : 1, dh = size === 'L' ? 4 : 3; rect(b, x0 + w - 3 - dw, gy - dh + 1, dw, dh, rgb('#3a2c24')); }
      const SL = ramp('#46444e', '#5e5c66', '#7a7882');
      for (let j = 0; j < rh; j++) {
        const y = gy - wh - j, inset = j === rh - 1 && rh > 1 ? 1 : 0;
        for (let x = x0 - 1 + inset; x <= x0 + w - inset; x++) put(b, x, y, j === rh - 1 ? SL[2] : SL[1]);
      }
      if (size === 'L') { put(b, x0 + 3, gy - wh - rh, ST[1]); put(b, x0 + w - 4, gy - wh - rh, ST[1]); }
      return sprite(b, Math.floor(b.w / 2), gy);
    });
  }
  /** A whitewashed chorten (stupa): stepped base, round dome, a gold spire. */
  function chorten(size) {
    return memo('chorten:' + size, () => {
      const bw = SZ(size, 10, 7, 4), bh = SZ(size, 3, 2, 1), dw = SZ(size, 6, 4, 2), dh = SZ(size, 4, 3, 2), sh = SZ(size, 6, 4, 2);
      const W = bw + 4, Ht = bh + 1 + dh + sh + 3, b = buf(W, Ht), gy = Ht - 2, cx = W / 2;
      const WL = ramp('#c8c0b0', '#e4ded2', '#faf6ee');
      const row = (y, hw, red) => { for (let x = Math.round(cx - hw); x < Math.round(cx + hw); x++) put(b, x, y, red ? rgb('#9a3a2a') : rampPick(WL, 0.9 - (x - (cx - hw)) / (2 * hw) * 0.6, x, y)); };
      for (let j = 0; j < bh; j++) row(gy - j, bw / 2, false);
      row(gy - bh, bw / 2 - 1, size !== 'S');
      for (let k = 0; k < dh; k++) { const t = (k + 0.5) / dh; row(gy - bh - 1 - k, Math.max(1, (dw / 2) * Math.sqrt(1 - t * t * 0.7)), false); }
      const top = gy - bh - 1 - dh, sw = size === 'L' ? 2 : 1;
      for (let k = 0; k < sh; k++) for (let i = 0; i < sw; i++) put(b, Math.floor(cx) - (sw > 1 ? 1 : 0) + i, top - k, k % 2 ? rgb('#b07a1c') : rgb('#e2b23a'));
      return sprite(b, Math.floor(cx), gy);
    });
  }
  /** A cairn: stones stacked by passing trekkers. */
  function cairn(size) {
    return memo('cairn:' + size, () => {
      const rs = SZ(size, [2.3, 1.8, 1.3], [1.7, 1.2], [1.2]);
      const b = buf(9, 12), cx = 4.5; let y = 10;
      for (const r of rs) { blob(b, cx, y - r * 0.6, r, P.stone, 0.62); y -= r * 1.25; }
      return sprite(b, 4, 10);
    });
  }
  /** A rock outcrop: two jagged peaks with lit left faces; tone 1–2 adds a snow cap (glacier, summit). */
  function outcrop(size, seed, tone) {
    return memo('out:' + size + ':' + seed + ':' + tone, () => {
      const R = tone === 0 ? ramp('#4c3c44', '#6a5458', '#8c7470', '#ae948a') : ramp('#3c3844', '#55515e', '#726e7a', '#94909c');
      const SN = ramp('#c4d0e8', '#f4f8ff');
      const w = SZ(size, 15 + seed * 2, 9 + seed, 5 + (seed % 2)), hmax = SZ(size, 7 + (seed % 3) * 2, 4 + (seed % 2), 3);
      const rnd = rng(seed * 131 + tone * 7 + w);
      const b = buf(w + 2, hmax + 3), gy = hmax + 1;
      const pk = [[0.32 + rnd() * 0.2, hmax], [0.68 + rnd() * 0.18, hmax * (0.45 + rnd() * 0.3)]];
      const hs = [];
      for (let x = 0; x < w; x++) {
        const t = (x + 0.5) / w; let h = 0;
        for (const [c, ph] of pk) h = Math.max(h, ph * (1 - Math.abs(t - c) / 0.42));
        hs.push(Math.max(1, Math.round(h + (rnd() - 0.5) * 1.1)));
      }
      let lit = true;
      for (let x = 0; x < w; x++) {
        const prev = x ? hs[x - 1] : 0;
        if (hs[x] > prev) lit = true; else if (hs[x] < prev) lit = false;
        const top = gy - hs[x] + 1;
        for (let y = top; y <= gy; y++) {
          let c = y === top ? R[3] : y === gy ? R[0] : lit ? R[2] : R[1];
          if (tone > 0 && y <= top + (tone === 2 ? 1 : 0)) c = lit ? SN[1] : SN[0];
          put(b, x + 1, y, c);
        }
      }
      return sprite(b, Math.floor((w + 2) / 2), gy);
    });
  }
  /** A crevasse: a straight dark crack in the ice, a bright snow lip above, one small step along it. */
  function crevasse(size, seed) {
    return memo('crev:' + size + ':' + seed, () => {
      const w = SZ(size, 16 + seed * 4, 10 + seed * 2, 5 + seed), th = SZ(size, 2, 1, 1);
      const b = buf(w + 2, th + 4), cy = 1, step = Math.floor(w * (0.35 + seed * 0.15));
      for (let x = 0; x < w; x++) {
        const t = (x + 0.5) / w, edge = t < 0.12 || t > 0.88;
        const n = edge ? 1 : th, yo = x >= step ? 1 : 0;
        put(b, x + 1, cy + yo, rgb('#fcfeff'));
        for (let j = 0; j < n; j++) put(b, x + 1, cy + 1 + j + yo, j === 0 ? rgb('#22305e') : rgb('#3c54a0'));
      }
      return sprite(b, Math.floor((w + 2) / 2), th + 2, false);
    });
  }
  /** A prayer-flag pole: a tall stick with five flags down its side. */
  function flagPole(size, seed) {
    const sd = seed % 2;
    return memo('fpole:' + size + ':' + sd, () => {
      const h = SZ(size, 16, 11, 7), fw = SZ(size, 3, 2, 1), fh = SZ(size, 2, 1, 1), gap = size === 'L' ? 1 : 0;
      const b = buf(fw + 4, h + 3), gy = h + 1;
      for (let y = gy - h + 1; y <= gy; y++) put(b, 1, y, rgb('#6a4a30'));
      put(b, 1, gy - h, rgb('#e2b23a'));
      for (let i = 0; i < 5; i++) { const y0 = gy - h + 2 + i * (fh + gap); if (y0 + fh > gy - 2) break; rect(b, 2, y0, fw, fh, P.flags[(i + sd) % 5]); }
      return sprite(b, 1, gy);
    });
  }
  /** A mani wall: a low wall of carved stones, rounded at the ends. */
  function maniWall(size) {
    return memo('mani:' + size, () => {
      const w = SZ(size, 20, 13, 7), h = SZ(size, 4, 3, 2);
      const b = buf(w + 2, h + 2), gy = h;
      for (let y = gy - h + 1; y <= gy; y++) for (let x = 1; x <= w; x++) {
        if ((x === 1 || x === w) && y === gy - h + 1) continue;
        let c = y === gy - h + 1 ? P.stone[3] : rampPick(P.stone, 0.62 - (x / w) * 0.3, x, y);
        if (size !== 'S' && y === gy - 1 && x % 3 === 1) c = rgb('#f4f0e6');
        put(b, x, y, c);
      }
      return sprite(b, Math.floor((w + 2) / 2), gy);
    });
  }
  /** A small patch of meadow flowers. */
  function flowers(seed) {
    return memo('flw:' + seed, () => {
      const b = buf(9, 4), rnd = rng(seed * 17 + 3), cols = [rgb('#fffcf0'), rgb('#ffdc5a'), rgb('#faaac8'), rgb('#c8b4ff')];
      for (let i = 0; i < 6; i++) { const x = 1 + Math.floor(rnd() * 7), y = Math.floor(rnd() * 2); put(b, x, y + 1, rgb('#3e6e30')); put(b, x, y, cols[(seed + (i % 2) * 2) % 4]); }
      return sprite(b, 4, 3, false);
    });
  }
  /** The crescent moon, cut out once (the sky shows through). */
  function moon() {
    return memo('moon', () => {
      const d = disc(6, '#f0f2ff', '#c8cce4', null), c = canvas(d.w, d.h), g = c.getContext('2d');
      g.drawImage(d.cv, 0, 0);
      for (let yy = -7; yy <= 7; yy++) for (let xx = -7; xx <= 7; xx++) if ((xx - 3) * (xx - 3) + (yy + 2) * (yy + 2) <= 30) g.clearRect(d.ax + xx, d.ay + yy, 1, 1);
      return { cv: c, w: d.w, h: d.h, ax: d.ax, ay: d.ay };
    });
  }

  window.DA_PIXEL = {
    field, pond, stoneHut, chorten, cairn, outcrop, crevasse, flagPole, maniWall, flowers, moon,
    dither, rampPick, hash2, rng, rgb, mix, ramp, clamp, canvas, buf, put, selout, toCanvas, sprite, fromMap, blob, rect, line, P,
    CLIMBER_PAL, HEAD, BODIES, CHEER_ARMS, DEFAULT_HAT, COSMETICS, buildClimber, hatSprites, outfitKey,
    ALPACA, ALPACA_RUN, COATS, GOLD_COAT, buildAlpaca, overlay,
    text, sign, clearTextCaches, tree, pine, bush, stone, teahouse, monastery, tent, serac, plane, cloud, disc, ring, puff, wand, smokePuff,
  };
})();
