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
  firstMessage: 'I N S Vikrant. What should the crew research?',
  backgroundSound: 'off',
  transcriber: { provider: 'deepgram', model: 'nova-3', language: 'en' },
  voice: { provider: 'deepgram', model: 'aura-2', voiceId: 'thalia' },
  model: {
    provider: 'openai', model: 'gpt-4o',
    messages: [{ role: 'system', content:
      'You are the voice agent for INS Vikrant, a research crew that checks its evidence. Keep every reply to one or two short spoken sentences, except when relaying what why or ask returned: speak that answer in full. ' +
      'When the caller asks a research question about a public company, restate it in one sentence, then call start_mission with the stock ticker, the company name, the question, and the topics they care about as focus. ' +
      'Read back the mission id exactly as the tool returned it. Only say a mission started if start_mission returned a mission id. ' +
      'If a tool call fails or returns nothing, say plainly that the mission could not be started and why; never invent a mission name or a result. ' +
      'A mission takes about ten seconds, and the caller gets a phone notification with the verdict when it finishes; say so after launching. ' +
      'Use get_status for progress and why for the reasons behind a verdict. ' +
      'After a mission finishes, use why for the reasons behind the verdict and ask for any other question about it; pass the caller\'s question to ask in their own words and speak the answer you get back. ' +
      'Always give the reasons that support and the reasons against. ' +
      'Never reply only that you cannot answer or do not have an answer: if you cannot give a buy or sell recommendation, say that in a few words and then call ask so the caller hears the evidence for and against. ' +
      'If no mission exists yet for the company, offer to start one. ' +
      'Before stop_mission, ask the caller to say yes, and only then call it with confirmed true. ' +
      'Research only: never give buy or sell advice. Never read URLs aloud.' }],
    tools: [
      tool('start_mission', 'Start a research mission about a public company.',
        { ticker: { type: 'string', description: 'Stock ticker, e.g. NVDA' }, company: s, question: s,
          focus: { type: 'string', description: 'Comma-separated topics the caller cares about, e.g. data center,guidance' } },
        ['ticker', 'question'], 'Launching the crew.'),
      tool('get_status', 'Report progress or the verdict of a mission. Omit mission_id for the latest.', { mission_id: s }, []),
      tool('why', 'Explain the reasons and the strongest counterpoint behind a verdict.', { mission_id: s }, []),
      tool('ask', 'Answer any follow-up question about a mission from its checked evidence: reasons, risks, what supports or cuts against the thesis, comparisons, or whether the evidence favours investing.',
        { mission_id: s, question: s }, ['question'], 'Checking the evidence.'),
      tool('stop_mission', 'Stop a mission. Only pass confirmed true after the caller says yes.',
        { mission_id: s, confirmed: { type: 'boolean' } }, []),
    ],
  },
};
const existing = process.env.VAPI_ASSISTANT_ID;
const r = await fetch('https://api.vapi.ai/assistant' + (existing ? `/${existing}` : ''), { method: existing ? 'PATCH' : 'POST', headers: H, body: JSON.stringify(body) });
const a = await r.json();
if (!r.ok) { console.error('save assistant failed', r.status, JSON.stringify(a).slice(0, 600)); process.exit(1); }
console.log('assistant', a.id);
const p = await fetch(`https://api.vapi.ai/phone-number/${VAPI_PHONE_NUMBER_ID}`, { method: 'PATCH', headers: H, body: JSON.stringify({ assistantId: a.id }) });
const n = await p.json();
if (!p.ok) { console.error('attach number failed', p.status, JSON.stringify(n).slice(0, 600)); process.exit(1); }
console.log('number', n.number || n.id, '-> assistant', a.id);
