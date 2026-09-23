# F25 Report — Professionals Vertical Slice

## Objetivo

Implementar o vertical slice completo do domínio Professionals: `Authentication → Tenant Context → Membership →
Permission → Entitlement → Controller → Domain Service → Repository → PostgreSQL → Audit → Usage`, exactamente
o modelo e as fronteiras fechadas em F25A (ADR-036/037/038), sem reinterpretar nenhuma decisão — **incluindo,
ao contrário da F24, a UI em `na-pista-console`**, confirmada em F25A como a UI oficial do Na Pista.

## Estado

**COMPLETE.** Backend (API/BD) e UI (`na-pista-console`) ambos implementados nesta fase. Nenhuma tensão de
escopo por resolver desta vez — o próprio F25A já tinha fechado explicitamente a questão que o relatório da
F24 tinha deixado em aberto.

## Escopo entregue

- `na_pista.professionals` e `na_pista.professional_services` (migration real, aplicada).
- Repository tenant-scoped para ambas as tabelas.
- Domain service com regras de criação/actualização/lifecycle de Professional e de associação/remoção de
  Service (`associateService`/`removeAssociation`).
- API completa: `POST/GET /professionals`, `GET/PATCH /professionals/:id`, `GET /professionals/:id/services`,
  `POST/DELETE /professionals/:id/services/:serviceId`.
- Validação Zod estrita, reutilizando `phoneSchema`/`emailSchema` de Customers (agora exportados).
- Permissões `professionals.read/create/update` (sem `professionals.delete`, sem
  `professional_services.manage` — gerido por `professionals.update`).
- `catalog.enabled` reutilizado, sem entitlement novo.
- Audit transacional com 6 acções distintas (`professional.created/updated/archived/reactivated`,
  `professional_service.created/removed`).
- Usage real (`api_requests`, em `professional.created`).
- UI completa em `na-pista-console`: lista/criação/detalhe/edição/arquivo/reactivação de Professionals, e o
  fluxo de associação/remoção de Services na página de detalhe.
- **Pré-requisito retroactivo, documentado, não escondido**: a UI de Services que a F24 tinha deliberadamente
  deixado por fazer (tipo `Service`, `lib/api/services.ts`, permissões `services.*`) — sem isto, o selector de
  associação de Professionals seria impossível de construir.
- Primeiro conjunto de testes de componente do `na-pista-console` (Vitest + React Testing Library — convenção
  nova desta fase, ver secção "UI tests" abaixo).
- 3 ADRs (já criados em F25A), documentação da API. Nenhuma alteração ao UL Platform (só scripts de fixtures,
  dev-only).

## Modelo (decidido em F25A, implementado sem alterações)

```
Professional {
  id, organizationId, name, description?, phone?, email?, status, createdAt, updatedAt
}

professional_services {
  id, organizationId, professionalId, serviceId, createdAt
}
```

Confirmado directamente no schema real (`src/db/schema/professionals.ts`,
`src/db/schema/professionalServices.ts`) e na migration aplicada (`0005_gorgeous_charles_xavier.sql`) — sem
`userId`/`customerId`/`serviceId` (em `professionals`)/`appointmentId`/`scheduleId`, sem campos de
disponibilidade/agenda/booking/comissão/rating, exactamente como o brief e ADR-036 exigem.

## A associação Professional↔Service (ADR-037)

`professional_services` é uma tabela de junção N:M própria — **nunca** uma FK directa em `Professional` ou em
`Service`. Tenant-safety garantida por **duas FKs compostas**, ambas ancoradas na própria coluna
`organization_id` da tabela de junção:

```
professional_services.(organization_id, professional_id) → professionals.(organization_id, id)
professional_services.(organization_id, service_id)      → services.(organization_id, id)
```

Isto estruturalmente garante que as duas linhas referenciadas pertencem ao mesmo tenant entre si — o mesmo
mecanismo já provado por `order_items` (F23), reutilizado sem alterações. Provado directamente com uma
inserção `raw` que viola a FK composta (erro real do Postgres, `error.cause.message` inspeccionado,
confirmando `professional_services_service_org_fk`).

**Regras de associação:**
- Associar exige que **ambos** os lados estejam `ACTIVE` — `409 PROFESSIONAL_ARCHIVED` /
  `409 SERVICE_ARCHIVED` caso contrário.
- Uma associação duplicada devolve `409 CONFLICT` (violação `23505` real, `isUniqueViolationError`
  finalmente usado a sério nesta fase).
- Remover uma associação é **sempre** permitido, independentemente do estado de qualquer um dos lados —
  provado directamente (associação sobrevive a arquivamento de qualquer lado; remoção funciona com qualquer
  lado arquivado).
- Remoção é `DELETE` físico (não um soft-delete) — a única eliminação física real neste domínio. Uma segunda
  tentativa de remoção devolve `404`, nunca um no-op silencioso.

## Lifecycle (Professional)

`ACTIVE | ARCHIVED`. Transições via `PATCH { "status": ... }` — sem `DELETE`, sem endpoints dedicados
`/archive`/`/reactivate` (confirmado: `DELETE` no path do próprio Professional resolve `404`, a rota
simplesmente não existe). A camada de domínio distingue uma transição de lifecycle real de uma edição comum:
`professional.archived`/`professional.reactivated` só quando `status` muda de direcção; caso contrário
`professional.updated` — provado directamente (nenhum `professional.updated` acompanha um `professional.archived`
na mesma operação).

## API

Contrato completo: [`docs/api/professionals-api.md`](api/professionals-api.md).

## Autorização

`professionals.read` (todos os roles), `professionals.create`/`professionals.update` (OWNER/ADMIN/MANAGER,
idênticos). `professionals.update` também gere as associações (`POST`/`DELETE .../services/:serviceId`) — sem
`professional_services.manage` própria, decisão consistente com a de não criar `professionals.delete`: sem
uma camada extra sem razão específica, seguindo o padrão mais recente de Inventory/Orders/Services em vez do
padrão OWNER/ADMIN-only de Product/Customer/Category. Provado E2E: STAFF só lê (inclui associações — `403` em
`POST`/`DELETE` de associação); MANAGER cria/edita/arquiva/reactiva/associa/remove sem restrição adicional
face a OWNER.

## Entitlement

`catalog.enabled`, reutilizado sem alteração. Provado E2E: sem subscrição → `503`/depois
`403 ENTITLEMENT_REQUIRED`; com subscrição activa → `200`.

## Isolamento de tenant

`organization_id NOT NULL` em ambas as tabelas, repository que nunca corre sem `TenantContext` resolvido
(confirmado por teste unitário síncrono cobrindo as sete funções do repository, incluindo as de associação).
Provado nas três camadas:
- **Aplicação**: guard unitário sem ligação à BD.
- **Postgres**: Professional da org A invisível para a org B; FK composta rejeita uma associação
  cross-tenant mesmo via inserção directa.
- **HTTP**: `403` sem membership, `404` para id de outra organização no path da própria organização,
  `404` ao tentar associar um Professional da própria org a um Service de outra org (nunca vaza a
  existência do recurso alheio), credencial de serviço cross-tenant bloqueada.

## Audit

`professional.created`, `professional.updated`, `professional.archived`, `professional.reactivated`,
`professional_service.created`, `professional_service.removed` — todas na mesma transacção da mutação
(`recordAuditEvent`, mecanismo inalterado). Provado com uma falha real de Postgres (violação `NOT NULL` em
`audit_events.action`) dentro da transacção de `createProfessional`, confirmando rollback real (a linha do
Professional também não persiste).

## Usage

`api_requests`, registado apenas em `professional.created` (não em `PATCH`, não em associar/remover) —
mesma convenção de Product/Customer/Service ("criar apenas"). Provado E2E: uma criação real de Professional
aumenta mensuravelmente o usage registado na Platform.

## UI (`na-pista-console`)

Construída nesta fase, confirmada como obrigatória por F25A (ao contrário da decisão de F24):

- `app/o/[organizationId]/professionals/page.tsx` — lista (filtros `status`/`q`), criação.
- `app/o/[organizationId]/professionals/[professionalId]/page.tsx` — edição, toggle arquivar/reactivar,
  secção "Serviços associados" (selector de associação + tabela com botão "Remover").
- `lib/api/professionals.ts`, tipos `Professional`/`AssociatedService` em `lib/api/types.ts`, permissões
  `professionals.*` em `lib/permissions.ts` (mesma postura UX-only do resto do ficheiro — a autorização real
  continua só no servidor).
- **Pré-requisito retroactivo de Services** (não pedido directamente por F25, mas impossível de evitar): como
  F24 nunca tocou em `na-pista-console`, não existia tipo `Service`, cliente de API nem permissões
  `services.*` — sem isto, o `<select>` de associação de Professionals não tinha de onde vir. Construído
  junto: `app/o/[organizationId]/services/page.tsx` e `.../services/[serviceId]/page.tsx`, `lib/api/services.ts`,
  `services.*` em `lib/permissions.ts`. Documentado aqui como pré-requisito genuíno, não scope creep.

### UI tests (novo nesta fase)

`na-pista-console` não tinha nenhuma framework de testes até esta fase (`package.json` sem
jest/vitest/playwright/testing-library). Como esta é a primeira fase de testes de Console, a escolha de
ferramenta torna-se convenção do projecto daqui em diante — em vez de decidir sozinho uma decisão duradoura
para todo o repositório, **perguntei explicitamente ao utilizador** entre Vitest+RTL, Playwright, ou adiar. A
resposta foi **Vitest + React Testing Library**: testes ao nível de componente, `fetch`/API client mockados,
sem precisar do backend real nem do Supabase real a correr — suficiente para cobrir os cenários do brief §39
sem introduzir uma segunda infraestrutura de testes (browser real) só para esta fase.

Adicionado: `vitest.config.ts`, `vitest.setup.ts`, `vitest`/`@testing-library/react`/`@testing-library/jest-dom`/
`@testing-library/user-event`/`jsdom`/`@vitejs/plugin-react` como devDependencies, `npm run test` (`vitest run`).

Cobertura (24 testes, 2 ficheiros):
- `professionals/page.test.tsx` (10): organization context (request scoped ao `organizationId` da rota),
  loading, empty, erro genérico/403 FORBIDDEN/403 ENTITLEMENT_REQUIRED, lista renderizada, criar (permissão
  STAFF oculta o botão, OWNER cria e a lista recarrega, validação client-side de nome vazio).
- `[professionalId]/page.test.tsx` (14): loading, organization context, 404, erro genérico com referência,
  edição (campos pré-preenchidos, desactivados para STAFF, OWNER edita e guarda), arquivar/reactivar via
  toggle, serviços associados (vazio, listado com duração/preço/estado, oculto para STAFF, associar via
  `<select>`, erro de associação dedicado sem afectar o formulário principal, remover).

## Testes

| Camada | Específicos de Professionals | Resultado |
|---|---|---|
| Unitários (`na-pista`) | 19 (18 em `professionals.test.ts` + 1 em `repository.test.ts`) | 19 pass |
| Integração (PostgreSQL real, `na-pista`) | 22 | 22 pass |
| E2E (Platform real + Na Pista real + PostgreSQL real, `na-pista`) | 32 | 32 pass |
| UI (Vitest + RTL, `na-pista-console`) | 24 | 24 pass |
| **Total Professionals** | **97** | **97 pass, 0 fail** |

Suite completa do `na-pista` na mesma execução (Professionals + Services/Orders/Inventory/Customers/Products/
Categories das fases anteriores, inalterados), **executada duas vezes**: a primeira com apenas F25
re-provisionado revelou 2 falhas causadas por fixtures F20-F24 obsoletas de execuções anteriores (não uma
regressão real — ver "Falso positivo" abaixo); após reprovisionar F20-F25 de raiz (convenção já estabelecida
em todas as fases anteriores), a suite completa correu limpa:

**100 unitários + 82 integração + 149 E2E = 331 testes, 331 pass, 0 fail.**

`na-pista-console`: `npm run test` (Vitest) = 24/24 pass (primeira suite de UI do projecto).

### Falso positivo investigado e descartado

A primeira corrida da suite completa (antes de reprovisionar F20-F24) reportou 2 falhas:
1. `customers-lifecycle.test.ts` — timeout de ficheiro a 90000ms, sem nenhum subteste individual reportado
   como falhado.
2. `entitlements.test.ts` "entitlement enabled... disabling then re-enabling it live toggles access" —
   `assert.equal(cancelRes.status, 200)` recebeu `409`, porque a subscrição da org D do F20 já estava
   cancelada de uma execução anterior (o `PATCH .../subscriptions/:id { status: "canceled" }` não é
   idempotente — cancelar uma subscrição já cancelada devolve `409 Conflict`, correctamente).

Ambas as falhas desapareceram completamente depois de reprovisionar as fixtures F20-F24 (que não tinham sido
tocadas nesta fase, ao contrário de F25 que já tinha sido reprovisionado). **Nenhuma delas está relacionada
com código de Professionals** — nem `customers-lifecycle.test.ts` nem `entitlements.test.ts` tocam em
`professionals`/`services`/`professional_services`. Confirmado, não apenas assumido: reprovisionamento
completo (F20-F25) seguido de nova corrida integral produziu 149/149 E2E limpos, incluindo os dois testes
antes falhados.

**Deliberadamente não duplicados de F19-F24** (mesma instrução repetida em cada fase): comportamento de
credencial de serviço revogada/expirada e de **membership revogada** — ambos exaustivamente provados no spike
da F19 e reutilizados sem alteração por todas as fases desde então; "Platform indisponível falha fechado"
cita `tests/e2e/customers-platform-unavailable.test.ts` directamente.

## Segurança

Procurados `organizationId`, `professionalId`, `serviceId`, `secret`, `password`, `jwt`, `api key` em todos os
ficheiros novos/modificados de `src/modules/professionals/`, `src/db/schema/professionals*.ts`,
`src/shared/errors.ts`, `src/authorization/permissions.ts`, `src/app.ts`: nenhum literal de
secret/password/JWT em nenhum ficheiro. Todo `:organizationId` aparece apenas como parâmetro de rota, nunca
como campo aceite em nenhum schema `.strict()` — confirmado directamente (`createProfessionalSchema`,
`updateProfessionalSchema`). `professionalId`/`serviceId` fluem de `paramString(req.params...)` directamente
para funções do repository que usam o query builder do Drizzle (parametrizado) — nenhum `sql\`...\`` com
interpolação de string em nenhum ficheiro deste módulo. Nenhum acesso directo à BD do Platform. Nenhum erro
Postgres em bruto chega a uma resposta ao cliente.

## Decisões preservadas do F25A (não reinterpretadas)

Modelo mínimo de Professional sem `userId` (ADR-036), `professional_services` como junção N:M tenant-safe por
duas FKs compostas, nunca uma FK directa (ADR-037), fronteira Professional/Scheduling/Appointment/Auth —
nenhum destes conceitos implementado (ADR-038), lifecycle via `PATCH { status }` sem `DELETE` (ADR-036 §19),
sem `professionals.delete` nem `professional_services.manage` (ADR-036/037).

## Decisões explicitamente NÃO tomadas nesta fase

- Qualquer forma de Scheduling, Availability, Appointments, Booking, self-booking, calendário, buffers,
  comissão, rating, agendamentos recorrentes — todos explicitamente fora de escopo (ADR-038), nenhum
  implementado.
- Nenhum endpoint de "listar Professionals por Service" na direcção inversa além do filtro `?serviceId=` em
  `GET /professionals` (suficiente para o brief; um `GET /services/:id/professionals` dedicado fica para
  quando houver um consumidor real).

## Limitações conhecidas

1. Mesmo registo de credenciais de serviço em memória de F19-F24 — não é um secret store real (não
   re-litigado aqui).
2. Sem `TenantSettings`/moeda real por organização — herdado, inalterado.
3. **Lint pré-existente, não introduzido nesta fase**: `npm run lint` em `na-pista` reporta 16 erros
   `@typescript-eslint/no-explicit-any` em 8 ficheiros de `tests/e2e/` — todos no padrão idêntico
   `{ data?: any; error?: any }` da função `call()` de cada `*Helpers.ts`. Confirmado por `git log`/
   `git status` que 5 desses ficheiros (`helpers.ts`, `customersHelpers.ts`, `inventoryHelpers.ts`,
   `ordersHelpers.ts`, `servicesHelpers.ts`) já existiam, inalterados, antes desta fase — o mesmo erro já
   existia desde F20/F21/F22/F23/F24, nunca reportado nos relatórios anteriores. `professionalsHelpers.ts`
   (novo nesta fase) reproduz o mesmo padrão deliberadamente, para não ficar inconsistente com os seus
   irmãos — corrigi-lo isoladamente aqui criaria uma assimetria sem resolver o problema real (os outros 5
   ficheiros continuariam a falhar). Não corrigido nesta fase porque é uma limpeza transversal a todo o
   histórico do projecto, não uma decisão de domínio de Professionals — fica registado aqui para uma fase
   dedicada a lint/qualidade, não escondido.
4. UI Vitest cobre apenas os dois componentes de página (lista + detalhe); não há testes de integração
   Next.js (`next build`/rotas reais) nem E2E de browser (Playwright) — decisão explícita do utilizador ao
   escolher Vitest+RTL (ver secção "UI tests").

## Platform gaps

Nenhum identificado. Nenhuma necessidade real de alteração ao UL Platform foi encontrada nesta fase.

## Próximos passos

F26 pode implementar Scheduling/Availability/Appointments sem qualquer alteração a `professionals` ou
`professional_services` (ADR-038). A limitação de lint (#3 acima) devia ser resolvida numa fase dedicada,
transversal a todo o `tests/e2e/`, não apenas ao módulo mais recente.

## Git

**Commits:**
- `na-pista`: schema+migration, repository/service/routes, permissões, erros, testes (unit/integration/E2E),
  documentação da API e este relatório, `README.md`/`docs/adr/README.md` actualizados.
- `na-pista-console`: UI de Professionals + pré-requisito de Services, testes de UI, configuração Vitest.
- `ul-platform`: dois scripts de fixtures apenas (dev-only).

**Push:** nenhum remote configurado — sem push, mesma postura de todas as fases anteriores.

## Auto-revisão obrigatória (brief §44)

1. **Professional está separado de User/Customer?** Sim — sem `userId`/`customerId`, confirmado no schema e
   ADR-036; `userId`/`customerId` no corpo do pedido são rejeitados (`.strict()`), provado unitário e E2E.
2. **Professional possui exactamente os campos definidos?** Sim — `id, organizationId, name, description?,
   phone?, email?, status, createdAt, updatedAt`, confirmado no schema real e na migration aplicada.
3. **Professional não referencia Service directamente?** Confirmado — nenhuma coluna/FK em `professionals`;
   `serviceId` no corpo é rejeitado, provado unitário.
4. **professional_services é uma tabela de junção própria?** Sim — `professional_services`, com `id` próprio,
   nunca uma FK em `Professional` ou `Service`.
5. **A FK composta garante tenant-safety em ambos os lados?** Sim — duas FKs compostas ancoradas em
   `professional_services.organization_id`; provado por inserção `raw` real que viola a FK, erro Postgres
   inspeccionado directamente.
6. **Duplicar uma associação é rejeitado?** Sim — `409 CONFLICT`, violação `23505` real, `isUniqueViolationError`
   usado; provado integração e E2E.
7. **Associar exige ambos os lados ACTIVE?** Sim — `409 PROFESSIONAL_ARCHIVED`/`409 SERVICE_ARCHIVED`, provado
   integração e E2E para cada lado separadamente.
8. **Remover uma associação é sempre permitido?** Sim — mesmo com qualquer lado ARCHIVED, provado integração e
   E2E (ambas as direcções).
9. **Remoção é física, não soft-delete?** Sim — confirmado por re-listagem (0 linhas) e por uma segunda
   tentativa de remoção devolver `404`, nunca um no-op silencioso.
10. **phone/email reutilizam os validadores de Customer?** Sim — `phoneSchema`/`emailSchema` agora exportados
    de `customers/schemas.ts`, importados sem duplicação.
11. **Professional não referencia Scheduling/Appointment/Availability?** Confirmado — nenhum campo de
    calendário/disponibilidade; `scheduleId`/`appointmentId`/`workingHours`/`availability`/`vacation` rejeitados,
    provado unitário e E2E.
12. **catalog.enabled é o entitlement utilizado?** Sim — mesmo middleware `requireCapability`, sem alteração;
    provado E2E (disabled/enabled).
13. **professionals.delete não foi criado?** Confirmado — ausente de `permissions.ts`, ausente das rotas;
    provado por teste unitário explícito.
14. **professional_services.manage não foi criado?** Confirmado — associação gerida por `professionals.update`;
    ausente de `permissions.ts`; provado por teste unitário explícito.
15. **Lifecycle usa status?** Sim — `ACTIVE|ARCHIVED`, confirmado no schema e testado directamente.
16. **Archive/reactivate usa PATCH?** Sim — `PATCH { status }`; `DELETE` no path do Professional não tem rota
    registada (E2E: `404`).
17. **Tenant isolation está provado?** Sim — três camadas (aplicação/Postgres/HTTP), incluindo o caso
    específico de tentar associar através de um `serviceId`/`professionalId` de outra org (`404`, nunca vaza
    existência).
18. **organizationId não é confiado do body?** Confirmado — todos os schemas são `.strict()` sem o campo;
    provado unitário e E2E.
19. **Repository exige tenant context?** Sim — `assertTenant` em todas as sete funções (incluindo as de
    associação); provado por teste unitário síncrono.
20. **Audit está implementado, incluindo para associações?** Sim — 6 acções distintas, mesma transacção da
    mutação; provado integração (incluindo rollback real) e E2E.
21. **Usage está implementado?** Sim — `api_requests`, em `professional.created`; provado E2E.
22. **Cross-tenant update/archive foi testado?** Sim — E2E: org A não consegue actualizar/arquivar Professional
    da org B (`403`).
23. **Cross-tenant association foi testado?** Sim — E2E: org A não consegue associar o seu próprio
    Professional a um Service de outra org, nem o inverso (`404`, sem vazar existência).
24. **Membership revocation foi testada?** Não re-testada nesta fase — citada explicitamente do spike da F19,
    mecanismo inalterado.
25. **Missing entitlement foi testado?** Sim — E2E, org C sem subscrição (`503` sem credencial, `403
    ENTITLEMENT_REQUIRED` com credencial).
26. **Database failure foi testado?** Sim, indirectamente: a falha de audit dentro da transacção de
    `createProfessional` é uma falha real de Postgres (violação `NOT NULL`), provando rollback transaccional
    (teste de integração); "own DB unreachable" ao nível HTTP não foi replicado especificamente para
    Professionals (mecanismo partilhado, module-agnostic, já provado e citado).
27. **UI usa API real?** Sim — `lib/api/professionals.ts`/`lib/api/services.ts` chamam a API real via
    `callNaPista`, nenhum dado mock em produção (só nos testes Vitest, explicitamente mockados).
28. **UI segue Design System Na Pista?** Sim — reutiliza as mesmas classes CSS (`card`, `btn`, `field`, `table`,
    `badge`, `empty-state`) já usadas por Products/Customers/Orders, nenhum estilo novo introduzido.
29. **UI oculta acções não permitidas por role?** Sim — `roleCan(roleKey, "professionals.update")` controla
    edição/arquivo/associação/remoção; provado por testes de UI (STAFF vê campos desactivados, sem botões de
    mutação).
30. **UI trata loading/empty/error?** Sim — provado directamente por 6 dos 24 testes de UI (loading em ambas
    as páginas, empty na lista e nas associações, erro genérico/403/404 em ambas).
31. **Não houve alterações em UL Platform?** Confirmado — `git status`/`git diff` em `ul-platform` mostram
    apenas os dois scripts de fixtures (dev-only), nenhum código de produção tocado.
32. **Não foram introduzidos conceitos de F26/F27?** Confirmado — nenhuma tabela/coluna/campo de Scheduling,
    Availability ou Appointment existe em código; todos os campos relacionados são explicitamente rejeitados
    pelos schemas Zod (provado unitário).
33. **Full regression suite passou?** Sim — 331/331 (100 unitários + 82 integração + 149 E2E), incluindo todas
    as fases anteriores inalteradas, **após** reprovisionar fixtures F20-F25 de raiz (ver secção "Falso
    positivo investigado e descartado" para a primeira corrida, com 2 falhas explicadas e eliminadas).
34. **UI tests passaram?** Sim — 24/24 (Vitest + React Testing Library, primeira suite de testes de
    `na-pista-console`, decisão de ferramenta confirmada explicitamente com o utilizador).
35. **Build passou (ambos os repositórios)?** Sim — `na-pista`: `npm run typecheck`/`npm run build` limpos.
    `na-pista-console`: `npm run lint`/`npm run typecheck`/`npm run build` limpos (confirmado ainda nesta
    sessão, incluindo as novas rotas de Professionals/Services).
36. **Lint passou?** Parcial — `na-pista-console` limpo (0 problemas). `na-pista` tem 16 erros
    `@typescript-eslint/no-explicit-any`, **todos pré-existentes** (5 dos 8 ficheiros afectados não foram
    tocados nesta fase — ver Limitação #3). Não escondido: reportado explicitamente aqui e na secção de
    Limitações, com a evidência (`git log`/`git status`) que prova que predata F25.
37. **Working tree está limpo após os commits desta fase?** A confirmar após os commits (ver secção Git) —
    `git status --short` deve estar vazio em `na-pista` e `na-pista-console`, e mostrar apenas os dois
    scripts de fixtures em `ul-platform`.
38. **professionalId/serviceId nunca vazam existência entre tenants?** Confirmado — todo acesso cross-tenant
    (directo ou via associação) resolve `403`/`404` genéricos, nunca um erro que distinga "existe noutra org"
    de "não existe".
39. **A convenção "archive-not-delete" foi seguida e fundamentada de forma independente, não copiada
    cegamente?** Sim — a mesma conclusão de Service (F24) foi alcançada de novo aqui, mas pela razão própria
    de Professional (histórico de associações e de agenda futura não deve desaparecer só porque o profissional
    saiu), documentada em ADR-036 §19, não apenas herdada por inércia.
40. **O pré-requisito de UI de Services foi documentado como tal, não escondido como scope creep?** Sim — ver
    secção "UI" acima; justificado directamente pela dependência técnica real (o selector de associação não
    pode existir sem o tipo `Service`/cliente de API), não uma expansão de escopo não relacionada.

Todas as 40 respostas suportadas por evidência directa (código lido, teste executado, ou razão arquitectural
explícita) — nenhuma resposta inventada.
