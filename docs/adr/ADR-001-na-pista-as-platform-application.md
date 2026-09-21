# ADR-001 — Na Pista como Application do UL Platform

- **Estado:** Accepted (derivado do CLAUDE.md §2–§4 e do código do Platform)
- **Data:** 2026-09-21

## Context
O ecossistema UL tem projectos independentes. O UL Platform já tem um registry de aplicações com `NA_PISTA`
(`applications` + planos, subscrições, chaves, scopes, meters, ambientes, integrações). É preciso decidir a relação
entre o Na Pista (produto) e o Platform (infraestrutura).

## Decision
O Na Pista é um **serviço independente** (repositório, BD e deploy próprios) que o Platform conhece como a
`Application` `NA_PISTA` — uma linha de registo, não código dentro do Platform. Comunica com o Platform **só por
API/contratos**; nunca por imports de ficheiros, caminhos relativos, tabelas partilhadas ou acesso à BD do Platform.

## Alternatives
1. Módulo dentro de `ul-platform` (rejeitada: viola CLAUDE.md §2/§3; o Platform passaria a conter domínio de negócio).
2. Monorepo Platform+produtos (rejeitada: proibido explicitamente).
3. BD partilhada com schemas separados (rejeitada: dependência por BD é o que o CLAUDE.md proíbe).

## Consequences
- (+) Ciclos de vida e deploys independentes; extracção futura trivial.
- (−) Toda a informação do Platform (membership, entitlement, chaves) chega por rede → latência, cache e
  fail-closed (ver R-03/R-06 em `f18-review.md`).
- (−) Sem FK para `organizations`: a integridade de tenant é validada por pedido (ADR-002).
