// Escritório Virtual GST — recebe as mensagens do WhatsApp (Uazapi) e guarda no Supabase.
// Variáveis na Vercel: UAZAPI_URL, UAZAPI_TOKEN (token da instância) e a chave do Supabase.
// O endereço do webhook leva um segredo derivado do UAZAPI_TOKEN (?s=...), configurado pelo painel.
const crypto = require('crypto');

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
    remetente: txt(m.sender || m.sender_pn || m.key?.participant, 200),
    nome_remetente: txt(m.senderName || m.pushName, 200),
    de_mim: Boolean(m.fromMe ?? m.key?.fromMe),
    tipo: txt(m.messageType || m.type || p.EventType, 60),
    texto: txt(texto),
  };
}

async function sb(caminho, body, prefer) {
  const key = CHAVE();
  const headers = { apikey: key, 'Content-Type': 'application/json', Prefer: prefer || 'return=minimal' };
  if (!key.startsWith('sb_')) headers.Authorization = 'Bearer ' + key;
  const r = await fetch(SUPABASE_URL + '/rest/v1/' + caminho, { method: 'POST', headers, body: JSON.stringify(body) });
  if (!r.ok) throw new Error('banco ' + r.status);
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
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
    await sb('whatsapp_mensagens?on_conflict=msg_id', { ...linha, bruto: p }, 'return=minimal,resolution=ignore-duplicates');
    return res.json({ ok: true });
  } catch (e) {
    return res.status(500).json({ ok: false });
  }
};
module.exports.segredoWebhook = segredoWebhook;
