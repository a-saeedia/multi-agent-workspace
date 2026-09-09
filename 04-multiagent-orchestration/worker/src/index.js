/**
 * P04 Task Hub Worker — Cloudflare-hosted durable task queue (KV-backed).
 *
 * API:
 *   POST /tasks                {type, payload}        -> create task {id, status}
 *   GET  /tasks                ?status=pending        -> list tasks (opt filter)
 *   GET  /tasks/:id            -> task detail
 *   POST /tasks/:id/claim      {workerId}             -> claim for processing
 *   POST /tasks/:id/complete   {result}               -> mark done
 *   POST /tasks/:id/fail       {error}                -> mark failed
 *   GET  /health                                      -> liveness
 *
 * Auth: optional. If AUTH_TOKEN is set, every request must carry
 * `Authorization: Bearer <token>` (except GET /health).
 */
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    // ---- health / auth ----
    if (request.method === "GET" && path === "/health") {
      return json({ ok: true, ts: Date.now(), queue: await countQueued(env) }, 200);
    }
    if (env.AUTH_TOKEN && request.headers.get("Authorization") !== `Bearer ${env.AUTH_TOKEN}`) {
      return json({ error: "unauthorized" }, 401);
    }

    try {
      // ---- POST /tasks ----
      if (request.method === "POST" && path === "/tasks") {
        const body = await request.json().catch(() => ({}));
        if (!body.type || typeof body.type !== "string") {
          return json({ error: "missing field: type" }, 400);
        }
        const id = crypto.randomUUID();
        const task = {
          id,
          type: body.type,
          payload: body.payload ?? {},
          status: "pending",
          createdAt: Date.now(),
          claimedBy: null,
          claimedAt: null,
          result: null,
          error: null,
          attempts: 0,
        };
        await env.TASKS.put(`task:${id}`, JSON.stringify(task), {
          metadata: { status: "pending" },
        });
        await env.TASKS.put(`idx:pending:${id}`, JSON.stringify({ id, type: body.type, createdAt: task.createdAt }));
        return json({ id, status: "pending" }, 201);
      }

      // ---- GET /tasks (list) ----
      if (request.method === "GET" && path === "/tasks") {
        const status = url.searchParams.get("status") || null;
        const prefix = status && status !== "pending" ? null : `idx:${status ?? "pending"}:`;
        const listParams = prefix ? { prefix } : { prefix: "task:" };
        const out = [];
        const list = await env.TASKS.list(listParams);
        for (const key of list.keys) {
          const raw = await env.TASKS.get(key.name);
          if (!raw) continue;
          if (key.name.startsWith("idx:")) {
            const meta = JSON.parse(raw);
            const t = await env.TASKS.get(`task:${meta.id}`);
            if (t) out.push(JSON.parse(t));
          } else {
            out.push(JSON.parse(raw));
          }
        }
        out.sort((a, b) => a.createdAt - b.createdAt);
        return json({ tasks: out, count: out.length }, 200);
      }

      // ---- GET /tasks/:id ----
      const mGet = path.match(/^\/tasks\/([^/]+)$/);
      if (request.method === "GET" && mGet) {
        const raw = await env.TASKS.get(`task:${mGet[1]}`);
        if (!raw) return json({ error: "not found" }, 404);
        return json(JSON.parse(raw), 200);
      }

      // ---- POST /tasks/:id/claim ----
      const mClaim = path.match(/^\/tasks\/([^/]+)\/claim$/);
      if (request.method === "POST" && mClaim) {
        const id = mClaim[1];
        const body = await request.json().catch(() => ({}));
        const workerId = body.workerId || "unknown-worker";
        const lockKey = `lock:${id}`;
        await env.TASKS.put(lockKey, workerId, { expirationTtl: 300 });
        const raw = await env.TASKS.get(`task:${id}`);
        if (!raw) {
          await env.TASKS.delete(lockKey);
          return json({ error: "not found" }, 404);
        }
        const task = JSON.parse(raw);
        if (task.status !== "pending" && task.status !== "retry") {
          await env.TASKS.delete(lockKey);
          return json({ task, error: "not claimable (status: " + task.status + ")" }, 409);
        }
        task.status = "running";
        task.claimedBy = workerId;
        task.claimedAt = Date.now();
        task.attempts += 1;
        await env.TASKS.put(`task:${id}`, JSON.stringify(task), { metadata: { status: "running" } });
        await env.TASKS.delete(`idx:pending:${id}`);
        return json(task, 200);
      }

      // ---- POST /tasks/:id/complete | /tasks/:id/fail ----
      const mDone = path.match(/^\/tasks\/([^/]+)\/(complete|fail)$/);
      if (request.method === "POST" && mDone) {
        const id = mDone[1];
        const ok = mDone[2] === "complete";
        const body = await request.json().catch(() => ({}));
        const raw = await env.TASKS.get(`task:${id}`);
        if (!raw) return json({ error: "not found" }, 404);
        const task = JSON.parse(raw);
        task.status = ok ? "done" : "failed";
        task.result = ok ? (body.result ?? null) : null;
        task.error = ok ? null : (body.error ?? "unknown error");
        task.finishedAt = Date.now();
        await env.TASKS.put(`task:${id}`, JSON.stringify(task), { metadata: { status: task.status } });
        await env.TASKS.delete(`lock:${id}`);
        return json(task, 200);
      }

      return json({ error: "not found" }, 404);
    } catch (e) {
      return json({ error: "internal: " + String((e && e.message) || e) }, 500);
    }
  },
};

async function countQueued(env) {
  try {
    const list = await env.TASKS.list({ prefix: "idx:pending:" });
    return list.keys.length;
  } catch {
    return -1;
  }
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json" },
  });
}