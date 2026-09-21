# Módulos, taxonomia e capability matrix

## 1. Taxonomia: capacidades, não tipos de negócio (ADR-004)

**Rejeitado:** `business_type = BARBERSHOP | BOUTIQUE | YOGURT_STORE`. Enum fechado, cada novo tipo de negócio
seria uma migração e um `if` espalhado; uma empresa híbrida não caberia.

**Adoptado (PROPOSTA):**

```
Business model (descritivo, não armazenado)
      ↓ implica
Capabilities (famílias)       COMMERCE  ·  BOOKING  ·  (CUSTOMERS, transversal)
      ↓ realizadas por
Modules (código)              PRODUCTS, INVENTORY, ORDERS  ·  SERVICES, PROFESSIONALS, SCHEDULING, APPOINTMENTS  ·  CUSTOMERS
      ↓ habilitados por
Entitlements (Platform)       products.enabled, ...
```

- **Duas famílias bastam?** `PRODUCT` e `SERVICE` cobrem os três cenários do brief (boutique, barbearia, híbrida).
  Chamam-se aqui `COMMERCE` (o que se vende é um bem) e `BOOKING` (o que se vende é tempo/serviço). Não se
  inventam famílias adicionais (aluguer, subscrições recorrentes, restauração com mesas...) — se surgirem, entram
  como **novo módulo**, não como novo "tipo".
- **O tipo de negócio não é dado do sistema.** Uma boutique é simplesmente uma organização com
  `products.enabled`, `inventory.enabled`, `orders.enabled`, `customers.enabled`. Uma híbrida tem ambos.
  Se o onboarding precisar de perguntar "que tipo de negócio é?" para sugerir módulos, isso é lógica de UI que
  resulta num plano/subscrição, não uma coluna. (Não implementar até haver requisito de produto.)

## 2. Module Registry — qual a menor abstração? (ADR-004)

Opções avaliadas: (a) só código/configuração; (b) entidade persistida; (c) capability; (d) application entitlement.

**Decisão (PROPOSTA): combinação mínima de (a) + (d).**
- **Módulo = manifesto em código** no Na Pista (`modules/<x>/module.ts`): `key`, `family`, `dependsOn[]`,
  `entitlementKey`, `permissions[]`, `meters[]`, `events[]`, rotas montadas.
- **Habilitação = entitlement do Platform** (`<módulo>.enabled`). O Platform continua sem conhecer módulos:
  só vê chaves de entitlement livres (é exactamente o desenho actual — `plan_entitlements.key` é texto livre).
- **Não** há tabela `modules` nem `tenant_modules`. Persistir módulos duplicaria o que o Platform já resolve
  (plano → entitlements) e criaria uma segunda fonte de verdade sobre "o que a org pode usar".
- **Reavaliar** só se surgir necessidade real de: activação **por escolha do tenant** (ter o módulo contratado
  mas escondê-lo) ou configuração por módulo. Nesse caso adicionar `tenant_modules` no Na Pista, sem tocar no Platform.

Validação de dependências no arranque: um módulo cujas `dependsOn` não estejam registadas recusa arrancar (falha
alta e cedo, não em runtime do tenant). Em runtime: módulo com entitlement `true` mas dependência desabilitada
→ `403 MODULE_DEPENDENCY_UNMET` com o módulo em falta.

## 3. Catálogo de módulos

Classificação: **CORE** (necessário para validar a arquitectura e servir qualquer cenário) · **PHASE 2** (construir
depois do slice; ordem = OD-19) · **FUTURE** (não construir/decidir agora).

| Módulo | Família | Classe | Propósito | Depende de |
|---|---|---|---|---|
| `TENANT` (TenantSettings) | — | **CORE** | fuso, moeda, bootstrap do tenant | — |
| `PRODUCTS` (+ categorias) | COMMERCE | **CORE** | catálogo de bens vendáveis | TENANT |
| `CUSTOMERS` | transversal | **CORE** | clientes de negócio da organização | TENANT |
| `INVENTORY` | COMMERCE | PHASE 2 | quantidade em stock e movimentos | PRODUCTS |
| `ORDERS` | COMMERCE | PHASE 2 | pedidos e itens | PRODUCTS, (CUSTOMERS, OD-03), (INVENTORY, opcional) |
| `SERVICES` | BOOKING | PHASE 2 | catálogo de serviços prestáveis | TENANT |
| `PROFESSIONALS` | BOOKING | PHASE 2 | quem presta serviços | SERVICES |
| `SCHEDULING` (horários + disponibilidade) | BOOKING | PHASE 2 | horário semanal, exceções, disponibilidade calculada | PROFESSIONALS |
| `APPOINTMENTS` | BOOKING | PHASE 2 | marcações | SERVICES, PROFESSIONALS, SCHEDULING, CUSTOMERS |
| Variantes de produto | COMMERCE | FUTURE (OD-02) | tamanho/cor/sabor | PRODUCTS |
| Localizações/armazéns | COMMERCE | FUTURE (OD-06) | stock multi-local | INVENTORY |
| Relatórios avançados | — | FUTURE | (`advanced_reports.enabled` já existe no seed) | — |
| Auto-marcação pelo cliente final | BOOKING | FUTURE (OD-10) | | APPOINTMENTS |
| Faturação, IVA, POS, loyalty, CRM avançado, contabilidade, pagamentos, entregas | — | FUTURE | fora do core; integrações via Micha Express / Foi | — |

`CUSTOMERS` é CORE embora o slice 1 não o use: ambos os ramos dependem dele e o seu modelo de identidade
(ADR-009) tem de estar fechado antes de Orders/Appointments. (O slice 1 é *Products*; ver `vertical-slice.md`.)

### Ficha por módulo

Formato: propósito · entidades · operações · dependências · tenant boundary · permissions (locais, PROPOSTA) ·
entitlements possíveis · eventos · APIs · dependências externas.
Todas as entidades: `organization_id` obrigatório (ver `tenancy.md`). Nomes de permission/entitlement/evento
são **propostas** — chaves definitivas só ao implementar, e entitlements exigem PR de dados no Platform (PG-4).

**TENANT** — *config operacional do tenant.* Entidade `TenantSettings`. Ops: obter, actualizar. Perm.:
`settings.read/update`. Entitlement: — (implícito na subscrição `NA_PISTA`). Evento: `settings.updated`. API:
`GET|PATCH /v1/organizations/:orgId/settings`. Externo: Platform (subscrição activa).

**PRODUCTS** — *catálogo.* Entidades `Product`, `Category`. Ops: CRUD de produto (apagar = arquivar), CRUD de
categoria, atribuir categoria. Perm.: `products.read/write/delete`. Entitl.: `products.enabled`, `products.max`.
Eventos: `product.created|updated|archived`. API: `/products`, `/categories`. Externo: Platform (entitlement).

**CUSTOMERS** — *clientes de negócio.* Entidade `BusinessCustomer`. Ops: CRUD (apagar = arquivar/anonimizar, OD-22).
Perm.: `customers.read/write`. Entitl.: `customers.enabled`, `customers.max`. Eventos: `customer.created|updated`.
API: `/customers`. Externo: —.

**INVENTORY** — *stock.* Entidades `StockLevel`, `InventoryMovement` (append-only). Ops: consultar, ajustar
(movimento), listar movimentos. Perm.: `inventory.read/adjust`. Entitl.: `inventory.enabled`. Eventos:
`inventory.adjusted`, `inventory.low` (FUTURE). API: `/inventory`. Depende de PRODUCTS.

**ORDERS** — *pedidos.* Entidades `Order`, `OrderItem`. Ops: criar, obter, listar, mudar estado, cancelar. Perm.:
`orders.read/create/cancel`. Entitl.: `orders.enabled`. Meter: `orders`. Eventos: `order.created|completed|canceled`.
API: `/orders`. Externo: Micha Express (pagamento — **FUTURE**, fora do core).

**SERVICES** — *catálogo de serviços.* Entidade `Service` (duração, preço). Perm.: `services.read/write`.
Entitl.: `services.enabled`. Eventos: `service.created|updated`. API: `/services`.

**PROFESSIONALS** — *quem presta.* Entidades `Professional`, `ProfessionalService` (N:M). Ligação opcional a um
`userId` do Platform (um profissional pode não ter login). Perm.: `professionals.read/write`. Entitl.:
`services.enabled` (agrupado), `professionals.max`. Eventos: `professional.created|updated`. API: `/professionals`.

**SCHEDULING** — *horários e disponibilidade.* Entidades `WorkingHours` (semanal, por profissional),
`TimeOff` (exceções). **Disponibilidade é calculada**, não armazenada: horário − exceções − marcações activas.
Perm.: `scheduling.read/write`. Entitl.: `appointments.enabled` (agrupado). API: `/professionals/:id/availability`.

**APPOINTMENTS** — *marcações.* Entidade `Appointment`. Ops: criar, obter, listar, reagendar (FUTURE), cancelar,
concluir. Perm.: `appointments.read/create/cancel/complete`. Entitl.: `appointments.enabled`, `appointments.max`
(período: OD-13). Meter: `appointments` (não existe no seed, PG-4). Eventos: `appointment.created|canceled|completed`.
API: `/appointments`. Externo: Qualé a Dica?! (consome disponibilidade/cria marcações via API — FUTURE).

## 4. Capability matrix

Só capacidades justificadas pelo conceito. "Existe no Platform?" reflecte o seed **actual** (DV-3).
`Perm.` = permission local do Na Pista (OD-12). `Ent.` = entitlement. `Usage` = meter (📦 = já no seed para NA_PISTA; ➕ = exige seed novo; — = não medir / contagem local).

| Capability | Módulo | API (prefixo `/v1/organizations/:orgId`) | Perm. | Ent. | Usage | Fase |
|---|---|---|---|---|---|---|
| Gerir definições do tenant | TENANT | `/settings` | `settings.read/update` | — | — | CORE |
| Gerir produtos | PRODUCTS | `/products` | `products.read/write/delete` | `products.enabled` | — | CORE |
| Limitar nº de produtos | PRODUCTS | `POST /products` | `products.write` | `products.max` (📦 existe) | — (contagem local) | CORE |
| Organizar por categorias | PRODUCTS | `/categories` | `products.read/write` | `products.enabled` | — | CORE |
| Gerir clientes de negócio | CUSTOMERS | `/customers` | `customers.read/write` | `customers.enabled`, `customers.max` | — (contagem local) | CORE |
| Consultar/ajustar stock | INVENTORY | `/inventory`, `/inventory/movements` | `inventory.read/adjust` | `inventory.enabled` | — | 2 |
| Criar/gerir pedidos | ORDERS | `/orders` | `orders.read/create/cancel` | `orders.enabled` | `orders` 📦 | 2 |
| Gerir serviços | SERVICES | `/services` | `services.read/write` | `services.enabled` | — | 2 |
| Gerir profissionais | PROFESSIONALS | `/professionals` | `professionals.read/write` | `services.enabled`, `professionals.max` | — (contagem local) | 2 |
| Definir horários/exceções | SCHEDULING | `/professionals/:id/working-hours`, `/time-off` | `scheduling.read/write` | `appointments.enabled` | — | 2 |
| Consultar disponibilidade | SCHEDULING | `/professionals/:id/availability` | `scheduling.read` | `appointments.enabled` | — | 2 |
| Marcar/cancelar/concluir | APPOINTMENTS | `/appointments` | `appointments.read/create/cancel/complete` | `appointments.enabled`, `appointments.max` | `appointments` ➕ | 2 |
| Integração por chave de serviço (leitura catálogo) | PRODUCTS/SERVICES | mesmas rotas GET | scope de serviço (ver `authorization.md`) | igual ao módulo | `api_requests` 📦 | CORE |
| Relatórios avançados | — | — | — | `advanced_reports.enabled` (📦 existe) | — | FUTURE |

Esta matriz alimenta: implementação (rotas + testes), documentação pública, desenho de planos (ADR/OD-20),
onboarding, UL Client (ecrãs de entitlements/usage) e UI do Na Pista.
