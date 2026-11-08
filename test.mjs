// Node tests for the Daily Ascent engine and seed data.
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';

const dir = path.dirname(new URL(import.meta.url).pathname);
const ctx = { console, module: undefined };
ctx.globalThis = ctx;
vm.createContext(ctx);
vm.runInContext('var DA_CATS = [];', ctx);
for (const f of ['src/engine.js', 'src/data-broad.js', 'src/data-mid.js', 'src/data-hard-wild.js']) {
  vm.runInContext(fs.readFileSync(path.join(dir, f), 'utf8'), ctx, { filename: f });
}
const E = ctx.DA_ENGINE;
const CATS = ctx.DA_CATS;
const DATA = { categories: CATS.filter((c) => c.kind !== 'practice') };

let fails = 0;
const ok = (cond, msg) => { if (!cond) { fails++; console.log('FAIL', msg); } };

// ---- normalization
ok(E.normalize('  Café  ') === 'cafe', 'diacritics');
ok(E.normalize('The Netherlands') === 'netherlands', 'leading article');
ok(E.normalize('Burkina   Faso!') === 'burkina faso', 'spaces/punct');
ok(E.normalize("O'Keeffe") === 'okeeffe', 'apostrophe');
ok(E.normalize('Trinidad & Tobago') === 'trinidad and tobago', 'ampersand');

// ---- per-category integrity
const idx = {};
const report = [];
for (const c of CATS) {
  const ix = E.buildIndex(c);
  idx[c.id] = ix;
  const counts = E.CONFIG.tiers.map((_, t) => ix.entries.filter((e) => e.tier === t).length);
  report.push(`${c.id.padEnd(15)} ${c.kind.padEnd(8)} ${String(ix.entries.length).padStart(4)}  [${counts.join(' ')}]`);
  // every canonical and alias must match back to its own entry
  for (const e of ix.entries) {
    for (const form of [e.canon, ...e.aliases]) {
      const m = E.match(ix, form);
      if (!m || !m.entry || m.entry.id !== e.id) {
        fails++;
        console.log(`FAIL ${c.id}: "${form}" -> ${m && m.entry ? '"' + m.entry.canon + '"' : JSON.stringify(m)} (expected "${e.canon}")`);
      }
    }
  }
}
console.log(report.join('\n'));

// ---- spot checks
const has = (cat, input, canon) => {
  const m = E.match(idx[cat], input);
  ok(m && m.entry && m.entry.canon === canon, `${cat}: "${input}" should match ${canon}, got ${m && m.entry ? m.entry.canon : JSON.stringify(m)}`);
};
const none = (cat, input) => {
  const m = E.match(idx[cat], input);
  ok(!m || !m.entry, `${cat}: "${input}" should not match, got ${m && m.entry ? m.entry.canon : ''}`);
};
has('animals', 'horses', 'Horse');
has('animals', 'Geese', 'Goose');
has('mountains', 'Mt. Everest', 'Everest');
has('mountains', 'mount kenya', 'Mount Kenya');
has('mountains', 'Mt Kenya', 'Mount Kenya');
has('trees', 'oak tree', 'Oak');
has('trees', 'Oak trees', 'Oak');
has('vegetables', 'tomatoe', 'Tomato');
has('vegetables', 'brussel sprouts', 'Brussels sprout');
has('europe', 'Holland', 'Netherlands');
has('europe', 'irland', 'Ireland');
has('africa', 'cote d\'ivoire', 'Ivory Coast');
has('kitchen', 'knives', 'Knife');
has('kitchen', 'frying pans', 'Frying pan');
has('heroes', 'spider-man', 'Spider Man');
has('heroes', 'Peter Parker', 'Spider Man');
has('fruits', 'blue berries', 'Blueberry');
has('cheeses', 'cheddar cheese', 'Cheddar');
has('dogs', 'golden retrievers', 'Golden Retriever');
has('islands', 'Bali island', 'Bali');
has('composers', 'mozart', 'Wolfgang Amadeus Mozart');
has('composers', 'Rachmaninov', 'Sergei Rachmaninoff');
has('elements', 'aluminium', 'Aluminum');
has('constellations', 'big dipper', 'Ursa Major');
none('africa', 'Austria');
none('europe', 'Mali');
none('fruits', 'carrot');
none('usstates', 'Puerto Rico');

const elements = idx.elements.entries.length;
ok(elements === 118, 'elements count ' + elements);
const iau = idx.constellations.entries.filter((e) => !/triangle|belt|pleiades|square|teapot|hyades|argo|cross$|keystone|sickle|coathanger|cascade|coffin|quadrans|felis|noctua|antinous|cerberus|gallus|rangifer|poniatovii|machina|officina|solarium/i.test(e.canon) || /^crux|triangulum/i.test(e.canon)).length;
ok(iau === 88, 'IAU constellations ' + iau);
ok(idx.usstates.entries.length === 50, 'states ' + idx.usstates.entries.length);
ok(idx.africa.entries.filter((e) => e.canon !== 'Western Sahara').length === 54, 'africa ' + idx.africa.entries.length);

// ---- scoring
ok(E.answerGain(0, 0, 0) === 55, 'crawler gain leg1');
ok(E.answerGain(4, 10, 6) === Math.round(500 * 1.25 * 1.5), 'sherpa chained leg7');
ok(E.CONFIG.tiers.map((t) => t.name).join() === 'Crawler,Hiker,Climber,Mountaineer,Sherpa', 'rank names');
ok(E.legEffective(750) === 750 && E.legEffective(950) === 820 && E.legEffective(5000) === 1000, 'leg cap');
ok(E.finalAltitude([5000, 5000, 5000, 5000, 5000, 5000, 5000]) === 8849, 'summit cap');
ok(E.milestoneFor(5400).id === 'basecamp' && E.milestoneFor(8849).id === 'summit' && E.milestoneFor(3000).id === 'lukla', 'milestones');
ok(E.airPercent(8849) >= 30 && E.airPercent(8849) <= 34, 'air at summit ' + E.airPercent(8849));

// ---- verdicts
ok(E.interpretVerdict({ valid: true, commonness: 0.005, confidence: 0.9 }).tier === 4, 'confident sherpa');
ok(E.interpretVerdict({ valid: true, commonness: 0.005, confidence: 0.3 }).tier === 1, 'low confidence capped at hiker');
ok(E.interpretVerdict({ valid: false, confidence: 0.9 }).penalize === true, 'confident invalid penalized');
ok(E.interpretVerdict({ valid: false, confidence: 0.2 }).penalize === false, 'unsure invalid not penalized');
ok(E.interpretVerdict(null).kind === 'error', 'bad verdict');

// ---- daily deal: 120 days
const seen = new Map();
let prev = [];
for (let d = 1; d <= 120; d++) {
  const cats = E.dailyCategories(DATA, d);
  ok(cats.length === 7 && cats.every(Boolean), 'day ' + d + ' has 7');
  const ids = cats.map((c) => c.id);
  ok(new Set(ids).size === 7, 'day ' + d + ' unique: ' + ids.join(','));
  cats.forEach((c, i) => ok(c.kind === E.CONFIG.legKinds[i], `day ${d} leg ${i + 1} kind ${c.kind}`));
  const lanes = cats.filter((c) => c.kind === 'mid').map((c) => c.lane);
  ok(new Set(lanes).size === 3, 'day ' + d + ' lanes ' + lanes);
  const repeat = ids.filter((x) => prev.includes(x));
  ok(repeat.length === 0, `day ${d} repeats yesterday: ${repeat}`);
  prev = ids;
  ids.forEach((x) => seen.set(x, (seen.get(x) || 0) + 1));
  if (d <= 3) console.log('day', d, ids.join(', '));
}
ok(seen.size === DATA.categories.length, 'all categories dealt: ' + seen.size);

// ---- calibration Monte Carlo (players are archetypes with tier mixes)
function simulate(profile, n = 4000) {
  const r = E.rng(42);
  const out = [];
  for (let i = 0; i < n; i++) {
    const skill = profile.skill * (0.75 + r() * 0.5);
    const raws = E.CONFIG.legs.map((leg, li) => {
      const answers = Math.max(0, Math.round(leg.secs * skill * (0.7 + r() * 0.6) / profile.secsPerAnswer));
      let raw = 0, chain = 0;
      for (let k = 0; k < answers; k++) {
        if (r() < profile.invalidRate) { chain = 0; continue; }
        const x = r(); let acc = 0, t = 0;
        for (; t < 5; t++) { acc += profile.mix[t]; if (x < acc) break; }
        raw += E.answerGain(Math.min(t, 4), chain, li); chain++;
      }
      return raw;
    });
    out.push(E.finalAltitude(raws));
  }
  return out;
}
const bands = (alts) => {
  const b = { 'below BC': 0, 'BC': 0, 'C1-C2': 0, 'C2-DZ': 0, 'DZ': 0, 'Summit': 0 };
  for (const a of alts) {
    if (a < 5364) b['below BC']++; else if (a < 6065) b.BC++; else if (a < 6400) b['C1-C2']++;
    else if (a < 8000) b['C2-DZ']++; else if (a < 8849) b.DZ++; else b.Summit++;
  }
  return Object.entries(b).map(([k, v]) => `${k} ${(100 * v / alts.length).toFixed(0)}%`).join(' · ');
};
const median = (a) => a.slice().sort((x, y) => x - y)[Math.floor(a.length / 2)];
const players = [
  { name: 'casual', weight: 0.3, skill: 1, secsPerAnswer: 5, invalidRate: 0.15, mix: [0.85, 0.12, 0.03, 0, 0] },
  { name: 'solid', weight: 0.4, skill: 1, secsPerAnswer: 3, invalidRate: 0.1, mix: [0.7, 0.18, 0.09, 0.025, 0.005] },
  { name: 'strong', weight: 0.25, skill: 1, secsPerAnswer: 2.5, invalidRate: 0.06, mix: [0.55, 0.22, 0.14, 0.07, 0.02] },
  { name: 'expert', weight: 0.05, skill: 1, secsPerAnswer: 2, invalidRate: 0.04, mix: [0.42, 0.24, 0.18, 0.11, 0.05] },
];
let all = [];
for (const p of players) {
  const alts = simulate(p);
  console.log(`${p.name.padEnd(7)} median ${median(alts)} m  | ${bands(alts)}`);
  all = all.concat(alts.slice(0, Math.round(alts.length * p.weight)));
}
console.log('blended          | ' + bands(all));

console.log(fails ? `\n${fails} FAILURES` : '\nALL TESTS PASSED');
process.exit(fails ? 1 : 0);
