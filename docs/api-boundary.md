# Fronteira de API

## 1. Duas APIs, dois donos

```
UL PLATFORM API  (dono: ul-platform)                NA PISTA API  (dono: na-pista)
/v1/organizations  /v1/applications                 /v1/organizations/:orgId/settings
/v1/subscriptions  /v1/entitlements                 /v1/organizations/:orgId/products
/v1/api-keys  /v1/usage  /v1/webhooks               /v1/organizations/:orgId/categories
/v1/service/discover  /v1/platform/*                /v1/organizations/:orgId/customers
                                                     /v1/organizations/:orgId/inventory
   "quem pode usar?"                                 /v1/organizations/:orgId/orders
                                                     /v1/organizations/:orgId/services
                                                     /v1/organizations/:orgId/professionals
                                                     /v1/organizations/:orgId/appointments
                                                        "o que pode fazer?"
```

O Platform **nunca** expõe rotas de negócio; o Na Pista **nunca** expõe rotas de identidade/organização/plano.
O brief listava `/v1/products` sem o prefixo; ajustado (permitido pelo brief) por causa da resolução de tenant (§3).

## 2. Convenções — reutilizam as do Platform (consistência entre serviços UL)

| Tema | Regra | Origem |
|---|---|---|
| Versionamento | `/v1/...` no path desde o início. Quebras = `/v2`. | CLAUDE.md §9 |
| Envelope | sucesso `{ "data": ... }`; erro `{ "error": { "code", "message" } }`. | `shared/response.ts` |
| Códigos de erro | `VALIDATION_ERROR 400`, `UNAUTHORIZED 401`, `FORBIDDEN 403`, `NOT_FOUND 404`, `CONFLICT 409` (iguais ao Platform) + **específicos do Na Pista (PROPOSTA)**: `ENTITLEMENT_REQUIRED 403`, `MODULE_DEPENDENCY_UNMET 403`, `LIMIT_EXCEEDED 409`. Clientes que não conheçam um código tratam pelo status HTTP. | `shared/errors.ts` |
| Request ID | Aceita `X-Request-ID` válido (`^[A-Za-z0-9._-]{1,128}$`), senão gera; devolve sempre no header; **nunca** no corpo. Propagado nas chamadas ao Platform. | `middleware/requestId.ts` |
| Input | Validado na fronteira (Zod); rejeita campos desconhecidos. Nunca expõe tabelas como contrato. | CLAUDE.md §9 |
| Paginação | **Cursor/keyset**: `?cursor=&limit=` (`limit` máx. 100, por omissão a fixar); resposta `{ data: [...], page: { nextCursor } }`. Sem `offset`. | `modules/audit` (padrão existente) |
| Filtros | Query params **whitelisted por recurso** (ex.: `?status=ACTIVE&categoryId=...&q=`). Nunca filtros arbitrários sobre colunas. | — |
| Ordenação | `?sort=name,-createdAt`, apenas colunas whitelisted e indexadas; desempate por `id` para cursor estável. | — |
| Idempotência | POSTs que criam factos com efeitos (**orders, appointments, inventory movements**) aceitam `Idempotency-Key` (header); armazenada por `(organization_id, key)` com hash do pedido; replay → mesma resposta; mesma chave + corpo diferente → `409`. Cria-produto/cliente não precisa (conflitos naturais por SKU/unicidade). | Padrão de `usage` do Platform, adaptado a header |
| Webhooks | Tratados como eventos externos **re-tentáveis**: receptor idempotente por `X-UL-Event-Id`. | Platform |
| Health | `GET /v1/health` (sem dependências) e `GET /v1/health/ready` (BD). | `routes/v1/health.ts` |
| Rate limit | por identidade autenticada (chave/utilizador) em operações sensíveis. | `middleware/rateLimit.ts` |

Contrato publicado: **OpenAPI 3** gerado/mantido no repositório do Na Pista e versionado com a API. É o que UI
por defeito, UI personalizada e integradores consomem (ADR-008). Nada de imports de código entre projectos.

## 3. Resolução de tenant: organização no path (ADR-002)

`/v1/organizations/{organizationId}/...`, como no Platform e no UL Client.

Alternativas rejeitadas: header `X-Organization-Id` / organização "implícita" do token. O path é explícito,
cacheável, auditável, e alinha-se com `requireServiceOrganizationMatch` (a org da credencial tem de coincidir
com a do path). Em qualquer caso o id **nunca** é confiado sem validação (§ tenancy §4).

## 4. Quem chama o Na Pista

| Chamador | Credencial | Como o Na Pista a valida | Tenant vem de |
|---|---|---|---|
| Humano (UI por defeito / UI UL personalizada / UI do cliente com login) | JWT Supabase | JWKS pública do Supabase (`iss`, `aud=authenticated`, expiração) | path + membership validado no Platform |
| Integração do cliente (sistema próprio do tenant) | API key `ulk_` da org (`application = NA_PISTA`) | introspecção `GET {platform}/v1/service/me` (PG-11) | credencial (deve coincidir com o path) |
| Outra aplicação UL (ex.: Qualé a Dica?!) | API key `ulk_` da org (`application = QUALE_A_DICA`) | idem | credencial |

Introspecção remota por pedido tem custo e dependência do Platform → resultado em cache de TTL curto
(a revogação demora no máximo o TTL) — OD-13. Sem o Platform disponível, chamadas de serviço **falham fechadas**.

## 5. O que o Na Pista chama no Platform (superfície mínima)

| Objectivo | Endpoint (existente hoje) | Autenticação usada | Notas |
|---|---|---|---|
| Membership + role do utilizador | `GET /v1/me` | JWT do próprio utilizador (reencaminhado) | qualquer membro activo; ver OD-12 |
| Permissions de um role (informativo) | `GET /v1/roles/:roleKey` | qualquer credencial (DV-1) | o Na Pista **não** usa isto para decidir permissions de negócio (são locais) |
| Entitlements efectivos | `GET /v1/organizations/:orgId/applications/NA_PISTA/entitlements` | API key org-scoped de `NA_PISTA` | PG-1 / OD-11 |
| Validar chave recebida | `GET /v1/service/me` | a própria chave recebida | PG-11 |
| Registar usage | `POST /v1/organizations/:orgId/applications/NA_PISTA/usage` | API key org-scoped, scope `usage.write` | via outbox |
| Publicar eventos | `POST /v1/organizations/:orgId/events` | API key org-scoped, scope `event.publish` | via outbox |
| Descobrir outras apps (ex.: Micha Express) | `GET /v1/service/discover?target=&environment=` | API key (qualquer) | só quando houver integração real (FUTURE) |

Nada mais. Em particular o Na Pista **não** cria organizações, memberships, subscriptions nem chaves.

## 6. O que o Na Pista **expõe** ao Platform/outros

- Endpoint da API registado no Platform: `application_endpoints` (`type: API`, `baseUrl`) para `production` e
  `staging` — registado por um `PLATFORM_ADMIN` no UL Console (o seed só tem placeholder de staging; **não** há
  URL de produção — a registar quando existir).
- Integração(ões) de entrada já semeadas: `QUALE_A_DICA → NA_PISTA` (discovery permitido; a autorização do que
  pode fazer é por scope, ver `authorization.md`). Nenhuma integração nova é necessária para o slice 1.
- O Platform **não** faz proxy: quem chama o Na Pista vai directo.

## 7. Audit e observabilidade na fronteira
Todo pedido tem `requestId`; logs estruturados sem segredos (mesmo padrão do Platform); erros nunca vazam SQL/stack.
Audit de negócio: ver `audit.md`.
