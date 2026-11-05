# Deployment

## Local / demo (reproducible)

```bash
# prerequisites: Node.js >= 22.13 (built-in node:sqlite; no native modules)
npm install
npm run seed        # or: node server/seed.js --force  (reset)
npm start           # binds HOST:PORT from env, default 127.0.0.1:8787
```

Environment (copy `.env.example` → `.env`; placeholders only in the repo):

| Variable | Demo default | Live requirement |
|---|---|---|
| `LTET_MODE` | `demo` | `live` |
| `PORT` / `HOST` | 8787 / 127.0.0.1 | as deployed |
| `SESSION_SECRET` | labelled demo value | long random secret (vault) |
| `TELEPHONY_WEBHOOK_SECRET` | empty | required for carrier webhook |
| `IDENTITY_API_URL` / `PORTAL_CLAIMS_API_URL` / `FINANCE_API_URL` / `OTP_PROVIDER_URL` | empty | required (readiness blocks otherwise) |
| `ASR/TTS/LLM_PROVIDER_URL` | empty | optional; deterministic adapters used when absent |
| `ENABLE_CALL_RECORDINGS` | false | stay false until consent/storage policy approved |
| `TZ_DISPLAY` | Asia/Kolkata | fixed for Release 1 |

Live-mode contract: `/api/readiness` must return `ready:true` before private
workflows are enabled; with missing config the engine **fails closed** (no
synthetic fallback), and demo tools (reset/faults/inbox/role-switch) 403.

## Hosting shape

Single Node process (HTTP + worker). Minimum viable production shape:

```
[Carrier/IVR] --signed webhooks--> [Node engine + worker] --> [SQLite volume]
      |                                   |                        |
 toll-free routing                   TLS terminator            backups + retention
 (IR-18, operator)                   (reverse proxy)           purge job (governed)
```

- Put a TLS-terminating reverse proxy (nginx/Caddy/ALB) in front; HSTS on.
- Serve `HOST=0.0.0.0` only behind the proxy; never expose the admin API publicly
  without SSO (IR-15) — staff auth is the only gate in this build.
- Scale: one writer process per SQLite volume. For higher concurrency, move to a
  managed relational DB (schema is plain SQL; migrations are idempotent) and run N
  engine processes + 1 worker per volume. `busy.max_concurrent_calls` is policy.

## Backups / restore

- SQLite: `sqlite3 data/ltet.db ".backup backup/ltet-$(date +%F).db"` or
  filesystem snapshots (WAL mode is crash-safe). Test restores quarterly.
- Retention: transcripts 90 days, call logs 3650 days by **demo-labelled** policy;
  the governed purge (`POST /api/admin/retention/run`, admin-only, audited) is the
  only deletion path for immutable logs.
- Store backups encrypted; backups contain synthetic data in demo, real personal
  data in live — classify accordingly.

## Observability

- `/api/health` (liveness), `/api/readiness` (integration blockers, worker stats).
- `audit_events` for every privileged action; `jobs` table for queue age and
  dead-letters; `call_latency` for response-start timing (simulator-labelled).
- Ship logs (stdout) to your aggregator; alert on: dead-letter jobs > 0, readiness
  `ready:false`, verification_failed spikes, unrouted alerts.

## Worker operations

- Starts with the process; tick every 2 s; `recoverStaleJobs()` on boot re-queues
  crashed runs. Manual controls (admin): replay dead jobs
  (`services/postcall.js: replayDeadJob` — expose via admin route if needed);
  inspect queue stats via `/api/readiness`.
- Bounded retries (5) with exponential backoff → `dead` + audit event.

## Rollback

- Application: previous git tag + `npm ci && systemctl restart ltet-engine`
  (schema is forward-compatible within Release 1; migrations only add).
- Configuration: Administration → Rollback to any published policy version
  (audited); takes effect immediately.
- Data: restore the latest backup; immutable logs survive application rollbacks.

## Known external dependencies (not deployable from this repo alone)

Toll-free carrier + failover (IR-18), LTET identity/claims/Finance/OTP endpoints
(IR-02/04/05/06/03), SSO (IR-15), recording storage if ever enabled (IR-17),
production ASR/TTS/LLM providers (IR-11/12/13). Each is documented in
docs/INTEGRATIONS.md with its fail-closed behaviour.
