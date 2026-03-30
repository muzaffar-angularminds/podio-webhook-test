# Implementation Plan — BullMQ Migration

Migrating from in-memory Bottleneck queue to BullMQ + Redis architecture.
All changes mapped to the existing folder structure (no new top-level directories).

---

## What Changes vs What Stays

### Stays (already implemented, minor updates only)

- `src/config/auth.js` — OAuth flow (already works, no changes needed)
- `src/config/logger.js` — Winston logger (already exists)
- `src/config/morgan.js` — HTTP logging (already exists)
- `src/config/config.js` — env validation (needs new vars added)
- `src/webhooks/client.js` — Axios + interceptors (already works)
- `src/webhooks/route.js` — route definition (already exists)
- `src/middlewares/` — error handling, rate limiter (no changes)
- `src/utils/apiError.js` — custom error class (no changes)
- `src/utils/catchAsync.js` — async wrapper (no changes)
- `src/db/pluggins.js` — Mongoose plugins (no changes)

### Remove

- `src/utils/podioQueueManager.js` — replaced by BullMQ workers
- `bottleneck` npm dependency — replaced by BullMQ rate limiter

### New Files

| #   | File                            | Purpose                                                              |
| --- | ------------------------------- | -------------------------------------------------------------------- |
| 1   | `src/config/redis.js`           | ioredis client + helper functions (idempotency, schema hash)         |
| 2   | `src/queues/index.js`           | 3 BullMQ queue definitions (item-events, app-events, seed)           |
| 3   | `src/queues/primaryWorker.js`   | Consumes item events: GET /item/{id}?hook=false → transform → upsert |
| 4   | `src/queues/secondaryWorker.js` | Consumes app events: schema diff, reseed trigger, app.delete         |
| 5   | `src/db/app-schema.model.js`    | AppSchema model for schema snapshots + diffing                       |
| 6   | `src/scripts/seedApp.js`        | Paginated bulk fetch + bulkWrite upsert (initial seeding)            |

### Updated Files

| #   | File                              | Change                                                                                                                                             |
| --- | --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `src/webhooks/controller.js`      | Replace queueManager.enqueue → BullMQ queue.add with jobId dedup + Redis idempotency. Add handlers for comment, file, tag, app events              |
| 2   | `src/utils/transformPodioItem.js` | Store full raw in `podio_data`, extract `status`, `created_by`                                                                                     |
| 3   | `src/db/podio-item.model.js`      | Add `podio_data` (Mixed), `status`, `created_by`, `podio_created_at`. Add `strict: false`. Expand `sync_status` enum with "deleted", "app_deleted" |
| 4   | `src/db/webhook-state.model.js`   | Keep for fallback crash recovery (staging Map persistence)                                                                                         |
| 5   | `src/index.js`                    | Add Redis connection, BullMQ worker startup, Bull Board mount, updated shutdown                                                                    |
| 6   | `src/app.js`                      | Mount Bull Board at `/admin/queues`                                                                                                                |
| 7   | `src/route.js`                    | Add dashboard API routes (`/api/items`)                                                                                                            |
| 8   | `package.json`                    | Add bullmq, ioredis, @bull-board/api, @bull-board/express. Remove bottleneck                                                                       |
| 9   | `.env.example`                    | Add REDIS_HOST, REDIS_PORT, SEED_DELAY_MS, RATE_LIMIT_MAX                                                                                          |
| 10  | `docker-compose.yml`              | New file — MongoDB + Redis services                                                                                                                |

---

## Implementation Order

Each step unblocks the next. Do not skip ahead.

### Phase 1 — Infrastructure & Config

**Step 1: Docker + Redis setup**

- Create `docker-compose.yml` (MongoDB + Redis with AOF persistence)
- Update `.env.example` with Redis vars
- Update `src/config/config.js` to validate new env vars (REDIS_HOST, REDIS_PORT, SEED_DELAY_MS, RATE_LIMIT_MAX)

**Step 2: `src/config/redis.js`**

- ioredis client connecting to REDIS_HOST:REDIS_PORT
- Export helpers: `checkIdempotency(key)`, `markProcessed(key, ttl)`, `getSchemaHash(appId)`, `setSchemaHash(appId, hash)`
- Export the raw client for BullMQ connection sharing

**Step 3: Install new dependencies**

```bash
npm install bullmq ioredis @bull-board/api @bull-board/express
npm uninstall bottleneck
```

### Phase 2 — Queue Definitions & Models

**Step 4: `src/queues/index.js`**

- Define 3 queues: `podio-item-events`, `podio-app-events`, `podio-seed`
- Default job options: 3 attempts, exponential backoff (2s → 4s → 8s)
- Keep last 1000 completed, 500 failed jobs
- Export queues + Redis connection object

**Step 5: Update `src/db/podio-item.model.js`**

- Add fields: `podio_data` (Mixed), `status`, `created_by`, `podio_created_at`
- Expand sync_status enum: add "deleted", "app_deleted"
- Set `strict: false` on schema options
- Keep existing compound unique index on `{ item_id, app_id }`

**Step 6: `src/db/app-schema.model.js`**

- Fields: `app_id` (Number, unique), `app_name`, `fields` (Mixed), `fields_snapshot` (Mixed), `last_synced_at`
- timestamps: true

### Phase 3 — Transform & Seed

**Step 7: Update `src/utils/transformPodioItem.js`**

- Store full raw response in `podio_data` field
- Extract `status` using label-based field search
- Extract `created_by` from `raw.created_by.name`
- Extract `podio_created_at` from `raw.created_on`
- Keep existing field stripping for `data` field (Option A approach)

**Step 8: `src/scripts/seedApp.js`**

- Accept --app_id CLI argument (single app) or --all flag (seed all registered apps)
- Authenticate via auth.js
- Uses the same POST /item/app/{appId}/filter/?hook=false bulk API (250/hr rate-limited budget)
- Paginated loop: limit=500, offset incrementing until offset >= total
- **Rate limit management**: The seed script shares the 250/hr filter budget with the primary worker's seed queue. To stay safe:
  - Sleep between pages: configurable via SEED_DELAY_MS (default 15000ms = 15s = 240 calls/hr max)
  - When seeding multiple apps, process them sequentially (not in parallel) — same rate limit applies across all apps
  - The BullMQ `podio-seed` queue has its own rate limiter (max 240/duration 3600000) as a second guardrail
- Transform each item → bulkWrite upsert to MongoDB
- Save app schema snapshot to AppSchema collection after complete
- Must be idempotent (re-running produces same state)
- Can also be triggered as a BullMQ job by secondaryWorker
- Logs progress: page X/Y, items upserted, rate limit remaining (from response headers)

### Phase 4 — Workers

**Step 9: `src/queues/primaryWorker.js`**

- Consume `podio-item-events` queue
- Rate limited: 240 calls/hr (BullMQ limiter)
- Concurrency: 1
- On `item.delete`: set sync_status="deleted" in MongoDB (no Podio API call)
- On `item.create`/`item.update`: GET /item/{id}?hook=false → transform → findOneAndUpdate upsert
- 4xx → throw UnrecoverableError (no retry)
- 5xx/network → throw normal error (BullMQ retries with backoff)
- Graceful shutdown: SIGTERM/SIGINT → worker.close()

**Step 10: `src/queues/secondaryWorker.js`**

- Consume `podio-app-events` queue
- On `app.update`: fetch schema from Podio → compare hash via Redis → if changed, diff fields → save snapshot → trigger reseed if structural changes
- On `app.delete`: mark all items as "app_deleted", remove AppSchema, clear Redis hash
- Include `diffSchemas()` function
- Graceful shutdown: SIGTERM/SIGINT → worker.close()

### Phase 5 — Webhook Handler & Server Wiring

**Step 11: Update `src/webhooks/controller.js`**

- Remove `queueManager` import
- Import BullMQ queues from `src/queues/index.js`
- Import Redis helpers from `src/config/redis.js`
- Event routing:
  - `hook.verify` → call Podio verify endpoint (unchanged)
  - `item.create` / `item.update` → Redis idempotency check → itemQueue.add with jobId dedup
  - `item.delete` → itemQueue.add (no idempotency check needed)
  - `comment.create` / `comment.delete` / `file.change` / `tag.add` / `tag.delete` → enqueue parent item_id to itemQueue for refresh
  - `app.update` / `app.delete` → appQueue.add with jobId dedup

**Step 12: Update `src/app.js`**

- Mount Bull Board at `/admin/queues`
- Import queue adapters

**Step 13: Update `src/index.js`**

- Remove queueManager import
- Connect Redis on startup
- Workers can run in-process or as separate processes (start with in-process for simplicity)
- Updated graceful shutdown: close workers → persist any staging state → close Redis → close MongoDB

### Phase 6 — Cleanup & Documentation

**Step 14: Cleanup**

- Delete `src/utils/podioQueueManager.js` (replaced by BullMQ workers)
- Update `README.md` with new architecture, setup steps, docker-compose usage
- Update `.env.example`

---

## Key Decisions for Implementation

1. **Workers in-process vs separate processes**: Start with in-process (all in index.js) for development simplicity. Can split to separate processes later for production scaling using the npm scripts pattern from context.

2. **Keep webhook-state.model.js**: Even with BullMQ, keep the staging Map persistence as a belt-and-suspenders fallback. The context acknowledges worst-case data loss is bounded by FLUSH_DELAY_MS.

3. **Filter API for both seed AND real-time**: Both the seed script and the primary worker use POST /item/app/{appId}/filter/?hook=false (250/hr budget, up to 500 items/call). They share the same 250/hr rate limit, so they must coordinate:
   - Primary worker: BullMQ limiter at 240/hr
   - Seed script: sleep-based throttle (SEED_DELAY_MS between pages)
   - When seeding is running, real-time item processing will be slower (shared budget). Seed jobs should ideally run during off-hours or when webhook volume is low.
   - Multiple apps are seeded sequentially, not in parallel — one shared rate limit for all.

4. **`?hook=false` on ALL Podio read calls**: Prevents infinite webhook loops. This is mandatory.

5. **`strict: false` on PodioItem**: Future-proofs against Podio schema changes. New fields land automatically.

---

## File Map: Context → Our Structure

| Context reference                      | Our file                                                              |
| -------------------------------------- | --------------------------------------------------------------------- |
| `src/podio/auth.js`                    | `src/config/auth.js` (exists)                                         |
| `src/podio/client.js`                  | `src/webhooks/client.js` (exists)                                     |
| `src/queues/index.js`                  | `src/queues/index.js` (new)                                           |
| `src/queues/primaryWorker.js`          | `src/queues/primaryWorker.js` (new)                                   |
| `src/queues/secondaryWorker.js`        | `src/queues/secondaryWorker.js` (new)                                 |
| `src/redis/client.js`                  | `src/config/redis.js` (new)                                           |
| `src/db/models/PodioItem.js`           | `src/db/podio-item.model.js` (update)                                 |
| `src/db/models/AppSchema.js`           | `src/db/app-schema.model.js` (new)                                    |
| `src/db/models/WebhookState.js`        | `src/db/webhook-state.model.js` (keep)                                |
| `src/transforms/transformPodioItem.js` | `src/utils/transformPodioItem.js` (update)                            |
| `src/scripts/seedApp.js`               | `src/scripts/seedApp.js` (new)                                        |
| `src/webhook/server.js`                | `src/index.js` + `src/app.js` + `src/webhooks/controller.js` (update) |
| `src/config/logger.js`                 | `src/config/logger.js` (exists)                                       |
