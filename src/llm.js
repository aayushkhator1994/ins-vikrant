// OpenAI-compatible chat call through New York Token Exchange. Never throws.

const CHAT_TIMEOUT_MS = 45000;

export async function chat(
  messages,
  { model = process.env.NYTE_MODEL || 'nyte/auto', max_tokens = 300, temperature = 0.2 } = {},
) {
  const key = process.env.NYTE_API_KEY || process.env.TRUSTEDROUTER_API_KEY;
  if (!key) return null;
  const base = process.env.NYTE_BASE_URL || 'https://api.nytokenexchange.com/v1';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CHAT_TIMEOUT_MS);
  try {
    const res = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, messages, max_tokens, temperature }),
      signal: controller.signal,
    });
    if (!res.ok) return { error: `HTTP ${res.status}` };
    const json = await res.json();
    const content = json?.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || !content.trim()) return { error: 'empty response' };
    return { text: content.trim(), model: json.model || model, usage: json.usage || null };
  } catch (err) {
    const msg = err && err.name === 'AbortError' ? `timed out after ${CHAT_TIMEOUT_MS}ms` : String((err && err.message) || err);
    return { error: msg.slice(0, 200) };
  } finally {
    clearTimeout(timer);
  }
}
