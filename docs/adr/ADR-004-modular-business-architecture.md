# ADR-004 — Arquitectura de negócio modular (capacidades, não tipos de negócio)

- **Estado:** Proposed
- **Data:** 2026-09-21

## Context
O Na Pista serve boutiques, lojas de iogurte, barbearias e híbridas. Um enum `business_type` fechado seria rígido;
o conceito descreve "módulos pré-concebidos".

## Decision
1. **Sem `business_type`.** Modelo: capacidades (`COMMERCE`, `BOOKING`, `CUSTOMERS` transversal) realizadas por
   módulos, habilitados por entitlements (`<módulo>.enabled`).
2. **Monólito modular** com fronteiras entre módulos; cada módulo tem um manifesto em código (chave, dependências,
   entitlement, permissions, meters, eventos).
3. **Module Registry mínimo = código + entitlement do Platform.** Sem tabela `modules`/`tenant_modules` (reavaliar
   só se surgir activação por escolha do tenant).
4. Entitlements agrupam módulos que não se vendem isolados (`services.enabled` = SERVICES+PROFESSIONALS;
   `appointments.enabled` = SCHEDULING+APPOINTMENTS).
5. Classificação: CORE (TENANT, PRODUCTS, CUSTOMERS) / PHASE 2 (restantes) / FUTURE.

## Alternatives
- Enum de tipos de negócio (rejeitada). Tabela de módulos persistida (rejeitada: duplica a resolução do Platform).
- Microserviço por módulo (rejeitada: CLAUDE.md §8).

## Consequences
- (+) Híbrida = soma de módulos, sem código novo; novos módulos = novo manifesto + chave de entitlement.
- (−) Chaves de entitlement/scopes/meters exigem dados novos no Platform (seed-only, PG-4).
- (−) Dependências entre módulos têm de ser validadas no arranque e em runtime.
