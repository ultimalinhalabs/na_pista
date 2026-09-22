# Fluxo de integração Platform ↔ Na Pista (F19 — provado em runtime)

Todos os passos abaixo correspondem a código real em `spikes/platform-integration/src/` e foram exercitados
contra o UL Platform real (HTTP + Postgres reais) pelos testes em `spikes/platform-integration/tests/e2e/`.
Ver `decisions.md` para a justificação de cada escolha e `f19-report.md` para os resultados dos testes.

## 1. Human request

```
Browser
  │  Supabase Auth (login)
  ▼
Na Pista UI                                    (não construída nesta fase — F19 §24)
  │  Authorization: Bearer <JWT>, HTTPS
  ▼
Na Pista API
  │
  ├─▶ auth/jwt.ts            pré-check local barato: forma + exp óbvio (sem rede, sem segredo — ADR-012)
  │
  ├─▶ platform/membership.ts  GET {PLATFORM}/v1/me  (reencaminha o MESMO JWT; cache 15s)
  │        ▼
  │   UL Platform: verifica assinatura (JWKS/HS256), iss, aud, exp
  │        ▼
  │   { userId, email, memberships[] }
  │
  ├─▶ tenancy/tenantContext.ts   :organizationId do path × memberships[] → TenantContext | 403
  │
  ├─▶ authorization/permissions.ts  roleKey da membership → permission local | 403
  │
  ├─▶ platform/entitlements.ts   GET {PLATFORM}/v1/organizations/:id/applications/NA_PISTA/entitlements
  │        (com a credencial de serviço PRÓPRIA da Na Pista para esta organização — OD-11; cache 10s)
  │        ▼
  │   { subscription, entitlements[] } → interpretCapability() → enabled | 403 ENTITLEMENT_REQUIRED
  │
  ▼
modules/products/service.ts → repository.ts (exige TenantContext) → Postgres (schema próprio da Na Pista)
  │
  ▼
resposta { data } | { error }, sempre com X-Request-ID
```

Nenhum passo confia em `organizationId` do path nem em `role` vindo do cliente sem o validar contra o Platform
(F19 §9). Falha em qualquer chamada ao Platform → `503 UPSTREAM_UNAVAILABLE`, nunca tratada como "permitir".

## 2. Service request (credencial de serviço a chamar a Na Pista)

Modela, por exemplo, um sistema próprio de um tenant, ou uma futura chamada do Qualé a Dica?! à Na Pista.

```
Chamador (integração do tenant / outra app UL)
  │  Authorization: Bearer ulk_<id>.<secret>
  ▼
Na Pista API
  │
  ├─▶ middleware/authenticate.ts   prefixo "ulk_" → ramo de serviço (nunca ambos os ramos)
  │
  ├─▶ platform/serviceIntrospection.ts   GET {PLATFORM}/v1/service/me  (com a credencial recebida; cache 15s)
  │        ▼
  │   UL Platform: verifica hash do segredo, expiração, revogação, status da Application
  │        ▼
  │   { apiKeyId, application, organizationId, scopes }
  │
  ├─▶ tenancy/tenantContext.ts   credencial.organizationId === :organizationId do path, senão 403
  │
  ├─▶ middleware/requireAuthorized.ts   scope da credencial ⊇ scope exigido pela operação, senão 403
  │
  ├─▶ platform/entitlements.ts   (mesma verificação que no fluxo humano — a entitlement aplica-se igual)
  │
  ▼
modules/products/... → Postgres
```

## 3. Chamadas que a própria Na Pista faz ao Platform (saída)

```
Na Pista (com a SUA credencial de serviço, org-scoped — OD-11)
  │
  ├─▶ GET  .../applications/NA_PISTA/entitlements     (leitura de capability — usado neste spike)
  ├─▶ POST .../applications/NA_PISTA/usage             (scope usage.write — não exercitado neste spike; outbox é F20)
  └─▶ POST .../events                                  (scope event.publish — idem)
```

## 4. O que NÃO acontece nesta arquitectura
- A Na Pista nunca liga directamente à base de dados do Platform.
- A Na Pista nunca verifica a assinatura de um JWT sozinha por omissão (ADR-012) nem verifica um `ulk_` sozinha
  (PG-11) — ambos delegados ao Platform.
- O Platform nunca sabe o que é um "Produto" — só resolve identidade, organização, subscrição e entitlement.
- Nenhum pedido de negócio corre sem `TenantContext` resolvido (garantido estruturalmente no repository).
