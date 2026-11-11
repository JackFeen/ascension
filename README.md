# Daily Ascent

A daily word game. Five categories, five timed legs, and your score is your altitude on Everest, drawn as cozy pixel art.

**Working on the code (or pointing an AI agent at it)? Start with [`CLAUDE.md`](CLAUDE.md)**: vision, architecture, file map, gotchas and roadmap. The original spec is in [`docs/product-spec.md`](docs/product-spec.md).

Play it at **https://jackfeen.github.io/ascension/**.

## Publishing changes

GitHub Pages serves the root `index.html` from `main`. Edit files in `src/`, run `npm test && npm run build`, then commit `src/` together with the rebuilt `index.html` and push. The site updates in about a minute. The share card picks up the github.io link automatically.

Moving to your own domain later: add a `CNAME` file in GitHub Pages settings. To force a specific link in the share card, add `<script>window.DA_SHARE_URL = "https://yourdomain.com"</script>` before the other scripts.

## Project layout

| File | What it is |
| --- | --- |
| `src/engine.js` | Config, normalization, matching (exact → alias → autocorrect for typos and sound-alikes → qualified variants), scoring, daily deal, judge prompt. No DOM. |
| `src/data-*.js` | The answer bank: 49 categories plus a practice one, about 28,400 answers, scored across five climber ranks (Crawler, Hiker, Climber, Mountaineer, Sherpa). |
| `src/pixel.js` | The pixel sprite kit: dithering, outlines, lit blobs, text signs, and the sprite maps for the layered climber, the alpacas and the scenery. |
| `src/app.js` | The pixel-art mountain (a low-res canvas scaled up crisply, built to hold a steady 60 fps), sound, answer checking, game flow, results, stats, and the Sherpa alpaca ride (after a Sherpa answer's spotlight, a herd carries the climber up the meters earned). |
| `src/shell.html` | Markup and styles: the pixel UI (parchment panels, wood signs, HUD plates, Silkscreen and Pixelify Sans). |
| `build.mjs` | `node build.mjs` writes `index.html` (the playable page, committed for GitHub Pages) and `dist/game.html` (Claude artifact body, git-ignored). |
| `src/dev-*.js`, `src/dev.js` | Dev mode: the published lock (salt + hash), lap math and password check, and the tools UI. |
| `test.mjs` | `npm test` checks every answer and alias, must-accept and must-reject lists for every category, matching and qualifier edge cases, timers, scoring, 120 days of deals, that the deal for puzzles 1–365 hasn't changed, and a calibration simulation. |
| `scripts/smoke.cjs` | `npm run smoke` plays a full climb in headless Chromium inside a sandboxed iframe (needs `npm install && npx playwright install chromium`). Screenshots land in `shots/`, including `newlook-home.png`, `newlook-leg1.png`, `newlook-camp.png`, `newlook-night.png`, `newlook-ride.png`, `newlook-results.png` and, with dev mode, `newlook-outfit.png`. |

## Tuning

Every number lives in `CONFIG` at the top of `src/engine.js`: leg timers and multipliers, rank gains, chain bonus, leg cap, penalties, judge thresholds. Change, run `node test.mjs` to see the simulated altitude distribution, then `node build.mjs`.

## Adding categories

Add an object to one of the `src/data-*.js` files:

```js
{ id: 'rivers', kind: 'hard', text: 'Rivers', a: {
  c: 'Nile, Amazon, Mississippi',          // most players say these
  f: '...', u: '...', r: '...', e: '...',
  l: 'Okavango=okavango river',            // "=" adds an alias
}},
```

`kind` is `broad` (leg 1), `mid` (legs 2 and 4, two of the three lanes a day in rotation; also set `lane` to `geo`, `nature` or `culture`), `wild` (leg 3) or `hard` (leg 5). Each pool is dealt in cycles with no repeats, so adding categories lengthens the time before any category comes back. Adding a category also reshuffles every day's deal, and `npm test` pins that deal, so update its hash in `test.mjs` on purpose (CLAUDE.md §4, gotcha 8). Add a few answers to `MUST_ACCEPT` in `test.mjs` too. An optional `qualifiers` list lets one leading word make a variant ("women's soccer"); see CLAUDE.md §7.

## Dev mode

A password-locked infinite climb with testing tools: pause and speed controls, laps past the summit, jumping to any leg, altitude or category, an autoplay bot, a browsable answer bank with every answer's rank and score, effect triggers (including a preview of draft climber cosmetics), an answer debugger, a fake answer checker, a fake clock, save-data tools, an FPS meter and screenshots. Open it with `?dev` in the URL or by tapping the "Daily Ascent" wordmark five times. Dev climbs use their own save and never touch your real streak or stats.

The password lives only in `dev.local.mjs` at the repo root, which is git-ignored and must never be committed. `npm run dev-lock` turns it into `src/dev-lock.js`, which holds just a salt and a hash. Details are in [`CLAUDE.md`](CLAUDE.md) §15.

## What runs where

- **As a Claude artifact:** answers missing from the word list can be checked by Claude on the player's own account, after they allow it once.
- **On GitHub Pages:** only word-list answers count. A backend judge (Supabase edge function or Cloudflare Worker calling an LLM) would bring checking to the public site.
- **Not yet built (spec v1):** server-authoritative timers, accounts, leaderboards, image share card, review tooling. Everything is client-side, so the answer bank is visible in the page source.
