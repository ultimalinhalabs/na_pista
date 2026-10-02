# F31 — Reference Product UI · Auditoria (F31.0)

Auditoria feita **antes de qualquer código**, sobre `na-pista` @ `dab0251` (F30 fechada, contrato em
`7f86f61`/`dab0251`), `na-pista-console` @ `67622fc` e `ul-platform` @ `5f5034c`. O código foi tratado como fonte
de verdade; cada afirmação de contrato abaixo foi verificada no source (`src/modules/*/schemas.ts`,
`src/db/schema/*.ts`, `src/shared/listing.ts`) e no OpenAPI gerado (`docs/api/openapi.json`).

Tenant de referência: **O Partir do Pão** — Pastelaria · Cafetaria · Eventos (Rua 3 do Cassenda, Luanda).

---

## 1. Arquitectura encontrada

```
Browser ── Supabase Auth (sessão) ──┐
   │                                 │ Bearer JWT
   ▼                                 ▼
na-pista-console (Next 15, client-rendered)  ──►  Na Pista API  /v1/organizations/:org/...
   (Default UI, ADR-008)                      ──►  UL Platform  /v1/me, /v1/organizations/:org, ...
```

- A UI do Na Pista vive num **repositório independente**: `na-pista-console` (Default UI, ADR-008). O `na-pista` é
  só API. A F31 é construída **no `na-pista-console`** — é lá que estão o cliente de API, o design system, o shell e
  as páginas de Produtos/Categorias que o brief manda reutilizar (§22). Criar um repositório novo (Custom UI)
  obrigaria a duplicar cliente de API, tratamento de erros e componentes — exactamente o que o brief proíbe.
- Tenant: a organização vem do segmento `/o/[organizationId]`, cruzado no layout com as memberships reais
  (`GET /v1/me` do Platform) — gate de UX. A autorização real é a pipeline do Na Pista
  (auth → tenant → permission → entitlement `catalog.enabled`). A UI nunca decide acesso.
- Dados: `lib/api/*` → `callNaPista` / `callNaPistaPage` (envelope `{ data, pagination }`, ADR-051) → `ApiError`
  (`status`, `code`, `message`, `requestId`). 401 dispara `np:session-expired` → logout + `/login?expired=1`.
- Fetching: `useAsync` (ignora respostas obsoletas, mantém dados anteriores durante reload).
- Testes: Vitest + Testing Library + jsdom, API mockada ao nível de `lib/api/*`. **Baseline: 15 ficheiros,
  166/166 testes a passar.**

## 2. Design System existente (`DESIGN.md` + `app/globals.css`)

| Camada | Estado | Reutilizável na F31 |
|---|---|---|
| Tokens `--np-*` (cores, espaço, raio, sombra) | escuro premium, dourado restrito | **sim** — é a base a tematizar |
| Classes (`.btn`, `.card`, `.input`, `.badge`, `.table-wrap`, `.alert`, `.empty`, `.skeleton`, `.modal`, `.drawer`, `.sidebar`…) | consomem só tokens | sim |
| `components/ui/Button` (`Button`, `ButtonLink`, `Spinner`) | `loading` → `aria-busy` + disabled (anti duplo envio) | sim |
| `components/ui/Form` (`Field`, `FormSection`, `SearchInput`) | `Field` liga label/hint/erro (`aria-describedby`, `aria-invalid`, `role=alert`) | sim |
| `components/ui/Feedback` (`Alert`, `EmptyState`, `Skeleton`, `TableSkeleton`, `ErrorNotice`, `ModuleUnavailable`, `PermissionDenied`, `ResultLimitNotice`) | `ErrorNotice` = código → pt-PT + detalhe seguro + referência do pedido | sim (`EmptyState` precisa de ícone opcional) |
| `components/ui/Overlay` (`Modal`, `ConfirmDialog`, `Drawer`) | focus trap, Esc, retorno de foco | sim |
| `components/ui/Data` (`Badge`, `DataTable`, `Stat`, `Timeline`, `DetailList`) | `DataTable` com skeleton/vazio/scroll | sim (sem cabeçalhos ordenáveis) |
| `components/patterns` (`PageHeader`, `ResourceHeader`, `Section`, `FilterBar`, `ListPage`, `DetailGuard`) | `ListPage` é só tabela, sem paginação real | `PageHeader`/`DetailGuard` sim; `ListPage` não serve o catálogo em grelha |
| `components/shell` (`AppShell`, `CommandMenu`) | sidebar agrupada, gaveta móvel < 900px, Ctrl+K | sim — com marca/nav por tema |
| `lib/errors.ts`, `lib/status.ts`, `lib/format.ts` | mapa de erros, vocabulário de estados, `formatMoney` sem floats | sim |

**Ícones:** não existe biblioteca de ícones; o shell usa 3 SVG inline. O brief pede Lucide → `lucide-react`
(dependência justificada, tree-shakeable, ISC).

**Tipografia:** stack de sistema (`-apple-system, Segoe UI, Roboto`), sem fonte de marca.

**Tematização:** inexistente. `DESIGN.md` declara que a Default UI é *sempre* escura/dourada. Como **todas** as
classes consomem tokens (verificado: sem hex fora de `:root`, excepto `rgba(0,0,0,.6)` nos overlays), uma camada
de tema por tenant é possível **sem tocar nos componentes** — basta redefinir tokens num escopo.

## 3. Endpoints de Produtos/Categorias (verificados)

Todos sob `/v1/organizations/:organizationId`, gate `requireTenantContext` + `requireCapability("catalog.enabled")`.

| Método | Caminho | Permissão | Notas |
|---|---|---|---|
| GET | `/products` | `products.read` | `q`, `status`, `categoryId`, `page`, `pageSize` (≤100, default 50), `sort` ∈ {`createdAt`,`name`}, `order` ∈ {`asc`,`desc`} (default `createdAt desc`); envelope paginado |
| POST | `/products` | `products.create` | 201 |
| GET | `/products/:productId` | `products.read` | |
| PATCH | `/products/:productId` | `products.update` | inclui `status` (reactivar) |
| DELETE | `/products/:productId` | `products.delete` | **arquiva** (ADR-020), nunca apaga |
| GET | `/categories` | `categories.read` | `status`, `page`, `pageSize` (≤100), `sort` ∈ {`createdAt`,`name`}, `order` — **sem `q`** |
| POST | `/categories` | `categories.create` | |
| GET | `/categories/:categoryId` | `categories.read` | |
| PATCH | `/categories/:categoryId` | `categories.update` | `name`, `description`, `status` |
| DELETE | `/categories/:categoryId` | `categories.delete` | arquiva |
| GET | `/audit-events?resourceType=product&resourceId=…` | `audit.read` (OWNER/ADMIN) | histórico real do produto (F30, ADR-055) |
| GET | `/inventory/:productId` | `inventory.read` | saldo de um produto (já usado no detalhe) |

Papéis (espelho UX em `lib/permissions.ts`): OWNER/ADMIN tudo; MANAGER sem `*.delete` (não arquiva);
STAFF só leitura.

## 4. Campos reais

**Product** — `id`, `organizationId`, `categoryId` (nullable), `name` (1–200, trim), `description` (≤2000,
nullable), `unit` ∈ {`UNIT`,`KG`,`G`,`L`,`ML`} (default `UNIT`), `price` (`numeric(14,2)` como string decimal,
nullable; `null` = "sem preço" ≠ `0` = "gratuito"; aceita número ou string, rejeita negativo/NaN), `status` ∈
{`ACTIVE`,`ARCHIVED`}, `createdAt`, `updatedAt`. Corpo `.strict()` — campos desconhecidos → 400.
`categoryId` de outra organização → `400 VALIDATION_ERROR` (+ FK composta em Postgres).

**Category** — `id`, `organizationId`, `name` (1–200), `description` (≤2000, nullable), `status`, `createdAt`,
`updatedAt`. Plana (sem hierarquia). Sem contagem de produtos.

**Moeda:** AOA (ADR-030); `formatMoney` → `1 850,00 Kz`.

### Suporte real (pedido pelo brief §1.8)

| Capacidade | Existe? | Evidência / consequência na UI |
|---|---|---|
| Imagens | **não** | sem coluna, sem upload, sem storage. Card/detalhe mostram uma área visual neutra **sem** botão de upload |
| Unidades | **sim** | `unit` (5 valores). Mostrada e editável |
| Stock | **sim, noutro módulo** | `inventory` (saldo por produto). Não vem no produto; a lista não o junta. Card **não** mostra stock; detalhe mantém o saldo (já existente, pedido por produto) |
| Bundles / kits | **não** | "Kit Aniversário" só pode existir como produto simples com descrição |
| Variantes | **não** | "Brigadeiros simples/personalizados" = produtos distintos |
| Preços compostos / por quantidade | **não** | um único `price` actual; sem tabelas de preço, sem "a partir de" |
| Metadados / atributos livres | **não** | nada além dos campos acima |
| Ordenação por preço / `updatedAt` | **não** | só `name` e `createdAt` |
| Pesquisa | `q` = substring do **nome** (ILIKE) | não pesquisa descrição |
| Contagem por categoria | só via `GET /products?categoryId=…&pageSize=1` → `pagination.total` | contagem exacta por categoria custa 1 pedido/categoria |
| Histórico do produto | **sim** (OWNER/ADMIN) | `GET /audit-events` filtrado por recurso |
| Branding/tema por tenant | **não** | nem Na Pista nem Platform expõem logo/cores. Platform expõe `slug` em `GET /v1/organizations/:id` (`organization.read`, todos os papéis) |
| "Eventos" (encomendas para eventos) | **não** | Appointments existe mas é serviço+profissional, não evento de pastelaria |

## 5. Lacunas no consumo actual da Console (não no contrato)

- `listProducts`/`listCategories` usam `limit` (alias deprecado) e `callNaPista` — **ignoram `pagination`**; a UI
  mostra "primeiros 100" em vez de paginar. A F30 já fornece `page/pageSize/total/totalPages`.
- `sort`/`order` nunca são enviados.
- `ApiError` não lê `error.details` (ADR-053) → erros de validação não são associados ao campo.
- `PAYLOAD_TOO_LARGE` não tem mensagem pt-PT.
- O formulário de produto não expõe `unit` (o contrato aceita).
- O detalhe diz "histórico não disponível pela API" — já não é verdade desde a F30 (`audit.read`).

## 6. Gaps entre a experiência desejada e o contrato

| # | Desejado (brief) | Contrato actual | Decisão F31 |
|---|---|---|---|
| G1 | Imagem de produto | inexistente | área visual de marca (inicial + ícone da categoria), explicitamente "sem fotografia"; **sem** upload fingido. Proposta futura: `imageUrl`/media module (ADR a escrever) |
| G2 | Tema do tenant vindo da plataforma | inexistente | registo de temas **no código da UI**, resolvido pelo `slug` real da organização (Platform). Proposta futura: contrato `appearance` no Platform/Na Pista |
| G3 | Ordenar por preço / actualização | só `name`, `createdAt` | UI oferece só as ordenações suportadas; **sem** ordenação client-side |
| G4 | Coluna "Actualizado" ordenável | mostrável, não ordenável | coluna mostrada, cabeçalho não clicável |
| G5 | Pesquisa em categorias | sem `q` | categorias raramente passam de dezenas → sem pesquisa (não filtrar client-side) |
| G6 | Stock no card | outro módulo, sem junção | não mostrado no card; detalhe mostra saldo (existente) |
| G7 | Kits/bundles, variantes | inexistentes | não simulados; documentado como próximo passo de produto |
| G8 | Nav "Agenda → Eventos" | sem módulo | **omitido** do menu (regra "não criar módulos sem backend") |
| G9 | Contagem de produtos por categoria | sem agregação | N pedidos `pageSize=1` (aceitável para dezenas de categorias); documentar custo |
| G10 | Distinguir DEMO DATA vs REAL DATA | sem campo/flag | por **organização**: um tenant de demonstração dedicado é marcado no registo de temas e a UI mostra um aviso permanente "Dados de demonstração" |
| G11 | Seed de produtos de referência | só via API pública | **não** criado sem autorização explícita (brief §13) |

Nenhum gap exige endpoint novo para a F31 funcionar. **Nenhum endpoint privado/interno é criado.**

## 7. Decisões de UI

1. **Local:** `na-pista-console` (ver §1). O Partir do Pão é o primeiro **Design Tenant** — um tema (dados), não um
   fork nem `if (tenant === X)` espalhado.
2. **Tema = tokens.** Novos tokens semânticos `--brand-*` (pedidos no brief §4) definidos em `:root` a partir dos
   valores Na Pista; os `--np-*` passam a derivar deles. Um tema de tenant redefine só `--brand-*` num escopo
   `[data-tenant-theme="…"]`. Componentes continuam a consumir os mesmos tokens → zero regressão para os outros
   tenants. `DESIGN.md` é actualizado (a regra "sempre escuro" passa a ser "escuro por omissão; tema de tenant
   permitido via tokens").
3. **Resolução do tema:** `slug` da organização (Platform `GET /v1/organizations/:id`) → registo
   `lib/theme/tenants.ts`. Sem match → tema Na Pista. Cosmético apenas; nunca autorização.
4. **Tipografia:** UI em sans funcional (Inter); display (Fraunces, serifada expressiva) **só** na identidade do
   tenant, título da visão geral/página e marca. Nunca em tabelas, formulários, números, navegação, labels.
5. **Produtos:** página nova sobre o contrato paginado — grelha (por omissão) / lista, pesquisa (nome), filtros
   (categoria, estado), ordenação (nome, mais recentes/antigos), paginação real, estados
   loading/empty/no-results/error/entitlement/forbidden. Vista e filtros reflectidos no URL.
6. **Detalhe:** página (não drawer) — permite link directo na demo e preserva o padrão `DetailGuard`.
7. **Criar/editar:** um formulário partilhado (`ProductForm`) para criar (modal) e editar (detalhe), com `unit`,
   validação de limites alinhada com o schema, erros de campo a partir de `error.details`.
8. **Categorias:** lista com ícone discreto e contagem real de produtos; criar/editar/arquivar/reactivar.
9. **Navegação por perfil:** o tema pode declarar um perfil de navegação de negócio de produto (o IA do brief §6),
   filtrado também pelas permissões; módulos sem backend não aparecem.

## 8. Fora de âmbito (confirmado)

Bundles, variantes, preços compostos, imagens/upload, pagamentos, WhatsApp, CRM, analytics, delivery, facturas,
marketplace, endpoints novos, alterações à fundação da API.
