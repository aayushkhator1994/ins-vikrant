// One model call for the captain's briefing. Uses New York Token Exchange when NYTE_API_KEY is set,
// otherwise Anthropic when ANTHROPIC_API_KEY is set. Returns null with no key. Never throws.

const CHAT_TIMEOUT_MS = 45000;
let anthropicModel = null;

async function post(url, headers, body) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CHAT_TIMEOUT_MS);
  try {
    const res = await fetch(url, { method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json', ...headers }, body: body && JSON.stringify(body), signal: controller.signal });
    const json = await res.json().catch(() => ({}));
    return res.ok ? { json } : { error: `HTTP ${res.status} ${json?.error?.message || ''}`.trim().slice(0, 200) };
  } catch (err) {
    const msg = err && err.name === 'AbortError' ? `timed out after ${CHAT_TIMEOUT_MS}ms` : String((err && err.message) || err);
    return { error: msg.slice(0, 200) };
  } finally {
    clearTimeout(timer);
  }
}

async function chatAnthropic(messages, key, { max_tokens }) {
  const headers = { 'x-api-key': key, 'anthropic-version': '2023-06-01' };
  let model = process.env.ANTHROPIC_MODEL || anthropicModel;
  if (!model) {
    const list = await post('https://api.anthropic.com/v1/models?limit=50', headers);
    if (list.error) return { error: `listing models: ${list.error}` };
    const ids = (list.json.data || []).map((m) => m.id);
    model = ids.find((id) => id.includes('haiku')) || ids.find((id) => id.includes('sonnet')) || ids[0];
    if (!model) return { error: 'no Anthropic model available to this key' };
    anthropicModel = model;
  }
  const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n');
  const rest = messages.filter((m) => m.role !== 'system');
  const r = await post('https://api.anthropic.com/v1/messages', headers, { model, max_tokens, system, messages: rest });
  if (r.error) return r;
  const text = (r.json.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('').trim();
  if (!text) return { error: 'empty response' };
  return { text, model: r.json.model || model, usage: r.json.usage || null, provider: 'Anthropic' };
}

export async function chat(messages, { model = process.env.NYTE_MODEL || 'nyte/auto', max_tokens = 300, temperature = 0.2 } = {}) {
  const nyte = process.env.NYTE_API_KEY || process.env.TRUSTEDROUTER_API_KEY;
  if (!nyte) {
    return process.env.ANTHROPIC_API_KEY ? chatAnthropic(messages, process.env.ANTHROPIC_API_KEY, { max_tokens }) : null;
  }
  const base = process.env.NYTE_BASE_URL || 'https://api.nytokenexchange.com/v1';
  const r = await post(`${base}/chat/completions`, { Authorization: `Bearer ${nyte}` }, { model, messages, max_tokens, temperature });
  if (r.error) return r;
  const content = r.json?.choices?.[0]?.message?.content;
  if (typeof content !== 'string' || !content.trim()) return { error: 'empty response' };
  return { text: content.trim(), model: r.json.model || model, usage: r.json.usage || null, provider: 'New York Token Exchange' };
}
