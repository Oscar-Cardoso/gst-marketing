// Formulário do site -> tabela de leads do escritório + aviso do Fiscal (Oscar e Jéssica) + tarefa de retorno em 24h.
// Público (sem login): valida tamanho, tem campo-isca contra robô e limite por IP.
const crypto = require('crypto');

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://rybbojxebmmtfhbmnopm.supabase.co';
const CHAVE = () => process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY || '';
const txt = (v, max = 200) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

async function sb(caminho, { method = 'GET', body, prefer } = {}) {
  const key = CHAVE();
  const headers = { apikey: key, 'Content-Type': 'application/json' };
  if (!key.startsWith('sb_')) headers.Authorization = 'Bearer ' + key;
  if (prefer) headers.Prefer = prefer;
  const r = await fetch(SUPABASE_URL + '/rest/v1/' + caminho, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text();
  if (!r.ok) throw Object.assign(new Error('banco ' + r.status + ' ' + t.slice(0, 120)), { status: r.status });
  try { return t ? JSON.parse(t) : null; } catch { return null; }
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ ok: false });
  if (!CHAVE()) return res.status(503).json({ ok: false });
  let b = req.body;
  if (typeof b === 'string') { try { b = JSON.parse(b); } catch { b = {}; } }
  b = b && typeof b === 'object' ? b : {};
  if (txt(b.site)) return res.json({ ok: true }); // campo-isca preenchido = robô

  const lead = {
    nome: txt(b.nome, 120), whatsapp: txt(b.whatsapp, 40), loja: txt(b.supermercado, 160),
    cidade: txt(b.cidade, 120), lojas: txt(b.lojas, 40), faturamento: txt(b.faturamento, 40),
    marketing: txt(b.marketing, 80), desafio: txt(b.desafio, 800), indicado_por: txt(b.indicado_por, 80) || null,
    formulario: txt(b.formulario, 30), event_id: txt(b.event_id, 80) || null,
    utm: Object.fromEntries(['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content'].map((k) => [k, txt(b[k], 200)]).filter(([, v]) => v)),
  };
  if (!lead.nome || lead.whatsapp.replace(/\D/g, '').length < 10 || !lead.loja) return res.status(400).json({ ok: false, erro: 'dados incompletos' });

  try {
    const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    lead.origem_ip = ip ? crypto.createHash('sha256').update('lead:' + ip).digest('hex').slice(0, 24) : null;
    if (lead.origem_ip) {
      const desde = new Date(Date.now() - 3600e3).toISOString();
      const rec = await sb(`leads?select=id&origem_ip=eq.${lead.origem_ip}&created_at=gte.${desde}`);
      if (rec.length >= 5) return res.json({ ok: true }); // excesso: ignora em silêncio
    }
    const gravado = await sb('leads' + (lead.event_id ? '?on_conflict=event_id' : ''), { method: 'POST', body: lead, prefer: 'return=representation,resolution=ignore-duplicates' });
    const novo = Array.isArray(gravado) && gravado[0];
    if (!novo) return res.json({ ok: true }); // duplicado (mesmo envio duas vezes)

    const linhas = [
      '🟢 *Novo lead do site*', '',
      `*${lead.loja}*${lead.cidade ? ' · ' + lead.cidade : ''}`,
      `Contato: ${lead.nome} · ${lead.whatsapp}`,
      lead.lojas && `Lojas: ${lead.lojas}`,
      lead.faturamento && `Faturamento: ${lead.faturamento}`,
      lead.marketing && `Marketing hoje: ${lead.marketing}`,
      lead.desafio && `Desafio: ${lead.desafio.slice(0, 300)}`,
      lead.indicado_por && `👤 Indicado por: *${lead.indicado_por}* (canal de representantes)`,
      lead.utm.utm_campaign && `Campanha: ${lead.utm.utm_campaign}`,
      '', 'Prometemos retorno em até 24h. Tarefa criada no escritório.', '', '_Fiscal · GST_',
    ].filter((l) => typeof l === 'string');
    const texto = linhas.filter((l, i, a) => !(l === '' && a[i - 1] === '')).join('\n');

    const [interno] = await sb('clientes?select=id&status=eq.interno&limit=1');
    const [oscar] = await sb('equipe?select=id&nome=eq.Oscar&limit=1');
    const tarefas = [];
    if (interno && oscar) {
      tarefas.push(sb('tarefas', { method: 'POST', body: {
        cliente_id: interno.id, responsavel_id: oscar.id, titulo: `Responder lead do site: ${lead.loja}${lead.cidade ? ' (' + lead.cidade + ')' : ''}`,
        descricao: `${lead.nome} · ${lead.whatsapp}${lead.indicado_por ? ' · indicado por ' + lead.indicado_por : ''}. Agendar o diagnóstico gratuito.`,
        area: 'comercial', origem: 'integracao', origem_referencia: 'site:lead:' + novo.id, pedido_original: texto.slice(0, 1500),
        chave_deduplicacao: 'lead:' + novo.id, prazo: new Date(Date.now() + 24 * 3600e3).toISOString(), prioridade: 'alta', status: 'a_fazer',
      } }));
    }
    await Promise.allSettled([
      ...tarefas,
      sb('diario', { method: 'POST', body: { dia: new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' }), tipo: 'cliente', resumo: `Lead do site: ${lead.loja}${lead.cidade ? ' (' + lead.cidade + ')' : ''}${lead.indicado_por ? ', indicado por ' + lead.indicado_por : ''}.`, quem: 'Site', fonte: 'site' } }),
      sb('whatsapp_fila', { method: 'POST', body: [{ destino: 'oscar', tipo: 'texto', texto, origem: 'lead_site' }, { destino: 'jessica', tipo: 'texto', texto, origem: 'lead_site' }] }),
    ]);
    return res.json({ ok: true });
  } catch (e) {
    return res.status(500).json({ ok: false });
  }
};
