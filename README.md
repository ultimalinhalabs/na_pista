# Na Pista

> **Na Pista é um SaaS Multi Tenant de gestão que possibilita aos gestores de empresas provedoras de produtos ou
> serviços fazer a gestão de seus processos por meio dos recursos que a plataforma proverá.**

Aplicação independente do ecossistema Última Linha. Uma **infraestrutura modular de gestão empresarial** exposta
por API — não um ERP, POS, CRM nem software de loja/barbearia (esses são contextos de utilização dos módulos).

## Estado

**F18 (arquitectura/domínio): PARTIAL** — blueprint técnico, sem código de produto (ver [`docs/f18-review.md`](docs/f18-review.md)).

**F19 (integração Platform↔Na Pista): ver [`docs/f19-report.md`](docs/f19-report.md)** — spike removível em
[`spikes/platform-integration/`](spikes/platform-integration/) que prova em runtime, contra o UL Platform real
(HTTP + Postgres reais), as decisões críticas de segurança que a F18 tinha deixado em aberto (OD-11, OD-12,
OD-13, OD-14, OD-16). Não é o Product Module real — só o suficiente para validar o contrato antes de o construir.

**F20 (Product Management, vertical slice real): COMPLETE — ver [`docs/f20-report.md`](docs/f20-report.md).**
Primeiro módulo de negócio real: `src/` (Categories + Products), BD própria com migrations reais
(`drizzle/migrations/`), autorização e entitlement a sério, audit e usage reais, 42/42 testes (unitários +
integração + E2E, todos contra o Platform e o Postgres reais). UI própria em
[`../na-pista-console`](../na-pista-console) (repositório irmão, ADR-008).

**F21 (Customer Management, primitiva transversal): COMPLETE — ver [`docs/f21-report.md`](docs/f21-report.md).**
Segundo módulo de negócio real: Customers, deliberadamente independente de Products/Categories e do User do
Platform (ADR-025), pronto para futuros módulos de Commerce (`Customer → Order`) e Serviços
(`Customer → Appointment`). 37/37 testes específicos de Customers; suite completa do `na-pista` (Customers +
Products/Categories da F20, inalterados) em 79/79.

**F22 (Inventory Management, vertical slice real): COMPLETE — ver [`docs/f22-report.md`](docs/f22-report.md).**
Terceiro módulo de negócio real: `Product → InventoryBalance → StockMovement`, com OD-04 (unidades/quantidades
fraccionárias), OD-05 (stock negativo/backorder) e OD-06 (localizações) fechadas via ADR-027/ADR-028. Mutação
de balance atómica e concorrência-segura (`UPDATE`/`INSERT ON CONFLICT` condicional, sem `SELECT ... FOR
UPDATE`), **provada com transacções Postgres realmente concorrentes** (não apenas revisão de código): duas
saídas simultâneas de 7 contra um saldo de 10 resolvem em exactamente uma sucedida, saldo final 3. 48/48 testes
específicos de Inventory; suite completa do `na-pista` (Inventory + Customers/Products/Categories das fases
anteriores, inalterados) em 127/127.

**F23A (arquitectura de Commerce & Money): COMPLETE — ver [`docs/f23a-report.md`](docs/f23a-report.md).**
Decision spike — **sem** Orders/OrderItems/preço implementados. Fecha OD-01 (moeda/dinheiro, para o âmbito de
moeda única AOA) e OD-03 (`Order.customerId` opcional): dinheiro = `numeric(14,2)` + string decimal na API
(desvio explícito e fundamentado da proposta original de "minor units" da F18 — ver ADR-029), arredondamento
= `ROUND()` nativo do Postgres (half-away-from-zero, **confirmado empiricamente** contra a BD real), moeda =
uma por Organization, sempre snapshot em `Order.currency`, `OrderItem` faz snapshot de `unitPrice`/
`productName`, ciclo de vida mínimo `DRAFT → CONFIRMED → COMPLETED|CANCELED` com Inventory a mudar **só** em
`CONFIRMED` (reutilizando `ADJUSTMENT_OUT`/`ADJUSTMENT_IN` sem alterar o modelo de Inventory). ADR-029..032.
Pacote de decisão completo em [`docs/f23a-commerce-money-decisions.md`](docs/f23a-commerce-money-decisions.md)
— a F23 pode implementar Orders sem tomar nenhuma decisão monetária nova.

**F23 (Order Management, vertical slice real): COMPLETE — ver [`docs/f23-report.md`](docs/f23-report.md).**
Quarto módulo de negócio real e primeiro domínio de Commerce: `Order → OrderItem`, implementando o contrato da
F23A exactamente (ADR-029..032), sem reinterpretar nenhuma decisão monetária/de ciclo de vida. Inventory muda
**só** em `CONFIRMED`, reutilizando o `createMovement` da F22 **sem alterações ao seu modelo/schema** (apenas
um parâmetro opcional de transacção externa, para que Order + movimentos de stock + audit sejam atómicos numa
única transacção Postgres). **Prova obrigatória de concorrência reutilizada da F22, sem lógica nova**: duas
Orders a confirmar em simultâneo por 7 unidades cada, contra um stock de 10 → exactamente uma `CONFIRMED`,
stock final 3, um único movimento. 71/71 testes específicos de Orders; suite completa do `na-pista` (Orders +
Inventory/Customers/Products/Categories das fases anteriores, inalterados) em 198/198.

**F24A (decisões de domínio de Serviços): COMPLETE — ver [`docs/f24a-report.md`](docs/f24a-report.md).**
Decision spike — **sem** Service/Professional/Scheduling/Appointment implementados. Fecha o modelo mínimo de
`Service` (não um clone de Product: sem categorias, sem variantes, com `durationMinutes`), a representação de
duração (`durationMinutes integer`, número JSON simples — excepção deliberada e fundamentada à convenção
"dinheiro/quantidade = string decimal", já que um inteiro limitado não tem o problema de precisão de float que
essa convenção resolve), preço/moeda reutilizando a F23A sem nenhuma decisão nova (`numeric(14,2)`, sem coluna
de moeda), e as fronteiras Service/Professional/Scheduling/Appointment (Service não referencia Professional
nem Customer; `professional_services` fica para a F25, aditivo, sem redesenhar Service). ADR-033..035. Pacote
de decisão completo em [`docs/f24a-services-decisions.md`](docs/f24a-services-decisions.md) — a F24 pode
implementar o catálogo de Serviços sem tomar nenhuma decisão de domínio nova.

**F24 (Service Management, vertical slice real — API/BD): COMPLETE — ver [`docs/f24-report.md`](docs/f24-report.md).**
Quinto módulo de negócio real: `Service`, implementando o contrato da F24A exactamente (ADR-033..035) —
`durationMinutes integer` (número JSON simples, nunca string decimal), preço/moeda idênticos a Product sem
coluna de moeda própria, lifecycle `ACTIVE|ARCHIVED` via `PATCH { status }` (sem `DELETE`, sem
`services.delete`). 60/60 testes específicos de Services; suite completa do `na-pista` (Services + Orders/
Inventory/Customers/Products/Categories das fases anteriores, inalterados) em 258/258. **UI não implementada
nesta fase** — o próprio brief da F24 proibiu explicitamente alterar `na-pista-console` e restringiu o
trabalho ao repositório `na-pista`; decisão documentada, não escondida, em `docs/f24-report.md`.

**F25A (decisões de domínio de Professionals): COMPLETE — ver [`docs/f25a-report.md`](docs/f25a-report.md).**
Decision spike — **sem** Professional/`professional_services` implementados. Fecha o modelo mínimo de
Professional (não é User, não é Customer, não é clone de Product/Service — `name`/`description?`/`phone?`/
`email?`/`status`, sem `userId`), e a decisão central: a relação Professional↔Service é uma tabela de junção
N:M própria (`professional_services`), tenant-safe por duas FKs compostas (o mesmo mecanismo já provado por
`order_items`), nunca uma FK directa em nenhum dos dois lados. Lifecycle via `PATCH { status }`, sem
`professionals.delete` (mesma razão da F24, agora fundamentada de forma própria para Professional).
`na-pista-console` é confirmado explicitamente como a UI oficial futura — resolvendo a tensão que o próprio
relatório da F24 tinha assinalado — mas a UI não é construída nesta fase. ADR-036..038. Pacote de decisão
completo em [`docs/f25a-professionals-decisions.md`](docs/f25a-professionals-decisions.md) — a F25 pode
implementar Professionals sem tomar nenhuma decisão de domínio nova.

**F25 (Professional Management, vertical slice real — API/BD/UI): COMPLETE — ver [`docs/f25-report.md`](docs/f25-report.md).**
Sexto módulo de negócio real: `Professional` + `professional_services`, implementando o contrato da F25A
exactamente (ADR-036..038) — sem `userId`, sem campos de agenda/disponibilidade, lifecycle `ACTIVE|ARCHIVED`
via `PATCH { status }` (sem `DELETE`, sem `professionals.delete`, sem `professional_services.manage`). A
associação Professional↔Service é uma tabela de junção N:M tenant-safe por duas FKs compostas próprias
(`professional_services.(organization_id, professional_id)`/`(organization_id, service_id)`), nunca uma FK
directa em nenhum dos dois lados — o mesmo mecanismo já provado por `order_items` (F23), reutilizado sem
alterações. Associar exige que ambos os lados estejam `ACTIVE` (`PROFESSIONAL_ARCHIVED`/`SERVICE_ARCHIVED`,
409); remover uma associação é sempre permitido, mesmo com um dos lados arquivado. **Ao contrário da F24, esta
fase constrói a UI** em [`../na-pista-console`](../na-pista-console) (confirmado em F25A como a UI oficial),
incluindo o preenchimento retroactivo da UI de Services que a F24 tinha deliberadamente deixado por fazer
(tipo `Service`, cliente de API, permissões) — pré-requisito real para o selector de associação de
Professionals, não scope creep. Testes unitários/integração/E2E do `na-pista` e o primeiro conjunto de testes
de componente do `na-pista-console` (Vitest + React Testing Library, convenção nova desta fase — ver
`docs/f25-report.md` "UI tests").

**F26A (decisões de domínio de Scheduling & Availability): COMPLETE — ver [`docs/f26a-report.md`](docs/f26a-report.md).**
Decision spike — **sem** Scheduling/Appointment implementados. Corrige uma lacuna real encontrada por
inspecção directa: a F18 assumia `TenantSettings.timezone`, que **não existe** em `ul-platform` (nem
`TenantSettings` nem qualquer campo de timezone em `organizations`) — decisão fechada: o fuso horário passa a
ser propriedade do próprio Na Pista (`organization_settings`, tabela nova, própria), nunca do UL Platform.
Scheduling é `Professional`-cêntrico (não `Service`-cêntrico), duas tabelas aditivas
(`professional_schedule_rules`, `professional_schedule_exceptions`), regras semanais + excepções por data
(a excepção substitui inteiramente a regra semanal nesse dia, nunca um merge parcial), sem entidade `Break`
(intervalos múltiplos já bastam), sem slots pré-gerados (disponibilidade sempre calculada, nunca armazenada —
valida a proposta original da F18 em vez de a copiar cegamente), sem buffers/localizações/recursos/horário de
organização nesta fase (cada um com caminho de extensão aditivo documentado). Fronteira Scheduling/Appointment
fechada: Scheduling nunca contém Customer nem estado de reserva; F27 terá de revalidar disponibilidade no
momento da escrita (leitura de disponibilidade é apenas indicativa, nunca uma garantia transaccional).
ADR-039..041. Zero alterações a `Service`/`Professional`/`professional_services`/UL Platform. UI não
implementada nesta fase (spike puro).

**F26 (Scheduling & Availability, vertical slice real — API/BD/UI): COMPLETE — ver [`docs/f26-report.md`](docs/f26-report.md).**
Sétimo módulo de negócio real: implementa o contrato da F26A exactamente (ADR-039..041) — `organization_settings`
(fuso horário IANA, nunca UTC/servidor/browser, falha fechado até estar configurado), `professional_schedule_rules`
(regras semanais, múltiplos intervalos/dia, intervalos adjacentes aceites sem merge, overnight rejeitado por
Zod E por `CHECK` real na BD), `professional_schedule_exceptions` (excepções substituem inteiramente a regra
semanal nessa data — provado com o exemplo exacto do brief — nunca uma junção parcial). Motor de disponibilidade
é uma função pura sem acesso a BD, testável isoladamente; `timezone` não entra no cálculo do motor (o modelo é
wall-clock do início ao fim) — só serve para confirmar que a Organização já o configurou. Disponibilidade de
trabalho é sempre devolvida; `serviceStartTimes` (incremento fixo de 15 min) só quando um `serviceId` é dado —
nunca uma garantia de reserva (não existem Marcações nesta versão; F27 terá de revalidar no momento da escrita).
`professional_services`/`Service.durationMinutes` lidos ao vivo, nunca duplicados. Permissões
`scheduling.read/create/update` fundamentadas de forma própria (não copiadas). UI construída em
`na-pista-console`: a agenda semanal/excepções/pré-visualização de disponibilidade estendem a própria página de
detalhe do Profissional (não uma rota nova — Scheduling é propriedade de um Profissional, ADR-039), mais uma
página nova de Definições para o fuso horário. 139 testes específicos de Scheduling (52 unitários + 36 integração
+ 32 E2E + 19 UI); suite completa do `na-pista` em 451/451 (dois flakes ambientais transitórios investigados e
confirmados não relacionados com código, re-corridos isoladamente com sucesso — ver `docs/f26-report.md` §25).
Zero alterações a `Service`/`Professional`/`professional_services`/UL Platform.

## Em duas linhas

```
UL PLATFORM → "Quem pode usar?"   (identidade, organizações, memberships, planos, subscrições, entitlements, chaves, usage, webhooks)
NA PISTA    → "O que pode fazer?" (produtos, stock, pedidos, clientes | serviços, profissionais, horários, marcações)
```

- **Tenant** = a `Organization` do UL Platform (`organization_id` em toda linha de negócio).
- **Taxonomia** = capacidades/módulos habilitados por entitlements, **não** um `business_type`.
- **Repositório e BD independentes**; fala com o Platform só por API.
- **Primeiro slice:** Product Management — **construído (F20)**: Categories + Products, tenant-scoped, com
  autorização/entitlement/audit/usage reais. Ver [`docs/f20-report.md`](docs/f20-report.md).
- **Segundo slice:** Customer Management — **construído (F21)**: primitiva transversal, sem acoplamento a
  Products nem ao User do Platform. Ver [`docs/f21-report.md`](docs/f21-report.md).
- **Terceiro slice:** Inventory Management — **construído (F22)**: `Product → InventoryBalance →
  StockMovement`, mutação atómica/concorrência-segura, sem localizações/UOM engine. Ver
  [`docs/f22-report.md`](docs/f22-report.md).
- **Quarto slice:** Order Management — **construído (F23)**: `Order → OrderItem`, dinheiro/moeda/preço exactamente
  como a F23A decidiu (ADR-029..032), Inventory consumido só em `CONFIRMED` via o `createMovement` da F22 **sem
  alterações ao seu schema**. Ver [`docs/f23-report.md`](docs/f23-report.md).

## Mapa da documentação

| Documento | Conteúdo |
|---|---|
| [`docs/platform-audit.md`](docs/platform-audit.md) | Auditoria do código real do Platform/Client/Console, **divergências (DV)** e **lacunas (PG)** |
| [`docs/architecture.md`](docs/architecture.md) | Definição, o que é / não é, fronteira Platform↔Na Pista, estilo, fluxo de pedido |
| [`docs/tenancy.md`](docs/tenancy.md) | Modelo multi-tenant, `TenantSettings`, garantias de isolamento |
| [`docs/domain-model.md`](docs/domain-model.md) | ERD conceptual, decisões de Product/Service/Customer domain |
| [`docs/modules.md`](docs/modules.md) | Taxonomia, module registry, catálogo de módulos, **capability matrix** |
| [`docs/api-boundary.md`](docs/api-boundary.md) | Convenções de API, resolução de tenant, quem chama quem |
| [`docs/authorization.md`](docs/authorization.md) | Autenticação, autorização humana e de serviço |
| [`docs/entitlements.md`](docs/entitlements.md) | Como chegam, semântica, catálogo de entitlements |
| [`docs/usage.md`](docs/usage.md) | Meters, módulo → meter → limite |
| [`docs/events.md`](docs/events.md) | Contrato de eventos de domínio |
| [`docs/audit.md`](docs/audit.md) | Audit de plataforma vs. audit de negócio |
| [`docs/ui-strategy.md`](docs/ui-strategy.md) | API vs Default UI vs Custom UI |
| [`docs/vertical-slice.md`](docs/vertical-slice.md) | Slice 1, cenário E2E-alvo, backlog técnico |
| [`docs/f18-review.md`](docs/f18-review.md) | Validação A/B/C, auto-revisão, **open decisions**, riscos |
| [`docs/decisions.md`](docs/decisions.md) | **F19** — OD-11/12/13/14/16 fechadas, com evidência de runtime |
| [`docs/integration-flow.md`](docs/integration-flow.md) | **F19** — fluxo humano e de serviço, ponta a ponta |
| [`docs/platform-changes-required.md`](docs/platform-changes-required.md) | **F19** — alterações ao Platform identificadas, não implementadas |
| [`docs/f19-report.md`](docs/f19-report.md) | **F19** — relatório final: estado, testes, matriz de segurança |
| [`docs/api/products-api.md`](docs/api/products-api.md) | **F20** — contrato da API de Categories/Products |
| [`docs/f20-report.md`](docs/f20-report.md) | **F20** — relatório final: domínio, API, BD, testes, limitações |
| [`docs/api/customers-api.md`](docs/api/customers-api.md) | **F21** — contrato da API de Customers |
| [`docs/f21-report.md`](docs/f21-report.md) | **F21** — relatório final: domínio, API, BD, testes, limitações |
| [`docs/api/inventory-api.md`](docs/api/inventory-api.md) | **F22** — contrato da API de Inventory |
| [`docs/f22-report.md`](docs/f22-report.md) | **F22** — relatório final: domínio, API, BD, concorrência, testes, limitações |
| [`docs/f23a-commerce-money-decisions.md`](docs/f23a-commerce-money-decisions.md) | **F23A** — pacote de decisões de dinheiro/moeda/commerce, contrato para a F23 |
| [`docs/f23a-report.md`](docs/f23a-report.md) | **F23A** — relatório final do spike: decisões, validação, auto-revisão |
| [`docs/api/orders-api.md`](docs/api/orders-api.md) | **F23** — contrato da API de Orders |
| [`docs/f23-report.md`](docs/f23-report.md) | **F23** — relatório final: modelo, dinheiro, ciclo de vida, transacção, concorrência, testes, limitações |
| [`docs/f24a-services-decisions.md`](docs/f24a-services-decisions.md) | **F24A** — pacote de decisões do domínio de Serviços, contrato para a F24 |
| [`docs/f24a-report.md`](docs/f24a-report.md) | **F24A** — relatório final do spike: decisões, alternativas, auto-revisão |
| [`docs/api/services-api.md`](docs/api/services-api.md) | **F24** — contrato da API de Services |
| [`docs/f24-report.md`](docs/f24-report.md) | **F24** — relatório final: modelo, API, BD, testes, auto-revisão, decisão de escopo de UI |
| [`docs/f25a-professionals-decisions.md`](docs/f25a-professionals-decisions.md) | **F25A** — pacote de decisões do domínio de Professionals, contrato para a F25 |
| [`docs/f25a-report.md`](docs/f25a-report.md) | **F25A** — relatório final do spike: decisões, alternativas, auto-revisão |
| [`docs/api/professionals-api.md`](docs/api/professionals-api.md) | **F25** — contrato da API de Professionals (incluindo `professional_services`) |
| [`docs/f25-report.md`](docs/f25-report.md) | **F25** — relatório final: modelo, API, BD, associação N:M, UI, testes, auto-revisão |
| [`docs/f26a-report.md`](docs/f26a-report.md) | **F26A** — relatório final do spike: decisões de Scheduling/timezone/disponibilidade, alternativas, auto-revisão |
| [`docs/api/scheduling-api.md`](docs/api/scheduling-api.md) | **F26** — contrato da API de Scheduling e Organization Settings |
| [`docs/f26-report.md`](docs/f26-report.md) | **F26** — relatório final: modelo, BD, motor de disponibilidade, API, UI, testes, auto-revisão |
| [`docs/adr/`](docs/adr/README.md) | ADR-001 … ADR-041 |
| [`spikes/platform-integration/`](spikes/platform-integration/README.md) | **F19** — código do spike (removível), como correr os testes |
| [`src/`](src) | **F20/F21/F22/F23/F24/F25/F26** — código real do Na Pista (Categories/Products/Customers/Inventory/Orders/Services/Professionals/Scheduling), não removível |

## Convenções deste blueprint
- **DECIDIDO** — decorre do conceito oficial, do CLAUDE.md ou do código do Platform.
- **PROPOSTA** — recomendação técnica desta fase, reversível.
- **OPEN DECISION (OD-nn)** — não pode ser determinada com segurança a partir do conceito; nunca tratada como fechada.
- **PG-nn** lacuna do Platform · **DV-nn** divergência encontrada · **R-nn** risco.

## A correr (F20/F21/F22/F23/F24/F25/F26)

```bash
npm install
cp .env.example .env        # NA_PISTA_DATABASE_URL, PLATFORM_API_URL, ...
npm run db:generate         # já gerado; só necessário após mudar src/db/schema/
npm run db:migrate
npm run dev                 # API em :4200

# testes (precisam de um UL Platform real já a correr em :4000)
npm run test:unit
npm run test:integration    # precisa de NA_PISTA_DATABASE_URL real
cd ../ul-platform && npm run f20:provision && npm run f21:provision && npm run f22:provision && npm run f23:provision && npm run f24:provision && npm run f25:provision && npm run f26:provision   # fixtures reais
cd ../na-pista && npm run test:e2e
```

UI: ver [`../na-pista-console`](../na-pista-console).

## Fora de âmbito (F18)
CRUDs, migrations definitivas, billing, pagamentos, integração com Micha Express, deploys, UI de cliente, app móvel,
analytics avançados, notificações, IA. Modelo fiscal, IVA, POS, faturação, loyalty, CRM avançado, contabilidade,
transportes, marketplace: **FUTURE**, fora do core.
