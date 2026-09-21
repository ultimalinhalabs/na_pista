# Usage / Metering

Só se define **o que poderá ser medido**. Sem motor de billing, sem preços, sem enforcement via usage.

## 1. Contrato do Platform (confirmado)
- Escrita só por serviço: `POST /v1/organizations/:orgId/applications/NA_PISTA/usage`, scope `usage.write`,
  corpo `{ meterKey, quantity, occurredAt?, idempotencyKey, metadata? }`. Replay da mesma
  `(org, app, meter, idempotencyKey)` → `200`, mesma linha, sem dupla contagem.
- Meters são registo global **só seed**; allowlist `NA_PISTA`: `users`, `orders`, `storage_bytes`, `api_requests`.
- Eventos de usage são imutáveis e append-only; correcção = novo evento (ex.: quantidade negativa).
- Requer chave org-scoped (PG-1).

## 2. Regra central: usage é **relatório**, não enforcement
O Platform deixa um OWNER criar uma chave `NA_PISTA` com `usage.write` (PG-8) → o tenant pode forjar o próprio
usage. Logo:

> **Limites são aplicados com contagens locais do Na Pista** (`entitlements.md` §3/§5). O usage no Platform serve
> visibilidade (UL Client mostra-o) e, no futuro, facturação — e só deve ser tratado como fiável quando a origem
> não puder ser forjada pelo tenant (depende de OD-11).

## 3. Módulo → Meter → Limite

| Módulo | Operação | Meter | No seed p/ NA_PISTA? | Limite associado |
|---|---|---|---|---|
| PRODUCTS | criar produto | — (**estado**, não fluxo) | — | `products.max` (contagem local) |
| CUSTOMERS | criar cliente | — (estado) | — | `customers.max` (contagem local) |
| PROFESSIONALS | criar profissional | — (estado) | — | `professionals.max` (contagem local) |
| ORDERS | criar/concluir pedido | `orders` | 📦 sim | `orders.*` por período (OD-13) |
| APPOINTMENTS | criar marcação | `appointments` | ➕ não | `appointments.max` por período (OD-13) |
| (transversal) | pedido autenticado à API | `api_requests` | 📦 sim | — |
| (transversal) | utilizadores activos | `users` | 📦 sim | (futuro: `staff`) |
| (transversal) | ficheiros armazenados | `storage_bytes` | 📦 sim | FUTURE |

Observação: do brief, `products.created` e `customers.created` **não** são meters — são contagens de estado.
Registar "criações" como fluxo só faria sentido se se cobrasse por criação (não é requisito).

## 4. Como o Na Pista regista usage (PROPOSTA)
1. A operação de negócio escreve a linha de `OutboxMessage(kind = usage)` **na mesma transacção**
   (`idempotencyKey` = id determinístico do facto, ex.: `order:<orderId>:created`).
2. Um dispatcher em processo entrega ao Platform e marca como enviado; em falha, re-tenta (o Platform é idempotente
   por `idempotencyKey`, por isso re-tentar é seguro).
3. Falha do Platform **não** falha a operação de negócio; degrada para atraso na contabilização.

`api_requests`: agregar localmente por janela (ex.: por minuto, por org) e enviar 1 evento agregado — não 1
evento por pedido (volume). Granularidade: a fixar no slice (é o meter que o slice 1 usa para validar o pipeline
sem exigir alterações no seed, dado que `products` não é meter).

## 5. Fora de âmbito
Preços, facturação, overage, bloqueio automático por usage, retenção/arquivo, limiares (`usage.threshold_reached`).
