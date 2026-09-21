# ADR-010 — Primeiro vertical slice: Product Management

- **Estado:** Proposed
- **Data:** 2026-09-21

## Context
É preciso validar a integração Platform ↔ Na Pista antes de construir todos os módulos. O brief recomenda Products
mas manda não assumir.

## Decision
Slice 1 = **Product Management** (criar/listar/obter/actualizar/arquivar produtos), com autenticação, membership,
permission, entitlement (`products.enabled`, `products.max`), audit, outbox (evento + usage `api_requests`) e UI
mínima. Escolhido por: menor risco de decisões de negócio abertas, único entitlement já semeado (`products.max`),
isolamento fácil de testar exaustivamente. Limitação registada: não exercita BOOKING; mitigada por validação em papel
e slice 2 = Services/Professionals/Scheduling. Avaliação das alternativas em `vertical-slice.md` §1.

## Alternatives
- Appointments (mais arriscado, várias OD abertas).
- Customers + Orders (depende de OD-03/OD-05 e de Inventory).

## Consequences
- (+) Prova a cadeia inteira com o mínimo de regras.
- (−) O ramo BOOKING só é provado no slice 2; se a prioridade de negócio for BOOKING (OD-19) muda a ordem do slice 2,
  não o slice 1.
