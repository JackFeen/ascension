// Node tests for the Daily Ascent engine and seed data.
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import crypto from 'node:crypto';

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

// ---- qualifiers (stage 4): a leading generic qualifier on a listed answer
{
  const q = (cat, input, base, qual) => {
    const m = E.match(idx[cat], input);
    ok(m && m.entry && m.entry.canon === base && m.qualifier === qual, `${cat}: "${input}" should qualify ${qual} + ${base}, got ${m && m.entry ? (m.qualifier || '-') + ' + ' + m.entry.canon : JSON.stringify(m)}`);
    return m;
  };
  const m1 = q('sports', "women's soccer", 'Soccer', 'womens');
  ok(m1 && m1.canon === 'Women’s soccer', 'qualified canonical reads well: ' + (m1 && m1.canon));
  q('sports', 'womens socer', 'Soccer', 'womens');            // fuzzy on the base word
  q('colors', 'dark purple', 'Purple', 'dark');
  q('fruits', 'dried mangoes', 'Mango', 'dried');             // plural on the base
  // explicit entries win over a qualified reading
  has('sports', 'beach volleyball', 'Beach volleyball');
  ok(!E.match(idx.sports, 'beach volleyball').qualifier, 'listed entry is not reported as qualified');
  // qualified answers keep the base tier
  const soccer = E.match(idx.sports, 'soccer').entry;
  ok(m1 && m1.entry.tier === soccer.tier, 'qualified tier equals base tier');
  // must-reject: qualifier alone, stacked, qualifier + non-answer, categories without qualifiers
  for (const [cat, input] of [['sports', 'womens'], ['sports', 'womens youth soccer'], ['sports', 'womens asdfgh'], ['sports', 'youth womens soccer'],
    ['colors', 'dark dark green'], ['colors', 'light'], ['colors', 'dark potato'], ['fruits', 'dried dried mango'], ['jobs', 'head zzq'],
    ['animals', 'womens horse'], ['capitals', 'dark paris']]) none(cat, input);
  ok(CATS.filter((c) => !c.qualifiers).every((c) => E.qualifierList(c).length === 0), 'no qualifiers without a qualifiers field');
  const bare = E.buildIndex(Object.assign({}, CATS.find((c) => c.id === 'sports'), { qualifiers: undefined }));
  ok(!E.match(bare, 'womens soccer'), 'a category without a qualifiers field never qualifies');
  // dedupe on (base, qualifier) and the per-leg cap
  const sid = soccer.id, bid = E.match(idx.sports, 'basketball').entry.id;
  const leg = [{ s: 'ok', eid: sid }];
  ok(E.hitOutcome(leg, sid, null).kind === 'dup', 'plain repeat is a duplicate');
  ok(E.hitOutcome(leg, sid, 'womens').kind === 'new', 'qualified form is distinct from its base');
  leg.push({ s: 'ok', eid: sid, q: 'womens' });
  ok(E.hitOutcome(leg, sid, 'womens').kind === 'dup', "women's soccer twice is a duplicate");
  ok(E.match(idx.sports, "women's soccer").qualifier === E.match(idx.sports, 'womens soccer').qualifier, "women's / womens share one key");
  leg.push({ s: 'ok', eid: bid, q: 'womens' }, { s: 'ok', eid: bid, q: 'college' }, { s: 'rejected', eid: null });
  ok(E.CONFIG.maxQualifiedPerLeg === 3, 'variant cap is 3');
  ok(E.hitOutcome(leg, sid, 'youth').kind === 'limit', 'a 4th qualified answer hits the variant limit');
  ok(E.hitOutcome(leg, bid, null).kind === 'new', 'plain answers are not limited by the variant cap');
  ok(E.hitOutcome(leg, sid, 'youth', leg[3]).kind === 'new', 'the answer being resolved is ignored when counting');
  // the judge's canonical maps without fuzzy matching
  ok(!E.match(idx.sports, 'womens socer', { noFuzzy: true }), 'noFuzzy skips fuzzy in qualified matching too');
  ok(E.match(idx.sports, "Women's Soccer", { noFuzzy: true }).qualifier === 'womens', 'judge canonical maps onto a qualified form');
}

const elements = idx.elements.entries.length;
ok(elements === 118, 'elements count ' + elements);
const iau = idx.constellations.entries.filter((e) => !/triangle|belt|pleiades|square|teapot|hyades|argo|cross$|keystone|sickle|coathanger|cascade|coffin|quadrans|felis|noctua|antinous|cerberus|gallus|rangifer|poniatovii|machina|officina|solarium/i.test(e.canon) || /^crux|triangulum/i.test(e.canon)).length;
ok(iau === 88, 'IAU constellations ' + iau);
ok(idx.usstates.entries.length === 50, 'states ' + idx.usstates.entries.length);
ok(idx.africa.entries.filter((e) => e.canon !== 'Western Sahara').length === 54, 'africa ' + idx.africa.entries.length);

// ---- leg timers (+10 s each); multipliers, extra time, countdown and penalty unchanged
ok(JSON.stringify(E.CONFIG.legs.map((l) => l.secs)) === '[30,30,25,25,25,20,20]', 'leg timers are 30/30/25/25/25/20/20');
ok(JSON.stringify(E.CONFIG.legs.map((l) => l.mult)) === '[1,1,1.25,1.25,1.25,1.5,1.5]', 'leg multipliers unchanged');
ok(E.CONFIG.extraTimeFactor === 1.5 && E.CONFIG.countdownSecs === 3 && E.CONFIG.transitionMs === 3500 && E.CONFIG.invalidPenaltySecs === 1, 'extra time, countdown, transition and penalty unchanged');
ok(E.CONFIG.legs.reduce((s, l) => s + l.secs, 0) === 175, 'total answering time is 175 s');

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

// ---- deal unchanged by the word-list expansion: puzzles 1-365 must match the
// pre-expansion deal (the deal depends on category ids, kinds and lanes, never on answers)
{
  const deal = [];
  for (let d = 1; d <= 365; d++) deal.push(E.dailyCategories(DATA, d).map((c) => c.id).join(','));
  const hash = crypto.createHash('sha256').update(JSON.stringify(deal)).digest('hex');
  ok(hash === '672df2266a0dc0913a8b2d6c0a7db5638be88287015772535eb69f5e1bb46b5e', 'deal for puzzles 1-365 unchanged (sha256 ' + hash.slice(0, 12) + ')');
}

// ---- autocorrect (§6.3): real misspellings that must be corrected to a listed answer
const MUST_CORRECT = [
  ["sports", "wheelchare basketbal", "Wheelchair basketball"],
  ["composers", "tchaikovski", "Pyotr Tchaikovsky"],
  ["colors", "fuschia", "Fuchsia"],
  ["mountains", "kilimanjero", "Kilimanjaro"],
  ["dogs", "chiwawa", "Chihuahua"],
  ["dogs", "daschund", "Dachshund"],
  ["fruits", "bananna", "Banana"],
  ["fruits", "pinapple", "Pineapple"],
  ["vegetables", "brocolli", "Broccoli"],
  ["vegetables", "zuchini", "Zucchini"],
  ["animals", "girafe", "Giraffe"],
  ["animals", "hippopotamous", "Hippo"],
  ["dinosaurs", "tyranosaurus", "Tyrannosaurus rex"],
  ["painters", "michaelangelo", "Michelangelo"],
  ["painters", "rembrant", "Rembrandt"],
  ["spices", "cinammon", "Cinnamon"],
  ["sea", "octapus", "Octopus"],
  ["jobs", "plummer", "Plumber"],
  ["europe", "lichtenstein", "Liechtenstein"],
  ["asia", "phillipines", "Philippines"],
  ["desserts", "tiramisoo", "Tiramisu"],
  ["cheeses", "parmasan", "Parmesan"],
  ["animals", "elephamt", "Elephant"],
  ["kitchen", "spatuls", "Spatula"],
  ["birds", "flamingoe", "Flamingo"],
  ["insects", "cockroch", "Cockroach"],
  ["instruments", "saxaphone", "Saxophone"],
  ["instruments", "xylaphone", "Xylophone"],
  ["capitals", "budapesht", "Budapest"],
  ["africa", "zimbabwae", "Zimbabwe"],
  ["europe", "swizerland", "Switzerland"],
  ["asia", "afganistan", "Afghanistan"],
  ["elements", "flourine", "Fluorine"],
  ["elements", "potasium", "Potassium"],
  ["greekmyth", "persefone", "Persephone"],
  ["heroes", "wolverene", "Wolverine"],
  ["trees", "eucalyptis", "Eucalyptus"],
  ["flowers", "chrysanthemem", "Chrysanthemum"],
  ["eurocities", "barcelone", "Barcelona"],
  ["languages", "portugese", "Portuguese"],
  ["cars", "lamborgini", "Lamborghini"],
  ["games", "monopolu", "Monopoly"],
  ["bathroom", "toothbrish", "Toothbrush"],
  ["breakfast", "pancackes", "Pancakes"],
  ["office", "stappler", "Stapler"],
  ["clothing", "cardigam", "Cardigan"],
  ["body", "stomache", "Stomach"],
  ["constellations", "casiopeia", "Cassiopeia"],
  ["sports", "table tenis", "Table tennis"],
  ["fly", "helicoptor", "Helicopter"],
  ["sports", "weelchiar baskeball", "Wheelchair basketball"],
  ["dogs", "golden retreiver", "Golden Retriever"],
];
{
  const kinds = new Set();
  for (const [cat, input, canon] of MUST_CORRECT) {
    const m = E.match(idx[cat], input);
    ok(m && m.entry && m.entry.canon === canon && m.via === 'fuzzy', `${cat}: "${input}" corrects to ${canon}, got ${m ? (m.entry ? m.entry.canon + ' via ' + m.via : 'ambiguous') : 'nothing'}`);
    if (m && m.fix) kinds.add(m.fix);
  }
  for (const k of ['typo', 'keyboard', 'sound', 'words']) ok(kinds.has(k), 'MUST_CORRECT covers fix kind ' + k);
  ok(new Set(MUST_CORRECT.map((c) => c[0])).size >= 20 && MUST_CORRECT.length >= 40, 'MUST_CORRECT spans 40+ cases in 20+ categories');
}

// ---- autocorrect guardrails: inputs that must NOT be corrected
// expect: null = no match · 'ambiguous' · a canonical name = that exact listed answer
const MUST_NOT_CORRECT = [
  ['animals', 'cst', null, '3 letters, one off: answers this short never correct'],
  ['animals', 'dpg', null, '3 letters, one keyboard slip: still never corrected'],
  ['animals', 'loin', null, '4 letters allow only one keyboard or repeated-letter fix, not a swap'],
  ['animals', 'road', null, 'no keyboard discount on the first letter (road is not Toad)'],
  ['islands', 'xqzvbn', null, 'gibberish: no first-letter match with anything close'],
  ['jobs', 'qwerty', null, 'gibberish'],
  ['sports', 'zzzzzzz', null, 'gibberish'],
  ['flowers', 'chrys', null, 'under 60% of the answer’s length (chrysanthemum)'],
  ['dinosaurs', 'tyran', null, 'under 60% of the answer’s length (tyrannosaurus)'],
  ['fruits', 'safe', null, 'sound-alike matching is only for answers of 7+ letters (safou)'],
  ['animals', 'mouse', 'Mouse', 'an exact answer never corrects to a near one (moose)'],
  ['animals', 'moose', 'Moose', 'an exact answer never corrects to a near one (mouse)'],
  ['office', 'staplet', 'ambiguous', 'equally close to stapler and staples, neither sounds the same'],
];
for (const [cat, input, expect, why] of MUST_NOT_CORRECT) {
  const m = E.match(idx[cat], input);
  const got = !m ? null : m.ambiguous ? 'ambiguous' : m.via === 'fuzzy' ? 'corrected to ' + m.entry.canon : m.entry.canon;
  ok(got === expect, `${cat}: "${input}" → ${expect} (${why}), got ${got}`);
}
{
  const K = E.CONFIG.correct;
  ok(K && K.keyboardCost === 0.5 && K.doubleLetterCost === 0.5 && K.soundCost === 1 && K.margin === 1 && K.shortLen === 4, 'CONFIG.correct defaults');
  ok(E.fuzzyAllowance(3) === 0 && E.fuzzyAllowance(4) === 0.5 && E.fuzzyAllowance(8) === 1 && E.fuzzyAllowance(9) === 2, 'allowance by length');
  ok(E.phoneticKey('fuschia') === E.phoneticKey('fuchsia') && E.phoneticKey('chiwawa') === E.phoneticKey('chihuahua') && E.phoneticKey('daschund') === E.phoneticKey('dachshund'), 'phonetic keys match for sound-alikes');
  ok(E.phoneticKey('phoenix')[0] === 'f' && E.phoneticKey('knight')[0] === 'n' && E.phoneticKey('cinnamon')[0] === 's', 'phonetic key respelling (ph, kn, soft c)');
  const cc = E.correctionCost('fuschia', 'fuchsia');
  ok(cc.allowed && cc.fix === 'sound', 'correctionCost reports the sound fix');
  ok(E.correctionCost('bananna', 'banana').cost === 0.5 && E.correctionCost('elephamt', 'elephant').cost === 0.5, 'repeated-letter and keyboard fixes cost half');
  ok(E.correctionCost('dog', 'bog').allowed === false, 'no first-letter keyboard discount');
  ok(!E.match(idx.colors, 'fuschia', { noFuzzy: true }), 'noFuzzy skips the whole correction stage');
  const qm = E.match(idx.sports, 'womens socer');
  ok(qm && qm.qualifier === 'womens' && qm.entry.canon === 'Soccer' && qm.fix, 'qualified answers are corrected on the base word');
  ok(!E.match(idx.sports, 'mens womens socer'), 'no stacking, even with a correction');
}

// ---- must-accept: every category keeps these answers (listed or qualified, never via fuzzy)
const MUST_ACCEPT = {
  kitchen: ["spatula", "mandoline", "salad spinner", "mortar and pestle", "dutch oven", "zester", "sous vide", "tagine"],
  fruits: ["apple", "mangosteen", "rambutan", "cloudberry", "feijoa", "salak", "jabuticaba", "dried mango"],
  vegetables: ["carrot", "kohlrabi", "romanesco", "salsify", "celeriac", "okra", "fiddlehead", "baby carrots"],
  body: ["elbow", "philtrum", "clavicle", "uvula", "septum", "achilles tendon", "pinna", "hyoid"],
  clothing: ["jeans", "cardigan", "kimono", "sarong", "dashiki", "poncho", "cummerbund", "balaclava"],
  animals: ["dog", "okapi", "axolotl", "pangolin", "aye aye", "quokka", "narwhal", "fossa"],
  sports: ["soccer", "wheelchair basketball", "sitting volleyball", "goalball", "boccia", "sepak takraw", "kabaddi", "women's soccer"],
  colors: ["red", "chartreuse", "vermilion", "cerulean", "puce", "gamboge", "dark purple", "neon green"],
  jobs: ["teacher", "actuary", "farrier", "cooper", "chandler", "sommelier", "phlebotomist", "assistant manager"],
  beach: ["sand", "sandcastle", "lifeguard", "flip flops", "boogie board", "windbreak", "sea glass", "groyne"],
  bathroom: ["toilet", "loofah", "bidet", "plunger", "shower caddy", "bath mat", "pumice stone", "toothbrush holder"],
  office: ["stapler", "hole punch", "lanyard", "whiteboard", "rolodex", "paper shredder", "post it notes", "filing cabinet"],
  breakfast: ["pancakes", "eggs benedict", "shakshuka", "congee", "kedgeree", "granola", "huevos rancheros", "full english"],
  toolbox: ["hammer", "spirit level", "allen key", "stud finder", "hacksaw", "awl", "chisel", "tape measure"],
  africa: ["nigeria", "ivory coast", "eswatini", "swaziland", "cabo verde", "drc", "sao tome and principe"],
  europe: ["france", "czechia", "holland", "vatican", "north macedonia", "moldova", "liechtenstein"],
  asia: ["japan", "myanmar", "burma", "east timor", "kyrgyzstan", "uae", "bhutan"],
  usstates: ["texas", "new york", "rhode island", "mass", "north dakota", "wyoming", "hawaii"],
  islands: ["hawaii", "madagascar", "svalbard", "tristan da cunha", "lampedusa", "socotra", "skye", "bora bora"],
  languages: ["english", "swahili", "quechua", "basque", "tagalog", "yoruba", "wolof", "esperanto"],
  eurocities: ["paris", "bruges", "ljubljana", "tallinn", "porto", "graz", "bratislava", "split"],
  dogs: ["labrador", "basenji", "xoloitzcuintli", "vizsla", "puli", "saluki", "borzoi", "shiba inu"],
  birds: ["robin", "hoopoe", "shoebill", "kakapo", "lammergeier", "bee eater", "frigatebird", "oystercatcher"],
  sea: ["shark", "nudibranch", "sea cucumber", "anglerfish", "manatee", "narwhal", "cuttlefish", "sea pen"],
  flowers: ["rose", "protea", "hellebore", "edelweiss", "gardenia", "bird of paradise", "cosmos", "foxglove"],
  insects: ["ant", "mantis", "earwig", "lacewing", "cicada", "stick insect", "silverfish", "weta"],
  trees: ["oak", "baobab", "sequoia", "rowan", "hornbeam", "jacaranda", "ginkgo", "oak tree"],
  dinosaurs: ["t rex", "stegosaurus", "spinosaurus", "parasaurolophus", "therizinosaurus", "pachycephalosaurus", "microraptor", "carnotaurus"],
  instruments: ["piano", "theremin", "sitar", "didgeridoo", "hurdy gurdy", "kora", "erhu", "oud"],
  cars: ["ford", "toyota", "lamborghini", "koenigsegg", "pagani", "skoda", "lada", "rivian"],
  games: ["chess", "monopoly", "catan", "go", "mahjong", "pandemic", "carcassonne", "ticket to ride"],
  cheeses: ["cheddar", "brie", "roquefort", "manchego", "halloumi", "epoisses", "taleggio", "smoked gouda"],
  spices: ["cinnamon", "sumac", "saffron", "asafoetida", "grains of paradise", "fenugreek", "za'atar", "ground cumin"],
  desserts: ["cheesecake", "tiramisu", "baklava", "pavlova", "mochi", "cannoli", "eton mess", "chocolate mousse"],
  heroes: ["batman", "spider-man", "wonder woman", "black panther", "ms marvel", "moon knight", "squirrel girl", "hellboy"],
  elements: ["oxygen", "gold", "tungsten", "wolfram", "aluminium", "aluminum", "oganesson"],
  constellations: ["orion", "ursa major", "big dipper", "cassiopeia", "southern cross", "camelopardalis", "norma"],
  capitals: ["london", "ulaanbaatar", "ouagadougou", "thimphu", "canberra", "sacramento", "edinburgh", "kyoto"],
  mountains: ["everest", "kilimanjaro", "mt kenya", "denali", "aconcagua", "eiger", "matterhorn", "krakatoa"],
  painters: ["van gogh", "monet", "artemisia gentileschi", "caravaggio", "frida kahlo", "hokusai", "vermeer", "basquiat"],
  composers: ["mozart", "beethoven", "hildegard von bingen", "saint saens", "janacek", "satie", "sibelius", "purcell"],
  greekmyth: ["zeus", "athena", "persephone", "prometheus", "tiresias", "medusa", "atalanta", "chiron"],
  cracked: ["egg", "safe", "enigma code", "liberty bell", "geode", "knuckles", "cold case", "creme brulee"],
  wheels: ["car", "wheelchair", "penny farthing", "tuk tuk", "batmobile", "mars rover", "toy car", "electric scooter"],
  pairs: ["socks", "chopsticks", "salt and pepper", "romeo and juliet", "bonnie and clyde", "castor and pollux", "binary stars", "pocket aces"],
  keys: ["piano", "typewriter", "map", "florida", "concertina", "monkey", "janitor", "periodic table"],
  holes: ["swiss cheese", "donut", "colander", "golf course", "great blue hole", "pinhole camera", "honeycomb", "cenote"],
  scales: ["fish", "snake", "piano", "kettle", "pangolin", "limescale", "beaufort scale", "smaug"],
  fly: ["bird", "plane", "helicopter", "time", "sputnik", "spitfire", "hang glider", "frisbee"],
  icecream: ["vanilla", "chocolate", "pistachio", "mocha", "black sesame", "ube", "earl grey", "pumpkin spice"],
};
for (const c of CATS) ok(MUST_ACCEPT[c.id] && MUST_ACCEPT[c.id].length >= 5, c.id + ': has a must-accept list');
for (const [cat, list] of Object.entries(MUST_ACCEPT)) for (const input of list) {
  const m = E.match(idx[cat], input);
  ok(m && m.entry && m.via !== 'fuzzy', `${cat}: must accept "${input}"`);
}

// ---- must-reject: wrong answers, stacked or unknown qualifiers
const MUST_REJECT = {
  sports: ["pizza", "womens pizza", "indoor golfing", "mens womens soccer", "womens womens soccer", "youth pro soccer"],
  colors: ["dog", "dark dog", "light light blue", "pale neon pink"],
  jobs: ["pizza", "assistant senior manager"],
  fruits: ["potato", "dried dried apricot"],
  vegetables: ["banana", "chocolate"],
  spices: ["sugar", "ground beef"],
  dinosaurs: ["woolly mammoth", "dodo", "godzilla"],
  languages: ["klingon numbers", "french fries", "morse"],
  cars: ["mustang", "civic"],
  heroes: ["joker", "thanos", "lex luthor"],
  capitals: ["los angeles", "chicago", "manchester"],
  africa: ["dubai", "jamaica"],
  usstates: ["puerto rico", "ontario"],
  elements: ["unobtainium", "kryptonite", "water"],
  constellations: ["milky way", "andromeda galaxy"],
  greekmyth: ["thor", "odin", "anubis"],
  birds: ["bat", "pterodactyl"],
  trees: ["rose", "daisy"],
  insects: ["dolphin", "granite"],
  desserts: ["chocolate pizza", "mini mini cupcake"],
  cheeses: ["butter", "smoked aged cheddar"],
  keys: ["banana", "cheese"],
  fly: ["penguin", "ostrich", "kiwi bird"],
  icecream: ["gasoline", "cardboard"],
};
for (const [cat, list] of Object.entries(MUST_REJECT)) for (const input of list) {
  const m = E.match(idx[cat], input);
  ok(!m || !m.entry, `${cat}: must reject "${input}", got ${m && m.entry ? (m.qualifier ? m.qualifier + ' + ' : '') + m.entry.canon : ''}`);
}

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

// ---- dev mode: lap math and the password lock
{
  const dctx = { console, module: undefined, TextEncoder };
  dctx.globalThis = dctx;
  vm.createContext(dctx);
  for (const f of ['src/dev-lock.js', 'src/dev-core.js']) vm.runInContext(fs.readFileSync(path.join(dir, f), 'utf8'), dctx, { filename: f });
  const D = dctx.DA_DEV_CORE, LOCK = dctx.DA_DEV_LOCK;
  const S = E.CONFIG.startAlt, T = E.CONFIG.summitAlt, span = T - S;
  const lap = (t) => D.lapState(t, S, T);
  ok(span === 5989, 'lap span ' + span);
  ok(lap(0).lap === 1 && lap(0).alt === S, 'lap 1 starts at Lukla');
  ok(lap(span - 1).lap === 1 && lap(span - 1).alt === T - 1, 'just below the summit is still lap 1');
  ok(lap(span).lap === 2 && lap(span).alt === S, 'passing the summit wraps to Lukla on lap 2');
  ok(lap(span * 3 + 100).lap === 4 && lap(span * 3 + 100).alt === S + 100, 'lap 4, 100 m up');
  ok(lap(span * 3 + 100).total === span * 3 + 100, 'total climbed is uncapped');
  ok(lap(-50).lap === 1 && lap(-50).alt === S, 'negative totals clamp to Lukla');
  ok(D.timingSafeEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 3])) && !D.timingSafeEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 4])) && !D.timingSafeEqual(new Uint8Array([1, 2]), new Uint8Array([1, 2, 0])), 'constant-time compare');
  ok(LOCK && LOCK.iterations >= 310000 && D.b64ToBytes(LOCK.salt).length === 16 && D.b64ToBytes(LOCK.hash).length === 32, 'dev lock shape');
  const subtle = (await import('node:crypto')).webcrypto.subtle;
  ok(!(await D.verifyPassword('definitely-not-it', LOCK, subtle)), 'wrong dev password fails');
  const priv = path.join(dir, 'dev.local.mjs');
  if (fs.existsSync(priv)) {
    const { DEV_PASSWORD } = await import(new URL('file://' + priv).href);
    ok(await D.verifyPassword(DEV_PASSWORD, LOCK, subtle), 'dev password from dev.local.mjs matches src/dev-lock.js (run npm run dev-lock after changing it)');
  } else console.log('skip: no dev.local.mjs, so the right-password check is skipped');
  let threw = false;
  try { await D.verifyPassword('x', LOCK, undefined); } catch (e) { threw = true; }
  ok(threw, 'missing WebCrypto throws (the UI shows the https message)');
}

console.log(fails ? `\n${fails} FAILURES` : '\nALL TESTS PASSED');
process.exit(fails ? 1 : 0);
