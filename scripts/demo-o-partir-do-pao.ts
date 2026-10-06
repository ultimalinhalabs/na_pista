import "dotenv/config";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { loadManualValidationFixtures, type ManualValidationFixtures } from "./manual-validation-fixtures.js";

/**
 * F31 — DEMONSTRATION tenant for "O Partir do Pão" (Pastelaria · Cafetaria ·
 * Eventos). DEV-ONLY tooling, same family as `mv:seed`; never run against
 * production (brief §13).
 *
 * What it does, through PUBLIC APIs only (never a database write of its own):
 *   1. UL Platform: creates a SEPARATE organization "O Partir do Pão" with
 *      slug `o-partir-do-pao-demo` — the slug the Console's tenant theme
 *      registry marks as demo data, so every page says "Dados de
 *      demonstração" (brief §20). Owned by the manual-validation OWNER; the
 *      ADMIN/MANAGER/STAFF users join with their roles. Subscribes it to
 *      NA_PISTA/BUSINESS and mints its platform-facing credential.
 *   2. Na Pista: stores that credential exactly like `credentials:provision`
 *      does (introspected by the Platform, encrypted, audited).
 *   3. Na Pista API: sets the timezone and creates categories and products.
 *
 * The product names come from the client's reference material (brief §13).
 * The PRICES ARE ILLUSTRATIVE demo values, not the business's real prices.
 *
 * Idempotent: the organization is recorded in the git-ignored
 * `.fixtures/demo-o-partir-do-pao.json` (it holds a credential secret — never
 * commit, paste or log it) and reused on later runs; the catalog is only
 * seeded when the organization has no products. Prints ids and counts only.
 *
 * Requires: ul-platform `npm run dev`, na-pista `npm run dev`, and the
 * manual-validation fixtures (`npm run mv:provision` in ul-platform).
 * Usage: npm run demo:o-partir-do-pao
 */
const API = process.env.NA_PISTA_API_URL ?? `http://127.0.0.1:${process.env.PORT ?? 4200}/v1`;
const DEMO_FIXTURE = resolve(".fixtures/demo-o-partir-do-pao.json");
const SLUG = "o-partir-do-pao-demo";
const NAME = "O Partir do Pão";
const TZ = "Africa/Luanda";

interface DemoFixture {
  createdAt: string;
  organizations: { DEMO_O_PARTIR_DO_PAO: { id: string; name: string; slug: string; credentials: { platformFacing: { keyId: string; secret: string; scopes: string[] } } } };
}

async function signIn(fixtures: ManualValidationFixtures, email: string, password: string): Promise<string> {
  const res = await fetch(new URL("/auth/v1/token?grant_type=password", fixtures.supabaseUrl), {
    method: "POST",
    headers: { apikey: fixtures.supabaseAnonKey, "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) throw new Error(`sign-in failed: ${res.status}`);
  return ((await res.json()) as { access_token: string }).access_token;
}

function http(base: string, token: string) {
  return async function call<T = { id: string }>(method: string, path: string, body?: unknown): Promise<{ data: T; pagination?: { total: number } }> {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json = (await res.json().catch(() => undefined)) as { data?: T; pagination?: { total: number }; error?: { code?: string } } | undefined;
    // Status and error code only — never a response body (the credential creation response holds a secret).
    if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${json?.error?.code ?? ""}`);
    return { data: json!.data as T, pagination: json!.pagination };
  };
}

async function ensureOrganization(fixtures: ManualValidationFixtures, ownerToken: string): Promise<DemoFixture> {
  if (existsSync(DEMO_FIXTURE)) {
    const existing = JSON.parse(readFileSync(DEMO_FIXTURE, "utf8")) as DemoFixture;
    console.log(`Reusing demo organization ${existing.organizations.DEMO_O_PARTIR_DO_PAO.id}`);
    return existing;
  }
  const platform = http(fixtures.platformBaseUrl, ownerToken);
  const reference = fixtures.organizations.PRODUCT_REFERENCE;
  const { data: org } = await platform<{ id: string; name: string; slug: string }>("POST", "/organizations", { name: NAME, slug: SLUG });
  for (const role of ["ADMIN", "MANAGER", "STAFF"] as const) {
    await platform("POST", `/organizations/${org.id}/memberships`, { userId: reference.users[role].id, roleKey: role });
  }
  await platform("POST", `/organizations/${org.id}/subscriptions`, { applicationKey: "NA_PISTA", planKey: "BUSINESS" });
  const { data: key } = await platform<{ id: string; secret: string; scopes: string[] }>("POST", `/organizations/${org.id}/api-keys`, {
    applicationKey: "NA_PISTA",
    scopes: ["usage.write", "event.publish"],
  });
  const fixture: DemoFixture = {
    createdAt: new Date().toISOString(),
    organizations: { DEMO_O_PARTIR_DO_PAO: { id: org.id, name: org.name, slug: org.slug, credentials: { platformFacing: { keyId: key.id, secret: key.secret, scopes: key.scopes } } } },
  };
  writeFileSync(DEMO_FIXTURE, JSON.stringify(fixture, null, 2), { encoding: "utf8", mode: 0o600 });
  console.log(`Created demo organization ${org.id} (slug ${org.slug}); fixture written to .fixtures/ (git-ignored, contains a secret).`);
  return fixture;
}

async function provisionCredential(fixture: DemoFixture) {
  const org = fixture.organizations.DEMO_O_PARTIR_DO_PAO;
  const { provisionPlatformCredential } = await import("../src/modules/platformCredentials/service.js");
  const { queryClient } = await import("../src/db/index.js");
  try {
    const { outcome } = await provisionPlatformCredential(
      { organizationId: org.id, credential: org.credentials.platformFacing.secret },
      { actor: { type: "service", id: "system:demo-o-partir-do-pao" }, requestId: "demo:o-partir-do-pao" },
    );
    console.log(`Platform credential for ${org.id}: ${outcome}`);
  } finally {
    await queryClient.end();
  }
}

/** Reference catalog (brief §13). Prices are ILLUSTRATIVE — the business sets its own. */
const CATALOG: { category: string; description: string; products: { name: string; description: string; price: string | null }[] }[] = [
  {
    category: "Kits de aniversário",
    description: "Kits completos para festas em casa e na escola.",
    products: [
      { name: "Kit Aniversário Home", description: "Para celebrar em casa: salgados, doces e mini bolos prontos a partilhar.", price: "45000.00" },
      { name: "Kit Aniversário School", description: "Pensado para levar à escola: porções individuais para toda a turma.", price: "35000.00" },
    ],
  },
  {
    category: "Doces e brigadeiros",
    description: "Doces finos para mesas de festa.",
    products: [
      { name: "Brigadeiros simples", description: "Brigadeiro tradicional de chocolate. Preço por unidade.", price: "300.00" },
      { name: "Brigadeiros personalizados", description: "Cores e decoração à medida da festa. Preço sob consulta, por encomenda.", price: null },
      { name: "Cupcakes", description: "Cupcake decorado com cobertura de creme.", price: "1200.00" },
      { name: "Canudinhos com recheio", description: "Canudinhos estaladiços com recheio à escolha.", price: "350.00" },
    ],
  },
  {
    category: "Mini bolos e tartes",
    description: "Porções individuais de pastelaria.",
    products: [
      { name: "Mini bolo Chantilly", description: "Bolo individual com chantilly.", price: "1500.00" },
      { name: "Mini tartelete de fruta", description: "Massa areada, creme pasteleiro e fruta da época.", price: "1300.00" },
      { name: "Mini bolo de ginguba", description: "Bolo individual de ginguba.", price: "1200.00" },
    ],
  },
  {
    category: "Salgados",
    description: "Salgados para lanches e festas.",
    products: [
      { name: "Mini cachorro-quente", description: "Pão macio e salsicha. Preço por unidade.", price: "600.00" },
      { name: "Mini pizza", description: "Massa fina com fiambre e queijo. Preço por unidade.", price: "700.00" },
      { name: "Mini hambúrguer", description: "Pão de brioche e hambúrguer de vaca. Preço por unidade.", price: "900.00" },
      { name: "Salgados diversos", description: "Sortido de salgados fritos e assados. Preço por unidade.", price: "250.00" },
    ],
  },
];

async function seedCatalog(fixtures: ManualValidationFixtures, ownerToken: string, organizationId: string) {
  const api = http(`${API}/organizations/${organizationId}`, ownerToken);
  const existing = await api("GET", "/products?pageSize=1&status=ACTIVE");
  if ((existing.pagination?.total ?? 0) > 0) {
    console.log(`Catalog already has ${existing.pagination!.total} active products — not seeding again.`);
    return;
  }
  await api("PUT", "/settings", { timezone: TZ });
  let products = 0;
  for (const group of CATALOG) {
    const { data: category } = await api("POST", "/categories", { name: group.category, description: group.description });
    for (const p of group.products) {
      await api("POST", "/products", { name: p.name, description: p.description, categoryId: category.id, unit: "UNIT", ...(p.price ? { price: p.price } : {}) });
      products++;
    }
  }
  console.log(`Seeded ${CATALOG.length} categories and ${products} products (demo data, illustrative prices).`);
}

const fixtures = loadManualValidationFixtures();
const owner = fixtures.organizations.PRODUCT_REFERENCE.users.OWNER;
const ownerToken = await signIn(fixtures, owner.email, owner.password);
const demo = await ensureOrganization(fixtures, ownerToken);
await provisionCredential(demo);
await seedCatalog(fixtures, ownerToken, demo.organizations.DEMO_O_PARTIR_DO_PAO.id);
