// Escritório Virtual GST — recebe as mensagens do WhatsApp (Uazapi) e guarda no Supabase.
// Variáveis na Vercel: UAZAPI_URL, UAZAPI_TOKEN (token da instância) e a chave do Supabase.
// O endereço do webhook leva um segredo derivado do UAZAPI_TOKEN (?s=...), configurado pelo painel.
const crypto = require('crypto');
const { responder, despacharFila, grupoInterno, uaz } = require('./_agente.js');
const { atenderLead } = require('./_leads.js');

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

// ---------- áudio: baixa pela Uazapi e transcreve na OpenAI (chave fica só na Vercel) ----------
const ehAudio = (msg, bruto) => { const m = (bruto && bruto.message) || {}; return /audio/i.test(String(m.messageType || msg.tipo || '')) || ['ptt', 'audio'].includes(String(m.mediaType || '').toLowerCase()); };
async function transcrever(msg, bruto) {
  if (!process.env.OPENAI_API_KEY) throw new Error('falta a OPENAI_API_KEY na Vercel');
  const m = (bruto && bruto.message) || {};
  const segundos = Number((m.content && m.content.seconds) || 0);
  if (segundos > 600) throw new Error('áudio com mais de 10 minutos');
  const d = await uaz('/message/download', { method: 'POST', body: { id: msg.msg_id, return_base64: true, generate_mp3: true } });
  let b64 = d && (d.base64Data || d.base64 || d.data || (d.file && d.file.base64));
  let tipo = (d && (d.mimetype || d.mimeType)) || 'audio/mpeg';
  let buf;
  if (b64) buf = Buffer.from(String(b64).replace(/^data:[^,]+,/, ''), 'base64');
  else if (d && (d.fileURL || d.url)) { const r = await fetch(d.fileURL || d.url); if (!r.ok) throw new Error('não consegui baixar o áudio'); buf = Buffer.from(await r.arrayBuffer()); tipo = r.headers.get('content-type') || tipo; }
  else throw new Error('a Uazapi não devolveu o áudio');
  const ext = /mpeg|mp3/.test(tipo) ? 'mp3' : /ogg|opus/.test(tipo) ? 'ogg' : /mp4|m4a/.test(tipo) ? 'm4a' : 'mp3';
  const form = new FormData();
  form.append('file', new Blob([buf], { type: tipo }), 'audio.' + ext);
  form.append('model', process.env.OPENAI_TRANSCRICAO_MODELO || 'whisper-1');
  form.append('language', 'pt');
  form.append('prompt', 'Conversa de agência de marketing para supermercados: GST, Fiscal, encarte, oferta, tráfego, Meta Ads, Jéssica, Clara, Daniel, Felipe, Ester, Igor, Gustavo, Sara, Dimas.');
  const r = await fetch('https://api.openai.com/v1/audio/transcriptions', { method: 'POST', headers: { Authorization: 'Bearer ' + process.env.OPENAI_API_KEY }, body: form });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error('transcrição ' + r.status + (j.error && j.error.message ? ': ' + String(j.error.message).slice(0, 120) : ''));
  const texto = String(j.text || '').trim();
  if (!texto) throw new Error('áudio sem fala reconhecível');
  return texto;
}

// ---------- designer avisa no grupo do cliente "ofertas aprovadas ✅" → encarte concluído no escritório ----------
const AVISO_APROVADO = /\b(ofertas?|l[aâ]minas?|encartes?|artes?|tabloides?)\s+(aprovad|finalizad)|\b(aprovad|finalizad)[ao]s?\b\s*✅/i;
async function designerAprovou(msg) {
  if (!msg.cliente_id || !AVISO_APROVADO.test(msg.texto || '') || /\?/.test(msg.texto || '')) return;
  const equipe = await sbGet('equipe?select=id,nome,funcao,whatsapp&ativo=eq.true');
  const k = chaveFone(msg.remetente);
  const quem = k && equipe.find((e) => chaveFone(e.whatsapp) === k);
  if (!quem) return;
  const resp = await sbGet(`cliente_responsaveis?select=equipe_id&cliente_id=eq.${msg.cliente_id}&area=eq.design`);
  if (!resp.some((r) => r.equipe_id === quem.id) && !/design/i.test(quem.funcao || '')) return;
  const ts = await sbGet(`tarefas?select=id,titulo,responsavel_id,oferta_id,prazo&cliente_id=eq.${msg.cliente_id}&area=eq.design&status=in.(a_fazer,em_andamento,aguardando_cliente,em_conferencia)&order=prazo.asc.nullslast&limit=20`);
  const alvo = ts.find((t) => t.oferta_id && t.responsavel_id === quem.id) || ts.find((t) => t.oferta_id) || ts.find((t) => /encarte|l[aâ]mina|oferta|tabloide/i.test(t.titulo));
  if (!alvo) return;
  await fetch(SUPABASE_URL + '/rest/v1/tarefas?id=eq.' + alvo.id, { method: 'PATCH', headers: cab('return=minimal'), body: JSON.stringify({ status: 'concluida', alterado_por: quem.id }) });
  await sb('diario', { dia: new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' }), cliente_id: msg.cliente_id, tipo: 'nota', resumo: `Fiscal concluiu "${alvo.titulo}" porque ${quem.nome} avisou no grupo do cliente: "${String(msg.texto).slice(0, 80)}".`, quem: 'Fiscal', fonte: 'whatsapp' });
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
async function atenderGrupo(quem, msg, bruto, clienteId) {
  let resposta;
  try {
    const desde = new Date(Date.now() - 3 * 3600e3).toISOString();
    const hist = await sbGet(`whatsapp_mensagens?select=de_mim,texto,nome_remetente,recebida_em&chat_id=eq.${encodeURIComponent(msg.chat_id)}&recebida_em=gte.${desde}&id=neq.${msg.id}&order=recebida_em.desc&limit=15`);
    const conversa = hist.reverse().filter((h) => h.texto).map((h) => `${h.de_mim ? 'Fiscal' : h.nome_remetente || '?'}: ${String(h.texto).slice(0, 500)}`).join('\n');
    // mensagem citada (o Oscar responde à fala do cliente marcando o Fiscal)
    let citada = '';
    const m = (bruto && bruto.message) || {};
    const qid = typeof m.quoted === 'string' ? m.quoted : m.quoted && (m.quoted.id || m.quoted.messageid);
    if (qid) { try { const r = await sbGet('whatsapp_mensagens?select=texto,nome_remetente,de_mim&msg_id=eq.' + encodeURIComponent(qid) + '&limit=1'); if (r[0] && r[0].texto) citada = `${r[0].de_mim ? 'Fiscal' : r[0].nome_remetente || '?'}: ${String(r[0].texto).slice(0, 1500)}`; } catch {} }
    const pedido = (conversa ? 'Conversa recente no grupo (contexto):\n' + conversa + '\n\n' : '') + (citada ? 'Mensagem que ele citou/respondeu:\n' + citada + '\n\n' : '') + `Mensagem de ${quem.nome} chamando você agora:\n${msg.texto}`;
    resposta = clienteId
      ? await responder({ quem, pedido, modo: 'cliente', admin: quem.acesso === 'admin', cliente: clienteId })
      : await responder({ quem, pedido, modo: 'grupo', admin: quem.acesso === 'admin' });
  } catch (e) {
    resposta = `${quem.nome.split(' ')[0]}, tive um problema para responder agora. Tenta de novo em instantes.`;
  }
  const id = await enviar(msg.chat_id, resposta, msg.msg_id ? { replyid: msg.msg_id } : {}).catch(() => null);
  await sb('whatsapp_mensagens', { chat_id: msg.chat_id, eh_grupo: true, de_mim: true, tipo: 'resposta_agente', texto: resposta, remetente: 'agente', nome_remetente: 'Fiscal', msg_id: id || null, recebida_em: new Date().toISOString() });
  await fetch(SUPABASE_URL + '/rest/v1/whatsapp_mensagens?id=eq.' + msg.id, { method: 'PATCH', headers: cab('return=minimal'), body: JSON.stringify({ processada: true }) });
}
async function atenderProspect(msg, numero, bruto) {
  let texto = msg.texto;
  if (!texto && ehAudio(msg, bruto)) {
    const ja = await sbGet('prospects?select=id&telefone=eq.' + numero + '&limit=1');
    if (!ja.length) return; // áudio de quem ainda não é lead: ignora
    try { texto = await transcrever(msg, bruto); } catch (e) { texto = null; }
    if (!texto) { await enviar(numero, 'Não consegui ouvir seu áudio aqui. Pode me mandar por escrito? 🙏'); return; }
  }
  if (!texto) return;
  const hist = await sbGet(`whatsapp_mensagens?select=de_mim,texto,recebida_em&chat_id=eq.${encodeURIComponent(msg.chat_id)}&recebida_em=gte.${new Date(Date.now() - 7 * 864e5).toISOString()}&id=neq.${msg.id}&order=recebida_em.desc&limit=30`);
  const resposta = await atenderLead({ numero, chatId: msg.chat_id, texto, nomeWhats: msg.nome_remetente, historico: hist.reverse() });
  if (!resposta) return;
  await enviar(numero, resposta);
  await sb('whatsapp_mensagens', { chat_id: msg.chat_id, eh_grupo: false, de_mim: true, tipo: 'resposta_agente', texto: resposta, remetente: 'agente', recebida_em: new Date().toISOString() });
  await fetch(SUPABASE_URL + '/rest/v1/whatsapp_mensagens?id=eq.' + msg.id, { method: 'PATCH', headers: cab('return=minimal'), body: JSON.stringify({ processada: true }) });
}
async function atender(quem, msg, numero, ouvido) {
  let resposta;
  try {
    const hist = await sbGet(`whatsapp_mensagens?select=de_mim,texto,recebida_em&chat_id=eq.${encodeURIComponent(msg.chat_id)}&recebida_em=gte.${new Date(Date.now() - 6 * 3600e3).toISOString()}&id=neq.${msg.id}&order=recebida_em.desc&limit=12`);
    resposta = await responder({ quem, pedido: msg.texto, historico: hist.reverse() });
  } catch (e) {
    resposta = 'Tive um problema para responder agora (' + String(e.message || e).slice(0, 120) + '). Tenta de novo em instantes.';
  }
  if (ouvido) resposta = '🎧 Entendi: _' + (ouvido.length > 400 ? ouvido.slice(0, 400) + '…' : ouvido) + '_\n\n' + resposta;
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
    if (nova && !nova.eh_grupo && !nova.de_mim && (nova.texto || ehAudio(nova, semSegredo))) {
      const numero = String(nova.remetente || nova.chat_id || '').replace(/\D/g, '');
      const quem = numero ? await sbGet(`equipe?select=id,nome,whatsapp&comanda_agente=eq.true&whatsapp=eq.${numero}`) : [];
      if (quem[0] && ehAudio(nova, semSegredo)) {
        // por enquanto só os áudios do Oscar (treino); os demais seguem ignorados
        if (/^oscar$/i.test(quem[0].nome)) {
          try {
            const falado = await transcrever(nova, semSegredo);
            await fetch(SUPABASE_URL + '/rest/v1/whatsapp_mensagens?id=eq.' + nova.id, { method: 'PATCH', headers: cab('return=minimal'), body: JSON.stringify({ texto: '🎧 ' + falado }) });
            await atender(quem[0], { ...nova, texto: falado }, numero, falado);
          } catch (e) {
            await enviar(numero, 'Recebi seu áudio, mas não consegui ouvir (' + String(e.message || e).slice(0, 140) + '). Pode mandar por escrito?');
          }
        }
      } else if (quem[0]) await atender(quem[0], nova, numero);
      else if (numero && !(await sbGet('equipe?select=id&whatsapp=eq.' + numero)).length) {
        // não é da equipe: pode ser lead da campanha (só responde quem chegou pelo anúncio ou já é lead)
        try { await atenderProspect(nova, numero, semSegredo); } catch (e) {}
      }
    }
    if (nova && nova.eh_grupo && !nova.de_mim && nova.texto && nova.cliente_id) { try { await designerAprovou(nova); } catch (e) {} }
    // grupo interno: a equipe chama o Fiscal marcando @Fiscal, respondendo a ele ou começando com "Fiscal,"
    if (nova && nova.eh_grupo && !nova.de_mim && nova.texto) {
      let interno = null;
      try { interno = await grupoInterno(); } catch {}
      if (interno && interno.id === nova.chat_id && await chamouOFiscal(nova, semSegredo, interno.id)) {
        const quem = await quemDaEquipe(nova);
        if (quem) await atenderGrupo(quem, nova, semSegredo);
      } else if (nova.cliente_id && (!interno || interno.id !== nova.chat_id) && await chamouOFiscal(nova, semSegredo, nova.chat_id)) {
        // grupo de cliente: qualquer pessoa da equipe chama o Fiscal (o cliente lê a resposta).
        // Oscar e Jéssica (admin): tarefas, feedback e histórico. Equipe: só registrar/ajustar tarefas.
        const quem = await quemDaEquipe(nova);
        // exige o número cadastrado (não vale só o nome: alguém do cliente pode ter o mesmo nome)
        if (quem && chaveFone(nova.remetente) && chaveFone(nova.remetente) === chaveFone(quem.whatsapp)) await atenderGrupo(quem, nova, semSegredo, nova.cliente_id);
      }
    }
    return res.json({ ok: true });
  } catch (e) {
    return res.status(500).json({ ok: false });
  }
};
module.exports.segredoWebhook = segredoWebhook;
module.exports.config = { maxDuration: 60 };
