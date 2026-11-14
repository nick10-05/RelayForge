# Deploying RelayForge (Northflank Sandbox + Neon, ₹0, no card)

One Docker image runs everything (design §3, §10):

- **`relayforge`** service: API + delivery worker + dashboard. On start it applies pending
  migrations, then serves. Port 3000.
- **`chaos`** service (optional, the second Sandbox service): the same image with another start
  command — a public, deliberately unreliable receiver for demos. Port 8080.
- **Neon** Postgres 17: the app uses the **pooled** URL, migrations the **direct** URL.

Secrets (database URLs, encryption key) go only into Northflank's secret settings — never into
the repo, an issue, or a chat.

## 1. Neon

1. Create a project: **Postgres 17**, region close to your Northflank region (same continent,
   ideally the same cloud region).
2. Dashboard → **Connect**: copy two connection strings for the default database:
   - **Pooled** (host contains `-pooler`) → `DATABASE_URL`
   - **Direct** (pooling toggle off) → `DATABASE_DIRECT_URL`
3. In both, change `sslmode=require` to `sslmode=verify-full` (same behaviour in `pg` 8 —
   full certificate check — but explicit, and it silences a startup warning). The
   `channel_binding=require` part can stay; `pg` ignores it.

Why two URLs: Neon's pooler is PgBouncer in transaction mode — ideal for many short app
queries, unsafe for migrations (DDL relies on session state). The app also never uses
LISTEN/NOTIFY or session settings, so the pooler is safe for it.

## 2. Generate the encryption key (locally)

```powershell
node -e "console.log('k1:' + require('crypto').randomBytes(32).toString('base64'))"
```

Keep the output for `ENCRYPTION_KEYS`; `ENCRYPTION_ACTIVE_KEY_ID` is `k1`. Losing it makes the
stored signing/verify secrets unreadable — keep a copy in a password manager.

## 3. Northflank: the `relayforge` service

1. Create a project (Sandbox), region near your Neon region.
2. **Add new service → Combined service** (build + deploy):
   - Repository `nick10-05/RelayForge`, branch `main`.
   - Build type **Dockerfile**, path `/Dockerfile`, context `/`.
   - Port **3000**, protocol HTTP, **public**. Note the public URL it shows
     (`https://<something>.code.run`).
   - Smallest compute plan; 1 instance.
3. **Environment** (mark the secret ones as secret):

   | Variable | Value |
   |---|---|
   | `DATABASE_URL` | Neon pooled URL (secret) |
   | `DATABASE_DIRECT_URL` | Neon direct URL (secret) |
   | `ENCRYPTION_KEYS` | `k1:…` from step 2 (secret) |
   | `ENCRYPTION_ACTIVE_KEY_ID` | `k1` |
   | `APP_ORIGIN` | the service's public URL, e.g. `https://p01--relayforge--xyz.code.run` (no trailing slash) |
   | `TRUST_PROXY` | `1` |
   | `LOG_LEVEL` | `info` |

   `NODE_ENV=production`, `HOST=0.0.0.0` and `PORT=3000` are set by the image.
4. **Health checks**: add a **liveness** check, HTTP `GET /healthz` on port 3000 (every 30 s).
   Do **not** add a check on `/readyz`: it queries the database, so polling it would keep Neon
   awake permanently and use up the free compute hours (100 CU-h/month) in about two weeks.
   `/healthz` never touches the database.
5. Deploy. The log should show `migrations applied`, then `Server listening`, then
   `delivery worker started`. If the config is wrong, the container exits listing every bad
   variable by name (never its value).

If you didn't know the public URL before the first deploy, set `APP_ORIGIN` afterwards and
redeploy — until then every dashboard form answers 403 (`csrf_origin_mismatch`).

## 4. Northflank: the `chaos` service (optional)

**Add new service → Deployment service**, deploying the image built by the `relayforge`
service (or a second combined service on the same repo):

- **Start command override**: `node apps/server/src/testing/chaos-cli.ts`
- Environment: `HOST=0.0.0.0`, `PORT=8080`
- Port **8080**, HTTP, **public**.

It is safe to expose: request bodies are capped at 1 MB, only the last 1,000 requests are kept
in memory, and `/hang` gives up after 60 s. Paths: `/ok`, `/status/:code`, `/flaky/:n`,
`/slow/:ms`, `/retry-after/:s`, `/redirect`, `/hang`, `/reset`, `/big/:bytes`, `/binary`.

## 5. Verify the deployment

1. Open the `relayforge` URL → sign up → create an endpoint → copy its ingest URL.
2. Add a destination `https://<chaos-url>/flaky/2` (or any HTTPS receiver).
3. Send an event:
   ```powershell
   curl.exe -X POST <ingest URL> -H "content-type: application/json" -d '{\"hello\":\"world\"}'
   ```
4. Open the event: two failed attempts, then a success (retries back off up to ~30 s and
   ~60 s). Retry and replay work from the page.
5. **Check `TRUST_PROXY`**: the event's *Source IP* must be your public IP. If it shows an
   internal address (10.x, 172.16–31.x), the platform has one more proxy hop: set
   `TRUST_PROXY=2` and redeploy. Never set it higher than the real number of proxies — that
   would let clients spoof their IP and bypass rate limits.

### A real webhook (GitHub)

Repository → Settings → Webhooks → Add webhook: payload URL = the ingest URL, content type
`application/json`, any event. Each delivery from GitHub appears in the event list within a
few seconds and is forwarded to the endpoint's destinations.

## How it behaves on the free tiers

- **Neon scales to zero** after 5 idle minutes and resumes in a few hundred ms on the next
  query. The worker schedules its next database check for the earliest due retry and sleeps
  without any timer when nothing is due. The storage guard re-measures only when events arrive
  (at most hourly), and retention runs once a day, so an idle deployment wakes Neon about once
  a day (each wake keeps it up ~5 minutes).
- **Northflank Sandbox is always on** (no cold starts), but has one small instance: the k6
  numbers in the README were measured locally, not here.
- **Migrations run on every start** (a no-op when there is nothing new). With more than one
  instance they would race — run them as a separate job before scaling out.
- **Restarts are safe**: SIGTERM drains in-flight requests and deliveries (10 s budget); a
  delivery cut off mid-send keeps its lease and is retried after it expires (at-least-once).

## Troubleshooting

| Symptom | Cause |
|---|---|
| Container exits with `Invalid configuration:` | A listed variable is missing or malformed |
| `migration failed:` and a restart loop | Wrong `DATABASE_DIRECT_URL`, or the pooled URL was used there |
| 403 `csrf_origin_mismatch` on every form | `APP_ORIGIN` doesn't exactly match the URL in the browser |
| Logged out after every reload | Not served over HTTPS (the `__Host-` cookie requires it) |
| Destination rejected: "https is required" | Production allows only HTTPS destinations |
| Ingest answers 503 `storage_full` | Database above 90 % of `STORAGE_CAP_BYTES`; retention frees space daily |
