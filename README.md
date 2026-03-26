# Podio Webhook Sync Service

A Node.js service that receives webhooks from Podio CRM, queues item changes, and syncs them to MongoDB using batch API calls. Built for high-throughput, rate-limit-safe data mirroring.

## Architecture

```
Podio CRM
  │
  │  Webhook (POST /webhooks/podio/:appId)
  ▼
┌──────────────────────────────────────────────┐
│  Express Server                              │
│  ┌────────────┐    ┌──────────────────────┐  │
│  │ Controller │───▶│ PodioQueueManager    │  │
│  │            │    │ (Singleton)          │  │
│  │ hook.verify│    │                      │  │
│  │ item.create│    │ Map<appId, Set<id>>  │  │
│  │ item.update│    │        │             │  │
│  │ item.delete│    │   ┌────▼─────┐       │  │
│  └────────────┘    │   │ Flush    │       │  │
│                    │   │ (2 min)  │       │  │
│  ┌────────────┐    │   └────┬─────┘       │  │
│  │ Auth       │    │        │             │  │
│  │ (OAuth)    │◀───│   ┌────▼─────┐       │  │
│  └────────────┘    │   │ Podio    │       │  │
│                    │   │ Filter   │       │  │
│  ┌────────────┐    │   │ API      │       │  │
│  │ Podio      │◀───│   └────┬─────┘       │  │
│  │ Client     │    │        │             │  │
│  │ (Axios)    │    │   ┌────▼─────┐       │  │
│  └────────────┘    │   │Transform │       │  │
│                    │   │ + Upsert │       │  │
│                    │   └────┬─────┘       │  │
│                    └────────┼─────────────┘  │
└─────────────────────────────┼────────────────┘
                              ▼
                         MongoDB
                    (podio_items collection)
```

## How It Works

### Webhook Flow

1. Podio sends a webhook to `POST /webhooks/podio/:appId`
2. The server immediately responds with `200 OK` (Podio requires this within 5 seconds)
3. Based on the webhook type:
   - **`hook.verify`** — Calls Podio's `/hook/{id}/verify/validate` endpoint to confirm the webhook registration
   - **`item.create` / `item.update`** — Enqueues the `item_id` into the in-memory queue (Map with Set per app)
   - **`item.delete`** — Placeholder (no action currently)

### Queue Processing

The `PodioQueueManager` is a singleton that batches and deduplicates webhook events:

- **Deduplication**: Uses `Set<itemId>` per app. If a user edits 10 fields on one item (10 webhooks), only 1 entry is stored
- **Flush Cycle**: Every 2 minutes (configurable), the flush loop:
  1. Snapshots the current Set for each app
  2. Clears the Set (new webhooks go to the next cycle)
  3. Calls Podio's `POST /item/app/{appId}/filter/` API with the item IDs
  4. Transforms the response (strips bloat from raw Podio data)
  5. Upserts to MongoDB via `bulkWrite`
- **Rate Limiting**: Bottleneck library enforces 1 API call per flush interval, staying well within Podio's 250 calls/hr limit on the filter endpoint
- **Error Handling**:
  - 4xx errors (bad request, auth) — logs full Podio response and drops items (retrying won't help)
  - 5xx/network errors — re-enqueues items, retries up to 3 times

### Data Transformation

Raw Podio API responses are ~1500 lines per item. The transformer (`transformPodioItem.js`) strips each field to:

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
- Extracts top-level metadata (`item_id`, `app_id`, `title`, timestamps)

### Crash Recovery

- **Heartbeat**: Every 10 minutes, the current queue state (Map contents) is persisted to the `webhook_state` collection
- **Graceful Shutdown**: On `SIGTERM`, `SIGINT`, or uncaught errors, the queue state is persisted before the server stops
- **Recovery**: On startup, `init()` loads persisted state from MongoDB and re-enqueues all pending items

### Authentication

`PodioAuthManager` (singleton) handles OAuth:

- Authenticates using Podio's app grant type (`grant_type: "app"`)
- Auto-refreshes tokens before they expire (60-second early buffer)
- Falls back to full re-authentication if refresh fails
- The Axios client injects the Bearer token via a request interceptor

## Project Structure

```
src/
├── config/
│   ├── config.js          # Env var validation (Joi) and export
│   ├── auth.js            # PodioAuthManager — OAuth token lifecycle
│   ├── logger.js          # Winston logger setup
│   └── morgan.js          # HTTP request logging
├── db/
│   ├── podio-item.model.js      # Synced Podio items (Mixed data field)
│   ├── webhook-state.model.js   # Queue persistence for crash recovery
│   └── pluggins.js              # Mongoose plugins (paginate, private, softDelete)
├── middlewares/
│   ├── error.js           # Error converter + handler
│   └── rateLimiter.js     # Rate limiting for auth routes
├── utils/
│   ├── podioQueueManager.js   # Queue: dedup, batch fetch, flush, heartbeat
│   ├── transformPodioItem.js  # Strips raw Podio response to clean fields
│   ├── apiError.js            # Custom API error class
│   └── catchAsync.js          # Async route handler wrapper
├── webhooks/
│   ├── controller.js      # Webhook request handler
│   ├── service.js         # Podio webhook verification
│   ├── client.js          # Axios instance with auth + rate limit interceptors
│   └── route.js           # POST /:appId route
├── workers/               # (Reserved for future background jobs)
├── app.js                 # Express app setup and middleware stack
├── index.js               # Server entry point, DB connection, shutdown handlers
└── route.js               # Route index
```

## Database

### `podio_items` Collection

| Field | Type | Description |
|---|---|---|
| `item_id` | Number | Podio item ID (unique with app_id) |
| `app_id` | Number | Podio app ID |
| `data` | Mixed | Stripped fields array (field_id, external_id, label, type, values) |
| `title` | String | Item title from Podio |
| `podio_last_updated_at` | Date | Last event timestamp from Podio |
| `sync_status` | String | "success", "failed", or "pending" |
| `last_synced_at` | Date | When this item was last synced |
| `sync_error` | String | Error message if sync failed |
| `createdAt` | Date | Mongoose auto-managed |
| `updatedAt` | Date | Mongoose auto-managed |

**Index**: Compound unique on `{ item_id, app_id }`

### `webhook_state` Collection

| Field | Type | Description |
|---|---|---|
| `appId` | String | Podio app ID |
| `pendingItems` | Array | `[{ itemId, createdAt }]` — items awaiting processing |
| `lastSyncAt` | Date | Last heartbeat timestamp |

## Setup

### Prerequisites

- Node.js
- MongoDB
- Podio API credentials (client ID, client secret, app ID, app token)

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
| `PODIO_CLIENT_ID` | Yes | Podio OAuth client ID |
| `PODIO_CLIENT_SECRET` | Yes | Podio OAuth client secret |
| `PODIO_APP_ID` | Yes | Podio app ID for authentication |
| `PODIO_APP_TOKEN` | Yes | Podio app token for authentication |
| `PODIO_WEBHOOK_SECRET` | Yes | Podio webhook secret for verification |
| `BATCH_SIZE` | No | Max items per filter API call (default: 500) |
| `FLUSH_INTERVAL_MS` | No | Queue flush interval in ms (default: 120000 / 2 min) |

### Running

```bash
# Development (with auto-reload)
npm run dev

# The server starts on the configured PORT
# Webhook endpoint: POST /webhooks/podio/:appId
# Health check: GET /status
```

## API Endpoints

| Method | Path | Description |
|---|---|---|
| `POST` | `/webhooks/podio/:appId` | Receive Podio webhooks for a specific app |
| `GET` | `/status` | Health check (returns 200) |

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

## Middleware Stack

Applied in order:

1. Morgan HTTP logging (disabled in test)
2. Helmet security headers
3. JSON and URL-encoded body parsing
4. Gzip compression (disabled for `/threads`)
5. CORS (localhost/LAN in dev, all origins in prod)
6. Cookie parser
7. Rate limiter on `/auth` routes (production only — 20 requests per 15 min)
8. Application routes
9. 404 handler
10. Error converter (normalizes to ApiError)
11. Error handler (sends response)

## Graceful Shutdown

On `SIGTERM`, `SIGINT`, uncaught exceptions, or unhandled rejections:

1. Persist queue state to MongoDB (pending items saved)
2. Stop accepting new connections
3. Disconnect from MongoDB
4. Exit process

On next startup, `queueManager.init()` recovers pending items and re-enqueues them.
