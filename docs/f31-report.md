# F31 — Reference Product UI · O Partir do Pão · Relatório

**Estado:** concluída como vertical slice (tema de tenant + Produtos + Categorias), sem alterações à API.
Auditoria prévia: [`f31-audit.md`](f31-audit.md). Evidência visual: [`f31-qa/`](f31-qa/).

## 1. Objectivo

Provar que a mesma infraestrutura Na Pista se torna **nativa do negócio que serve**: uma UI de referência da
categoria *Product Business*, com a identidade de O Partir do Pão (pastelaria · cafetaria · eventos), a
consumir **só** o contrato público da F30 — sem endpoints privados, sem bypass, sem dados inventados.

## 2. Arquitectura

```
na-pista-console (Default UI, ADR-008)
├── Core Design System      app/globals.css — componentes consomem --np-* (agora aliases)
├── Tokens semânticos       --brand-* em :root = identidade Na Pista (sem regressão)
├── Tema de tenant          app/themes/o-partir-do-pao.css → :root[data-tenant-theme="o-partir-do-pao"]
├── Registo de temas        lib/theme/tenants.ts — slug UL Platform → { key, displayName, tagline, navProfile, demo }
├── Resolução               lib/theme/TenantTheme.tsx — GET /v1/organizations/:id (Platform) → <html data-tenant-theme>
└── Business UI             Produtos · Categorias · Visão geral (perfil product-business)
```

- **O Partir do Pão é um "Design Tenant", não uma excepção:** zero `if (tenant === …)` nos componentes; o tema
  é dados (tokens + identidade + perfil de navegação). Um próximo tenant (ginásio, clínica, restaurante) é um
  ficheiro CSS + uma entrada no registo.
- **Tenant:** continua a vir do segmento `/o/:organizationId` cruzado com as memberships reais (`/v1/me`). O tema
  é **cosmético** — nunca concede nem decide acesso; a pipeline do Na Pista (auth → tenant → permission →
  entitlement) continua a ser a única autoridade.
- **Perfil `product-business`:** o menu do brief §6 — Visão geral · Operação (Pedidos, Clientes) · Catálogo
  (Produtos, Categorias) · Inventário (Stock) · Definições (+ Integrações). **"Agenda › Eventos" foi omitido:
  não existe backend** (gap G8). Marcações/Serviços/Profissionais saem do menu, do Ctrl+K e da visão geral.
- **Demo vs real:** a distinção é por **organização**. O slug `o-partir-do-pao-demo` está marcado `demo: true`:
  todas as páginas mostram o selo "Dados de demonstração" e a visão geral explica-o. O slug real
  (`o-partir-do-pao`) recebe o mesmo tema **sem** o selo.

## 3. Endpoints utilizados (todos públicos, F30)

| Endpoint | Uso |
|---|---|
| `GET /v1/organizations/:org/products` (`q`, `status`, `categoryId`, `page`, `pageSize`, `sort`∈{name,createdAt}, `order`) | catálogo (grelha/lista), contagens (`pageSize=1` → `pagination.total`) |
| `GET/PATCH/DELETE /v1/organizations/:org/products/:id`, `POST …/products` | detalhe, editar (PATCH só do que mudou), arquivar, reactivar, criar |
| `GET /v1/organizations/:org/categories` (`status`, `page`, `pageSize`, `sort`, `order`) | filtros, nomes, página de categorias |
| `POST/PATCH/DELETE …/categories[/:id]` | criar, editar, arquivar, reactivar |
| `GET /v1/organizations/:org/audit-events?resourceType=product&resourceId=…` | histórico real do produto (OWNER/ADMIN) |
| `GET /v1/organizations/:org/inventory/:productId` | saldo no detalhe (já existente) |
| UL Platform `GET /v1/organizations/:id` | `slug` para resolver o tema (todos os papéis) |

**Nenhum endpoint novo. Nenhuma alteração ao `na-pista/src`.**

## 4. Componentes

Novos (reutilizáveis, só tokens): `ProductCatalog`, `ProductCard`/`ProductGrid`/`ProductGridSkeleton`,
`ProductPrice`, `ProductVisual`, `ProductFormDialog` (criar/editar), `ArchiveProductDialog`, `Pagination`,
`SegmentedControl`, `TenantThemeProvider`/`useTenantTheme`. Helpers: `lib/catalog/visuals.ts` (ícone Lucide por
nome de categoria, tom estável), `displayDay`, `listProductsPage`/`countProducts`/`listCategoriesPage`/
`listAuditEvents`, `invalidBodyFields`.

Componentes globais alterados (compatíveis, documentados em `DESIGN.md §9`):

| Alteração | Impacto |
|---|---|
| `--np-*` passam a aliases de `--brand-*` | valores idênticos → sem mudança visual para outros tenants (verificado: [19](f31-qa/19-1440-unthemed-org-regression.jpg)) |
| `ApiError.details` (ADR-053) | parâmetro opcional, default `[]` |
| `DataTable` `Column.className`, `EmptyState` `icon` | opcionais |
| `AppShell` identidade de tenant, ícones Lucide no menu, menu do utilizador compacto ≤ 900px | sem tema = marca Na Pista como antes |
| **Bug corrigido** `Modal`/`Drawer`: o efeito de foco re-executava a cada render quando `onClose` era inline → o foco saltava para o primeiro campo enquanto se escrevia noutro | `onClose` via ref |
| **Bug corrigido** `.table-wrap` sem `position: relative`: cabeçalhos `.sr-only` (ex.: "Ações") escapavam ao scroll e alargavam a **página** em ecrãs estreitos | 1 linha CSS |
| Rodapé de `Modal` fixo (sticky) | acção primária visível em ecrãs baixos |
| `lib/permissions.ts`: `audit.read` para OWNER/ADMIN | espelho UX da F30 |

Dependência nova: **`lucide-react`** (pedida pelo brief §15; tree-shakeable). Fontes **Inter** (UI) e
**Fraunces** (display) via `next/font` — self-hosted no build, sem pedido a terceiros em runtime; só o tema as usa.

## 5. Decisões de design

- **Paleta (WCAG AA verificada, valores anotados no CSS):** creme `#FBF6F0` de base, superfícies brancas, texto
  chocolate `#3A2219` (13.7:1), rosa pastel `#F2C4CE` como identidade, **rosa forte `#A23F5B`** para links/foco/
  activo (6.2:1), **chocolate `#4A2A1E`** para a acção primária (12.1:1 com o texto creme), borda de campo
  `#A68C7B` (3.15:1, WCAG 1.4.11).
- **O rosa não domina:** a primeira QA mostrou a grelha toda rosa; os tons das áreas visuais passaram a ser
  neutros (creme/areia) com o rosa como um de três.
- **Tipografia:** Fraunces só na identidade, hero e títulos de página; Inter em tudo o resto (tabelas,
  formulários, números, navegação). Sem manuscrita.
- **Grelha por omissão**, lista como vista operacional; estado (vista, filtros, ordenação, página, pesquisa)
  no URL — qualquer passo da demo tem link directo.
- **Sem imagens no contrato:** área visual de marca com o ícone da categoria e a legenda explícita
  "Fotografias de produto ainda não são suportadas pela plataforma." — sem botão de upload.
- **Cards só com dados reais:** categoria, nome, descrição, preço (+ unidade), estado (badge só se arquivado).
  Sem stock, vendas, avaliações ou margens.
- **"Sem preço" é um estado legítimo** (ADR-031) e aparece como tal (ex.: brigadeiros personalizados por encomenda).
- **Formulário:** limites do schema (nome 1–200, descrição ≤ 2000, preço ≥ 0 com 2 casas, `1 500,50` aceite),
  unidade exposta ("Vendido por"), PATCH apenas dos campos alterados, erros de campo a partir de `error.details`
  sem mostrar o texto inglês do servidor, duplo envio bloqueado (botão + guarda).
- **Erros (ADR-053):** mensagem pt-PT por `error.code` + referência do pedido; 403 `FORBIDDEN` → estado de
  permissão; 403 `ENTITLEMENT_REQUIRED` → módulo indisponível; 401 → sessão expirada (comportamento F29).
- **Responsivo:** sidebar → gaveta ≤ 900px; toolbar → pesquisa a toda a largura + botão "Filtros" ≤ 767px;
  grelha 2 colunas ≤ 600px; lista esconde Categoria/Actualizado ≤ 767px (categoria passa para baixo do nome) e
  rola **dentro** do contentor; acções de linha só com ícone ≤ 1199px (com `aria-label`).

## 6. QA visual

Executada no browser real contra a stack local (Platform + Na Pista + Console) com o tenant de demonstração.
1440 em janela real; 1280/1024/768/390/375 em iframe com a largura exacta (as media queries vêem a largura real).
Em cada viewport verificou-se `document.scrollWidth ≤ largura` (sem scroll horizontal da página).

| Viewport | Ecrãs | Resultado |
|---|---|---|
| 1440 | [visão geral](f31-qa/01-1440-overview.jpg), [grelha](f31-qa/02-1440-products-grid.jpg), [lista](f31-qa/03-1440-products-list.jpg), [detalhe](f31-qa/04-1440-product-detail.jpg), [histórico](f31-qa/05-1440-product-history.jpg), [editar](f31-qa/06-1440-edit-dialog.jpg), [categorias](f31-qa/07-1440-categories.jpg), [org sem tema](f31-qa/19-1440-unthemed-org-regression.jpg) | ✅ |
| 1280 | [visão geral](f31-qa/08-1280-overview.jpg), [catálogo recente](f31-qa/09-1280-overview-catalog.jpg) | ✅ |
| 1024 | [lista](f31-qa/10-1024-products-list.jpg) | ✅ após correcção (acções cortadas → ícones + padding) |
| 768 | [grelha](f31-qa/11-768-products-grid.jpg) *(captura anterior à correcção do cabeçalho)*, [categorias](f31-qa/12-768-categories.jpg) | ✅ após correcção (nome do tenant reduzido a "O") |
| 390 | [detalhe](f31-qa/17-390-product-detail.png), [antes da correcção do cabeçalho](f31-qa/18-390-products-before-header-fix.png) | ✅ |
| 375 | [grelha](f31-qa/14-375-products-grid.png), [lista](f31-qa/13-375-products-list.png), [filtros](f31-qa/15-375-filters-open.png), [gaveta](f31-qa/16-375-drawer.png) | ✅ após correcção (scroll horizontal da página na lista) |

Problemas encontrados pela QA e corrigidos: grelha dominada por rosa; cabeçalho móvel; scroll horizontal da página
na lista (bug global de `.table-wrap`); acções cortadas a 1024; botão primário do diálogo abaixo da dobra.

## 7. Testes

Console: **226/226** (antes 166), 20 ficheiros; `tsc`, `eslint` e `next build` limpos. Novos:

| Ficheiro | Cobre |
|---|---|
| `components/catalog/catalog.test.tsx` (19) | contexto de tenant, pedido por omissão, grelha só com campos do contrato, lista, estado do URL, pesquisa no servidor (debounce), filtros, ordenação allowlisted, paginação, loading, vazio (com e sem permissão), sem resultados + limpar, erro com referência + retry, 403 FORBIDDEN, 403 ENTITLEMENT_REQUIRED, criar, arquivar com confirmação, MANAGER sem arquivar, `?new=1` |
| `components/catalog/ProductForm.test.tsx` (17) | normalização de preço, obrigatório + associação ARIA, limites, categorias activas, duplo envio, `details` → campo (sem texto do servidor), PATCH mínimo, limpar preço/unidade |
| `app/o/[org]/products/[productId]/page.test.tsx` (6) | campos, sem upload fingido, histórico real (OWNER), MANAGER sem `audit.read`, editar, arquivar → reactivar, 404 |
| `app/o/[org]/categories/page.test.tsx` (7) | lista + contagens reais com link filtrado, criar, arquivar, reactivar, STAFF só leitura, vazio, entitlement |
| `lib/theme/theme.test.tsx` (11) | slug → tema/demo, aplicação ao `<html>`, sem tema, falha do Platform → omissão, limpeza, perfil de navegação, Ctrl+K por perfil, shell com identidade e selo demo, `ApiError.details` |

Sessão expirada (401 → `/login?expired=1`) continua coberta pelos testes F29 do shell.
Na Pista: sem alterações a `src/`; `tsc` e `eslint` limpos para o script novo.

## 8. Dados de demonstração

Autorizados explicitamente para o ambiente **local/dev**. `npm run demo:o-partir-do-pao` (na-pista):

- cria pela API pública do Platform uma organização **separada** "O Partir do Pão", slug `o-partir-do-pao-demo`
  (owner = utilizador OWNER do manual-validation; ADMIN/MANAGER/STAFF com os seus papéis), subscrição
  NA_PISTA/BUSINESS e credencial platform-facing (provisionada como em `credentials:provision`);
- cria pela API do Na Pista 4 categorias e 13 produtos do material de referência (§13 do brief);
- idempotente (verificado: 2.ª execução reutiliza a org e não duplica); nada secreto é impresso; a fixture
  `.fixtures/demo-o-partir-do-pao.json` é git-ignored.

**Os preços são ilustrativos.** As imagens/flyers referidos no brief não chegaram a esta sessão; os valores foram
escolhidos apenas para demonstração e devem ser substituídos pelos reais pelo negócio.

Executado neste ambiente: organização `923efd2f-cefe-4eea-8041-24ba31b862c1`.

## 9. Limitações

- **Latência do ambiente local (importante para a demo):** cada pedido autenticado ao Na Pista demora
  **~5,5–6,9 s** e `/v1/me` ~2 s. Medido: a base de dados de dev é remota (~190 ms por round-trip `select 1`) e
  um pedido faz várias round-trips sequenciais (Platform: identidade, entitlements; Na Pista: credencial,
  lista + contagem). A UI dispara os pedidos em paralelo e mostra skeletons/estado ocupado; o tempo é do servidor.
  Os caches existentes (10–15 s, OD-13) só ajudam dentro dessa janela. **Recomendação:** apresentar a partir de
  um staging com API e base de dados na mesma região.
- O tema é resolvido por um registo no código (não há contrato de aparência — G2). O slug é editável por
  OWNER/ADMIN no Platform; uma org pode, portanto, adoptar um tema registado — efeito puramente cosmético, nunca
  de acesso.
- Contagem por categoria = 1 pedido por categoria visível (≤ 24) — sem agregação no contrato (G9).
- Pesquisa só por nome (contrato); categorias sem pesquisa (contrato).
- Os nomes de categoria > 100 não seriam resolvidos nos cards (lê-se a primeira página de 100, ordenada por nome).
- O histórico mostra "por utilizador/por integração", não o nome (resolver `actorId` exigiria a lista de membros).
- `ul-platform/.env` precisou de `http://localhost:3010` em `PLATFORM_ALLOWED_ORIGINS` (pré-requisito já
  documentado em `manual-validation.md` §2; corrigido pelo utilizador).

## 10. Gaps descobertos (contrato)

Ver `f31-audit.md §6`. Por prioridade comercial: **G1 imagens de produto**, **G2 aparência de tenant
(contrato)**, G7 kits/bundles e variantes ("Kit Aniversário", "Brigadeiros personalizados"), G8 encomendas para
eventos, G3/G4 ordenar por preço/actualização, G9 contagem por categoria, G6 stock na listagem.

## 11. Próximos passos recomendados

1. **Staging co-localizado** para a apresentação (latência §9) — maior impacto na percepção, zero código.
2. **ADR + módulo de media** (imagens de produto: storage, tamanhos, `imageUrl` no contrato) — o maior salto
   visual para um negócio alimentar.
3. **Contrato de aparência de tenant** (Platform ou Na Pista) para substituir o registo em código.
4. **Kits/bundles** como capacidade genérica do catálogo (não específica deste cliente).
5. Encomendas para eventos (data de entrega/levantamento num Pedido) — avaliar sobre Orders antes de um módulo novo.
6. Aplicar o mesmo padrão (paginação real, `details` nos formulários) a Clientes/Pedidos/Serviços.

## 12. Git

Commits locais apenas (sem push, sem alteração de remotes) — ver o resumo entregue com este relatório.
