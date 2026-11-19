// Chamada ao modelo do Fiscal: tenta a Anthropic (Claude) e, se ela falhar (sem crédito, fora do ar,
// limite), usa a OpenAI (GPT) com a mesma conversa. A resposta volta sempre no formato da Anthropic
// ({ content: [{type:'text'|'tool_use'}], stop_reason }), então o resto do código não muda.
// Variáveis: ANTHROPIC_API_KEY, OPENAI_API_KEY, OPENAI_AGENTE_MODELO (opcional, padrão gpt-4.1).

let anthropicForaAte = 0; // depois de falta de crédito/chave, pula a Anthropic por um tempo
const PAUSA_ANTHROPIC = 10 * 60e3;

async function anthropic(body) {
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    const e = new Error('Anthropic ' + r.status + ': ' + ((j.error && j.error.message) || ''));
    e.status = r.status; e.msg = (j.error && j.error.message) || '';
    throw e;
  }
  return j;
}

function paraOpenAI(body) {
  const msgs = [];
  if (body.system) msgs.push({ role: 'system', content: typeof body.system === 'string' ? body.system : body.system.map((b) => b.text || '').join('\n') });
  for (const m of body.messages || []) {
    if (typeof m.content === 'string') { msgs.push({ role: m.role, content: m.content }); continue; }
    const blocos = m.content || [];
    if (m.role === 'assistant') {
      const texto = blocos.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
      const usos = blocos.filter((b) => b.type === 'tool_use');
      const msg = { role: 'assistant', content: texto || null };
      if (usos.length) msg.tool_calls = usos.map((u) => ({ id: u.id, type: 'function', function: { name: u.name, arguments: JSON.stringify(u.input || {}) } }));
      msgs.push(msg);
    } else {
      for (const b of blocos.filter((x) => x.type === 'tool_result')) {
        const c = typeof b.content === 'string' ? b.content : JSON.stringify(b.content);
        msgs.push({ role: 'tool', tool_call_id: b.tool_use_id, content: (b.is_error ? 'ERRO: ' : '') + c });
      }
      const texto = blocos.filter((x) => x.type === 'text').map((x) => x.text).join('\n');
      if (texto) msgs.push({ role: 'user', content: texto });
    }
  }
  const req = { model: process.env.OPENAI_AGENTE_MODELO || 'gpt-4.1', messages: msgs, max_completion_tokens: body.max_tokens || 2000 };
  if (body.tools && body.tools.length) {
    req.tools = body.tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description || '', parameters: t.input_schema || { type: 'object', properties: {} } } }));
  }
  return req;
}

async function openai(body) {
  const r = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + process.env.OPENAI_API_KEY, 'content-type': 'application/json' },
    body: JSON.stringify(paraOpenAI(body)),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error('OpenAI ' + r.status + ': ' + ((j.error && j.error.message) || ''));
  const m = (j.choices && j.choices[0] && j.choices[0].message) || {};
  const content = [];
  if (m.content) content.push({ type: 'text', text: m.content });
  for (const t of m.tool_calls || []) {
    let input = {}; try { input = JSON.parse(t.function.arguments || '{}'); } catch {}
    content.push({ type: 'tool_use', id: t.id, name: t.function.name, input });
  }
  return { content, stop_reason: (m.tool_calls || []).length ? 'tool_use' : 'end_turn', provedor: 'openai' };
}

async function chamarModelo(body) {
  const temA = !!process.env.ANTHROPIC_API_KEY, temO = !!process.env.OPENAI_API_KEY;
  if (temA && Date.now() > anthropicForaAte) {
    try { return await anthropic(body); } catch (e) {
      if (!temO || e.status === 400 && !/credit|billing|balance/i.test(e.msg || '')) throw e; // erro do pedido em si: não adianta trocar
      if (e.status === 401 || e.status === 403 || /credit|billing|balance/i.test(e.msg || '')) anthropicForaAte = Date.now() + PAUSA_ANTHROPIC;
      console.error('Anthropic falhou, usando OpenAI:', e.message);
    }
  }
  if (!temO) throw new Error('Anthropic indisponível e falta a OPENAI_API_KEY na Vercel');
  return openai(body);
}

const temModelo = () => !!(process.env.ANTHROPIC_API_KEY || process.env.OPENAI_API_KEY);

module.exports = { chamarModelo, temModelo };
