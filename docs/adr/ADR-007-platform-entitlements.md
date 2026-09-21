# ADR-007 — Entitlements resolvidos pelo Platform, aplicados pelo Na Pista

- **Estado:** Accepted (princípio); vocabulário e semântica = Proposed (OD-13/OD-14)
- **Data:** 2026-09-21

## Context
O Platform resolve `Plan → Subscription → Effective Entitlements` (síncrono, sem cache) e `plan_entitlements` tem
chaves livres. O Na Pista tem de saber que módulos/limites uma org tem.

## Decision
O Na Pista **consome** os entitlements efectivos do Platform (pull, cache curto, fail closed) e **aplica-os**; nunca
duplica a resolução nem lê planos/subscrições. Habilitação de módulo = `<módulo>.enabled` (ausência = negar);
limites de estado = `<recurso>.max` comparados com contagens **locais**; o usage do Platform não serve para
enforcement (é forjável pelo tenant, PG-8). Downgrade nunca apaga dados: bloqueia novas criações.

## Alternatives
- Copiar entitlements para a BD do Na Pista (rejeitada: dessincroniza).
- Usar a tabela `entitlements` do Platform (existe mas não é usada hoje).
- Enforcement por usage do Platform (rejeitada: PG-8).

## Consequences
- (+) Uma só fonte de verdade comercial.
- (−) Sem push do Platform (PG-6): mudanças demoram até ao TTL.
- (−) Novas chaves = PR de seed no Platform (PG-4).
