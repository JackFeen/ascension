# AGENTS.md

Read [`CLAUDE.md`](CLAUDE.md) before changing anything. It covers the product vision, architecture, file map, data formats, gotchas, commands (`npm test`, `npm run build`, `npm run smoke`) and the roadmap. The original product spec is in [`docs/product-spec.md`](docs/product-spec.md).

Short version: edit `src/`, never `dist/`; run `npm test` after any change to `src/engine.js` or `src/data-*.js`; then `npm run build`.
