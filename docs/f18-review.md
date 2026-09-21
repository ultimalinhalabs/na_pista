# F18 — Validação, auto-revisão, decisões abertas e riscos

## 1. Estado
**PARTIAL.** A arquitectura e o blueprint estão definidos e coerentes com o código real do Platform, mas existem
**decisões fundamentais que o conceito não permite fechar** (secção 4), incluindo duas de **segurança** (OD-11,
OD-12). Declarar COMPLETE esconderia essas decisões — por isso não o faço. Nenhuma foi inventada: cada uma tem
recomendação **e** está marcada `OPEN DECISION`.

## 2. Validação por cenários

Critérios (brief §28): sem duplicar código · sem alterar o UL Platform · sem forks · sem lógica de negócio no UL Client.

| | **A. Boutique** | **B. Barbearia** | **C. Híbrida** |
|---|---|---|---|
| Módulos (entitlements) | PRODUCTS, INVENTORY, ORDERS, CUSTOMERS → `products/inventory/orders/customers.enabled` | SERVICES+PROFESSIONALS, SCHEDULING+APPOINTMENTS, CUSTOMERS → `services/appointments/customers.enabled` | PRODUCTS, INVENTORY, ORDERS, SERVICES, SCHEDULING (+CUSTOMERS) → união das duas listas |
| Como se configura | plano `NA_PISTA` com essas chaves; subscrição da org | idem, outras chaves | idem, união |
| Código duplicado? | não — módulos são os mesmos, só muda o que está habilitado | não | não — nenhum código "híbrido": é a soma; `CUSTOMERS` é partilhado (uma entidade, dois ramos) |
| Altera código do Platform? | **não** (só dados: chaves em `plan_entitlements`, PG-4) — *condicionado a OD-11 opção A e OD-12 opção A* | não (idem) | não (idem) |
| Forks? | não — mesma API, mesma Default UI (menu por `capabilities`) | não | não |
| Lógica de negócio no UL Client? | não — Client só mostra entitlements/usage já existentes | não | não |
| Ponto de atenção | variantes (OD-02), stock negativo (OD-05), cliente opcional no pedido (OD-03) | conflitos/estados de marcação (OD-09), fuso (TenantSettings) | `Customer` único para pedidos e marcações → ADR-009 evita duas entidades; dependências entre módulos validadas no arranque |

**Resultado honesto:** a arquitectura suporta os três **sem** alterar código do Platform, **desde que** (1) as chaves
de entitlement/scopes/meters da Fase 2 sejam adicionadas por dados de seed (trabalho de dono do Platform, B1/E3) e
(2) se aceite provisionar uma chave de serviço por tenant (OD-11 opção A). Se o dono do Platform preferir a
credencial de aplicação (OD-11 opção B) ou um endpoint de membership (OD-12 opção B), **há** alteração de código do
Platform — proposta como decisão explícita, não como efeito colateral. Validação feita **em papel**; só o slice 1
a provará em código para o ramo COMMERCE (o ramo BOOKING fica por provar até ao slice 2).

## 3. Auto-revisão (brief §29)

1. **O que é o Na Pista?** Um SaaS multi-tenant que é uma infraestrutura modular de gestão empresarial, exposta por API, com módulos (produtos, stock, pedidos, clientes, serviços, profissionais, horários, marcações) habilitados por plano.
2. **O que NÃO é?** ERP, POS, software de barbearia/loja, CRM, inventário (contextos de uso, não a identidade); nem pagamentos, logística, chat, nem parte do UL Platform.
3. **Tenant boundary?** A `Organization` do UL Platform (`organization_id` em toda linha de negócio).
4. **Organization vs Business Customer?** A Organization é o tenant (a empresa que usa o Na Pista); o BusinessCustomer é alguém que essa empresa atende, dado de negócio dentro do tenant.
5. **Platform Customer vs Na Pista Customer?** Platform `customers` = relação conta-UL↔organização (sem API, sem uso). `BusinessCustomer` = registo comercial da organização, com ou sem conta UL. Não se misturam (ADR-009).
6. **Módulos?** PRODUCTS(+categorias), CUSTOMERS, INVENTORY, ORDERS, SERVICES, PROFESSIONALS, SCHEDULING, APPOINTMENTS (+TENANT settings).
7. **Core?** TENANT, PRODUCTS, CUSTOMERS. Fase 2: o resto. FUTURE: variantes, localizações, relatórios, auto-marcação, tudo o que é fiscal/pagamento/entrega.
8. **Empresa de produtos?** Subscreve um plano com PRODUCTS/INVENTORY/ORDERS/CUSTOMERS; usa a API (ou a Default UI).
9. **Empresa de serviços?** Plano com SERVICES/PROFESSIONALS/SCHEDULING/APPOINTMENTS/CUSTOMERS.
10. **Híbrida?** Plano com a união; mesma API e UI; `CUSTOMERS` partilhado.
11. **Controlado pelo Platform?** Identidade, organizações, memberships, roles, aplicações, planos, subscrições, entitlements efectivos, chaves de serviço/scopes, usage (registo), webhooks (transporte), discovery, audit de plataforma.
12. **Controlado pelo Na Pista?** Todos os dados e regras de negócio, permissions de módulo, aplicação de limites (contagens locais), audit de negócio, definições do tenant.
13. **Como chegam as subscriptions?** Não chegam como objecto: o Na Pista vê `subscription.status/planKey` dentro dos entitlements efectivos (pull); a subscrição gere-se no Platform.
14. **Como chegam os entitlements?** `GET .../applications/NA_PISTA/entitlements` com chave org-scoped, cache de TTL curto, semântica fail-closed (`entitlements.md`).
15. **UI customizada e o mesmo core?** Consome a mesma API OpenAPI e `GET /capabilities`; sem fork; código de cliente só no seu repositório (`ui-strategy.md`).
16. **Isolamento de tenant?** Coluna obrigatória + FKs compostas + repository que exige `TenantContext` + membership validado a cada pedido + testes obrigatórios [+ RLS, OD-16].
17. **Service-to-service auth?** API key `ulk_` (identidade) + scopes (autorização), verificada pelo Platform; duas classes de chave separadas; Na Pista→Platform por chave org-scoped (hoje, PG-1).
18. **Usage?** Fluxos: `orders`, `appointments`(➕), `api_requests`. Estados (`products`, `customers`, `professionals`) são contagens locais, não usage.
19. **Audit?** Alterações a produtos/preços, ajustes de stock, cancelamentos de pedido/marcação, mudanças de serviço/profissional/definições — no audit de negócio do Na Pista; o Platform audita o que é dele.
20. **Primeiro slice?** Product Management (ADR-010).
21. **Maiores riscos?** Secção 5.
22. **Decisões que precisam do negócio?** Secção 4.

## 4. Open decisions

Tipo: **[SEG]** segurança · **[NEG]** informação de negócio · **[TEC]** decisão técnica com spike · **[PLAT]** depende do dono do Platform.
Todas têm recomendação nos documentos referidos; **nenhuma está fechada**.

| ID | Decisão | Tipo | Onde | Bloqueia o slice 1? |
|---|---|---|---|---|
| OD-01 | Moeda(s), país/locale, casas decimais; multi-moeda | NEG | domain-model PD-4, tenancy | parcial (moeda em `TenantSettings`) |
| OD-02 | Variantes de produto (unidade vendável) | NEG | PD-3 | não (risco R-04) |
| OD-03 | Pedido exige cliente? | NEG | PD-8 | não (Fase 2) |
| OD-04 | Unidade de medida e quantidades fraccionárias | NEG | PD-7 | não |
| OD-05 | Stock negativo/backorder | NEG | PD-6 | não |
| OD-06 | Localizações/armazéns | NEG | PD-7 | não |
| OD-07 | Barcode | NEG | PD-7 | não |
| OD-08 | Categorias planas ou em árvore | NEG | PD-2 | não (slice 1b) |
| OD-09 | Estados de marcação, buffers, multi-serviço, prazos de cancelamento | NEG | SD-2/SD-5 | não (Fase 2) |
| OD-10 | Auto-marcação/login do cliente final e ligação a conta UL | NEG | ADR-009 | não |
| **OD-11** | **Como o Na Pista actua sobre N orgs: chave por tenant (hoje) vs. credencial de aplicação (mudança no Platform)** | **SEG/PLAT** | PG-1, PG-8, authorization §3 | **sim** |
| **OD-12** | **Membership via `/me` (JWT reencaminhado) vs. endpoint de serviço; permissions locais vs. permissions com escopo de aplicação no Platform** | **SEG/PLAT** | PG-2, PG-3, authorization §2 | **sim** |
| OD-13 | TTL de caches; `max` ausente; `past_due`/`trialing`; período de `appointments.max` | SEG/NEG | entitlements §3 | sim (TTL, semântica) |
| OD-14 | Vocabulário de entitlements/scopes/meters (`catalog.*` vs `products.*`; `products.enabled`) | PLAT | entitlements §4, DV-3 | sim (nome de `products.enabled`) |
| OD-15 | Audit de negócio próprio vs. ingestão no Platform; falhar a operação se o audit falhar | TEC/PLAT | audit §4 | não (recomendação assumida) |
| OD-16 | RLS na BD do Na Pista + compatibilidade com pooling | TEC | tenancy §3 | não (spike) |
| OD-17 | CORS e registo de origens de UIs de clientes; redirects OAuth | TEC | ui-strategy §4 | não |
| OD-18 | Hosting/BD do Na Pista (Postgres/Supabase próprio), ambientes | TEC | architecture | sim (infra) |
| OD-19 | Ordem da Fase 2: COMMERCE vs BOOKING | NEG | vertical-slice §1 | não |
| OD-20 | Composição comercial dos planos (o que entra em STARTER/BUSINESS) e como representar o serviço de UI personalizada | NEG | ui-strategy §1 | não |
| OD-21 | Ciclo de vida do tenant: org eliminada/subscrição cancelada → retenção/purga/aviso | SEG/NEG | tenancy §5, PG-6 | não (regra provisória: nunca apagar) |
| OD-22 | Privacidade/dados pessoais de clientes: enquadramento legal, anonimização, retenção | NEG/legal | domain-model §4 | antes de dados reais |

## 5. Riscos arquitecturais

| ID | Risco | Mitigação |
|---|---|---|
| R-01 | **Chaves por tenant** (OD-11 A): N segredos guardados no Na Pista, provisionamento manual por cada OWNER, revogação/rotação por tenant | Cifrar em repouso; runbook; decidir cedo se o Platform ganha credencial de aplicação (B) |
| R-02 | **Usage forjável** (PG-8): um tenant pode registar usage falso | Enforcement só com contagens locais; separação de classes de chave; corrigir no Platform se usage passar a facturar |
| R-03 | **Dependência do Platform em cada pedido** (membership, entitlement, introspecção de chave): latência e disponibilidade | Cache curto, timeouts, fail closed, métricas; reavaliar B (endpoint dedicado) se o custo for real |
| R-04 | **Variantes adiadas** (OD-02): migração dolorosa se a boutique exigir variantes cedo | Decidir com o negócio antes do schema de Orders/Inventory; manter `product_id` como referência única até lá |
| R-05 | **Permissions locais limitadas a 4 roles** (OD-12): negócio pode exigir permissões finas/roles por org | Ponto de decisão explícito; caminho = Platform suportar permissions por aplicação (ADR) |
| R-06 | **Cache de autorização** atrasa revogações (membership/chave/subscrição até ao TTL) | TTL curto e documentado; operações de alto risco podem saltar a cache |
| R-07 | **Orgs eliminadas sem aviso** (PG-6) deixam dados órfãos e potencial violação de retenção | Regra provisória "nunca apagar"; OD-21; pedir evento ao Platform |
| R-08 | **Isolamento falhar por bug** (esquecer `organization_id`) | 4 camadas + testes por endpoint obrigatórios + (RLS) |
| R-09 | **Entrega de eventos síncrona e não deduplicada** no Platform | Outbox + dedupe no consumidor; entrega assíncrona a partir do Na Pista |
| R-10 | **Scope creep para ERP/POS/CRM** — o conceito é "módulos", a tentação é "sistema completo" | Módulos só entram com justificação no conceito; FUTURE explícito para fiscal/pagamentos/loyalty/etc. |
| R-11 | **Documentação do Platform desactualizada** (DV-1/2) induz erros de integração | B2 no backlog; este repositório trata o código como contrato |
| R-12 | **Modelo de tempo/marcações** (fusos, DST, sobreposição) subestimado | Slice 2 dedicado; constraint de exclusão na BD; UTC + `timezone` do tenant |

## 6. O que esta fase **não** verificou
- Nada foi executado contra um Platform em runtime; as afirmações vêm de leitura de código.
- Não se leram todos os testes do Platform nem o código das páginas do Console/Client em detalhe (`platform-audit.md`, "Limites").
- Sem validação com utilizadores/negócio: as permissions propostas, estados e campos são pontos de partida.
