# Alterações pedidas ao UL Platform (encontradas pelo spike F19)

Nenhuma foi implementada nesta fase — só o que era pequeno, seguro e directamente necessário ao próprio spike
seria elegível (F19 §6), e nada do spike precisou de facto de uma alteração ao Platform para funcionar (ver
`decisions.md`: OD-11/OD-12/OD-13/OD-14/OD-16 fecham todas com "Platform changes: NONE" ou "OPTIONAL").
Este documento existe para não esconder as que ficaram identificadas mas descartadas para esta fase.

Classificação: **BLOCKER** (impede algo que a F19 precisava de provar) · **REQUIRED** (necessário para o
Na Pista real, não para o spike) · **OPTIONAL** (melhoria, sem dependência).

## PC-1 — Credencial de aplicação com autoridade sobre múltiplas organizações (OD-11, Alternativa B)

- **Classe:** OPTIONAL
- **Reason:** OD-11 fechou na Alternativa A (uma chave por organização), que funciona hoje sem qualquer
  mudança. A Alternativa B (uma credencial `NA_PISTA` só-de-plataforma que actua em nome de qualquer
  organização subscrita) reduziria o número de segredos a gerir de N (uma por tenant) para 1.
- **Current behavior:** `req.service.organizationId` de uma credencial de plataforma é sempre `null`;
  `requireServiceOrganizationMatch`/`requireEntitlementAccess` comparam-no ao `:organizationId` do URL, que
  nunca é `null` — a comparação falha sempre, estruturalmente (confirmado por leitura do código, não apenas
  assumido).
- **Required behavior:** um novo caminho de autorização — por exemplo, a credencial de plataforma teria de
  provar, por pedido, que a `NA_PISTA` tem uma integração/relação válida com a organização alvo (via
  Subscription, o que já existe) antes de ser tratada como "agindo por essa organização".
- **Security rationale:** isto é deliberadamente difícil de fazer bem: uma credencial assim teria o alcance de
  qualquer organização subscrita à `NA_PISTA` — o raio de explosão de um único segredo comprometido passa de
  "uma organização" para "todas as organizações desse produto". Qualquer desenho tem de manter esse raio
  explícito e, idealmente, auditável por organização afectada.
- **API contract:** possivelmente `requireEntitlementAccess`/`requireServiceOrganizationMatch` ganhariam um
  modo adicional: aceitar uma credencial de plataforma **e** validar que existe uma subscrição não-cancelada
  da organização do URL para a aplicação da credencial, antes de prosseguir.
- **Schema impact:** nenhum novo — `api_keys.organizationId` já é nullable para este caso exacto.
- **Migration:** nenhuma migração de dados; só código de autorização.
- **Backwards compatibility:** aditivo — não muda o comportamento de chaves org-scoped existentes.
- **Test impact:** exigiria novos testes de isolamento (uma credencial de plataforma da `NA_PISTA` nunca pode
  agir sobre uma organização subscrita a outra aplicação, nem sobre uma organização não subscrita a nada).

## PC-2 — Impor a separação de classes de credencial (platform-facing vs integration) no próprio Platform

- **Classe:** OPTIONAL
- **Reason:** hoje (PG-8) um OWNER pode criar uma chave `NA_PISTA` da sua organização com qualquer combinação
  de scopes da allowlist — nada impede uma única chave de ter simultaneamente `usage.write`/`event.publish`
  (que deviam ser só da Na Pista) e `catalog.write` (que devia ser só de uma integração do tenant). A F19
  mitigou isto por convenção operacional (duas chaves, nunca uma) — ver `authorization.md` §3.1 — mas o
  Platform não o impõe.
- **Current behavior:** `validateRequestedScopes` só verifica registo + allowlist da aplicação, nunca
  combinações proibidas dentro da mesma allowlist.
- **Required behavior:** por decidir — por exemplo, sub-categorizar `application_service_scopes` em classes
  (`product-facing` vs `tenant-integration`) e rejeitar a criação de uma chave que misture classes.
- **Security rationale:** fecha definitivamente PG-8 — hoje a mitigação depende de disciplina operacional, não
  de um mecanismo.
- **API/schema impact:** nova coluna/enum em `service_scopes` ou `application_service_scopes`; validação extra
  em `createOrganizationApiKey`.
- **Backwards compatibility:** teria de decidir o que fazer a chaves já existentes com scopes mistos.
- **Test impact:** novos testes de `service-scopes.test.ts`/`api-keys.test.ts` no próprio Platform.

## PC-3 — Endpoint de serviço para consultar membership de outro utilizador

- **Classe:** OPTIONAL
- **Reason:** OD-12 fechou na Alternativa A (reencaminhar o JWT do próprio utilizador para `GET /v1/me`), que
  funciona hoje. Um endpoint dedicado (`GET /v1/service/organizations/:id/members/:userId`, por exemplo,
  atrás de um scope de serviço) evitaria o reencaminhamento do token e permitiria à Na Pista consultar
  membership sem depender do utilizador ter reenviado o seu próprio JWT nesse pedido específico (útil, por
  exemplo, para um job assíncrono que age em nome de um utilizador já autenticado anteriormente).
- **Current behavior:** não existe nenhum endpoint de serviço para consultar o membership de um utilizador
  diferente do dono do token.
- **Required behavior:** um novo endpoint, autenticado por credencial de serviço org-scoped, que devolva o
  membership (roleKey, status) de um `userId` específico nessa organização.
- **Security rationale:** teria de continuar a nunca aceitar `roleKey` do chamador — só devolver o que está
  na tabela `memberships`. Nenhum risco novo óbvio, desde que a credencial continue org-scoped (nunca uma
  consulta cross-organização).
- **Schema impact:** nenhum.
- **Test impact:** novo endpoint = novos testes de autorização (credencial de A não pode consultar B).

## PC-4 — Renomear/duplicar `catalog.enabled` para `products.enabled` no seed dos planos `NA_PISTA`

- **Classe:** REQUIRED (antes da F20 construir o módulo Products a sério — não bloqueia esta fase)
- **Reason:** OD-14. O spike reutilizou deliberadamente `catalog.enabled` (já semeado) em vez de inventar
  `products.enabled` sem suporte no Platform.
- **Current behavior:** `plan_entitlements` para `NA_PISTA/STARTER` e `NA_PISTA/BUSINESS` têm `catalog.enabled`,
  não `products.enabled`.
- **Required behavior:** adicionar `products.enabled = true` às mesmas linhas (ou substituir), mantendo
  `products.max` como está.
- **Migration:** puramente de dados — `INSERT`/`UPDATE` em `plan_entitlements` via `db/seed/data.ts`, sem
  alteração de schema.
- **Backwards compatibility:** aditivo se ambas as chaves coexistirem por um período; qualquer consumidor
  existente de `catalog.enabled` continua a funcionar.
- **Test impact:** actualizar `tests/effective-entitlements.test.ts` se passar a assumir a chave nova.

## PC-5 — Novos usage meters (`products`, `appointments`) e service scopes por módulo

- **Classe:** REQUIRED (quando os módulos correspondentes forem construídos — F20+, não bloqueia esta fase)
- **Reason:** `docs/usage.md`/`docs/modules.md` da F18 já identificavam isto (PG-4); a F19 confirma que não há
  caminho HTTP para o adicionar — é sempre seed.
- **Current/Required behavior:** adicionar `products`/`appointments` a `METERS` e `APPLICATION_METERS.NA_PISTA`;
  adicionar scopes que faltam (ex.: nenhum novo scope foi necessário para o Product mínimo desta fase —
  `catalog.write` já cobre).
- **Migration:** dados apenas.
- **Test impact:** nenhum teste do Platform depende disto hoje; adicionar quando o módulo real existir.

## Notas
- Nenhum destes itens foi necessário para fechar OD-11/OD-12/OD-13/OD-14/OD-16 — todos fecharam com o
  Platform tal como está. Isto está registado aqui porque **melhoraria** a arquitectura, não porque a bloqueou.
- PC-1 e PC-2 são as únicas com implicações de segurança reais; ambas aumentam ou reduzem um raio de explosão
  existente, nunca introduzem um caminho de escalonamento novo por si só.
