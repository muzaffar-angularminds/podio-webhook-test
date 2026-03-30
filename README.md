# Podio Webhook Sync Service

A Node.js service that receives webhooks from Podio CRM, queues item changes via BullMQ (Redis-backed), and syncs them to MongoDB using batch API calls. Built for high-throughput, rate-limit-safe data mirroring across multiple Podio apps.

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
|              | Batch Worker     |                |
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
|  (token per app)      |   /admin/queues          |
|                       |                          |
|  App Registry         |   Admin UI               |
|  (DB-stored creds)    |   /admin/apps            |
+--------------------------------------------------+
                        |
                        v
                   MongoDB
          podio_items, podio_apps,
        app_schemas, webhook_state
```

## How It Works

### Webhook Flow

1. Podio sends a webhook to `POST /webhooks/podio/:appId`
2. The server immediately responds with `200 OK` (Podio requires fast ACK to avoid suspension)
3. Based on the webhook type:
   - **`hook.verify`** -- Calls Podio's `/hook/{id}/verify/validate` endpoint to activate the webhook
   - **`item.create` / `item.update`** -- Enqueues the `item_id` into the staging Map (Set per app for O(1) dedup), schedules a delayed BullMQ flush trigger
   - **`item.delete`** -- Soft deletes the item in MongoDB via mongoose-delete (sets `deleted: true`)
   - **`app.update`** -- Enqueues to app-events queue for schema diff + potential reseed
   - **`app.delete`** -- Enqueues to app-events queue to soft-delete all items and remove schema

### Queue Processing (BullMQ + Redis)

The `PodioQueueManager` uses BullMQ backed by Redis for durable job processing:

- **Staging Map**: In-memory `Map<appId, Set<itemId>>` for fast dedup. Same item enqueued 100 times = stored once
- **Flush Trigger**: When an item is enqueued, a delayed BullMQ job is scheduled (2 min default). If more webhooks arrive for the same app, the timer resets -- ensuring the user finishes editing before data is fetched
- **Batch Worker**: When the flush fires, it snapshots the Set, clears it, and pushes batch jobs to `podio-batches` queue. Rate-limited at 240 calls/hr (under Podio's 250/hr ceiling for the filter endpoint)
- **`?hook=false`**: All Podio API read calls include this parameter to prevent infinite webhook loops
- **Error Handling**:
  - 4xx errors -- `UnrecoverableError`, skips all retries, moves to failed set in Bull Board
  - 5xx/network errors -- BullMQ retries with exponential backoff (2s, 4s, 8s), max 3 attempts
- **Crash Recovery**: Heartbeat persists staging Map to MongoDB every 10 min. On startup, `init()` restores pending items. BullMQ jobs in Redis survive process restarts independently

### Multi-App Authentication

App credentials (appId + appToken) are stored in MongoDB via the App Registry, not in env vars. This supports unlimited Podio apps.

- `PodioAuthManager` maintains a token cache: `Map<appId, { accessToken, refreshToken, expiresAt }>`
- Each app authenticates independently using its own `appToken` + shared `clientId`/`clientSecret` from env
- Tokens auto-refresh 60 seconds before expiry
- The Axios client auto-detects `appId` from the request URL and looks up credentials from DB (with in-memory cache)

### Data Transformation

Raw Podio API responses are ~1500 lines per item. The transformer strips each field to:

```json
{
  "field_id": 123456,
  "external_id": "status-dont-touch",
  "label": "Status",
  "type": "category",
  "values": [{ "value": { "text": "New Lead", "color": "DCEDC8" } }]
}
```

- Drops all `config` and `settings` bloat from each field
- Trims `app` reference values to just `{ item_id, app_item_id, title }`
- Extracts top-level metadata (`itemId`, `appId`, `title`, timestamps)
- Works for any Podio app regardless of field structure

### Schema Change Handling (Secondary Worker)

When Podio fires an `app.update` webhook (someone changed the app's field structure):

1. Secondary worker fetches `GET /app/{appId}` for current schema
2. Computes MD5 hash and compares with stored `fieldsHash` in `app_schemas`
3. If changed, runs `diffSchemas()` to detect: field added, deleted, renamed, type changed, category options changed
4. Saves new schema snapshot (with previous version for reference)
5. If structural changes detected, triggers a full reseed

### Reseed -- Shadow Collection + Atomic Swap

When a reseed is triggered (schema change or manual via seed script):

1. **Fetch into shadow**: All items fetched via paginated filter API into `podio_items_staging_{appId}` -- old data in `podio_items` stays untouched
2. **Validate**: Compare shadow count with Podio's reported total
3. **Swap**: Soft-delete old items -> copy shadow into `podio_items` -> hard-delete old soft-deleted items -> drop shadow
4. **Rollback on failure**: If swap fails, restore soft-deleted items via `mongoose-delete` `.restore()`, drop shadow collection

Dashboard reads from `podio_items` throughout -- no downtime during reseed.

## Project Structure

```
src/
+-- admin/
|   +-- admin.controller.js  # App registry CRUD handlers
|   +-- admin.route.js       # Admin API + page routes
|   +-- views/
|       +-- apps.html        # Admin UI for managing Podio apps
+-- config/
|   +-- config.js            # Env var validation (Joi) and export
|   +-- auth.js              # Multi-app OAuth token manager
|   +-- redis.js             # ioredis client + idempotency helpers
|   +-- logger.js            # Winston logger setup
|   +-- morgan.js            # HTTP request logging
+-- db/
|   +-- podio-item.model.js  # Synced Podio items (soft delete enabled)
|   +-- podio-app.model.js   # App registry (appId, appToken, isActive)
|   +-- app-schema.model.js  # Schema snapshots for diffing + reseed tracking
|   +-- webhook-state.model.js # Queue persistence for crash recovery
|   +-- pluggins.js          # Mongoose plugins (paginate, private, softDelete)
+-- middlewares/
|   +-- error.js             # Error converter + handler
|   +-- rateLimiter.js       # Rate limiting for auth routes
+-- queues/
|   +-- index.js             # BullMQ queue definitions (4 queues)
|   +-- secondaryWorker.js   # App event consumer, schema diff, reseed logic
+-- scripts/
|   +-- seedApp.js           # CLI seed script for initial bulk import
+-- utils/
|   +-- podioQueueManager.js # Queue orchestrator: flush, batch, secondary workers
|   +-- transformPodioItem.js # Strips raw Podio response to clean fields
|   +-- apiError.js          # Custom API error class
|   +-- catchAsync.js        # Async route handler wrapper
+-- webhooks/
|   +-- controller.js        # Webhook request handler (all event types)
|   +-- service.js           # Podio webhook verification
|   +-- client.js            # Axios instance with per-app auth + rate limit logging
|   +-- route.js             # POST /:appId route
+-- app.js                   # Express app setup, middleware, Bull Board
+-- index.js                 # Server entry point, DB/Redis connection, shutdown
+-- route.js                 # Route index
```

## Database Collections

### `podio_items` -- Synced Items

| Field | Type | Description |
|---|---|---|
| `itemId` | Number | Podio item ID (unique with appId) |
| `appId` | Number | Podio app ID |
| `data` | Mixed | Stripped fields array (field_id, external_id, label, type, values) |
| `title` | String | Item title from Podio |
| `podioLastUpdatedAt` | Date | Last event timestamp from Podio |
| `syncStatus` | String | "success", "failed", or "pending" |
| `lastSyncedAt` | Date | When this item was last synced |
| `syncError` | String | Error message if sync failed |
| `deleted` | Boolean | Soft delete flag (mongoose-delete) |
| `deletedAt` | Date | When soft-deleted |

**Index**: Compound unique on `{ itemId, appId }`

### `podio_apps` -- App Registry

| Field | Type | Description |
|---|---|---|
| `appId` | Number | Podio app ID (unique) |
| `appToken` | String | Per-app Podio credential |
| `appName` | String | Human-readable name |
| `spaceId` | Number | Podio workspace ID |
| `isActive` | Boolean | Enable/disable syncing |
| `webhookId` | Number | Podio webhook ID once registered |
| `lastSeededAt` | Date | When last fully seeded |

### `app_schemas` -- Schema Snapshots

| Field | Type | Description |
|---|---|---|
| `appId` | Number | Podio app ID (unique) |
| `appName` | String | App name |
| `fields` | Mixed | Current Podio field definitions |
| `fieldsHash` | String | MD5 hash for quick change detection |
| `previousFields` | Mixed | Previous version for diffing |
| `reseedStatus` | String | "idle", "in_progress", "completed", "failed" |
| `reseedProgress` | Object | `{ current, total }` -- items fetched so far |
| `reseedStartedAt` | Date | When reseed started |
| `reseedError` | String | Error message if reseed failed |

### `webhook_state` -- Queue Crash Recovery

| Field | Type | Description |
|---|---|---|
| `appId` | String | Podio app ID |
| `pendingItems` | Array | `[{ itemId, createdAt }]` -- items awaiting processing |
| `lastSyncAt` | Date | Last heartbeat timestamp |

## Setup

### Prerequisites

- Node.js (v18+)
- MongoDB
- Redis (for BullMQ job queue)
- Podio API credentials (client ID, client secret)

### Installation

```bash
git clone <repo-url>
cd webhook-test
npm install
cp .env.example .env
# Edit .env with your credentials
```

### Environment Variables

| Variable | Required | Description |
|---|---|---|
| `NODE_ENV` | Yes | `development`, `production`, or `test` |
| `PORT` | Yes | Server port (default: 8080) |
| `MONGODB_URL` | Yes | MongoDB connection string |
| `PODIO_CLIENT_ID` | Yes | Podio OAuth client ID (shared across all apps) |
| `PODIO_CLIENT_SECRET` | Yes | Podio OAuth client secret (shared across all apps) |
| `PODIO_WEBHOOK_SECRET` | Yes | Podio webhook secret for verification |
| `REDIS_URL` | Yes | Redis connection URL (default: `redis://localhost:6379`) |
| `BATCH_SIZE` | No | Max items per filter API call (default: 500) |
| `FLUSH_DELAY_MS` | No | Queue flush delay in ms (default: 120000 / 2 min) |
| `SEED_DELAY_MS` | No | Delay between seed pages in ms (default: 15000 / 15s) |

**Note:** Per-app credentials (`appId` + `appToken`) are stored in MongoDB via the Admin UI, not in env vars.

### Running

```bash
# Start the server (development with auto-reload)
npm run dev

# The server starts on the configured PORT
# Webhook endpoint:  POST /webhooks/podio/:appId
# Health check:      GET /status
# Admin UI:          http://localhost:8080/admin/apps
# Queue Monitor:     http://localhost:8080/admin/queues
```

### Registering Podio Apps

Before the service can process webhooks for a Podio app, you must register it:

1. Open the Admin UI at `http://localhost:8080/admin/apps`
2. Fill in the app's ID, token, name, and space ID
3. Click "Register App"
4. The app appears in the table with Active status

You can deactivate/reactivate or delete apps from the same page.

### Running the Seed Script

The seed script bulk-fetches all items from a Podio app into MongoDB. Use it for:
- Initial data import when connecting a new app
- Manual reseed if data gets out of sync

```bash
# Seed a specific app (must be registered and active in the Admin UI first)
npm run seed -- --app_id=30682880
```

**What it does:**
1. Connects to MongoDB
2. Looks up the app in the registry (must be registered and active)
3. Fetches all items via paginated `POST /item/app/{appId}/filter/?hook=false`
4. Sleeps `SEED_DELAY_MS` (default 15s) between pages to respect Podio's 250/hr rate limit
5. Uses the shadow collection approach: fetches into `podio_items_staging_{appId}`, then swaps atomically
6. If the seed fails midway, old data is restored from soft-delete -- no data loss
7. Updates `lastSeededAt` on the app registry entry
8. Logs progress: `Page X/Y, N items fetched`

**Rate limit note:** The seed script shares the 250/hr filter API budget with the real-time batch worker. Run seeds during low webhook volume periods, or when the server is not running.

## API Endpoints

| Method | Path | Description |
|---|---|---|
| `POST` | `/webhooks/podio/:appId` | Receive Podio webhooks for a specific app |
| `GET` | `/status` | Health check (returns 200) |
| `GET` | `/admin/apps` | Admin UI -- manage registered Podio apps |
| `GET` | `/admin/queues` | Bull Board -- inspect BullMQ job queues |
| `GET` | `/admin/api/apps` | List all registered apps (JSON) |
| `POST` | `/admin/api/apps` | Register a new app |
| `PATCH` | `/admin/api/apps/:appId/toggle` | Toggle app active/inactive |
| `DELETE` | `/admin/api/apps/:appId` | Remove an app |

### Webhook Payload (from Podio)

```json
{
  "type": "item.create",
  "hook_id": 24360216,
  "item_id": 3276908608,
  "code": "verification_code"
}
```

The `app_id` comes from the URL parameter (`:appId`), not the request body.

### Supported Webhook Types

| Type | Action |
|---|---|
| `hook.verify` | Calls Podio verify API to activate webhook |
| `item.create` | Enqueues item for batch fetch + upsert |
| `item.update` | Enqueues item for batch fetch + upsert |
| `item.delete` | Soft deletes item in MongoDB |
| `app.update` | Triggers schema diff, reseeds if structural changes |
| `app.delete` | Soft deletes all items, removes schema, deactivates app |

## Middleware Stack

1. Bull Board UI at `/admin/queues`
2. Empty favicon handler (prevents 404 noise)
3. Morgan HTTP logging (disabled in test)
4. Helmet security headers (inline scripts allowed for admin pages)
5. JSON and URL-encoded body parsing
6. Gzip compression
7. CORS (localhost/LAN in dev, all origins in prod)
8. Cookie parser
9. Rate limiter on `/auth` routes (production only)
10. Application routes
11. 404 handler
12. Error converter + handler

## Graceful Shutdown

On `SIGTERM`, `SIGINT`, uncaught exceptions, or unhandled rejections:

1. Close all BullMQ workers (flush, batch, secondary) -- finish current jobs
2. Persist staging Map to MongoDB (pending items saved)
3. Close Redis connection
4. Disconnect from MongoDB
5. Exit process

Double-shutdown guard prevents duplicate shutdown sequences.

On next startup, `queueManager.init()` recovers pending items from MongoDB and re-enqueues them. BullMQ jobs in Redis are restored independently.
