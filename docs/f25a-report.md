# F25A Report — Professionals Domain Decision Spike

## Status

**COMPLETE.** F25A is a decision spike; its Definition of Done is a coherent, evidence-based decision package
— not running code. Every question the brief asked (§1–§34, self-review §35) is answered with either a
citation to prior work/code actually inspected, or explicit, reasoned architectural decision-making where no
prior precedent existed. Nothing was silently reinterpreted or copied blindly: where Professional's decisions
follow Service/Customer precedent, the reasoning is restated for Professional specifically (per the brief's
own "não copiar Product ou Service cegamente" instruction), not assumed to transfer automatically. No
Professional/`professional_services` production code, migration, API, or UI exists after this phase —
confirmed by `git status`/`git diff` below.

## Decisions

See [`docs/f25a-professionals-decisions.md`](f25a-professionals-decisions.md) for the full package. Summary:
Professional is a minimal catalog-of-people entity (`name`, `description?`, `phone?`, `email?`, `status`) —
not a Product/Service clone, not a Platform User (no `userId` in this phase); the Professional↔Service
relationship is a real N:M join table (`professional_services`), tenant-safe via the same two-composite-FK
pattern `order_items` already proves, with explicit `409`/`404`/archived-side error semantics; lifecycle is
the same `ACTIVE|ARCHIVED` toggle via `PATCH { status }` every recent module uses, no
`professionals.delete`; Professional never contains anything Scheduling- or Appointment-shaped; `na-pista-
console` is confirmed as the official future UI target (resolving the tension F24's own report flagged), not
built in this phase.

## Alternatives considered

Full reasoning per decision lives in each ADR's own "Alternatives" section. Highest-signal ones:
1. **Cloning Product/Service's shape onto Professional** — rejected; Professional has identity/contact
   semantics neither has and none of Service's pricing/duration semantics — ADR-036.
2. **A `professional.userId` FK to the Platform's `users` table now** — rejected; no demonstrated need,
   would conflate identity with an operational resource — ADR-036/038.
3. **`service.professionalId` or `professional.serviceIds` (array)** — both rejected; a real N:M join table
   is the only structurally tenant-safe, queryable, indexable shape — ADR-037.
4. **A `status` column on `professional_services`** — rejected; no demonstrated need for a soft-disable state
   beyond create/remove — ADR-037.
5. **Idempotent (silently-succeeding) duplicate association `POST`** — rejected in favor of explicit `409
   CONFLICT`, matching this codebase's consistent posture — ADR-037.
6. **`ON DELETE CASCADE` on the join table's FKs** — rejected; nothing in this domain ever physically deletes
   a Professional or Service, so cascade is never exercised and would only imply a pathway that doesn't
   exist — ADR-037.
7. **A separate `professional_services.manage` permission** — considered, not chosen; `professionals.update`
   covers association management too, mirroring Order's own item-management precedent — ADR-036/§8 of the
   decisions doc.

## ADRs produced

- [ADR-036 — Professional Domain Model](adr/ADR-036-professional-domain-model.md)
- [ADR-037 — Professional-Service Relationship (`professional_services`)](adr/ADR-037-professional-service-relationship.md)
- [ADR-038 — Professional / Scheduling / Appointment / Auth Boundary](adr/ADR-038-professional-scheduling-appointment-boundary.md)

Three ADRs, matching the brief's own suggested count (§31) and its "usar menos ADRs se duas decisões puderem
ser agrupadas" instruction — the domain model and the relationship are genuinely distinct decision clusters
(one entity's own shape vs. a cross-entity structural mechanism) and each stands as its own document; the
boundary/auth decisions share one ADR since both are about what Professional explicitly excludes and defers.

## F25 implementation contract

See [`docs/f25a-professionals-decisions.md`](f25a-professionals-decisions.md) §17 — reproduced there in full
(both table shapes, the additive `services` migration step, API routes, authorization/entitlement/audit/usage
contracts). Not duplicated here to avoid the two documents drifting apart.

## Platform gaps

None identified. No UL Platform change is needed for F25 — `catalog.enabled` (unchanged), no new scope, no
new meter, no new application.

## Known limitations

1. **UI contract defined, not built** — `na-pista-console` is confirmed as the target (§15 of the decisions
   doc), but F25A itself implements no UI, per its own explicit scope.
2. **No `platformUserId`** — Professional cannot yet be linked to a real login; deferred until a real
   requirement demonstrates it (ADR-036/038).
3. **Personal-data/retention framework** for Professional contact fields remains F18's open OD-22, unresolved
   — same posture as Customer's own unresolved instance of the same question.

## Deferred decisions

`platformUserId`, the reverse association lookup endpoint, all of Scheduling (F26) and Appointments (F27),
and OD-22 (privacy/retention) — each named explicitly in `docs/f25a-professionals-decisions.md` §18, with a
stated future owner.

## Self review (brief §35)

1. **O que é Professional?** A pessoa/recurso operacional que executa um ou mais Services do catálogo da
   Organization — uma entidade de domínio do Na Pista, não uma identidade de autenticação (ADR-036).
2. **Professional é User?** Não — nenhuma referência ao Platform User nesta fase; um link futuro *opcional*
   está documentado, não implementado (ADR-036/038).
3. **Professional é Customer?** Não — conceptualmente distinto: Customer é quem é atendido, Professional é
   quem atende; nenhuma relação directa entre as duas entidades.
4. **Qual é o modelo mínimo?** `id, organizationId, name, description?, phone?, email?, status, createdAt,
   updatedAt` — nenhum campo a mais (ADR-036, decisões §2).
5. **Name é obrigatório?** Sim.
6. **Name possui unique constraint?** Não — mesma razão de `Customer.name`/`Service.name` (ADR-024/033,
   estendida com razão própria em ADR-036).
7. **Email existe?** Sim, opcional, reutiliza o validador exacto de `Customer.email`.
8. **Phone existe?** Sim, opcional, reutiliza o validador exacto de `Customer.phone`.
9. **Contactos são únicos?** Não — mesma razão de `Customer` (linha partilhada, contacto ainda não
   configurado individualmente são estados legítimos).
10. **Existe description/bio?** Sim, opcional, texto simples, ≤2000 caracteres, propósito operacional (não
    marketing/rich text).
11. **Qual é o lifecycle?** `ACTIVE | ARCHIVED`, sem estados de disponibilidade (`ON_LEAVE`/`BUSY`/etc. —
    pertencem à F26).
12. **Existe ACTIVE/ARCHIVED?** Sim.
13. **Como ocorre archive/reactivate?** `PATCH { status }` — sem `DELETE`, sem endpoints dedicados, mesmo
    padrão que a F24 acabou de estabelecer para Service.
14. **Professional pode existir sem Service?** Sim — onboarding incremental (decisões §7).
15. **Service pode existir sem Professional?** Sim — inalterado desde a F24; `services` não é tocado nesta
    fase.
16. **A relação é N:M?** Sim, via `professional_services` (ADR-037).
17. **Onde vive a relação?** Numa tabela de junção própria, nunca uma FK directa em `Professional` ou
    `Service`.
18. **Qual é a chave de professional_services?** `id uuid` próprio (surrogate, consistente com todas as
    outras tabelas) + `UNIQUE(organization_id, professional_id, service_id)`.
19. **Como impedir duplicação?** O `UNIQUE` composto acima; uma segunda tentativa resolve `409 CONFLICT`.
20. **Como impedir cross-tenant association?** Duas FKs compostas, ambas fixadas em
    `professional_services.organization_id` — o mesmo mecanismo já provado por `order_items` (ADR-037).
21. **Professional pode continuar associado a Service ARCHIVED?** Sim — arquivar nunca remove associações
    existentes (ADR-037).
22. **Pode criar associação com Professional ARCHIVED?** Não — `409 PROFESSIONAL_ARCHIVED` (novo, definido
    para a F25 implementar).
23. **Pode criar associação com Service ARCHIVED?** Não — `409 SERVICE_ARCHIVED` (idem).
24. **Quais são as permissions?** `professionals.read` (todos), `professionals.create`/`professionals.update`
    (OWNER/ADMIN/MANAGER, idênticos).
25. **Existe services.delete?** Não é a pergunta desta fase (isso já foi decidido na F24: não existe). Para
    Professional: **`professionals.delete` não existe** — mesma decisão, razão própria documentada em
    ADR-036/decisões §8.
26. **Qual entitlement é usado?** `catalog.enabled`, sem alteração.
27. **Quais audit events existem?** `professional.created/updated/archived/reactivated`,
    `professional_service.created/removed`.
28. **Quais usage events existem?** `api_requests`, apenas em `professional.created`.
29. **Repository exige TenantContext?** Sim — decisão explícita, restatement do padrão desde ADR-021, sem
    `getProfessionalById(id)` sem tenant.
30. **Qual é a API futura?** `GET/POST /professionals`, `GET/PATCH /professionals/:id`,
    `GET/POST/DELETE /professionals/:id/services[/:serviceId]` (decisões §13/§6).
31. **Como funciona search?** `status`, `q` (nome, ILIKE), `serviceId` (filtro por associação), `limit`
    (1-100, default 50) — sem motor de pesquisa avançado.
32. **Qual é a UI futura?** `/o/[organizationId]/professionals` em `na-pista-console` (confirmado
    explicitamente por este brief) — lista, criar/editar, arquivar/reactivar, gerir associações a Services.
    Não implementada nesta fase.
33. **Onde começa Scheduling?** Onde `Professional` (quem) e `Service` (o quê) se encontram com "quando" —
    Scheduling consome `durationMinutes` de Service e a existência de Professional/`professional_services`,
    nada mais (ADR-038).
34. **Onde começa Appointment?** Na instância concreta que combina Customer+Service+Professional+When+
    snapshot — nenhuma dessas relações vive em `Professional` (ADR-038).
35. **Professional precisa de Auth?** Não, por definição — pode ser um recurso puramente operacional sem
    conta alguma (ADR-036 §"Decision").
36. **Como F27 usará Professional?** Vai referenciá-lo (mais `Service`/`Customer`) e snapshotar
    `professionalId`/`professionalName` no momento da marcação, validando que o par `(professionalId,
    serviceId)` existe em `professional_services` — nenhuma alteração a `Professional` necessária (ADR-038).
37. **F25 exige alteração em Service?** Sim, uma: um índice único `(organization_id, id)` aditivo em
    `services` (necessário para a FK composta de `professional_services`) — nenhuma outra alteração, nenhum
    redesenho (ADR-037).
38. **F26 exige alteração em Professional?** Não — Scheduling introduz as suas próprias tabelas, lê
    `Professional`/`professional_services` sem alteração (ADR-038).
39. **F27 exige alteração em Professional?** Não — pela mesma razão (ADR-038).
40. **Há Platform gaps?** Nenhum identificado (secção dedicada acima).
41. **Há decisões ainda abertas?** As explicitamente deferidas (§18 do pacote de decisões) — nenhuma delas
    bloqueia a implementação da F25.
42. **Todas as decisões necessárias para F25 estão fechadas?** Sim — o contrato de implementação (§17 do
    pacote de decisões) especifica todos os campos, constraints, rotas, permissões, e contratos de
    audit/usage necessários.

Todas as 42 respostas suportadas por evidência directa ou razão arquitectural explícita — nenhuma resposta
inventada. Marcando **COMPLETE**.

## Git

**Commits:** `na-pista` apenas (ADR-036..038, `docs/f25a-professionals-decisions.md`, este relatório,
actualização do índice de ADRs). Nenhuma alteração a `ul-platform` nesta fase (nenhum fixture necessário —
spike puro de documentação). Nenhuma alteração a `na-pista-console`. **Push:** nenhum remote configurado para
`na-pista` — sem push, mesma postura de todas as fases anteriores.

## Próximo passo exacto

**F25 — Professionals Vertical Slice**: implementar `Professional` e `professional_services` exactamente
conforme o contrato de `docs/f25a-professionals-decisions.md` §17, reutilizando o padrão tenant-scoped-
repository/entitlement-gate/audit/usage já provado cinco vezes (Categories, Products, Customers, Inventory,
Orders, Services), e o padrão exacto de validação de contacto já implementado em `customers/schemas.ts`
(exportar `phoneSchema`/`emailSchema`, não duplicar). Nenhuma decisão arquitectural deve ficar por tomar
durante a implementação da F25.
