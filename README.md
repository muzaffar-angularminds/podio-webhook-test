# Podio Webhook Sync Service

A Node.js service that mirrors Podio CRM data into MongoDB in near real-time. Podio sends webhook events when items change, the service queues them via BullMQ (Redis-backed), batches item IDs, fetches data from Podio's filter API, transforms it, and upserts to MongoDB. Built for high-throughput, rate-limit-safe data mirroring across multiple Podio apps.

## Architecture

```
Podio CRM
  |
  |  Webhook (POST /webhooks/podio/:appId)
  v
+--------------------------------------------------+
|  Express Server                                  |
|                                                  |
|  Controller                                      |
|  hook.verify  --> Podio verify API               |
|  item.create  --> Staging Map (Set per app)      |
|  item.update  --> Staging Map (Set per app)      |
|  item.delete  --> Soft delete in MongoDB         |
|  app.update   --> BullMQ app-events queue        |
|  app.delete   --> BullMQ app-events queue        |
|                       |                          |
|              +--------v---------+                |
|              | BullMQ (Redis)   |                |
|              |                  |                |
|              | podio-flush      | Delayed flush  |
|              | podio-batches    | Rate-limited   |
|              | podio-app-events | Schema sync    |
|              | podio-seed       | Initial seed   |
|              +--------+---------+                |
|                       |                          |
|              +--------v---------+                |
|              | Primary Worker   |                |
|              | POST /filter/    |                |
|              | ?hook=false      |                |
|              +--------+---------+                |
|                       |                          |
|              +--------v---------+                |
|              | Transform        |                |
|              | + bulkWrite      |                |
|              +--------+---------+                |
|                       |                          |
|  Multi-App Auth       |   Bull Board UI          |
|  (token per app)      |   /debug/queues          |
+--------------------------------------------------+
                        |
                        v
                   MongoDB
             app_items, app_schemas,
          app_schema_logs, states
```

## How It Works

### Webhook Flow

1. Podio sends a webhook to `POST /webhooks/podio/:appId`
2. Server responds `200 OK` immediately (Podio suspends webhooks after 15 failures)
3. Based on webhook type:
   - **`hook.verify`** -- Calls Podio's verify endpoint to activate the webhook
   - **`item.create` / `item.update`** -- Enqueues item_id into staging Map (Set dedup), schedules delayed flush
   - **`item.delete`** -- Soft deletes item in MongoDB (sets `deleted: true`)
   - **`app.update`** -- Enqueues to app-events queue for schema diff + potential reseed
   - **`app.delete`** -- Enqueues to app-events queue to soft-delete all items

### Queue Processing (BullMQ + Redis)

- **Staging Map**: `Map<appId, Set<itemId>>` for O(1) dedup. Same item 100 times = stored once
- **Flush Trigger**: 2-minute delayed BullMQ job. Timer resets on new webhooks -- user finishes editing before fetch
- **Batch Worker**: Rate-limited at 240 calls/hr (under Podio's 250/hr ceiling). Uses `POST /item/app/{appId}/filter/?hook=false`
- **`?hook=false`**: Prevents infinite webhook loops on all Podio read calls
- **Error Handling**: 4xx = `UnrecoverableError` (no retry). 5xx = exponential backoff (2s, 4s, 8s)
- **Crash Recovery**: Heartbeat persists staging Map to MongoDB every hour. BullMQ jobs survive restarts via Redis

### Data Storage -- Two-Layer Field Model

Each item stores fields in two formats:

**`rawFields`** (Map) -- Full Podio field data keyed by `external_id`. Contains values, metadata, field type, label. Used as backup and for re-extraction.

**`transformedFields`** (Map) -- Flat key:value pairs of only the fields the dashboard needs. Keys use underscores (e.g. `status_dont_touch`). Fast for queries and reads.

```js
// rawFields — full metadata
{
  "status-dont-touch": {
    values: [{ value: { id: 1, text: "New Lead", color: "D1F3EC" } }],
    fieldId: 99838373,
    label: "Status",
    type: "category",
    externalId: "status-dont-touch"
  }
}

// transformedFields — flat key:value for dashboard
{
  status_dont_touch: "New Lead",
  campaign: "DIRECT MAIL",
  datetime_called_in: "2026-04-07 03:20:00",
  icp_score: "5"
}
```

Which fields appear in `transformedFields` is configured per app in `config/apps.js` via `extractFields`.

### Multi-App Authentication

App credentials are stored in `config/apps.js` (static file). Each app authenticates independently.

- `PodioAuthManager` maintains token cache: `Map<appId, { accessToken, refreshToken, expiresAt, appToken }>`
- Shared `clientId`/`clientSecret` from `.env`, per-app `token` from config
- Tokens auto-refresh 60s before expiry, fallback to full re-auth

### Schema Change Detection (Secondary Worker)

When `app.update` webhook fires:

1. Fetches `GET /app/{appId}` for current field definitions
2. Computes MD5 hash, compares with stored `fieldsHash`
3. If changed, runs `diffSchemas()` -- detects: field added, deleted, renamed, type changed, category options changed
4. Saves schema snapshot + logs change to `app_schema_logs`
5. If structural changes detected, triggers full reseed

### Reseed -- Shadow Collection + Atomic Swap

1. **Fetch into shadow**: All items fetched into `podio_items_staging_{appId}`. Old data untouched.
2. **Validate**: Compare shadow count with Podio's reported total
3. **Swap**: Soft-delete old items, `$merge` shadow into `app_items`, hard-delete old, drop shadow
4. **Rollback on failure**: Restore soft-deleted items, preserve shadow for resume
5. **Checkpoint resume**: Progress saved after every page. Resume from last checkpoint on restart.

## Project Structure

```
src/
+-- config/
|   +-- apps.js              # App registry (appId, token, name, extractFields)
|   +-- config.js            # Env var validation (Joi)
|   +-- auth.js              # Multi-app OAuth token manager
|   +-- redis.js             # ioredis client + lock helpers
|   +-- logger.js            # Winston logger
|   +-- morgan.js            # HTTP request logging
+-- models/
|   +-- app-items.model.js   # Synced items (rawFields + transformedFields)
|   +-- app-schema.model.js  # Schema snapshots + reseed tracking
|   +-- app-schema-logs.model.js # Schema change audit trail
|   +-- state.model.js       # Queue crash recovery
|   +-- pluggins.js          # Mongoose plugins (paginate, softDelete)
+-- queues/
|   +-- index.js             # BullMQ queue definitions (4 queues)
|   +-- queueManager.js      # Orchestrator: enqueue, flush scheduling, workers
|   +-- primaryWorker.js     # Flush + Batch workers (Podio fetch + MongoDB upsert)
|   +-- secondaryWorker.js   # App events, schema diff, reseed logic
+-- scripts/
|   +-- seedApp.js           # Seed single app (CLI)
|   +-- seedAll.js           # Seed all apps sequentially
|   +-- reExtract.js         # Rebuild transformedFields from rawFields (no API calls)
+-- utils/
|   +-- transformAppItem.js  # Raw Podio response -> rawFields + transformedFields
|   +-- extractFieldValue.js # Generic Podio field value extractor
|   +-- diffSchemas.js       # Schema comparison utility
|   +-- apiError.js          # Custom API error class
|   +-- catchAsync.js        # Async route handler wrapper
+-- webhooks/
|   +-- controller.js        # Webhook handler (all event types)
|   +-- service.js           # Podio webhook verification
|   +-- client.js            # Axios instance with per-app auth
|   +-- route.js             # POST /:appId route
+-- middlewares/
|   +-- error.js             # Error converter + handler
|   +-- rateLimiter.js       # Rate limiting
+-- app.js                   # Express app, middleware, Bull Board
+-- index.js                 # Entry point, connections, shutdown
+-- route.js                 # Route index
```

## Database Collections

### `app_items` -- Synced Items

| Field | Type | Description |
|---|---|---|
| `itemId` | Number | Podio item ID (unique with appId) |
| `appId` | Number | Podio app ID |
| `appName` | String | App name from config |
| `rawFields` | Map | Full field data keyed by external_id |
| `transformedFields` | Map | Flat key:value of extracted fields (underscore keys) |
| `appItemId` | Number | Per-app sequential ID |
| `title` | String | Item title |
| `createdOn` | Date | Podio creation date |
| `lastEventOn` | Date | Last Podio event date |
| `syncStatus` | String | success, failed, pending |
| `lastSyncedAt` | Date | Last sync time |
| `deleted` | Boolean | Soft delete flag |

**Index**: Compound unique `{ itemId, appId }`

### `app_schemas` -- Schema Snapshots

| Field | Type | Description |
|---|---|---|
| `appId` | Number | Unique |
| `appName` | String | App name |
| `fields` | Mixed | Current field definitions |
| `fieldsHash` | String | MD5 for quick change detection |
| `previousFields` | Mixed | Previous version for diffing |
| `reseedStatus` | String | idle, in_progress, completed, failed |
| `reseedProgress` | Object | `{ current, total }` |

### `app_schema_logs` -- Schema Change Audit Trail

| Field | Type | Description |
|---|---|---|
| `appId` | Number | Which app changed |
| `changes` | Array | `[{ type, fieldId, externalId, label, from, to }]` |
| `triggeredReseed` | Boolean | Did this change trigger a reseed |
| `reseedResult` | String | success, failed, null |
| `fieldsHashBefore` | String | Hash before change |
| `fieldsHashAfter` | String | Hash after change |

### `states` -- Queue Crash Recovery

| Field | Type | Description |
|---|---|---|
| `appId` | String | Podio app ID |
| `pendingItems` | Array | `[{ itemId, createdAt }]` |
| `lastSyncAt` | Date | Last heartbeat |

## Setup

### Prerequisites

- Node.js (v18+)
- MongoDB
- Redis (for BullMQ)
- Podio API credentials (client ID, client secret)

### Installation

```bash
git clone <repo-url>
cd webhook-test
npm install
cp .env.example .env
# Edit .env with your credentials
```

### Register Apps

Add your Podio apps to `src/config/apps.js`:

```js
module.exports = [
  {
    appId: 13038875,
    name: "Call Backs",
    token: "your-app-token",
    extractFields: [
      "status-dont-touch",
      "datetime-called-in",
      "campaign",
    ],
  },
];
```

- `appId` and `token`: from Podio App > Wrench icon > Developer
- `extractFields`: which fields to include in `transformedFields` for the dashboard

### Environment Variables

| Variable | Required | Description |
|---|---|---|
| `NODE_ENV` | Yes | `development`, `production`, or `test` |
| `PORT` | Yes | Server port (default: 8080) |
| `MONGODB_URL` | Yes | MongoDB connection string |
| `PODIO_CLIENT_ID` | Yes | Podio OAuth client ID (shared across all apps) |
| `PODIO_CLIENT_SECRET` | Yes | Podio OAuth client secret |
| `PODIO_WEBHOOK_SECRET` | Yes | Podio webhook secret |
| `REDIS_URL` | Yes | Redis connection URL |
| `FLUSH_DELAY_MS` | No | Queue flush delay (default: 120000 / 2 min) |
| `HEARTBEAT_INTERVAL_MS` | No | State persist interval (default: 3600000 / 1 hr) |
| `BATCH_SIZE` | No | Items per filter API call (default: 500) |
| `SEED_DELAY_MS` | No | Delay between seed pages (default: 18000 / 18s) |

### Running

```bash
# Start the server (development with auto-reload)
npm run dev

# Server endpoints:
# Webhook:      POST /webhooks/podio/:appId
# Health check: GET /status
# Queue UI:     http://localhost:8080/debug/queues
```

## Seeding

### Seed a Single App

```bash
npm run seed -- --app_id=13038875
npm run seed -- --app_id=13038875 --force              # Force reseed
npm run seed -- --app_id=13038875 --resume              # Resume interrupted
npm run seed -- --app_id=13038875 --from=2026-01-01 --to=2026-04-07  # Date range
npm run seed -- --app_id=13038875 --batch_size=200      # Smaller batches
```

### Seed All Apps

```bash
npm run seed:all
npm run seed:all -- --force
npm run seed:all -- --from=2026-01-01 --to=2026-04-07 --batch_size=200
```

Runs apps sequentially (shared rate limit). Each app's data is written to `app_items` as soon as that app finishes -- no waiting for all apps.

### Re-Extract (No API Calls)

When you add/remove fields in `extractFields`, rebuild `transformedFields` from existing `rawFields`:

```bash
npm run re-extract -- --app_id=13038875    # Single app
npm run re-extract -- --all                # All apps
```

Pure DB operation -- no Podio API calls, runs in seconds.

## Rate Limiting

| Operation | Endpoint | Budget | Our limit |
|---|---|---|---|
| Real-time sync | POST /filter/ | 250/hr | 240/hr (BullMQ limiter) |
| Seeding | POST /filter/ | 250/hr (shared) | 200/hr (18s delay) |
| Schema fetch | GET /app/{id} | 1,000/hr | On-demand |

Rate limit 420 responses: pause 60s and retry (doesn't count as failed attempt).

## Health Check

`GET /status` returns:

```json
{ "status": "ok", "mongo": "connected", "redis": "connected" }
```

Returns `503` with `"status": "degraded"` if MongoDB or Redis is disconnected.

## Graceful Shutdown

On `SIGTERM`, `SIGINT`, or uncaught errors:

1. Close all BullMQ workers (finish current jobs)
2. Persist staging Map to MongoDB
3. Close Redis and MongoDB connections
4. Exit

Double-shutdown guard prevents duplicate sequences.
