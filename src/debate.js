const DEFAULT_FOCUS = ['revenue', 'guidance', 'data center', 'margin'];
const DISCLAIMER = 'Research only. Not investment advice; no buy or sell recommendation.';
const EMPTY = 'No checked claims on this side.';

function focusOf(brief) {
  const f = brief && Array.isArray(brief.focus) ? brief.focus.filter(Boolean) : [];
  return (f.length ? f : DEFAULT_FOCUS).map((x) => String(x).toLowerCase());
}

function score(c, focus) {
  const text = `${c.claim} ${c.quote}`.toLowerCase();
  let s = 0;
  if (c.scout === 'fundamentals') s += 2;
  if (/\d/.test(text)) s += 1;
  if (focus.some((k) => text.includes(k))) s += 1;
  return s;
}

function rank(claims, focus) {
  return claims
    .map((c, i) => ({ c, i, s: score(c, focus) }))
    .sort((a, b) => b.s - a.s || a.i - b.i)
    .map((x) => x.c);
}

const words = (s) => new Set(String(s).toLowerCase().match(/[a-z0-9]{4,}/g) || []);

function bestAnswer(own, target) {
  if (!own.length) return null;
  const tw = words(target.quote);
  let best = own[0];
  let bestN = 0;
  for (const c of own) {
    let n = 0;
    for (const w of words(c.quote)) if (tw.has(w)) n++;
    if (n > bestN) {
      best = c;
      bestN = n;
    }
  }
  return best;
}

const cite = (c) => `[${c.id}] "${c.quote}"`;

function side(name, other, own, theirs, stance) {
  const argument = own.length
    ? `${name} (${stance}) rests on ${own.length} checked claim${own.length === 1 ? '' : 's'}: ${own.slice(0, 3).map(cite).join('; ')}`
    : EMPTY;
  let rebuttal;
  if (!theirs.length) {
    rebuttal = `${other} has no checked claims to answer.`;
  } else if (!own.length) {
    rebuttal = `${other}'s strongest claim is ${cite(theirs[0])}. ${name} has no checked claim to answer it.`;
  } else {
    rebuttal = `${other}'s strongest claim is ${cite(theirs[0])}. ${name} answers with ${cite(bestAnswer(own, theirs[0]))}.`;
  }
  return { argument, points: own, rebuttal };
}

export function debate(passedClaims, brief) {
  const focus = focusOf(brief);
  const claims = Array.isArray(passedClaims) ? passedClaims : [];
  const bull = rank(claims.filter((c) => c.side === 'for'), focus);
  const bear = rank(claims.filter((c) => c.side === 'against'), focus);
  return {
    bull: side('Bull', 'Bear', bull, bear, 'the evidence supports the story'),
    bear: side('Bear', 'Bull', bear, bull, 'the evidence cuts against the story'),
  };
}

export function rule(passedClaims, dropped, brief, debateResult) {
  const claims = Array.isArray(passedClaims) ? passedClaims : [];
  const d = debateResult || debate(claims, brief);
  const f = claims.filter((c) => c.side === 'for').length;
  const a = claims.filter((c) => c.side === 'against').length;
  let verdict = 'Mixed';
  if (f + a > 0) {
    if (f >= 2 * a && f > a) verdict = 'Supports';
    else if (a >= 2 * f && a > f) verdict = 'Contradicts';
  }
  const bull = d.bull.points;
  const bear = d.bear.points;
  const reason = (c) => `${c.side === 'for' ? 'For' : 'Against'} [${c.id}]: "${c.quote}" ${c.source_url}`;

  let reasons;
  let counter;
  if (f + a === 0) {
    reasons = ['No claims survived the evidence check.'];
    counter = null;
  } else if (verdict === 'Supports') {
    reasons = bull.slice(0, 3).map(reason);
    counter = bear[0] || null;
  } else if (verdict === 'Contradicts') {
    reasons = bear.slice(0, 3).map(reason);
    counter = bull[0] || null;
  } else {
    const major = f >= a ? bull : bear;
    const minor = f >= a ? bear : bull;
    reasons = [major[0], minor[0], major[1], minor[1]].filter(Boolean).slice(0, 3).map(reason);
    counter = minor[0] || null;
  }

  const focus = focusOf(brief).join(', ');
  let would;
  if (f + a === 0) {
    would = `Any checked claim would move this: a quote on ${focus} that can be found word for word in a primary filing or a dated headline.`;
  } else if (verdict === 'Supports') {
    const need = Math.floor(f / 2) + 1 - a;
    would = `Supports holds while claims for are at least double claims against (${f} vs ${a}). ${need} more checked claim${need === 1 ? '' : 's'} against (for example a cut or decline in ${focus}) would move it to Mixed.`;
  } else if (verdict === 'Contradicts') {
    const need = Math.floor(a / 2) + 1 - f;
    would = `Contradicts holds while claims against are at least double claims for (${a} vs ${f}). ${need} more checked claim${need === 1 ? '' : 's'} for (for example a raise or record in ${focus}) would move it to Mixed.`;
  } else {
    const toSupport = Math.max(2 * a, a + 1) - f;
    const toContra = Math.max(2 * f, f + 1) - a;
    would = `Mixed at ${f} for and ${a} against. ${toSupport} more checked claim${toSupport === 1 ? '' : 's'} for would move it to Supports; ${toContra} more against would move it to Contradicts.`;
  }

  return {
    mission_id: brief.id,
    ticker: brief.ticker,
    question: brief.question,
    verdict,
    claims_for: f,
    claims_against: a,
    reasons,
    strongest_counterpoint: counter
      ? `[${counter.id}] "${counter.quote}" ${counter.source_url}`
      : 'No checked claim on the other side.',
    would_change_mind: would,
    dropped_claims: (dropped || []).map((c) => ({ id: c.id, scout: c.scout, claim: c.claim, source_url: c.source_url, check: c.check })),
    bull: d.bull,
    bear: d.bear,
    disclaimer: DISCLAIMER,
    finished_at: new Date().toISOString(),
  };
}
