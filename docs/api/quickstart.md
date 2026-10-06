# Quickstart — integrating your own interface with Na Pista

You will make your first authenticated call, read and write data, handle errors and pages, and see the shape of two
complete custom integrations. Everything here uses the public contract only ([openapi.json](openapi.json)).

> Placeholders: `https://api.na-pista.example` stands for your Na Pista API host, `{ORG}` for your organization id,
> `<USER_TOKEN>` for a signed-in user's access token, `ulk_EXAMPLE_ONLY` for an integration key. None of them are
> real values.

## 1. Base URL

```
https://api.na-pista.example/v1
```

All routes are versioned under `/v1`. The contract itself is public: `GET /v1/openapi.json` (no token needed) — load it
into any OpenAPI tool to browse or generate a client.

## 2. Authentication

Pick the caller ([authentication.md](authentication.md)):

- **Your staff, in your interface** → the user's own access token (they sign in with their UL account; you never see
  their password). Their role decides what they can do.
- **Your server** → an integration key (`ulk_…`, scopes `catalog.read`/`catalog.write`), created by an organization
  OWNER. Keep it on the server only.

```
Authorization: Bearer <USER_TOKEN>        # or: Bearer ulk_EXAMPLE_ONLY (server-side only)
```

## 3. Organization context

Every business route is scoped to one organization: `/v1/organizations/{ORG}/…`. The caller must belong to it (user)
or the key must have been issued for it. Your interface should let the user choose among the organizations they
belong to (from the UL Platform's `GET /v1/me`) and then use that id in every Na Pista path.

## 4. First authenticated request

```bash
curl -s https://api.na-pista.example/v1/organizations/{ORG}/products?pageSize=5 \
  -H "Authorization: Bearer <USER_TOKEN>" \
  -H "X-Request-ID: quickstart-1"
```

```json
{ "data": [ { "id": "8a2e…", "name": "Camisola Azul", "price": "9500.00", "status": "ACTIVE", "…": "…" } ],
  "pagination": { "page": 1, "pageSize": 5, "total": 1, "totalPages": 1 } }
```

`401` → bad or expired token; `403` → wrong organization, role or scope ([errors.md](errors.md)).

## 5. First read

```bash
curl -s "https://api.na-pista.example/v1/organizations/{ORG}/customers?q=ana&status=ACTIVE" \
  -H "Authorization: Bearer <USER_TOKEN>"
```

Filters are explicit per endpoint ([filtering.md](filtering.md)); an unknown parameter is a `400`, never silently
ignored.

## 6. First mutation

```bash
curl -s -X POST https://api.na-pista.example/v1/organizations/{ORG}/products \
  -H "Authorization: Bearer <USER_TOKEN>" -H "Content-Type: application/json" \
  -d '{ "name": "Camisola Azul", "price": "9500.00", "unit": "UNIT" }'
```

`201` with the created product. Money is always a **decimal string** (`"9500.00"`), never a float; the organization
currency is `AOA`. Fields you may not set (ids, status on create, totals, prices on order lines) are rejected, not
ignored.

## 7. Error handling

```js
async function naPista(path, { token, method = "GET", body } = {}) {
  const res = await fetch(`https://api.na-pista.example/v1${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json();
  if (!res.ok) {
    const err = new Error(json.error.message);
    Object.assign(err, { status: res.status, code: json.error.code, details: json.error.details, requestId: res.headers.get("x-request-id") });
    throw err; // branch on err.code — e.g. INSUFFICIENT_STOCK, APPOINTMENT_CONFLICT
  }
  return json; // { data } or { data, pagination }
}
```

Show `details` next to the offending form fields; log `requestId`; retry `503` with backoff.

## 8. Pagination

```js
const first = await naPista(`/organizations/${org}/orders?status=CONFIRMED&page=1&pageSize=50`, { token });
// first.pagination → { page, pageSize, total, totalPages }
```

See [pagination.md](pagination.md) for a full "walk every page" helper and stable traversal.

## 9. Webhooks

Na Pista publishes **no events yet** — do not build on webhooks today; read the API instead (and see
[webhooks.md](webhooks.md) for how UL Platform webhooks work and will apply once events exist).

## 10. Custom frontend architecture

```
Your interface (browser / app)            Your server (optional)
        │  user access token                     │  ulk_ integration key (server-side only)
        ▼                                        ▼
            Na Pista API  /v1/organizations/{ORG}/…   ← all business rules, validation, tenancy
                        │
                        ├─ UL Platform (identity, memberships, subscriptions) — called by Na Pista, not by you
                        └─ Na Pista data (per organization)
```

- Your interface never talks to a database and never decides permissions — it reacts to `403`s.
- Prices, totals, stock and availability are computed by the API; display what it returns.
- The Na Pista Console is built exactly this way.

---

## Example A — a shop front-office: products → customers → orders

```js
const org = "{ORG}";
const token = "<USER_TOKEN>";

// 1. Catalogue: active products, by name
const { data: products } = await naPista(`/organizations/${org}/products?status=ACTIVE&sort=name&order=asc&pageSize=100`, { token });

// 2. Find or create the customer
const found = await naPista(`/organizations/${org}/customers?q=${encodeURIComponent("ana@example.com")}`, { token });
const customer = found.data[0] ?? (await naPista(`/organizations/${org}/customers`, {
  token, method: "POST", body: { name: "Ana", email: "ana@example.com" },
})).data;

// 3. Draft order — the server fills prices, subtotals, total and currency
const { data: draft } = await naPista(`/organizations/${org}/orders`, {
  token, method: "POST", body: { customerId: customer.id, items: [{ productId: products[0].id, quantity: 2 }] },
});

// 4. Confirm — decreases stock atomically; may fail with INSUFFICIENT_STOCK
try {
  const { data: confirmed } = await naPista(`/organizations/${org}/orders/${draft.id}/confirm`, { token, method: "POST" });
  console.log(confirmed.status, confirmed.total, confirmed.currency); // CONFIRMED "19000.00" AOA
} catch (err) {
  if (err.code === "INSUFFICIENT_STOCK") console.log("Not enough stock — adjust the order");
  else throw err;
}
```

## Example B — a booking page: services → professionals → appointments

```js
const org = "{ORG}";
const token = "<USER_TOKEN>"; // staff booking on behalf of a customer

// 1. What can be booked, and by whom
const { data: services } = await naPista(`/organizations/${org}/services?status=ACTIVE&sort=name&order=asc`, { token });
const service = services[0];
const { data: pros } = await naPista(`/organizations/${org}/professionals?status=ACTIVE&serviceId=${service.id}`, { token });
const pro = pros[0];

// 2. Free start times for a date (organization-local date; the server handles time zones)
const { data: slots } = await naPista(
  `/organizations/${org}/professionals/${pro.id}/bookable-slots?date=2026-10-05&serviceId=${service.id}`, { token });

// 3. Book the first slot — end time comes from the service duration
const { data: appointment } = await naPista(`/organizations/${org}/appointments`, {
  token, method: "POST",
  body: { customerId: "{CUSTOMER_ID}", professionalId: pro.id, serviceId: service.id, startAt: slots.slots[0].startAt },
}); // 409 APPOINTMENT_CONFLICT if someone took it meanwhile → reload slots

// 4. The day's agenda
const { data: day } = await naPista(`/organizations/${org}/appointments?from=2026-10-05&to=2026-10-05&professionalId=${pro.id}`, { token });
```

Prerequisites for bookings: the organization's timezone is set (`PUT /settings`), the professional has a weekly
schedule (`PUT /professionals/{id}/schedule`) and provides the service. Otherwise you get
`409 TIMEZONE_NOT_CONFIGURED` or no slots.

Every endpoint used in both examples is exercised — with responses validated against the published schemas — by the
API's own end-to-end contract test (`tests/e2e/contract.test.ts`) against a real UL Platform and database.
