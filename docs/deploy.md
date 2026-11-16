# Deploying RelayForge (Render Free + Neon, ₹0, no card)

One Docker image runs everything (design §3, §10):

- **`relayforge`** web service: API + delivery worker + dashboard. On start it applies pending
  migrations, then serves.
- **`relayforge-chaos`** web service (optional): the same image with another start command — a
  public, deliberately unreliable receiver for demos.
- **Neon** Postgres 18: the app uses the **pooled** URL, migrations the **direct** URL. Never use
  Render's free Postgres — it expires 30 days after creation.

Secrets (database URLs, encryption key) go only into Render's environment settings — never into
the repo, an issue, or a chat.

## What Render Free means for RelayForge

| Free-tier rule | Effect on RelayForge |
|---|---|
| Spins down after **15 min** without inbound traffic; waking takes **about a minute** | The first webhook after an idle period may hit the sender's timeout (GitHub waits 10 s). Senders that retry (Stripe, Standard Webhooks) recover on their own; GitHub needs a manual "Redeliver" |
| The worker runs inside the web service, so it sleeps too | Retries that fall due while asleep run **late**, right after the next wake-up (the claim query picks up everything overdue). Nothing is lost — rows live in Neon |
| **750** free instance hours per workspace per month | One service awake all month is ~744 h, so two services fit only because both sleep when idle |
| **5 GB** outbound bandwidth per month (includes traffic to Neon and to destinations) | Ample for a demo. Without a card, going over suspends the free services until next month — no bill |
| **500** build minutes per month | A build takes a few minutes; auto-deploy on every push to `main` is fine |
| 0.1 CPU, 512 MB RAM, one instance, no shell, no persistent disk | Fine: the app is stateless (everything is in Postgres). The k6 numbers in the README were measured locally, not here |
| **No pre-deploy command** on free services | Migrations already run in the image's start command, so nothing changes |
| Render may restart a free service at any time | Safe: SIGTERM drains in-flight work (10 s); a delivery cut off mid-send is retried after its lease expires (at-least-once) |

A side effect: while the service sleeps it sends no queries, so Neon can scale to zero too.

## 1. Neon

1. Project **Postgres 18**, region **AWS Asia Pacific (Singapore)** — the same city as Render's
   Singapore region.
2. Dashboard → **Connect**, default database and role:
   - **Pooled** (connection pooling **on**, host contains `-pooler`) → `DATABASE_URL`
   - **Direct** (connection pooling **off**) → `DATABASE_DIRECT_URL`
3. In both, change `sslmode=require` to `sslmode=verify-full` (same behaviour in `pg` 8 — full
   certificate check — but explicit, and it silences a startup warning). `channel_binding=require`
   can stay; `pg` ignores it.

Why two URLs: Neon's pooler is PgBouncer in transaction mode — ideal for many short app
queries, unsafe for migrations (DDL relies on session state). The app never uses LISTEN/NOTIFY
or session settings, so the pooler is safe for it.

## 2. Encryption key (generated locally, straight to the clipboard)

```powershell
node -e "process.stdout.write('k1:' + require('crypto').randomBytes(32).toString('base64'))" | Set-Clipboard
```

Nothing is printed. Paste it into `ENCRYPTION_KEYS` and into your password manager — losing it
makes the stored signing/verify secrets unreadable. `ENCRYPTION_ACTIVE_KEY_ID` is `k1`.

## 3. Render: the `relayforge` web service

1. Sign up at render.com with GitHub (no card) and allow access to the `RelayForge` repository.
2. **New → Web Service** → repository `nick10-05/RelayForge`:

   | Setting | Value |
   |---|---|
   | Name | `relayforge` (the URL becomes `https://relayforge.onrender.com`, or gets a suffix if taken) |
   | Language / runtime | **Docker** (Dockerfile path `./Dockerfile`, context `.`) |
   | Branch | `main` |
   | Region | **Singapore** |
   | Instance type | **Free** |

3. **Environment variables**:

   | Variable | Value |
   |---|---|
   | `DATABASE_URL` | Neon pooled URL |
   | `DATABASE_DIRECT_URL` | Neon direct URL |
   | `ENCRYPTION_KEYS` | `k1:…` from step 2 |
   | `ENCRYPTION_ACTIVE_KEY_ID` | `k1` |
   | `APP_ORIGIN` | the service URL shown on its page, e.g. `https://relayforge-r0l7.onrender.com` (no trailing slash) |
   | `TRUST_PROXY` | `3` (measured on Render, see step 5 of the verification) |
   | `LOG_LEVEL` | `info` |

   `NODE_ENV=production` and `HOST=0.0.0.0` come from the image. Render sets `PORT` (10000 by
   default); the server listens on whatever `PORT` says, and Render routes to it.
4. **Advanced → Health Check Path**: `/healthz`. It never touches the database, so it cannot keep
   Neon awake. (Not `/readyz`, which queries the database.)
5. **Create Web Service**. The log should show `migrations applied`, then `Server listening`, then
   `delivery worker started`. If the config is wrong, the container exits listing every bad
   variable by name (never its value).

**`onrender.com` names are global.** If someone else already has `relayforge`, Render adds a
random suffix (this deployment is `https://relayforge-r0l7.onrender.com`), and the bare name
serves someone else's app. Copy the URL from the service page, set `APP_ORIGIN` to exactly that
(Environment → Edit → Save, rebuild, and deploy) — until then every dashboard form answers 403
(`csrf_origin_mismatch`).

## 4. Render: the `relayforge-chaos` service (optional)

**New → Web Service**, same repository, branch, region and Free plan, runtime Docker, then:

- **Docker Command**: `node apps/server/src/testing/chaos-cli.ts`
- Environment: `HOST=0.0.0.0` (`PORT` is set by Render)
- Health Check Path: `/ok`

It is safe to expose: request bodies are capped at 1 MB, only the last 1,000 requests are kept
in memory, and `/hang` gives up after 60 s. Paths: `/ok`, `/status/:code`, `/flaky/:n`,
`/slow/:ms`, `/retry-after/:s`, `/redirect`, `/hang`, `/reset`, `/big/:bytes`, `/binary`. It
sleeps when idle too, so the first delivery to it after a quiet spell may time out and be
retried — a realistic demo of the retry path.

## 5. Verify the deployment

1. Open the `relayforge` URL (the first load may take a minute if it was asleep) → sign up →
   create an endpoint → copy its ingest URL.
2. Add a destination `https://<chaos-url>/flaky/2` (or any HTTPS receiver).
3. Send an event:
   ```powershell
   curl.exe -X POST <ingest URL> -H "content-type: application/json" -d '{\"hello\":\"world\"}'
   ```
4. Open the event: two failed attempts, then a success (retries back off up to ~30 s and
   ~60 s). Retry and replay work from the page.
5. **Check `TRUST_PROXY`**: the event's *Source IP* must be your public IP. Its request headers
   show the chain. On Render: `x-forwarded-for: <you>, <Cloudflare edge>, <Render LB 10.x>`, and
   the TCP connection itself comes from one more internal proxy — **3 hops**, so
   `TRUST_PROXY=3` (with `1`, Source IP shows the 10.x load balancer). The rule: trust exactly as
   many hops as the platform adds, counted from the right. A client that sends its own fake
   `X-Forwarded-For` only adds entries on the _left_, so it can't spoof its IP; a value higher
   than the real hop count would let it, and bypass rate limits.

### A real webhook (GitHub)

Repository → Settings → Webhooks → Add webhook: payload URL = the ingest URL, content type
`application/json`, any event. If the service was asleep, GitHub's first delivery may time out
(it waits 10 s); use **Redeliver** once the service is up.

## How it behaves on the free tiers

- **Render** sleeps after 15 idle minutes and wakes on the next request (~1 min).
- **Neon scales to zero** after 5 idle minutes and resumes in a few hundred ms on the next
  query. While Render is awake, the worker schedules its next database check for the earliest
  due retry and sleeps without any timer when nothing is due; the storage guard re-measures only
  when events arrive (at most hourly).
- **Retention** runs at every start — so at each wake-up — and every 24 h while awake. The
  7-day window is a minimum, not an exact deadline.
- **Migrations run on every start** (a no-op when there is nothing new). With more than one
  instance they would race — run them as a separate step before scaling out.

## Troubleshooting

| Symptom | Cause |
|---|---|
| Container exits with `Invalid configuration:` | A listed variable is missing or malformed |
| `migration failed:` and a restart loop | Wrong `DATABASE_DIRECT_URL`, or the pooled URL was used there |
| 403 `csrf_origin_mismatch` on every form | `APP_ORIGIN` doesn't exactly match the URL in the browser |
| Logged out after every reload | Not served over HTTPS (the `__Host-` cookie requires it) |
| Destination rejected: "https is required" | Production allows only HTTPS destinations |
| Ingest answers 503 `storage_full` | Database above 90 % of `STORAGE_CAP_BYTES`; retention frees space daily |
| First request after a break takes ~1 min | The free service was asleep — expected |
| All services suspended until next month | Free instance hours or the 5 GB bandwidth ran out |
