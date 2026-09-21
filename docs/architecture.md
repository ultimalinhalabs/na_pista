# Arquitectura do Na Pista

> Convenções: **DECIDIDO** = derivado do conceito oficial, do CLAUDE.md ou do código do Platform.
> **PROPOSTA** = recomendação técnica desta fase, reversível. **OPEN DECISION (OD-nn)** = precisa de informação
> de negócio ou de uma decisão de segurança; registo em [`f18-review.md`](f18-review.md#4-open-decisions).

## 1. Definição oficial (fonte de verdade)

> "Na Pista é um SaaS Multi Tenant de gestão que possibilita aos gestores de empresas provedoras de produtos ou
> serviços fazer a gestão de seus processos por meio dos recursos que a plataforma proverá."

Consequências directas da definição:

1. **SaaS multi-tenant** → o tenant é a `Organization` do UL Platform (ADR-002).
2. **Gestores de empresas** → os utilizadores humanos são membros (Membership) de uma organização.
3. **Produtos ou serviços** → dois ramos de capacidade (comércio e marcação), combináveis (ADR-004).
4. **Recursos que a plataforma proverá** → módulos pré-concebidos, disponibilizados por **API** (ADR-005).
5. UI própria do cliente **ou** UI desenvolvida pela Última Linha → dois serviços comerciais distintos (ADR-008).

### O que o Na Pista É
Uma **infraestrutura modular de gestão empresarial**, exposta por API, com módulos activáveis por
capacidade contratada.

### O que o Na Pista NÃO é
Não é (nem se reduz a) ERP, POS, software de barbearia, software de loja, CRM ou sistema de inventário.
Esses são **contextos de utilização possíveis** dos módulos. Não é também: marketplace, meio de pagamento
(Micha Express), logística (Foi), automação conversacional (Qualé a Dica?!), nem parte do UL Platform.
Faturação fiscal, IVA, POS, loyalty, contabilidade: **FUTURE**, fora do core (brief §27).

## 2. Posição no ecossistema

```
                      Supabase Auth (identidade — um único projecto)
                              │ JWT
        ┌─────────────────────┼──────────────────────────────┐
        ▼                     ▼                              ▼
   UL Console            UL Client                  Na Pista Default UI / Custom UI
   (PLATFORM_ADMIN)      (tenant ↔ ecossistema)      (operação do negócio)
        │                     │                              │
        └───────────┬─────────┘                              │
                    ▼                                        ▼
              UL PLATFORM  ◄──────── API/contratos ────►  NA PISTA API
              "Quem pode usar?"     (service credentials)  "O que pode fazer?"
              identidade · orgs · memberships · roles      módulos de negócio
              plans · subscriptions · entitlements         BD PRÓPRIA (Postgres)
              api keys · scopes · usage · webhooks         audit de negócio próprio
              discovery · audit de plataforma
```

- Repositório **independente** (`na-pista/`), BD **própria**, deploy próprio. Nunca importa ficheiros do Platform,
  nunca lê a BD do Platform, nunca partilha tabelas (CLAUDE.md §2; ADR-001, ADR-003).
- Fala com o Platform **só por API** (ver [`api-boundary.md`](api-boundary.md)) e descobre-o/descobre-se via
  Service Discovery.
- É uma `Application` (`NA_PISTA`) no registry do Platform — uma linha de registo, não uma pasta de código do
  Platform (ADR-001).

## 3. Fronteira Platform ↔ Na Pista (regra)

> **UL Platform = infraestrutura SaaS transversal. Na Pista = domínio de gestão empresarial.**

| Pertence ao **UL Platform** | Pertence ao **Na Pista** |
|---|---|
| identidade e utilizadores; organizações; memberships; roles e permissions **genéricas** | módulos de gestão: produtos, categorias, stock/inventário, pedidos |
| registo de aplicações; planos; subscriptions; **entitlements efectivos** | clientes de negócio (BusinessCustomer) |
| credenciais de API e autenticação de serviço; service scopes | serviços, profissionais, horários, disponibilidade, agendamentos |
| usage (registo de factos) ; webhooks (transporte de eventos) | regras e workflows dos módulos; validações de negócio |
| service discovery; audit de **plataforma**; observabilidade comum | APIs de negócio; **audit de negócio**; definições do tenant (fuso, moeda) |
| infra SaaS transversal (rate limit, request id, health) | limites *aplicados* (contagens locais vs. entitlement) |

Testes de fronteira (usar em code review):
1. *"Isto muda se mudarmos de produto?"* Se sim → é Platform. Se só faz sentido para gestão comercial → Na Pista.
2. *"O Platform precisaria de conhecer um conceito de negócio para suportar isto?"* Se sim → está no sítio errado.
3. Nenhuma tabela `products`, `orders`, `inventory`, `appointments`, ... no Platform. Nenhuma `subscriptions`,
   `memberships`, `organizations` (como fonte de verdade) no Na Pista.

## 4. Estilo arquitectural (DECIDIDO, CLAUDE.md §8)

**Monólito modular** para o Na Pista: um serviço, um deployable, módulos com fronteiras fortes.
Sem microserviços. Sem broker. Fronteiras internas explícitas para permitir extracção futura, se e só se
houver necessidade operacional real.

Estrutura-alvo do código (PROPOSTA, a materializar no primeiro slice):

```
na-pista/
  src/
    platform/          # cliente do UL Platform (único ponto que fala com ele): entitlements, membership, usage, events, discovery
    tenancy/           # TenantContext, resolução e validação de organização
    auth/              # verificação de JWT (JWKS) e de credenciais de serviço
    modules/
      products/        # routes · service · repository · schema · events · permissions · module.ts (manifesto)
      customers/
      ...              # um directório por módulo; módulos só falam entre si via a sua interface pública
    shared/            # envelope, erros, paginação, request-id, logger
    db/                # cliente, migrations
```

Regras: `routes` finas → `service` (regras) → `repository` (única camada que toca em SQL e **exige** `TenantContext`).
Um módulo nunca importa o `repository` de outro.

## 5. Fluxo de um pedido humano (DECIDIDO na ordem, PROPOSTA nos mecanismos)

```
Request (Bearer JWT)
  → autenticar: verificar JWT Supabase (JWKS pública; iss + aud)             [Na Pista]
  → resolver aplicação: NA_PISTA (é este serviço)
  → resolver organização: :organizationId do path — NUNCA confiar sem validar
  → membership activo + roleKey: via Platform (GET /v1/me com o JWT do utilizador)  [OD-12]
  → autorização: permission local do módulo ⊆ roleKey                        [Na Pista, OD-12]
  → entitlement: módulo habilitado para a org (Platform, cache curto)        [PG-1 / OD-11]
  → controller → service → repository(TenantContext) → BD
  → audit de negócio + outbox (eventos, usage) na MESMA transacção
```

Detalhes em [`authorization.md`](authorization.md), [`tenancy.md`](tenancy.md), [`entitlements.md`](entitlements.md).

## 6. Escala e simplicidade
Nada nesta fase resolve problemas de escala futuros com complexidade presente (CLAUDE.md §14): sem CQRS, sem
event sourcing, sem cache distribuído, sem broker. O único mecanismo "assíncrono" proposto é uma **outbox em
Postgres** porque o Platform entrega eventos/usage de forma síncrona e sem dedupe (PG-7) — ver `events.md`.
