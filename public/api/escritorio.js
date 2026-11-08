// Escritório Virtual GST — API do painel interno.
// Os dados ficam no Supabase e só este servidor acessa (chave secreta).
// Variáveis de ambiente na Vercel:
//   SUPABASE_URL               -> https://rybbojxebmmtfhbmnopm.supabase.co
//   SUPABASE_SERVICE_ROLE_KEY  -> chave secreta (service_role) do Supabase
//   ESCRITORIO_SENHA           -> senha compartilhada do painel
//   ESCRITORIO_SEGREDO         -> texto aleatório longo usado para assinar o login
const crypto = require('crypto');

const COOKIE = 'gst_escritorio';
const DIAS_SESSAO = 30;
const STATUS = ['triagem', 'a_fazer', 'em_andamento', 'aguardando_cliente', 'em_conferencia', 'concluida', 'cancelada'];
const AREAS = ['design', 'social_media', 'trafego', 'automacao', 'video', 'gestao'];
const PRIORIDADES = ['baixa', 'normal', 'alta', 'urgente'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ---------- sessão ----------
function assinar(valor) {
  return crypto.createHmac('sha256', process.env.ESCRITORIO_SEGREDO || '').update(valor).digest('base64url');
}
function criarToken() {
  const exp = String(Date.now() + DIAS_SESSAO * 864e5);
  return exp + '.' + assinar(exp);
}
function tokenValido(token) {
  if (!token || !process.env.ESCRITORIO_SEGREDO) return false;
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
  const url = process.env.SUPABASE_URL + '/rest/v1/' + caminho;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
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
    sb('clientes?select=id,nome,socio,tipo_servico,contato,status,servicos,frequencia_oferta&order=nome'),
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
    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY || !process.env.ESCRITORIO_SENHA || !process.env.ESCRITORIO_SEGREDO) {
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
    if (req.method !== 'POST') return res.status(405).json({ ok: false });
    const b = await lerCorpo(req);
    if (acao === 'oferta') return res.json({ ok: true, ...(await registrarOferta(b)) });
    if (acao === 'tarefa') return res.json({ ok: true, ...(await atualizarTarefa(b)) });
    if (acao === 'nova') return res.json({ ok: true, ...(await criarTarefa(b)) });
    return res.status(404).json({ ok: false, erro: 'Ação desconhecida' });
  } catch (e) {
    return res.status(e.status || 500).json({ ok: false, erro: e.message || 'Erro' });
  }
};
