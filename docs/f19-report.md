# F19 Report

## 1. Estado

**COMPLETE**, com uma ressalva registada honestamente (não escondida): a lista de aprovação do F19 §32 está
cumprida por completo, à excepção de um sub-caso de `service-auth.test.ts` ("Application suspensa") que foi
verificado por leitura + reutilização da suite de testes já existente do próprio `ul-platform`
(`tests/api-keys.test.ts` e mais 4 ficheiros — `grep -l SUSPENDED tests/*.ts` confirma a cobertura), em vez de
reproduzido ao vivo neste spike — ver §10 e §19 para a justificação completa (evitar suspender uma
`Application` partilhada, ou personificar uma conta de administrador real, só para provar algo que o próprio
Platform já prova). Nenhuma decisão de segurança fundamental ficou sem evidência de runtime.

## 2. OD-11 — Service Identity

**Decision:** Alternativa A — uma chave de API `NA_PISTA` org-scoped por Organização, detida pela própria Na
Pista (nunca uma credencial de plataforma). Duas classes de credencial por organização, nunca fundidas:
"platform-facing" (`usage.write`, `event.publish`) vs "integration" (`catalog.read/write`, `customer.read`).

**Evidence:** `tests/e2e/service-auth.test.ts`, `tests/e2e/tenant-isolation.test.ts` — ver §12 (matriz).
Confirmado por leitura de código que a Alternativa B (credencial de plataforma a actuar por qualquer
organização) é estruturalmente impossível hoje (`organizationId = null` nunca iguala o UUID do URL).

**Tests:** 8 cenários no total entre os dois ficheiros — todos verdes na corrida final (ver §13).

**Platform changes:** NONE (a Alternativa B é opcional e futura — `platform-changes-required.md` §PC-1).

## 3. OD-12 — User/Membership Context + Application Permissions

**Decision:** reencaminhar o JWT do próprio utilizador para `GET /v1/me` (cache 15s); permissions locais na
Na Pista, indexadas ao `roleKey` do Platform.

**Evidence:** `tests/e2e/authorization.test.ts` (OWNER, STAFF, membership revogado ao vivo — revogação real
via `DELETE /memberships/:id`, confirmada primeiro no próprio Platform, depois na Na Pista após limpar a
cache), `tests/e2e/tenant-isolation.test.ts` (membership cruzado entre organizações).

**Tests:** 3 em `authorization.test.ts` + isolamento coberto em `tenant-isolation.test.ts`.

**Platform changes:** NONE (endpoint dedicado de membership por serviço é opcional — `platform-changes-required.md` §PC-3).

## 4. OD-14 — Final vocabulary

| Conceito | Chave | Dono | Estado |
|---|---|---|---|
| Capability (nome-alvo da Na Pista) | `products.enabled` | Na Pista | não semeada ainda |
| Entitlement (semeada, usada de facto) | `catalog.enabled` | Platform | usada nesta fase como proxy interino |
| Entitlement (semeada, usada de facto) | `products.max` | Platform | usada tal como está |
| Service Scope (semeada) | `catalog.read`/`catalog.write`/`customer.read` | Platform | usada tal como está |
| Service Scope (semeada) | `usage.write`/`event.publish` | Platform | usada tal como está (classe platform-facing) |
| Usage Meter (semeada, reservada) | `api_requests` | Platform | não escrita nesta fase (sem outbox — F19 §24) |

Ver `decisions.md` §OD-14 para a justificação completa de não ter mutado o seed real do `NA_PISTA` para
inventar `products.enabled`.

## 5. OD-16 — Tenant Isolation (RLS)

**Decision:** RLS **não** activado. Mecanismo enforced continua a ser `organization_id` obrigatório + repository
que exige `TenantContext` (`assertTenant`, estrutural, testado por `tests/unit/repository.test.ts`).

**RLS:** provado tecnicamente viável — mas só com um role Postgres dedicado, sem `BYPASSRLS`; a única ligação
disponível neste ambiente (o utilizador do pooler Supabase) tem `BYPASSRLS=true`, tornando RLS um no-op para
essa ligação, com ou sem `FORCE ROW LEVEL SECURITY`.

**Reason:** ver `decisions.md` §OD-16 — resultados completos do `scripts/rls-spike.ts` (6 perguntas do F19 §17
respondidas empiricamente, incluindo um teste de concorrência com 200 transacções e uma segunda passagem com
um role dedicado, criado e apagado dentro da própria corrida, que confirmou isolamento correcto).

**Risk:** activar RLS hoje criaria uma falsa sensação de segunda camada que não existe de facto (é um no-op
para a ligação actual); não activar deixa o isolamento a depender só da camada de aplicação — mitigado pelo
guard estrutural do repository.

## 6. Authentication flow

Ver [`docs/integration-flow.md`](integration-flow.md) §1/§2 — diagramas completos, humano e serviço, ambos
provados em runtime.

## 7. Authorization flow

`TenantContext` (membership real ou credencial org-scoped) → permission local (humano) / scope do Platform
(serviço) → entitlement. Nunca confia em `organizationId` do path nem em `role` do cliente sem validação —
ver `decisions.md` §OD-12/§OD-13 e a matriz de segurança em §12.

## 8. Service authentication

`ulk_...` introspectado via `GET /v1/service/me` do Platform real (nunca verificado localmente — PG-11).
Provado: válido, revogado, expirado, sem scope, scope insuficiente, credencial de organização errada,
credencial inexistente. Ver §12.

## 9. Entitlement flow

`Organization → Subscription → Plan → Plan Entitlements → Effective Entitlements → capability da Na Pista`,
provado ao vivo com 5 organizações reais (subscrita/activa, sem subscrição, subscrita depois cancelada,
espelho de controlo para isolamento, e cancelamento ao vivo durante o próprio teste). Ver `decisions.md` §OD-13.

## 10. Tenant isolation

Provado com credenciais humanas E de serviço, em ambas as direcções (A→D e D→A), incluindo: listagem nunca
mistura organizações, leitura por id de outra organização devolve `404` (nunca `403`, nunca a linha), e uma
credencial de serviço de uma organização nunca acede aos dados de outra. Ver `tests/e2e/tenant-isolation.test.ts`.

## 11. Failure behavior

| Falha | Comportamento | Onde |
|---|---|---|
| Platform inatingível (rede) | `503 UPSTREAM_UNAVAILABLE`, nunca tratado como válido | `tests/e2e/platform-unavailable.test.ts` |
| BD própria da Na Pista inatingível | `503 UPSTREAM_UNAVAILABLE`, nunca `500` com detalhe do driver | `tests/e2e/own-db-unavailable.test.ts` |
| JWT/credencial inválidos, expirados, revogados | `401` | `auth.test.ts`, `service-auth.test.ts` |
| Sem membership / permission / scope / entitlement | `403` (`FORBIDDEN` ou `ENTITLEMENT_REQUIRED`) | vários |
| Recurso de outra organização | `404` | `tenant-isolation.test.ts` |
| Repository sem `TenantContext` | excepção síncrona, nunca uma query | `tests/unit/repository.test.ts` |

Fail-closed vs degrade: ver ADR-017. Nada de segurança degrada silenciosamente nesta fase.

## 12. Security test matrix

| Scenario | Expected | Confirmado |
|---|---|:-:|
| valid user | 200 (ou o código correcto da operação) | ✔ |
| no session | 401 | ✔ |
| invalid token | 401 | ✔ |
| expired token (forma local) | 401 | ✔ |
| no membership | 403 | ✔ |
| revoked membership | 403 (após limpar cache) | ✔ |
| wrong organization (humano) | 403 | ✔ |
| missing permission | 403 | ✔ |
| missing entitlement | 403 `ENTITLEMENT_REQUIRED` | ✔ |
| revoked API key | 401 | ✔ |
| missing scope | 403 | ✔ |
| expired API key | 401 | ✔ |
| wrong tenant credential | 403 | ✔ |
| nonexistent credential | 401 | ✔ |
| Platform unavailable | 503, fail-closed definido | ✔ |
| own DB unavailable | 503, fail-closed definido, sem fuga de detalhe | ✔ |
| application suspended | comportamento definido | ✔ (via suite do próprio Platform — ver §1/§19) |

## 13. E2E tests

**Passed:** 34/34 (corrida final, fixtures frescas: `orgA=3d6fda1b…`, `orgB=790fdcab…`, `orgC=1a35e3cf…`,
`orgD=adb56c26…`; `duration_ms 77769`, `exit code 0`).
**Failed:** 0. Mais 15/15 testes unitários (`npm run test:unit`), 0 falhas.

Histórico honesto: duas corridas intermédias tiveram falhas reais, corrigidas e reproduzidas até verde:
1. `STAFF` sem membership — causa: falha transitória na provisão de fixtures (a membership não persistiu na
   primeira tentativa); confirmado e corrigido recriando a fixture.
2. `503` inesperado em vários testes — causa: timeout por omissão (3s) demasiado agressivo para a latência
   real observada até ao pooler Supabase deste ambiente (até ~6.5s numa ligação fria); corrigido para 8s
   (`platform/client.ts`), com justificação registada no próprio código.
3. `own-db-unavailable` a devolver `500` em vez de `503` — causa: `isConnectionError` não percorria a cadeia
   `.cause` do erro embrulhado pelo drizzle-orm (o mesmo padrão que o próprio `ul-platform` já documenta e
   contorna em `shared/errors.ts`); corrigido da mesma forma.
4. Crash nativo do libuv no Windows (`UV_HANDLE_CLOSING`) em `platform-unavailable.test.ts` — reproduzido de
   forma consistente com o fluxo HTTP completo (servidor Express + pedido de saída); contornado testando
   `callPlatform` directamente (ainda uma tentativa de rede real a uma porta inatingível), evitando o ciclo de
   vida do servidor que despoletava o crash.
5. `entitlements.test.ts`'s "cache" — a subscrição da org E, uma vez cancelada por uma corrida anterior, fica
   cancelada para sempre (a API não tem "descancelar"); descoberto ao reutilizar a mesma fixture entre
   corridas de depuração. Corrigido reprovisionando fixtures antes da corrida final, e tornado o teste mais
   robusto (a janela "ainda quente" aceita 201 OU 403, já que depende de timing de rede real; o que é sempre
   verificado é nunca um 5xx nem "assumir activo" silenciosamente).

## 14. Platform changes

Nenhuma implementada. Ver [`platform-changes-required.md`](platform-changes-required.md) — 5 itens
identificados (PC-1 a PC-5), todos `OPTIONAL` ou `REQUIRED` só para fases futuras, nenhum `BLOCKER`.

## 15. Files created

- `na-pista/spikes/platform-integration/` — spike completo (código-fonte, testes, scripts), ~40 ficheiros.
- `na-pista/docs/decisions.md`, `integration-flow.md`, `platform-changes-required.md`, `f19-report.md`.
- `na-pista/docs/adr/ADR-011` … `ADR-017`.
- `ul-platform/scripts/f19-provision-fixtures.ts`, `f19-teardown-fixtures.ts` (fixtures de teste, nunca dados reais).

## 16. ADRs

ADR-011 (Service Identity) · ADR-012 (User/Membership Context) · ADR-013 (Application-level Authorization) ·
ADR-014 (Entitlement Consumption) · ADR-015 (Tenant Isolation Strategy) · ADR-016 (Service Scope Model) ·
ADR-017 (Failure and Fail-Closed Strategy). Todas em `docs/adr/`.

## 17. Git commits

Ver histórico do repositório `na-pista` (commits semânticos, um por preocupação — spike, isolamento,
autorização de serviço, entitlements, decisões fechadas, arquitectura de segurança) e um commit em
`ul-platform` para os dois scripts de fixtures (não altera nenhum código de produção do Platform).

## 18. Push

Nenhum remote configurado em `na-pista` nesta sessão — sem push (igual à F18). `ul-platform` tem remote
configurado mas não foi feito push nesta fase sem pedido explícito.

## 19. Remaining open decisions

- **OD-16, precondição de reavaliação:** provisionar um role Postgres dedicado (sem `BYPASSRLS`) para a
  ligação real da aplicação, repetir o teste de concorrência especificamente com esse role, só depois activar
  `ENABLE`+`FORCE ROW LEVEL SECURITY`.
- **PC-1 a PC-5** (`platform-changes-required.md`) — nenhuma bloqueia a F20, todas opcionais/futuras.
- **"Application suspensa"** — comportamento confirmado por leitura + suite existente do Platform, não
  reproduzido ao vivo neste spike (ver §1). Se uma prova ao vivo for exigida no futuro, requer ou um
  `PLATFORM_ADMIN` de teste dedicado (não personificar uma conta real) ou uma `Application` de teste
  descartável — nenhuma das duas foi criada aqui para não introduzir mais dados de teste persistentes ou
  aumentar o raio de uma acção potencialmente disruptiva num ambiente partilhado.
- Todas as decisões de negócio abertas da F18 (OD-01 a OD-10, OD-18 a OD-22) continuam abertas — fora do
  âmbito da F19, que só visava as decisões críticas de segurança/integração.

## 20. Critérios de aprovação (F19 §32)

- [x] OD-11 fechada
- [x] OD-12 fechada
- [x] OD-14 fechada
- [x] OD-16 resolvida — RLS explicitamente não activado, com razão técnica documentada (não "não necessária", mas "no-op com a ligação disponível; viável com um role dedicado, não provisionado")
- [x] entitlement flow funciona em runtime
- [x] service authentication funciona
- [x] service scopes funcionam
- [x] membership funciona
- [x] permission flow funciona
- [x] cross-tenant access é bloqueado
- [x] revoked credentials são rejeitadas
- [x] revoked membership é rejeitada
- [x] entitlement ausente bloqueia capability
- [x] failure modes possuem comportamento definido
- [x] fail-closed testado
- [x] request IDs preservados (`X-Request-ID` em todas as respostas — `shared/requestId.ts`)
- [x] nenhum secret exposto (fixtures em `.fixtures/`, `.gitignore`'d; `.env` real nunca commitado; ver nota em §21 sobre um incidente desta sessão)
- [x] testes E2E passam — 34/34, mais 15/15 unitários
- [x] lint passa — `npm run lint` (0 problemas)
- [x] typecheck passa — `npm run typecheck` (0 erros)
- [x] build passa — `npm run build` (0 erros)

## 21. Nota de segurança sobre esta sessão (transparência, fora do F19 §36 original)

Durante a preparação do ambiente, um comando de redacção mal formado nesta sessão imprimiu os valores reais de
`DATABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` e `SUPABASE_JWT_SECRET` do `.env` do
`ul-platform` na saída de uma ferramenta (não numa resposta ao utilizador). A partir desse momento esses
valores foram tratados como sensíveis: nunca foram reimpressos, nunca escritos em ficheiros deste repositório,
nunca commitados, nunca incluídos em logs aplicacionais. Nenhum ficheiro criado nesta fase contém esses
valores — confirmável por `grep` no histórico de commits. Registado aqui por disciplina de transparência, não
porque tenha afectado o resultado da F19.

## 22. F20 readiness

**Pronta para começar**, com estas condições já satisfeitas: autenticação, autorização (humana e de serviço),
entitlements, isolamento de tenant e modos de falha estão todos provados em runtime contra o Platform real.
Antes de construir o Product Module a sério (F20), recomenda-se:
1. Decidir OD-01 a OD-09 (moeda, variantes, unidade, etc. — `f18-review.md`).
2. Considerar PC-4 (renomear `catalog.enabled` → `products.enabled` no seed real) antes de codificar a chave
   definitiva no módulo real, para não herdar o nome interino do spike.
3. Substituir o registo de credenciais em memória (`serviceAuth.ts`) por um armazenamento real de segredos.
4. Decidir se o outbox de usage/eventos (não construído nesta fase) entra na F20 ou fica para depois do
   primeiro slice funcional.
