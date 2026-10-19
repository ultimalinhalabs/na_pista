# Proposta de alojamento de produção — Na Pista (API e Console)

> 16/10/2026 — **proposta para decisão, nada foi criado.** Não foram criados recursos pagos nem alteradas
> configurações de produção. Segue o padrão que a UL Platform já usa em produção: API HTTP na Vercel e um
> worker persistente na Railway.

> **Decisões do dono (16/10/2026):**
> - **Base de dados: manter a mesma** (opção B, `jpwoyo…`), sem limpeza destrutiva;
> - **Domínios temporários:** `napista.ultimalinha.ao` (Console) e `api-napista.ultimalinha.ao` (API);
> - **Código de alojamento implementado** em `feature/production-hosting`: `api/index.js`, `vercel.json`,
>   `src/worker.ts`, `railway.json`, `prepare: false` e `engines` 24.x.

## 0. Decisão de 2026-10-18 — sem worker 24/7 (substitui a parte Railway abaixo)

O dono não quer um serviço a gerar custos 24 horas por dia sem utilização. O worker da Railway **foi retirado**
(`railway.json` apagado). O provisionamento da credencial gerida passa a correr **a pedido**, dentro da própria
API na Vercel (funções que só custam enquanto respondem):

1. **Primeiro pedido:** quando uma organização acabada de ativar abre a Na Pista e ainda não tem credencial,
   o `resolver.ts` corre um ciclo do reconciliador (`reconcileOnDemand`), partilhado por pedidos simultâneos e
   limitado a um ciclo por 15 s por instância. A credencial fica ativa nesse mesmo pedido.
2. **Rede de segurança diária:** a Vercel Cron chama `GET /v1/internal/cron/reconcile-provisioning` uma vez por
   dia (05:00 UTC; o plano Hobby só permite cron diário) com `Authorization: Bearer <CRON_SECRET>`. Sem o segredo, a
   rota responde 404.

Variáveis no projeto Vercel `na-pista` (todas sensíveis): `NA_PISTA_PROVISIONING_CREDENTIAL` (PROVISIONER,
scope `credential.provision`, emitida na UL Console) e `CRON_SECRET` (aleatório, ≥ 16 caracteres). As variáveis
`NA_PISTA_RECONCILE_INTERVAL_MS` e o serviço Railway deixam de ser necessários. `npm run start:worker` mantém-se
apenas para ensaios locais.

## 1. Situação atual (verificada)

- A Na Pista **não tem destino de produção**: não há projeto Vercel nem configuração Railway. O README diz
  "Runtime de produção (preparação — ainda sem deploy)".
- O runtime está preparado (`2c3d7b0`):
  - `npm start` arranca `dist/src/server.js`;
  - `GET /v1/health/ready` faz uma leitura `select 1`;
  - em produção o CORS é obrigatório e exato;
  - fora de produção só aceita uma base de dados local.
- Tarefa em segundo plano: o **reconciliador D2-B** (`startProvisioningReconciler`). Corre dentro do processo
  HTTP com `setInterval` e vai buscar à UL Platform a credencial gerida de cada organização ativada. **Numa
  função Vercel não corre de forma fiável** (não há processo contínuo).
- A Na Pista **não envia emails**: convites, renovação e comprovativos são da UL Platform.
- A única base de dados Na Pista existente (Supabase `jpwoyo…`) serve **desenvolvimento e "produção"**. Tem
  dados de demonstração e as 273 linhas sintéticas do incidente de 06/10. As migrações estão aplicadas até
  0010; a `0011_managed_credential_pending` está por aplicar.

## 2. Arquitetura proposta

```text
                 ┌──────────────── Vercel (equipa ultima-linha) ────────────────┐
Browser ───────► │ na-pista-console (Next.js)   napista.ultimalinha.ao           │
                 │ na-pista (API, função Node)  api-napista.ultimalinha.ao  ─────┼──► UL Platform API (api.ultimalinha.ao)
                 └───────────────────────────────────────────────────────────────┘
                 ┌──────── Railway ────────┐
                 │ na-pista-worker         │  reconciliador D2-B (processo contínuo) ──► UL Platform API
                 └─────────────────────────┘
                 ┌──────── Supabase ───────┐
                 │ BD Na Pista (produção)  │  ◄── API e worker (nunca a BD da UL Platform)
                 └─────────────────────────┘
```

| Componente | Onde | Como |
|---|---|---|
| API Na Pista | Vercel, projeto `na-pista`, Node 24.x | Como a UL Platform: `api/index.js` exporta a app Express compilada, `vercel.json` encaminha tudo para `/api`, `npm run build`. **Alteração de código necessária:** separar o arranque do reconciliador do `server.ts` |
| Worker | Railway, serviço `na-pista-worker` no projeto UL | Novo `src/worker.ts`, que só corre `startProvisioningReconciler()`, com encerramento gracioso. `railway.json`: build `npm run build`, start `node dist/src/worker.js`, restart `ON_FAILURE` |
| Console Na Pista | Vercel, projeto `na-pista-console` (Next.js) | Previews **sem** variáveis de produção, como na `ul-console` |
| Base de dados | Supabase, **projeto novo e dedicado** (recomendado) | Ver §3 |

**Alternativa sem worker:** uma Vercel Cron a chamar um endpoint interno protegido que corre
`reconcileOnce`. No plano Hobby as crons correm no máximo uma vez por dia, o que atrasaria até 24 h o acesso
de um cliente acabado de ativar. Por isso a recomendação é o worker na Railway, que já é usado pela UL
Platform (atenção: está em trial).

## 3. Base de dados — decisão necessária

| Opção | Prós | Contras |
|---|---|---|
| **A. Projeto Supabase novo `na-pista-prod` (recomendado)** | Produção limpa, sem demo nem dados sintéticos; separa claramente dev e prod; segredos novos | Custo: o plano gratuito tem limite de projetos ativos por organização; um terceiro projeto pode exigir Pro ou outra organização. **Criar = recurso possivelmente pago → autorização** |
| B. Reutilizar `jpwoyo…` depois de limpo | Sem custo novo | Tem histórico de demo e testes; exige limpeza destrutiva (autorização explícita); dev e prod continuariam misturados |

Em qualquer das opções:
- schema `na_pista` e migrações com a receita segura (dry-run do conjunto pendente);
- utilizador de base de dados com privilégios mínimos para o runtime;
- pooler em modo transação para a função Vercel (`prepare:false`) e em modo sessão para o worker.

## 4. Domínios (DNS na AngoWeb)

- `api-napista.ultimalinha.ao` → CNAME para o alvo que a Vercel indicar (projeto `na-pista`).
- `napista.ultimalinha.ao` → CNAME para a Vercel (projeto `na-pista-console`).
- Alternativa: um domínio próprio `napista.ao`, se existir. Decisão do dono.
- Supabase Auth: acrescentar `https://napista.ultimalinha.ao` à allow-list de redirects. É a mesma identidade
  do ecossistema.
- UL Platform: acrescentar a origem da Console a `PLATFORM_ALLOWED_ORIGINS`. A Console da Na Pista chama
  diretamente a API UL (equipa e convites).
- UL Client: `NEXT_PUBLIC_NA_PISTA_CONSOLE_URL=https://napista.ultimalinha.ao` (botão "Abrir Na Pista").

## 5. Variáveis de ambiente (só nomes; os valores nunca vão para o código, a documentação ou o chat)

**API (Vercel, Production):**
- `NODE_ENV=production`;
- `PLATFORM_API_URL=https://api.ultimalinha.ao/v1`;
- `NA_PISTA_DATABASE_URL` (segredo);
- `NA_PISTA_DB_SCHEMA=na_pista`;
- `NA_PISTA_CREDENTIAL_ENCRYPTION_KEY` (segredo **exclusivo de produção**, 32 bytes em base64, criado no deployment);
- `NA_PISTA_ALLOWED_ORIGINS=https://napista.ultimalinha.ao`;
- `NA_PISTA_REQUIRE_UL_APPLICATION_ACCESS=true` (recomendado para o piloto).

**Worker (Railway):**
- as mesmas `NODE_ENV`, `PLATFORM_API_URL`, `NA_PISTA_DATABASE_URL` (pooler de sessão), `NA_PISTA_DB_SCHEMA`
  e `NA_PISTA_CREDENTIAL_ENCRYPTION_KEY`;
- `NA_PISTA_PROVISIONING_CREDENTIAL` (segredo: credencial PROVISIONER emitida pela UL Platform, scope
  `credential.provision`);
- `NA_PISTA_RECONCILE_INTERVAL_MS=30000`.

**Console (Vercel):**
- `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` (públicas);
- `NEXT_PUBLIC_NA_PISTA_API_URL=https://api-napista.ultimalinha.ao/v1`;
- `NEXT_PUBLIC_PLATFORM_API_URL=https://api.ultimalinha.ao/v1`;
- `NEXT_PUBLIC_UL_CLIENT_URL=https://platform.ultimalinha.ao`.

O PROVISIONER é emitido na UL Console ou API por um PLATFORM_ADMIN e colocado **diretamente** na Railway.
Nunca passa pelo chat.

## 6. Monitorização

- `GET /v1/health` e `/v1/health/ready` (BD) para a API. Um monitor externo de uptime a cada 5 min é um
  serviço externo, por isso precisa de autorização.
- Logs JSON estruturados: Vercel (API e Console) e Railway (worker). Eventos a vigiar:
  `platform_credential.reconcile_failed`, `http.request.error` com status ≥500 e `UPSTREAM_UNAVAILABLE`.
- Alertas: notificações de deployment falhado (Vercel e Railway) para o email do dono.

## 7. Isolamento de ambientes

- **Local:** só uma base de dados loopback (já imposto pelo código).
- **Preview/staging:** os projetos Vercel **sem** variáveis de produção no target Preview, como hoje na
  `ul-platform`. Para validar antes do piloto, criar um ambiente de staging com BD própria (branch Supabase
  ou projeto staging) e uma UL Platform de staging, ou validar num preview com BD de staging. Ver a lista
  "validação em staging" no plano de publicação da UL Platform.
- **Produção:** segredos só nos painéis da Vercel e da Railway. Chave de encriptação exclusiva. Deploy a
  partir de `main` só depois do merge aprovado.

## 8. Sequência proposta (cada passo 🔐 precisa de autorização)

1. 🔐 Decidir a BD (A ou B) e os domínios.
2. Código, sem custo: `api/index.js`, `vercel.json`, `src/worker.ts`, `railway.json` e `engines` 24.x, com
   testes. Branch e PR em rascunho.
3. 🔐 Criar a BD de produção e aplicar as migrações 0000–0011.
4. 🔐 Criar os projetos Vercel (`na-pista`, `na-pista-console`) e o serviço Railway; configurar as
   variáveis; DNS.
5. 🔐 Emitir o PROVISIONER na UL Platform e colocá-lo no worker.
6. Smoke tests:
   - health e ready;
   - uma organização de teste ativada recebe a credencial gerida;
   - `/v1/organizations/:id/products` responde;
   - `products.max` é aplicado.
