// Agente do Escritório GST no WhatsApp: responde ao Oscar e à Jéssica na hora.
// Usa a API da Anthropic (ANTHROPIC_API_KEY na Vercel) e o Supabase do escritório.
const crypto = require('crypto');
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
    sb('clientes?select=id,nome,socio,status,tier,contato,pasta_drive&order=nome'),
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
  { name: 'publicar_tarefas_grupo_interno', description: 'Publica no grupo interno da equipe no WhatsApp ("GST, Estratégia e Tráfego") a lista de tarefas abertas, separada por pessoa. Use SÓ quando o Oscar ou a Jéssica pedirem explicitamente para enviar/atualizar as tarefas no grupo interno. Com previa=true só devolve o texto, sem enviar.', input_schema: { type: 'object', properties: { previa: { type: 'boolean' }, pessoas: { type: 'array', items: { type: 'string' }, description: 'opcional: só essas pessoas' } } } },
  { name: 'anuncios', description: 'Números do Meta Ads (Gerenciador de Anúncios) de cada cliente: investimento de hoje, ontem, 7 dias e do mês, campanhas ativas e sem entrega, objetivo das campanhas, e do mês: alcance, impressões, CPM, cliques no link, CTR (%), conversas iniciadas no WhatsApp/Direct, cadastros, compras e valor das compras (custo por conversa = gasto_mes/conversas_mes; ROAS = valor_compras_mes/gasto_mes), situação da conta (ACTIVE, DISABLED = bloqueada, UNSETTLED = pagamento pendente). É uma fotografia atualizada 4 vezes ao dia (8h, 12h, 16h, 20h); sempre diga o horário da coleta. Sem cliente = todas as contas.', input_schema: { type: 'object', properties: { cliente: { type: 'string', description: 'nome do cliente (opcional)' } } } },
  { name: 'modelos_mensagem', description: 'Lista os modelos de mensagem prontos para os grupos dos clientes (ex.: lembrete da lista de ofertas, pasta do Drive para vídeos), com quando usar e o texto.', input_schema: { type: 'object', properties: {} } },
  { name: 'previa_mensagem_grupos', description: 'Prepara uma mensagem para os grupos de WhatsApp de um ou mais clientes e devolve a PRÉVIA. Não envia nada. Use um modelo (slug de modelos_mensagem) ou texto_livre ditado pelo Oscar/Jéssica. clientes = lista de nomes; todos=true para todos os clientes ativos que têm grupo; grupo_interno=true para o grupo interno da equipe (comunicados à equipe). Depois mostre a prévia e pergunte se pode enviar.', input_schema: { type: 'object', properties: { modelo: { type: 'string' }, texto_livre: { type: 'string' }, clientes: { type: 'array', items: { type: 'string' } }, todos: { type: 'boolean' }, grupo_interno: { type: 'boolean' } } } },
  { name: 'confirmar_envio_grupos', description: 'Envia a última prévia preparada por previa_mensagem_grupos (de quem está falando, dos últimos 30 min). Use SÓ quando a pessoa responder que pode enviar, numa mensagem DEPOIS de ver a prévia.', input_schema: { type: 'object', properties: {} } },
  { name: 'ofertas', description: 'Quais clientes já mandaram oferta (lista de ofertas registrada no escritório) nos últimos dias e quais ainda não mandaram. Padrão: 7 dias.', input_schema: { type: 'object', properties: { dias: { type: 'number' }, cliente: { type: 'string' } } } },
  { name: 'buscar_diario', description: 'Procura no Diário do escritório por palavra e/ou cliente (últimos 180 dias).', input_schema: { type: 'object', properties: { texto: { type: 'string' }, cliente: { type: 'string' } } } },
];

const FERRAMENTAS_GRUPO = new Set(['ver_cliente', 'listar_tarefas', 'panorama', 'criar_tarefa', 'atualizar_tarefa', 'registrar_oferta', 'anotar_diario', 'consultar_processo', 'mensagens_grupo', 'anuncios', 'ofertas', 'buscar_diario']);
const financeiroTexto = (d) => d.tipo === 'financeiro' || /R\$\s?\d|\bmensalidade|\bfaturamento|\breceita|\blucro|\bcomiss/i.test(d.resumo || '');
async function executar(nome, a, ctx) {
  const B = ctx.B;
  if (ctx.modo === 'grupo') {
    if (!FERRAMENTAS_GRUPO.has(nome)) throw new Error('no grupo interno essa ação não é permitida; só o Oscar ou a Jéssica, no privado do Fiscal');
    if (nome === 'anotar_diario' && a.tipo === 'financeiro') throw new Error('registro financeiro só no privado, pelo Oscar ou pela Jéssica');
  }
  const cli = (n) => { const r = achar(B.clientes, n); if (r.erro) throw new Error(r.erro); return r.item; };
  const pes = (n) => { const r = achar(B.equipe, n); if (r.erro) throw new Error(r.erro); return r.item; };
  if (nome === 'ver_cliente') {
    const c = cli(a.cliente);
    const [resp, ab, di] = await Promise.all([
      sb('cliente_responsaveis?select=area,equipe_id&cliente_id=eq.' + c.id),
      sb('tarefas?select=id,titulo,responsavel_id,cliente_id,prazo,status,bloqueio&cliente_id=eq.' + c.id + '&status=not.in.(concluida,cancelada)&order=prazo.asc.nullsfirst&limit=30'),
      sb('diario?select=dia,tipo,resumo,quem&cliente_id=eq.' + c.id + '&order=dia.desc,created_at.desc&limit=8'),
    ]);
    const eq = ctx.modo === 'grupo' && !ctx.admin;
    return { cliente: c.nome, socio: eq ? undefined : c.socio, status: c.status, plano: c.tier, contato: c.contato, pasta_drive: c.pasta_drive || 'sem pasta cadastrada',
      equipe: resp.map((r) => `${r.area}: ${(B.equipe.find((e) => e.id === r.equipe_id) || {}).nome}`),
      tarefas_abertas: ab.map((t) => linhaTarefa(t, B)), diario: di.filter((d) => !eq || !financeiroTexto(d)).map((d) => `${d.dia} ${d.tipo}: ${d.resumo}`) };
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
    if (ctx.modo === 'grupo' && !ctx.admin) {
      if (a.responsavel) throw new Error('trocar o responsável de uma tarefa é com o Oscar ou a Jéssica (ou arrastando no escritório)');
      if (a.prazo && t.responsavel_id !== ctx.quem.id) throw new Error('só dá para mudar o prazo das suas próprias tarefas; peça ao Oscar ou à Jéssica');
    }
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
  if (nome === 'publicar_tarefas_grupo_interno') {
    const texto = await montarTarefasEquipe(B, a.pessoas, ctx.quem.nome);
    if (a.previa) return { previa: texto };
    const grupo = await grupoInterno();
    await enviarWhats(grupo.id, texto);
    await sb('diario', { method: 'POST', body: { dia: hojeSP(), tipo: 'equipe', resumo: 'Fiscal publicou as tarefas abertas por pessoa no grupo interno (' + grupo.nome + ').', quem: ctx.quem.nome, fonte: 'whatsapp' } });
    return { enviado: true, grupo: grupo.nome, caracteres: texto.length };
  }
  if (nome === 'anuncios') {
    let filtro = '';
    if (a.cliente) {
      const r = achar(B.clientes, a.cliente);
      if (r.item) filtro = '&cliente_id=eq.' + r.item.id;
      else filtro = '&rotulo=ilike.*' + encodeURIComponent(String(a.cliente).replace(/[*,()]/g, '')) + '*';
    }
    const rows = await sb('meta_ultimo?select=rotulo,conta_nome,moeda,status_conta,gasto_hoje,gasto_ontem,gasto_7d,gasto_mes,campanhas_ativas,campanhas_sem_entrega,objetivos,alcance_mes,impressoes_mes,cpm_mes,cliques_link_mes,ctr_mes,conversas_mes,leads_mes,compras_mes,valor_compras_mes,observacao,coletado_em' + filtro + '&order=gasto_mes.desc.nullslast');
    if (!rows.length) return { aviso: 'Sem fotografia do Meta para esse filtro ainda.' };
    const fmt = (d) => new Date(d).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
    return { coletado_em: fmt(rows.map((r) => r.coletado_em).sort().pop()), contas: rows.map(({ coletado_em, ...r }) => r) };
  }
  if (nome === 'modelos_mensagem') {
    const ms = await sb('mensagens_modelo?select=slug,titulo,quando_usar,texto&ativo=eq.true&order=titulo');
    return { modelos: ms };
  }
  if (nome === 'previa_mensagem_grupos') {
    let base = a.texto_livre ? String(a.texto_livre).trim() : null, mod = null;
    if (!base) {
      const ms = await sb('mensagens_modelo?select=slug,titulo,texto&ativo=eq.true');
      const r = achar(ms, a.modelo || '', 'slug').item || achar(ms, a.modelo || '', 'titulo').item;
      if (!r) throw new Error('modelo não encontrado. Existentes: ' + ms.map((x) => x.slug + ' (' + x.titulo + ')').join(', '));
      mod = r; base = r.texto;
    }
    const todosCli = await sb('clientes?select=id,nome,status,whatsapp_grupo_id,pasta_drive&order=nome');
    const ativos = todosCli.filter((c) => !['pausado', 'encerrado', 'interno'].includes(c.status));
    let alvo = [];
    if (a.todos) alvo = ativos;
    else for (const n of a.clientes || []) { const r = achar(todosCli, n); if (r.erro) throw new Error(r.erro); alvo.push(r.item); }
    if (a.grupo_interno) {
      const g = await grupoInterno();
      const texto = base.replace(/\{cliente\}/g, 'GST').replace(/\{pasta_drive\}/g, '');
      const lote = crypto.randomUUID();
      await sb('whatsapp_envios_cliente', { method: 'POST', body: [{ lote, modelo: mod ? mod.slug : null, cliente_id: null, grupo_id: g.id, grupo_nome: g.nome, texto, pedido_por: ctx.quem.nome, status: 'previa' }] });
      return { previa_de_um_grupo: texto, grupos: [g.nome], ficaram_fora: [], aviso: 'NADA foi enviado. Mostre a prévia e pergunte se pode enviar.' };
    }
    if (!alvo.length) throw new Error('diga para quais clientes (ou todos)');
    if (alvo.length > 25) throw new Error('no máximo 25 grupos por envio');
    const lote = crypto.randomUUID();
    const prontos = [], fora = [];
    for (const c of alvo) {
      let gid = c.whatsapp_grupo_id, gnome = null;
      const vistos = await sb(`whatsapp_mensagens?select=chat_id,nome_chat&cliente_id=eq.${c.id}&eh_grupo=eq.true&order=recebida_em.desc&limit=1`);
      if (!gid && vistos[0]) gid = vistos[0].chat_id;
      if (vistos[0] && vistos[0].chat_id === gid) gnome = vistos[0].nome_chat;
      if (!gid) { fora.push(c.nome + ' (o Fiscal não está em nenhum grupo desse cliente)'); continue; }
      if (base.includes('{pasta_drive}') && !c.pasta_drive) { fora.push(c.nome + ' (sem pasta do Drive cadastrada)'); continue; }
      const texto = base.replace(/\{cliente\}/g, c.nome).replace(/\{pasta_drive\}/g, c.pasta_drive || '');
      prontos.push({ lote, modelo: mod ? mod.slug : null, cliente_id: c.id, grupo_id: gid, grupo_nome: gnome, texto, pedido_por: ctx.quem.nome, status: 'previa' });
    }
    if (prontos.length) await sb('whatsapp_envios_cliente', { method: 'POST', body: prontos });
    return { previa_de_um_grupo: prontos[0] ? prontos[0].texto : null, grupos: prontos.map((x) => x.grupo_nome || (todosCli.find((c) => c.id === x.cliente_id) || {}).nome), ficaram_fora: fora, aviso: 'NADA foi enviado. Mostre a prévia e os grupos e pergunte se pode enviar.' };
  }
  if (nome === 'confirmar_envio_grupos') {
    if (!/\b(sim|pode|manda|envia|enviar|ok|confirm|bora|isso|libera|vai)/i.test(ctx.pedido || '')) throw new Error('a pessoa ainda não confirmou o envio; pergunte se pode enviar');
    const desde = new Date(Date.now() - 30 * 60e3).toISOString();
    const ult = await sb(`whatsapp_envios_cliente?select=lote,created_at&status=eq.previa&pedido_por=eq.${encodeURIComponent(ctx.quem.nome)}&created_at=gte.${desde}&order=created_at.desc&limit=1`);
    if (!ult[0]) throw new Error('não há prévia pendente dos últimos 30 minutos; prepare de novo com previa_mensagem_grupos');
    if (new Date(ult[0].created_at).getTime() >= ctx.inicio) throw new Error('a prévia acabou de ser criada nesta mesma mensagem; mostre a prévia e espere a pessoa confirmar');
    const itens = await sb(`whatsapp_envios_cliente?select=id,cliente_id,grupo_id,grupo_nome,texto,modelo&lote=eq.${ult[0].lote}&status=eq.previa`);
    const ok = [], falha = [];
    for (const [i, m] of itens.entries()) {
      const pegou = await sb('whatsapp_envios_cliente?id=eq.' + m.id + '&status=eq.previa', { method: 'PATCH', body: { status: 'enviando' }, prefer: 'return=representation' });
      if (!pegou.length) continue;
      const nomeC = (B.clientes.find((c) => c.id === m.cliente_id) || {}).nome || m.grupo_nome;
      try {
        if (i) await new Promise((r) => setTimeout(r, 1500));
        await enviarWhats(m.grupo_id, m.texto);
        await sb('whatsapp_envios_cliente?id=eq.' + m.id, { method: 'PATCH', body: { status: 'enviado', enviado_em: new Date().toISOString() } });
        await sb('diario', { method: 'POST', body: { dia: hojeSP(), cliente_id: m.cliente_id, tipo: 'cliente', resumo: `Fiscal enviou no grupo ${m.grupo_nome || 'do cliente'}: ${m.modelo ? 'modelo "' + m.modelo + '"' : 'mensagem'} (a pedido de ${ctx.quem.nome}).`, quem: ctx.quem.nome, fonte: 'whatsapp' } });
        ok.push(nomeC);
      } catch (e) {
        await sb('whatsapp_envios_cliente?id=eq.' + m.id, { method: 'PATCH', body: { status: 'erro', erro: String(e.message || e).slice(0, 300) } });
        falha.push(nomeC);
      }
    }
    return { enviados: ok, falharam: falha };
  }
  if (nome === 'ofertas') {
    const dias = Math.min(Math.max(Number(a.dias) || 7, 1), 60);
    const desde = new Date(Date.now() - dias * 864e5).toISOString();
    let q = 'ofertas?select=cliente_id,recebida_em,created_at,descricao,origem_referencia&created_at=gte.' + desde + '&order=created_at.desc&limit=300';
    if (a.cliente) q += '&cliente_id=eq.' + cli(a.cliente).id;
    const os = await sb(q);
    const ativos = B.clientes.filter((c) => ['ativo', 'implantacao'].includes(c.status));
    const ultima = {};
    os.forEach((o) => { if (!ultima[o.cliente_id]) ultima[o.cliente_id] = o; });
    return { periodo: `últimos ${dias} dias`, mandaram: Object.values(ultima).map((o) => `${(B.clientes.find((c) => c.id === o.cliente_id) || {}).nome} · ${fmt(o.recebida_em || o.created_at)}${o.origem_referencia ? ' · ' + o.origem_referencia : ''}`),
      ainda_nao: a.cliente ? undefined : ativos.filter((c) => !ultima[c.id]).map((c) => c.nome),
      obs: 'Só conta oferta registrada no escritório (botão Chegou oferta ou pelo Fiscal). Oferta que chegou no privado de alguém e não foi registrada não aparece.' };
  }
  if (nome === 'buscar_diario') {
    let q = 'diario?select=dia,tipo,resumo,quem,cliente_id&order=dia.desc,created_at.desc&limit=25&dia=gte.' + new Date(Date.now() - 180 * 864e5).toISOString().slice(0, 10);
    if (a.cliente) q += '&cliente_id=eq.' + cli(a.cliente).id;
    if (a.texto) q += '&resumo=ilike.' + encodeURIComponent('*' + String(a.texto).replace(/[*,()]/g, ' ') + '*');
    const r = (await sb(q)).filter((d) => !(ctx.modo === 'grupo' && !ctx.admin && financeiroTexto(d)));
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
  return `Você é o *Fiscal*, assistente de operações do Escritório Virtual da GST Marketing. Seu nome é Fiscal (como o fiscal de loja do supermercado: vê o que está fora do lugar, organiza e lembra). Você fica abaixo do Oscar e da Jéssica, não decide nem dá ordens à equipe; registra, organiza, lembra, mostra atrasos e prepara mensagens. Se perguntarem quem você é, responda assim em uma ou duas frases. Você é o agente do Escritório Virtual da GST Marketing (agência de marketing para supermercados; dono Oscar Cardoso, sócio Dimas em parte dos clientes). Conversa pelo WhatsApp com ${quem.nome}${/j[ée]ssica/i.test(quem.nome) ? ' (esposa do Oscar, assumindo a operação; ainda aprendendo, explique de forma simples quando ajudar)' : ' (dono da GST)'}.
Agora: ${agoraSP()} (Brasília).
Responda sempre em português do Brasil, curto e direto, no estilo WhatsApp: frases curtas, listas com "•" quando houver vários itens, *negrito* do WhatsApp com asteriscos simples. Nada de markdown com # ou **. Sem enrolação.
Os códigos entre colchetes [xxxxxxxx] nos resultados são internos: use nas ferramentas, mas NUNCA mostre na resposta; cite a tarefa pelo título.
Use as ferramentas para consultar e mudar o escritório; nunca invente tarefa, número, prazo ou nome. Se a ferramenta der erro (ex.: nome ambíguo), diga o que faltou e pergunte.
Quando pedirem para fazer algo (criar tarefa, mudar responsável, registrar oferta, anotar), faça direto e confirme em uma linha o que ficou. Só pergunte antes se faltar algo essencial (qual cliente) ou se o pedido for ambíguo.
Regras: tudo o que não é marketing (precificação, margem, mix, Mapa do Lucro, estoque, curva ABC, fornecedores, financeiro da loja) vai para o responsável "Comercial · Dimas" com área comercial. Sem responsável ou prazo a tarefa fica em triagem. Prazo sem hora = 18h do dia. "Amanhã", "sexta" etc. são relativos a hoje.
Quando perguntarem como fazer algo (ou a Jéssica pedir ajuda), consulte a base de processos e responda em passo a passo, adaptado ao cliente quando houver. Quando perguntarem o que um cliente falou ou pediu, veja as mensagens do grupo.
Você não manda mensagem para pessoas da equipe no privado; só responde aqui. Exceções:
1) Publicar as tarefas no grupo interno da equipe com publicar_tarefas_grupo_interno, só quando o Oscar ou a Jéssica pedirem claramente ("manda/atualiza as tarefas no grupo"). Se for ambíguo, mostre a prévia (previa=true) e pergunte.
2) Mensagem nos grupos dos clientes, só quando o Oscar ou a Jéssica pedirem: SEMPRE em duas etapas. Primeiro previa_mensagem_grupos (modelo pronto ou texto ditado por eles), mostre a prévia e a lista de grupos e pergunte "Posso enviar?". Só chame confirmar_envio_grupos quando a pessoa responder que sim, numa mensagem seguinte. Nunca envie para cliente por conta própria, nunca invente texto para o cliente sem pedido, e não altere o texto do modelo sem pedirem. Para ver os modelos use modelos_mensagem. Comunicados para a equipe (ex.: modelo acesso_escritorio) usam o mesmo fluxo com grupo_interno=true.
Depois de enviar, confirme em uma linha. Para outros recados, escreva o texto pronto para a pessoa copiar e enviar.
Clientes ativos: ${ativos.map((c) => c.nome).join(', ')}.
Equipe: ${B.equipe.map((e) => `${e.nome} (${e.funcao || ''})`).join(', ')}.`;
}

function sistemaGrupo(quem, B, admin) {
  const ativos = B.clientes.filter((c) => !['pausado', 'encerrado'].includes(c.status));
  return `Você é o *Fiscal*, assistente de operações do Escritório Virtual da GST Marketing (agência de marketing para supermercados). Você está respondendo no grupo interno da equipe no WhatsApp ("GST Estratégia e Tráfego"), porque ${quem.nome} te chamou. Todos do grupo leem sua resposta.
Agora: ${agoraSP()} (Brasília).
Responda em português do Brasil, curto, no estilo WhatsApp: comece chamando a pessoa pelo nome, frases curtas, listas com "•", *negrito* com asteriscos simples, sem # nem **. Responda só o que foi perguntado.
Os códigos [xxxxxxxx] nos resultados são internos: use nas ferramentas, nunca mostre.
Use as ferramentas; nunca invente tarefa, número, prazo, oferta ou nome. Se faltar algo essencial (qual cliente), pergunte em uma linha.
O que você pode fazer aqui: responder sobre a operação (tarefas, atrasos, quem cuida de cada cliente, pasta do Drive, ofertas recebidas, anúncios, processos), criar tarefa quando pedirem, concluir ou mudar o status de tarefa quando a pessoa avisar que fez ("feito", "terminei", "enviei"), registrar oferta quando avisarem que um cliente mandou (inclusive no privado de alguém), e anotar no diário.
Quando alguém avisar que fez algo, ache a tarefa e conclua; confirme em uma linha. Quando avisarem que um cliente mandou a oferta, registre a oferta (isso cria o encarte para o designer) e confirme.
${admin ? '' : 'Regras para a equipe: não fale de valores, mensalidade, receita, lucro, comissão ou de quem é sócio de cada cliente. Não troque o responsável de tarefas (isso é com o Oscar ou a Jéssica, ou arrastando no escritório) e só mude prazo das tarefas da própria pessoa. '}Você não manda mensagem em grupo de cliente nem no privado de ninguém a partir daqui: se pedirem, diga que isso é com o Oscar ou a Jéssica, no privado do Fiscal.
Tudo o que não é marketing (precificação, mix, estoque, financeiro da loja) vai para "Comercial · Dimas", área comercial. Sem responsável ou prazo a tarefa fica em triagem. Prazo sem hora = 18h do dia.
Quem está falando: ${quem.nome} (${quem.funcao || 'equipe'}).
Clientes ativos: ${ativos.map((c) => c.nome).join(', ')}.
Equipe: ${B.equipe.map((e) => `${e.nome} (${e.funcao || ''})`).join(', ')}.`;
}

// ---------- grupo interno ----------
const NOME_GRUPO_INTERNO = /estrat[ée]gia/i;
async function uaz(caminho, opt = {}) {
  const base = (process.env.UAZAPI_URL || '').replace(/\/+$/, '');
  if (!base || !process.env.UAZAPI_TOKEN) throw new Error('WhatsApp não configurado');
  const r = await fetch(base + caminho, { method: opt.method || 'GET', headers: { token: process.env.UAZAPI_TOKEN, 'Content-Type': 'application/json', Accept: 'application/json' }, body: opt.body ? JSON.stringify(opt.body) : undefined });
  const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch { j = t; }
  if (!r.ok) throw new Error('WhatsApp respondeu ' + r.status);
  return j;
}
async function enviarWhats(numero, texto) { return uaz('/send/text', { method: 'POST', body: { number: numero, text: texto } }); }
async function grupoInterno() {
  const salvo = await sb('configuracoes?select=valor&chave=eq.grupo_interno');
  if (salvo[0] && salvo[0].valor) { try { return JSON.parse(salvo[0].valor); } catch {} }
  let achado = null;
  const visto = await sb('whatsapp_mensagens?select=chat_id,nome_chat&eh_grupo=eq.true&order=recebida_em.desc&limit=500');
  const m = visto.find((x) => x.nome_chat && NOME_GRUPO_INTERNO.test(x.nome_chat) && /gst/i.test(x.nome_chat));
  if (m) achado = { id: m.chat_id, nome: m.nome_chat };
  if (!achado) {
    let lista = [];
    for (const c of ['/group/list?force=true&noparticipants=true', '/group/list']) { try { const j = await uaz(c); lista = Array.isArray(j) ? j : (j.groups || j.data || []); if (lista.length) break; } catch {} }
    const g = lista.find((x) => { const n = x.Name || x.name || x.subject || x.Subject || ''; return NOME_GRUPO_INTERNO.test(n) && /gst/i.test(n); });
    if (g) achado = { id: g.JID || g.jid || g.id || g.chatid, nome: g.Name || g.name || g.subject || g.Subject };
  }
  if (!achado || !achado.id) throw new Error('não achei o grupo interno "GST, Estratégia e Tráfego" no WhatsApp do escritório. Confira se o número do Fiscal está no grupo.');
  await sb('configuracoes?on_conflict=chave', { method: 'POST', prefer: 'resolution=merge-duplicates,return=minimal', body: { chave: 'grupo_interno', valor: JSON.stringify(achado), updated_at: new Date().toISOString() } });
  return achado;
}
async function montarTarefasEquipe(B, filtro, pedidoPor) {
  const ts = await sb('tarefas?select=id,titulo,responsavel_id,cliente_id,prazo,status,bloqueio&status=not.in.(concluida,cancelada,triagem)&responsavel_id=not.is.null&order=prazo.asc.nullslast&limit=500');
  const fora = new Set(B.equipe.filter((e) => /^oscar$/i.test(e.nome) || /comercial/i.test(e.nome)).map((e) => e.id));
  let pessoas = B.equipe.filter((e) => !fora.has(e.id));
  if (filtro && filtro.length) { const qs = filtro.map(norm); pessoas = pessoas.filter((e) => qs.some((q) => norm(e.nome).includes(q) || q.includes(norm(e.nome)))); }
  const agora = new Date();
  const dia = (p) => new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit' }).format(new Date(p));
  const blocos = [];
  for (const e of pessoas) {
    const minhas = ts.filter((t) => t.responsavel_id === e.id);
    if (!minhas.length) continue;
    const atr = minhas.filter((t) => t.prazo && new Date(t.prazo) < agora && t.status !== 'aguardando_cliente');
    const resto = minhas.filter((t) => !atr.includes(t));
    const linha = (t) => {
      const c = (B.clientes.find((x) => x.id === t.cliente_id) || {}).nome || '';
      const estado = t.status === 'aguardando_cliente' ? ' (aguardando cliente)' : t.bloqueio ? ' (travada: ' + t.bloqueio + ')' : t.status === 'em_andamento' ? ' (em andamento)' : '';
      return `• ${t.titulo}${c ? ' · ' + c : ''} · ${t.prazo ? dia(t.prazo) : 'sem prazo'}${estado}`;
    };
    const itens = [...atr.map((t) => '⚠️ ' + linha(t).slice(2)), ...resto.map(linha)];
    const mostra = itens.slice(0, 15);
    blocos.push(`*${e.nome}* (${minhas.length}${atr.length ? ', ' + atr.length + ' atrasada' + (atr.length > 1 ? 's' : '') : ''})\n${mostra.join('\n')}${itens.length > 15 ? `\n… e mais ${itens.length - 15} no painel` : ''}`);
  }
  const hoje = new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Sao_Paulo', weekday: 'long', day: '2-digit', month: '2-digit' }).format(agora);
  if (!blocos.length) return `📋 *Tarefas da equipe · ${hoje}*\n\nNenhuma tarefa aberta com responsável agora. 🎉\n\n_Fiscal · GST_`;
  return `📋 *Tarefas da equipe · ${hoje}*\n_${pedidoPor === 'rotina' ? 'Atualização automática das 20h' : 'Atualização pedida por ' + pedidoPor}. ⚠️ = atrasada._\n\n${blocos.join('\n\n')}\n\nTerminou? Marque como concluída no painel (agenciagst.com.br/escritorio) ou avise aqui no grupo.\n\n_Fiscal · GST_`;
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
async function responder({ quem, pedido, historico = [], modo = 'privado', admin = true }) {
  if (!process.env.ANTHROPIC_API_KEY) return 'O agente ainda não está ligado: falta a ANTHROPIC_API_KEY na Vercel.';
  const B = await base();
  const ctx = { B, quem, pedido, inicio: Date.now(), modo, admin };
  const ferramentas = modo === 'grupo' ? FERRAMENTAS.filter((f) => FERRAMENTAS_GRUPO.has(f.name)) : FERRAMENTAS;
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
  const sys = modo === 'grupo' ? sistemaGrupo(quem, B, admin) : sistema(quem, B); // fixo durante a conversa (mudar o texto invalida o raciocínio anterior)
  for (let volta = 0; volta < 8; volta++) {
    const j = await claude({ model: MODELO, max_tokens: 2000, system: sys, tools: ferramentas, messages });
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

// Ronda das ofertas (todo dia 12h no grupo interno): quem mandou, quem falta, encartes em aberto
async function montarRondaOfertas(B) {
  const desde = new Date(Date.now() - 7 * 864e5).toISOString();
  const [os, resp, encartes] = await Promise.all([
    sb('ofertas?select=cliente_id,recebida_em,created_at&created_at=gte.' + desde + '&order=created_at.desc&limit=500'),
    sb('cliente_responsaveis?select=cliente_id,equipe_id&area=eq.design'),
    sb('tarefas?select=id,titulo,responsavel_id,cliente_id,prazo,status&oferta_id=not.is.null&area=eq.design&status=not.in.(concluida,cancelada)&order=prazo.asc.nullslast&limit=100'),
  ]);
  const nomeC = (id) => (B.clientes.find((c) => c.id === id) || {}).nome || '';
  const nomeP = (id) => (B.equipe.find((e) => e.id === id) || {}).nome || 'sem responsável';
  const dia = (p) => new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit' }).format(new Date(p));
  const comEncarte = new Set(resp.map((r) => r.cliente_id));
  const ativos = B.clientes.filter((c) => ['ativo', 'implantacao'].includes(c.status) && comEncarte.has(c.id));
  const ultima = {};
  os.forEach((o) => { if (!ultima[o.cliente_id]) ultima[o.cliente_id] = o.recebida_em || o.created_at; });
  const mandaram = ativos.filter((c) => ultima[c.id]).map((c) => `• ${c.nome} (${dia(ultima[c.id])})`);
  const faltam = ativos.filter((c) => !ultima[c.id]).map((c) => c.nome);
  const agora = new Date();
  const abertos = encartes.map((t) => `• ${nomeC(t.cliente_id)} · ${nomeP(t.responsavel_id)}${t.prazo ? ' · ' + dia(t.prazo) : ''}${t.prazo && new Date(t.prazo) < agora ? ' ⚠️' : ''}`);
  const hoje = new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Sao_Paulo', weekday: 'long', day: '2-digit', month: '2-digit' }).format(agora);
  return [`📦 *Ronda das ofertas · ${hoje}*`, '',
    `*Ofertas registradas nos últimos 7 dias* (${mandaram.length})`, mandaram.length ? mandaram.join('\n') : 'Nenhuma ainda.', '',
    `*Ainda sem oferta registrada* (${faltam.length})`, faltam.length ? faltam.join(', ') : 'Todos em dia. 🎉', '',
    `*Encartes de oferta em aberto* (${abertos.length})`, abertos.length ? abertos.join('\n') : 'Nenhum.', '',
    'Algum cliente mandou a oferta no privado de vocês? Me avisem aqui marcando o *@Fiscal* (ex.: "@Fiscal o Aly mandou a oferta"), que eu registro e já crio o encarte.',
    'Terminou um encarte? "@Fiscal encarte do Aly feito" e eu dou baixa.', '', '_Fiscal · GST_'].join('\n');
}

// ---------- fila de envio (agentes agendados e rotina das 20h) ----------
async function despacharFila() {
  const pend = await sb('whatsapp_fila?select=id,destino,tipo,texto&status=eq.pendente&created_at=gte.' + new Date(Date.now() - 864e5).toISOString() + '&order=created_at&limit=10');
  const out = [];
  for (const m of pend) {
    const pegou = await sb('whatsapp_fila?id=eq.' + m.id + '&status=eq.pendente', { method: 'PATCH', body: { status: 'enviando' }, prefer: 'return=representation' });
    if (!pegou.length) continue;
    try {
      let numero, texto = m.texto;
      if (m.destino === 'grupo_interno') numero = (await grupoInterno()).id;
      else {
        const p = await sb('equipe?select=whatsapp&comanda_agente=eq.true&nome=eq.' + encodeURIComponent(m.destino === 'oscar' ? 'Oscar' : 'Jéssica'));
        numero = p[0] && p[0].whatsapp;
        if (!numero) throw new Error('sem WhatsApp cadastrado para ' + m.destino);
      }
      if (m.tipo === 'tarefas_equipe') texto = await montarTarefasEquipe(await base(), null, 'rotina');
      if (m.tipo === 'ronda_ofertas') texto = await montarRondaOfertas(await base());
      await enviarWhats(numero, String(texto).slice(0, 60000));
      await sb('whatsapp_fila?id=eq.' + m.id, { method: 'PATCH', body: { status: 'enviado', enviado_em: new Date().toISOString() } });
      out.push({ id: m.id, ok: true });
    } catch (e) {
      await sb('whatsapp_fila?id=eq.' + m.id, { method: 'PATCH', body: { status: 'erro', erro: String(e.message || e).slice(0, 300) } });
      out.push({ id: m.id, ok: false });
    }
  }
  return out;
}

module.exports = { responder, executar, base, despacharFila, grupoInterno, uaz, montarRondaOfertas };
