// INS Vikrant bridge: one small always-on HTTP server.
// Vapi calls POST /vapi/tools; humans read GET / (mission timeline) and GET /missions/:id (memo).
// Zero dependencies. runMission / missionStatus are injected (see bottom for the direct-run wiring).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';

const MAX_BODY = 100 * 1024; // 100 KB
const HARD_BODY = 1024 * 1024; // stop draining and drop the socket past this
const ID_RE = /^[a-z0-9.\-]{1,64}$/;
const TICKER_RE = /^[A-Za-z.]{1,6}$/;
const URL_RE = /https?:\/\/[^\s<>"'`]+/g;
const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '`': '&#96;' };

const esc = (v) => String(v ?? '').replace(/[&<>"'`]/g, (c) => ESC[c]);
// Path traversal guard: charset allows dots, so also refuse all-dot names ('.', '..').
const validId = (id) => typeof id === 'string' && ID_RE.test(id) && !/^\.+$/.test(id);

function text(v, max = 2000) {
  const s = typeof v === 'string' ? v : v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

// Make a string safe and pleasant to SPEAK: no URLs, single line, bounded.
function speak(v, max = 300) {
  const s = text(v, 4000)
    .replace(URL_RE, '')
    .replace(/\(\s*\)|\[\s*\]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return s.length > max ? `${s.slice(0, max).trim()}…` : s;
}

const sentence = (s) => (s && !/[.!?…]$/.test(s) ? `${s}.` : s);
const count = (v) => (Array.isArray(v) ? v.length : Number.isFinite(Number(v)) ? Number(v) : 0);

function readJson(file) {
  try {
    const v = JSON.parse(fs.readFileSync(file, 'utf8'));
    return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

function fmtTime(v) {
  if (v === undefined || v === null || v === '') return '';
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? text(v, 40) : `${d.toISOString().replace('T', ' ').slice(0, 19)}Z`;
}

// Mission directories on disk, newest first.
function listMissions(missionsDir) {
  let entries;
  try {
    entries = fs.readdirSync(missionsDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const d of entries) {
    if (!d.isDirectory() || !validId(d.name)) continue;
    const dir = path.join(missionsDir, d.name);
    let mtime = 0;
    for (const f of ['', 'events.jsonl', 'decision.json']) {
      try {
        mtime = Math.max(mtime, fs.statSync(path.join(dir, f)).mtimeMs);
      } catch {}
    }
    out.push({ id: d.name, dir, mtime });
  }
  return out.sort((a, b) => b.mtime - a.mtime || (a.id < b.id ? 1 : -1));
}

function readEvents(dir, limit = 200) {
  let raw;
  try {
    raw = fs.readFileSync(path.join(dir, 'events.jsonl'), 'utf8');
  } catch {
    return [];
  }
  const events = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line);
      if (e && typeof e === 'object') events.push(e);
    } catch {
      events.push({ ts: '', type: 'unparsed', msg: line });
    }
  }
  return events.slice(-limit);
}

function secretOk(given, expected) {
  if (typeof given !== 'string') return false;
  const a = Buffer.from(given, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Never buffers more than MAX_BODY. Resolves { text } or { tooLarge: true }.
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let over = false;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        over = true;
        chunks.length = 0;
        if (size > HARD_BODY) {
          resolve({ tooLarge: true, hard: true });
          req.removeAllListeners('data');
          req.pause();
        }
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(over ? { tooLarge: true } : { text: Buffer.concat(chunks).toString('utf8') }));
    req.on('error', reject);
  });
}

function send(res, status, type, body, extra = {}) {
  res.writeHead(status, {
    'Content-Type': type,
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
    ...extra,
  });
  res.end(body);
}
const json = (res, status, obj, extra) => send(res, status, 'application/json; charset=utf-8', JSON.stringify(obj), extra);
const html = (res, status, body) =>
  send(res, status, 'text/html; charset=utf-8', body, {
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'",
    'Referrer-Policy': 'no-referrer',
  });

const CSS = `
:root{color-scheme:dark}
body{margin:0;padding:24px;background:#0b0f14;color:#d7dde5;font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
main{max-width:860px;margin:0 auto}
h1{font-size:22px;margin:0 0 4px}h2{font-size:18px}h3{font-size:16px}
a{color:#7cc4ff;text-decoration:none}a:hover{text-decoration:underline}
.sub{color:#7d8896;margin:0 0 20px}
.card{background:#121821;border:1px solid #1f2933;border-radius:10px;padding:16px;margin:0 0 16px}
.card header{display:flex;gap:10px;align-items:center;flex-wrap:wrap}
.id{font-family:ui-monospace,Menlo,monospace}
.ticker{font-weight:700;color:#fff}
.badge{padding:2px 10px;border-radius:999px;font-size:12px;font-weight:700;text-transform:uppercase;background:#2a3441;color:#c5ced9}
.badge.good{background:#0f3d2a;color:#6ee7a8}.badge.bad{background:#4a1820;color:#ff9aa5}.badge.running{background:#3a3210;color:#ffd66b}
.q{margin:10px 0 4px}.meta{color:#7d8896;font-size:13px;margin:0 0 10px}
.events{list-style:none;margin:0;padding:0;border-top:1px solid #1f2933}
.events li{display:grid;grid-template-columns:170px 110px 1fr;gap:10px;padding:5px 0;border-bottom:1px solid #18202a;font-size:13px}
.events time{color:#7d8896;font-family:ui-monospace,Menlo,monospace}.events .type{color:#9fb3c8}
.events .msg{overflow-wrap:anywhere;white-space:pre-wrap}
.empty{color:#7d8896}
.memo{overflow-wrap:anywhere}
`;

const page = (title, body) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><style>${CSS}</style></head><body><main>${body}</main></body></html>`;

function verdictClass(v) {
  if (v === 'running') return 'running';
  if (/\b(sell|no|not|avoid|fail|bear\w*|short|reject)\b/i.test(v)) return 'bad';
  if (/\b(buy|go|yes|invest|bull\w*|proceed|long)\b/i.test(v)) return 'good';
  return 'neutral';
}

// Escape first, linkify only bare http(s) URLs (each fragment is escaped separately so entities never end up inside an href).
function inline(raw) {
  let out = '';
  let last = 0;
  for (const m of raw.matchAll(URL_RE)) {
    const url = m[0].replace(/[.,;:!?)\]]+$/, '');
    if (!url) continue;
    out += `${esc(raw.slice(last, m.index))}<a href="${esc(url)}" rel="noopener noreferrer">${esc(url)}</a>`;
    last = m.index + url.length;
  }
  return out + esc(raw.slice(last));
}

function renderMemo(md) {
  const out = [];
  let inList = false;
  const closeList = () => {
    if (inList) out.push('</ul>');
    inList = false;
  };
  for (const line of md.split(/\r?\n/)) {
    const li = /^\s*- (.*)$/.exec(line);
    if (li) {
      if (!inList) out.push('<ul>');
      inList = true;
      out.push(`<li>${inline(li[1])}</li>`);
      continue;
    }
    closeList();
    const h = /^(#{1,3}) (.*)$/.exec(line);
    if (h) out.push(`<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`);
    else if (line.trim()) out.push(`<p>${inline(line)}</p>`);
  }
  closeList();
  return out.join('\n');
}

export function createBridge({ missionsDir = 'missions', runMission, missionStatus, env = process.env } = {}) {
  const started = new Map(); // id -> start ts, for missions whose directory may not exist yet

  const dailyCap = () => {
    const n = Number.parseInt(env.DAILY_MISSION_CAP, 10);
    return Number.isFinite(n) && n >= 0 ? n : 20;
  };

  function takeDailySlot() {
    const file = path.join(missionsDir, '.daily.json');
    const today = new Date().toISOString().slice(0, 10); // UTC day
    const cur = readJson(file);
    const used = cur && cur.date === today && Number.isInteger(cur.count) && cur.count >= 0 ? cur.count : 0;
    if (used >= dailyCap()) return false;
    fs.mkdirSync(missionsDir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ date: today, count: used + 1 }));
    return true;
  }

  // Disk missions plus just-started ones that have not created their directory yet, newest first.
  function recent() {
    const all = listMissions(missionsDir);
    const seen = new Set(all.map((m) => m.id));
    for (const [id, ts] of started) if (!seen.has(id)) all.push({ id, dir: path.join(missionsDir, id), mtime: ts });
    return all.sort((a, b) => b.mtime - a.mtime);
  }

  function resolveId(arg) {
    const all = recent();
    if (arg === undefined || arg === null || String(arg).trim() === '') {
      return all.length ? { id: all[0].id, known: true } : { error: 'There are no missions yet.' };
    }
    const s = String(arg).trim().toLowerCase();
    if (!validId(s)) return { error: 'That mission id is not valid.' };
    if (all.some((m) => m.id === s)) return { id: s, known: true };
    const byTicker = all.find((m) => m.id.startsWith(`${s}-`)); // caller said just the ticker
    return byTicker ? { id: byTicker.id, known: true } : { id: s, known: false };
  }

  function diskStatus(id) {
    const dir = path.join(missionsDir, id);
    const d = readJson(path.join(dir, 'decision.json'));
    const events = readEvents(dir);
    if (d) return { id, state: 'done', verdict: d.verdict, claims_for: d.claims_for, claims_against: d.claims_against, last_event: events.at(-1), steps_done: [] };
    return { id, state: events.length || fs.existsSync(dir) ? 'running' : 'unknown', last_event: events.at(-1), steps_done: [] };
  }

  const tools = {
    async start_mission(args) {
      const ticker = typeof args.ticker === 'string' ? args.ticker.trim() : '';
      const question = typeof args.question === 'string' ? args.question.replace(/\s+/g, ' ').trim() : '';
      if (!TICKER_RE.test(ticker) || !/[A-Za-z]/.test(ticker)) return 'I need a valid stock ticker, one to six letters, to start a mission.';
      if (question.length < 5 || question.length > 400) return 'I need a research question between 5 and 400 characters to start a mission.';
      if (typeof runMission !== 'function') return 'The mission runner is not available right now.';
      const rawFocus = Array.isArray(args.focus) ? args.focus : typeof args.focus === 'string' ? args.focus.split(/[,;\n]/) : [];
      const focus = rawFocus.filter((f) => typeof f === 'string').map((f) => f.trim().slice(0, 200)).filter(Boolean).slice(0, 10);
      const company = typeof args.company === 'string' && args.company.trim() ? args.company.trim().slice(0, 120) : ticker.toUpperCase();
      if (!takeDailySlot()) return 'Daily mission cap reached. Try again tomorrow.';

      let ts = Date.now();
      let id = `${ticker.toLowerCase()}-${ts.toString(36)}`;
      while (started.has(id) || fs.existsSync(path.join(missionsDir, id))) id = `${ticker.toLowerCase()}-${(++ts).toString(36)}`;
      started.set(id, Date.now());
      try {
        // Deliberately not awaited: the call must return while the mission runs.
        Promise.resolve(runMission({ id, ticker: ticker.toUpperCase(), company, question, focus, missionsDir })).catch((err) =>
          console.error(`[bridge] mission ${id} failed:`, err),
        );
      } catch (err) {
        console.error(`[bridge] mission ${id} failed to start:`, err);
      }
      return `Mission ${id} started. I am researching: ${question}. I will push the verdict when it is ready.`;
    },

    async get_status(args) {
      const r = resolveId(args.mission_id);
      if (r.error) return r.error;
      const { id } = r;
      const st = (typeof missionStatus === 'function' ? await missionStatus(id, missionsDir) : diskStatus(id)) || {};
      if (st.state === 'done') {
        return `Mission ${id} is done. ${speak(st.verdict, 80) || 'No verdict'}: ${count(st.claims_for)} checked claims for, ${count(st.claims_against)} against.`;
      }
      if (st.state === 'running') {
        const ev = st.last_event;
        const last = speak(ev && typeof ev === 'object' ? ev.msg ?? ev.type : ev, 160);
        const steps = Array.isArray(st.steps_done) && st.steps_done.length ? ` ${st.steps_done.length} steps done.` : '';
        return `Mission ${id} is running.${steps}${last ? ` Latest: ${sentence(last)}` : ''}`;
      }
      return started.has(id) ? `Mission ${id} is starting.` : `I cannot find mission ${id}.`;
    },

    async why(args) {
      const r = resolveId(args.mission_id);
      if (r.error) return r.error;
      const { id } = r;
      const d = readJson(path.join(missionsDir, id, 'decision.json'));
      if (!d) return r.known ? `Mission ${id} has not finished yet, so there is no verdict to explain.` : `I cannot find mission ${id}.`;
      const reasons = (Array.isArray(d.reasons) ? d.reasons : [])
        .map((x) => speak(typeof x === 'string' ? x : x?.text ?? x?.reason ?? '', 220))
        .filter(Boolean)
        .slice(0, 3);
      const cp = speak(d.strongest_counterpoint, 260);
      let out = `Mission ${id} verdict: ${sentence(speak(d.verdict, 80) || 'none')}`;
      out += reasons.length ? ` Top reasons: ${reasons.map((x, i) => `${i + 1}, ${sentence(x)}`).join(' ')}` : ' No reasons were recorded.';
      if (cp) out += ` Strongest counterpoint: ${sentence(cp)}`;
      return out;
    },

    async stop_mission(args) {
      const r = resolveId(args.mission_id);
      if (r.error) return r.error === 'There are no missions yet.' ? 'There is no mission to stop.' : r.error;
      const { id } = r;
      if (!r.known) return `I cannot find mission ${id}.`;
      if (args.confirmed !== true) return `Say yes to confirm stopping mission ${id}.`;
      const dir = path.join(missionsDir, id);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'STOP'), `${new Date().toISOString()}\n`);
      return `Mission ${id} was stopped.`;
    },
  };

  async function handleTools(req, res) {
    const secret = env.BRIDGE_SECRET;
    if (typeof secret !== 'string' || secret.trim() === '') {
      req.resume();
      return json(res, 503, { error: 'bridge not configured: BRIDGE_SECRET is not set, refusing all tool calls' });
    }
    if (!secretOk(req.headers['x-vapi-secret'], secret)) {
      req.resume();
      return json(res, 401, { error: 'bad secret' });
    }
    const body = await readBody(req);
    if (body.tooLarge) {
      json(res, 400, { error: 'body too large' }, { Connection: 'close' });
      if (body.hard) req.destroy();
      return undefined;
    }
    let payload;
    try {
      payload = JSON.parse(body.text);
    } catch {
      return json(res, 400, { error: 'invalid JSON' });
    }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return json(res, 400, { error: 'invalid JSON' });
    const message = payload.message && typeof payload.message === 'object' ? payload.message : {};

    const allow = String(env.CALLER_ALLOWLIST ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    if (allow.length && !allow.includes(message.call?.customer?.number)) return json(res, 403, { error: 'caller not allowed' });

    const list = Array.isArray(message.toolCallList) ? message.toolCallList : Array.isArray(message.toolCalls) ? message.toolCalls : [];
    const results = [];
    for (const tc of list.slice(0, 20)) {
      if (!tc || typeof tc !== 'object') continue;
      const name = text(tc.function?.name ?? tc.name ?? '', 60);
      let args = tc.function?.arguments ?? tc.arguments ?? {};
      let result;
      if (typeof args === 'string') {
        try {
          args = args.trim() ? JSON.parse(args) : {};
        } catch {
          args = null;
        }
      }
      if (!args || typeof args !== 'object' || Array.isArray(args)) result = `I could not read the arguments for ${name}.`;
      else if (!Object.hasOwn(tools, name)) result = `Unknown tool ${name}.`;
      else {
        try {
          result = await tools[name](args);
        } catch (err) {
          console.error(`[bridge] tool ${name} failed:`, err);
          result = `Something went wrong running ${name}.`;
        }
      }
      results.push({ toolCallId: tc.id ?? null, result: String(result).replace(/\s+/g, ' ').trim() });
    }
    return json(res, 200, { results });
  }

  function timelinePage() {
    const cards = listMissions(missionsDir).slice(0, 100).map((m) => {
      const brief = readJson(path.join(m.dir, 'brief.json')) || {};
      const decision = readJson(path.join(m.dir, 'decision.json'));
      const stopped = fs.existsSync(path.join(m.dir, 'STOP'));
      let finished = '';
      if (decision) {
        try {
          finished = fmtTime(fs.statSync(path.join(m.dir, 'decision.json')).mtimeMs);
        } catch {}
      }
      const verdict = decision ? text(decision.verdict, 60) || 'done' : 'running';
      const tally = decision ? `${count(decision.claims_for)} for / ${count(decision.claims_against)} against` : '— for / — against';
      const href = `/missions/${encodeURIComponent(m.id)}`;
      const events = readEvents(m.dir)
        .map((e) => `<li><time>${esc(fmtTime(e.ts))}</time><span class="type">${esc(text(e.type, 60))}</span><span class="msg">${esc(text(e.msg))}</span></li>`)
        .join('');
      return `<article class="card"><header><a class="id" href="${esc(href)}">${esc(m.id)}</a><span class="ticker">${esc(text(brief.ticker, 12))}</span><span class="badge ${verdictClass(verdict)}">${esc(verdict)}</span>${stopped ? '<span class="badge bad">stop requested</span>' : ''}</header>
<p class="q">${esc(text(brief.question, 600))}</p>
<p class="meta">${esc(tally)} · ${finished ? `finished ${esc(finished)}` : 'not finished'} · <a href="${esc(href)}">memo</a></p>
${events ? `<ol class="events">${events}</ol>` : '<p class="empty">No events yet.</p>'}</article>`;
    });
    const title = 'INS Vikrant — mission timeline';
    return page(title, `<h1>${esc(title)}</h1><p class="sub">Research missions launched by a phone call. Newest first.</p>${cards.join('\n') || '<p class="empty">No missions yet.</p>'}`);
  }

  async function handle(req, res) {
    const pathname = String(req.url || '/').split('?')[0]; // raw path on purpose: no dot-segment normalisation
    const isGet = req.method === 'GET' || req.method === 'HEAD';
    if (pathname === '/vapi/tools' && req.method === 'POST') return handleTools(req, res);
    req.resume();
    if (isGet && pathname === '/healthz') return json(res, 200, { ok: true });
    if (isGet && (pathname === '/' || pathname === '/missions' || pathname === '/missions/')) return html(res, 200, timelinePage());
    if (isGet && pathname.startsWith('/missions/')) {
      let id = null;
      try {
        id = decodeURIComponent(pathname.slice('/missions/'.length));
      } catch {}
      if (!validId(id)) return json(res, 400, { error: 'bad mission id' });
      let md;
      try {
        md = fs.readFileSync(path.join(missionsDir, id, 'memo.md'), 'utf8');
      } catch {
        return json(res, 404, { error: 'memo not found' });
      }
      return html(res, 200, page(`${id} — INS Vikrant memo`, `<p><a href="/missions">← mission timeline</a></p><div class="card memo">${renderMemo(md)}</div>`));
    }
    return json(res, 404, { error: 'not found' });
  }

  return http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      console.error('[bridge] request failed:', err);
      if (!res.headersSent) json(res, 500, { error: 'internal error' });
      else res.destroy();
    });
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { runMission, missionStatus } = await import('./mission.js');
  const port = Number(process.env.PORT) || 8787;
  if (!process.env.BRIDGE_SECRET) console.warn('[bridge] BRIDGE_SECRET is not set: every /vapi/tools call will be refused with 503.');
  createBridge({ runMission, missionStatus }).listen(port, () => {
    console.log(`INS Vikrant bridge listening on http://localhost:${port}`);
  });
}
