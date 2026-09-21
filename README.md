# Na Pista

> **Na Pista é um SaaS Multi Tenant de gestão que possibilita aos gestores de empresas provedoras de produtos ou
> serviços fazer a gestão de seus processos por meio dos recursos que a plataforma proverá.**

Aplicação independente do ecossistema Última Linha. Uma **infraestrutura modular de gestão empresarial** exposta
por API — não um ERP, POS, CRM nem software de loja/barbearia (esses são contextos de utilização dos módulos).

## Estado

**Fase F18 — arquitectura e definição de domínio. Não há código de aplicação.** Este repositório contém, por agora,
apenas o blueprint técnico e funcional que servirá de contrato para a implementação. Estado da fase: **PARTIAL**
(decisões abertas de segurança e de negócio — ver [`docs/f18-review.md`](docs/f18-review.md)).

## Em duas linhas

```
UL PLATFORM → "Quem pode usar?"   (identidade, organizações, memberships, planos, subscrições, entitlements, chaves, usage, webhooks)
NA PISTA    → "O que pode fazer?" (produtos, stock, pedidos, clientes | serviços, profissionais, horários, marcações)
```

- **Tenant** = a `Organization` do UL Platform (`organization_id` em toda linha de negócio).
- **Taxonomia** = capacidades/módulos habilitados por entitlements, **não** um `business_type`.
- **Repositório e BD independentes**; fala com o Platform só por API.
- **Primeiro slice:** Product Management.

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
| [`docs/adr/`](docs/adr/README.md) | ADR-001 … ADR-010 |

## Convenções deste blueprint
- **DECIDIDO** — decorre do conceito oficial, do CLAUDE.md ou do código do Platform.
- **PROPOSTA** — recomendação técnica desta fase, reversível.
- **OPEN DECISION (OD-nn)** — não pode ser determinada com segurança a partir do conceito; nunca tratada como fechada.
- **PG-nn** lacuna do Platform · **DV-nn** divergência encontrada · **R-nn** risco.

## Fora de âmbito (F18)
CRUDs, migrations definitivas, billing, pagamentos, integração com Micha Express, deploys, UI de cliente, app móvel,
analytics avançados, notificações, IA. Modelo fiscal, IVA, POS, faturação, loyalty, CRM avançado, contabilidade,
transportes, marketplace: **FUTURE**, fora do core.
