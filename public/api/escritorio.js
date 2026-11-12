// Escritório Virtual GST — API do painel interno.
// Os dados ficam no Supabase e só este servidor acessa (chave secreta).
// Variáveis de ambiente na Vercel:
//   SUPABASE_SERVICE_ROLE_KEY  -> chave secreta do Supabase (colocada pela integração Supabase ↔ Vercel)
//   ESCRITORIO_SENHA           -> senha do Oscar e da Jéssica (acesso total)
//   ESCRITORIO_SENHA_EQUIPE    -> senha da equipe (opcional; sem financeiro, sócio e cobrança)
// Opcionais: SUPABASE_URL (padrão abaixo) e ESCRITORIO_SEGREDO (padrão: derivado da chave secreta)
const crypto = require('crypto');

const COOKIE = 'gst_escritorio';
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://rybbojxebmmtfhbmnopm.supabase.co';
const CHAVE = () => process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY || '';
const SEGREDO = () => process.env.ESCRITORIO_SEGREDO || (CHAVE() ? crypto.createHash('sha256').update('gst-escritorio:' + CHAVE()).digest('hex') : '');
const DIAS_SESSAO = 30;
const STATUS = ['triagem', 'a_fazer', 'em_andamento', 'aguardando_cliente', 'em_conferencia', 'concluida', 'cancelada'];
const AREAS = ['design', 'social_media', 'trafego', 'automacao', 'video', 'gestao', 'comercial'];
const PRIORIDADES = ['baixa', 'normal', 'alta', 'urgente'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ---------- sessão ----------
function assinar(valor) {
  return crypto.createHmac('sha256', SEGREDO()).update(valor).digest('base64url');
}
// papel: "admin" (Oscar e Jéssica, senha ESCRITORIO_SENHA) ou "equipe" (senha ESCRITORIO_SENHA_EQUIPE, sem financeiro)
function criarToken(papel) {
  const exp = String(Date.now() + DIAS_SESSAO * 864e5);
  const p = papel === 'equipe' ? 'equipe' : 'admin';
  return exp + '.' + p + '.' + assinar(exp + '.' + p);
}
function papelDoToken(token) {
  if (!token || !SEGREDO()) return null;
  const partes = token.split('.');
  let exp, papel, sig, base;
  if (partes.length === 2) { [exp, sig] = partes; papel = 'admin'; base = exp; } // sessões antigas = admin
  else if (partes.length === 3) { [exp, papel, sig] = partes; base = exp + '.' + papel; }
  else return null;
  if (!exp || !sig || Number(exp) < Date.now() || !['admin', 'equipe'].includes(papel)) return null;
  const esperado = assinar(base);
  if (!(sig.length === esperado.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(esperado)))) return null;
  return papel;
}
function lerCookie(req) {
  const m = (req.headers.cookie || '').match(new RegExp('(?:^|;\\s*)' + COOKIE + '=([^;]+)'));
  return m ? decodeURIComponent(m[1]) : null;
}
function igual(digitada, certa) {
  if (!certa || typeof digitada !== 'string') return false;
  const a = crypto.createHash('sha256').update(digitada).digest();
  const b = crypto.createHash('sha256').update(certa).digest();
  return crypto.timingSafeEqual(a, b);
}
function papelDaSenha(digitada) {
  if (igual(digitada, process.env.ESCRITORIO_SENHA || '')) return 'admin';
  if (igual(digitada, process.env.ESCRITORIO_SENHA_EQUIPE || '')) return 'equipe';
  return null;
}
const SO_ADMIN = new Set(['financeiro', 'mensalidade', 'custo_pessoa', 'custo_fixo', 'whatsapp', 'whatsapp_ativar']);

// ---------- Supabase (REST) ----------
async function sb(caminho, { method = 'GET', body, prefer } = {}) {
  const url = SUPABASE_URL + '/rest/v1/' + caminho;
  const key = CHAVE();
  const headers = { apikey: key, 'Content-Type': 'application/json' };
  // chave antiga (service_role, começa com "eyJ") também vai no Authorization; a nova (sb_secret_...) só no apikey
  if (!key.startsWith('sb_')) headers.Authorization = 'Bearer ' + key;
  if (prefer) headers.Prefer = prefer;
  const r = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const texto = await r.text();
  let dados = null;
  try { dados = texto ? JSON.parse(texto) : null; } catch { dados = texto; }
  if (!r.ok) {
    const msg = (dados && (dados.message || dados.hint)) || 'Erro no banco';
    const e = new Error(msg); e.status = 400; throw e;
  }
  return dados;
}

function texto(v, max = 2000) {
  return typeof v === 'string' ? v.trim().slice(0, max) : '';
}
function idOuNulo(v) {
  return typeof v === 'string' && UUID.test(v) ? v : null;
}

// ---------- ações ----------
async function carregarDados(papel) {
  const hoje = new Date(Date.now() - 3 * 3600e3).toISOString().slice(0, 10); // dia em Brasília
  const inicioHoje = new Date(hoje + 'T00:00:00-03:00').toISOString();
  const [clientes, equipe, responsaveis, abertas, concluidasHoje] = await Promise.all([
    sb('clientes?select=id,nome,socio,tipo_servico,contato,status,servicos,frequencia_oferta,tier,saude,emite_nota,pagamento_anuncios&order=nome'),
    sb('equipe?select=id,nome,funcao,ativo&ativo=eq.true&order=nome'),
    sb('cliente_responsaveis?select=cliente_id,equipe_id,area'),
    sb('tarefas?select=id,cliente_id,responsavel_id,titulo,descricao,area,status,prazo,prioridade,bloqueio,dependencia_id,oferta_id,pedido_original,created_at,updated_at&status=not.in.(concluida,cancelada)&order=prazo.asc.nullsfirst&limit=1000'),
    sb('tarefas?select=id,cliente_id,responsavel_id,titulo,area,status,concluida_em&status=eq.concluida&concluida_em=gte.' + encodeURIComponent(inicioHoje) + '&order=concluida_em.desc&limit=300'),
  ]);
  // equipe não vê quem é sócio do cliente nem dados de cobrança
  const cls = papel === 'admin' ? clientes : clientes.map(({ socio, emite_nota, pagamento_anuncios, ...c }) => c);
  return { clientes: cls, equipe, responsaveis, abertas, concluidasHoje, agora: new Date().toISOString() };
}

async function carregarDiario(papel) {
  const desde = new Date(Date.now() - 180 * 864e5).toISOString().slice(0, 10);
  const diario = await sb('diario?select=id,dia,cliente_id,tipo,resumo,quem,fonte,referencia,created_at&dia=gte.' + desde + '&order=dia.desc,created_at.desc&limit=1500');
  // equipe não vê registros financeiros nem valores em reais
  return { diario: papel === 'admin' ? diario : diario.filter((d) => d.tipo !== 'financeiro' && !/R\$\s?\d|\bmensalidade|\bfaturamento|\breceita|\blucro|\bcomiss/i.test(d.resumo || '')) };
}

async function registrarOferta(b) {
  const cliente = idOuNulo(b.cliente_id);
  if (!cliente) throw Object.assign(new Error('Escolha o cliente'), { status: 400 });
  const id = await sb('rpc/gst_registrar_oferta', {
    method: 'POST',
    body: { p_cliente_id: cliente, p_descricao: texto(b.descricao) || null, p_origem: 'manual', p_origem_referencia: 'painel escritório' },
  });
  return { oferta_id: id };
}

async function atualizarTarefa(b) {
  const id = idOuNulo(b.id);
  if (!id) throw Object.assign(new Error('Tarefa inválida'), { status: 400 });
  const mudar = {};
  if (b.status !== undefined) {
    if (!STATUS.includes(b.status)) throw Object.assign(new Error('Status inválido'), { status: 400 });
    mudar.status = b.status;
  }
  if (b.responsavel_id !== undefined) mudar.responsavel_id = idOuNulo(b.responsavel_id);
  if (b.prazo !== undefined) mudar.prazo = b.prazo ? new Date(b.prazo).toISOString() : null;
  if (b.prioridade !== undefined && PRIORIDADES.includes(b.prioridade)) mudar.prioridade = b.prioridade;
  if (b.bloqueio !== undefined) mudar.bloqueio = texto(b.bloqueio, 500) || null;
  if (b.titulo !== undefined && texto(b.titulo, 300)) mudar.titulo = texto(b.titulo, 300);
  if (b.descricao !== undefined) mudar.descricao = texto(b.descricao) || null;
  // sem responsável ou prazo a tarefa volta para triagem
  if ((mudar.responsavel_id === null || mudar.prazo === null) && !['triagem', 'cancelada'].includes(mudar.status)) {
    mudar.status = 'triagem';
  }
  mudar.alterado_por = idOuNulo(b.ator_id);
  const r = await sb('tarefas?id=eq.' + id, { method: 'PATCH', body: mudar, prefer: 'return=representation' });
  return { tarefa: r && r[0] };
}

async function criarTarefa(b) {
  const cliente = idOuNulo(b.cliente_id);
  const titulo = texto(b.titulo, 300);
  if (!cliente || !titulo) throw Object.assign(new Error('Informe cliente e título'), { status: 400 });
  const responsavel = idOuNulo(b.responsavel_id);
  const prazo = b.prazo ? new Date(b.prazo).toISOString() : null;
  const nova = {
    cliente_id: cliente,
    titulo,
    descricao: texto(b.descricao) || null,
    area: AREAS.includes(b.area) ? b.area : null,
    responsavel_id: responsavel,
    prazo,
    prioridade: PRIORIDADES.includes(b.prioridade) ? b.prioridade : 'normal',
    status: responsavel && prazo ? 'a_fazer' : 'triagem',
    origem: 'manual',
    origem_referencia: 'painel escritório',
    pedido_original: texto(b.descricao) || titulo,
    alterado_por: idOuNulo(b.ator_id),
  };
  const r = await sb('tarefas', { method: 'POST', body: nova, prefer: 'return=representation' });
  return { tarefa: r && r[0] };
}

// ---------- financeiro ----------
// Regra da sociedade: nos clientes do Dimas, o design sai antes da divisão 50/50;
// tráfego e social saem só da metade da GST (Oscar).
const n2 = (v) => Math.round((Number(v) || 0) * 100) / 100;
async function carregarFinanceiro() {
  const [clientes, equipe, responsaveis, fixos] = await Promise.all([
    sb('clientes?select=id,nome,socio,tier,mensalidade,custo_design,custo_trafego,custo_social&status=not.in.(pausado,encerrado,interno)&order=nome'),
    sb('equipe?select=id,nome,funcao,ativo,custo_por_cliente,custo_fixo_mensal,custo_obs&ativo=eq.true&order=nome'),
    sb('cliente_responsaveis?select=cliente_id,equipe_id,area'),
    sb('custos_fixos?select=id,descricao,categoria,tipo,valor&ativo=eq.true&order=descricao'),
  ]);
  const [fech, desp] = await Promise.all([
    sb('fechamentos_mensais?select=mes,cliente_nome,cliente_id,socio,servico,receita,custo_design,custo_trafego,custo_social,lucro_oscar,projecao&order=mes,cliente_nome&limit=2000'),
    sb('despesas_mensais?select=mes,descricao,tipo,valor&order=mes&limit=500'),
  ]);
  const pessoa = Object.fromEntries(equipe.map((p) => [p.id, p]));
  const clientesDe = {};
  for (const r of responsaveis) (clientesDe[r.equipe_id] = clientesDe[r.equipe_id] || new Set()).add(r.cliente_id);

  const porArea = {}, porPessoa = {};
  for (const p of equipe) porPessoa[p.id] = { id: p.id, nome: p.nome, custo: 0, clientes: (clientesDe[p.id] || new Set()).size, areas: {}, regra: p.custo_obs || null, custo_por_cliente: p.custo_por_cliente, custo_fixo_mensal: p.custo_fixo_mensal, sem_valor: p.custo_por_cliente == null && p.custo_fixo_mensal == null };
  // custo fixo da pessoa sem nenhum cliente cadastrado entra inteiro
  for (const p of equipe) if (Number(p.custo_fixo_mensal) > 0 && !porPessoa[p.id].clientes) { porPessoa[p.id].custo += Number(p.custo_fixo_mensal); porArea.outros = (porArea.outros || 0) + Number(p.custo_fixo_mensal); }

  const linhas = clientes.map((c) => {
    const M = Number(c.mensalidade) || 0;
    const custos = { design: 0, outros: 0 }, contados = new Set(), det = [];
    // custo real do cliente (planilha de fechamento) substitui a regra por pessoa em design/social/tráfego
    const real = c.custo_design != null || c.custo_trafego != null || c.custo_social != null;
    const AREAS_REAIS = { design: c.custo_design, social_media: c.custo_social, trafego: c.custo_trafego };
    const resps = responsaveis.filter((x) => x.cliente_id === c.id);
    if (real) {
      for (const [area, val] of Object.entries(AREAS_REAIS)) {
        const v = Number(val) || 0;
        if (!v) continue;
        const r = resps.find((x) => x.area === area);
        const p = r && pessoa[r.equipe_id];
        if (area === 'design') custos.design += v; else custos.outros += v;
        porArea[area] = (porArea[area] || 0) + v;
        if (p) { porPessoa[p.id].custo += v; porPessoa[p.id].areas[area] = (porPessoa[p.id].areas[area] || 0) + 1; contados.add(p.id + area); }
        det.push({ pessoa: p ? p.nome : 'sem responsável', area, valor: n2(v) });
      }
    }
    for (const r of resps) {
      const p = pessoa[r.equipe_id];
      if (real && AREAS_REAIS.hasOwnProperty(r.area)) continue;
      if (!p || contados.has(p.id)) continue;
      contados.add(p.id);
      let v = 0;
      if (Number(p.custo_fixo_mensal) > 0) v = Number(p.custo_fixo_mensal) / (clientesDe[p.id].size || 1);
      else v = Number(p.custo_por_cliente) || 0;
      if (r.area === 'design') custos.design += v; else custos.outros += v;
      porArea[r.area] = (porArea[r.area] || 0) + v;
      porPessoa[p.id].custo += v;
      porPessoa[p.id].areas[r.area] = (porPessoa[p.id].areas[r.area] || 0) + 1;
      det.push({ pessoa: p.nome, area: r.area, valor: n2(v) });
    }
    const custoEquipe = custos.design + custos.outros;
    const repasse = c.socio === 'dimas' ? Math.max(0, (M - custos.design) / 2) : 0;
    const receitaGst = M - repasse;
    return { id: c.id, nome: c.nome, socio: c.socio, tier: c.tier, mensalidade: c.mensalidade == null ? null : n2(M), repasse_dimas: n2(repasse), receita_gst: n2(receitaGst), custo_equipe: n2(custoEquipe), lucro: c.mensalidade == null ? null : n2(receitaGst - custoEquipe), detalhe: det };
  });

  const soma = (k) => n2(linhas.reduce((a, l) => a + (Number(l[k]) || 0), 0));
  const receitaBruta = soma('mensalidade');
  const fixosCalc = fixos.map((f) => ({ ...f, total: n2(f.tipo === 'percentual_receita' ? receitaBruta * Number(f.valor) / 100 : Number(f.valor)) }));
  const totalFixos = n2(fixosCalc.reduce((a, f) => a + f.total, 0));
  const custoEquipeTotal = n2(Object.values(porPessoa).reduce((a, p) => a + p.custo, 0));
  const receitaGst = soma('receita_gst');
  const lucro = n2(receitaGst - custoEquipeTotal - totalFixos);
  const cat = {};
  for (const f of fixosCalc) cat[f.categoria] = n2((cat[f.categoria] || 0) + f.total);
  const meses = {};
  for (const f of fech) {
    const m = (meses[f.mes] = meses[f.mes] || { mes: f.mes, projecao: false, receita: 0, receita_oscar: 0, receita_dimas: 0, design: 0, trafego: 0, social: 0, resultado: 0, clientes: 0, despesas: 0, linhas: [] });
    const R = Number(f.receita) || 0;
    m.projecao = m.projecao || f.projecao;
    m.receita += R; if (f.socio === 'dimas') m.receita_dimas += R; else m.receita_oscar += R;
    m.design += Number(f.custo_design) || 0; m.trafego += Number(f.custo_trafego) || 0; m.social += Number(f.custo_social) || 0;
    m.resultado += Number(f.lucro_oscar) || 0;
    if (R > 0) m.clientes += 1;
    m.linhas.push({ nome: f.cliente_nome, socio: f.socio, servico: f.servico, receita: f.receita, design: f.custo_design, trafego: f.custo_trafego, social: f.custo_social, lucro: f.lucro_oscar });
  }
  const despMes = {};
  for (const d of desp) { (despMes[d.mes] = despMes[d.mes] || []).push(d); if (meses[d.mes]) meses[d.mes].despesas += Number(d.valor) || 0; }
  const historico = Object.values(meses).sort((a, b) => a.mes.localeCompare(b.mes)).map((m) => ({
    ...m, receita: n2(m.receita), receita_oscar: n2(m.receita_oscar), receita_dimas: n2(m.receita_dimas), design: n2(m.design), trafego: n2(m.trafego), social: n2(m.social),
    resultado: n2(m.resultado), despesas: n2(m.despesas), despesas_lista: despMes[m.mes] || [],
    resultado_final: despMes[m.mes] ? n2(m.resultado - m.despesas) : null,
    margem: m.receita ? Math.round((m.resultado / m.receita) * 1000) / 10 : 0,
    linhas: m.linhas.sort((a, b) => (Number(b.lucro) || 0) - (Number(a.lucro) || 0)),
  }));
  return {
    historico,
    resumo: {
      receita_bruta: receitaBruta, repasse_dimas: soma('repasse_dimas'), receita_gst: receitaGst,
      custo_equipe: custoEquipeTotal, custos_fixos: totalFixos, custo_total: n2(custoEquipeTotal + totalFixos),
      lucro, margem: receitaGst ? Math.round((lucro / receitaGst) * 1000) / 10 : 0,
      clientes_com_valor: linhas.filter((l) => l.mensalidade != null).length, clientes_total: linhas.length,
      custo_sem_mensalidade: n2(linhas.filter((l) => l.mensalidade == null).reduce((a, l) => a + l.custo_equipe, 0)),
    },
    por_area: Object.entries(porArea).map(([area, v]) => ({ area, valor: n2(v) })).sort((a, b) => b.valor - a.valor),
    por_pessoa: Object.values(porPessoa).map((p) => ({ ...p, custo: n2(p.custo) })).sort((a, b) => b.custo - a.custo),
    fixos: fixosCalc, fixos_por_categoria: cat,
    clientes: linhas.sort((a, b) => (a.lucro == null) - (b.lucro == null) || (b.lucro ?? 0) - (a.lucro ?? 0) || a.nome.localeCompare(b.nome)),
  };
}
async function salvarMensalidade(b) {
  const id = idOuNulo(b.cliente_id);
  if (!id) throw Object.assign(new Error('Cliente inválido'), { status: 400 });
  const v = b.mensalidade === '' || b.mensalidade == null ? null : Number(b.mensalidade);
  if (v != null && (!isFinite(v) || v < 0 || v > 1e6)) throw Object.assign(new Error('Valor inválido'), { status: 400 });
  await sb('clientes?id=eq.' + id, { method: 'PATCH', body: { mensalidade: v } });
  return {};
}
async function salvarCustoPessoa(b) {
  const id = idOuNulo(b.equipe_id);
  if (!id) throw Object.assign(new Error('Pessoa inválida'), { status: 400 });
  const num = (x) => (x === '' || x == null ? null : Number(x));
  const pc = num(b.custo_por_cliente), cf = num(b.custo_fixo_mensal);
  for (const v of [pc, cf]) if (v != null && (!isFinite(v) || v < 0 || v > 1e6)) throw Object.assign(new Error('Valor inválido'), { status: 400 });
  await sb('equipe?id=eq.' + id, { method: 'PATCH', body: { custo_por_cliente: pc, custo_fixo_mensal: cf, custo_obs: texto(b.custo_obs, 200) || null } });
  return {};
}
async function salvarCustoFixo(b) {
  const id = idOuNulo(b.id);
  if (b.remover && id) { await sb('custos_fixos?id=eq.' + id, { method: 'PATCH', body: { ativo: false } }); return {}; }
  const desc = texto(b.descricao, 120), v = Number(b.valor);
  if (!desc || !isFinite(v) || v < 0) throw Object.assign(new Error('Informe descrição e valor'), { status: 400 });
  const linha = { descricao: desc, categoria: texto(b.categoria, 40) || 'geral', tipo: b.tipo === 'percentual_receita' ? 'percentual_receita' : 'valor', valor: v };
  if (id) await sb('custos_fixos?id=eq.' + id, { method: 'PATCH', body: linha });
  else await sb('custos_fixos', { method: 'POST', body: linha });
  return {};
}

// ---------- WhatsApp (Uazapi) ----------
const segredoWhats = () => (process.env.UAZAPI_TOKEN ? crypto.createHash('sha256').update('gst-whatsapp:' + process.env.UAZAPI_TOKEN).digest('hex').slice(0, 40) : '');
async function uazapi(caminho, { method = 'GET', body } = {}) {
  const base = (process.env.UAZAPI_URL || '').replace(/\/+$/, '');
  if (!base || !process.env.UAZAPI_TOKEN) throw Object.assign(new Error('WhatsApp ainda não configurado na Vercel (UAZAPI_URL e UAZAPI_TOKEN).'), { status: 400 });
  const r = await fetch(base + caminho, { method, headers: { token: process.env.UAZAPI_TOKEN, 'Content-Type': 'application/json', Accept: 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch { j = { texto: t.slice(0, 300) }; }
  if (!r.ok) throw Object.assign(new Error((j && (j.error || j.message)) || 'Uazapi respondeu ' + r.status), { status: 400 });
  return j;
}
async function whatsStatus() {
  if (!process.env.UAZAPI_URL || !process.env.UAZAPI_TOKEN) return { configurado: false, faltam: ['UAZAPI_URL', 'UAZAPI_TOKEN'].filter((k) => !process.env[k]) };
  const j = await uazapi('/instance/status');
  const inst = j.instance || j;
  const st = j.status || {};
  const conectado = Boolean(st.connected ?? st.loggedIn ?? (inst.status === 'connected'));
  let webhook = null;
  try { const w = await uazapi('/webhook'); const lista = Array.isArray(w) ? w : [w]; webhook = lista.some((x) => x && x.enabled !== false && String(x.url || '').includes('/api/whatsapp')); } catch {}
  const ultima = await sb('whatsapp_mensagens?select=recebida_em&order=recebida_em.desc&limit=1');
  return { configurado: true, conectado, estado: inst.status || null, numero: inst.owner || inst.phone || null, nome: inst.profileName || inst.name || null, webhook, ultima_mensagem: ultima[0] ? ultima[0].recebida_em : null };
}
async function whatsAtivar(req) {
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  const url = 'https://' + host + '/api/whatsapp?s=' + segredoWhats();
  await uazapi('/webhook', { method: 'POST', body: { enabled: true, url, events: ['messages', 'connection'], excludeMessages: ['wasSentByApi'] } });
  return { ativado: true };
}

async function lerCorpo(req) {
  let b = req.body;
  if (typeof b === 'string') { try { b = JSON.parse(b); } catch { b = {}; } }
  return b && typeof b === 'object' ? b : {};
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Robots-Tag', 'noindex');
  const acao = (req.query && req.query.acao) || '';
  try {
    if (!CHAVE() || !process.env.ESCRITORIO_SENHA) {
      return res.status(503).json({ ok: false, erro: 'Painel ainda não configurado na Vercel (variáveis de ambiente).' });
    }

    if (acao === 'login' && req.method === 'POST') {
      const b = await lerCorpo(req);
      const papelNovo = papelDaSenha(b.senha);
      if (!papelNovo) {
        await new Promise((r) => setTimeout(r, 800));
        return res.status(401).json({ ok: false, erro: 'Senha incorreta' });
      }
      res.setHeader('Set-Cookie', `${COOKIE}=${criarToken(papelNovo)}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${DIAS_SESSAO * 86400}`);
      return res.json({ ok: true, papel: papelNovo });
    }
    if (acao === 'logout') {
      res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`);
      return res.json({ ok: true });
    }

    const papel = papelDoToken(lerCookie(req));
    if (!papel) return res.status(401).json({ ok: false, erro: 'Faça login' });
    if (papel !== 'admin' && SO_ADMIN.has(acao)) return res.status(403).json({ ok: false, erro: 'Sem acesso a essa área' });

    if (acao === 'dados' && req.method === 'GET') return res.json({ ok: true, papel, ...(await carregarDados(papel)) });
    if (acao === 'painel' && req.method === 'GET') return res.json({ ok: true, ...(await sb('rpc/gst_painel', { method: 'POST', body: {} })) });
    if (acao === 'diario' && req.method === 'GET') return res.json({ ok: true, ...(await carregarDiario(papel)) });
    if (acao === 'whatsapp' && req.method === 'GET') return res.json({ ok: true, ...(await whatsStatus()) });
    if (acao === 'financeiro' && req.method === 'GET') return res.json({ ok: true, ...(await carregarFinanceiro()) });
    if (req.method !== 'POST') return res.status(405).json({ ok: false });
    const b = await lerCorpo(req);
    if (acao === 'whatsapp_ativar') return res.json({ ok: true, ...(await whatsAtivar(req)) });
    if (acao === 'oferta') return res.json({ ok: true, ...(await registrarOferta(b)) });
    if (acao === 'tarefa') return res.json({ ok: true, ...(await atualizarTarefa(b)) });
    if (acao === 'nova') return res.json({ ok: true, ...(await criarTarefa(b)) });
    if (acao === 'mensalidade') return res.json({ ok: true, ...(await salvarMensalidade(b)) });
    if (acao === 'custo_pessoa') return res.json({ ok: true, ...(await salvarCustoPessoa(b)) });
    if (acao === 'custo_fixo') return res.json({ ok: true, ...(await salvarCustoFixo(b)) });
    return res.status(404).json({ ok: false, erro: 'Ação desconhecida' });
  } catch (e) {
    return res.status(e.status || 500).json({ ok: false, erro: e.message || 'Erro' });
  }
};
