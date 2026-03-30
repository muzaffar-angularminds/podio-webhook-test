# Podio → MongoDB Real-Time Sync — Agent Context (BullMQ Edition)

Read this file completely before writing or modifying any code.
This is the single source of truth for architecture, decisions, and implementation order.

---

## What This System Does

Mirrors Podio CRM data into MongoDB in near real-time so a React Dashboard
can read fast, scalable data without ever touching Podio's rate-limited API.

Three flows operate independently:

- **Flow 1 — Initial Seeding**: One-time (or on-demand) script that bulk-fetches
  all items from a Podio app, transforms them, and inserts them into MongoDB.
  This is the bootstrap. Also triggered by Flow 3 on schema changes.

- **Flow 2 — Real-Time Sync**: Podio sends webhook events when items are created,
  updated, or deleted. Express receives them, enqueues a BullMQ job, and a
  Primary Worker applies the corresponding MongoDB operation.

- **Flow 3 — Schema Reseed**: When a Podio app's structure changes (`app.update`),
  a Secondary Worker detects the change, drops the stale collection, and
  triggers a full reseed via the seeding script.

---

## Tech Stack

| Layer                 | Technology            | Purpose                                   |
| --------------------- | --------------------- | ----------------------------------------- |
| CRM Source            | Podio API             | Source of truth for all data              |
| HTTP Server           | Express.js            | Webhook receiver + Dashboard API          |
| Job Queue             | BullMQ (on Redis)     | Durable async job processing              |
| Primary Database      | MongoDB               | Mirrored data store                       |
| Cache + Queue Backend | Redis                 | BullMQ jobs + idempotency + rate tracking |
| Auth                  | Podio OAuth2 App Auth | Access tokens for API calls               |
| Queue Monitor         | Bull Board            | Visual dashboard for job inspection       |

**Infrastructure cost reality:** Redis is already required. BullMQ runs entirely
on Redis — no additional infrastructure is needed beyond what was already planned.
RabbitMQ has been removed from the stack entirely.

---

## BullMQ Queue Architecture

### Why BullMQ Over RabbitMQ Here

RabbitMQ requires a separate service (AMQP broker) with its own port, management
UI, memory allocation, and operational overhead. BullMQ runs entirely on Redis,
which is already in the stack for caching and idempotency. One less container,
one less thing to monitor, one less failure point.

BullMQ gives you everything RabbitMQ gave this workflow: durable job storage,
automatic retries with backoff, dead-letter equivalents via the `failed` job set,
concurrency control, rate limiting, and a visual UI via Bull Board.

### Queue Definitions (`src/queues/index.js`)

Three queues, all backed by the same Redis instance:

**`podio-item-events`** — receives item-level webhook events (`item.create`,
`item.update`, `item.delete`, and parent-item refreshes from comment/file/tag events).
Consumed by the Primary Worker. Rate limited to 240 Podio API calls per hour.

**`podio-app-events`** — receives app-level events (`app.update`, `app.delete`).
Consumed by the Secondary Worker. Low volume, no rate limit needed.

**`podio-seed`** — receives seeding jobs triggered either on startup or by the
Secondary Worker after a schema change. One job per `app_id`. Processed by the
seeding script logic wrapped in a worker. Rate limited to prevent bursting
Podio's 250/hr filter endpoint budget during large reseeds.

```js
// src/queues/index.js
const { Queue } = require("bullmq");
const connection = {
  host: process.env.REDIS_HOST || "localhost",
  port: parseInt(process.env.REDIS_PORT) || 6379,
};

const defaultJobOptions = {
  attempts: 3,
  backoff: { type: "exponential", delay: 2000 }, // 2s → 4s → 8s
  removeOnComplete: { count: 1000 }, // keep last 1000 for audit
  removeOnFail: { count: 500 }, // keep last 500 failed for inspection
};

const itemQueue = new Queue("podio-item-events", {
  connection,
  defaultJobOptions,
});
const appQueue = new Queue("podio-app-events", {
  connection,
  defaultJobOptions,
});
const seedQueue = new Queue("podio-seed", { connection, defaultJobOptions });

module.exports = { itemQueue, appQueue, seedQueue, connection };
```

### Job Deduplication

BullMQ deduplicates jobs via the `jobId` option. If a job with the same `jobId`
already exists in the queue (waiting or delayed), the new `add()` call is a
silent no-op. Use this for all item events to prevent the same item being
processed multiple times when Podio fires duplicate webhooks:

```js
await itemQueue.add(
  "item-event",
  { type, item_id, app_id },
  { jobId: `item:${item_id}:${type}` }, // dedup key
);
```

For seed jobs, dedup by `app_id` so a flood of `app.update` events only
triggers one reseed:

```js
await seedQueue.add("reseed", { app_id }, { jobId: `seed:${app_id}` });
```

### Error Handling — Permanent vs Transient

BullMQ retries any job that throws a normal error, using the `backoff` config.
For Podio `4xx` responses (auth failure, not found, bad request), retrying will
never succeed — throw `UnrecoverableError` to skip remaining attempts and move
the job directly to the failed set:

```js
const { UnrecoverableError } = require("bullmq");

// Inside any worker processor:
const status = err.response?.status;
if (status && status >= 400 && status < 500) {
  throw new UnrecoverableError(`Permanent ${status} from Podio. Dropping job.`);
}
throw err; // transient — BullMQ will retry with backoff
```

Failed jobs (after all retries exhausted) stay in Redis under the queue's
`failed` set. They are visible and manually retriable via Bull Board — this is
the equivalent of RabbitMQ's Dead Letter Queue.

### Bull Board — Queue Monitoring UI

Add to `server.js` so the visual dashboard is always available:

```js
const { createBullBoard } = require("@bull-board/api");
const { BullMQAdapter } = require("@bull-board/api/bullMQAdapter");
const { ExpressAdapter } = require("@bull-board/express");
const { itemQueue, appQueue, seedQueue } = require("./queues");

const serverAdapter = new ExpressAdapter();
serverAdapter.setBasePath("/admin/queues");

createBullBoard({
  queues: [
    new BullMQAdapter(itemQueue),
    new BullMQAdapter(appQueue),
    new BullMQAdapter(seedQueue),
  ],
  serverAdapter,
});

app.use("/admin/queues", serverAdapter.getRouter());
// Visit: http://localhost:3000/admin/queues
```

---

## Flow 1 — Initial Seeding Script

**File:** `src/scripts/seedApp.js`

**When to run:** Once on first deployment. Also called by the Secondary Worker
after a schema change.

**What it does:**

1. Authenticates with Podio via App Auth.
2. Calls `POST /item/app/{app_id}/filter/?hook=false` in a paginated loop:
   `limit=500`, incrementing `offset` until `offset >= total`.
3. Adds each page of results as a `podio-seed` BullMQ job, OR processes
   inline if called directly (both patterns must be supported).
4. For each page: calls `transformPodioItem()` on every item, then `bulkWrite`
   with `upsert: true` into MongoDB.
5. Stores the app schema snapshot in `AppSchema` collection after seeding.
6. On completion, clears the `seed:${app_id}` job from the seed queue.

**Critical implementation details:**

- Always use `?hook=false` on filter calls. Without it, Podio may fire webhooks
  in response to the seed reads, causing the item worker to re-fetch every item
  being seeded — a feedback loop that burns rate limit budget.
- Sleep 4000ms between pages: `await sleep(4000)`. This keeps seeding at
  ~15 pages/min = ~900/hr for the general endpoint budget.
- The script must be idempotent. Running it twice must produce the same MongoDB
  state. `upsert: true` on `bulkWrite` handles this.
- Accept `app_id` as argument: `node seedApp.js --app_id=12345` for CLI use.

**Podio filter API call:**

```js
POST /item/app/{app_id}/filter/?hook=false
{
  filters: {},          // empty = fetch all items
  limit: 500,
  offset: 0,            // increment by 500 per page
  sort_by: "item_id",
  sort_desc: false
}
// Response: { total: N, filtered: N, items: [...] }
// Keep paginating until offset >= total
```

---

## Flow 2 — Real-Time Webhook Sync

### Step 1: Express Webhook Listener (`src/webhook/server.js`)

The handler has one job: receive, validate minimally, enqueue, return 200.
All within 15 seconds.

**Podio suspension rules — never violate:**

- No 200 response within 15s → counts as one failure.
- 15 failures in 15 minutes → webhook suspended 15 minutes.
- 200 failures in 7 days → permanently disabled (must manually re-verify).

**Handler pattern — 200 first, always:**

```js
app.post("/webhook/podio", async (req, res) => {
  res.sendStatus(200); // 1. ACK immediately
  const { type, item_id, app_id, hook_id, code } = req.body;
  await routeWebhookEvent({ type, item_id, app_id, hook_id, code }); // 2. enqueue
});
```

**Event routing:**

`hook.verify` — Must call Podio back to activate the webhook:

```js
await podioClient.post(`/hook/${hook_id}/verify/validate`, { code });
```

This is a two-step handshake. Podio POSTs to us with a code; we call Podio
back with that code to confirm ownership. Only then does Podio start sending
real events. Do not echo the code in the response — that does nothing.

`item.create` / `item.update` — Check Redis idempotency, then enqueue:

```js
const key = `event:${hook_id}:${item_id}`;
if (await redis.get(key)) return; // already processed
await redis.set(key, "1", "EX", 86400); // mark as seen, 24hr TTL
await itemQueue.add(
  "item-event",
  { type, item_id, app_id },
  {
    jobId: `item:${item_id}:${type}`, // dedup
  },
);
```

`item.delete` — Enqueue without idempotency check (deletes are safe to retry soft delete to db):

```js
await itemQueue.add(
  "item-event",
  { type: "item.delete", item_id, app_id },
  {
    jobId: `item:${item_id}:delete`,
  },
);
```

`app.update` / `app.delete` — Enqueue to the app queue:

```js
await appQueue.add(
  "app-event",
  { type, app_id },
  {
    jobId: `app:${app_id}:${type}`, // dedup: one handler per app per event type
  },
);
```

### Step 2: Primary Worker (`src/queues/primaryWorker.js`)

Consumes `podio-item-events`. Rate limited to 240 Podio API calls per hour.

```js
const { Worker, UnrecoverableError } = require("bullmq");
const { connection } = require("./index");

new Worker(
  "podio-item-events",
  async (job) => {
    const { type, item_id, app_id } = job.data;

    if (type === "item.delete") {
      await PodioItem.findOneAndUpdate(
        { item_id: String(item_id) },
        { $set: { sync_status: "deleted", last_synced_at: new Date() } },
      );
      return;
    }

    // item.create, item.update, and parent-item refreshes
    let raw;
    try {
      const { data } = await podioClient.get(`/item/${item_id}`, {
        params: { hook: false }, // CRITICAL: prevents infinite webhook loop
      });
      raw = data;
    } catch (err) {
      const status = err.response?.status;
      if (status >= 400 && status < 500) {
        throw new UnrecoverableError(`Podio ${status} for item ${item_id}`);
      }
      throw err; // transient — BullMQ retries with backoff
    }

    const transformed = transformPodioItem(raw, app_id);
    await PodioItem.findOneAndUpdate(
      { item_id: String(item_id) },
      {
        $set: {
          ...transformed,
          sync_status: "success",
          last_synced_at: new Date(),
        },
      },
      { upsert: true },
    );
  },
  {
    connection,
    concurrency: 1, // one job at a time
    limiter: { max: 240, duration: 3_600_000 }, // 240/hr under Podio's 250/hr limit
  },
);
```

**Why `GET /item/{id}` here instead of the batch filter:**
The primary worker handles one item at a time on-demand (webhook-triggered).
Batch filter is used only in the seeding script where we know in advance we
want many items. On-demand single-item fetch via `GET /item/{id}` consumes
from the 1,000/hr general budget, not the 250/hr rate-limited filter budget —
a better use of budget for real-time events.

**Why `hook=false` is mandatory:**
Without it, calling `GET /item/{id}` from the worker can cause Podio to fire
a webhook for that item. That webhook enters the queue. The worker picks it up,
calls `GET /item/{id}` again, which fires another webhook. Infinite loop.
`hook=false` tells Podio to treat the read as an internal silent operation.

---

## Flow 3 — Schema Change Handling

### Secondary Worker (`src/queues/secondaryWorker.js`)

Consumes `podio-app-events`. Low volume queue, no rate limiting needed.

**On `app.update`:**

```js
new Worker(
  "podio-app-events",
  async (job) => {
    const { type, app_id } = job.data;

    if (type === "app.update") {
      // 1. Fetch current schema from Podio
      const { data: currentApp } = await podioClient.get(`/app/${app_id}`);
      const currentFields = currentApp.fields;

      // 2. Load stored snapshot
      const stored = await AppSchema.findOne({ app_id: String(app_id) });

      // 3. Quick hash check via Redis before expensive diff
      const currentHash = md5(JSON.stringify(currentFields));
      const storedHash = await redis.get(`schema:hash:${app_id}`);

      if (storedHash === currentHash) {
        logger.info(`[Schema] App ${app_id} schema unchanged. Skipping.`);
        return;
      }

      // 4. Full diff to understand what changed
      const changes = diffSchemas(stored?.fields || [], currentFields);
      logger.info(`[Schema] App ${app_id} changes: ${JSON.stringify(changes)}`);

      // 5. Save new snapshot
      await AppSchema.findOneAndUpdate(
        { app_id: String(app_id) },
        {
          fields: currentFields,
          fields_snapshot: stored?.fields || [],
          last_synced_at: new Date(),
        },
        { upsert: true },
      );
      await redis.set(`schema:hash:${app_id}`, currentHash);

      // 6. If structural changes exist, trigger full reseed
      const structural = changes.filter((c) =>
        [
          "field_added",
          "field_deleted",
          "field_renamed",
          "field_type_changed",
          "category_options_changed",
        ].includes(c.type),
      );

      if (structural.length > 0) {
        logger.info(
          `[Schema] Structural changes detected. Triggering reseed for app ${app_id}`,
        );
        await seedQueue.add(
          "reseed",
          { app_id },
          {
            jobId: `seed:${app_id}`, // dedup: multiple app.update events = one reseed
          },
        );
      }
    }

    if (type === "app.delete") {
      await PodioItem.updateMany(
        { app_id: String(app_id) },
        { $set: { sync_status: "app_deleted", last_synced_at: new Date() } },
      );
      await AppSchema.findOneAndDelete({ app_id: String(app_id) });
      await redis.del(`schema:hash:${app_id}`);
      logger.info(
        `[Schema] App ${app_id} deleted. All items marked app_deleted.`,
      );
    }
  },
  { connection },
);
```

**Schema diff function (implement in `src/queues/secondaryWorker.js`):**

```js
function diffSchemas(oldFields, newFields) {
  const changes = [];
  const oldMap = new Map(oldFields.map((f) => [f.field_id, f]));
  const newMap = new Map(newFields.map((f) => [f.field_id, f]));

  for (const [id, newField] of newMap) {
    if (!oldMap.has(id)) {
      changes.push({ type: "field_added", label: newField.label });
    } else {
      const old = oldMap.get(id);
      if (old.label !== newField.label)
        changes.push({
          type: "field_renamed",
          from: old.label,
          to: newField.label,
        });
      if (old.type !== newField.type)
        changes.push({ type: "field_type_changed", field_id: id });
      if (newField.type === "category") {
        const oldOpts = JSON.stringify(old.config?.settings?.options || []);
        const newOpts = JSON.stringify(
          newField.config?.settings?.options || [],
        );
        if (oldOpts !== newOpts)
          changes.push({ type: "category_options_changed", field_id: id });
      }
    }
  }

  for (const [id, oldField] of oldMap) {
    if (!newMap.has(id))
      changes.push({ type: "field_deleted", label: oldField.label });
  }

  return changes;
}
```

**Why full reseed on structural schema changes:**
When a field is renamed, every existing MongoDB document contains the old label
in `podio_data.fields`. Dashboard queries filtering on `label: "Lead Status"`
break silently when that field is renamed to "Deal Stage". Patching every
document in-place is complex and error-prone at scale. The seeding script is
idempotent and uses `upsert: true`, so running it again is always safe and
produces a fully consistent state.

---

## Podio Authentication (`src/podio/auth.js`)

App Auth flow — system acts as an automated service, not a human user. Tokens
appear in Podio's audit logs as "created by the app."

**Token acquisition:**

```
POST https://api.podio.com/oauth/token/v2
Content-Type: application/json

{
  "grant_type":    "app",
  "app_id":        PODIO_APP_ID,
  "app_token":     PODIO_APP_TOKEN,
  "client_id":     PODIO_CLIENT_ID,
  "client_secret": PODIO_CLIENT_SECRET,
  "redirect_uri":  PODIO_REDIRECT_URI
}

Response: { access_token, refresh_token, expires_in, token_type: "bearer" }
```

**CRITICAL DISTINCTION:**

- `PODIO_APP_TOKEN` = static credential from Podio settings page (used to log in).
- `access_token` = dynamic OAuth bearer token (used in API headers, expires).
  These are different things. Putting the `app_token` in the Authorization header
  will return 401 on every request.

`auth.js` responsibilities:

- Store `access_token`, `refresh_token`, and computed `expiresAt = Date.now() + expires_in * 1000`.
- On `getAccessToken()`: return stored token if `Date.now() < expiresAt - 60_000`.
- If near expiry: call refresh endpoint with `grant_type: "refresh_token"`.
- If refresh fails: fall back to full re-authentication.
- Export a single `getAccessToken()` function used by the Axios client.

**`src/podio/client.js`** — Axios instance with:

- Request interceptor: `config.headers.Authorization = \`Bearer \${await auth.getAccessToken()}\``.
- Response interceptor: read `X-Rate-Limit-Remaining` and `X-Rate-Limit-Limit`
  headers on every response. Log remaining. Warn when below 20%. Log error on 420.

---

## Redis Usage (`src/redis/client.js`)

Redis serves four purposes simultaneously. All through the same ioredis connection.

**1. BullMQ backend** — BullMQ uses Redis internally for all job storage.
No additional configuration needed — just point BullMQ and ioredis at the same host.

**2. Idempotency keys** — prevent duplicate processing of the same webhook.

```js
const key = `event:${hook_id}:${item_id}`;
await redis.set(key, "1", "EX", 86400); // 24-hour TTL
const exists = await redis.get(key); // check before processing
```

**3. Schema version hash** — fast pre-check before expensive MongoDB diff.

```js
await redis.set(`schema:hash:${app_id}`, md5(JSON.stringify(fields)));
const cached = await redis.get(`schema:hash:${app_id}`);
```

**4. Rate limit tracking** — sliding window counter to monitor Podio API usage.

```js
const minute = Math.floor(Date.now() / 60000);
await redis.incr(`ratelimit:podio:${minute}`);
await redis.expire(`ratelimit:podio:${minute}`, 120);
```

Export helper functions from `redis/client.js`:

- `checkIdempotency(key)` → returns `true` if already processed
- `markProcessed(key, ttl = 86400)` → sets the key
- `getSchemaHash(appId)` → returns stored hash or null
- `setSchemaHash(appId, hash)` → stores hash with no TTL (schema hashes are permanent)

---

## MongoDB Collections

### `podioitems` — Main Mirror

```js
const PodioItemSchema = new mongoose.Schema(
  {
    item_id: { type: String, required: true, index: true },
    app_id: { type: String, required: true, index: true },
    podio_data: { type: mongoose.Schema.Types.Mixed }, // full raw response
    title: { type: String, index: true },
    status: { type: String, index: true },
    created_by: { type: String },
    podio_created_at: { type: Date },
    podio_last_updated_at: { type: Date },
    sync_status: { type: String, default: "pending" }, // success|failed|deleted|app_deleted
    last_synced_at: { type: Date },
    sync_error: { type: String, default: null },
  },
  { strict: false, timestamps: false },
);

PodioItemSchema.index({ app_id: 1, podio_last_updated_at: -1 });
PodioItemSchema.index({ item_id: 1, app_id: 1 }, { unique: true });
```

`strict: false` is intentional — new Podio fields land in the document
automatically without requiring schema migrations or redeployments.

### `appschemas` — Schema Snapshots

```js
const AppSchemaModel = new mongoose.Schema(
  {
    app_id: { type: String, required: true, unique: true },
    app_name: { type: String },
    fields: { type: mongoose.Schema.Types.Mixed }, // current field definitions
    fields_snapshot: { type: mongoose.Schema.Types.Mixed }, // previous version for diffing
    last_synced_at: { type: Date, default: Date.now },
  },
  { timestamps: true },
);
```

---

## Transform Function (`src/transforms/transformPodioItem.js`)

```js
function transformPodioItem(raw, appId) {
  return {
    item_id: String(raw.item_id),
    app_id: String(appId || raw.app?.app_id),
    podio_data: raw, // ALWAYS preserve full raw
    title: raw.title || null,
    status: extractField(raw.fields, "status"),
    created_by: raw.created_by?.name || null,
    podio_created_at: raw.created_on ? new Date(raw.created_on) : null,
    podio_last_updated_at: raw.last_event_on
      ? new Date(raw.last_event_on)
      : null,
  };
}

function extractField(fields, label) {
  const field = fields?.find(
    (f) => f.label?.toLowerCase() === label.toLowerCase(),
  );
  return field?.values?.[0]?.value?.text || field?.values?.[0]?.value || null;
}

module.exports = transformPodioItem;
```

---

## Graceful Shutdown (All Workers and Server)

Every process must handle SIGTERM and SIGINT cleanly. BullMQ workers need to
finish their current job before closing to avoid leaving jobs in a stalled state.

```js
// Add to every worker file and to server.js
async function shutdown() {
  logger.info("[Shutdown] Closing gracefully...");
  await worker.close(); // finish current job, stop accepting new ones
  await mongoose.connection.close();
  await redis.quit();
  logger.info("[Shutdown] Clean exit.");
  process.exit(0);
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
```

---

## Environment Variables

```env
# Server
PORT=3000

# Podio OAuth2 App Auth
# Find these in: Podio App → Settings (gear icon) → Developer
PODIO_CLIENT_ID=your_client_id
PODIO_CLIENT_SECRET=your_client_secret
PODIO_APP_ID=your_podio_app_id
PODIO_APP_TOKEN=your_podio_app_token
PODIO_REDIRECT_URI=https://localhost

# MongoDB
MONGO_URI=mongodb://admin:admin@localhost:27017/podio_mirror?authSource=admin
MONGO_DB_NAME=podio_mirror

# Redis — used by both BullMQ and ioredis directly
REDIS_HOST=localhost
REDIS_PORT=6379

# Seeding
BATCH_SIZE=500          # items per Podio filter call (max the API supports)
SEED_DELAY_MS=4000      # delay between paginated pages during seeding (rate limiting)

# Workers
MAX_RETRIES=3           # transient failure retries before job enters failed set
RATE_LIMIT_MAX=240      # Podio API calls per hour (under Podio's 250/hr limit)
```

---

## Docker Compose

Two services only. RabbitMQ is gone. Redis handles both caching and BullMQ.

```yaml
version: "3.9"
services:
  mongodb:
    image: mongo:7
    container_name: podio_mongo
    ports: ["27017:27017"]
    environment:
      MONGO_INITDB_ROOT_USERNAME: admin
      MONGO_INITDB_ROOT_PASSWORD: admin
      MONGO_INITDB_DATABASE: podio_mirror
    volumes: [mongo_data:/data/db]

  redis:
    image: redis:7-alpine
    container_name: podio_redis
    ports: ["6379:6379"]
    command: redis-server --appendonly yes # enables Redis persistence
    volumes: [redis_data:/data]

volumes:
  mongo_data:
  redis_data:
```

`--appendonly yes` is mandatory. Without it, a Redis restart loses all BullMQ
jobs that are pending or delayed. With it, Redis replays its log on startup
and jobs survive restarts.

---

## npm Dependencies

```json
{
  "dependencies": {
    "axios": "^1.6.7",
    "bullmq": "^5.0.0",
    "ioredis": "^5.3.2",
    "mongoose": "^8.2.2",
    "express": "^4.18.3",
    "dotenv": "^16.4.5",
    "winston": "^3.11.0",
    "@bull-board/api": "^5.0.0",
    "@bull-board/express": "^5.0.0"
  },
  "devDependencies": {
    "nodemon": "^3.1.0"
  }
}
```

`amqplib` and `bottleneck` are not needed and must not be added.

---

## npm Scripts

```json
{
  "scripts": {
    "server": "node src/webhook/server.js",
    "worker:primary": "node src/queues/primaryWorker.js",
    "worker:secondary": "node src/queues/secondaryWorker.js",
    "seed": "node src/scripts/seedApp.js",
    "dev:server": "nodemon src/webhook/server.js",
    "dev:primary": "nodemon src/queues/primaryWorker.js",
    "dev:secondary": "nodemon src/queues/secondaryWorker.js",
    "infra:up": "docker-compose up -d",
    "infra:down": "docker-compose down"
  }
}
```

---

## Local Dev Setup

```bash
# 1. Start infrastructure (MongoDB + Redis only)
npm run infra:up

# 2. Install deps
npm install

# 3. Configure environment
cp .env.example .env
# Fill in: PODIO_CLIENT_ID, PODIO_CLIENT_SECRET, PODIO_APP_ID, PODIO_APP_TOKEN

# 4. Run initial seed
npm run seed -- --app_id=YOUR_PODIO_APP_ID

# 5. Start the webhook server
npm run dev:server

# 6. Expose to internet (Podio requires a real URL)
npx ngrok http 3000
# Copy the https URL → Podio App → Settings → Developer → Webhooks
# Register events: item.create, item.update, item.delete, app.update

# 7. Start workers in separate terminals
npm run dev:primary
npm run dev:secondary

# 8. Monitor jobs
# Bull Board UI: http://localhost:3000/admin/queues
```

---

## Implementation Order

Work in this exact sequence. Each step unblocks the next.

1. **`src/config/logger.js`** — Winston with console transport. Every other file
   imports this. Nothing runs without it.

2. **`src/redis/client.js`** — ioredis instance, export helpers:
   `checkIdempotency`, `markProcessed`, `getSchemaHash`, `setSchemaHash`.

3. **`src/podio/auth.js`** — Full OAuth2 App Auth with token refresh.

4. **`src/podio/client.js`** — Axios instance with auth interceptor and
   rate-header logging. Test by calling `GET /app/{YOUR_APP_ID}` and logging
   the field count in the response.

5. **`src/db/connection.js`** — Mongoose connect with reconnect handling.

6. **`src/db/models/PodioItem.js`** and **`src/db/models/AppSchema.js`** —
   schemas exactly as specified above.

7. **`src/transforms/transformPodioItem.js`** — transform function as specified.

8. **`src/queues/index.js`** — queue definitions for all three BullMQ queues.

9. **`src/scripts/seedApp.js`** — paginated bulk fetch with sleep between pages,
   `hook=false` on all calls, `bulkWrite` upsert. Test: run it, verify docs in
   MongoDB, run again, verify no duplicates and no extra API calls.

10. **`src/queues/primaryWorker.js`** — item event consumer with rate limiter,
    `GET /item/{id}?hook=false`, full ack/nack/UnrecoverableError logic.

11. **`src/webhook/server.js`** — Express server, full event routing switch,
    idempotency check before every enqueue, Bull Board mounted at `/admin/queues`.

12. **`src/queues/secondaryWorker.js`** — app event consumer, `diffSchemas`,
    reseed trigger, graceful shutdown.

13. **Graceful shutdown** — wire SIGTERM/SIGINT handlers in all three processes.

14. **Dashboard API endpoints** on `server.js`:
    - `GET /api/items?app_id=X&status=Y&page=1&limit=50` — excludes deleted docs.
    - `GET /api/items/:item_id` — single item lookup.

15. **(Optional)** WebSocket or SSE for real-time push to the React Dashboard.

---

## Key Decisions and Rationale

**BullMQ over RabbitMQ.** Redis is already required for idempotency and caching.
BullMQ runs entirely on Redis — no second broker, no extra Docker service, no
AMQP port to manage. The capabilities relevant to this project (durable jobs,
retries, DLQ equivalent via failed set, rate limiting, monitoring UI) are all
present in BullMQ.

**Three separate queues instead of one.** Item events, app events, and seed jobs
have different rate limits, concurrency needs, and retry budgets. Mixing them in
one queue would mean a flood of item events blocking a schema reseed, or a slow
seed job preventing real-time item processing. Separate queues give independent
throughput control for each concern.

**`GET /item/{id}` in primary worker, filter API in seeding script.** Real-time
events are one item at a time — using the batch filter API for single items adds
complexity with no benefit. The filter API is used in the seeding script where
we always know we want many items, making batching efficient. On-demand single
fetches consume from the 1,000/hr general budget; the filter endpoint consumes
from the stricter 250/hr budget. Use each budget for the right job.

**`jobId` deduplication instead of Redis pre-check for queuing.** For the
queuing step, BullMQ's `jobId` is the correct dedup mechanism — it's atomic and
requires no extra Redis round-trip. The Redis idempotency key is used as a
belt-and-suspenders check at the webhook handler level to prevent even publishing
a duplicate job in the first place, which is valuable because it saves the Redis
storage of a BullMQ job entirely.

**`strict: false` on PodioItem.** Podio app schemas change over time. With
`strict: false` and `podio_data: Mixed`, any field Podio adds in the future
lands in the document automatically. The dashboard can always read from
`podio_data.fields` for fields not yet promoted to indexed top-level keys.
Zero migrations needed.

**`UnrecoverableError` for Podio 4xx.** A 401 Unauthorized or 404 Not Found
from Podio will never succeed regardless of how many retries are attempted.
Retrying them wastes rate limit budget. `UnrecoverableError` tells BullMQ to
move the job directly to the failed set, skipping all remaining attempt slots.
The job is then visible in Bull Board for manual inspection.

**`--appendonly yes` on Redis.** BullMQ stores all pending, delayed, and active
jobs in Redis. Without AOF persistence, a Redis restart loses every job in
every queue. With `--appendonly yes`, Redis replays its operation log on startup
and the queue state is fully restored — equivalent to RabbitMQ's durable queues.

**Full reseed on structural schema changes.** Patching existing documents when
a Podio field is renamed requires updating every `podio_data.fields[n].label`
where the old label appears — across potentially thousands of documents, with
no guarantee the patch logic handles all edge cases. The seeding script is
already written, already idempotent, and already handles all field types.
Triggering it is one line. The outcome is a guaranteed consistent state.
