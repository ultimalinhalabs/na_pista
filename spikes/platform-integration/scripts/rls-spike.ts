import "dotenv/config";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { env } from "../src/config/env.js";

/**
 * OD-16 technical spike — standalone, not part of the app or the E2E
 * suite. Answers the questions F19 §17 actually asks, empirically,
 * against the REAL connection this project uses (the Supabase Supavisor
 * pooler in transaction mode — see docs/decisions.md ADR-015 for why
 * that's the connection under test).
 *
 * Run: npm run rls:spike   (idempotent; cleans up its own throwaway table)
 */

interface Result {
  question: string;
  answer: string;
  evidence: string;
}
/** postgres.js rows are typed loosely under noUncheckedIndexedAccess; this is a diagnostic script, not shipped code — a plain cast is fine here. */
function row0<T = any>(rows: unknown): T {
  return (rows as any[])[0] as T;
}

const results: Result[] = [];
function record(question: string, answer: string, evidence: string) {
  results.push({ question, answer, evidence });
  console.log(`\n[${question}]\n  -> ${answer}\n  evidence: ${evidence}`);
}

async function main() {
  const schema = `${env.NA_PISTA_DB_SCHEMA}_rls_spike`;
  // A small, dedicated pool (mirrors the app's own pool size) — the whole
  // point is to prove/disprove leakage ACROSS pooled connections.
  const sql = postgres(env.NA_PISTA_DATABASE_URL, { max: 5, connect_timeout: 5 });

  try {
    await sql.unsafe(`drop schema if exists ${schema} cascade`);
    await sql.unsafe(`create schema ${schema}`);
    await sql.unsafe(`
      create table ${schema}.rls_probe (
        id uuid primary key default gen_random_uuid(),
        organization_id uuid not null,
        value text not null
      )
    `);

    const orgX = "11111111-1111-1111-1111-111111111111";
    const orgY = "22222222-2222-2222-2222-222222222222";
    await sql.unsafe(`insert into ${schema}.rls_probe (organization_id, value) values ('${orgX}', 'x-row'), ('${orgY}', 'y-row')`);

    // Q1: does this connection's ROLE bypass RLS outright (owner/superuser)?
    const roleInfo = row0<{ rolsuper: boolean; rolbypassrls: boolean }>(
      await sql`select rolsuper, rolbypassrls from pg_roles where rolname = current_user`,
    );
    const { rolsuper, rolbypassrls } = roleInfo;
    const ownerRow = row0<{ owner: string }>(
      await sql.unsafe(`select pg_get_userbyid(relowner) as owner from pg_class where oid = '${schema}.rls_probe'::regclass`),
    );
    const currentUserRow = row0<{ current_user: string }>(await sql`select current_user`);
    const isOwner = ownerRow.owner === currentUserRow.current_user;
    record(
      "1. RLS é compatível com este utilizador de ligação?",
      rolsuper
        ? "NÃO por si só — este role É superuser, que ignora RLS SEMPRE, mesmo com policies e mesmo com FORCE ROW LEVEL SECURITY. RLS não pode proteger nada nesta ligação sem trocar de role."
        : rolbypassrls
          ? "NÃO por si só — este role tem BYPASSRLS."
          : isOwner
            ? "Parcialmente — este role é o DONO da tabela; o dono ignora RLS por omissão A MENOS QUE a tabela use FORCE ROW LEVEL SECURITY (testado a seguir)."
            : "Sim — não é superuser, não tem BYPASSRLS, não é o dono.",
      `pg_roles: rolsuper=${rolsuper} rolbypassrls=${rolbypassrls}; is table owner=${isOwner}`,
    );

    // Enable RLS + a real policy keyed off a per-transaction GUC.
    await sql.unsafe(`alter table ${schema}.rls_probe enable row level security`);
    await sql.unsafe(`
      create policy tenant_isolation on ${schema}.rls_probe
      using (organization_id = current_setting('app.organization_id', true)::uuid)
    `);

    // Q2 (without FORCE): does the owner/current connection still see everything?
    const withoutForceCount = row0<{ c: number }>(await sql.unsafe(`select count(*)::int as c from ${schema}.rls_probe`)).c;
    record(
      "2. Sem FORCE ROW LEVEL SECURITY, o dono da tabela vê tudo mesmo com a policy activa?",
      withoutForceCount === 2 ? "SIM — confirma que ENABLE sozinho não protege o dono/superuser desta ligação." : "NÃO (inesperado)",
      `rows visible without app.organization_id set, without FORCE: ${withoutForceCount}`,
    );

    await sql.unsafe(`alter table ${schema}.rls_probe force row level security`);
    const withForceNoGucCount = row0<{ c: number }>(await sql.unsafe(`select count(*)::int as c from ${schema}.rls_probe`)).c;
    record(
      "2b. Com FORCE ROW LEVEL SECURITY, e sem GUC definido, quantas linhas são visíveis?",
      rolsuper
        ? `${withForceNoGucCount} — FORCE não afecta superuser; continua a ver tudo.`
        : `${withForceNoGucCount} — esperado 0 (current_setting com missing_ok=true devolve NULL, NULL::uuid não iguala nada).`,
      `rows visible with FORCE, no app.organization_id set: ${withForceNoGucCount}`,
    );

    // Q3/Q4: does SET LOCAL inside a transaction correctly scope visibility, and never leak to the next transaction on a REUSED pooled connection?
    async function readAs(orgId: string): Promise<number> {
      return sql.begin(async (tx) => {
        await tx.unsafe(`set local app.organization_id = '${orgId}'`);
        const rows = await tx.unsafe(`select count(*)::int as c from ${schema}.rls_probe`);
        return row0<{ c: number }>(rows).c;
      });
    }
    const asX = await readAs(orgX);
    const asY = await readAs(orgY);
    record(
      "3. SET LOCAL dentro de uma transacção isola correctamente por organização?",
      asX === 1 && asY === 1 ? "SIM — cada transacção só vê a sua própria linha." : `FALHOU (asX=${asX}, asY=${asY})`,
      `readAs(orgX)=${asX} (esperado 1), readAs(orgY)=${asY} (esperado 1)`,
    );

    // Stress test: hammer with rapid, interleaved, alternating-tenant
    // transactions on a SMALL pool (max:5) to try to force connection
    // reuse across different tenants and detect any leakage.
    const N = 200;
    const orgs = [orgX, orgY];
    const outcomes = await Promise.all(
      Array.from({ length: N }, (_, i) => orgs[i % 2]!).map(async (orgId, i) => {
        const c = await readAs(orgId);
        return { i, orgId, c, ok: c === 1 };
      }),
    );
    const leaks = outcomes.filter((o) => !o.ok);
    record(
      "4. Sob concorrência real (pool max=5, 200 transacções alternadas, mesmas ligações físicas reutilizadas), há alguma fuga entre tenants?",
      leaks.length === 0 ? `NÃO — 0/${N} transacções viram dados incorrectos, mesmo com ligações reutilizadas.` : `SIM — ${leaks.length}/${N} fugas detectadas.`,
      leaks.length === 0
        ? `SET LOCAL é escopado à transacção pelo próprio Postgres, independentemente de pooling — a ligação física é irrelevante para este mecanismo.`
        : JSON.stringify(leaks.slice(0, 5)),
    );

    // Q5/Q6: migrations / admin connections. A migration connection typically runs DDL and doesn't set the GUC at all — with FORCE RLS, would it be blocked from seeing rows it needs to alter/backfill?
    const migrationLikeSelect = await sql.begin(async (tx) => {
      // no SET LOCAL at all — simulates a migration/backfill script that forgot, or a background job.
      const rows = await tx.unsafe(`select count(*)::int as c from ${schema}.rls_probe`);
      return row0<{ c: number }>(rows).c;
    });
    record(
      "5/6. Uma ligação de migração/admin que NÃO define o GUC (esquecimento, ou script de fundo) o que vê?",
      rolsuper
        ? `${migrationLikeSelect} linhas — como esta ligação é superuser, migrations funcionam sem qualquer alteração; RLS é invisível para elas.`
        : `${migrationLikeSelect} linhas — com FORCE e sem GUC, uma migration nesta mesma role veria 0 linhas; precisaria de BYPASSRLS explícito OU de correr como o dono sem FORCE OU de um role de migração dedicado.`,
      `rows visible to a GUC-less transaction: ${migrationLikeSelect}`,
    );

    // Q1 follow-up: the connection role has BYPASSRLS — does RLS actually
    // WORK once a dedicated, non-bypassing role is used instead? A
    // throwaway login role, granted nothing but DML on this one table,
    // created and dropped entirely within this run.
    const roleName = `na_pista_rls_spike_${Date.now().toString(36)}`;
    const rolePassword = randomUUID().replace(/-/g, "");
    let lowPrivResult: { asX: number; asY: number; ok: boolean } | null = null;
    try {
      await sql.unsafe(`create role ${roleName} login password '${rolePassword}' nosuperuser nobypassrls`);
      await sql.unsafe(`grant usage on schema ${schema} to ${roleName}`);
      await sql.unsafe(`grant select, insert on ${schema}.rls_probe to ${roleName}`);

      // Supabase's Supavisor pooler is multi-tenant: it routes purely by
      // parsing the username as `<role>.<project-ref>` (no SNI/other
      // identifier available over a plain TCP connection string) — a
      // bare role name is rejected with ENOIDENTIFIER, confirmed
      // empirically. The project ref is not a secret (it's the public
      // subdomain in SUPABASE_URL/the pooler hostname) but is never
      // printed here regardless — derived programmatically only.
      const originalUser = new URL(env.NA_PISTA_DATABASE_URL).username;
      const projectRef = originalUser.includes(".") ? originalUser.split(".").slice(1).join(".") : undefined;
      const url = new URL(env.NA_PISTA_DATABASE_URL);
      url.username = projectRef ? `${roleName}.${projectRef}` : roleName;
      url.password = rolePassword;
      const lowPrivSql = postgres(url.toString(), { max: 2, connect_timeout: 5 });
      try {
        async function readAsLowPriv(orgId: string): Promise<number> {
          return lowPrivSql.begin(async (tx) => {
            await tx.unsafe(`set local app.organization_id = '${orgId}'`);
            const rows = await tx.unsafe(`select count(*)::int as c from ${schema}.rls_probe`);
            return row0<{ c: number }>(rows).c;
          });
        }
        const lpX = await readAsLowPriv(orgX);
        const lpY = await readAsLowPriv(orgY);
        lowPrivResult = { asX: lpX, asY: lpY, ok: lpX === 1 && lpY === 1 };
      } finally {
        await lowPrivSql.end();
      }

      record(
        "1b. Com um role dedicado SEM BYPASSRLS e sem ser dono da tabela, a mesma policy isola correctamente?",
        lowPrivResult.ok
          ? "SIM — confirmado: RLS funciona correctamente, DESDE QUE a ligação da aplicação use um role dedicado, sem BYPASSRLS e sem ownership da tabela. O bloqueio de hoje é exclusivamente o role de ligação disponível (o utilizador do pooler Supabase, que tem BYPASSRLS por definição), não uma limitação do mecanismo em si."
          : `FALHOU mesmo com role dedicado (asX=${lowPrivResult.asX}, asY=${lowPrivResult.asY}) — reavaliar antes de considerar RLS viável.`,
        `low-priv role readAs(orgX)=${lowPrivResult.asX}, readAs(orgY)=${lowPrivResult.asY}`,
      );
    } catch (error) {
      record(
        "1b. Com um role dedicado SEM BYPASSRLS e sem ser dono da tabela, a mesma policy isola correctamente?",
        "NÃO TESTÁVEL neste ambiente — falha ao ligar com o role dedicado através do pooler (ver evidência). Não confirma nem refuta o mecanismo RLS em si; confirma apenas que este pooler multi-tenant precisa de acomodação específica para um role novo.",
        `connection error: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      await sql.unsafe(`revoke all on ${schema}.rls_probe from ${roleName}`).catch(() => {});
      await sql.unsafe(`revoke usage on schema ${schema} from ${roleName}`).catch(() => {});
      await sql.unsafe(`drop role if exists ${roleName}`).catch(() => {});
    }

    console.log("\n=== SUMÁRIO ===");
    for (const r of results) console.log(`- ${r.question}\n  ${r.answer}`);
  } finally {
    await sql.unsafe(`drop schema if exists ${schema} cascade`);
    await sql.end();
  }
}

main().catch((error) => {
  console.error("rls-spike failed:", error instanceof Error ? error.message : error);
  process.exit(1);
});
