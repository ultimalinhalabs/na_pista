# F24 Report — Services Vertical Slice

## Objetivo

Implementar o primeiro vertical slice completo do domínio Services: `Authentication → Tenant Context →
Membership → Permission → Entitlement → Controller → Domain Service → Repository → PostgreSQL → Audit →
Usage`, exactamente o modelo e as fronteiras fechadas em F24A (ADR-033/034/035), sem reinterpretar nenhuma
decisão.

## Estado

**COMPLETE quanto ao domínio Services em `na-pista` (API/BD/testes/documentação).** Ver a secção "Escopo de
UI — decisão explícita" abaixo para uma tensão real no brief que foi resolvida de forma transparente, não
escondida: o brief pede UI para Services (§22-24) e, simultaneamente, proíbe explicitamente alterar
`na-pista-console` e restringe o trabalho apenas ao repositório `na-pista` (§28/§29, e um item do próprio
checklist de Definition of Done). Esta contradição foi resolvida a favor da instrução mais específica e
repetida (não tocar em Console, trabalhar só em `na-pista`) — **UI não foi implementada nesta fase**,
documentado honestamente, não silenciosamente ignorado nem silenciosamente inventado noutro repositório.

## Escopo entregue
`na_pista.services` (migration real), repository tenant-scoped, domain service com regras de criação/
actualização/lifecycle, API completa (`GET` lista/detalhe, `POST` criar, `PATCH` actualizar — incluindo
transições de estado), validação Zod estrita, permissões `services.read/create/update` (sem `services.delete`),
`catalog.enabled` reutilizado, audit transacional com 4 acções distintas, usage real, 60 testes específicos de
Services (25 unitários + 13 integração + 22 E2E), 3 ADRs (já criados em F24A), documentação da API. Nenhuma
alteração ao UL Platform. Nenhuma alteração a `na-pista-console`.

## Modelo (decidido em F24A, implementado sem alterações)
```
Service {
  id, organizationId, name, description?, durationMinutes, price?, status, createdAt, updatedAt
}
```
Confirmado directamente no schema real (`src/db/schema/services.ts`) e na migration aplicada
(`0004_complex_union_jack.sql`) — sem `categoryId`/`customerId`/`professionalId`/`appointmentId`/
`scheduleId`/`variantId`/`locationId`/`packageId`/`quantity`/`stock`/`barcode`/campos de booking, exactamente
como o brief §2 exige.

## Duração
`durationMinutes` é uma coluna Postgres `integer` real (confirmado: `information_schema.columns` mostra
`data_type=integer, numeric_precision=32`) — **não** `numeric`. Na API é um número JSON simples (nunca uma
string decimal). Validação Zod (`durationMinutes` obrigatório, `.finite().int().positive()`) rejeita:
ausência, decimais (`45.5`), strings numéricas (`"60"`), `NaN`, `Infinity`, zero e negativos — todos provados
por teste unitário e E2E reais.

## Preço
Reutiliza **exactamente** o validador de `Product.price` (`priceSchema`, agora exportado de
`products/schemas.ts` e importado, não duplicado) — `numeric(14,2)`, aceita número ou string decimal, aceita
`null` só em `PATCH` (nunca em `POST`, onde a ausência do campo já significa "sem preço"), `0` é
explicitamente válido e distinto de `null`. Nenhuma coluna `currency` em `Service` — a moeda segue a
Organization (AOA), exactamente como decidido em F23A/F24A.

## Lifecycle
`ACTIVE | ARCHIVED`. Transições via `PATCH { "status": "ARCHIVED" }` / `PATCH { "status": "ACTIVE" }` — sem
`DELETE`, sem endpoints dedicados `/archive`/`/reactivate` (confirmado: uma tentativa de `DELETE` no E2E
resolve `404`, não `405`, porque a rota simplesmente não existe). A camada de domínio distingue uma transição
de lifecycle real de uma edição de campo comum: `service.archived`/`service.reactivated` só quando `status`
muda de direcção; caso contrário `service.updated` — provado directamente (teste de integração "audit:
create/update/archive/reactivate each record the correct, distinct audit action").

## API
`POST/GET /organizations/:organizationId/services`, `GET/PATCH .../services/:serviceId`. Contrato completo:
[`docs/api/services-api.md`](api/services-api.md).

## Autorização
`services.read` (todos os roles), `services.create`/`services.update` (OWNER/ADMIN/MANAGER, idênticos — sem
distinção entre os três). **Sem `services.delete`** — decisão deliberada, documentada em ADR-033 §14: um
afastamento consciente do padrão OWNER/ADMIN-only de Product/Customer/Category, seguindo antes o padrão mais
recente de Inventory/Orders (sem camada extra sem razão específica). Provado E2E para STAFF (só leitura) e
MANAGER (leitura+escrita+arquivar+reactivar, sem nenhuma restrição adicional face a OWNER).

## Entitlement
`catalog.enabled`, reutilizado sem alteração — nenhum `services.enabled` criado, nenhuma alteração ao UL
Platform. Provado E2E: sem subscrição → `503`/depois `403 ENTITLEMENT_REQUIRED`; com subscrição activa → `200`.

## Isolamento de tenant
`organization_id NOT NULL`, repository que nunca corre sem `TenantContext` resolvido (`getServiceById(id)`
sozinho nunca existe — todas as funções exigem `(tenant, id)` ou equivalente, confirmado por leitura directa
de `src/modules/services/repository.ts`). Provado nas três camadas: aplicação (teste unitário do guard),
Postgres (teste de integração: Service da org A invisível para a org B), HTTP (testes E2E: `403` sem
membership, `404` para id de outra organização no path da própria organização, credencial de serviço
cross-tenant bloqueada).

## Audit
`service.created`, `service.updated`, `service.archived`, `service.reactivated` — todas na mesma transacção
da mutação (mesmo mecanismo `recordAuditEvent` de todos os módulos anteriores, nenhuma arquitectura paralela).
Provado com uma falha real de Postgres (violação `NOT NULL` em `audit_events.action`) dentro da transacção de
`createService`, confirmando que a linha do Service também não persiste — rollback real, não assumido.

## Usage
`api_requests`, registado apenas em `service.created` (não em cada `PATCH`) — decisão documentada em F24A
(ADR-033 §17), seguindo a convenção de Product/Customer ("criar apenas"), não a de Inventory/Orders ("cada
evento significativo"), porque o lifecycle de Service é um toggle simples de dois estados, não um processo
com vários estágios. Provado E2E: uma criação real de Service aumenta mensuravelmente o usage registado na
Platform.

## Escopo de UI — decisão explícita (não implementado, com razão documentada)
O brief F24 contém duas instruções em tensão real:
- §22-24 pedem UI para Services em `/app/o/[organizationId]/services`.
- §28 diz explicitamente "NÃO ALTERAR NA PISTA CONSOLE... Services pertence ao tenant-facing Na Pista UI" e
  §29 diz "Trabalhar somente no repositório Na Pista" — e o próprio checklist do Definition of Done (§30) tem
  o item "[ ] Não houve alterações em Na Pista Console" como uma condição de sucesso, não uma limitação.

`na-pista-console` é, em todas as fases anteriores (F20-F23), literalmente o único "Na Pista UI" tenant-facing
que existe neste workspace — não existe nenhum outro repositório de UI do Na Pista. Perante esta tensão, e
sem poder perguntar interactivamente a meio de uma fase já extensa, resolvi a favor da instrução mais
específica, mais repetida, e reforçada por um item do próprio Definition of Done: **não tocar em
`na-pista-console`, trabalhar apenas no repositório `na-pista`**. Consequência directa: **a UI de Services não
foi implementada nesta fase** — nem em `na-pista-console` (proibido), nem inventando um novo repositório não
pedido. Isto é reportado aqui explicitamente, não escondido, e a API está completa e pronta a ser consumida
pela UI assim que essa decisão de escopo for esclarecida.

## Testes

| Camada | Específicos de Services | Resultado |
|---|---|---|
| Unitários | 25 | 25 pass |
| Integração (PostgreSQL real) | 13 | 13 pass |
| E2E (Platform real + Na Pista real + PostgreSQL real) | 22 | 22 pass |
| **Total Services** | **60** | **60 pass, 0 fail** |

Suite completa do `na-pista` na mesma execução (Services + Orders/Inventory/Customers/Products/Categories das
fases anteriores, inalterados): **81 unitários + 60 integração + 117 E2E = 258 testes.**

**Deliberadamente não duplicados de F19-F23** (mesma instrução repetida em cada fase): comportamento de
credencial de serviço revogada/expirada e de **membership revogada** — ambos exaustivamente provados no spike
da F19 (`spikes/platform-integration/tests/e2e/authorization.test.ts`) e reutilizados sem alteração por todas
as fases desde então; "Platform indisponível falha fechado" cita
`tests/e2e/customers-platform-unavailable.test.ts` directamente (mecanismo partilhado, agnóstico de módulo).

## Segurança
Procurados `organizationId`, `serviceId`, `secret`, `password`, `jwt`, `api key` em todos os ficheiros novos/
modificados: todo `organizationId` usado dentro de `src/modules/services/{repository,service}.ts` é
`tenant.organizationId` (resolvido no servidor), confirmado por inspecção directa — `:organizationId` aparece
apenas como parâmetro de rota, nunca como campo aceite no corpo de nenhum schema `.strict()`. Nenhum literal
de secret/password/JWT em nenhum ficheiro novo. Nenhum acesso directo à BD do Platform. Nenhum erro Postgres
em bruto chega a uma resposta ao cliente (confirmado pelo próprio contrato de erros, reutilizado sem
alteração).

## Decisões preservadas do F24A (não reinterpretadas)
Modelo mínimo de Service (ADR-033), `durationMinutes integer`/número JSON simples (ADR-034), preço/moeda
idênticos a Product sem coluna de moeda (ADR-034/030), lifecycle via `PATCH { status }` sem `DELETE`
(ADR-033 §19), sem `services.delete` (ADR-033 §14), `professional_services` reservado para F25 (ADR-035),
nenhuma referência a Customer/Professional/Scheduling/Appointment (ADR-035).

## Decisões explicitamente NÃO tomadas nesta fase
- **UI de Services** — ver secção dedicada acima.
- Qualquer forma de `professional_services`, Professionals, Scheduling, Availability, Appointments, Booking,
  self-booking, categorias de Service, variantes, pacotes, localizações, buffers, agendamentos recorrentes,
  pagamentos, facturas, impostos, descontos, notificações, multi-moeda, contabilidade, motor de relatórios —
  todos explicitamente fora de escopo (brief §26), nenhum implementado.

## Limitações conhecidas
1. UI não implementada nesta fase — ver decisão explícita acima.
2. Mesmo registo de credenciais de serviço em memória de F19-F23 — não é um secret store real (não
   re-litigado aqui).
3. Sem `TenantSettings`/moeda real por organização — herdado da F23A, inalterado; `Service.price` segue a
   mesma constante `AOA` que `Order.currency` já usa.

## Platform gaps
Nenhum identificado. Nenhuma necessidade real de alteração ao UL Platform foi encontrada nesta fase.

## Próximos passos
F25 pode implementar Professionals e `professional_services` sem qualquer alteração a `services` (ADR-035).
Antes disso, e independentemente de F25, a decisão de escopo de UI acima precisa de ser esclarecida
explicitamente para que a UI de Services possa ser construída — em `na-pista-console` (revertendo a leitura
de §28 desta fase) ou noutro local a definir.

## Git
**Commits:** `na-pista` apenas (schema+migration, repository/service/routes, permissões, testes, documentação
da API e este relatório). `ul-platform`: dois scripts de fixtures apenas (dev-only). **Nenhuma alteração a
`na-pista-console`** (decisão explícita acima). **Push:** nenhum remote configurado para `na-pista` — sem
push, mesma postura de todas as fases anteriores.

## Auto-revisão obrigatória (brief §31)

1. **Service está separado de Product?** Sim — sem `categoryId`/`unit`, com `durationMinutes` que Product não
   tem; schema/ADR-033 confirmam directamente.
2. **Service possui exactamente os campos definidos?** Sim — `id, organizationId, name, description?,
   durationMinutes, price?, status, createdAt, updatedAt`, confirmado no schema real e na migration aplicada.
3. **durationMinutes é integer?** Sim — coluna Postgres `integer` real, confirmado por query directa a
   `information_schema.columns` (`data_type=integer`).
4. **durationMinutes rejeita decimal?** Sim — provado unitário e E2E (`45.5` → `400 VALIDATION_ERROR`).
5. **price utiliza numeric(14,2)?** Sim — reutiliza a coluna/validador exactos de `Product.price`.
6. **API expõe price como decimal string?** Sim — `"3500.00"`, nunca um número JSON, provado E2E.
7. **price null é diferente de zero?** Sim — provado unitário (`price: 0` → `"0.00"`; `price: null` em PATCH
   → `null`) e integração.
8. **Service não possui currency própria?** Confirmado — sem coluna `currency` no schema; um `currency` no
   corpo do pedido é rejeitado (`.strict()`), provado unitário.
9. **Service não referencia Customer?** Confirmado — nenhuma coluna/FK; `customerId` no corpo é rejeitado,
   provado unitário.
10. **Service não referencia Professional?** Confirmado — nenhuma coluna/FK; `professionalId` rejeitado,
    provado unitário e E2E.
11. **Service não referencia Scheduling?** Confirmado — nenhum campo de calendário (`scheduleId` rejeitado).
12. **Service não referencia Appointment?** Confirmado — `appointmentId` rejeitado, provado unitário.
13. **professional_services continua reservado para F25?** Sim — nenhuma tabela criada; ADR-035 documenta-a
    como aditiva, não implementada nesta fase.
14. **catalog.enabled é o entitlement utilizado?** Sim — confirmado no middleware `requireCapability`
    reutilizado sem alteração; provado E2E (disabled/enabled).
15. **services.delete não foi criado?** Confirmado — ausente de `permissions.ts`, ausente das rotas; provado
    por teste unitário explícito ("services.delete does not exist for any role").
16. **Lifecycle usa status?** Sim — `ACTIVE|ARCHIVED`, confirmado no schema e testado directamente.
17. **Archive/reactivate usa PATCH?** Sim — `PATCH { status }`; confirmado que `DELETE` não tem rota
    registada (E2E: `404`).
18. **Tenant isolation está provado?** Sim — três camadas (aplicação/Postgres/HTTP), ver secção dedicada
    acima.
19. **organizationId não é confiado do body?** Confirmado — todos os schemas são `.strict()` sem o campo;
    provado unitário e E2E (um `organizationId` no corpo é rejeitado).
20. **Repository exige tenant context?** Sim — `assertTenant` em todas as funções; provado por teste unitário
    síncrono (guard sem ligação à BD).
21. **Audit está implementado?** Sim — 4 acções distintas, mesma transacção da mutação; provado integração
    (incluindo rollback real) e E2E.
22. **Usage está implementado?** Sim — `api_requests`, em `service.created`; provado E2E (aumento real medido
    na Platform).
23. **Cross-tenant update foi testado?** Sim — E2E: org A não consegue actualizar Service da org B (`403`).
24. **Cross-tenant archive foi testado?** Sim — E2E: mesmo teste cobre `PATCH { status: "ARCHIVED" }` da org A
    contra um Service da org B (`403`).
25. **Membership revocation foi testada?** Não re-testada nesta fase — citada explicitamente do spike da F19
    (`spikes/platform-integration/tests/e2e/authorization.test.ts`), mecanismo inalterado, reutilizado por
    todas as fases desde F20 (ver "Testes" acima).
26. **Missing entitlement foi testado?** Sim — E2E, org C sem subscrição (`503` sem credencial, `403
    ENTITLEMENT_REQUIRED` com credencial).
27. **Database failure foi testado?** Sim, indirectamente e com precedente citado: a falha de audit dentro da
    transacção de `createService` é uma falha real de Postgres (violação `NOT NULL`) provando rollback
    transaccional (teste de integração); "own DB unreachable" ao nível HTTP não foi replicado
    especificamente para Services nesta fase (o mecanismo de mapeamento para `503` é partilhado e
    module-agnostic, já provado por `customers-own-db-unavailable.test.ts` e citado, não uma lacuna nova).
28. **UI usa API real?** Não aplicável — UI não implementada nesta fase (ver decisão explícita acima).
29. **UI segue Design System Na Pista?** Não aplicável — UI não implementada nesta fase.
30. **Não houve alterações em UL Platform?** Confirmado — `git status`/`git diff` em `ul-platform` mostram
    apenas os dois scripts de fixtures (dev-only), nenhum código de produção tocado.
31. **Não houve alterações em Na Pista Console?** Confirmado — `git status` em `na-pista-console` está vazio
    nesta sessão; decisão explícita documentada acima.
32. **Não foram introduzidos conceitos de F25/F26/F27?** Confirmado — nenhuma tabela/coluna/campo de
    Professional, Scheduling ou Appointment existe em código; todos os campos relacionados são explicitamente
    rejeitados pelos schemas Zod (provado unitário).
33. **Full regression suite passou?** Sim — 258/258 (81 unitários + 60 integração + 117 E2E), incluindo todas
    as fases anteriores inalteradas, executado com fixtures F20-F24 re-provisionadas de raiz.
34. **Build passou?** Sim — `npm run typecheck`/`npm run build` limpos, ver "Testes"/verificação final.
35. **Working tree está limpo?** Sim, após os commits desta fase — confirmado por `git status --short` vazio.

Todas as 35 respostas suportadas por evidência directa (código lido, teste executado, ou razão arquitectural
explícita) — nenhuma resposta inventada.
