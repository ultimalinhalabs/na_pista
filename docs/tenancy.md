# Modelo multi-tenant

## 1. Cadeia (DECIDIDO)

```
Platform Organization  ── fronteira de tenancy (fonte de verdade, ID imutável)
        ↓
Na Pista Tenant        ── NÃO é uma entidade concorrente: é a mesma organização, vista pelo Na Pista
        ↓
Business Data          ── toda linha de negócio carrega organization_id
```

- O identificador de tenant é o `organizations.id` do Platform (UUID). O Na Pista **não gera** identificadores
  de tenant nem tem tabela `organizations` própria como fonte de verdade.
- Como a BD do Na Pista é separada (CLAUDE.md §2), `organization_id` **não pode ter FK** para o Platform.
  É um `uuid NOT NULL` validado na fronteira (membership + subscription) — a integridade referencial é
  substituída por *validação de acesso em cada pedido*.

## 2. `TenantSettings` — precisamos de "BusinessProfile"?

**Sim, uma entidade mínima, mas não é um segundo "cadastro da empresa".** Nome foi escolhido de propósito:
`TenantSettings` (não `Business`/`Company`), para não competir com `Organization`.

| | `Organization` (Platform) | `TenantSettings` (Na Pista) |
|---|---|---|
| Papel | identidade e fronteira de acesso do tenant | configuração **operacional do Na Pista** para esse tenant |
| Campos | `id, name, slug, createdBy` | `organization_id (PK), timezone, currency_code, ...` |
| Fonte de verdade de `name/slug` | **sim** | **nunca copiar** (lê-se do Platform quando preciso) |
| Ciclo de vida | criada/eliminada no Platform | criada no 1.º acesso ao Na Pista (lazy, idempotente) |

Justificação de existir: há configuração que só faz sentido no domínio de gestão e que o Platform não deve
conhecer — **fuso horário** (necessário para agendamentos: horários semanais dependem dele) e **moeda**
(necessária para representar preços). Estritamente o mínimo; qualquer campo novo tem de justificar-se por um
módulo.

- `currency_code` (ISO 4217) e o conjunto de moedas/países suportados: **OD-01** (não se assume país, IVA ou legislação).
- `TenantSettings` não guarda "tipo de negócio" (ver [`modules.md`](modules.md) §1).

## 3. Garantias de isolamento (obrigatórias — DECIDIDO como requisito; mecanismos = PROPOSTA)

Camadas, da mais forte para a defesa em profundidade. Uma camada nunca substitui a anterior.

1. **Coluna obrigatória.** Toda tabela de negócio tem `organization_id uuid NOT NULL`. Sem excepções. Sem tabelas
   de negócio "globais".
2. **Chaves compostas.** Referências entre tabelas de negócio incluem o tenant:
   `FOREIGN KEY (organization_id, product_id) REFERENCES products (organization_id, id)`.
   Cada tabela tem `UNIQUE (organization_id, id)` para o permitir. Um `order_item` **não consegue** apontar para
   um produto de outra organização, mesmo com um bug na aplicação.
3. **Repository exige `TenantContext`.** A única camada com SQL recebe `TenantContext { organizationId, actor }`
   como argumento obrigatório e aplica `WHERE organization_id = $1` por construção (nunca "depois de ler").
   Não existe função de repository sem tenant. Id de outra organização → `404` (não `403`), sem revelar existência.
4. **`TenantContext` só é construído pelo middleware de tenancy**, a partir de: path `:organizationId` +
   membership validado no Platform (humano) **ou** organização da credencial de serviço (serviço).
   Nunca de body, query ou header controlados pelo cliente sem validação.
5. **Defesa em profundidade na BD (RLS): OD-16.** Row-Level Security com `set_config('app.organization_id', ...)`
   por transacção é recomendada como rede de segurança; depende de validar o modo de pooling da ligação. Decidir
   com um spike no primeiro slice. **Não é requisito para as camadas 1–4.**
6. **Testes de isolamento obrigatórios** (ver `vertical-slice.md` §4): cada endpoint de cada módulo tem teste
   "org B não vê/edita/apaga recurso da org A" antes de merge — mesmo padrão já usado pelo Platform e pelo UL Client.

```
Organization A          Organization B
 ├── Products            ├── Products
 ├── Orders              ├── Orders
 ├── Customers           ├── Customers
 └── Inventory           └── Inventory
        ✗  nenhum acesso cruzado (coluna + FK composta + repository + testes [+ RLS])
```

## 4. Resolução do tenant no pedido

- **Humano:** `/v1/organizations/{organizationId}/...`. O id do path é *candidato*; só se torna `TenantContext`
  depois de o Platform confirmar membership activo desse utilizador nessa organização (OD-12 define o mecanismo).
- **Serviço (integração de cliente ou outra aplicação UL):** o tenant vem **da credencial** (org da chave),
  e o path tem de coincidir — mesmo padrão `requireServiceOrganizationMatch` do Platform. Chave de plataforma
  (`organizationId = null`) não define tenant → só serve para operações não org-scoped (ex.: discovery).
- Uma organização sem subscription activa a `NA_PISTA` → `403` (sem acesso à aplicação), distinto de módulo não
  contratado (`403`, código próprio, ver `api-boundary.md`).

## 5. Ciclo de vida do tenant (OPEN — OD-21)

O Platform elimina organizações por hard delete, sem notificar (PG-6). O Na Pista não pode assumir que o tenant
existe para sempre. Decisão pendente: política de retenção/anonimização/purga dos dados de negócio e como o
Na Pista descobre que uma organização/subscription desapareceu (pull periódico vs. novo evento do Platform).
Até decidir: **nunca apagar dados de tenant automaticamente**.
