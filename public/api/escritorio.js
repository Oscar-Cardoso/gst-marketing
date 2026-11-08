// Escritório Virtual GST — API do painel interno.
// Os dados ficam no Supabase e só este servidor acessa (chave secreta).
// Variáveis de ambiente na Vercel:
//   SUPABASE_SERVICE_ROLE_KEY  -> chave secreta do Supabase (colocada pela integração Supabase ↔ Vercel)
//   ESCRITORIO_SENHA           -> senha compartilhada do painel
// Opcionais: SUPABASE_URL (padrão abaixo) e ESCRITORIO_SEGREDO (padrão: derivado da chave secreta)
const crypto = require('crypto');

const COOKIE = 'gst_escritorio';
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://rybbojxebmmtfhbmnopm.supabase.co';
const CHAVE = () => process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY || '';
const SEGREDO = () => process.env.ESCRITORIO_SEGREDO || (CHAVE() ? crypto.createHash('sha256').update('gst-escritorio:' + CHAVE()).digest('hex') : '');
const DIAS_SESSAO = 30;
const STATUS = ['triagem', 'a_fazer', 'em_andamento', 'aguardando_cliente', 'em_conferencia', 'concluida', 'cancelada'];
const AREAS = ['design', 'social_media', 'trafego', 'automacao', 'video', 'gestao'];
const PRIORIDADES = ['baixa', 'normal', 'alta', 'urgente'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ---------- sessão ----------
function assinar(valor) {
  return crypto.createHmac('sha256', SEGREDO()).update(valor).digest('base64url');
}
function criarToken() {
  const exp = String(Date.now() + DIAS_SESSAO * 864e5);
  return exp + '.' + assinar(exp);
}
function tokenValido(token) {
  if (!token || !SEGREDO()) return false;
  const [exp, sig] = token.split('.');
  if (!exp || !sig || Number(exp) < Date.now()) return false;
  const esperado = assinar(exp);
  return sig.length === esperado.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(esperado));
}
function lerCookie(req) {
  const m = (req.headers.cookie || '').match(new RegExp('(?:^|;\\s*)' + COOKIE + '=([^;]+)'));
  return m ? decodeURIComponent(m[1]) : null;
}
function senhaConfere(digitada) {
  const certa = process.env.ESCRITORIO_SENHA || '';
  if (!certa || typeof digitada !== 'string') return false;
  const a = crypto.createHash('sha256').update(digitada).digest();
  const b = crypto.createHash('sha256').update(certa).digest();
  return crypto.timingSafeEqual(a, b);
}

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
async function carregarDados() {
  const hoje = new Date(Date.now() - 3 * 3600e3).toISOString().slice(0, 10); // dia em Brasília
  const inicioHoje = new Date(hoje + 'T00:00:00-03:00').toISOString();
  const [clientes, equipe, responsaveis, abertas, concluidasHoje] = await Promise.all([
    sb('clientes?select=id,nome,socio,tipo_servico,contato,status,servicos,frequencia_oferta,tier,saude,emite_nota,pagamento_anuncios&order=nome'),
    sb('equipe?select=id,nome,funcao,ativo&ativo=eq.true&order=nome'),
    sb('cliente_responsaveis?select=cliente_id,equipe_id,area'),
    sb('tarefas?select=id,cliente_id,responsavel_id,titulo,descricao,area,status,prazo,prioridade,bloqueio,dependencia_id,oferta_id,pedido_original,created_at,updated_at&status=not.in.(concluida,cancelada)&order=prazo.asc.nullsfirst&limit=1000'),
    sb('tarefas?select=id,cliente_id,responsavel_id,titulo,area,status,concluida_em&status=eq.concluida&concluida_em=gte.' + encodeURIComponent(inicioHoje) + '&order=concluida_em.desc&limit=300'),
  ]);
  return { clientes, equipe, responsaveis, abertas, concluidasHoje, agora: new Date().toISOString() };
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
    sb('clientes?select=id,nome,socio,tier,mensalidade&order=nome'),
    sb('equipe?select=id,nome,funcao,ativo,custo_por_cliente,custo_fixo_mensal,custo_obs&ativo=eq.true&order=nome'),
    sb('cliente_responsaveis?select=cliente_id,equipe_id,area'),
    sb('custos_fixos?select=id,descricao,categoria,tipo,valor&ativo=eq.true&order=descricao'),
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
    for (const r of responsaveis.filter((x) => x.cliente_id === c.id)) {
      const p = pessoa[r.equipe_id];
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
  return {
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
      if (!senhaConfere(b.senha)) {
        await new Promise((r) => setTimeout(r, 800));
        return res.status(401).json({ ok: false, erro: 'Senha incorreta' });
      }
      res.setHeader('Set-Cookie', `${COOKIE}=${criarToken()}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${DIAS_SESSAO * 86400}`);
      return res.json({ ok: true });
    }
    if (acao === 'logout') {
      res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`);
      return res.json({ ok: true });
    }

    if (!tokenValido(lerCookie(req))) return res.status(401).json({ ok: false, erro: 'Faça login' });

    if (acao === 'dados' && req.method === 'GET') return res.json({ ok: true, ...(await carregarDados()) });
    if (acao === 'financeiro' && req.method === 'GET') return res.json({ ok: true, ...(await carregarFinanceiro()) });
    if (req.method !== 'POST') return res.status(405).json({ ok: false });
    const b = await lerCorpo(req);
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
