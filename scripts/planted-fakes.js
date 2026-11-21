// LIVE measurement: plant 10 fake claims against real pages and count how many
// the plain-code checker rejects. Uses the real network.
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { fetchSource, checkClaims, normalize } from '../src/checker.js';

const DEFAULT_URLS = [
  'https://en.wikipedia.org/wiki/Nvidia',
  'https://en.wikipedia.org/wiki/The_Home_Depot',
  'https://www.sec.gov/about/what-we-do',
  'https://en.wikipedia.org/wiki/Form_10-K',
  'https://en.wikipedia.org/wiki/Earnings_call',
];
const urls = process.env.FAKES_URLS
  ? process.env.FAKES_URLS.split(',').map((s) => s.trim()).filter(Boolean)
  : DEFAULT_URLS;

const INVENTED = [
  'Data center revenue fell 41% sequentially as hyperscale customers paused all orders.',
  'The board approved a special dividend of $14.75 per share payable to holders in March.',
  'Comparable store sales declined 23.6% after the company closed 312 locations in the quarter.',
  'Management lowered full-year guidance to $8.2 billion citing a 55% drop in backlog.',
  'The auditor issued a going concern warning after cash reserves dropped to $19 million.',
  'Operating margin collapsed to 3.1% as inventory write-downs reached $2,940 million.',
  'The company restated 2019 earnings downward by 38% following an internal review.',
  'Gross margin compressed 1,150 basis points as the firm absorbed $670 million in tariffs.',
  'Free cash flow turned negative at $4.4 billion on a 61% rise in capital spending.',
  'Shares outstanding rose 27% after the firm issued 480 million new shares at a discount.',
];
const FAKES_TOTAL = 10;
const CONTROLS_PER_PAGE = 2;
const CONTROLS_MAX = 10;

const host = (u) => { try { return new URL(u).host; } catch { return u; } };

function suitableSentences(text) {
  return text
    .replace(/\s+/g, ' ')
    .split('. ')
    .map((s) => s.trim())
    .filter((s) => s.length >= 60 && s.length <= 240 && /\d/.test(s) && !/[\[^]/.test(s));
}

function mutateFirstNumber(sentence, pageNorm) {
  for (let add = 7; add <= 70; add += 7) {
    const mutated = sentence.replace(/\d+/, (d) => String(Number(d) + add));
    if (mutated !== sentence && !pageNorm.includes(normalize(mutated))) return mutated;
  }
  return null;
}

// 1. Fetch pages (keep them so the check below does not refetch).
const pages = new Map();
const reachable = [];
for (const url of urls) {
  const res = await fetchSource(url);
  pages.set(url, res);
  if (res.ok && res.text) {
    reachable.push(url);
    console.log(`fetched  ${url} (status ${res.status}, ${res.text.length} chars)`);
  } else {
    console.log(`SKIPPED  ${url} (unreachable, status ${res.status})`);
  }
}
const targets = reachable.length ? reachable : urls;

// 2. Controls: real sentences, should pass.
const claims = [];
const kinds = new Map();
const perPage = new Map();
const controls = [];
for (const url of reachable) {
  const picked = suitableSentences(pages.get(url).text).slice(0, CONTROLS_PER_PAGE);
  perPage.set(url, picked);
  for (const s of picked) {
    if (controls.length >= CONTROLS_MAX) break;
    controls.push({ url, sentence: s });
  }
}
controls.forEach((c, i) => {
  const id = `control-${i + 1}`;
  kinds.set(id, 'control');
  claims.push({ id, scout: 'planted-fakes', side: 'for', claim: c.sentence, quote: c.sentence, source_url: c.url });
});

// 3. Planted fakes: 5 number-mutated real sentences + invented ones to reach 10.
const mutated = [];
const maxDepth = Math.max(0, ...[...perPage.values()].map((v) => v.length));
for (let depth = 0; depth < maxDepth && mutated.length < 5; depth++) {
  for (const url of reachable) {
    if (mutated.length >= 5) break;
    const s = perPage.get(url)[depth];
    if (!s) continue;
    const m = mutateFirstNumber(s, normalize(pages.get(url).text));
    if (m) mutated.push({ url, sentence: m });
  }
}
const inventedCount = FAKES_TOTAL - mutated.length;
for (let i = 0; i < inventedCount; i++) {
  const id = `fake-invented-${i + 1}`;
  kinds.set(id, 'fake-invented');
  const q = INVENTED[i % INVENTED.length];
  claims.push({ id, scout: 'planted-fakes', side: 'for', claim: q, quote: q, source_url: targets[i % targets.length] });
}
mutated.forEach((m, i) => {
  const id = `fake-mutated-${i + 1}`;
  kinds.set(id, 'fake-mutated');
  claims.push({ id, scout: 'planted-fakes', side: 'for', claim: m.sentence, quote: m.sentence, source_url: m.url });
});

// 4. Run through the checker (reuse already-fetched pages; one fetch per URL).
const result = await checkClaims(claims, {
  fetchSource: async (url) => pages.get(url) ?? fetchSource(url),
});
const byId = new Map([...result.passed, ...result.dropped].map((r) => [r.id, r]));
const rows = claims.map((c) => ({
  id: c.id,
  kind: kinds.get(c.id),
  url: c.source_url,
  host: host(c.source_url),
  check: byId.get(c.id).check,
  quote: c.quote,
}));

const pad = (s, n) => String(s).padEnd(n);
console.log('');
console.log(`${pad('id', 18)}${pad('kind', 15)}${pad('host', 20)}check`);
console.log('-'.repeat(72));
for (const r of rows) console.log(`${pad(r.id, 18)}${pad(r.kind, 15)}${pad(r.host, 20)}${r.check}`);

const fakeRows = rows.filter((r) => r.kind !== 'control');
const controlRows = rows.filter((r) => r.kind === 'control');
const fakesCaught = fakeRows.filter((r) => r.check !== 'passed').length;
const controlsPassed = controlRows.filter((r) => r.check === 'passed').length;

console.log('');
console.log(`Planted fakes caught: ${fakesCaught} of ${fakeRows.length}`);
console.log(`Controls passed: ${controlsPassed} of ${controlRows.length}`);

const outPath = join(dirname(fileURLToPath(import.meta.url)), 'planted-fakes.result.json');
await writeFile(
  outPath,
  JSON.stringify(
    {
      ran_at: new Date().toISOString(),
      urls: reachable,
      urls_skipped: urls.filter((u) => !reachable.includes(u)),
      fakes_caught: fakesCaught,
      fakes_total: fakeRows.length,
      controls_passed: controlsPassed,
      controls_total: controlRows.length,
      rows,
    },
    null,
    2,
  ) + '\n',
);

process.exit(fakesCaught === fakeRows.length ? 0 : 1);
