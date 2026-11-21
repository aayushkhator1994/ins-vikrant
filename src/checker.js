// Citation checker: plain code, no model. Drops claims whose quoted evidence
// is not really on the cited page.

const DEFAULT_UA =
  'INS-Vikrant-checker/0.1 (research; contact: ins-vikrant@users.noreply.github.com)';
const FETCH_TIMEOUT_MS = 15000;
const MIN_QUOTE_LEN = 12;

export function normalize(s) {
  return String(s ?? '')
    .toLowerCase()
    .replace(/[\u2018\u2019\u201A\u201B\u2032]/g, "'")
    .replace(/[\u201C\u201D\u201E\u201F\u2033]/g, '"')
    .replace(/[\u2010\u2011\u2012\u2013\u2014\u2015\u2212]/g, '-')
    .replace(/[\u00A0\u2007\u202F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const NAMED_ENTITIES = {
  lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  mdash: '\u2014', ndash: '\u2013', lsquo: '\u2018', rsquo: '\u2019',
  ldquo: '\u201C', rdquo: '\u201D', hellip: '\u2026',
};

function codePoint(n) {
  if (!Number.isFinite(n) || n < 0 || n > 0x10ffff) return ' ';
  if (n === 160) return ' ';
  try { return String.fromCodePoint(n); } catch { return ' '; }
}

function decodeEntities(s) {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => codePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => codePoint(parseInt(d, 10)))
    .replace(/&([a-z]+);/gi, (m, name) => {
      const k = name.toLowerCase();
      return k !== 'amp' && k in NAMED_ENTITIES ? NAMED_ENTITIES[k] : m;
    })
    .replace(/&amp;/gi, '&');
}

export function htmlToText(html) {
  const input = String(html ?? '');
  if (!input.includes('<')) return input;
  const stripped = input
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, ' $1 ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<[^>]*>/g, ' ');
  return decodeEntities(stripped).replace(/\s+/g, ' ').trim();
}

export function extractNumbers(s) {
  const matches =
    String(s ?? '').match(/\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?/g) || [];
  return matches.map((m) => String(Number(m.replace(/,/g, ''))));
}

export function markdownToText(md) {
  return String(md ?? '')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^[ \t]*\|?[ \t]*:?-{3,}:?[ \t]*(?:\|[ \t]*:?-{3,}:?[ \t]*)*\|?[ \t]*$/gm, ' ')
    .replace(/^[ \t]*#{1,6}[ \t]+/gm, '')
    .replace(/^[ \t]*(?:>[ \t]?)+/gm, '')
    .replace(/^[ \t]*(?:[-+*]|\d+\.)[ \t]+/gm, '')
    .replace(/~~/g, '')
    .replace(/[*`]/g, '')
    .replace(/\|/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

async function fetchDirect(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        'User-Agent': process.env.FETCH_USER_AGENT || DEFAULT_UA,
        Accept: '*/*',
      },
    });
    const body = await res.text();
    return { ok: res.ok, status: res.status, text: htmlToText(body), via: 'direct' };
  } catch {
    return { ok: false, status: 0, text: '', via: 'direct' };
  } finally {
    clearTimeout(timer);
  }
}

const CONTEXT_DEV_URL = 'https://api.context.dev/v1/web/scrape';
const CONTEXT_DEV_TIMEOUT_MS = 30000;
const FEED_OR_API_RE = /\/rss|\.xml(\?|$)|\.json(\?|$)|news\.google\.com/i;

async function fetchContextDev(url, key) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CONTEXT_DEV_TIMEOUT_MS);
  try {
    const res = await fetch(CONTEXT_DEV_URL, {
      method: 'POST',
      signal: controller.signal,
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, formats: { markdown: true } }),
    });
    if (!res.ok) return null;
    const json = await res.json();
    const md = json?.markdown?.data;
    if (typeof md !== 'string') return null;
    const text = markdownToText(md);
    if (!text) return null;
    return { ok: true, status: 200, text, via: 'context.dev' };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchSource(url) {
  try {
    const key = process.env.CONTEXT_DEV_API_KEY;
    if (key && !FEED_OR_API_RE.test(String(url))) {
      const scraped = await fetchContextDev(url, key);
      if (scraped) return scraped;
    }
    return await fetchDirect(url);
  } catch {
    return { ok: false, status: 0, text: '', via: 'direct' };
  }
}

function isHttpUrl(u) {
  if (typeof u !== 'string' || !u) return false;
  try {
    const p = new URL(u);
    return p.protocol === 'http:' || p.protocol === 'https:';
  } catch {
    return false;
  }
}

const directCache = new Map();
function directOnce(url) {
  if (!directCache.has(url)) directCache.set(url, fetchDirect(url).catch(() => null));
  return directCache.get(url);
}

export async function checkClaim(claim, { fetchSource: fetcher = fetchSource } = {}) {
  let via;
  const done = (check) => (via ? { ...claim, check, fetched_via: via } : { ...claim, check });
  const url = claim?.source_url;
  if (!isHttpUrl(url)) return done('source_unreachable');

  let page;
  try {
    page = await fetcher(url);
  } catch {
    return done('source_unreachable');
  }
  if (page && typeof page.via === 'string' && page.via) via = page.via;
  if (!page || !page.ok) return done('source_unreachable');

  const quote = normalize(claim.quote);
  if (quote.length < MIN_QUOTE_LEN) return done('quote_not_found');
  if (!normalize(page.text).includes(quote)) {
    const raw = via === 'context.dev' ? await directOnce(url) : null;
    if (!raw || !raw.ok || !normalize(raw.text).includes(quote)) return done('quote_not_found');
    via = 'direct';
  }

  const quoteNumbers = new Set(extractNumbers(claim.quote));
  for (const n of extractNumbers(claim.claim)) {
    if (!quoteNumbers.has(n)) return done('number_not_in_quote');
  }
  return done('passed');
}

export async function checkClaims(claims, opts = {}) {
  const list = Array.isArray(claims) ? claims : [];
  const fetcher = opts.fetchSource || fetchSource;
  const cache = new Map();
  const cachedFetcher = (url) => {
    if (!cache.has(url)) {
      cache.set(url, Promise.resolve().then(() => fetcher(url)));
    }
    return cache.get(url);
  };

  const results = await Promise.all(
    list.map((c) => checkClaim(c, { ...opts, fetchSource: cachedFetcher })),
  );

  const passed = results.filter((r) => r.check === 'passed');
  const dropped = results.filter((r) => r.check !== 'passed');
  const total = results.length;
  return {
    passed,
    dropped,
    stats: {
      total,
      passed: passed.length,
      rejected: dropped.length,
      rejected_share: total === 0 ? 0 : Math.round((dropped.length / total) * 1000) / 1000,
    },
  };
}
