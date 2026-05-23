# GST Marketing — Site + Dashboard Admin

Site institucional, central de propostas e dashboard admin privado para gerenciamento de leads, propostas e playbooks.

## Instalação

```bash
npm install
npm start
```

O servidor roda em `http://localhost:3000`

## Estrutura

- `/` — Site público com form de captação
- `/propostas/` — Central visual de propostas
- `/proposta/[nome]` — Cada proposta individual
- `/admin` — Dashboard admin (protegido com senha)

## Admin

Senha: `T@ubate6`

### Funcionalidades do Admin

- 📊 **Analytics** — Total de leads, propostas, taxa de conversão
- 👥 **Leads** — Lista de leads capturados via form
- 📋 **Propostas** — Gerenciar status (Enviada, Em Negociação, Ganha, Perdida)
- 📚 **Playbooks** — Upload, listagem e filtro por 10 categorias

## Deploy na Vercel

1. Conecte seu repositório GitHub à Vercel
2. Configure a variável `PORT` se necessário
3. Deploy automático em cada push

## Dados

- Leads e propostas são salvos em `data/` (JSON)
- Playbooks são salvos em `public/uploads/playbooks/`

---

**GST Marketing** — Especialistas em Marketing para Supermercados
