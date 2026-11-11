// Escritório Virtual GST — recebe as mensagens do WhatsApp (Uazapi) e guarda no Supabase.
// Variáveis na Vercel: UAZAPI_URL, UAZAPI_TOKEN (token da instância) e a chave do Supabase.
// O endereço do webhook leva um segredo derivado do UAZAPI_TOKEN (?s=...), configurado pelo painel.
const crypto = require('crypto');
const { responder, despacharFila } = require('./_agente.js');

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://rybbojxebmmtfhbmnopm.supabase.co';
const CHAVE = () => process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY || '';
const segredoWebhook = () => (process.env.UAZAPI_TOKEN ? crypto.createHash('sha256').update('gst-whatsapp:' + process.env.UAZAPI_TOKEN).digest('hex').slice(0, 40) : '');

function confere(a, b) {
  if (!a || !b) return false;
  const x = crypto.createHash('sha256').update(String(a)).digest();
  const y = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(x, y);
}
const txt = (v, max = 4000) => (typeof v === 'string' ? v.slice(0, max) : v == null ? null : String(v).slice(0, max));

// Lê os campos com tolerância: a Uazapi manda { EventType, message: {...}, chat: {...} }
function extrair(p) {
  const m = p.message || p.data?.message || p.data || {};
  const chat = p.chat || {};
  const chatId = m.chatid || m.chatId || chat.wa_chatid || m.key?.remoteJid || null;
  const grupo = Boolean(m.isGroup ?? chat.wa_isGroup ?? (chatId && /@g\.us$/.test(chatId)));
  let texto = m.text ?? m.content ?? m.body ?? m.message?.conversation ?? null;
  if (texto && typeof texto === 'object') texto = texto.text || texto.caption || JSON.stringify(texto);
  return {
    msg_id: txt(m.messageid || m.id || m.key?.id, 200),
    recebida_em: m.messageTimestamp ? new Date(Number(m.messageTimestamp) > 1e12 ? Number(m.messageTimestamp) : Number(m.messageTimestamp) * 1000).toISOString() : new Date().toISOString(),
    chat_id: txt(chatId, 200),
    eh_grupo: grupo,
    nome_chat: txt(m.groupName || chat.name || chat.wa_name || chat.wa_contactName, 300),
    remetente: txt(m.sender_pn || chat.phone && !grupo && chat.phone + '@s.whatsapp.net' || m.sender || m.key?.participant, 200),
    nome_remetente: txt(m.senderName || m.pushName, 200),
    de_mim: Boolean(m.fromMe ?? m.key?.fromMe),
    tipo: txt(m.messageType || m.type || p.EventType, 60),
    texto: txt(texto),
  };
}

function cab(prefer) {
  const key = CHAVE();
  const headers = { apikey: key, 'Content-Type': 'application/json' };
  if (prefer) headers.Prefer = prefer;
  if (!key.startsWith('sb_')) headers.Authorization = 'Bearer ' + key;
  return headers;
}
async function sb(caminho, body, prefer) {
  const r = await fetch(SUPABASE_URL + '/rest/v1/' + caminho, { method: 'POST', headers: cab(prefer || 'return=minimal'), body: JSON.stringify(body) });
  if (!r.ok) throw new Error('banco ' + r.status);
  const t = await r.text(); try { return t ? JSON.parse(t) : null; } catch { return null; }
}
async function sbGet(caminho) {
  const r = await fetch(SUPABASE_URL + '/rest/v1/' + caminho, { headers: cab() });
  if (!r.ok) throw new Error('banco ' + r.status);
  return r.json();
}
async function enviar(numero, texto) {
  const base = (process.env.UAZAPI_URL || '').replace(/\/+$/, '');
  const r = await fetch(base + '/send/text', { method: 'POST', headers: { token: process.env.UAZAPI_TOKEN, 'Content-Type': 'application/json' }, body: JSON.stringify({ number: numero, text: texto }) });
  if (!r.ok) throw new Error('envio ' + r.status);
}
async function atender(quem, msg, numero) {
  let resposta;
  try {
    const hist = await sbGet(`whatsapp_mensagens?select=de_mim,texto,recebida_em&chat_id=eq.${encodeURIComponent(msg.chat_id)}&recebida_em=gte.${new Date(Date.now() - 6 * 3600e3).toISOString()}&id=neq.${msg.id}&order=recebida_em.desc&limit=12`);
    resposta = await responder({ quem, pedido: msg.texto, historico: hist.reverse() });
  } catch (e) {
    resposta = 'Tive um problema para responder agora (' + String(e.message || e).slice(0, 120) + '). Tenta de novo em instantes.';
  }
  await enviar(numero, resposta);
  await sb('whatsapp_mensagens', { chat_id: msg.chat_id, eh_grupo: false, de_mim: true, tipo: 'resposta_agente', texto: resposta, remetente: 'agente', recebida_em: new Date().toISOString() });
  await fetch(SUPABASE_URL + '/rest/v1/whatsapp_mensagens?id=eq.' + msg.id, { method: 'PATCH', headers: cab('return=minimal'), body: JSON.stringify({ processada: true }) });
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  // despacha a fila de envio (só manda o que já está gravado no banco; não aceita conteúdo de fora)
  if (req.query && req.query.acao === 'despachar') {
    try { return res.json({ ok: true, enviados: await despacharFila() }); } catch (e) { return res.status(500).json({ ok: false }); }
  }
  if (req.method !== 'POST') return res.status(405).json({ ok: false });
  if (!confere(req.query && req.query.s, segredoWebhook())) return res.status(401).json({ ok: false });
  let p = req.body;
  if (typeof p === 'string') { try { p = JSON.parse(p); } catch { p = {}; } }
  p = p && typeof p === 'object' ? p : {};
  const evento = String(p.EventType || p.event || p.type || '').toLowerCase();
  if (evento && !/message/.test(evento)) return res.json({ ok: true, ignorado: evento });
  try {
    const linha = extrair(p);
    if (!linha.chat_id && !linha.texto) return res.json({ ok: true, ignorado: 'vazio' });
    const { token, BaseUrl, admintoken, ...semSegredo } = p; // nunca guardar o token da instância
    const gravada = await sb('whatsapp_mensagens?on_conflict=msg_id', { ...linha, bruto: semSegredo }, 'return=representation,resolution=ignore-duplicates');
    const nova = Array.isArray(gravada) && gravada[0];
    // ordem para o agente: conversa privada, vinda de alguém autorizado (Oscar / Jéssica)
    if (nova && !nova.eh_grupo && !nova.de_mim && nova.texto) {
      const numero = String(nova.remetente || nova.chat_id || '').replace(/\D/g, '');
      const quem = numero ? await sbGet(`equipe?select=id,nome,whatsapp&comanda_agente=eq.true&whatsapp=eq.${numero}`) : [];
      if (quem[0]) await atender(quem[0], nova, numero);
    }
    return res.json({ ok: true });
  } catch (e) {
    return res.status(500).json({ ok: false });
  }
};
module.exports.segredoWebhook = segredoWebhook;
module.exports.config = { maxDuration: 60 };
