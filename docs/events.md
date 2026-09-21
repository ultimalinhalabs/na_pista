# Modelo de eventos (contrato; sem broker)

## 1. Enquadramento
Eventos de domínio = "algo aconteceu" (factos passados, imutáveis). Não são a API síncrona. Aqui define-se
**o contrato**; não se implementa broker, filas nem workers complexos (brief §18).

## 2. Como o Platform transporta eventos (confirmado no código)
`POST /v1/organizations/:orgId/events` `{ type, data }` — chave de serviço org-scoped com `event.publish`.
O Platform entrega a todos os **webhook endpoints ACTIVE da organização** subscritos a esse `type`, assinados
(`HMAC-SHA256`, headers `X-UL-Signature`, `X-UL-Timestamp`, `X-UL-Event-Id`, `X-UL-Event-Type`).
Envelope entregue: `{ id: "evt_<uuid>", type, source: { application }, organizationId, occurredAt, data }`.

Restrições que moldam o contrato:
- `type` **tem exactamente o formato `domain.action`** (`^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$`): duas partes só. `tenant.settings.updated` seria rejeitado.
- Entrega **síncrona no pedido**, 1 tentativa, sem retry/dead-letter; **sem dedupe** na publicação (PG-7); at-least-once.
- Destinatários = webhooks **registados pela organização** (ex.: sistema do cliente, Qualé a Dica?!) — o Platform não sabe o que o evento significa.
- `source.application` é preenchido pelo Platform a partir da credencial (não forjável no corpo).

## 3. Regras do Na Pista para publicar (PROPOSTA)
1. **Outbox transaccional.** O evento é escrito em `OutboxMessage` na **mesma transacção** que a mudança de
   negócio. Um dispatcher em processo entrega ao Platform e marca como enviado. Sem dupla escrita (BD + HTTP).
2. **Nunca no caminho do pedido.** O utilizador não espera pela entrega dos webhooks do tenant.
3. **Duplicados são possíveis** (retry após falha ambígua; Platform não deduplica): o `data` inclui sempre um
   **id do facto** estável (`orderId`, `appointmentId`, …) e um `eventVersion`; consumidores dedupam por `X-UL-Event-Id`
   **e/ou** pelo id do facto. Documentar isto no contrato público.
4. **Payload mínimo:** identificadores + campos de estado que mudaram; **nunca** dados pessoais desnecessários
   (o destinatário é um sistema externo do tenant). Consumidores obtêm o detalhe via API (com a sua credencial).
5. Um evento = uma transição de estado de negócio commitada. Nada de eventos "de leitura".
6. Nomes no passado, `substantivo.acção`, snake_case: `product.created`.

## 4. Catálogo inicial (PROPOSTA — só o que os módulos justificam)

Campos comuns (envelope Platform): `id`, `type`, `source.application = NA_PISTA`, `organizationId` (**tenant**),
`occurredAt`. **Actor** (quem causou) vai em `data.actor` = `{ type: "user" | "service", id }`.

| Evento | Módulo | Payload mínimo em `data` | Classe | Consumidores futuros prováveis |
|---|---|---|---|---|
| `product.created` | PRODUCTS | `productId, status, actor` | CORE | webhooks do tenant; Qualé a Dica?! (catálogo) |
| `product.updated` | PRODUCTS | `productId, changedFields[], actor` | CORE | idem |
| `product.archived` | PRODUCTS | `productId, actor` | CORE | idem |
| `customer.created` / `customer.updated` | CUSTOMERS | `customerId, actor` | CORE | sistemas do tenant |
| `inventory.adjusted` | INVENTORY | `productId, delta, reason, actor` | 2 | sistemas do tenant |
| `order.created` | ORDERS | `orderId, status, actor` | 2 | Micha Express (pagamento — FUTURE), Foi (entrega — FUTURE) |
| `order.completed` / `order.canceled` | ORDERS | `orderId, actor` | 2 | idem |
| `service.created` / `service.updated` | SERVICES | `serviceId, actor` | 2 | Qualé a Dica?! |
| `professional.created` / `professional.updated` | PROFESSIONALS | `professionalId, actor` | 2 | — |
| `appointment.created` | APPOINTMENTS | `appointmentId, professionalId, serviceId, startsAt, actor` | 2 | Qualé a Dica?! (confirmações — FUTURE) |
| `appointment.canceled` / `appointment.completed` | APPOINTMENTS | `appointmentId, actor` | 2 | idem |
| `settings.updated` | TENANT | `changedFields[], actor` | 2 | — |

**Fora**: eventos de pagamento/entrega (pertencem a Micha Express/Foi), eventos de billing, eventos de sessão.
O brief sugeria `inventory.updated` — proposto `inventory.adjusted` (mais preciso, porque só há movimentos, PD/invariante 3).

## 5. Eventos que o Na Pista **consome**
Nenhum no v1. O Platform não emite eventos de controlo (PG-6). Se o Platform passar a emitir
(`subscription.changed`, `organization.deleted`), o Na Pista regista um webhook próprio por org — decisão com OD-21.
