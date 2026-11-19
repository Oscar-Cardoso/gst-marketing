# Escritório Virtual GST — como o sistema funciona

Guia para qualquer pessoa ou IA que precise manter ou continuar o sistema. Atualizado em 17/11/2026.

Este repositório é **público**. Aqui não vão senhas, chaves, tokens nem dados de clientes. Os dados ficam no banco (Supabase, acesso fechado) e as chaves ficam nas variáveis de ambiente da Vercel.

## Peças

| Peça | Onde | Para quê |
| --- | --- | --- |
| Site e escritório | Vercel, este repositório (`public/`) | `agenciagst.com.br` e o painel `agenciagst.com.br/escritorio` |
| API | `public/api/*.js` (funções da Vercel; arquivos que começam com `_` não viram rota) | Login, dados do painel, WhatsApp, agente |
| Banco | Supabase, projeto `gst-marketing` | Clientes, equipe, tarefas, diário, ofertas, anúncios, fila de WhatsApp, rotinas |
| WhatsApp | Uazapi (instância do número do Fiscal) | Recebe mensagens (webhook) e envia |
| Agente "Fiscal" | `public/api/_agente.js`, usa a API da Anthropic | Responde no privado (Oscar e Jéssica), no grupo interno e nos grupos de cliente |
| Rotinas agendadas | Parte no Claude (tarefas agendadas), parte no `pg_cron` do Supabase | Fotografia do Meta, resumos, notas, ronda de ofertas, lista das 20h |

## Arquivos principais

- `public/escritorio.html`: o painel inteiro (abas Painel, Hoje, Por pessoa, Clientes, Diário, Mapa, Anúncios, Financeiro; pasta do cliente; arrastar tarefa entre pessoas; busca).
- `public/api/escritorio.js`: API do painel (`?acao=dados`, `tarefa`, `nova`, `oferta`, `pasta_cliente`, `anuncios`, `diario`, `financeiro`, `foto`, login por código no WhatsApp). A equipe (papel `equipe`) nunca recebe mensalidade, receita, lucro, sócio nem lançamentos financeiros.
- `public/api/whatsapp.js`: webhook da Uazapi. Grava tudo em `whatsapp_mensagens`; atende Oscar/Jéssica no privado (texto e, do Oscar, áudio transcrito); atende quem marca o Fiscal no grupo interno e nos grupos de cliente; conclui o encarte quando o designer avisa "ofertas aprovadas"; `?acao=despachar` envia a fila.
- `public/api/_agente.js`: o Fiscal (ferramentas, regras e textos dos três modos: privado, grupo interno, grupo de cliente), montagem da lista das 20h, da ronda das ofertas e do relatório do comercial, e o despacho da fila.

## Variáveis de ambiente (Vercel) — só os nomes

`SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` (ou `SUPABASE_SECRET_KEY`), `UAZAPI_URL`, `UAZAPI_TOKEN`, `ANTHROPIC_API_KEY`, `AGENTE_MODELO` (opcional), `OPENAI_API_KEY` (transcrição de áudio e reserva do Fiscal), `OPENAI_TRANSCRICAO_MODELO` (opcional), `OPENAI_AGENTE_MODELO` (opcional, padrão `gpt-4.1`), `ESCRITORIO_SEGREDO`, `ESCRITORIO_SENHA`, `ESCRITORIO_SENHA_EQUIPE`, `META_PIXEL_ID`, `META_CAPI_TOKEN`, `META_TEST_EVENT_CODE`.

Os valores ficam só na Vercel. Nunca no código, no chat ou em documento.

## Banco (tabelas principais)

- `clientes` (inclui `contas_meta`, `whatsapp_grupo_id`, `pasta_drive`, `tipo_servico`), `equipe` (inclui `whatsapp`, `acesso` admin/equipe/nenhum), `cliente_responsaveis` (quem cuida de cada área de cada cliente).
- `tarefas` (gatilhos: validação, histórico, libera dependentes ao concluir, diário), `ofertas`, `reunioes`, `diario`.
- `processos`: base de conhecimento e a "pasta" de cada cliente (fluxo de trabalho, ficha de tráfego).
- `meta_snapshot` / view `meta_ultimo`: fotografia das contas de anúncio; função `gst_meta_registrar(jsonb)` grava e gera alertas.
- `whatsapp_mensagens`, `whatsapp_fila` (destinos `oscar`, `jessica`, `grupo_interno`, `equipe` + `equipe_id`): tudo o que sai pelo WhatsApp passa pela fila; um gatilho com `pg_net` chama `/api/whatsapp?acao=despachar`.
- `configuracoes` (chave/valor: grupo interno, ids do Fiscal, câmbio etc.), `notas_fiscais`, `verba_movimentos`.
- `rotinas_agendadas`: **cópia das instruções de todas as rotinas agendadas** (ver abaixo).

## Rotinas agendadas

| Rotina | Quando (Brasília) | Onde roda |
| --- | --- | --- |
| Resumo da manhã (Oscar e Jéssica) | seg a sáb, 7h04 | Claude |
| Fotografia Meta Ads | 7h52, 11h52, 15h52, 19h52 | Claude (só leitura no Meta) |
| Limpeza da pasta de ofertas de um cliente | 5h41 | Claude (Google Drive) |
| Pedido de notas ao contador | dias 1 e 15, 7h36 | Claude |
| Reuniões do dia viram tarefas (Tactiq) | seg a sáb, 19h40 | Claude |
| Ronda das ofertas no privado de cada responsável | 12h | `pg_cron` + código |
| Relatório do comercial no privado da especialista | 19h | `pg_cron` + código |
| Lista de tarefas por pessoa no grupo interno | 20h | `pg_cron` + código |

As instruções completas de cada uma estão na tabela `rotinas_agendadas` do Supabase (coluna `instrucoes`), porque citam clientes e pastas. Para recriar em outra plataforma: `select nome, agenda, conectores, instrucoes from rotinas_agendadas order by slug;` e agende cada texto como uma tarefa diária de um agente que tenha acesso ao Supabase (e ao Meta Ads, Tactiq ou Google Drive, conforme a coluna `conectores`). As do `pg_cron` já rodam no próprio Supabase e não dependem de IA.

**Ao mudar uma rotina no Claude, atualize a linha correspondente em `rotinas_agendadas`.**

## Regras que o sistema segue

- O Fiscal só manda mensagem para Oscar, Jéssica e o grupo interno por conta própria. No privado de alguém da equipe, só quando Oscar ou Jéssica mandam. Em grupo de cliente, só respondendo a quem o chamou (equipe cadastrada, conferida pelo número) ou com prévia e confirmação do Oscar/Jéssica.
- No grupo de cliente o Fiscal só vê aquele cliente e nunca fala de mensalidade, cobrança, nota, lucro, sócio ou custo da equipe. A equipe só pode registrar e ajustar tarefas; feedback de números é só para Oscar e Jéssica.
- A fotografia do Meta é só leitura: nunca cria, pausa ou edita campanha.
- Demanda comercial/financeira da loja é área `comercial`: clientes do Venda Todo Dia com a especialista comercial; os demais com "Comercial · Dimas".
- Sem métricas de horas da equipe (são autônomos).

## Como continuar com outra IA ou pessoa

1. Dê acesso a este repositório, ao projeto do Supabase e à Vercel (as chaves já estão lá).
2. Peça para ler este arquivo e a tabela `rotinas_agendadas`.
3. Recrie as rotinas que rodam no Claude na nova ferramenta (ou num servidor com agendador), usando as instruções salvas.
4. O Fiscal no WhatsApp continua funcionando sozinho. Ele usa a Anthropic (Claude) e, se ela falhar (sem crédito, fora do ar), passa sozinho para a OpenAI (GPT) com a mesma conversa e as mesmas ferramentas (`public/api/_llm.js`). Mantenha crédito nas duas contas. Para trocar de modelo, use as variáveis `AGENTE_MODELO` e `OPENAI_AGENTE_MODELO`.
