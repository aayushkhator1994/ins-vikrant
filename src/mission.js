import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { runStep, logEvent, readJson, writeJson } from './store.js';
import { checkClaims } from './checker.js';
import { validateClaim } from './scouts.js';
import { debate, rule } from './debate.js';

const WORKER = fileURLToPath(new URL('./scout-worker.js', import.meta.url));
const KINDS = ['fundamentals', 'news', 'readacross'];
const SCOUT_TIMEOUT_MS = 90000;
const MAX_RETRIES = 2;

function spawnScout(kind, dir, { env = {}, killAfterMs = null, onKill = null } = {}) {
  return new Promise((resolve) => {
    const childEnv = { ...process.env, ...env, MISSION_DIR: dir };
    delete childEnv.MISSION_VERBOSE;
    let child;
    try {
      child = spawn(process.execPath, [WORKER, kind, dir], { env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      resolve({ ok: false, reason: `spawn failed: ${err.message}` });
      return;
    }
    let out = '';
    let errOut = '';
    let timedOut = false;
    let settled = false;
    const done = (r) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(killer);
      resolve({ pid: child.pid, ...r });
    };
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (errOut += d));
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, SCOUT_TIMEOUT_MS);
    const killer =
      killAfterMs != null
        ? setTimeout(() => {
            if (onKill) onKill(child.pid);
            child.kill('SIGKILL');
          }, killAfterMs)
        : null;
    child.on('error', (err) => done({ ok: false, reason: `spawn error: ${err.message}` }));
    child.on('close', (code, signal) => {
      if (timedOut) return done({ ok: false, reason: `timed out after ${SCOUT_TIMEOUT_MS}ms` });
      if (signal) return done({ ok: false, reason: `process killed (${signal})` });
      if (code !== 0) return done({ ok: false, reason: `exit code ${code}: ${errOut.trim().slice(-200)}` });
      try {
        const last = out.trim().split('\n').pop();
        const parsed = JSON.parse(last);
        if (!parsed || !Array.isArray(parsed.claims)) throw new Error('no claims array');
        done({ ok: true, claims: parsed.claims });
      } catch (err) {
        done({ ok: false, reason: `bad output: ${err.message}` });
      }
    });
  });
}

async function runScout(kind, dir, killScout) {
  const lostReasons = [];
  let killed = false;
  for (let attempt = 1; attempt <= MAX_RETRIES + 1; attempt++) {
    const opts = {};
    if (attempt > 1) {
      logEvent(dir, 'scout_relaunched', `${kind} scout relaunched in a fresh process (attempt ${attempt})`, { scout: kind, attempt });
    } else {
      logEvent(dir, 'scout_started', `${kind} scout launched in its own process`, { scout: kind, attempt });
    }
    if (killScout === kind && attempt === 1) {
      killed = true;
      opts.env = { SCOUT_DELAY_MS: '3000' };
      opts.killAfterMs = 500;
      opts.onKill = (pid) => logEvent(dir, 'scout_killed', `${kind} scout machine deleted mid-mission (SIGKILL pid ${pid})`, { scout: kind, pid });
    }
    const r = await spawnScout(kind, dir, opts);
    if (r.ok) {
      const claims = r.claims.filter(validateClaim);
      logEvent(dir, 'scout_done', `${kind} scout returned ${claims.length} claims`, { scout: kind, attempt, claims: claims.length });
      return { scout: kind, claims, lost: false, attempts: attempt, killed, lost_reasons: lostReasons };
    }
    lostReasons.push(r.reason);
    logEvent(dir, 'scout_lost', `${kind} scout lost: ${r.reason}`, { scout: kind, attempt, reason: r.reason });
  }
  logEvent(dir, 'scout_abandoned', `${kind} scout gave up after ${MAX_RETRIES + 1} attempts; mission continues without it`, { scout: kind });
  return { scout: kind, claims: [], lost: true, attempts: MAX_RETRIES + 1, killed, lost_reasons: lostReasons };
}

function buildMemo(brief, decision, stats, scouts) {
  const L = [];
  const dropped = decision.dropped_claims.length;
  L.push(`# INS Vikrant: ${brief.company} (${brief.ticker})`, '');
  L.push(`**Question:** ${brief.question}`, '');
  L.push(`**Verdict:** ${decision.verdict}`, '');
  L.push(`${decision.claims_for} claims for, ${decision.claims_against} against (${dropped} dropped by the checker)`, '');
  L.push('## Top reasons', '');
  for (const r of decision.reasons) {
    const m = r.match(/^(.*)\s(https?:\/\/\S+)$/s);
    L.push(m ? `- ${m[1]} ([source](${m[2]}))` : `- ${r}`);
  }
  L.push('', '## Strongest counterpoint', '');
  const cm = decision.strongest_counterpoint.match(/^(.*)\s(https?:\/\/\S+)$/s);
  L.push(cm ? `${cm[1]} ([source](${cm[2]}))` : decision.strongest_counterpoint);
  L.push('', '## What would change the verdict', '', decision.would_change_mind);
  L.push('', '## Bull', '', decision.bull.argument, '', `**Rebuttal:** ${decision.bull.rebuttal}`);
  L.push('', '## Bear', '', decision.bear.argument, '', `**Rebuttal:** ${decision.bear.rebuttal}`);
  L.push('', '## Dropped by the evidence checker', '');
  if (!dropped) L.push('- None.');
  for (const c of decision.dropped_claims) L.push(`- [${c.id}] ${c.claim} (${c.check}; [source](${c.source_url}))`);
  L.push('', '## Scouts', '');
  for (const s of scouts) {
    let note = `- ${s.scout}: ${s.claims.length} claims`;
    if (s.lost) note += `, LOST after ${s.attempts} attempts (${s.lost_reasons.join('; ')}); mission finished without it`;
    else if (s.attempts > 1) note += `, lost ${s.attempts - 1} time${s.attempts > 2 ? 's' : ''} (${s.lost_reasons.join('; ')}) and relaunched; finished on attempt ${s.attempts}`;
    L.push(note);
  }
  if (stats) L.push('', `Checker: ${stats.total} claims in, ${stats.passed} passed, ${stats.rejected} rejected.`);
  L.push('', '---', '', `_${decision.disclaimer}_`, '');
  return L.join('\n');
}

export async function runMission({ id, ticker, company, question, focus = [], sources = [], killScout = null, missionsDir = 'missions' } = {}) {
  if (!ticker) throw new Error('ticker is required');
  ticker = String(ticker).toUpperCase();
  id = id || `${ticker.toLowerCase()}-${Date.now().toString(36)}`;
  company = company || ticker;
  question = question || `Do ${company}'s latest results support the story?`;
  const dir = path.join(missionsDir, id);
  fs.mkdirSync(dir, { recursive: true });

  const step = async (name, fn) => {
    const prev = readJson(path.join(dir, 'steps', `${name}.json`));
    if (prev && prev.status === 'done') {
      logEvent(dir, 'step_resumed', `${name}: already recorded, skipped`, { step: name });
      return prev.result;
    }
    logEvent(dir, 'step_started', name, { step: name });
    try {
      const result = await runStep(dir, name, fn);
      logEvent(dir, 'step_done', name, { step: name });
      return result;
    } catch (err) {
      logEvent(dir, 'step_failed', `${name}: ${err.message}`, { step: name });
      throw err;
    }
  };

  logEvent(dir, 'mission_started', `${ticker}: ${question}`, { mission_id: id });

  const brief = await step('brief', async () => {
    const b = { id, ticker, company, question, focus, sources };
    writeJson(path.join(dir, 'brief.json'), b);
    return b;
  });

  const scouts = await Promise.all(KINDS.map((kind) => step(`scout-${kind}`, () => runScout(kind, dir, killScout))));

  const checked = await step('check', async () => {
    const all = scouts.flatMap((s) => s.claims).filter(validateClaim);
    const res = await checkClaims(all);
    writeJson(path.join(dir, 'findings.json'), { claims: [...res.passed, ...res.dropped], stats: res.stats });
    logEvent(dir, 'checked', `${res.stats.passed} of ${res.stats.total} claims passed the evidence check`, { stats: res.stats });
    return res;
  });

  const debated = await step('debate', async () => debate(checked.passed, brief));

  const decision = await step('verdict', async () => {
    const d = rule(checked.passed, checked.dropped, brief, debated);
    writeJson(path.join(dir, 'decision.json'), d);
    logEvent(dir, 'verdict', `${d.verdict}: ${d.claims_for} for, ${d.claims_against} against`, { verdict: d.verdict });
    return d;
  });

  await step('memo', async () => {
    const file = path.join(dir, 'memo.md');
    fs.writeFileSync(file, buildMemo(brief, decision, checked.stats, scouts));
    return { path: file };
  });

  await step('veto', async () => {
    const file = path.join(path.dirname(path.resolve(missionsDir)), 'veto', `${ticker}.json`);
    const prev = readJson(file);
    const claims = checked.passed.map((c) => c.claim);
    const prevClaims = new Set(prev && Array.isArray(prev.claims) ? prev.claims : []);
    const evidence = readJson(path.join(dir, 'evidence', 'fundamentals.json'));
    const filings = new Set(evidence && Array.isArray(evidence.sources) ? evidence.sources : []);
    for (const c of [...checked.passed, ...checked.dropped]) if (c.scout === 'fundamentals') filings.add(c.source_url);
    const veto = {
      ticker,
      mission_id: id,
      verdict: decision.verdict,
      claims_for: decision.claims_for,
      claims_against: decision.claims_against,
      verdict_changed: prev && prev.verdict ? prev.verdict !== decision.verdict : false,
      changed_claims: claims.filter((c) => !prevClaims.has(c)),
      claims,
      new_filings: [...filings],
      next_earnings_date: null,
      updated_at: new Date().toISOString(),
    };
    writeJson(file, veto);
    return { path: file, verdict_changed: veto.verdict_changed };
  });

  await step('push', async () => {
    const topic = process.env.NTFY_TOPIC;
    if (!topic) {
      logEvent(dir, 'push_skipped', 'NTFY_TOPIC not set');
      return { pushed: false };
    }
    try {
      const res = await fetch(`${process.env.NTFY_SERVER || 'https://ntfy.sh'}/${topic}`, {
        method: 'POST',
        headers: { Title: 'INS Vikrant' },
        body: `${ticker} check: ${decision.verdict}, ${decision.claims_for} claims for, ${decision.claims_against} against.`,
        signal: AbortSignal.timeout(10000),
      });
      logEvent(dir, res.ok ? 'push_sent' : 'push_failed', `ntfy responded ${res.status}`);
      return { pushed: res.ok, status: res.status };
    } catch (err) {
      logEvent(dir, 'push_failed', `ntfy error: ${err.message}`);
      return { pushed: false, error: err.message };
    }
  });

  logEvent(dir, 'mission_done', `${ticker}: ${decision.verdict}`, { mission_id: id, verdict: decision.verdict });
  return decision;
}

export function missionStatus(id, missionsDir = 'missions') {
  const dir = path.join(missionsDir, id);
  if (!fs.existsSync(dir)) return { id, state: 'unknown', last_event: null, steps_done: [] };
  let last_event = null;
  try {
    const lines = fs.readFileSync(path.join(dir, 'events.jsonl'), 'utf8').trim().split('\n');
    last_event = JSON.parse(lines[lines.length - 1]);
  } catch {
    /* no events yet */
  }
  const steps_done = [];
  try {
    for (const f of fs.readdirSync(path.join(dir, 'steps'))) {
      if (!f.endsWith('.json')) continue;
      const s = readJson(path.join(dir, 'steps', f));
      if (s && s.status === 'done') steps_done.push(s.step);
    }
  } catch {
    /* no steps yet */
  }
  const status = { id, state: steps_done.includes('push') ? 'done' : 'running', last_event, steps_done };
  const decision = readJson(path.join(dir, 'decision.json'));
  if (decision) {
    status.verdict = decision.verdict;
    status.claims_for = decision.claims_for;
    status.claims_against = decision.claims_against;
  }
  return status;
}

function parseArgs(argv) {
  const o = { focus: [], sources: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const v = () => argv[++i];
    if (a === '--ticker') o.ticker = v();
    else if (a === '--company') o.company = v();
    else if (a === '--question') o.question = v();
    else if (a === '--focus') o.focus = String(v() || '').split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--source') o.sources.push(v());
    else if (a === '--kill-scout') o.killScout = v();
    else if (a === '--id') o.id = v();
    else if (a === '--missions-dir') o.missionsDir = v();
  }
  return o;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = parseArgs(process.argv.slice(2));
  if (!args.ticker) {
    console.error('usage: node src/mission.js --ticker NVDA [--company NVIDIA] [--question "..."] [--focus "a,b"] [--source <url>]... [--kill-scout news] [--id <id>]');
    process.exit(2);
  }
  process.env.MISSION_VERBOSE = '1';
  runMission(args)
    .then((d) => {
      const dropped = d.dropped_claims.length;
      console.log(`\nMemo: ${path.join(args.missionsDir || 'missions', d.mission_id, 'memo.md')}`);
      console.log(`${d.ticker}: ${d.verdict}, ${d.claims_for} claims for, ${d.claims_against} against (${dropped} dropped by the checker).`);
      process.exit(0);
    })
    .catch((err) => {
      console.error(`Mission failed: ${(err && err.stack) || err}`);
      process.exit(1);
    });
}
