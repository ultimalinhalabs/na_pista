# Auditoria

## 1. Duas trilhas, sem sobreposição

| | **Platform Audit** | **Na Pista Business Audit** |
|---|---|---|
| Responde a | "quem mudou membership, role, subscription, chave, webhook, aplicação?" | "quem alterou/eliminou/cancelou o quê nos dados do negócio?" |
| Onde vive | `audit_logs` no Platform (`recordAuditEvent`, interno) | `audit_events` na BD do Na Pista (tenant-scoped, append-only) |
| Quem escreve | só o próprio Platform | só o Na Pista |
| Quem lê | `PLATFORM_ADMIN` (control-plane); **sem** leitura por organização hoje (DV-4) | membros com permission local (`audit.read` do Na Pista, PROPOSTA: OWNER/ADMIN) |

Facto (PG-5): o Platform **não** oferece ingestão de audit por serviços, nem endpoint de leitura de audit por
organização. Por isso o audit de negócio é **do Na Pista** — decisão (**OD-15**, com alternativa registada abaixo).

**Não duplicar:** o Na Pista não regista o que o Platform já audita (criar org, mudar membership, subscrição, chaves).
Regista apenas operações de negócio. Ligação por `request_id` e ids (`organizationId`, `actor`) quando necessário.

## 2. Operações críticas a auditar (PROPOSTA)

| Módulo | Acção (`action`) |
|---|---|
| PRODUCTS | `product.created`, `product.updated` (campos alterados, **preço** antes/depois), `product.archived`, `product.restored` |
| CUSTOMERS | `customer.created`, `customer.updated`, `customer.archived`/anonimizado (OD-22) |
| INVENTORY | `inventory.adjusted` (motivo obrigatório, delta, antes/depois) |
| ORDERS | `order.created`, `order.confirmed`, `order.canceled` (motivo), alteração de itens/preços |
| SERVICES / PROFESSIONALS | criação, alteração de preço/duração, associação profissional↔serviço, desactivação |
| APPOINTMENTS | `appointment.canceled` (motivo, quem), `appointment.completed`, reagendamento |
| TENANT | `settings.updated` (configuração) |
| Segurança | acesso negado por isolamento (tentativa cross-tenant) como log de segurança, não audit de negócio |

**Não auditar:** leituras (GET), tentativas de validação falhadas, cada `api_request`.

## 3. Formato e regras
`{ id, organization_id, actor: { type: user|service, id }, action, target_type, target_id, metadata, request_id, created_at }`.
- **Escrito na mesma transacção** que a operação (diferente do `recordAuditEvent` do Platform, que engole erros):
  no Na Pista, se o audit de uma operação crítica não puder ser escrito, a operação **falha** — decisão a confirmar (OD-15).
- Append-only: sem UPDATE/DELETE por caminho de aplicação.
- `metadata` nunca contém segredos, tokens nem dados pessoais além do estritamente necessário.
- Consulta paginada por cursor, filtros: `action`, `actor`, `target`, intervalo — mesmo desenho do audit de plataforma.

## 4. Alternativa registada (OD-15)
O Platform poderia oferecer ingestão de audit por serviços e leitura por organização (`audit.read` já existe e não
é usada). Prós: um único sítio para o tenant ver tudo, retenção central. Contras: o Platform passaria a armazenar
metadados de negócio (risco de violar a fronteira) e o volume/forma dos eventos de negócio. Recomendação: **manter
trilhas separadas** e, se o UL Client precisar de uma vista unificada, agregá-las por API — não por BD.
