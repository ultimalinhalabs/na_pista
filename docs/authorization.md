# Autenticação e autorização

## 1. Autenticação humana (DECIDIDO — ADR-006)

```
User → Supabase Auth → JWT → Na Pista → (Platform: identidade/organização) → Membership → Permissions
```

- **Supabase Auth é a única autoridade de identidade** — o mesmo projecto usado pelo Platform, Console e Client.
  O Na Pista **não** tem tabela de utilizadores/passwords, nem fluxo de login próprio no backend.
- Verificação **no servidor** do Na Pista: assinatura via JWKS pública do Supabase (ou HS256 legado, como no
  Platform), `iss` esperado, `aud = authenticated`, expiração. O Na Pista **não** precisa de nenhum segredo do
  Supabase para verificar tokens ES256/RS256.
- **Nunca** `SUPABASE_SERVICE_ROLE_KEY` no frontend (nem no Na Pista, salvo necessidade explícita futura).
- **Nunca** `user_metadata` como fonte de autorização.
- Claims do JWT dizem *quem é* (`sub`, `email`), **não** *o que pode fazer* — membership/role vêm do Platform.

## 2. Autorização humana

```
User → Organization (path) → Membership activo (Platform) → roleKey → Permission local → Entitlement → operação
```

### 2.1 De onde vem o membership? (OD-12 — decisão de segurança em aberto)
Hoje (PG-2) o Platform só responde "quais são os meus memberships" ao próprio utilizador (`GET /v1/me`).

| Opção | Como | Prós | Contras |
|---|---|---|---|
| **A (recomendada para o slice 1)** | Na Pista reencaminha o JWT do utilizador para `GET /v1/me`, valida que existe membership `active` na org do path, obtém `roleKey`. Cache curto por `(userId, orgId)`. | Funciona **hoje**, sem mudar o Platform; o Platform continua a ser a única fonte de membership. | 1 chamada por utilizador/TTL; reutiliza sessão humana (não é o mecanismo *long-term* de serviço — é delegação por pedido, mas convém confirmar com o dono do CLAUDE.md §6). Revogação demora ≤ TTL. |
| B | Platform ganha endpoint de serviço "membership de U na org O" (chave org-scoped). | Sem reencaminhar JWT; permite cache/contrato próprios. | Mudança no Platform (fora da F18). |
| C | Copiar membership para a BD do Na Pista. | Rápido. | **Rejeitada:** segunda fonte de verdade de autorização; dessincroniza. |

### 2.2 De onde vêm as permissions de negócio? (OD-12)
O Platform só tem permissions genéricas e 4 roles fixos (PG-3), e o seu README afirma que permissions de produto
"belong to the products themselves". **Proposta:** política **local** do Na Pista: um mapa `roleKey → permissions
do módulo`, em código, versionado, testado. Sem roles customizados por organização no v1.

PROPOSTA de mapa (**a validar com o negócio** — não é um requisito, é um ponto de partida):

| Permission | OWNER | ADMIN | MANAGER | STAFF |
|---|:-:|:-:|:-:|:-:|
| `settings.update` | ✔ | ✔ | — | — |
| `products.read` / `customers.read` / `services.read` / `orders.read` / `appointments.read` / `inventory.read` / `scheduling.read` | ✔ | ✔ | ✔ | ✔ |
| `products.write` / `customers.write` / `services.write` / `professionals.write` / `scheduling.write` | ✔ | ✔ | ✔ | — |
| `products.delete` | ✔ | ✔ | — | — |
| `inventory.adjust` | ✔ | ✔ | ✔ | — |
| `orders.create` / `appointments.create` / `appointments.complete` | ✔ | ✔ | ✔ | ✔ |
| `orders.cancel` / `appointments.cancel` | ✔ | ✔ | ✔ | — |

Limitação assumida: sem permissions por utilizador nem roles por organização. Se o negócio exigir, será preciso
que o Platform suporte permissions com escopo de aplicação (PG-3) — mudança de Platform + ADR próprio.

### 2.3 Regras
1. A autorização é **sempre** avaliada no servidor do Na Pista; gates de UI são conveniência (padrão do UL Client).
2. `organizationId` do path só vira `TenantContext` após membership válido (`tenancy.md`).
3. Ordem no pipeline: autenticação → tenant/membership → **permission** → **entitlement** → controller.
   (Permission antes de entitlement: quem não tem permissão não deve descobrir o que a org contratou.)
4. Sem permissão → `403 FORBIDDEN`; sem membership → `403` (igual ao Platform); recurso de outra org → `404`.

## 3. Autorização de serviço (service-to-service)

Distinto do humano (CLAUDE.md §6): identidade = **API key** (`ulk_`), autorização = **scopes** persistidos na
chave; nunca sessão humana como mecanismo de longo prazo.

### 3.1 Duas classes de chave — separação obrigatória (PG-8)

| Classe | Quem detém | Serve para | Scopes permitidos (regra) |
|---|---|---|---|
| **Platform-facing** | O próprio Na Pista (por tenant hoje — OD-11) | Na Pista → Platform: entitlements, usage, eventos | `usage.write`, `event.publish` (+ leitura de entitlements sem scope) |
| **Integration** | Cliente da org, ou outra aplicação UL | X → Na Pista: ler/escrever dados de negócio | apenas scopes de dados (`catalog.*`, `customer.read`, …); **nunca** `usage.write`/`event.publish` |

Porquê: o Platform deixa um OWNER criar uma chave `NA_PISTA` com qualquer scope da allowlist (PG-8). Se a mesma
chave servisse as duas classes, o cliente poderia forjar usage/eventos. **O Platform não impõe a separação hoje**;
impõe-na a operação (e o UL Client/documentação) até haver mecanismo (OD-11).

### 3.2 Scopes e módulos (PROPOSTA; vocabulário em OD-14)
Scopes existentes na allowlist `NA_PISTA`: `catalog.read`, `catalog.write`, `customer.read`.
- `catalog.read` → GET de `products`, `categories`, `services`; `catalog.write` → escrita nos mesmos.
- `customer.read` → GET de `customers`.
- **Sem scope hoje** para orders, appointments, inventory, customer.write → exigem seed novo no Platform (PG-4) antes de
  serem expostos a integrações. Até lá, esses módulos só são acessíveis a humanos.
- O Na Pista **exige** o scope e valida que `credential.organizationId == :organizationId` (nunca chave de
  plataforma para dados de tenant).

### 3.3 Quando consultar o Platform e quando resolver localmente

| Decisão | Onde | Porquê |
|---|---|---|
| JWT válido? | **Local** (JWKS em cache) | Sem chamada por pedido |
| Membership/role activo | **Platform** (cache curto) | Fonte de verdade; nunca copiar (§2.1 C) |
| Permission de negócio | **Local** | Conceito do domínio do Na Pista |
| Módulo/limite contratado | **Platform** (cache curto) | Plano/subscription são do Platform; Na Pista não duplica a resolução |
| Contagem actual (nº produtos) vs limite | **Local** | Só o Na Pista tem os dados; comparação é enforcement do Na Pista |
| Chave de serviço válida + scopes | **Platform** (introspecção, cache curto) | Só o Platform verifica chaves (PG-11) |
| Isolamento de dados | **Local** | BD do Na Pista |

### 3.4 Falha e revogação (fail closed)
Se o Platform estiver indisponível **e** não houver cache válido: pedidos que dependem dele falham com `503`
(nunca "permitir por omissão"). TTL de cache = compromisso segurança/latência → fixar no slice 1 (OD-13);
revogações de membership/chave só produzem efeito após expirar o cache.

## 4. Gestão de credenciais
- Segredo `ulk_` guardado pelo Na Pista **cifrado em repouso**, chave de cifra em variável de ambiente; nunca em
  logs, nunca no audit, nunca no repositório (CLAUDE.md §11).
- Rotação manual suportada pelo Platform: criar nova → implantar → verificar → revogar antiga.
