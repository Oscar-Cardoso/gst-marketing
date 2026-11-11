// Agente do Escritório GST no WhatsApp: responde ao Oscar e à Jéssica na hora.
// Usa a API da Anthropic (ANTHROPIC_API_KEY na Vercel) e o Supabase do escritório.
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://rybbojxebmmtfhbmnopm.supabase.co';
const CHAVE = () => process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY || '';
const MODELO = process.env.AGENTE_MODELO || 'claude-sonnet-5-5';
const AREAS = ['design', 'social_media', 'trafego', 'automacao', 'video', 'gestao', 'comercial'];
const STATUS = ['triagem', 'a_fazer', 'em_andamento', 'aguardando_cliente', 'concluida', 'cancelada'];

async function sb(caminho, { method = 'GET', body, prefer } = {}) {
  const key = CHAVE();
  const headers = { apikey: key, 'Content-Type': 'application/json' };
  if (!key.startsWith('sb_')) headers.Authorization = 'Bearer ' + key;
  if (prefer) headers.Prefer = prefer;
  const r = await fetch(SUPABASE_URL + '/rest/v1/' + caminho, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text(); let j = null; try { j = t ? JSON.parse(t) : null; } catch { j = t; }
  if (!r.ok) throw new Error((j && (j.message || j.hint)) || 'erro no banco');
  return j;
}
const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
const GENERICO = /\b(supermercados?|sup|mercado|super|atacadista|atacarejo|loja|de|da|do|e)\b/g;
function achar(lista, nome, campo = 'nome') {
  const q = norm(nome); if (!q) return { erro: 'nome vazio' };
  const exato = lista.filter((x) => norm(x[campo]) === q);
  if (exato.length === 1) return { item: exato[0] };
  const qq = q.replace(GENERICO, ' ').trim() || q;
  const parc = lista.filter((x) => { const n = norm(x[campo]); return n.includes(qq) || (n.replace(GENERICO, ' ').trim() && qq.includes(n.replace(GENERICO, ' ').trim())); });
  if (parc.length === 1) return { item: parc[0] };
  if (!parc.length) return { erro: `não achei "${nome}"` };
  return { erro: `"${nome}" é ambíguo: ${parc.map((x) => x[campo]).join(', ')}` };
}
const agoraSP = () => new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Sao_Paulo', dateStyle: 'full', timeStyle: 'short' }).format(new Date());
const hojeSP = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date());
const fmt = (p) => p ? new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date(p)) : 'sem prazo';
function prazoISO(v) {
  if (!v) return null;
  const s = String(v).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return new Date(s + 'T18:00:00-03:00').toISOString();
  const d = new Date(/[zZ]|[+-]\d{2}:?\d{2}$/.test(s) ? s : s + '-03:00');
  return isNaN(d) ? null : d.toISOString();
}

async function base() {
  const [clientes, equipe] = await Promise.all([
    sb('clientes?select=id,nome,socio,status,tier,contato&order=nome'),
    sb('equipe?select=id,nome,funcao&ativo=eq.true&order=nome'),
  ]);
  return { clientes, equipe };
}
function linhaTarefa(t, B) {
  const p = B.equipe.find((e) => e.id === t.responsavel_id);
  const c = B.clientes.find((x) => x.id === t.cliente_id);
  const atr = t.prazo && new Date(t.prazo) < new Date() ? ' ⚠️ATRASADA' : '';
  return `[${t.id.slice(0, 8)}] ${t.titulo} · ${c ? c.nome : '—'} · ${p ? p.nome : 'sem responsável'} · ${fmt(t.prazo)} · ${t.status}${t.bloqueio ? ' · travada: ' + t.bloqueio : ''}${atr}`;
}

const FERRAMENTAS = [
  { name: 'ver_cliente', description: 'Ficha de um cliente: sócio, plano, quem cuida de cada área, tarefas abertas e últimos registros do diário.', input_schema: { type: 'object', properties: { cliente: { type: 'string' } }, required: ['cliente'] } },
  { name: 'listar_tarefas', description: 'Lista tarefas abertas. Filtros opcionais: cliente, responsavel, so_atrasadas, so_hoje.', input_schema: { type: 'object', properties: { cliente: { type: 'string' }, responsavel: { type: 'string' }, so_atrasadas: { type: 'boolean' }, so_hoje: { type: 'boolean' } } } },
  { name: 'panorama', description: 'Números do escritório agora: atrasadas, triagem, para hoje, aguardando cliente, concluídas hoje, por pessoa.', input_schema: { type: 'object', properties: {} } },
  { name: 'criar_tarefa', description: 'Cria uma tarefa. prazo em ISO (AAAA-MM-DD ou AAAA-MM-DDTHH:MM, horário de Brasília). Sem responsável ou prazo, fica em triagem.', input_schema: { type: 'object', properties: { cliente: { type: 'string' }, titulo: { type: 'string' }, responsavel: { type: 'string' }, prazo: { type: 'string' }, area: { type: 'string', enum: AREAS }, prioridade: { type: 'string', enum: ['baixa', 'normal', 'alta', 'urgente'] }, descricao: { type: 'string' } }, required: ['cliente', 'titulo'] } },
  { name: 'atualizar_tarefa', description: 'Muda uma tarefa aberta: status, responsável, prazo, prioridade ou bloqueio ("" tira o bloqueio). Identifique pelo código interno [xxxxxxxx] que aparece nos resultados das ferramentas, ou por parte do título (+ cliente).', input_schema: { type: 'object', properties: { codigo: { type: 'string' }, titulo: { type: 'string' }, cliente: { type: 'string' }, status: { type: 'string', enum: STATUS }, responsavel: { type: 'string' }, prazo: { type: 'string' }, prioridade: { type: 'string', enum: ['baixa', 'normal', 'alta', 'urgente'] }, bloqueio: { type: 'string' } } } },
  { name: 'registrar_oferta', description: 'Registra que chegou oferta de um cliente: cria o encarte para o designer e deixa social e tráfego esperando a aprovação.', input_schema: { type: 'object', properties: { cliente: { type: 'string' }, detalhes: { type: 'string' } }, required: ['cliente'] } },
  { name: 'trocar_responsavel_cliente', description: 'Define quem cuida de uma área de um cliente (design, social_media, trafego, automacao, video, gestao). Substitui quem estava.', input_schema: { type: 'object', properties: { cliente: { type: 'string' }, area: { type: 'string', enum: AREAS }, pessoa: { type: 'string' } }, required: ['cliente', 'area', 'pessoa'] } },
  { name: 'anotar_diario', description: 'Grava um registro no Diário do escritório (decisão, recado, mudança, fato importante).', input_schema: { type: 'object', properties: { resumo: { type: 'string' }, cliente: { type: 'string' }, tipo: { type: 'string', enum: ['decisao', 'nota', 'cliente', 'equipe', 'financeiro'] } }, required: ['resumo'] } },
  { name: 'consultar_processo', description: 'Base de treinamento da GST: processos, modelos e checklists de cada área (ex.: gestão de Instagram, cronograma de stories, análise de perfil). Sem argumentos lista o que existe; com texto ou area traz o conteúdo completo.', input_schema: { type: 'object', properties: { texto: { type: 'string' }, area: { type: 'string', enum: [...AREAS, 'geral'] } } } },
  { name: 'mensagens_grupo', description: 'Últimas mensagens recebidas nos grupos de WhatsApp de um cliente (o que o cliente pediu, aprovou ou perguntou).', input_schema: { type: 'object', properties: { cliente: { type: 'string' }, dias: { type: 'number' } }, required: ['cliente'] } },
  { name: 'financeiro', description: 'Fechamento mensal da GST (ago/26 em diante): receita, parte do Dimas, custos de design/tráfego/social, despesas, resultado e clientes por mês. Use para comparar meses.', input_schema: { type: 'object', properties: { meses: { type: 'number', description: 'quantos meses mais recentes (padrão 3)' } } } },
  { name: 'buscar_diario', description: 'Procura no Diário do escritório por palavra e/ou cliente (últimos 180 dias).', input_schema: { type: 'object', properties: { texto: { type: 'string' }, cliente: { type: 'string' } } } },
];

async function executar(nome, a, ctx) {
  const B = ctx.B;
  const cli = (n) => { const r = achar(B.clientes, n); if (r.erro) throw new Error(r.erro); return r.item; };
  const pes = (n) => { const r = achar(B.equipe, n); if (r.erro) throw new Error(r.erro); return r.item; };
  if (nome === 'ver_cliente') {
    const c = cli(a.cliente);
    const [resp, ab, di] = await Promise.all([
      sb('cliente_responsaveis?select=area,equipe_id&cliente_id=eq.' + c.id),
      sb('tarefas?select=id,titulo,responsavel_id,cliente_id,prazo,status,bloqueio&cliente_id=eq.' + c.id + '&status=not.in.(concluida,cancelada)&order=prazo.asc.nullsfirst&limit=30'),
      sb('diario?select=dia,tipo,resumo,quem&cliente_id=eq.' + c.id + '&order=dia.desc,created_at.desc&limit=8'),
    ]);
    return { cliente: c.nome, socio: c.socio, status: c.status, plano: c.tier, contato: c.contato,
      equipe: resp.map((r) => `${r.area}: ${(B.equipe.find((e) => e.id === r.equipe_id) || {}).nome}`),
      tarefas_abertas: ab.map((t) => linhaTarefa(t, B)), diario: di.map((d) => `${d.dia} ${d.tipo}: ${d.resumo}`) };
  }
  if (nome === 'listar_tarefas' || nome === 'panorama') {
    let q = 'tarefas?select=id,titulo,responsavel_id,cliente_id,prazo,status,bloqueio&status=not.in.(concluida,cancelada)&order=prazo.asc.nullsfirst&limit=300';
    if (a.cliente) q += '&cliente_id=eq.' + cli(a.cliente).id;
    if (a.responsavel) q += '&responsavel_id=eq.' + pes(a.responsavel).id;
    let ts = await sb(q);
    const hoje = hojeSP();
    const diaDe = (p) => p && new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date(p));
    const atrasada = (t) => t.prazo && new Date(t.prazo) < new Date() && t.status !== 'aguardando_cliente';
    if (nome === 'panorama') {
      const ok = await sb('diario?select=resumo,quem&tipo=eq.tarefa_concluida&dia=eq.' + hoje);
      const porPessoa = {};
      ts.forEach((t) => { const n = (B.equipe.find((e) => e.id === t.responsavel_id) || {}).nome || 'sem responsável'; porPessoa[n] = porPessoa[n] || { abertas: 0, atrasadas: 0 }; porPessoa[n].abertas++; if (atrasada(t)) porPessoa[n].atrasadas++; });
      return { abertas: ts.length, atrasadas: ts.filter(atrasada).map((t) => linhaTarefa(t, B)), triagem: ts.filter((t) => t.status === 'triagem').length,
        para_hoje: ts.filter((t) => diaDe(t.prazo) === hoje).map((t) => linhaTarefa(t, B)), aguardando_cliente: ts.filter((t) => t.status === 'aguardando_cliente').length,
        concluidas_hoje: ok.map((x) => `${x.resumo} (${x.quem || '—'})`), por_pessoa: porPessoa };
    }
    if (a.so_atrasadas) ts = ts.filter(atrasada);
    if (a.so_hoje) ts = ts.filter((t) => diaDe(t.prazo) === hoje);
    return { total: ts.length, tarefas: ts.slice(0, 40).map((t) => linhaTarefa(t, B)) };
  }
  if (nome === 'criar_tarefa') {
    const c = cli(a.cliente);
    const p = a.responsavel ? pes(a.responsavel) : null;
    const prazo = prazoISO(a.prazo);
    const nova = { cliente_id: c.id, titulo: String(a.titulo).slice(0, 300), descricao: a.descricao || null, area: AREAS.includes(a.area) ? a.area : null,
      responsavel_id: p ? p.id : null, prazo, prioridade: a.prioridade || 'normal', status: p && prazo ? 'a_fazer' : 'triagem',
      origem: 'whatsapp', origem_referencia: 'WhatsApp · ' + ctx.quem.nome, pedido_original: ctx.pedido.slice(0, 2000), alterado_por: ctx.quem.id };
    const r = await sb('tarefas', { method: 'POST', body: nova, prefer: 'return=representation' });
    await sb('diario?on_conflict=chave', { method: 'POST', prefer: 'return=minimal,resolution=ignore-duplicates', body: { dia: hojeSP(), cliente_id: c.id, tipo: 'tarefa_criada', resumo: `${nova.titulo}${p ? ' → ' + p.nome : ''}`, quem: ctx.quem.nome, fonte: 'whatsapp', chave: 'criada-' + r[0].id } });
    return { criada: linhaTarefa(r[0], B) };
  }
  if (nome === 'atualizar_tarefa') {
    const cod = String(a.codigo || '').toLowerCase().replace(/[^0-9a-f]/g, '').slice(0, 8);
    let achadas;
    if (cod.length === 8) achadas = await sb(`tarefas?select=id,titulo,responsavel_id,cliente_id,prazo,status,bloqueio&id=gte.${cod}-0000-0000-0000-000000000000&id=lte.${cod}-ffff-ffff-ffff-ffffffffffff`);
    else {
      if (!a.titulo) throw new Error('diga qual tarefa (parte do título e o cliente)');
      let q = 'tarefas?select=id,titulo,responsavel_id,cliente_id,prazo,status,bloqueio&status=not.in.(concluida,cancelada)&limit=200';
      if (a.cliente) q += '&cliente_id=eq.' + cli(a.cliente).id;
      const palavras = norm(a.titulo).split(' ').filter((w) => w.length > 2);
      achadas = (await sb(q)).filter((t) => palavras.every((w) => norm(t.titulo).includes(w)));
      if (achadas.length > 1) throw new Error('mais de uma tarefa parecida: ' + achadas.slice(0, 6).map((t) => linhaTarefa(t, B)).join(' | '));
    }
    if (achadas.length !== 1) throw new Error('não achei essa tarefa');
    const t = achadas[0], m = { alterado_por: ctx.quem.id };
    if (a.status) m.status = a.status;
    if (a.responsavel) m.responsavel_id = pes(a.responsavel).id;
    if (a.prazo) m.prazo = prazoISO(a.prazo);
    if (a.prioridade) m.prioridade = a.prioridade;
    if (a.bloqueio !== undefined) m.bloqueio = a.bloqueio || null;
    const fica = { ...t, ...m };
    if (!['triagem', 'cancelada'].includes(fica.status) && (!fica.responsavel_id || !fica.prazo)) throw new Error('para sair da triagem a tarefa precisa de responsável e prazo');
    if (t.status === 'triagem' && !a.status && fica.responsavel_id && fica.prazo) m.status = 'a_fazer';
    const r = await sb('tarefas?id=eq.' + t.id, { method: 'PATCH', body: m, prefer: 'return=representation' });
    return { atualizada: linhaTarefa(r[0], B) };
  }
  if (nome === 'registrar_oferta') {
    const c = cli(a.cliente);
    await sb('rpc/gst_registrar_oferta', { method: 'POST', body: { p_cliente_id: c.id, p_descricao: a.detalhes || null, p_origem: 'whatsapp', p_origem_referencia: 'WhatsApp · ' + ctx.quem.nome } });
    const ts = await sb('tarefas?select=id,titulo,responsavel_id,cliente_id,prazo,status,bloqueio&cliente_id=eq.' + c.id + '&order=created_at.desc&limit=4');
    return { oferta_registrada: c.nome, tarefas_criadas: ts.map((t) => linhaTarefa(t, B)) };
  }
  if (nome === 'trocar_responsavel_cliente') {
    const c = cli(a.cliente), p = pes(a.pessoa);
    if (!AREAS.includes(a.area) || a.area === 'comercial') throw new Error('área inválida');
    const antes = await sb(`cliente_responsaveis?select=equipe_id&cliente_id=eq.${c.id}&area=eq.${a.area}`);
    await sb(`cliente_responsaveis?cliente_id=eq.${c.id}&area=eq.${a.area}`, { method: 'DELETE' });
    await sb('cliente_responsaveis', { method: 'POST', body: { cliente_id: c.id, equipe_id: p.id, area: a.area } });
    const ant = antes.map((x) => (B.equipe.find((e) => e.id === x.equipe_id) || {}).nome).filter(Boolean).join(', ');
    await sb('diario', { method: 'POST', body: { dia: hojeSP(), cliente_id: c.id, tipo: 'equipe', resumo: `${a.area} do ${c.nome}${ant ? ' passou de ' + ant : ' ficou'} para ${p.nome}.`, quem: ctx.quem.nome, fonte: 'whatsapp' } });
    return { ok: `${a.area} do ${c.nome}: ${ant || 'ninguém'} → ${p.nome}. Tarefas já abertas continuam com quem estava.` };
  }
  if (nome === 'anotar_diario') {
    const c = a.cliente ? cli(a.cliente) : null;
    await sb('diario', { method: 'POST', body: { dia: hojeSP(), cliente_id: c ? c.id : null, tipo: a.tipo || 'nota', resumo: String(a.resumo).slice(0, 2000), quem: ctx.quem.nome, fonte: 'whatsapp' } });
    return { anotado: true };
  }
  if (nome === 'buscar_diario') {
    let q = 'diario?select=dia,tipo,resumo,quem,cliente_id&order=dia.desc,created_at.desc&limit=25&dia=gte.' + new Date(Date.now() - 180 * 864e5).toISOString().slice(0, 10);
    if (a.cliente) q += '&cliente_id=eq.' + cli(a.cliente).id;
    if (a.texto) q += '&resumo=ilike.' + encodeURIComponent('*' + String(a.texto).replace(/[*,()]/g, ' ') + '*');
    const r = await sb(q);
    return { registros: r.map((d) => `${d.dia} ${d.tipo}${d.cliente_id ? ' [' + (B.clientes.find((c) => c.id === d.cliente_id) || {}).nome + ']' : ''}: ${d.resumo}${d.quem ? ' (' + d.quem + ')' : ''}`) };
  }
  if (nome === 'consultar_processo') {
    const ps = await sb('processos?select=slug,area,titulo,resumo,tipo,conteudo,cliente_id&ativo=eq.true&order=area,titulo');
    const q = norm(a.texto || '');
    let achados = ps.filter((x) => (!a.area || x.area === a.area) && (!q || q.split(' ').every((w) => norm(x.titulo + ' ' + x.resumo + ' ' + x.conteudo).includes(w))));
    if (!a.texto && !a.area) return { processos: ps.map((x) => `${x.area} · ${x.titulo} (${x.tipo}): ${x.resumo || ''}`) };
    if (!achados.length && q) achados = ps.filter((x) => q.split(' ').some((w) => w.length > 3 && norm(x.titulo + ' ' + x.resumo).includes(w)));
    return achados.length ? { processos: achados.slice(0, 3).map((x) => ({ titulo: x.titulo, area: x.area, conteudo: x.conteudo })) } : { nada: 'não há processo cadastrado sobre isso', existentes: ps.map((x) => x.titulo) };
  }
  if (nome === 'mensagens_grupo') {
    const c = cli(a.cliente);
    const desde = new Date(Date.now() - Math.min(Number(a.dias) || 3, 30) * 864e5).toISOString();
    const ms = await sb(`whatsapp_mensagens?select=recebida_em,nome_chat,nome_remetente,de_mim,texto,tipo&cliente_id=eq.${c.id}&eh_grupo=eq.true&recebida_em=gte.${desde}&order=recebida_em.desc&limit=40`);
    const vistos = new Set();
    const lista = ms.filter((m) => { const k = (m.texto || '') + m.nome_remetente; if (vistos.has(k)) return false; vistos.add(k); return true; }).reverse();
    return lista.length ? { grupo: lista[0].nome_chat, mensagens: lista.map((m) => `${fmt(m.recebida_em)} ${m.de_mim ? 'GST (número do escritório)' : m.nome_remetente || '?'}: ${m.texto || '[' + (m.tipo || 'mídia') + ']'}`) } : { nada: 'nenhuma mensagem desse cliente no período (o número do escritório precisa estar no grupo)' };
  }
  if (nome === 'financeiro') {
    const [f, d] = await Promise.all([sb('fechamentos_mensais?select=mes,cliente_nome,socio,status,receita,custo_design,custo_trafego,custo_social,lucro_oscar,projecao&order=mes.desc'), sb('despesas_mensais?select=mes,descricao,valor')]);
    const meses = [...new Set(f.map((x) => String(x.mes).slice(0, 7)))].slice(0, Math.min(Number(a.meses) || 3, 6));
    const n = (v) => Number(v) || 0;
    return { regra: 'Clientes do Dimas: design sai antes da divisão 50/50; tráfego e social saem só da metade do Oscar. lucro_oscar já aplica a regra.', meses: meses.map((m) => {
      const ls = f.filter((x) => String(x.mes).startsWith(m)), ds = d.filter((x) => String(x.mes).startsWith(m));
      const soma = (k) => Math.round(ls.reduce((t, x) => t + n(x[k]), 0));
      const desp = Math.round(ds.reduce((t, x) => t + n(x.valor), 0));
      const resultado = soma('lucro_oscar');
      return { mes: m, projecao: ls.some((x) => x.projecao), clientes: ls.length, clientes_oscar: ls.filter((x) => x.socio !== 'dimas').length, clientes_dimas: ls.filter((x) => x.socio === 'dimas').length,
        receita_bruta: soma('receita'), custo_design: soma('custo_design'), custo_trafego: soma('custo_trafego'), custo_social: soma('custo_social'), resultado_oscar: resultado, despesas_fixas: desp, resultado_final: resultado - desp,
        lista: ls.map((x) => `${x.cliente_nome} (${x.socio}${x.status ? ', ' + x.status : ''}): receita ${Math.round(n(x.receita))}, lucro ${Math.round(n(x.lucro_oscar))}`) };
    }) };
  }
  throw new Error('ferramenta desconhecida');
}

function sistema(quem, B) {
  const ativos = B.clientes.filter((c) => !['pausado', 'encerrado'].includes(c.status));
  return `Você é o agente do Escritório Virtual da GST Marketing (agência de marketing para supermercados; dono Oscar Cardoso, sócio Dimas em parte dos clientes). Conversa pelo WhatsApp com ${quem.nome}${/j[ée]ssica/i.test(quem.nome) ? ' (esposa do Oscar, assumindo a operação; ainda aprendendo, explique de forma simples quando ajudar)' : ' (dono da GST)'}.
Agora: ${agoraSP()} (Brasília).
Responda sempre em português do Brasil, curto e direto, no estilo WhatsApp: frases curtas, listas com "•" quando houver vários itens, *negrito* do WhatsApp com asteriscos simples. Nada de markdown com # ou **. Sem enrolação.
Os códigos entre colchetes [xxxxxxxx] nos resultados são internos: use nas ferramentas, mas NUNCA mostre na resposta; cite a tarefa pelo título.
Use as ferramentas para consultar e mudar o escritório; nunca invente tarefa, número, prazo ou nome. Se a ferramenta der erro (ex.: nome ambíguo), diga o que faltou e pergunte.
Quando pedirem para fazer algo (criar tarefa, mudar responsável, registrar oferta, anotar), faça direto e confirme em uma linha o que ficou. Só pergunte antes se faltar algo essencial (qual cliente) ou se o pedido for ambíguo.
Regras: tudo o que não é marketing (precificação, margem, mix, Mapa do Lucro, estoque, curva ABC, fornecedores, financeiro da loja) vai para o responsável "Comercial · Dimas" com área comercial. Sem responsável ou prazo a tarefa fica em triagem. Prazo sem hora = 18h do dia. "Amanhã", "sexta" etc. são relativos a hoje.
Quando perguntarem como fazer algo (ou a Jéssica pedir ajuda), consulte a base de processos e responda em passo a passo, adaptado ao cliente quando houver. Quando perguntarem o que um cliente falou ou pediu, veja as mensagens do grupo.
Você não manda mensagem para clientes nem para a equipe; só responde aqui. Se pedirem isso, escreva o texto pronto para a pessoa copiar e enviar.
Clientes ativos: ${ativos.map((c) => c.nome).join(', ')}.
Equipe: ${B.equipe.map((e) => `${e.nome} (${e.funcao || ''})`).join(', ')}.`;
}

async function claude(body) {
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST', headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error('Anthropic ' + r.status + ': ' + ((j.error && j.error.message) || ''));
  return j;
}

// historico: [{de_mim, texto}] em ordem cronológica (sem a mensagem atual)
async function responder({ quem, pedido, historico = [] }) {
  if (!process.env.ANTHROPIC_API_KEY) return 'O agente ainda não está ligado: falta a ANTHROPIC_API_KEY na Vercel.';
  const B = await base();
  const ctx = { B, quem, pedido };
  const messages = [];
  for (const h of historico.slice(-12)) {
    const role = h.de_mim ? 'assistant' : 'user';
    const texto = String(h.texto || '').trim(); if (!texto) continue;
    if (messages.length && messages[messages.length - 1].role === role) messages[messages.length - 1].content += '\n' + texto;
    else messages.push({ role, content: texto });
  }
  while (messages.length && messages[0].role !== 'user') messages.shift();
  if (messages.length && messages[messages.length - 1].role === 'user') messages[messages.length - 1].content += '\n' + pedido;
  else messages.push({ role: 'user', content: pedido });
  const inicio = Date.now();
  const sys = sistema(quem, B); // fixo durante a conversa (mudar o texto invalida o raciocínio anterior)
  for (let volta = 0; volta < 8; volta++) {
    const j = await claude({ model: MODELO, max_tokens: 2000, system: sys, tools: FERRAMENTAS, messages });
    messages.push({ role: 'assistant', content: j.content });
    if (j.stop_reason !== 'tool_use') return j.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n').trim() || 'Feito.';
    const resultados = [];
    for (const c of j.content.filter((x) => x.type === 'tool_use')) {
      let out, erro = false;
      try { out = await executar(c.name, c.input || {}, ctx); } catch (e) { out = { erro: e.message }; erro = true; }
      resultados.push({ type: 'tool_result', tool_use_id: c.id, content: JSON.stringify(out).slice(0, 12000), is_error: erro });
    }
    messages.push({ role: 'user', content: resultados });
    if (Date.now() - inicio > 45000) break;
  }
  return 'Demorei demais para fechar essa. Pode repetir de forma mais curta?';
}

module.exports = { responder, executar, base };
