import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runStep, logEvent, readJson, writeJson } from '../src/store.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'vikrant-store-'));

test('runStep runs fn once, then returns the recorded result', async () => {
  const dir = tmp();
  let calls = 0;
  const fn = async () => {
    calls++;
    return { value: 42 };
  };
  const first = await runStep(dir, 'alpha', fn);
  const second = await runStep(dir, 'alpha', fn);
  assert.deepEqual(first, { value: 42 });
  assert.deepEqual(second, { value: 42 });
  assert.equal(calls, 1);
  const rec = readJson(path.join(dir, 'steps', 'alpha.json'));
  assert.equal(rec.status, 'done');
  assert.equal(rec.step, 'alpha');
  assert.equal(rec.attempts, 1);
  assert.ok(rec.started_at && rec.finished_at);
});

test('force re-runs a finished step', async () => {
  const dir = tmp();
  let calls = 0;
  const fn = () => ++calls;
  await runStep(dir, 'beta', fn);
  const again = await runStep(dir, 'beta', fn, { force: true });
  assert.equal(again, 2);
  assert.equal(readJson(path.join(dir, 'steps', 'beta.json')).attempts, 2);
});

test('a failed step is recorded and re-runs with attempts incremented', async () => {
  const dir = tmp();
  let calls = 0;
  const fn = async () => {
    calls++;
    if (calls === 1) throw new Error('scout lost');
    return 'ok';
  };
  await assert.rejects(() => runStep(dir, 'gamma', fn), /scout lost/);
  const failed = readJson(path.join(dir, 'steps', 'gamma.json'));
  assert.equal(failed.status, 'failed');
  assert.equal(failed.error, 'scout lost');
  assert.equal(failed.attempts, 1);
  const result = await runStep(dir, 'gamma', fn);
  assert.equal(result, 'ok');
  assert.equal(calls, 2);
  const done = readJson(path.join(dir, 'steps', 'gamma.json'));
  assert.equal(done.status, 'done');
  assert.equal(done.attempts, 2);
  assert.equal(done.result, 'ok');
});

test('logEvent appends JSON lines; writeJson/readJson round-trip', () => {
  const dir = path.join(tmp(), 'nested', 'mission');
  logEvent(dir, 'one', 'first', { n: 1 });
  logEvent(dir, 'two', 'second');
  const lines = fs.readFileSync(path.join(dir, 'events.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(lines.length, 2);
  assert.equal(lines[0].type, 'one');
  assert.equal(lines[0].n, 1);
  assert.equal(lines[1].msg, 'second');
  assert.ok(!Number.isNaN(Date.parse(lines[0].ts)));
  const p = path.join(dir, 'deep', 'x.json');
  writeJson(p, { a: [1, 2] });
  assert.deepEqual(readJson(p), { a: [1, 2] });
  assert.equal(readJson(path.join(dir, 'missing.json'), 'fb'), 'fb');
  assert.deepEqual(fs.readdirSync(path.dirname(p)), ['x.json']);
});
