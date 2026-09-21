# ADR-002 — Organization como Tenant Boundary

- **Estado:** Accepted (tenant = Organization, CLAUDE.md §8 e brief); mecanismos de isolamento = Proposed
- **Data:** 2026-09-21

## Context
O Na Pista é multi-tenant. O Platform tem `organizations` como "business tenant". É preciso definir a fronteira,
como o tenant chega a cada pedido e como se garante isolamento numa BD separada da do Platform.

## Decision
1. O tenant é a `Organization` do Platform; `organization_id` (UUID) é coluna obrigatória em **toda** tabela de
   negócio. O Na Pista não cria entidade concorrente da empresa.
2. Existe apenas `TenantSettings` (1:1 por org) para configuração operacional (fuso, moeda); nunca copia nome/slug.
3. O tenant vem do path `/v1/organizations/{organizationId}/...` e só se torna `TenantContext` após membership
   validado (humano) ou coincidência com a org da credencial (serviço).
4. Isolamento em camadas: coluna obrigatória → FKs compostas `(organization_id, id)` → repository que exige
   `TenantContext` → testes de isolamento por endpoint → (RLS como defesa em profundidade, OD-16).
5. Recurso de outra organização responde `404`.

## Alternatives
- Tenant implícito no token/header (rejeitada: menos explícito e auditável; o Platform/Client usam o path).
- Schema/BD por tenant (rejeitada agora: complexidade operacional sem necessidade demonstrada, CLAUDE.md §14).
- Tabela `businesses` própria (rejeitada: duplica a Organization).
- Só filtragem na aplicação, sem FKs compostas (rejeitada: um bug de query vazaria dados).

## Consequences
- (+) Isolamento inequívoco e testável; mesmo modelo mental do Platform/Client.
- (−) FK para o Platform impossível → dados órfãos se a org for eliminada (OD-21).
- (−) FKs compostas exigem `UNIQUE (organization_id, id)` em todas as tabelas.
