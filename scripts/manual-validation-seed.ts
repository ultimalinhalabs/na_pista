import "dotenv/config";
import { loadManualValidationFixtures, type ManualValidationFixtures } from "./manual-validation-fixtures.js";
import { assertLocalScriptTargets } from "./scriptTargetGuard.js";

/**
 * Seeds the two manual-validation organizations with realistic Na Pista data
 * through the PUBLIC HTTP API only (same validation, authorization, audit and
 * usage paths a user would hit) — never through the database.
 *
 *   PRODUCT_REFERENCE: timezone, categories, products (priced/unpriced, one
 *     archived), stock receipts (one product left at zero), customers, orders
 *     in DRAFT / CONFIRMED / COMPLETED / CANCELED.
 *   SERVICE_REFERENCE: timezone, services, professionals with weekly
 *     schedules and service associations, a day off, customers and
 *     appointments (scheduled, completed-eligible, canceled).
 *
 * Requires `npm run mv:server` running (NA_PISTA_API_URL, default
 * http://127.0.0.1:4200/v1). Run once per provisioning.
 *
 * Usage: npm run mv:seed
 */
const API = process.env.NA_PISTA_API_URL ?? `http://127.0.0.1:${process.env.PORT ?? 4200}/v1`;
const TZ = "Africa/Luanda";

// The API it calls is the local dev server, which writes to this same .env database.
assertLocalScriptTargets("mv:seed", {
  NA_PISTA_DATABASE_URL: process.env.NA_PISTA_DATABASE_URL,
  NA_PISTA_API_URL: API,
  PLATFORM_API_URL: process.env.PLATFORM_API_URL,
});

async function signIn(fixtures: ManualValidationFixtures, email: string, password: string): Promise<string> {
  const res = await fetch(new URL("/auth/v1/token?grant_type=password", fixtures.supabaseUrl), {
    method: "POST",
    headers: { apikey: fixtures.supabaseAnonKey, "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) throw new Error(`sign-in failed for ${email}: ${res.status}`);
  return ((await res.json()) as { access_token: string }).access_token;
}

function client(token: string, org: string) {
  return async function api<T = { id: string }>(method: string, path: string, body?: unknown, expected = [200, 201]): Promise<T> {
    const res = await fetch(`${API}/organizations/${org}${path}`, {
      method,
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json = (await res.json().catch(() => undefined)) as { data?: T; error?: { code?: string; message?: string } } | undefined;
    if (!expected.includes(res.status)) throw new Error(`${method} ${path} -> ${res.status} ${json?.error?.code ?? ""} ${json?.error?.message ?? ""}`);
    return json?.data as T;
  };
}

/** Local YYYY-MM-DD in the organization timezone, `offset` days from today. */
function localDate(offset: number) {
  const date = new Date(Date.now() + offset * 86_400_000);
  return new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}

async function seedProductReference(fixtures: ManualValidationFixtures) {
  const org = fixtures.organizations.PRODUCT_REFERENCE;
  const api = client(await signIn(fixtures, org.users.OWNER.email, org.users.OWNER.password), org.id);

  await api("PUT", "/settings", { timezone: TZ });
  const bebidas = await api("POST", "/categories", { name: "Bebidas" });
  const mercearia = await api("POST", "/categories", { name: "Mercearia" });
  const limpeza = await api("POST", "/categories", { name: "Limpeza" });

  const product = (name: string, categoryId: string | null, price: string | null, unit = "UNIT", description?: string) =>
    api("POST", "/products", { name, unit, ...(categoryId ? { categoryId } : {}), ...(price ? { price } : {}), ...(description ? { description } : {}) });
  const agua = await product("Água mineral 1,5 L", bebidas.id, "350.00", "UNIT", "Garrafa individual.");
  const sumo = await product("Sumo de múcua", bebidas.id, "1200.00");
  const arroz = await product("Arroz agulha", mercearia.id, "1850.50", "KG");
  const feijao = await product("Feijão manteiga", mercearia.id, "2100.00", "KG");
  const oleo = await product("Óleo alimentar", mercearia.id, "3200.00", "L");
  const lixivia = await product("Lixívia", limpeza.id, "950.00", "L");
  await product("Cabaz de Natal (preço por definir)", null, null);
  const antigo = await product("Refrigerante lata (descontinuado)", bebidas.id, "400.00");
  await api("PATCH", `/products/${antigo.id}`, { status: "ARCHIVED" });

  const receive = (productId: string, quantity: string, reason: string) => api("POST", `/inventory/${productId}/movements`, { type: "RECEIPT", quantity, reason });
  await receive(agua.id, "120", "Entrega do fornecedor");
  await receive(sumo.id, "36", "Entrega do fornecedor");
  await receive(arroz.id, "250.5", "Saco de 25 kg × 10");
  await receive(feijao.id, "80", "Entrega do fornecedor");
  await receive(oleo.id, "40", "Entrega do fornecedor");
  await api("POST", `/inventory/${agua.id}/movements`, { type: "ADJUSTMENT_OUT", quantity: "2", reason: "Garrafas danificadas" });
  // Lixívia: received then counted out to zero → shows up as "Produtos sem stock" on the Overview.
  await receive(lixivia.id, "5", "Amostra");
  await api("POST", `/inventory/${lixivia.id}/movements`, { type: "ADJUSTMENT_OUT", quantity: "5", reason: "Contagem física" });

  const customer = (name: string, email?: string, phone?: string) => api("POST", "/customers", { name, ...(email ? { email } : {}), ...(phone ? { phone } : {}) });
  const ana = await customer("Ana Tavares", "ana.tavares@example.com", "+244 923 000 111");
  const joao = await customer("João Mbala", undefined, "+244 912 000 222");
  const empresa = await customer("Restaurante Kilamba, Lda", "compras@example.com");
  const antigoCliente = await customer("Cliente arquivado");
  await api("PATCH", `/customers/${antigoCliente.id}`, { status: "ARCHIVED" });

  const order = (customerId: string | null, items: { productId: string; quantity: string }[]) => api("POST", "/orders", { ...(customerId ? { customerId } : {}), items });
  await order(ana.id, [{ productId: agua.id, quantity: "6" }, { productId: arroz.id, quantity: "2.5" }]); // DRAFT
  const confirmed = await order(empresa.id, [{ productId: oleo.id, quantity: "10" }, { productId: feijao.id, quantity: "12" }]);
  await api("POST", `/orders/${confirmed.id}/confirm`);
  const completed = await order(joao.id, [{ productId: sumo.id, quantity: "4" }]);
  await api("POST", `/orders/${completed.id}/confirm`);
  await api("POST", `/orders/${completed.id}/complete`);
  const canceled = await order(null, [{ productId: agua.id, quantity: "1" }]);
  await api("POST", `/orders/${canceled.id}/cancel`);
  console.log("PRODUCT_REFERENCE seeded: 3 categories, 8 products, 4 customers, 4 orders");
}

async function seedServiceReference(fixtures: ManualValidationFixtures) {
  const org = fixtures.organizations.SERVICE_REFERENCE;
  const api = client(await signIn(fixtures, org.users.OWNER.email, org.users.OWNER.password), org.id);

  await api("PUT", "/settings", { timezone: TZ });
  const corte = await api("POST", "/services", { name: "Corte de cabelo", durationMinutes: 30, price: "3500.00" });
  const barba = await api("POST", "/services", { name: "Barba", durationMinutes: 20, price: "2000.00" });
  const trancas = await api("POST", "/services", { name: "Tranças", durationMinutes: 120, price: "15000.00", description: "Inclui lavagem." });
  const consulta = await api("POST", "/services", { name: "Consulta de imagem", durationMinutes: 45 });
  const antigo = await api("POST", "/services", { name: "Serviço descontinuado", durationMinutes: 15, price: "500.00" });
  await api("PATCH", `/services/${antigo.id}`, { status: "ARCHIVED" });

  const weekdays = [1, 2, 3, 4, 5].flatMap((dayOfWeek) => [
    { dayOfWeek, startLocalTime: "08:00", endLocalTime: "12:30" },
    { dayOfWeek, startLocalTime: "14:00", endLocalTime: "18:00" },
  ]);
  const saturday = [{ dayOfWeek: 6, startLocalTime: "09:00", endLocalTime: "13:00" }];

  const professional = async (name: string, services: string[], rules: unknown[]) => {
    const p = await api("POST", "/professionals", { name });
    for (const serviceId of services) await api("POST", `/professionals/${p.id}/services/${serviceId}`);
    await api("PUT", `/professionals/${p.id}/schedule`, { rules });
    return p;
  };
  const rui = await professional("Rui Kiala", [corte.id, barba.id], [...weekdays, ...saturday]);
  const marta = await professional("Marta Neto", [trancas.id, corte.id], weekdays);
  await professional("Paulo Lemos", [consulta.id], weekdays.filter((r) => r.dayOfWeek <= 3));
  await api("POST", `/professionals/${marta.id}/schedule/exceptions`, { date: localDate(3) }); // fully unavailable that day

  const customer = (name: string, phone: string) => api("POST", "/customers", { name, phone });
  const clientes = [await customer("Helena Sousa", "+244 923 100 001"), await customer("Carlos Dala", "+244 923 100 002"), await customer("Beatriz Lopes", "+244 923 100 003")];

  // Book slots the server offers (never computed here): per professional/service, the first two days
  // (starting TODAY, so the Overview has "Marcações hoje" when the schedule still allows it) that have a free slot.
  let booked = 0;
  for (const [professionalId, serviceId] of [[rui.id, corte.id], [rui.id, barba.id], [marta.id, trancas.id], [marta.id, corte.id]] as const) {
    let perPair = 0;
    for (let offset = 0; offset <= 14 && perPair < 2; offset++) {
      const { slots } = await api<{ slots: { startAt: string }[] }>("GET", `/professionals/${professionalId}/bookable-slots?date=${localDate(offset)}&serviceId=${serviceId}`);
      const slot = slots[Math.min(perPair + booked, slots.length - 1)];
      if (!slot) continue;
      const appointment = await api("POST", "/appointments", { professionalId, serviceId, customerId: clientes[booked % clientes.length]!.id, startAt: slot.startAt, ...(booked === 0 ? { notes: "Primeira visita." } : {}) });
      if (booked === 3) await api("POST", `/appointments/${appointment.id}/cancel`, { reason: "Cliente pediu para remarcar" });
      booked++;
      perPair++;
    }
  }
  console.log(`SERVICE_REFERENCE seeded: 5 services, 3 professionals, 3 customers, ${booked} appointments`);
}

const fixtures = loadManualValidationFixtures();
await seedProductReference(fixtures);
await seedServiceReference(fixtures);
