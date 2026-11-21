import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createBridge } from '../src/bridge.js';

const SECRET = 'test-secret-123';

async function boot(t, envExtra = {}, { withSecret = true } = {}) {
  const missionsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vikrant-bridge-'));
  const calls = [];
  const statuses = new Map();
  const followUps = [];
  const followUp = { reply: null }; // null = no model key
  const env = { ...(withSecret ? { BRIDGE_SECRET: SECRET } : {}), ...envExtra };
  const server = createBridge({
    missionsDir,
    env,
    runMission: async (args) => {
      calls.push(args);
      return { verdict: 'BUY' };
    },
    missionStatus: (id) => statuses.get(id) ?? { id, state: 'unknown', last_event: null, steps_done: [] },
    answerFollowUp: async (input) => {
      followUps.push(input);
      if (typeof followUp.reply === 'function') return followUp.reply(input);
      return followUp.reply;
    },
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
    fs.rmSync(missionsDir, { recursive: true, force: true });
  });
  return { port: server.address().port, missionsDir, calls, statuses, followUps, followUp };
}

// Raw http.request so paths like /missions/../../etc/passwd are sent un-normalised.
function request(port, { method = 'GET', path: p = '/', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: p, method, headers, agent: false }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        let parsed = null;
        try {
          parsed = JSON.parse(data);
        } catch {}
        resolve({ status: res.statusCode, headers: res.headers, body: data, json: parsed });
      });
    });
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

function toolBody(name, args, { number = '+15550001111', id = 'tc_1', alias = false } = {}) {
  const list = [{ id, function: { name, arguments: args } }];
  return JSON.stringify({
    message: { type: 'tool-calls', call: { customer: { number } }, ...(alias ? { toolCalls: list } : { toolCallList: list }) },
  });
}

function callTool(port, name, args, opts = {}) {
  return request(port, {
    method: 'POST',
    path: '/vapi/tools',
    headers: { 'content-type': 'application/json', 'x-vapi-secret': opts.secret ?? SECRET },
    body: opts.rawBody ?? toolBody(name, args, opts),
  });
}

const START = { ticker: 'NVDA', company: 'Nvidia', question: 'Is data center demand durable?', focus: 'margins, supply' };

function plantMission(missionsDir, id, files = {}) {
  const dir = path.join(missionsDir, id);
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), typeof content === 'string' ? content : JSON.stringify(content));
  }
  return dir;
}

test('missing BRIDGE_SECRET -> 503, never runs open', async (t) => {
  const { port, calls } = await boot(t, {}, { withSecret: false });
  const res = await callTool(port, 'start_mission', START);
  assert.equal(res.status, 503);
  assert.match(res.json.error, /BRIDGE_SECRET/);
  assert.equal(calls.length, 0);
});

test('wrong or absent secret -> 401', async (t) => {
  const { port, calls } = await boot(t);
  const wrong = await callTool(port, 'start_mission', START, { secret: 'nope' });
  assert.equal(wrong.status, 401);
  assert.deepEqual(wrong.json, { error: 'bad secret' });
  const sameLength = await callTool(port, 'start_mission', START, { secret: 'x'.repeat(SECRET.length) });
  assert.equal(sameLength.status, 401);
  const none = await request(port, { method: 'POST', path: '/vapi/tools', body: toolBody('start_mission', START) });
  assert.equal(none.status, 401);
  assert.equal(calls.length, 0);
});

test('caller not on allowlist -> 403; listed caller passes', async (t) => {
  const { port, calls } = await boot(t, { CALLER_ALLOWLIST: '+15550001111, +15550002222' });
  const stranger = await callTool(port, 'start_mission', START, { number: '+19998887777' });
  assert.equal(stranger.status, 403);
  assert.deepEqual(stranger.json, { error: 'caller not allowed' });
  assert.equal(calls.length, 0);
  const friend = await callTool(port, 'start_mission', START, { number: '+15550002222' });
  assert.equal(friend.status, 200);
  assert.equal(calls.length, 1);
});

test('valid start_mission -> 200, result names the mission id, runMission called once', async (t) => {
  const { port, calls, missionsDir } = await boot(t);
  const res = await callTool(port, 'start_mission', START);
  assert.equal(res.status, 200);
  assert.equal(res.headers['x-content-type-options'], 'nosniff');
  assert.match(res.headers['content-type'], /application\/json/);
  assert.equal(res.json.results.length, 1);
  assert.equal(res.json.results[0].toolCallId, 'tc_1');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].ticker, 'NVDA');
  assert.equal(calls[0].company, 'Nvidia');
  assert.equal(calls[0].question, START.question);
  assert.deepEqual(calls[0].focus, ['margins', 'supply']);
  assert.equal(calls[0].missionsDir, missionsDir);
  assert.match(calls[0].id, /^nvda-[a-z0-9]+$/);
  assert.ok(res.json.results[0].result.includes(`Mission ${calls[0].id} started`));
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(missionsDir, '.daily.json'), 'utf8')).count, 1);
});

test('arguments as a JSON string, and message.toolCalls alias, both work', async (t) => {
  const { port, calls } = await boot(t);
  const res = await callTool(port, 'start_mission', JSON.stringify({ ...START, ticker: 'AAPL', focus: ['services'] }), { alias: true });
  assert.equal(res.status, 200);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].ticker, 'AAPL');
  assert.deepEqual(calls[0].focus, ['services']);
  assert.match(res.json.results[0].result, /Mission aapl-[a-z0-9]+ started/);
});

test('start_mission validation explains what is missing', async (t) => {
  const { port, calls } = await boot(t);
  const badTicker = await callTool(port, 'start_mission', { ticker: '../etc', question: 'Is this fine to ask?' });
  assert.match(badTicker.json.results[0].result, /ticker/i);
  const noQuestion = await callTool(port, 'start_mission', { ticker: 'NVDA', question: 'hm' });
  assert.match(noQuestion.json.results[0].result, /question/i);
  assert.equal(calls.length, 0);
});

test('daily cap of 1 -> second start refused', async (t) => {
  const { port, calls } = await boot(t, { DAILY_MISSION_CAP: '1' });
  const first = await callTool(port, 'start_mission', START);
  assert.match(first.json.results[0].result, /started/);
  const second = await callTool(port, 'start_mission', { ...START, ticker: 'AMD' });
  assert.equal(second.status, 200);
  assert.equal(second.json.results[0].result, 'Daily mission cap reached. Try again tomorrow.');
  assert.equal(calls.length, 1);
});

test('stop_mission asks for a yes, then writes STOP when confirmed', async (t) => {
  const { port, missionsDir } = await boot(t);
  const dir = plantMission(missionsDir, 'nvda-abc123', { 'brief.json': { id: 'nvda-abc123', ticker: 'NVDA', question: 'q?' } });
  const ask = await callTool(port, 'stop_mission', {});
  assert.equal(ask.json.results[0].result, 'Say yes to confirm stopping mission nvda-abc123.');
  assert.equal(fs.existsSync(path.join(dir, 'STOP')), false);
  const stringy = await callTool(port, 'stop_mission', { mission_id: 'nvda-abc123', confirmed: 'true' });
  assert.match(stringy.json.results[0].result, /Say yes to confirm/);
  assert.equal(fs.existsSync(path.join(dir, 'STOP')), false);
  const done = await callTool(port, 'stop_mission', { mission_id: 'nvda-abc123', confirmed: true });
  assert.match(done.json.results[0].result, /nvda-abc123 was stopped/);
  assert.equal(fs.existsSync(path.join(dir, 'STOP')), true);
  const traversal = await callTool(port, 'stop_mission', { mission_id: '../../tmp/x', confirmed: true });
  assert.match(traversal.json.results[0].result, /not valid/);
});

test('get_status and why speak the verdict without URLs; unknown tool is named', async (t) => {
  const { port, missionsDir, statuses } = await boot(t);
  plantMission(missionsDir, 'nvda-abc123', {
    'decision.json': {
      verdict: 'BUY',
      claims_for: 7,
      claims_against: 2,
      reasons: ['Revenue grew 60 percent (https://example.com/10k).', 'Backlog is rising https://example.com/b'],
      strongest_counterpoint: 'Customer concentration is high, see https://example.com/risk',
    },
  });
  statuses.set('nvda-abc123', { id: 'nvda-abc123', state: 'done', verdict: 'BUY', claims_for: 7, claims_against: 2, steps_done: [] });
  const status = await callTool(port, 'get_status', {});
  assert.ok(status.json.results[0].result.includes('BUY: 7 checked claims for, 2 against.'));
  const why = await callTool(port, 'why', { mission_id: 'nvda-abc123' });
  const spoken = why.json.results[0].result;
  assert.match(spoken, /Revenue grew 60 percent/);
  assert.match(spoken, /Customer concentration is high/);
  assert.doesNotMatch(spoken, /https?:/);

  plantMission(missionsDir, 'amd-zzz999', {});
  const early = await callTool(port, 'why', { mission_id: 'amd-zzz999' });
  assert.match(early.json.results[0].result, /amd-zzz999 is still running/);
  assert.doesNotMatch(early.json.results[0].result, /no verdict to explain/);
  const unknown = await callTool(port, 'launch_missiles', {});
  assert.equal(unknown.json.results[0].result, 'Unknown tool launch_missiles.');
});

test('invalid JSON and oversized bodies -> 400', async (t) => {
  const { port } = await boot(t);
  const bad = await callTool(port, null, null, { rawBody: '{not json' });
  assert.equal(bad.status, 400);
  const big = await callTool(port, null, null, { rawBody: JSON.stringify({ message: { pad: 'x'.repeat(150 * 1024) } }) });
  assert.equal(big.status, 400);
});

test('GET /missions escapes markup planted on disk', async (t) => {
  const { port, missionsDir } = await boot(t);
  plantMission(missionsDir, 'aapl-xss001', {
    'brief.json': { id: 'aapl-xss001', ticker: 'AAPL', company: 'Apple', question: '<img src=x onerror=alert(2)> is it durable?' },
    'events.jsonl': `${JSON.stringify({ ts: '2025-01-01T00:00:00Z', type: 'scrape', msg: '<script>alert(1)</script>' })}\nnot json <b>bold</b>\n`,
    'decision.json': { verdict: '"><script>alert(3)</script>', claims_for: 3, claims_against: 1, reasons: [] },
  });
  for (const p of ['/missions', '/']) {
    const res = await request(port, { path: p });
    assert.equal(res.status, 200);
    assert.match(res.headers['content-type'], /text\/html/);
    assert.equal(res.headers['x-content-type-options'], 'nosniff');
    assert.ok(res.body.includes('INS Vikrant — mission timeline'));
    assert.ok(res.body.includes('aapl-xss001'));
    assert.ok(res.body.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
    assert.ok(res.body.includes('3 for / 1 against'));
    assert.ok(!/<script/i.test(res.body), 'no script tag may reach the page');
    assert.ok(!/<img/i.test(res.body), 'no img tag may reach the page');
    assert.ok(!res.body.includes('<b>bold</b>'));
  }
});

test('GET /missions/:id renders the memo, 404 when missing, traversal ids rejected', async (t) => {
  const { port, missionsDir } = await boot(t);
  plantMission(missionsDir, 'nvda-abc123', {
    'memo.md': '# Verdict <script>x</script>\n## Reasons\n- Strong demand https://example.com/a?b=1&c=2.\nPlain "text"\n',
  });
  const memo = await request(port, { path: '/missions/nvda-abc123' });
  assert.equal(memo.status, 200);
  assert.ok(memo.body.includes('<h1>Verdict &lt;script&gt;x&lt;/script&gt;</h1>'));
  assert.ok(memo.body.includes('<h2>Reasons</h2>'));
  assert.ok(memo.body.includes('<li>Strong demand <a href="https://example.com/a?b=1&amp;c=2" rel="noopener noreferrer">'));
  assert.ok(!/<script/i.test(memo.body));

  assert.equal((await request(port, { path: '/missions/nvda-nope' })).status, 404);
  for (const p of ['/missions/../../etc/passwd', '/missions/%2e%2e%2f%2e%2e%2fetc%2fpasswd', '/missions/..', '/missions/%2e%2e', '/missions/NVDA_1']) {
    const res = await request(port, { path: p });
    assert.equal(res.status, 400, `${p} must be rejected`);
    assert.ok(!res.body.includes('root:'));
  }
});

test('healthz ok, everything else 404', async (t) => {
  const { port } = await boot(t);
  const ok = await request(port, { path: '/healthz' });
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.json, { ok: true });
  assert.equal((await request(port, { path: '/nope' })).status, 404);
  assert.equal((await request(port, { path: '/vapi/tools' })).status, 404);
});

const ANALYSED = {
  mission_id: 'amd-abc123',
  question: "What are the key risks in AMD's latest earnings?",
  thesis: "AMD's results are strong and the risks are limited.",
  verdict: 'Supports',
  claims_for: 5,
  claims_against: 2,
  reasons: ['For [news-1]: "Data center revenue nearly doubles" https://example.com/a'],
  strongest_counterpoint: '[news-3] "Margin guidance cut" https://example.com/c',
  analysis: {
    answer: 'The verdict is Supports. Most checked claims show strong results, with two pointing to risks.',
    reasons_for: [
      { id: 'news-1', reason: 'Data center revenue nearly doubled in the quarter.' },
      { id: 'news-2', reason: 'Revenue guidance came in above estimates.' },
    ],
    reasons_against: [{ id: 'news-3', reason: 'Gross margin guidance was cut, see https://example.com/c' }],
    bottom_line: 'Two more checked claims against would move it to Mixed.',
    model: 'fake-model',
    provider: 'Fake',
  },
};
const FINDINGS = {
  claims: [
    { id: 'news-1', scout: 'news', side: 'for', claim: 'Data center revenue nearly doubles', quote: 'q', source_url: 'https://example.com/a', check: 'passed' },
    { id: 'news-3', scout: 'news', side: 'against', claim: 'Margin guidance cut', quote: 'q', source_url: 'https://example.com/c', check: 'passed' },
    { id: 'news-4', scout: 'news', side: 'for', claim: 'Earnings date announced', quote: 'q', source_url: 'https://example.com/d', check: 'passed', relevance: 'irrelevant' },
    { id: 'news-5', scout: 'news', side: 'for', claim: 'Made-up number', quote: 'q', source_url: 'https://example.com/e', check: 'quote_not_found' },
  ],
  stats: { total: 4, passed: 3, rejected: 1 },
};

test('why with a model analysis speaks reasons for AND against, no URLs or claim ids', async (t) => {
  const { port, missionsDir } = await boot(t);
  plantMission(missionsDir, 'amd-abc123', { 'decision.json': ANALYSED });
  const why = await callTool(port, 'why', { mission_id: 'amd-abc123' });
  const spoken = why.json.results[0].result;
  assert.ok(spoken.startsWith('Mission amd-abc123: Supports, 5 checked claims for and 2 against.'));
  assert.match(spoken, /Supporting it: Data center revenue nearly doubled in the quarter; Revenue guidance came in above estimates\./);
  assert.match(spoken, /Against it: Gross margin guidance was cut/);
  assert.match(spoken, /Two more checked claims against would move it to Mixed\./);
  assert.doesNotMatch(spoken, /https?:/);
  assert.doesNotMatch(spoken, /news-\d/);

  // No against reasons: the caller still hears that nothing cuts against it.
  plantMission(missionsDir, 'amd-noagainst', { 'decision.json': { ...ANALYSED, analysis: { ...ANALYSED.analysis, reasons_against: [] } } });
  const one = await callTool(port, 'why', { mission_id: 'amd-noagainst' });
  assert.match(one.json.results[0].result, /Against it: nothing in the checked claims cuts against it\./);
});

test('why without an analysis still names the strongest claim on each side', async (t) => {
  const { port, missionsDir } = await boot(t);
  const { analysis, ...plain } = ANALYSED;
  plantMission(missionsDir, 'amd-plain01', {
    'decision.json': { ...plain, bull: { points: [{ id: 'news-1', claim: 'Data center revenue nearly doubles' }] }, bear: { points: [{ id: 'news-3', claim: 'Margin guidance cut' }] } },
  });
  const spoken = (await callTool(port, 'why', { mission_id: 'amd-plain01' })).json.results[0].result;
  assert.match(spoken, /Top reasons:/);
  assert.match(spoken, /Strongest claim for: Data center revenue nearly doubles\./);
  assert.match(spoken, /Strongest claim against: Margin guidance cut\./);
  assert.doesNotMatch(spoken, /https?:/);
});

test('ask passes the question and checked, relevant claims to answerFollowUp and speaks its text', async (t) => {
  const { port, missionsDir, followUps, followUp } = await boot(t);
  plantMission(missionsDir, 'amd-abc123', { 'decision.json': ANALYSED, 'findings.json': FINDINGS });
  followUp.reply = { text: 'I do not make that call. For: revenue nearly doubled.\nAgainst: margin guidance was cut, see https://example.com/c', model: 'fake-model', provider: 'Fake' };
  const res = await callTool(port, 'ask', { mission_id: 'amd-abc123', question: 'Should I invest in AMD?' });
  assert.equal(res.json.results[0].result, 'I do not make that call. For: revenue nearly doubled. Against: margin guidance was cut, see');
  assert.equal(followUps.length, 1);
  assert.equal(followUps[0].question, 'Should I invest in AMD?');
  assert.equal(followUps[0].decision.verdict, 'Supports');
  assert.equal(followUps[0].dropped, 1);
  assert.deepEqual(followUps[0].claims, [
    { id: 'news-1', side: 'for', claim: 'Data center revenue nearly doubles' },
    { id: 'news-3', side: 'against', claim: 'Margin guidance cut' },
  ]);
});

test('ask falls back to the why text when answerFollowUp fails, has no key, throws, or no question is given', async (t) => {
  const { port, missionsDir, followUps, followUp } = await boot(t);
  plantMission(missionsDir, 'amd-abc123', { 'decision.json': ANALYSED, 'findings.json': FINDINGS });
  const why = (await callTool(port, 'why', { mission_id: 'amd-abc123' })).json.results[0].result;
  const replies = [{ error: 'model timed out' }, null, () => { throw new Error('boom'); }, { text: '   ' }];
  for (const reply of replies) {
    followUp.reply = reply;
    const res = await callTool(port, 'ask', { mission_id: 'amd-abc123', question: 'What about margins?' });
    assert.equal(res.json.results[0].result, why);
    assert.doesNotMatch(res.json.results[0].result, /went wrong|cannot answer|can't answer/i);
  }
  assert.equal(followUps.length, replies.length);
  followUp.reply = { text: 'should not be used' };
  for (const args of [{ mission_id: 'amd-abc123' }, { mission_id: 'amd-abc123', question: '  ' }]) {
    const res = await callTool(port, 'ask', args);
    assert.equal(res.json.results[0].result, why);
  }
  assert.equal(followUps.length, replies.length);
});

test('ask and why on an unfinished mission say it is still running, with the latest event', async (t) => {
  const { port, missionsDir, followUps, followUp } = await boot(t);
  plantMission(missionsDir, 'amd-run001', {
    'events.jsonl': `${JSON.stringify({ ts: '2025-01-01T00:00:00Z', type: 'scout_done', msg: 'news scout returned 8 claims https://example.com/x' })}\n`,
  });
  followUp.reply = { text: 'should not be used' };
  for (const [name, args] of [['why', { mission_id: 'amd-run001' }], ['ask', { mission_id: 'amd-run001', question: 'Why?' }]]) {
    const spoken = (await callTool(port, name, args)).json.results[0].result;
    assert.match(spoken, /Mission amd-run001 is still running/);
    assert.match(spoken, /Latest: news scout returned 8 claims\./);
    assert.doesNotMatch(spoken, /https?:/);
  }
  assert.equal(followUps.length, 0);
  const missing = await callTool(port, 'ask', { mission_id: 'amd-nope', question: 'Why?' });
  assert.equal(missing.json.results[0].result, 'I cannot find mission amd-nope.');
});
