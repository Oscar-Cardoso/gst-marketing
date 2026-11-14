// Escritório Virtual GST — recebe as mensagens do WhatsApp (Uazapi) e guarda no Supabase.
// Variáveis na Vercel: UAZAPI_URL, UAZAPI_TOKEN (token da instância) e a chave do Supabase.
// O endereço do webhook leva um segredo derivado do UAZAPI_TOKEN (?s=...), configurado pelo painel.
const crypto = require('crypto');
const { responder, despacharFila, grupoInterno, uaz } = require('./_agente.js');

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
async function enviar(numero, texto, extra = {}) {
  const base = (process.env.UAZAPI_URL || '').replace(/\/+$/, '');
  const r = await fetch(base + '/send/text', { method: 'POST', headers: { token: process.env.UAZAPI_TOKEN, 'Content-Type': 'application/json' }, body: JSON.stringify({ number: numero, text: texto, ...extra }) });
  if (!r.ok) throw new Error('envio ' + r.status);
  const j = await r.json().catch(() => ({}));
  return j && (j.messageid || j.id || (j.key && j.key.id) || (j.message && (j.message.messageid || j.message.id))) || null;
}

// ---------- Fiscal no grupo interno: responde quando é chamado ----------
const chaveFone = (v) => { let d = String(v || '').replace(/\D/g, ''); if (d.length >= 12 && d.startsWith('55')) d = d.slice(2); return d.length >= 10 ? d.slice(0, 2) + d.slice(-8) : ''; };
const lerConfig = async (chave) => { const r = await sbGet('configuracoes?select=valor&chave=eq.' + chave); try { return r[0] ? JSON.parse(r[0].valor) : null; } catch { return null; } };
const salvarConfig = (chave, valor) => sb('configuracoes?on_conflict=chave', { chave, valor: JSON.stringify(valor), updated_at: new Date().toISOString() }, 'resolution=merge-duplicates,return=minimal');
// ids com que o Fiscal aparece numa marcação (@número ou @lid). Aprende pela lista de participantes do grupo.
async function idsDoFiscal(grupoId, dono) {
  const cfg = (await lerConfig('fiscal_mencoes')) || { ids: [], tentado: null };
  const ids = new Set((cfg.ids || []).map(String));
  if (dono) ids.add(String(dono).replace(/\D/g, ''));
  const precisa = ![...ids].some((x) => x.length >= 14) && (!cfg.tentado || Date.now() - Date.parse(cfg.tentado) > 6 * 3600e3);
  if (precisa && dono) {
    try {
      const info = await uaz('/group/info', { method: 'POST', body: { groupjid: grupoId, getInviteLink: false } });
      const parts = (info && (info.Participants || info.participants || (info.group && (info.group.Participants || info.group.participants)))) || [];
      for (const p of parts) {
        const t = JSON.stringify(p);
        if (!t.includes(String(dono).replace(/\D/g, ''))) continue;
        (t.match(/\d{10,}(?=@lid)/g) || []).forEach((x) => ids.add(x));
      }
    } catch {}
    await salvarConfig('fiscal_mencoes', { ids: [...ids], tentado: new Date().toISOString() });
  }
  return [...ids];
}
async function chamouOFiscal(msg, bruto, grupoId) {
  const texto = String(msg.texto || '');
  if (/^\s*@?fiscal\b/i.test(texto)) return true;
  const m = (bruto && bruto.message) || {};
  const ids = await idsDoFiscal(grupoId, m.owner || (bruto && bruto.chat && bruto.chat.owner));
  if (ids.some((id) => id && texto.includes('@' + id))) return true;
  const citada = typeof m.quoted === 'string' ? m.quoted : m.quoted && (m.quoted.id || m.quoted.messageid);
  if (citada) { const r = await sbGet('whatsapp_mensagens?select=id&de_mim=eq.true&msg_id=eq.' + encodeURIComponent(citada) + '&limit=1'); if (r[0]) return true; }
  return false;
}
async function quemDaEquipe(msg) {
  const equipe = await sbGet('equipe?select=id,nome,funcao,whatsapp,acesso&ativo=eq.true&acesso=neq.nenhum');
  const k = chaveFone(msg.remetente);
  let p = k && equipe.find((e) => chaveFone(e.whatsapp) === k);
  if (!p && msg.nome_remetente) { // sem número (só @lid): pelo nome, se for único
    const n = String(msg.nome_remetente).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().split(/\s+/)[0];
    const c = equipe.filter((e) => e.nome.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().split(/\s+/)[0] === n);
    if (c.length === 1) p = c[0];
  }
  return p || null;
}
async function atenderGrupo(quem, msg) {
  let resposta;
  try {
    const desde = new Date(Date.now() - 3 * 3600e3).toISOString();
    const hist = await sbGet(`whatsapp_mensagens?select=de_mim,texto,nome_remetente,recebida_em&chat_id=eq.${encodeURIComponent(msg.chat_id)}&recebida_em=gte.${desde}&id=neq.${msg.id}&order=recebida_em.desc&limit=15`);
    const conversa = hist.reverse().filter((h) => h.texto).map((h) => `${h.de_mim ? 'Fiscal' : h.nome_remetente || '?'}: ${String(h.texto).slice(0, 500)}`).join('\n');
    const pedido = (conversa ? 'Conversa recente no grupo (contexto):\n' + conversa + '\n\n' : '') + `Mensagem de ${quem.nome} chamando você agora:\n${msg.texto}`;
    resposta = await responder({ quem, pedido, modo: 'grupo', admin: quem.acesso === 'admin' });
  } catch (e) {
    resposta = `${quem.nome.split(' ')[0]}, tive um problema para responder agora. Tenta de novo em instantes.`;
  }
  const id = await enviar(msg.chat_id, resposta, msg.msg_id ? { replyid: msg.msg_id } : {}).catch(() => null);
  await sb('whatsapp_mensagens', { chat_id: msg.chat_id, eh_grupo: true, de_mim: true, tipo: 'resposta_agente', texto: resposta, remetente: 'agente', nome_remetente: 'Fiscal', msg_id: id || null, recebida_em: new Date().toISOString() });
  await fetch(SUPABASE_URL + '/rest/v1/whatsapp_mensagens?id=eq.' + msg.id, { method: 'PATCH', headers: cab('return=minimal'), body: JSON.stringify({ processada: true }) });
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
    // grupo interno: a equipe chama o Fiscal marcando @Fiscal, respondendo a ele ou começando com "Fiscal,"
    if (nova && nova.eh_grupo && !nova.de_mim && nova.texto) {
      let interno = null;
      try { interno = await grupoInterno(); } catch {}
      if (interno && interno.id === nova.chat_id && await chamouOFiscal(nova, semSegredo, interno.id)) {
        const quem = await quemDaEquipe(nova);
        if (quem) await atenderGrupo(quem, nova);
      }
    }
    return res.json({ ok: true });
  } catch (e) {
    return res.status(500).json({ ok: false });
  }
};
module.exports.segredoWebhook = segredoWebhook;
module.exports.config = { maxDuration: 60 };
