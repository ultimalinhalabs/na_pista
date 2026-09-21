# Auditoria do UL Platform, UL Client e UL Console (base da F18)

> Método: leitura directa do código em `ul-platform` (seed, schema, rotas, middlewares, serviços, testes),
> `ul-client` (CLAUDE.md, rotas, `lib/api`, `F17-BACKEND-GAPS.md`) e `ul-console` (estrutura de rotas,
> AGENTS.md/CLAUDE.md). O README do Platform foi lido, mas **o código prevaleceu** sempre que ambos diferem.
> Estado do Platform auditado: branch `master`, HEAD `5d5e9b0`.
>
> **Limites da auditoria (honestidade):** não foram lidos linha-a-linha todos os 26 ficheiros de teste, nem
> o código-fonte de páginas do `ul-console` para além da estrutura de rotas. Não foi executado o Platform
> contra uma base real nesta fase. Onde uma afirmação abaixo foi só inferida, está marcada *(inferido)*.

## 1. Contrato real do Platform (o que existe, confirmado no código)

| Área | Confirmado em | Facto |
|---|---|---|
| Application registry | `src/db/seed/data.ts`, `db/schema/applications.ts` | `UL_CONSOLE, NA_PISTA, MICHA_EXPRESS, FOI, QUALE_A_DICA, HOJE_TEM`. `NA_PISTA` = "Operational management for businesses." `status`: `ACTIVE/SUSPENDED/DEPRECATED`. |
| Organizations | `modules/organizations/service.ts` | `organizations(id, name, slug, createdBy)`. `createOrganization` cria a org **e** o membership `OWNER` na mesma transacção. `DELETE` é **hard delete** (cascade). Sem noção de produto ou tipo de negócio. |
| Memberships | `db/schema/memberships.ts` | `(userId, organizationId)` único; `status`: `active/invited/suspended`; um role por membership. |
| Roles | `db/seed/data.ts` | Globais e fixos: `OWNER, ADMIN, MANAGER, STAFF`. Sem roles por organização. |
| Permissions | idem | 20 chaves **genéricas** (`organization.*`, `membership.*`, `subscription.*`, `entitlement.read`, `api_key.*`, `webhook.*`, `usage.read`, `audit.read`, ...). **Nenhuma** permission de produto/negócio. |
| Plans | seed | `NA_PISTA`: `STARTER`, `BUSINESS`. Rotas de plans são **só leitura** (`routes/v1/plans.ts`). |
| Plan entitlements | seed | `NA_PISTA/STARTER`: `catalog.enabled=true`, `products.max=100`. `NA_PISTA/BUSINESS`: `catalog.enabled=true`, `products.max=1000`, `advanced_reports.enabled=true`. Chaves são texto livre (`jsonb value`). |
| Subscriptions | `modules/subscriptions/service.ts` | Estados `trialing/active/past_due/canceled`; "activa" = qualquer estado ≠ `canceled`. No máximo uma não-cancelada por (org, application). Criar/cancelar exige `subscription.manage` (OWNER). |
| Effective entitlements | `modules/entitlements/service.ts` | Resolução síncrona, sem cache. Resposta: `{ application, subscription: {id,status,planKey} \| null, entitlements: [{key,value}] }`. Chave ausente → `404` (endpoint singular). Tabela `entitlements` existe mas **não é usada**. |
| API keys | `modules/apiKeys`, `middleware/authenticate.ts` | `ulk_<id>.<secret>`; hash SHA-256; escopo por application e, opcionalmente, organization. Verificação **só no Platform** (não há forma de outro serviço verificar localmente). |
| Service scopes | seed | Registo global: `event.publish, usage.write, usage.read, catalog.read, catalog.write, customer.read, payment.create, payment.read, report.generate`. Allowlist `NA_PISTA`: `event.publish, usage.write, usage.read, catalog.read, catalog.write, customer.read`. |
| Webhooks | `modules/webhooks` | Endpoints por organização; assinatura `HMAC-SHA256`; entrega **síncrona**, 1 tentativa, at-least-once, sem dedupe na publicação. Publicação: `POST /organizations/:id/events` (`event.publish`, chave org-scoped). Tipo de evento: `domain.action`. |
| Usage | `modules/usage`, `routes/v1/usage.ts` | Escrita só por serviço (`usage.write`, org+application da credencial); idempotência por `(org, app, meter, idempotencyKey)`. Meters (seed): `users, orders, transactions, messages, storage_bytes, api_requests`. Allowlist `NA_PISTA`: `users, orders, storage_bytes, api_requests`. |
| Service discovery | `modules/discovery`, `routes/v1/service.ts` | `GET /v1/service/discover?target=&environment=`; requer integração `ACTIVE` origem→destino. Seed: `QUALE_A_DICA→NA_PISTA`, `NA_PISTA→MICHA_EXPRESS`, `HOJE_TEM→QUALE_A_DICA`. Endpoint `staging.na-pista.example` (placeholder); **sem endpoint de produção** semeado. |
| Environments / endpoints / integrations | `routes/v1/environments.ts`, `integrations.ts` | `production`/`staging` por application; escrita só `PLATFORM_ADMIN`. |
| Platform control plane | `routes/v1/platform.ts` | `PLATFORM_ADMIN`, permissions `platform.*`, credenciais de plataforma (`organizationId = null`), audit de plataforma. |
| Envelope / erros | `shared/response.ts`, `shared/errors.ts`, `middleware/errorHandler.ts` | `{ "data": ... }` / `{ "error": { "code", "message" } }`. Códigos: `VALIDATION_ERROR(400) UNAUTHORIZED(401) FORBIDDEN(403) NOT_FOUND(404) CONFLICT(409)`. `X-Request-ID` (aceita o do cliente se `^[A-Za-z0-9._-]{1,128}$`) vai no **header**, nunca no corpo. |
| Paginação | `modules/audit` | Cursor/keyset (`?cursor=&limit=`, máx. 100) — só no audit de plataforma. |
| JWT | `integrations/supabase/jwt.ts` | Supabase Auth; ES256/RS256 via JWKS (pública) ou HS256 legado; valida `iss` e `aud=authenticated`. Autorização **nunca** vem de `user_metadata`. |
| Customers (Platform) | `db/schema/customers.ts` | Tabela `(userId, organizationId)` única. **Sem rotas, sem serviço**; só tem teste (`tests/customer.test.ts`). |

### UL Client (tenant-facing) — confirmado
- Autoridade: `CLAUDE.md` do Client declara-o **não** ser dashboard de produto: "administers the organization's
  *relationship* with the UL ecosystem, not any product's own operational data".
- Rotas: `api-keys, applications, dashboard, entitlements, members, settings, subscriptions, usage, webhooks`
  sob `/app/o/[organizationId]/`. Resolve permissões via `GET /v1/roles/:roleKey` para o `roleKey` do membership
  (`GET /v1/me`); o gate real é sempre o Platform.
- `F17-BACKEND-GAPS.md`: (1) não há como adicionar membro por email; (2) a URL do webhook nunca é devolvida pela API.

### UL Console (platform admin) — confirmado (estrutura)
- Rotas: `admins, applications, audit, credentials, integrations, overview, service-discovery`. Só `PLATFORM_ADMIN`.
  Não há (nem deve haver) UI de dados de tenant ou de produtos.

## 2. Divergências registadas

| # | Divergência | Onde | Impacto para o Na Pista |
|---|---|---|---|
| DV-1 | Comentários/README dizem que catálogos (`/roles`, `/meters`, ...) são "human-only", mas o código só usa `authenticate`, que aceita **também** credenciais de serviço. Verificado em `roles.ts` e `meters.ts`; mesmo padrão (`authenticate` sem checagem de `req.auth`) em permissions, plans, service-scopes *(inferido por grep, não lidos um a um)*. | `routes/v1/*.ts` | Favorável: o Na Pista pode ler `GET /roles/:roleKey` com uma chave de serviço. Mas a documentação do Platform está errada e deve ser corrigida. |
| DV-2 | O README afirma "Every other endpoint … remains human-only" para além de entitlements/usage. Verdade só para rotas org-scoped protegidas por `requirePermission`; as rotas de catálogo (DV-1) não. | `README.md` | Idem. |
| DV-3 | Chaves de entitlement, meters e scopes semeadas para `NA_PISTA` (`catalog.enabled`, `products.max`, `advanced_reports.enabled`; meters `orders, users, storage_bytes, api_requests`; scopes `catalog.*`, `customer.read`) **não coincidem** com o vocabulário sugerido no brief F18 (`products.enabled`, `inventory.enabled`, `max_customers`, ...). O seed diz explicitamente que são "illustrative". | `db/seed/data.ts` | Vocabulário do Na Pista tem de ser decidido (OD-14) e semeado. É mudança de **dados**, não de código. |
| DV-4 | A permission `audit.read` (org) existe e é atribuída a OWNER/ADMIN, mas **nenhuma rota** a consome; só existe leitura de audit de plataforma. | `seed/data.ts`, `routes/v1/*` | Um tenant não consegue ler audit de negócio pelo Platform. |
| DV-5 | `CLAUDE.md` do projecto e `docs/UL_PLATFORM_CONTEXT_V1.md` escrevem "Minha Express" e não mencionam `Hoje Tem`; o seed já usa `MICHA_EXPRESS`/`HOJE_TEM`. | docs | Só documentação. Usar "Micha Express" (memória do projecto). |
| DV-6 | O brief pede `README.md` e `/docs/adr/` mas o repositório do Na Pista **não existia**. | — | Criado `na-pista/` como repositório irmão independente (não dentro de `ul-platform`), seguindo o CLAUDE.md §2. |
| DV-7 | O estado do repositório `ul-platform` tinha, no início desta sessão, alterações não commitadas (script `create-organization-for-user.ts` + entrada no `package.json`), criadas para uma tarefa anterior e **não** relacionadas com a F18. | `ul-platform` | Não incluídas nos commits da F18. |

## 3. Lacunas do Platform relevantes para o Na Pista (PG-*)

Nenhuma é corrigida na F18 (não se altera o Platform). Cada uma alimenta uma decisão aberta ou um item de backlog.

| # | Lacuna | Evidência | Consequência |
|---|---|---|---|
| **PG-1** | Uma credencial de **plataforma** (`organizationId = null`, "o backend do NA_PISTA") **não consegue** ler entitlements, escrever usage nem publicar eventos para nenhuma organização: `requireServiceOrganizationMatch` e `requireEntitlementAccess` comparam `req.service.organizationId !== :organizationId` (`null` nunca é igual). | `middleware/requireServiceOrganizationMatch.ts`, `entitlementAccess.ts`, `usageAccess.ts` | Hoje um serviço multi-tenant como o Na Pista precisaria de **uma chave org-scoped por tenant**, provisionada por cada OWNER. Decisão de segurança → **OD-11**. |
| **PG-2** | Não existe endpoint para um **serviço** perguntar "o utilizador U tem membership/role R na org O". `GET /v1/me` só serve o próprio utilizador (JWT dele); `GET /organizations/:id/memberships` exige permissão humana. | `routes/v1/me.ts`, `organizations.ts` | O Na Pista tem de reencaminhar o JWT do utilizador para `/v1/me` (ou o Platform ganhar um endpoint). **OD-12**. |
| **PG-3** | Permissions são globais e genéricas; roles são 4 fixos. Não há permissions específicas de aplicação. README: "No product-specific permissions … belong to the products themselves". | seed | O Na Pista terá política local de permissões derivada do `roleKey`. Sem roles customizados por organização. **OD-12**. |
| **PG-4** | `plan_entitlements`, `service_scopes`, `application_service_scopes`, `meters`, `application_meters` são **só seed**. Não há HTTP nem Console para os gerir (plans são read-only). | rotas; comentários no seed | Definir o catálogo do Na Pista = PR de dados no Platform + `db:seed`. |
| **PG-5** | Sem ingestão de audit por serviços; sem leitura de audit por organização (DV-4). `recordAuditEvent` é função interna. | `modules/audit/service.ts` | Na Pista mantém audit de negócio próprio. **OD-15**. |
| **PG-6** | O Platform não notifica mudanças de subscription/entitlement nem eliminação de organização. Só serviços publicam eventos. `deleteOrganization` apaga tudo em cascata sem aviso. | `modules/organizations/service.ts`, `routes/v1/events.ts` | Na Pista faz *pull* com TTL; dados de tenants eliminados ficam órfãos. **OD-21**. |
| **PG-7** | Publicação de evento é síncrona no request e sem dedupe por chave de idempotência (cada publish gera um `evt_<uuid>` novo). | `modules/webhooks/delivery.ts` | O Na Pista precisa de outbox + consumidores tolerantes a duplicados. Ver `events.md`. |
| **PG-8** | Um OWNER pode criar (`api_key.manage`) uma chave `NA_PISTA` da sua organização com **qualquer** scope da allowlist, incluindo `usage.write` e `event.publish`. | `modules/apiKeys/service.ts`, `seed` | Um tenant consegue forjar usage/eventos da própria org. Logo o usage do Platform **não é fonte fiável para enforcement**. Ver `usage.md`. |
| **PG-9** | A tabela `customers` do Platform não tem API nem uso. | `db/schema/customers.ts` | Não a usar no Na Pista agora. **ADR-009**. |
| **PG-10** | Sem convite por email; utilizador tem de já ter feito login. | `F17-BACKEND-GAPS.md` | Onboarding de equipa (profissionais/staff) no Na Pista depende disto. |
| **PG-11** | Verificação de API keys só existe dentro do Platform. Um serviço que **receba** uma `ulk_` (ex.: Qualé a Dica?! a chamar o Na Pista) tem de a validar via `GET /v1/service/me` (introspecção remota). | `authenticate.ts`, `routes/v1/service.ts` | Latência/dependência por chamada; revogação só se propaga se não houver cache longo. **OD-13/OD-17**. |
