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
| [`docs/adr/`](docs/adr/README.md) | ADR-001 … ADR-032 |
| [`spikes/platform-integration/`](spikes/platform-integration/README.md) | **F19** — código do spike (removível), como correr os testes |
| [`src/`](src) | **F20/F21/F22/F23** — código real do Na Pista (Categories/Products/Customers/Inventory/Orders), não removível |

## Convenções deste blueprint
- **DECIDIDO** — decorre do conceito oficial, do CLAUDE.md ou do código do Platform.
- **PROPOSTA** — recomendação técnica desta fase, reversível.
- **OPEN DECISION (OD-nn)** — não pode ser determinada com segurança a partir do conceito; nunca tratada como fechada.
- **PG-nn** lacuna do Platform · **DV-nn** divergência encontrada · **R-nn** risco.

## A correr (F20/F21/F22/F23)

```bash
npm install
cp .env.example .env        # NA_PISTA_DATABASE_URL, PLATFORM_API_URL, ...
npm run db:generate         # já gerado; só necessário após mudar src/db/schema/
npm run db:migrate
npm run dev                 # API em :4200

# testes (precisam de um UL Platform real já a correr em :4000)
npm run test:unit
npm run test:integration    # precisa de NA_PISTA_DATABASE_URL real
cd ../ul-platform && npm run f20:provision && npm run f21:provision && npm run f22:provision && npm run f23:provision   # fixtures reais
cd ../na-pista && npm run test:e2e
```

UI: ver [`../na-pista-console`](../na-pista-console).

## Fora de âmbito (F18)
CRUDs, migrations definitivas, billing, pagamentos, integração com Micha Express, deploys, UI de cliente, app móvel,
analytics avançados, notificações, IA. Modelo fiscal, IVA, POS, faturação, loyalty, CRM avançado, contabilidade,
transportes, marketplace: **FUTURE**, fora do core.
