#!/usr/bin/env python3
"""Busca investimento Meta Ads dos clientes ativos e gera public/campanhas/index.html.

Uso:
    META_TOKEN=... python3 scripts/painel/atualizar.py [saida_html]

Lê scripts/painel/contas.json, grava dados.json (ao lado do HTML de saída, fora do
commit) e chama gerar_campanhas.py. Nunca imprime o token.
"""
import json
import os
import subprocess
import sys
import time
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

import requests

GRAPH_VERSION = "v23.0"
GRAPH = f"https://graph.facebook.com/{GRAPH_VERSION}"
TZ = ZoneInfo("America/Sao_Paulo")
TIMEOUT = 30
TENTATIVAS = 3
CODIGOS_LIMITE = {4, 17, 613}
ACAO_CONVERSA = "onsite_conversion.messaging_conversation_started_7d"

AQUI = Path(__file__).resolve().parent
RAIZ = AQUI.parent.parent
SAIDA_PADRAO = RAIZ / "public" / "campanhas" / "index.html"


class ErroMeta(Exception):
    """Erro da Graph API (mensagem já sem o token)."""


def _limpa(texto: str, token: str) -> str:
    return texto.replace(token, "***") if token else texto


def get(url: str, params: dict | None, token: str) -> dict:
    """GET com timeout e retry em 5xx / limite de requisições."""
    ultimo = None
    for tentativa in range(1, TENTATIVAS + 1):
        try:
            p = dict(params or {})
            if "access_token=" not in url:
                p["access_token"] = token
            r = requests.get(url, params=p, timeout=TIMEOUT)
            try:
                corpo = r.json()
            except ValueError:
                corpo = {}
            if r.status_code == 200 and "error" not in corpo:
                return corpo
            erro = corpo.get("error", {}) if isinstance(corpo, dict) else {}
            codigo = erro.get("code")
            msg = erro.get("message") or f"HTTP {r.status_code}"
            ultimo = ErroMeta(_limpa(f"{msg} (code={codigo}, http={r.status_code})", token))
            if r.status_code >= 500 or codigo in CODIGOS_LIMITE:
                time.sleep(5 * tentativa ** 2)
                continue
            raise ultimo
        except requests.RequestException as e:
            ultimo = ErroMeta(_limpa(f"{type(e).__name__}: {e}", token))
            time.sleep(5 * tentativa ** 2)
    raise ultimo


def get_tudo(url: str, params: dict, token: str) -> list:
    dados, prox, p = [], url, params
    while prox:
        corpo = get(prox, p, token)
        dados.extend(corpo.get("data", []))
        prox = corpo.get("paging", {}).get("next")
        p = None  # o "next" já traz todos os parâmetros
    return dados


def conversas(actions) -> float:
    total = 0.0
    for a in actions or []:
        if a.get("action_type") == ACAO_CONVERSA:
            total += float(a.get("value", 0) or 0)
    return total


def insights(conta: str, since: str, until: str, token: str) -> list:
    return get_tudo(
        f"{GRAPH}/act_{conta}/insights",
        {
            "level": "campaign",
            "fields": "campaign_id,campaign_name,spend,impressions,clicks,actions",
            "time_range": json.dumps({"since": since, "until": until}),
            "limit": 500,
        },
        token,
    )


def adsets_ativos(conta: str, token: str) -> list:
    return get_tudo(
        f"{GRAPH}/act_{conta}/adsets",
        {
            "fields": "campaign_id,campaign{name},effective_status,start_time,end_time",
            "filtering": json.dumps(
                [{"field": "effective_status", "operator": "IN", "value": ["ACTIVE"]}]
            ),
            "limit": 500,
        },
        token,
    )


def _dt(s: str | None):
    if not s:
        return None
    # A Graph devolve "2026-10-01T10:00:00-0300"
    return datetime.strptime(s, "%Y-%m-%dT%H:%M:%S%z")


def resumo(linhas: list) -> tuple[dict, dict]:
    """Retorna (métricas agregadas, {campaign_id: {nome, spend, conversas}})."""
    m = {"investimento": 0.0, "campanhas": 0, "conversas": 0.0,
         "inv_conversas": 0.0, "impressoes": 0, "cliques": 0}
    por_camp = {}
    for l in linhas:
        spend = float(l.get("spend", 0) or 0)
        conv = conversas(l.get("actions"))
        m["investimento"] += spend
        m["impressoes"] += int(l.get("impressions", 0) or 0)
        m["cliques"] += int(l.get("clicks", 0) or 0)
        if spend > 0:
            m["campanhas"] += 1
        if conv > 0:
            m["conversas"] += conv
            m["inv_conversas"] += spend
        por_camp[l.get("campaign_id")] = {
            "nome": l.get("campaign_name", ""), "spend": spend, "conversas": conv}
    return m, por_camp


def soma(a: dict, b: dict) -> dict:
    return {k: a.get(k, 0) + b.get(k, 0) for k in set(a) | set(b)}


def arredonda(m: dict) -> dict:
    return {k: (round(v, 2) if isinstance(v, float) else v) for k, v in m.items()}


def main() -> int:
    token = os.environ.get("META_TOKEN", "").strip()
    if not token:
        print("ERRO: variável META_TOKEN não definida.", file=sys.stderr)
        return 1

    saida = Path(sys.argv[1]) if len(sys.argv) > 1 else SAIDA_PADRAO
    saida.parent.mkdir(parents=True, exist_ok=True)

    agora = datetime.now(TZ)
    hoje = agora.date()
    inicio_mes = hoje.replace(day=1)
    ontem = hoje - timedelta(days=1)
    agora_utc = agora.astimezone(timezone.utc)

    clientes_cfg = json.loads((AQUI / "contas.json").read_text(encoding="utf-8"))["clientes"]

    clientes, sem_inv, aguardando = [], [], []
    for c in clientes_cfg:
        nome = c["nome"]
        mes_tot, ontem_tot, no_ar = {}, {}, []
        try:
            for conta in c["contas"]:
                m_mes, camp_mes = resumo(insights(conta, inicio_mes.isoformat(), hoje.isoformat(), token))
                m_ont, _ = resumo(insights(conta, ontem.isoformat(), ontem.isoformat(), token))
                mes_tot = soma(mes_tot, m_mes)
                ontem_tot = soma(ontem_tot, m_ont)

                ativas = {}
                for s in adsets_ativos(conta, token):
                    if s.get("effective_status") != "ACTIVE":
                        continue
                    ini, fim = _dt(s.get("start_time")), _dt(s.get("end_time"))
                    if ini and ini > agora_utc:
                        continue
                    if fim and fim <= agora_utc:
                        continue
                    cid = s.get("campaign_id")
                    ativas[cid] = (s.get("campaign") or {}).get("name", "")
                for cid, cnome in ativas.items():
                    info = camp_mes.get(cid, {})
                    item = {"campanha": info.get("nome") or cnome,
                            "investimento_mes": round(info.get("spend", 0.0), 2),
                            "tipo": "conversas"}
                    if info.get("conversas"):
                        item["resultados"] = int(info["conversas"])
                    no_ar.append(item)
        except ErroMeta as e:
            print(f"[aguardando] {nome}: {e}", file=sys.stderr)
            aguardando.append(nome)
            continue

        mes_tot, ontem_tot = arredonda(mes_tot), arredonda(ontem_tot)
        if not mes_tot.get("investimento"):
            sem_inv.append(nome)
            print(f"[sem investimento] {nome}")
            continue
        no_ar.sort(key=lambda x: x["investimento_mes"], reverse=True)
        clientes.append({"nome": nome, "mes": mes_tot, "ontem": ontem_tot, "no_ar": no_ar})
        print(f"[ok] {nome}: R$ {mes_tot['investimento']:.2f} no mês, {len(no_ar)} no ar")

    clientes.sort(key=lambda x: x["mes"]["investimento"], reverse=True)
    dados = {
        "gerado_em": agora.isoformat(timespec="minutes"),
        "mes": {"since": inicio_mes.isoformat(), "until": hoje.isoformat()},
        "ontem": ontem.isoformat(),
        "clientes": clientes,
        "sem_investimento": sem_inv,
        "aguardando_meta": aguardando,
    }
    caminho_dados = Path(os.environ.get("DADOS_JSON", AQUI / "dados.json"))
    caminho_dados.write_text(json.dumps(dados, ensure_ascii=False, indent=2), encoding="utf-8")

    subprocess.run(
        [sys.executable, str(AQUI / "gerar_campanhas.py"), str(caminho_dados), str(saida)],
        check=True,
    )
    print(f"OK: {len(clientes)} com investimento, {len(sem_inv)} sem investimento, "
          f"{len(aguardando)} aguardando Meta → {saida}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
