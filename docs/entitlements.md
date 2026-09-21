# Entitlements (ADR-007)

## 1. Responsabilidades

```
Platform:  Plan → Subscription → Effective Entitlements   (resolve; única fonte de verdade)
Na Pista:  consome o resultado e APLICA-O nos módulos     (não duplica a resolução)
```

O Na Pista **nunca** lê `plans`/`subscriptions`, nunca reimplementa "qual plano vale". Faz uma pergunta ao
Platform e obedece. Permission ≠ Entitlement ≠ Usage (README do Platform): *o que este actor pode fazer* /
*o que a oferta comercial inclui* / *quanto foi consumido*.

## 2. Como chegam ao Na Pista (DECIDIDO pelo contrato actual)

- **Pull.** `GET /v1/organizations/:orgId/applications/NA_PISTA/entitlements` devolve
  `{ application, subscription: { id, status, planKey } | null, entitlements: [{ key, value }] }`.
  `subscription: null` + lista vazia = a org **não tem acesso** ao Na Pista (resposta 200, não erro).
- **Sem push.** O Platform não notifica mudanças de subscription/plano (PG-6). O Na Pista faz *pull* com **cache de
  TTL curto** por organização. Uma mudança de plano/cancelamento demora no máximo o TTL a ter efeito. TTL: OD-13.
- **Autenticação da chamada:** chave de serviço org-scoped de `NA_PISTA` (PG-1). Alternativa hoje: JWT do
  utilizador — **não recomendada**, pois exige `entitlement.read` (OWNER/ADMIN/MANAGER; `STAFF` falharia).

"Como as subscriptions chegam?": não chegam como objecto de gestão — o Na Pista só vê `subscription.status` e
`planKey` dentro da resolução de entitlements. Criar/cancelar subscrição acontece no Platform (UL Client, OWNER).

## 3. Semântica de resolução (regras do Na Pista, PROPOSTA — OD-13)

| Situação | Comportamento |
|---|---|
| `subscription: null` | Sem acesso: `403 ENTITLEMENT_REQUIRED` em tudo o que é de negócio. |
| `<módulo>.enabled` ausente ou `false` | Módulo desabilitado → `403 ENTITLEMENT_REQUIRED`. **Ausência = negar** (fail closed). |
| `<recurso>.max` presente (inteiro ≥ 0) | Limite. Criação com `contagem_local >= max` → `409 LIMIT_EXCEEDED`. |
| `<recurso>.max` ausente com módulo habilitado | **OPEN (OD-13):** ilimitado vs. 0. Recomendação: o plano tem de declarar explicitamente (o Na Pista trata ausente como *sem limite declarado* só se o desenho comercial o disser). |
| `subscription.status = trialing` / `past_due` | Para o Platform ainda há acesso. Política do Na Pista (bloquear escritas em `past_due`?): **OD-13**, decisão de negócio. Até lá: comporta-se como `active`. |
| `subscription.status = canceled` | Não aparece como granting → equivale a `subscription: null`. Dados **não** são apagados (OD-21). |
| Downgrade abaixo do uso actual (ex.: `max` passa a 100 com 300 produtos) | **Nunca apagar.** Bloquear **novas** criações; leituras e edições continuam. |

Contagem para limites é **local** (`SELECT count` em dados do próprio tenant, mesma transacção que a criação
protegida por lock/constraint para evitar corrida). Não se usa o `usage` do Platform para enforcement (PG-8, `usage.md`).

## 4. Catálogo inicial de entitlements (PROPOSTA — chaves não são definitivas)

Estado vs seed actual (DV-3): 📦 já existe; ➕ precisa de dado novo no Platform (PR de seed, PG-4).
Classes: **REQUIRED** (o slice 1 não funciona sem) · **OPTIONAL** (módulo/limite da Fase 2) · **FUTURE**.

| Chave | Tipo | Módulo | Classe | Seed |
|---|---|---|---|---|
| `products.enabled` | bool | PRODUCTS (+categorias) | **REQUIRED** | ➕ (hoje existe `catalog.enabled` — ver abaixo) |
| `products.max` | int | PRODUCTS | **REQUIRED** | 📦 (STARTER=100, BUSINESS=1000) |
| `customers.enabled` | bool | CUSTOMERS | OPTIONAL | ➕ |
| `customers.max` | int | CUSTOMERS | OPTIONAL | ➕ |
| `inventory.enabled` | bool | INVENTORY | OPTIONAL | ➕ |
| `orders.enabled` | bool | ORDERS | OPTIONAL | ➕ |
| `services.enabled` | bool | SERVICES + PROFESSIONALS | OPTIONAL | ➕ |
| `professionals.max` | int | PROFESSIONALS (o "max_staff" do brief) | OPTIONAL | ➕ |
| `appointments.enabled` | bool | SCHEDULING + APPOINTMENTS | OPTIONAL | ➕ |
| `appointments.max` | int (por período — OD-13) | APPOINTMENTS | OPTIONAL | ➕ |
| `advanced_reports.enabled` | bool | (relatórios) | FUTURE | 📦 |
| `locations.max` | int | INVENTORY | FUTURE | — |

**Agrupamentos deliberados** (menor abstração): `services.enabled` cobre SERVICES+PROFESSIONALS;
`appointments.enabled` cobre SCHEDULING+APPOINTMENTS — profissionais e horários não se vendem isolados do
serviço/marcação. Se um dia se vender separadamente, cria-se uma chave nova (aditivo).

**`catalog.enabled` (existente) vs `products.enabled` (proposto) — OD-14:** "catalog" é ambíguo (catálogo de
produtos ou de serviços?) e o brief sugere `products.enabled`. Recomendação: introduzir `products.enabled` e tratar
`catalog.enabled` como legado (mantido nos planos actuais até migração de dados). Decisão e migração do seed
pertencem ao dono do Platform.

## 5. Limites de estado vs. contadores de fluxo
- **Estado** (quantos *existem agora*): `products.max`, `customers.max`, `professionals.max` → contagem **local**.
- **Fluxo** (quantos *aconteceram no período*): `orders`, `appointments` → registados como usage (ver `usage.md`);
  enforcement por período, se existir, também com contagem local — **OD-13** (não se cria motor de billing).

## 6. Regras para o código (para o slice 1)
1. Um único componente `EntitlementService` no módulo `platform/` do Na Pista faz a chamada, o cache e a
   interpretação (§3). Módulos só perguntam `isEnabled(moduleKey)` / `limitFor(key)`.
2. O gate por módulo é declarativo (no manifesto do módulo), não `if` espalhado por handlers.
3. Testes cobrem: ausência, `false`, limite atingido, downgrade, Platform indisponível (fail closed), cache expirado.
