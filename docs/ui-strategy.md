# Estratégia de UI (ADR-008)

> **Identidade visual (obrigatória, desde 2026-09):** a Default UI (`na-pista-console`) segue a marca Na Pista
> — *"Na Pista — Ideias em Operação"* — descrita e normatizada em
> [`na-pista-console/DESIGN.md`](../../na-pista-console/DESIGN.md). É um requisito de produto: todo módulo
> novo (Inventory, Orders, Services, ...) reutiliza os tokens/componentes definidos ali, nunca cria uma
> paleta própria. O Na Pista tem identidade visual própria, distinta da Última Linha (marca do ecossistema).

## 1. Três coisas separadas

```
                        NA PISTA API   (contrato OpenAPI versionado — a única superfície)
                              │
             ┌────────────────┼──────────────────────────┐
             ▼                ▼                          ▼
        Default UI       Custom UI (UL)          UI do próprio cliente
     (produto UL SaaS)   (projecto UL, serviço)  (o cliente constrói)
             │                │                          │
        todos os tenants   um cliente específico    um cliente específico
```

| # | O quê | Dono | Repositório | Modelo comercial |
|---|---|---|---|---|
| 1 | **Na Pista API** | Na Pista | `na-pista` | acesso SaaS (subscrição `NA_PISTA` no Platform) |
| 2 | **Default UI** | Na Pista | repositório **próprio e independente** (nome a fixar) | incluída no SaaS |
| 3a | **Custom UI da Última Linha** | projecto UL por cliente | repositório **por cliente** | **serviço separado** (desenvolvimento), não é plano/entitlement |
| 3b | **UI do próprio cliente** | o cliente | do cliente | só acesso SaaS + API |

O desenvolvimento de UI personalizada é **serviço separado** do acesso SaaS (brief §1): o Platform representa
apenas o acesso (planos/subscrições). Como registar/facturar o serviço de UI: fora do Platform e fora da F18 (OD-20).

## 2. Onde NÃO vive a UI de negócio
- **UL Client** — o seu `CLAUDE.md` declara-o *não* dashboard de produto (administra a relação da org com o
  ecossistema). Meter ecrãs de produtos/pedidos/agenda lá violaria isso.
- **UL Console** — só `PLATFORM_ADMIN`, nunca dados de tenant.
- **Sem lógica de negócio** em nenhum dos dois: o UL Client pode, no máximo, mostrar entitlements/usage do Na Pista
  (já o faz para todas as aplicações) e ligar/redirecionar para a UI do Na Pista.

## 3. Como Default UI e Custom UI consomem o **mesmo** core
1. **Só API pública.** Sem imports de código, sem acesso à BD, sem endpoints "privados só da nossa UI". Se a
   Default UI precisa de algo, o contrato de API cresce para todos.
2. **Cliente tipado gerado do OpenAPI** (pacote publicado/gerado a partir do contrato — nunca dependência de
   ficheiros entre repositórios).
3. **A UI não resolve regras.** Módulos habilitados, limites e permissões do utilizador vêm calculados pela API
   (PROPOSTA: `GET /v1/organizations/:orgId/capabilities` →
   `{ modules: [{ key, enabled, limits }], permissions: [...] }`). A UI usa-os para *mostrar/ocultar*; a API
   *decide* sempre (padrão do UL Client: gate de UI = UX, não segurança). Assim uma UI personalizada obtém a mesma
   inteligência sem a reimplementar.
4. **Navegação dinâmica por módulo:** a UI monta o menu a partir de `capabilities`. Boutique, barbearia e
   híbrida são a *mesma* UI com módulos diferentes activos.
5. **Sem fork do core.** Personalização = composição de UI (tema, layout, fluxos) sobre a mesma API. Necessidades que
   exijam comportamento novo no servidor entram como capacidade **genérica** do core (com ADR), nunca como
   `if (cliente === X)`. Se algum dia forem precisos campos personalizados, avaliar *atributos personalizados
   genéricos por tenant* — nunca colunas específicas de um cliente.
6. **Código específico de cliente** vive só no repositório da Custom UI desse cliente.

## 4. Autenticação e origem dos pedidos por tipo de UI

| UI | Como autentica | Consequência |
|---|---|---|
| Default UI, Custom UI UL | Supabase Auth (mesmo projecto) no browser → JWT → Na Pista API | URLs de redirecção OAuth por UI têm de estar registadas no Supabase; a origem tem de estar no **CORS** do Na Pista |
| UI do cliente com login de equipa | idem (a equipa são utilizadores UL com membership) | idem |
| UI/backend do cliente sem utilizadores UL | servidor do cliente com **API key de integração** (`ulk_`, scopes de dados) — BFF | chave nunca vai para o browser |

CORS por tenant/UI personalizada: o Platform usa allow-list em variável de ambiente (`PLATFORM_ALLOWED_ORIGINS`);
um Na Pista com N UIs de clientes precisa de política própria — **OD-17** (recomendação inicial: allow-list
configurável mantida por operação, sem wildcard; nunca `*` com credenciais).

## 5. Ambientes
Clientes que constroem a sua UI precisam de `staging` do Na Pista com chaves de teste (o Platform já modela
`production`/`staging` por aplicação). Registar o endpoint real em cada ambiente é tarefa de `PLATFORM_ADMIN` no
UL Console (o seed só tem placeholder de staging).
