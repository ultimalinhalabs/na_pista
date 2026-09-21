# Primeiro vertical slice, teste E2E-alvo e backlog

## 1. Escolha: **Product Management** (ADR-010)

O brief recomenda-o "mas não assumir automaticamente". Avaliação contra as alternativas:

| Critério (o que o slice tem de validar) | **Products** | Appointments | Customers + Orders |
|---|:-:|:-:|:-:|
| Login → org → acesso à aplicação → entitlement | ✔ | ✔ | ✔ |
| Autenticação humana + membership + permission | ✔ | ✔ | ✔ |
| Isolamento de tenant (CRUD simples, fácil de testar exaustivamente) | ✔✔ | ✔ | ✔ |
| Limite por entitlement **já existente no seed** (`products.max`) | ✔ | ✗ (`appointments.max` não existe) | ✗ |
| Audit + outbox (evento) + usage no mesmo fluxo | ✔ | ✔ | ✔ |
| Serve **os dois** ramos (COMMERCE e BOOKING)? | só COMMERCE | só BOOKING | só COMMERCE |
| Complexidade de domínio (risco de decisões em aberto) | **baixa** (OD-02/05 não bloqueiam) | **alta** (OD-09, conflitos, timezone) | média (OD-03, stock, estados) |
| Isola o que estamos a validar (infraestrutura de integração) do que não sabemos (regras de negócio) | ✔✔ | ✗ | ~ |

**Conclusão:** Products, porque valida **toda a cadeia Platform ↔ Na Pista** com o mínimo de regras de negócio por
decidir, e é a única com entitlement (`products.max`) já semeado. **Limitação reconhecida:** não exercita o
ramo BOOKING nem o modelo de tempo/conflitos; mitigação = validação em papel dos cenários A/B/C (`f18-review.md` §2)
e o **slice 2 = Services + Professionals + Scheduling** (o mais arriscado, a seguir ao Products) antes de Orders.
Se o negócio priorizar o ramo BOOKING (OD-19), o slice 1 mantém-se (é infraestrutura de integração) e o slice 2
passa a ser Appointments.

## 2. Âmbito do slice 1
**Dentro:** esqueleto do serviço (config, BD, migrações, health), verificação de JWT, cliente do Platform
(`/me`, entitlements, usage, eventos), `TenantContext`, `TenantSettings` (criação lazy), `Product` (criar, listar,
obter, actualizar, arquivar), `products.enabled`/`products.max`, permissions locais, audit de negócio, outbox
(evento `product.created|updated|archived` + usage `api_requests`), `GET /capabilities`, OpenAPI, testes, e a
mínima Default UI que lista/cria produtos (ou, se a UI ainda não existir, teste de contrato em substituição — decidir no arranque).
**Fora:** Categories (slice 1b), Customers, Inventory, Orders, Services, Appointments, variantes, billing, pagamentos,
UI personalizada, integração com Micha Express/Foi.

## 3. Fluxo

```
Login (Supabase) → Organization (path) → NA_PISTA access → Entitlement → Product API
   → Create Product → Persist → Audit → Outbox(evento + usage) → UI update
```

| Passo | Mecanismo | Funciona com o Platform de hoje? |
|---|---|---|
| Login | Supabase Auth → JWT; Na Pista verifica via JWKS | ✔ |
| Organization + membership | `GET /v1/me` com o JWT (OD-12 opção A) | ✔ (com reserva do CLAUDE.md §6) |
| NA_PISTA access | `subscription != null` na resolução de entitlements | ✔ |
| Entitlement | `GET .../NA_PISTA/entitlements` com chave org-scoped (PG-1) | ✔ com **uma chave por tenant de teste** |
| Permission | mapa local role→permission | ✔ |
| Create + limite | `count` local vs `products.max` (lock/constraint contra corrida) | ✔ (`products.max` existe) |
| `products.enabled` | precisa de dado novo no Platform, **ou** OD-14 reutilizar `catalog.enabled` no slice | ➕ dado de seed |
| Audit | `audit_events` local, mesma transacção | ✔ |
| Usage | outbox → `POST .../usage` meter `api_requests` (existe) | ✔ (com chave org-scoped `usage.write`) |
| Evento | outbox → `POST .../events` → webhook do tenant | ✔ (`event.publish`) |
| UI update | Default UI consome a API | depende de existir a UI |

## 4. Cenário E2E-alvo (aceitação do slice)

Ambiente: um Platform de teste/staging real (migrado e semeado) + Na Pista + receptor de webhook local. Sem mocks
do Platform nos testes de aceitação (mocks só em testes unitários).

**Fixture:** Org A e Org B; utilizador `ownerA` (OWNER de A), `staffA` (STAFF de A), `ownerB` (OWNER de B),
`outsider` (sem memberships). Org A subscrita a `NA_PISTA` (plano com `products.enabled=true`, `products.max=N`
pequeno num plano de teste); Org B **sem** subscrição, depois com. Chave org-scoped `NA_PISTA` de A com
`usage.write`+`event.publish`; webhook de A subscrito a `product.created`.

| # | Cenário | Esperado |
|---|---|---|
| 1 | sem token / token inválido / expirado | `401 UNAUTHORIZED` |
| 2 | `ownerA` cria produto em A | `201`, persistido, `organization_id = A` |
| 3 | `outsider` ou `ownerB` acede a `/organizations/A/products` | `403` (sem membership) |
| 4 | `ownerB` (membro de B) faz GET/PATCH/archive de um `productId` de A usando o **seu** path B | `404` (não `403`), nada alterado |
| 5 | listagem de B nunca contém produtos de A; contagem de A não conta B | ✔ |
| 6 | tentativa de referenciar categoria de outra org (slice 1b) | rejeitada pela FK composta |
| 7 | Org B sem subscrição a `NA_PISTA` | `403 ENTITLEMENT_REQUIRED` |
| 8 | `staffA` tenta criar produto | `403 FORBIDDEN` (permission) |
| 9 | criar o produto nº `N+1` | `409 LIMIT_EXCEEDED`; nº N ainda ok; edição/leitura continuam |
| 10 | SKU duplicado no mesmo tenant | `409 CONFLICT`; **mesmo SKU noutra org** é permitido |
| 11 | audit | `product.created` em `audit_events` de A com actor, `request_id`; invisível para B |
| 12 | usage | `api_requests` registado no Platform para A (replay idempotente não duplica) |
| 13 | evento | webhook de A recebe `product.created` com assinatura válida e `source.application = NA_PISTA`; B não recebe nada |
| 14 | cancelar a subscrição de A, esperar TTL | `403 ENTITLEMENT_REQUIRED`; **dados intactos** |
| 15 | Platform indisponível sem cache válido | `503`, **nenhuma** escrita, sem fuga de dados (fail closed) |
| 16 | revogar a chave de serviço / membership | efeito ≤ TTL; documentado |
| 17 | UI | produto criado aparece na lista da UI |

Cobre o brief §23: authentication (1), tenant isolation (3–6), membership (3), permission (8), entitlement
(7, 9, 14), API (2, 10), audit (11), usage (12) — mais evento (13) e resiliência (15).

## 5. Backlog técnico (ordenado; `[P]`=Platform (só dados/ops, salvo indicação), `[NP]`=na-pista, `[UI]`)

**A. Fechar decisões antes de escrever código** (bloqueiam ou moldam o slice)
- A1 Fechar **OD-11** (credencial de plataforma vs. chave por tenant) — segurança. *Bloqueia a forma de provisionar chaves.*
- A2 Fechar **OD-12** (membership via `/me` vs. novo endpoint; mapa role→permission).
- A3 Fechar **OD-13** (TTL de cache, semântica `max` ausente, `past_due`) e **OD-14** (nomes de entitlement/scopes/meters).
- A4 Fechar **OD-01** (moeda/país) no mínimo para `TenantSettings` e preço; **OD-18** (BD e hosting do Na Pista).
- A5 Spike **OD-16** (RLS + pooling) — 1 dia, com decisão registada.

**B. Platform — dados e operação (sem alterar código do Platform)**
- B1 [P] PR de seed: `products.enabled` (e restantes chaves da Fase 2 quando decididas) nos planos `NA_PISTA`; plano de teste com limite pequeno.
- B2 [P] Corrigir a documentação errada (DV-1/DV-2: catálogos aceitam credenciais de serviço).
- B3 [P] Registar endpoint `staging` real do Na Pista (`PLATFORM_ADMIN`, UL Console).
- B4 [P] (se A1 → opção B) desenhar e implementar credencial de aplicação com autoridade sobre orgs subscritas — **mudança de código do Platform, security-sensitive, ADR próprio no Platform**.

**C. Fundação do Na Pista**
- C1 [NP] Repositório: linguagem/stack (alinhado com o resto, decisão no arranque), lint, CI, `.env.example`, sem segredos.
- C2 [NP] Config validada, logger estruturado, `X-Request-ID`, envelope/erros, health/ready.
- C3 [NP] BD própria + migrações + `TenantSettings`.
- C4 [NP] `auth/`: verificação de JWT (JWKS) + testes de token inválido/expirado/audience errada.
- C5 [NP] `platform/`: cliente do Platform (timeouts, cache curto, fail closed), `EntitlementService`, `MembershipResolver`.
- C6 [NP] `tenancy/`: `TenantContext`, middleware, repository base que **exige** tenant, harness de teste de isolamento.
- C7 [NP] Audit de negócio + outbox + dispatcher (usage e eventos).
- C8 [NP] Manifesto de módulo + `GET /capabilities` + OpenAPI.

**D. Slice 1**
- D1 [NP] Módulo PRODUCTS: schema, CRUD, arquivar, SKU único, `products.max` local, permissions.
- D2 [NP] Testes E2E §4 (todos).
- D3 [UI] Repositório da Default UI + login + lista/criação de produtos por `capabilities`.
- D4 [P/NP] Provisionar chave org-scoped + webhook de teste; runbook.
- D5 [NP] Slice 1b: Categories.

**E. Preparação da Fase 2** (só depois de D2 verde)
- E1 Fechar OD-02/03/04/05/09 com o negócio; E2 slice 2 (ordem por OD-19); E3 seed de scopes/meters/entitlements que a Fase 2 exige (`appointments` meter, scopes de orders/appointments).
- E4 Política de ciclo de vida do tenant (OD-21) e privacidade (OD-22) **antes** de guardar dados pessoais de clientes reais.
