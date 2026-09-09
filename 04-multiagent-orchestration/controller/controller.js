#!/usr/bin/env node
/**
 * P04 Orchestration Controller — Node.js
 *
 * Implements the orchestration loop from the design doc:
 *   1. task generation (enqueue)
 *   2. agent dispatch (parallel workers)
 *   3. parallel processing (concurrency-limited)
 *   4. result aggregation
 *
 * Two execution backends:
 *   - "local"  : run registered JS task handlers in-process (or agent subprocesses)
 *   - "cloud"  : enqueue/claim/complete against the Cloudflare Task Hub Worker
 *
 * Usage:
 *   node controller.js run <taskfile-or-path> --concurrency 4 --backend local
 *   node controller.js enqueue "echo" '{"msg":"hi"}' --hub <url> --token <t>
 *   node controller.js poll --hub <url> --token <t> --concurrency 4 --handler ./handlers.js
 */
const { spawn, execFile } = require("node:child_process");

const FFMPEG = process.env.FFMPEG || "C:\\Users\\User\\tools\\ffmpeg\\ffmpeg.exe";

// ---------------------------------------------------------------------------
// Local queue + in-process dispatch
// ---------------------------------------------------------------------------

/** A minimal in-process task queue. Returns {enqueue, run}. */
function createQueue({ concurrency = 4, handlers = {} } = {}) {
  const queue = [];
  const running = new Set();
  const results = new Map();
  let drainResolvers = [];
  let active = false;

  function enqueue(type, payload, opts = {}) {
    const id = opts.id || (crypto.randomUUID ? crypto.randomUUID() : `t${Date.now()}-${Math.random().toString(36).slice(2)}`);
    queue.push({ id, type, payload, status: "pending", attempts: 0, createdAt: Date.now() });
    results.set(id, { id, type, status: "pending" });
    if (!active) { active = true; pump(); }
    return id;
  }

  function pump() {
    while (running.size < concurrency && queue.length > 0) {
      const task = queue.shift();
      running.add(task.id);
      results.set(task.id, { ...task, status: "running", startedAt: Date.now() });
      runTask(task).then(
        (out) => {
          results.set(task.id, { ...results.get(task.id), status: "done", finishedAt: Date.now(), result: out });
          running.delete(task.id);
        },
        (err) => {
          results.set(task.id, { ...results.get(task.id), status: "failed", finishedAt: Date.now(), error: String(err && err.message || err) });
          running.delete(task.id);
        }
      ).finally(() => {
        if (running.size === 0 && queue.length === 0) {
          active = false;
          drainResolvers.forEach(r => r()); drainResolvers = [];
        } else {
          pump();
        }
      });
    }
  }

  async function runTask(task) {
    const h = handlers[task.type];
    if (!h) throw new Error(`no handler for task type '${task.type}'`);
    return h(task.payload, task);
  }

  function status() {
    return {
      queued: queue.length,
      running: running.size,
      total: results.size,
      byStatus: [...results.values()].reduce((a, r) => { a[r.status] = (a[r.status] || 0) + 1; return a; }, {}),
    };
  }

  function aggregate() {
    return [...results.values()];
  }

  function whenIdle() {
    if (!active && queue.length === 0 && running.size === 0) return Promise.resolve();
    return new Promise((res) => drainResolvers.push(res));
  }

  return { enqueue, status, aggregate, whenIdle };
}

// ---------------------------------------------------------------------------
// Agent subprocess runner (Hermes / OpenCode / FFmpeg as child processes)
// ---------------------------------------------------------------------------

/** Run an external agent CLI (e.g. `opencode run "task"`) and capture stdout. */
function runAgent(cmd, args, { cwd, timeoutMs = 120000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, windowsHide: true, shell: false });
    let stdout = "", stderr = "";
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("agent timeout")); }, timeoutMs);
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    child.on("error", (e) => { clearTimeout(timer); reject(e); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(`agent exit ${code}: ${stderr.trim().slice(0, 500)}`));
    });
  });
}

/** Run an ffmpeg command array, resolve on success. */
function runFfmpeg(args, { ffmpeg = FFMPEG, timeoutMs = 300000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile(ffmpeg, args, { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr || String(err)));
      else resolve(stdout);
    });
  });
}

// ---------------------------------------------------------------------------
// Cloud backend (against the Task Hub Worker)
// ---------------------------------------------------------------------------

function hubClient(base, token) {
  async function req(method, path, body) {
    const headers = { "content-type": "application/json" };
    if (token) headers["authorization"] = `Bearer ${token}`;
    const r = await fetch(base + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`hub ${r.status}: ${JSON.stringify(j.error || j)}`);
    return j;
  }
  return {
    enqueue: (type, payload) => req("POST", "/tasks", { type, payload }),
    health: () => req("GET", "/health"),
    claim: (id, workerId) => req("POST", `/tasks/${id}/claim`, { workerId }),
    complete: (id, result) => req("POST", `/tasks/${id}/complete`, { result }),
    fail: (id, error) => req("POST", `/tasks/${id}/fail`, { error }),
    get: (id) => req("GET", `/tasks/${id}`),
  };
}

/** Poll the hub for pending tasks and process them with the given handlers. */
async function pollHub({ hub, token, concurrency, handlers, workerId, intervalMs = 2500 }) {
  const client = hubClient(hub, token);
  console.log(`[controller] polling ${hub} as '${workerId}' (x${concurrency})`);
  const seen = new Set();

  while (true) {
    const { tasks } = await client.health().catch(() => ({ tasks: [] })); // liveness
    const list = await (async () => {
      try {
        const r = await fetch(`${hub}/tasks?status=pending`, {
          headers: token ? { authorization: `Bearer ${token}` } : {},
        });
        return await r.json();
      } catch { return { tasks: [] }; }
    })().catch(() => ({ tasks: [] }));

    const jobs = (list.tasks || []).filter((t) => !seen.has(t.id)).slice(0, concurrency);
    if (jobs.length) console.log(`[controller] ${jobs.length} pending task(s)`);

    await Promise.all(jobs.map(async (task) => {
      seen.add(task.id);
      let claimed;
      try { claimed = await client.claim(task.id, workerId); } catch { return; }
      const h = handlers[claimed.type];
      if (!h) { await client.fail(claimed.id, `no handler for type '${claimed.type}'`); return; }
      try {
        const result = await h(claimed.payload, claimed);
        await client.complete(claimed.id, result);
        console.log(`[controller] task ${claimed.id} (${claimed.type}) -> done`);
      } catch (e) {
        await client.fail(claimed.id, String(e && e.message || e));
        console.log(`[controller] task ${claimed.id} (${claimed.type}) -> FAILED: ${e && e.message || e}`);
      }
    }));

    await sleep(intervalMs);
  }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);

  if (cmd === "enqueue") {
    const type = rest[0];
    const payload = rest[1] ? JSON.parse(rest[1]) : {};
    const hub = flag(rest, "--hub");
    const token = flag(rest, "--token");
    if (hub) {
      const c = hubClient(hub, token);
      const r = await c.enqueue(type, payload);
      console.log(JSON.stringify(r));
      return;
    }
    // local memory queue demo
    const q = createQueue({ handlers: { [type]: (p) => `handled ${type}: ${JSON.stringify(p)}` } });
    const id = q.enqueue(type, payload);
    await q.whenIdle();
    console.log(JSON.stringify(q.aggregate().find((x) => x.id === id)));
    return;
  }

  if (cmd === "run") {
    const file = rest[0];
    const specFile = flag(rest, "--spec");
    const backend = flag(rest, "--backend") || "local";
    const concurrency = parseInt(flag(rest, "--concurrency") || "4", 10);
    const hub = flag(rest, "--hub");
    const token = flag(rest, "--token");
    const workerId = flag(rest, "--worker-id") || `w-${process.pid}`;

    const handlers = file ? require(require("node:path").resolve(file)) : {};
    if (backend === "cloud") {
      await pollHub({ hub, token, concurrency, handlers, workerId });
      return;
    }
    // Handlers are loaded lazily inside main(); exports are attached below, so
    // re-bind any runAgent/runFfmpeg the handlers destructured at require time.
    const q = createQueue({ concurrency, handlers });
    const spec = require(require("node:path").resolve(specFile || file + ".json"));
    for (const t of spec.tasks) q.enqueue(t.type, t.payload);
    await q.whenIdle();
    console.log(JSON.stringify({ status: q.status(), results: q.aggregate() }, null, 2));
    return;
  }

  if (cmd === "ffmpeg") {
    const r = await runFfmpeg(rest);
    console.log(r);
    return;
  }

  console.log(`usage:
  node controller.js run <handlers.js> [--spec tasks.json] [--backend local|cloud] [--concurrency N] [--hub URL] [--token T] [--worker-id ID]
  node controller.js enqueue <type> <json-payload> [--hub URL] [--token T]
  node controller.js ffmpeg <args...>
`);
}

function flag(args, name) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

module.exports = { createQueue, runAgent, runFfmpeg, hubClient, pollHub };

main().catch((e) => { console.error(e); process.exit(1); });