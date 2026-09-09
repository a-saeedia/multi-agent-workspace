# P04 — Multi-Agent Orchestration Layer

Cloudflare-hosted durable task queue + Node dispatch controller. Foundation that
P01 and P02 build on.

## Layout
```
controller/        Node.js orchestration brain (local)
  controller.js    queue, parallel dispatch, aggregation, hub client, CLI
  workers-sample/  sample task handlers + task spec (test data)
worker/            Cloudflare Worker — KV-backed task hub (the durable queue)
  src/index.js     REST API: /tasks (CRUD) /claim /complete /fail /health
  wrangler.toml    KV binding (TASKS -> "arman" namespace)
  test-local.js    local lifecycle test (10 assertions)
```

## How it works
- **Enqueue**: any producer POSTs `{type, payload}` to the hub → gets a uuid, status `pending`.
- **Claim**: consumers POST `/tasks/:id/claim` — KV lock + status guard prevent double-claims (409).
- **Complete/fail**: POST `/tasks/:id/{complete|fail}` with result/error.
- **Controller**: `poll` mode watches pending tasks, runs registered handlers in parallel (concurrency-limited), aggregate results.

## API
```
POST /tasks            {type, payload}                  -> {id, status:"pending"}   201
GET  /tasks            ?status=pending                 -> {tasks[], count}
GET  /tasks/:id        -> task detail
POST /tasks/:id/claim  {workerId}                      -> task (status:"running")   200|409
POST /tasks/:id/complete {result}                      -> task (status:"done")
POST /tasks/:id/fail   {error}                         -> task (status:"failed")
GET  /health           -> {ok, queue: n}
```
Optional auth: set `AUTH_TOKEN` secret; all calls then need `Authorization: Bearer`.

## Run locally (no Cloudflare needed)
```
node 04-multiagent-orchestration/controller/controller.js run ^
  04-multiagent-orchestration/controller/workers-sample/handlers.js ^
  --spec .../workers-sample/tasks.json --concurrency 4
```
→ dispatches 5 tasks across 4 concurrent workers, aggregates results.

## Test
```
node 04-multiagent-orchestration/worker/test-local.js     # 10/10 pass (KV stubbed)
```

## Deploy
```
wrangler deploy        # inside worker/     (needs CLOUDFLARE_API_TOKEN with workers:edit, kv:write)
```
Gives you the durable queue endpoint the controller can poll from anywhere.

## Status
**Implemented & locally verified.** Deploy blocked: the available Cloudflare token is read-only (workers:edit/kv:write needed). See `C:\Users\user\Desktop\multi\projects\README.md` for the bigger picture.