import fs from 'node:fs';
import path from 'node:path';
import { fetchSource } from './checker.js';

const UA =
  process.env.FETCH_USER_AGENT ||
  'INS-Vikrant-checker/0.1 (research; contact: ins-vikrant@users.noreply.github.com)';

const FOR_WORDS = ['up', 'rose', 'increase', 'increased', 'growth', 'grew', 'record', 'raise', 'raised', 'beat', 'strong', 'higher', 'expand', 'surge', 'accelerat'];
const AGAINST_WORDS = ['down', 'fell', 'decline', 'declined', 'decrease', 'lower', 'cut', 'miss', 'weak', 'slow', 'drop', 'loss', 'warn', 'risk', 'restrict', 'delay'];
const DEFAULT_FOCUS = ['revenue', 'guidance', 'data center', 'margin'];
const MAX_CLAIMS = 8;

// Short words match as whole words (plus common endings); longer ones match as prefixes.
function lexiconRegex(words) {
  const parts = words.map((w) => {
    if (w.length <= 3) return `${w}s?`;
    if (w.length === 4) return `${w}(?:s|es|ed|ing|er|ly|ped|ping)?`;
    return `${w}\\w*`;
  });
  return new RegExp(`\\b(?:${parts.join('|')})\\b`, 'gi');
}
const FOR_RE = lexiconRegex(FOR_WORDS);
const AGAINST_RE = lexiconRegex(AGAINST_WORDS);

export function classifySide(text) {
  const f = (text.match(FOR_RE) || []).length;
  const a = (text.match(AGAINST_RE) || []).length;
  if (f > a) return 'for';
  if (a > f) return 'against';
  return null;
}

const SCOUT_KINDS = ['fundamentals', 'news', 'readacross'];
const FIELDS = ['id', 'scout', 'side', 'claim', 'quote', 'source_url'];

export function validateClaim(c) {
  if (!c || typeof c !== 'object') return false;
  for (const f of FIELDS) {
    if (typeof c[f] !== 'string' || c[f].trim() === '') return false;
  }
  if (c.side !== 'for' && c.side !== 'against') return false;
  if (!SCOUT_KINDS.includes(c.scout)) return false;
  return true;
}

function focusOf(brief) {
  const f = Array.isArray(brief.focus) ? brief.focus.filter((x) => typeof x === 'string' && x.trim()) : [];
  return (f.length ? f : DEFAULT_FOCUS).map((x) => x.trim());
}

async function fetchJson(url, timeoutMs = 20000) {
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, Accept: 'application/json' },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

export async function resolveEdgarFiling(ticker) {
  const tickers = await fetchJson('https://www.sec.gov/files/company_tickers.json');
  const want = String(ticker).toUpperCase();
  const row = Object.values(tickers).find((r) => String(r.ticker).toUpperCase() === want);
  if (!row) throw new Error(`ticker ${want} not found in EDGAR`);
  const cik = String(row.cik_str);
  const sub = await fetchJson(`https://data.sec.gov/submissions/CIK${cik.padStart(10, '0')}.json`);
  const r = sub.filings && sub.filings.recent;
  if (!r || !Array.isArray(r.form)) throw new Error('no recent filings');
  for (let i = 0; i < r.form.length; i++) {
    if (r.form[i] === '10-Q' || r.form[i] === '10-K') {
      const acc = String(r.accessionNumber[i]).replace(/-/g, '');
      return `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${acc}/${r.primaryDocument[i]}`;
    }
  }
  throw new Error('no 10-Q or 10-K in recent filings');
}

function finish(scout, rows) {
  const out = [];
  for (const r of rows) {
    if (out.length >= MAX_CLAIMS) break;
    const c = { id: `${scout}-${out.length + 1}`, scout, side: r.side, claim: r.text, quote: r.text, source_url: r.source_url };
    if (validateClaim(c)) out.push(c);
  }
  return out;
}

async function fundamentals(brief) {
  const focus = focusOf(brief).map((f) => f.toLowerCase());
  const notes = [];
  let pages = Array.isArray(brief.sources) ? brief.sources.filter(Boolean) : [];
  if (!pages.length) {
    try {
      pages = [await resolveEdgarFiling(brief.ticker)];
    } catch (err) {
      notes.push(`edgar: ${err.message}`);
      pages = [];
    }
  }
  const candidates = [];
  const seen = new Set();
  for (const url of pages) {
    let src;
    try {
      src = await fetchSource(url);
    } catch (err) {
      src = { ok: false, status: 0, text: '' };
    }
    if (!src || !src.ok || !src.text) {
      notes.push(`unreachable: ${url} (status ${src ? src.status : 0})`);
      continue;
    }
    for (const raw of src.text.split(/(?<=[.!?])\s+/)) {
      const s = raw.trim();
      if (s.length < 50 || s.length > 300) continue;
      if (!/\d/.test(s)) continue;
      const low = s.toLowerCase();
      if (!focus.some((k) => low.includes(k))) continue;
      if (seen.has(low)) continue;
      seen.add(low);
      candidates.push({ text: s, side: classifySide(s), source_url: url });
    }
  }
  const strong = (c) => (/[%$]/.test(c.text) ? 0 : 1);
  const ranked = candidates.map((c, i) => ({ c, i })).sort((a, b) => strong(a.c) - strong(b.c) || a.i - b.i).map((x) => x.c);
  const claims = finish('fundamentals', ranked.filter((c) => c.side));
  if (process.env.MISSION_DIR) {
    try {
      const file = path.join(process.env.MISSION_DIR, 'evidence', 'fundamentals.json');
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify({ ticker: brief.ticker, fetched_at: new Date().toISOString(), sources: pages, notes, candidates: ranked }, null, 2));
    } catch {
      /* evidence is best effort */
    }
  }
  return claims;
}

function decodeEntities(s) {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
}

async function rssScout(scout, query) {
  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=en-US&gl=US&ceid=US:en`;
  let xml = '';
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(15000) });
    if (!res.ok) return [];
    xml = await res.text();
  } catch {
    return [];
  }
  const rows = [];
  const seen = new Set();
  for (const m of xml.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/g)) {
    const t = m[1].match(/<title\b[^>]*>([\s\S]*?)<\/title>/);
    if (!t) continue;
    let title = decodeEntities(t[1]).replace(/\s+/g, ' ').trim();
    title = title.replace(/\s+-\s+[^-]+$/, '').trim();
    if (!title || seen.has(title)) continue;
    seen.add(title);
    const side = classifySide(title);
    if (!side) continue;
    rows.push({ text: title, side, source_url: url });
  }
  return finish(scout, rows);
}

async function news(brief) {
  const company = brief.company || brief.ticker;
  return rssScout('news', `${company} earnings ${focusOf(brief).join(' ')} when:30d`);
}

async function readacross(brief) {
  const company = brief.company || brief.ticker;
  return rssScout('readacross', `${company} supplier OR customer OR competitor capex when:30d`);
}

const safe = (fn) => async (brief) => {
  try {
    return (await fn(brief)).filter(validateClaim);
  } catch {
    return [];
  }
};

export const SCOUTS = {
  fundamentals: safe(fundamentals),
  news: safe(news),
  readacross: safe(readacross),
};
