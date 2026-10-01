# Na Pista — Manual validation guide (F29)

How to run the Na Pista Console locally against real services, with real
users for every role, and what to check. Nothing here uses mocked data:
every screen reads the real Na Pista API and the real UL Platform API.

> **Secrets.** The fixture file holds real passwords and credential secrets.
> It lives in `na-pista/.fixtures/` (git-ignored) and must never be committed,
> pasted into tickets/chat, or screenshotted. Ids are never fixed — every
> provisioning run creates new organizations, users and credentials.

---

## 1. What you get

| Organization | Profile | Data seeded (through the public API) |
|---|---|---|
| `MV_PRODUCT_REFERENCE_<run>` | retail / catalog | timezone Africa/Luanda; 3 categories; 8 products (one without price, one archived); stock receipts and adjustments, one product at zero; 4 customers (one archived); 4 orders — DRAFT, CONFIRMED, COMPLETED, CANCELED |
| `MV_SERVICE_REFERENCE_<run>` | services / appointments | timezone Africa/Luanda; 5 services (one without price, one archived); 3 professionals with weekly schedules and service associations; one full-day exception; 3 customers; ~8 appointments from today onwards (one canceled) |

Each organization has four real Supabase Auth users (email pre-confirmed):
**OWNER, ADMIN, MANAGER, STAFF**, an active `NA_PISTA/BUSINESS`
subscription, a *platform-facing* credential (`usage.write`,
`event.publish` — what Na Pista itself uses) and an *integration* credential
(`catalog.read`, `catalog.write`).

## 2. Prerequisites

- Node 20+, dependencies installed in `ul-platform`, `na-pista`, `na-pista-console`.
- `ul-platform/.env` — `DATABASE_URL`, `SUPABASE_URL`, `SUPABASE_ANON_KEY`,
  `SUPABASE_SERVICE_ROLE_KEY` (used only by the provisioning/teardown scripts,
  server-side), `SUPABASE_JWT_SECRET`, `WEBHOOK_SECRET_ENCRYPTION_KEY`.
- `ul-platform/.env` → `PLATFORM_ALLOWED_ORIGINS` **must include
  `http://localhost:3010`** (the Console calls the Platform directly from
  the browser for identity, organization, team, credentials, webhooks,
  environments and usage). Without it the browser blocks every Platform call
  (CORS) and the Console cannot load your organizations.
- `na-pista/.env` — `NA_PISTA_DATABASE_URL`, `PLATFORM_API_URL=http://127.0.0.1:4000/v1`,
  `PORT=4200`, `NA_PISTA_ALLOWED_ORIGINS=http://localhost:3010`.
- `na-pista-console/.env.local` — `NEXT_PUBLIC_SUPABASE_URL`,
  `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `NEXT_PUBLIC_NA_PISTA_API_URL=http://127.0.0.1:4200/v1`,
  `NEXT_PUBLIC_PLATFORM_API_URL=http://127.0.0.1:4000/v1`. Never put a
  service-role key in the Console environment.

## 3. Local topology

```text
Browser (http://localhost:3010, Na Pista Console)
  ├── Supabase Auth (sign-in, session)
  ├── UL Platform API  http://127.0.0.1:4000/v1   (identity, org, team, credentials, webhooks, environments, usage)
  └── Na Pista API     http://127.0.0.1:4200/v1   (catalog, customers, inventory, orders, services, professionals, scheduling, appointments)
                         └── UL Platform API (entitlements, usage, audit context) with the org's platform-facing credential
```

**Platform credentials (F29A — gap G1 closed).** Each organization's
platform-facing credential is persisted, encrypted, in Na Pista's own
database. After provisioning the fixtures (§4), store their credentials once:

```bash
cd na-pista && npm run credentials:provision   # introspected by the Platform, encrypted, audited; idempotent
```

A plain `npm run dev` then serves those organizations — and keeps serving them
across restarts. Requires `NA_PISTA_CREDENTIAL_ENCRYPTION_KEY` in `na-pista/.env`
(see `.env.example`). `npm run mv:server` (in-memory registration) still works
but is no longer needed. See `docs/f29a-report.md`.

## 4. Provision (UL Platform)

```bash
cd ul-platform
npm run dev            # terminal 1 — Platform on :4000
npm run mv:provision   # terminal 2
```

Creates the users (Supabase Admin API), signs each one in with its password
(the same token the Console gets), creates both organizations, memberships,
subscriptions and credentials through the Platform's own API, and writes
`na-pista/.fixtures/manual-validation.json`. Only organization ids are
printed; no secret reaches stdout.

## 5. Start Na Pista and the Console

```bash
cd na-pista && npm run credentials:provision   # once per provisioning run (F29A)
cd na-pista && npm run dev                 # terminal 3 — Na Pista on :4200 (mv:server no longer required)
cd na-pista-console && npm run dev         # terminal 4 — Console on :3010
```

## 6. Seed realistic data

```bash
cd na-pista && npm run mv:seed
```

Everything goes through the public HTTP API as each organization's OWNER
(real validation, authorization, audit rows and usage). Appointment times are
taken from the server's own bookable slots — never computed by the script.
Run it once per provisioning (a second run adds duplicates, it does not fail
silently on conflicts).

## 7. Accounts

Open `na-pista/.fixtures/manual-validation.json` locally:

```text
organizations.PRODUCT_REFERENCE.users.OWNER.email / .password
organizations.PRODUCT_REFERENCE.users.ADMIN ...
organizations.SERVICE_REFERENCE.users.STAFF ...
organizations.<ref>.credentials.integration.secret   ← for API calls (ulk_<id>.<secret>)
```

Emails follow `mv-<product|service>-<role>-<run>@test.ul-platform.invalid`
(a reserved, undeliverable domain — no email is ever sent).
Sign in at `http://localhost:3010/login`.

## 8. Validation matrix — roles

Na Pista permissions are enforced by the Na Pista API; Platform permissions
by the Platform API. The Console only mirrors them for UX. For every "no",
also confirm the control is **absent** (not just failing).

| Capability | OWNER | ADMIN | MANAGER | STAFF |
|---|---|---|---|---|
| Overview, lists and details of every module | yes | yes | yes | yes |
| Create/edit products, categories, customers, services, professionals | yes | yes | yes | no |
| Archive products, categories, customers (`*.delete`) | yes | yes | no ¹ | no |
| Archive/reactivate services, professionals (`*.update`) | yes | yes | yes | no |
| Stock receipt / adjustments | yes | yes | yes | no |
| Create / confirm / complete / cancel orders | yes | yes | yes | no |
| Schedules, exceptions | yes | yes | yes | no |
| Create / reschedule / cancel / complete / no-show appointments | yes | yes | yes | no (read-only) |
| Organization timezone (`scheduling.update`) | yes | yes | yes | no |
| Organization name (Platform) | yes | yes | no | no |
| Team: change role, suspend, remove (Platform) | yes | yes | no (read) | no (read) |
| Credentials: list | yes | yes | no | no |
| Credentials: create / revoke | yes | no | no | no |
| Webhooks: list | yes | yes | no | no |
| Webhooks: create / test / revoke | yes | no | no | no |
| API usage meter (Integrations › API) | yes | yes | yes | no |

¹ The Console hides "Arquivar" for MANAGER (it mirrors `DELETE`, which needs
`*.delete`). Note that ADR-020 lets `PATCH {status}` change status with
`*.update`, so the API itself does not stop a MANAGER from archiving that way
— recorded in `docs/f29-report.md` as an observation, not changed in F29.

Cross-tenant: sign in as a PRODUCT_REFERENCE user, then paste a
SERVICE_REFERENCE URL (`/o/<service-org-id>/...`) → "no access" screen, no
data. Replace an id in a detail URL with an id from the other organization →
"não encontrado".

## 9. Validation scenarios

**Shell & navigation.** Sidebar groups; active item; org switcher (a user in
one org sees one entry); Ctrl/⌘+K finds pages and create actions (STAFF has
no create actions); mobile width (≤ 768 px) → drawer; environment chip
"Local"; user menu shows the email and signs out.

**Overview.** PRODUCT_REFERENCE: open orders = 2, zero-stock = 1 (Lixívia),
customers = 3, recent orders list. SERVICE_REFERENCE: today's appointments
(if the schedule allowed a booking today), no orders.

**Catalog & operation.** Create → appears in list; edit → detail updates;
archive asks for confirmation and the item leaves the default "Activos"
filter; reactivate. Product without a price cannot be added to an order.
Money shows as `1 850,50 Kz`.

**Inventory.** Receipt with a decimal quantity (e.g. `2.5` kg) → balance and
movement history update; `ADJUSTMENT_OUT` larger than the balance → clear
"Stock insuficiente" message; zero-stock filter.

**Orders.** DRAFT: change customer, add/remove items, change quantity;
Confirm (dialog explains stock consumption) → stock decreases; Cancel a
CONFIRMED order → stock restored; COMPLETED/CANCELED are read-only.

**Scheduling & appointments.** Hub lists professionals with links to
schedule / exceptions / availability. New appointment: only server-offered
slots; double-book the same slot in two tabs → second gets "acabou de ser
ocupado"; reschedule; cancel with reason; complete/no-show are only offered
after the start time (too early → explained, not generic).

**Errors.** Stop `mv:server` → pages show "Não foi possível contactar o
servidor" with no stack trace; restart and reload. Sign out in another tab →
next API call redirects to `/login?expired=1` with the "Sessão expirada"
banner.

## 10. Integration Center checks

- **API**: base URLs, organization id (copy), auth model, curl example with
  `$NA_PISTA_KEY` placeholder (never a real secret), module → scope table,
  usage meter for OWNER/ADMIN/MANAGER.
- **Credentials** (OWNER): create with `catalog.read` only → the secret is
  shown **once** with "Este segredo só será mostrado uma vez"; copy it; close
  → it is gone (reload, reopen: never shown again; the list shows
  `ulk_<prefix>…` only). Call the API with it:

  ```bash
  curl -H "Authorization: Bearer $NA_PISTA_KEY" \
    "http://127.0.0.1:4200/v1/organizations/<org-id>/products?limit=5"
  ```

  GET works; a POST returns 403 (no `catalog.write`). Revoke (confirm
  dialog) → the same curl returns 401. Revoking the *platform-facing*
  credential breaks the organization's access to Na Pista (the dialog warns);
  do not do it unless testing that — re-provision afterwards.
- **Environments**: production/staging as declared by the Platform, read-only.
- **Webhooks** (OWNER): banner that Na Pista does not publish events yet;
  create (HTTPS URL; secret shown once); "Testar" returns the real delivery
  result (a URL that does not exist → failed, with status); revoke.
- **Documentation**: every module, filter "no-show", curl examples.

## 11. Teardown

```bash
cd na-pista && npm run mv:teardown       # Na Pista rows for the fixture orgs + deletes the fixture file
cd ul-platform && npm run mv:teardown    # Platform orgs/users/credentials + Supabase Auth users (mv-*@test.ul-platform.invalid)
```

Run Na Pista's first (it needs the fixture file for the organization ids).
Platform teardown matches only `MV_*_REFERENCE_*` organizations and
`mv-*@test.ul-platform.invalid` users, so it cannot touch real tenants.
