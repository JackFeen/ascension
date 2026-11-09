// Inlines engine, data, dev mode and app into the shell.
//   dist/game.html  — page body for the claude.ai artifact (the host adds the document skeleton)
//   index.html      — complete standalone page at the repo root (GitHub Pages serves it)
import fs from 'node:fs';
const read = (f) => fs.readFileSync(new URL(f, import.meta.url), 'utf8');
const shell = read('./src/shell.html');
const data = ['./src/data-broad.js', './src/data-mid.js', './src/data-hard-wild.js'].map(read).join('\n');
// Dev mode: the published lock (salt + hash only), its pure core, then the tools UI.
const dev = ['./src/dev-lock.js', './src/dev-core.js', './src/dev.js'].map(read).join('\n');
const parts = { '/*@ENGINE*/': read('./src/engine.js'), '/*@DATA*/': data, '/*@DEV*/': dev, '/*@APP*/': read('./src/app.js') };
let out = shell;
for (const [k, v] of Object.entries(parts)) {
  if (/<\/script/i.test(v)) throw new Error('script terminator inside ' + k);
  out = out.split(k).join(v);
}
fs.mkdirSync(new URL('./dist/', import.meta.url), { recursive: true });
fs.writeFileSync(new URL('./dist/game.html', import.meta.url), out);
const cut = out.indexOf('</style>') + '</style>'.length;
const head = out.slice(0, cut), body = out.slice(cut);
const page = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="theme-color" content="#3b4c8c">
${head}
</head>
<body>${body}
</body>
</html>
`;
fs.writeFileSync(new URL('./index.html', import.meta.url), page);
console.log('built', (out.length / 1024).toFixed(0) + ' KB');
