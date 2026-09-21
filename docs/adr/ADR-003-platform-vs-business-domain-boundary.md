# ADR-003 — Fronteira Platform vs Business Domain

- **Estado:** Accepted
- **Data:** 2026-09-21

## Context
Risco recorrente de meter entidades de negócio no Platform "por conveniência" (o Platform já tem `customers`,
`entitlements`, `usage`, que se confundem facilmente com domínio de negócio).

## Decision
**UL Platform = infraestrutura SaaS transversal; Na Pista = domínio de gestão empresarial.** Nenhuma entidade de
negócio (products, orders, inventory, services, appointments, clientes de negócio, ...) no Platform. Nenhuma fonte
de verdade de identidade/organização/plano no Na Pista. Os testes de fronteira de `architecture.md` §3 fazem parte
do code review.

## Alternatives
- Platform com "módulos de negócio genéricos" (rejeitada: o Platform passaria a conhecer conceitos de negócio).
- Na Pista replicar memberships/planos para performance (rejeitada: segunda fonte de verdade de autorização).

## Consequences
- (+) O Platform mantém-se agnóstico de produto e reutilizável por Micha Express, Foi, etc.
- (−) O Na Pista depende do Platform em runtime para autorização/acesso; lacunas do Platform (PG-*) têm de ser
  contornadas ou corrigidas **no Platform**, não copiadas para o Na Pista.
