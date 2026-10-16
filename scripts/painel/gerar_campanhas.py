#!/usr/bin/env python3
"""Gera o HTML estático de agenciagst.com.br/campanhas a partir do dados.json.

Uso:
    python3 scripts/painel/gerar_campanhas.py dados.json public/campanhas/index.html

Formato do dados.json (gerado por atualizar.py):
{
  "gerado_em": "2026-10-15T07:02-03:00",
  "mes": {"since": "2026-10-01", "until": "2026-10-15"},
  "ontem": "2026-10-14",
  "clientes": [
    {
      "nome": "G2 Atacadista",
      "mes":   {"investimento": 1234.5, "campanhas": 3, "conversas": 210,
                "inv_conversas": 980.0, "impressoes": 0, "cliques": 0},
      "ontem": {mesmo formato de "mes"},
      "no_ar": [{"campanha": "...", "investimento_mes": 300.0,
                 "resultados": 45, "tipo": "conversas"}]
    }
  ],
  "sem_investimento": ["Cliente X"],
  "aguardando_meta": ["Cliente Y"]
}
"""
import html
import json
import sys
from datetime import date, datetime
from pathlib import Path

MESES = ["janeiro", "fevereiro", "março", "abril", "maio", "junho", "julho",
         "agosto", "setembro", "outubro", "novembro", "dezembro"]


def brl(v: float, casas: int = 2) -> str:
    s = f"{v:,.{casas}f}".replace(",", "X").replace(".", ",").replace("X", ".")
    return f"R$ {s}"


def num(v: float) -> str:
    return f"{int(round(v)):,}".replace(",", ".")


def d_br(iso: str) -> str:
    d = date.fromisoformat(iso[:10])
    return f"{d.day:02d}/{d.month:02d}"


def e(s) -> str:
    return html.escape(str(s))


def cpc(m: dict) -> str:
    conv = m.get("conversas", 0)
    return brl(m.get("inv_conversas", 0) / conv) if conv else "—"


def card_cliente(c: dict, maior: float, pos: int) -> str:
    m, o = c["mes"], c.get("ontem", {})
    largura = max(3, round(100 * m["investimento"] / maior)) if maior else 0
    no_ar = c.get("no_ar", [])
    if no_ar:
        itens = "".join(
            f'<li><span class="camp">{e(x["campanha"])}</span>'
            f'<span class="camp-num">{brl(x.get("investimento_mes", 0))}'
            + (f' · {num(x["resultados"])} conv.' if x.get("resultados") else "")
            + "</span></li>"
            for x in no_ar
        )
        bloco_ar = (f'<details><summary><span class="dot"></span>{len(no_ar)} '
                    f'campanha{"s" if len(no_ar) != 1 else ""} no ar agora</summary>'
                    f'<ul>{itens}</ul></details>')
    else:
        bloco_ar = '<p class="off">Nenhuma campanha no ar agora</p>'

    return f"""
<article class="card">
  <header class="card-top">
    <span class="pos">{pos}</span>
    <h3>{e(c["nome"])}</h3>
  </header>
  <div class="inv">{brl(m["investimento"])}<small>no mês</small></div>
  <div class="bar"><i style="width:{largura}%"></i></div>
  <dl class="kpis">
    <div><dt>Ontem</dt><dd>{brl(o.get("investimento", 0))}</dd></div>
    <div><dt>Campanhas</dt><dd>{m.get("campanhas", 0)}</dd></div>
    <div><dt>Conversas</dt><dd>{num(m.get("conversas", 0))}</dd></div>
    <div><dt>Custo/conversa</dt><dd>{cpc(m)}</dd></div>
  </dl>
  {bloco_ar}
</article>"""


def gerar(dados: dict) -> str:
    clientes = sorted(dados.get("clientes", []),
                      key=lambda c: c["mes"]["investimento"], reverse=True)
    sem = dados.get("sem_investimento", [])
    agu = dados.get("aguardando_meta", [])

    tot_mes = sum(c["mes"]["investimento"] for c in clientes)
    tot_ontem = sum(c.get("ontem", {}).get("investimento", 0) for c in clientes)
    tot_conv = sum(c["mes"].get("conversas", 0) for c in clientes)
    tot_inv_conv = sum(c["mes"].get("inv_conversas", 0) for c in clientes)
    tot_no_ar = sum(len(c.get("no_ar", [])) for c in clientes)
    maior = clientes[0]["mes"]["investimento"] if clientes else 0

    gerado = datetime.fromisoformat(dados["gerado_em"])
    since = date.fromisoformat(dados["mes"]["since"])
    periodo = f'{d_br(dados["mes"]["since"])} a {d_br(dados["mes"]["until"])}'
    mes_nome = MESES[since.month - 1]

    cards = "".join(card_cliente(c, maior, i + 1) for i, c in enumerate(clientes))
    if not cards:
        cards = '<p class="vazio">Nenhum cliente com investimento no período.</p>'

    def lista(titulo: str, nomes: list, nota: str, classe: str) -> str:
        if not nomes:
            return ""
        chips = "".join(f"<li>{e(n)}</li>" for n in sorted(nomes))
        return (f'<section class="extra {classe}"><h2>{titulo} <span>{len(nomes)}</span></h2>'
                f'<p>{nota}</p><ul class="chips">{chips}</ul></section>')

    return f"""<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="robots" content="noindex, nofollow">
<title>GST Marketing — Campanhas</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Poppins:wght@600;700;800&family=Inter:wght@400;500;600&display=swap" rel="stylesheet">
<style>
*,*::before,*::after{{box-sizing:border-box;margin:0;padding:0}}
:root{{--navy:#0d1b2a;--navy2:#162032;--green:#00c46a;--green-l:#e6fff4;--yellow:#f5b400;
--gray:#64748b;--bg:#f4f7fb;--text:#1e293b;--line:#e2e8f0}}
body{{font-family:Inter,system-ui,sans-serif;background:var(--bg);color:var(--text);line-height:1.45}}
h1,h2,h3{{font-family:Poppins,sans-serif}}
.wrap{{max-width:1100px;margin:0 auto;padding:0 16px}}
.top{{background:linear-gradient(135deg,var(--navy) 0%,#0a1f14 100%);color:#fff;padding:28px 0 32px}}
.logo{{font-family:Poppins,sans-serif;font-weight:800;font-size:18px}}.logo span{{color:var(--green)}}
.top h1{{font-size:clamp(22px,5vw,34px);font-weight:800;margin-top:14px;line-height:1.1}}
.top p{{color:rgba(255,255,255,.6);font-size:13px;margin-top:6px}}
.tot{{display:grid;grid-template-columns:repeat(2,1fr);gap:10px;margin-top:22px}}
.tot div{{background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.1);border-radius:12px;padding:12px 14px}}
.tot b{{display:block;font-family:Poppins,sans-serif;font-size:clamp(17px,4.5vw,24px);font-weight:700}}
.tot div:first-child b{{color:var(--green)}}
.tot small{{color:rgba(255,255,255,.6);font-size:12px}}
@media(min-width:760px){{.tot{{grid-template-columns:repeat(4,1fr)}}}}
main{{padding:22px 0 40px}}
.sec-t{{font-size:16px;font-weight:700;margin-bottom:12px;color:var(--navy)}}
.grid{{display:grid;gap:12px}}
@media(min-width:700px){{.grid{{grid-template-columns:repeat(2,1fr)}}}}
@media(min-width:1020px){{.grid{{grid-template-columns:repeat(3,1fr)}}}}
.card{{background:#fff;border:1px solid var(--line);border-radius:14px;padding:16px}}
.card-top{{display:flex;align-items:center;gap:10px}}
.pos{{flex:none;width:26px;height:26px;border-radius:50%;background:var(--navy);color:#fff;
font:600 12px/26px Poppins,sans-serif;text-align:center}}
.card h3{{font-size:15px;font-weight:600;line-height:1.25}}
.inv{{font-family:Poppins,sans-serif;font-size:24px;font-weight:700;margin-top:10px;color:var(--navy)}}
.inv small{{font:500 12px Inter,sans-serif;color:var(--gray);margin-left:6px}}
.bar{{height:6px;background:var(--bg);border-radius:6px;margin:8px 0 12px;overflow:hidden}}
.bar i{{display:block;height:100%;background:var(--green);border-radius:6px}}
.kpis{{display:grid;grid-template-columns:repeat(2,1fr);gap:8px 12px}}
.kpis dt{{font-size:11px;color:var(--gray);text-transform:uppercase;letter-spacing:.03em}}
.kpis dd{{font-weight:600;font-size:14px}}
details{{margin-top:12px;border-top:1px solid var(--line);padding-top:10px}}
summary{{cursor:pointer;font-size:13px;font-weight:600;color:#047a44;list-style:none;
display:flex;align-items:center;gap:8px;min-height:32px}}
summary::-webkit-details-marker{{display:none}}
summary::after{{content:"+";margin-left:auto;font-size:18px;color:var(--gray)}}
details[open] summary::after{{content:"−"}}
.dot{{width:8px;height:8px;border-radius:50%;background:var(--green);box-shadow:0 0 0 3px var(--green-l)}}
details ul{{list-style:none;margin-top:6px}}
details li{{display:flex;flex-direction:column;padding:7px 0;border-bottom:1px dashed var(--line);font-size:13px}}
details li:last-child{{border:0}}
.camp{{word-break:break-word}}.camp-num{{color:var(--gray);font-size:12px}}
.off{{margin-top:12px;border-top:1px solid var(--line);padding-top:10px;font-size:13px;color:var(--gray)}}
.extra{{background:#fff;border:1px solid var(--line);border-radius:14px;padding:16px;margin-top:16px}}
.extra h2{{font-size:15px;font-weight:700;color:var(--navy)}}
.extra h2 span{{font:600 12px Inter,sans-serif;background:var(--bg);border-radius:10px;padding:2px 8px;margin-left:4px}}
.extra p{{font-size:13px;color:var(--gray);margin:4px 0 10px}}
.chips{{list-style:none;display:flex;flex-wrap:wrap;gap:6px}}
.chips li{{font-size:12px;background:var(--bg);border:1px solid var(--line);border-radius:20px;padding:4px 10px}}
.aguardando{{border-color:#fde7a8}}.aguardando h2 span{{background:#fff6dc}}
.vazio{{color:var(--gray)}}
footer{{text-align:center;font-size:12px;color:var(--gray);padding:0 16px 32px}}
</style>
</head>
<body>
<div class="top"><div class="wrap">
  <div class="logo">GST<span>.</span> Marketing</div>
  <h1>Investimento em Meta Ads · {mes_nome}</h1>
  <p>Período {periodo} · atualizado em {gerado:%d/%m às %Hh%M}</p>
  <div class="tot">
    <div><b>{brl(tot_mes)}</b><small>investido no mês</small></div>
    <div><b>{brl(tot_ontem)}</b><small>ontem ({d_br(dados["ontem"])})</small></div>
    <div><b>{num(tot_conv)}</b><small>conversas · {brl(tot_inv_conv / tot_conv) if tot_conv else "—"} cada</small></div>
    <div><b>{len(clientes)} · {tot_no_ar}</b><small>clientes ativos · campanhas no ar</small></div>
  </div>
</div></div>
<main class="wrap">
  <h2 class="sec-t">Clientes por investimento no mês</h2>
  <div class="grid">{cards}</div>
  {lista("Sem investimento no mês", sem, "Contas acessíveis, mas sem gasto desde o dia 1.", "sem")}
  {lista("Aguardando acesso na Meta", agu, "O token ainda não lê estas contas (sem acesso ou conta desativada).", "aguardando")}
</main>
<footer>Atualização automática às 7h e às 18h · Dados da Meta Ads API · GST Marketing</footer>
</body>
</html>
"""


def main() -> int:
    if len(sys.argv) != 3:
        print("uso: gerar_campanhas.py dados.json saida.html", file=sys.stderr)
        return 1
    dados = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
    saida = Path(sys.argv[2])
    saida.parent.mkdir(parents=True, exist_ok=True)
    saida.write_text(gerar(dados), encoding="utf-8")
    return 0


if __name__ == "__main__":
    sys.exit(main())
