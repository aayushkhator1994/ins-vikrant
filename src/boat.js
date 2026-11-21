// Runs a scout on its own Boat VM (boat.dev): create a sandbox, run the scout in it, stop it.
// The VM holds no keys. It clones the public repo, reads the brief and prints its claims.
const BASE = () => process.env.BOAT_API_BASE || 'https://boat.dev/api/v1';
const REPO = () => process.env.SCOUT_REPO_URL || 'https://github.com/aayushkhator1994/ins-vikrant';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function boatScouts() {
  if (!process.env.BOAT_API_KEY) return [];
  return (process.env.BOAT_SCOUTS || 'fundamentals').split(',').map((s) => s.trim()).filter(Boolean);
}

async function api(method, path, body, timeoutMs = 150000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(BASE() + path, {
      method, signal: ctrl.signal,
      headers: { Authorization: `Bearer ${process.env.BOAT_API_KEY}`, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    const json = await r.json().catch(() => ({}));
    return { status: r.status, ok: r.ok, json };
  } finally { clearTimeout(t); }
}

export async function createSandbox() {
  const r = await api('POST', '/sandboxes', { ttlSeconds: 900 });
  if (!r.ok || !r.json.sandbox) throw new Error(`boat create failed: ${r.status} ${r.json.code || r.json.message || ''}`);
  return r.json.sandbox.id;
}

export async function exec(id, command, timeoutSeconds = 180) {
  for (let attempt = 1; attempt <= 8; attempt++) {
    const r = await api('POST', `/sandboxes/${id}/commands`, { command, timeoutSeconds }, (timeoutSeconds + 70) * 1000);
    if (r.ok) return { exitCode: r.json.exitCode, stdout: r.json.stdout || '', stderr: r.json.stderr || '' };
    const retryable = r.json.code === 'sandbox_starting' || r.status === 503 || (r.status === 502 && r.json.message === 'sandbox_restoring');
    if (!retryable) throw new Error(`boat exec failed: ${r.status} ${r.json.code || ''} ${r.json.message || ''}`);
    await sleep(3000);
  }
  throw new Error('boat exec failed: sandbox never became ready');
}

export async function stopSandbox(id) {
  const r = await api('POST', `/sandboxes/${id}/stop`);
  return r.ok;
}

// Returns { claims, sandbox_id }. The stopped VM keeps its disk, which is the mission's evidence.
export async function runScoutOnBoat(kind, brief, log = () => {}) {
  const id = await createSandbox();
  log('boat_vm_created', `${kind} scout VM ${id} created on boat.dev`, { sandbox_id: id, scout: kind });
  try {
    const b64 = Buffer.from(JSON.stringify(brief)).toString('base64');
    const cmd = `rm -rf /tmp/iv && git clone -q --depth 1 ${REPO()} /tmp/iv && mkdir -p /tmp/iv/m && echo ${b64} | base64 -d > /tmp/iv/m/brief.json && cd /tmp/iv && node src/scout-worker.js ${kind} m`;
    const out = await exec(id, cmd);
    if (out.exitCode !== 0) throw new Error(`scout exited ${out.exitCode} on VM ${id}: ${out.stderr.slice(-200)}`);
    const last = out.stdout.trim().split('\n').pop();
    const parsed = JSON.parse(last);
    return { claims: parsed.claims || [], sandbox_id: id };
  } finally {
    const stopped = await stopSandbox(id).catch(() => false);
    log('boat_vm_stopped', `${kind} scout VM ${id} ${stopped ? 'stopped; its disk is kept as evidence' : 'could not be stopped, check the Boat dashboard'}`, { sandbox_id: id, scout: kind });
  }
}
