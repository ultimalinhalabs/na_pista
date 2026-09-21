# ADR-005 — API-first

- **Estado:** Accepted (brief §1 e CLAUDE.md §9)
- **Data:** 2026-09-21

## Context
"A infraestrutura será disponibilizada através de APIs." Clientes podem ter UI própria ou contratar UI à UL.

## Decision
A API do Na Pista é o produto e a **única** superfície. Versionada (`/v1`), contrato OpenAPI publicado, envelope
`{data}`/`{error}` e códigos iguais aos do Platform, paginação por cursor, `X-Request-ID`, idempotência por
`Idempotency-Key` em POSTs com efeitos, validação na fronteira, controllers finos. Nenhuma UI (nem a nossa) usa
endpoints ou acessos privados.

## Alternatives
- Backend acoplado a uma UI (BFF único) (rejeitada: impede a UI própria do cliente).
- GraphQL (rejeitada agora: sem requisito; divergiria das convenções do ecossistema).

## Consequences
- (+) Default UI, Custom UI e integradores são consumidores iguais.
- (−) Manter o contrato estável (versionamento, testes de contrato) é responsabilidade permanente.
