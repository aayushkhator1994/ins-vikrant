// One-time: create the INS Vikrant voice assistant and attach it to the phone number.
// Needs VAPI_API_KEY, VAPI_PHONE_NUMBER_ID, PUBLIC_URL (the bridge's public https URL) and BRIDGE_SECRET.
const { VAPI_API_KEY, VAPI_PHONE_NUMBER_ID, PUBLIC_URL, BRIDGE_SECRET } = process.env;
for (const [k, v] of Object.entries({ VAPI_API_KEY, VAPI_PHONE_NUMBER_ID, PUBLIC_URL, BRIDGE_SECRET })) {
  if (!v) { console.error(`Missing ${k}`); process.exit(1); }
}
const H = { Authorization: `Bearer ${VAPI_API_KEY}`, 'Content-Type': 'application/json' };
const url = PUBLIC_URL.replace(/\/$/, '') + '/vapi/tools';
const s = { type: 'string' };
const tool = (name, description, properties, required, say) => ({
  type: 'function',
  function: { name, description, parameters: { type: 'object', properties, required } },
  server: { url, headers: { 'x-vapi-secret': BRIDGE_SECRET } },
  messages: say ? [{ type: 'request-start', content: say }] : [],
});
const body = {
  name: 'INS Vikrant',
  firstMessage: 'INS Vikrant. What should the crew research?',
  backgroundSound: 'off',
  transcriber: { provider: 'deepgram', model: 'nova-3', language: 'en' },
  voice: { provider: 'deepgram', model: 'aura-2', voiceId: 'thalia' },
  model: {
    provider: 'openai', model: 'gpt-4o',
    messages: [{ role: 'system', content:
      'You are the voice agent for INS Vikrant, a research crew that checks its evidence. Keep every reply to one or two short spoken sentences. ' +
      'When the caller asks a research question about a public company, restate it in one sentence, then call start_mission with the stock ticker, the company name, the question, and the topics they care about as focus. ' +
      'Read back the mission name. Use get_status for progress and why for the reasons behind a verdict. ' +
      'Before stop_mission, ask the caller to say yes, and only then call it with confirmed true. ' +
      'Research only: never give buy or sell advice. Never read URLs aloud.' }],
    tools: [
      tool('start_mission', 'Start a research mission about a public company.',
        { ticker: { type: 'string', description: 'Stock ticker, e.g. NVDA' }, company: s, question: s,
          focus: { type: 'string', description: 'Comma-separated topics the caller cares about, e.g. data center,guidance' } },
        ['ticker', 'question'], 'Launching the crew.'),
      tool('get_status', 'Report progress or the verdict of a mission. Omit mission_id for the latest.', { mission_id: s }, []),
      tool('why', 'Explain the reasons and the strongest counterpoint behind a verdict.', { mission_id: s }, []),
      tool('stop_mission', 'Stop a mission. Only pass confirmed true after the caller says yes.',
        { mission_id: s, confirmed: { type: 'boolean' } }, []),
    ],
  },
};
const r = await fetch('https://api.vapi.ai/assistant', { method: 'POST', headers: H, body: JSON.stringify(body) });
const a = await r.json();
if (!r.ok) { console.error('create assistant failed', r.status, JSON.stringify(a).slice(0, 600)); process.exit(1); }
console.log('assistant', a.id);
const p = await fetch(`https://api.vapi.ai/phone-number/${VAPI_PHONE_NUMBER_ID}`, { method: 'PATCH', headers: H, body: JSON.stringify({ assistantId: a.id }) });
const n = await p.json();
if (!p.ok) { console.error('attach number failed', p.status, JSON.stringify(n).slice(0, 600)); process.exit(1); }
console.log('number', n.number || n.id, '-> assistant', a.id);
