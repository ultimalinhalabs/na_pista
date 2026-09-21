# ADR-008 — Default UI vs Custom UI

- **Estado:** Proposed
- **Data:** 2026-09-21

## Context
Clientes podem ter UI própria ou contratar à UL uma UI adaptada; o UL Client declara não ser dashboard de produto.

## Decision
Três coisas separadas: **API**, **Default UI** (repositório próprio, incluída no SaaS) e **Custom UI** (repositório
por cliente; serviço separado do acesso SaaS). Todas consomem só a API pública (OpenAPI → cliente gerado) e
`GET /capabilities` (módulos habilitados + permissions calculados pela API). Sem fork do core; código específico de
cliente só no repositório da sua Custom UI. Sem UI de negócio no UL Client nem no UL Console.

## Alternatives
- Ecrãs de negócio no UL Client (rejeitada: contradiz o seu CLAUDE.md).
- UI única configurável por flags de cliente no core (rejeitada: código de cliente no core).

## Consequences
- (+) Uma API, N UIs; o menu por módulo serve boutique/barbearia/híbrida.
- (−) Política de CORS/redirects por UI (OD-17); representação comercial do serviço de UI fora do Platform (OD-20).
