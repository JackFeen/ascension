/* Daily Ascent — dev mode core: lap math and password check.
   Pure logic, no DOM. Runs in the browser and in Node (for tests). */
(function (root) {
  'use strict';

  // ---------------------------------------------------------------------------
  // Laps. The dev climb never ends: the total climbed is uncapped, and the
  // climber's altitude wraps from the summit back to Lukla once per lap.
  //   span     = summitAlt − startAlt (5,989 m with the real CONFIG)
  //   lap      = 1 + floor(total / span)
  //   altitude = startAlt + (total mod span)
  // ---------------------------------------------------------------------------
  function lapState(total, startAlt, summitAlt) {
    const span = summitAlt - startAlt;
    const t = Math.max(0, Number(total) || 0);
    const idx = Math.floor(t / span);
    const within = t - idx * span;
    return { lap: idx + 1, alt: startAlt + within, within, total: t, span };
  }

  // ---------------------------------------------------------------------------
  // Password check: PBKDF2-SHA256 through WebCrypto, constant-time compare.
  // ---------------------------------------------------------------------------
  const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  function b64ToBytes(s) {
    const clean = String(s).replace(/[^A-Za-z0-9+/]/g, '');
    const out = [];
    let buf = 0, bits = 0;
    for (const ch of clean) {
      buf = (buf << 6) | B64.indexOf(ch);
      bits += 6;
      if (bits >= 8) { bits -= 8; out.push((buf >> bits) & 255); }
    }
    return new Uint8Array(out);
  }

  function timingSafeEqual(a, b) {
    let diff = a.length ^ b.length;
    const n = Math.max(a.length, b.length);
    for (let i = 0; i < n; i++) diff |= (a[i] | 0) ^ (b[i] | 0);
    return diff === 0;
  }

  // Resolves true only when `password` derives to lock.hash. Throws when
  // WebCrypto is unavailable (callers show the "needs https" message).
  async function verifyPassword(password, lock, subtle, Encoder) {
    if (!subtle || typeof subtle.importKey !== 'function') throw new Error('no-subtle');
    const enc = new (Encoder || TextEncoder)();
    const key = await subtle.importKey('raw', enc.encode(String(password)), 'PBKDF2', false, ['deriveBits']);
    const want = b64ToBytes(lock.hash);
    const bits = await subtle.deriveBits({ name: 'PBKDF2', salt: b64ToBytes(lock.salt), iterations: lock.iterations, hash: 'SHA-256' }, key, want.length * 8);
    return timingSafeEqual(new Uint8Array(bits), want);
  }

  const CORE = { lapState, b64ToBytes, timingSafeEqual, verifyPassword };
  if (typeof module !== 'undefined' && module.exports) module.exports = CORE;
  else root.DA_DEV_CORE = CORE;
})(typeof window !== 'undefined' ? window : globalThis);
