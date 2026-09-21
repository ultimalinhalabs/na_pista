# ADR-009 — Fronteira de identidade do cliente

- **Estado:** Accepted (separação); campos e ligação futura = Proposed
- **Data:** 2026-09-21

## Context
O Platform tem `customers(userId, organizationId)` (relação entre uma **conta UL** e uma org; sem API nem uso).
O Na Pista precisa de "clientes" que, na maioria, **não têm conta UL** (cliente de uma barbearia).

## Decision
`BusinessCustomer` (Na Pista) **≠** `customers` (Platform). O Na Pista tem o seu registo comercial por tenant, com
`platform_user_id` **nullable** para uma ligação explícita futura; nunca ligar por email automaticamente. O Platform
não recebe dados do `BusinessCustomer`. Um Membership nunca cria um BusinessCustomer nem vice-versa. Login do cliente
final e auto-marcação: FUTURE (OD-10), sem exigir membership (CLAUDE.md §5).

## Alternatives
- Usar a tabela `customers` do Platform (rejeitada: exige conta UL, não tem campos de negócio, sem API).
- Exigir conta UL a todo o cliente (rejeitada: fricção; contradiz a realidade dos negócios).

## Consequences
- (+) Sem mistura de identidades; os dados pessoais ficam no domínio do tenant.
- (−) Possível duplicação futura (cliente com conta UL e registo comercial) → resolvida pela ligação explícita.
- (−) Enquadramento legal dos dados pessoais por decidir (OD-22).
