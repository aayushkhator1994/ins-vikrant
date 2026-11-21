import fs from 'node:fs';
import path from 'node:path';

export function readJson(p, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return fallback;
  }
}

export function writeJson(p, obj) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n');
  fs.renameSync(tmp, p);
}

export function logEvent(missionDir, type, msg, extra = {}) {
  const ev = { ts: new Date().toISOString(), type, msg, ...extra };
  fs.mkdirSync(missionDir, { recursive: true });
  fs.appendFileSync(path.join(missionDir, 'events.jsonl'), JSON.stringify(ev) + '\n');
  if (process.env.MISSION_VERBOSE === '1') {
    console.log(`[${ev.ts.slice(11, 19)}] ${type.padEnd(16)} ${msg}`);
  }
  return ev;
}

export async function runStep(missionDir, name, fn, { force = false } = {}) {
  const file = path.join(missionDir, 'steps', `${name}.json`);
  const prev = readJson(file);
  if (prev && prev.status === 'done' && !force) return prev.result;
  const attempts = ((prev && prev.attempts) || 0) + 1;
  const started_at = new Date().toISOString();
  try {
    const result = await fn();
    writeJson(file, {
      step: name,
      status: 'done',
      attempts,
      started_at,
      finished_at: new Date().toISOString(),
      result: result === undefined ? null : result,
    });
    return result;
  } catch (err) {
    writeJson(file, {
      step: name,
      status: 'failed',
      attempts,
      started_at,
      finished_at: new Date().toISOString(),
      error: String((err && err.message) || err),
    });
    throw err;
  }
}
