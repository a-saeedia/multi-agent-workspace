#!/usr/bin/env node
/**
 * Local test for the Task Hub Worker (04-multiagent-orchestration/worker).
 * Stubs KV (in-memory Map) + Response, exercises the full task lifecycle:
 * enqueue -> list -> claim -> complete -> get.
 */
const fs = require("node:fs");
const path = require("node:path");

const SRC = fs.readFileSync(path.join(__dirname, "src", "index.js"), "utf8");
const MOD = SRC.replace(/export default/, "module.exports =");

globalThis.Response = class {
  constructor(body, init = {}) { this.body = body; this.status = init.status || 200; this.headers = new Headers(init.headers); }
  async json() { return JSON.parse(this.body); }
};
globalThis.Headers = class { constructor(h = {}) { this.h = h; } };

const KV = new Map();
const env = {
  AUTH_TOKEN: null,
  TASKS: {
    async put(k, v) { KV.set(k, v); },
    async get(k) { return KV.get(k) ?? null; },
    async delete(k) { KV.delete(k); },
    async list({ prefix }) {
      const keys = [...KV.keys()].filter((k) => k.startsWith(prefix)).map((k) => ({ name: k }));
      return { keys, cursor: null };
    },
  },
};
const worker = eval(MOD);

async function req(method, path2, body) {
  const opts = { method, headers: {} };
  if (body !== undefined) { opts.body = JSON.stringify(body); opts.headers["content-type"] = "application/json"; }
  const r = await worker.fetch(new Request(`https://hub.workers.dev${path2}`, opts), env);
  const j = await r.json().catch(() => null);
  return { status: r.status, body: j };
}

(async () => {
  let pass = 0, fail = 0;
  const t = (name, cond) => { if (cond) { pass++; console.log(`  ok  ${name}`); } else { fail++; console.log(`FAIL  ${name}`); } };

  const h = await req("GET", "/health");
  t("health ok", h.status === 200 && h.body.ok === true && h.body.queue === 0);

  const c = await req("POST", "/tasks", { type: "llm_infer", payload: { text: "hi" } });
  t("enqueue returns 201 + id", c.status === 201 && !!c.body.id && c.body.status === "pending");
  const id = c.body.id;

  const g = await req("GET", `/tasks/${id}`);
  t("get task detail", g.status === 200 && g.body.type === "llm_infer" && g.body.status === "pending");

  const cl = await req("POST", `/tasks/${id}/claim`, { workerId: "w1" });
  t("claim -> running", cl.status === 200 && cl.body.status === "running" && cl.body.claimedBy === "w1" && cl.body.attempts === 1);

  const cl2 = await req("POST", `/tasks/${id}/claim`, { workerId: "w2" });
  t("double-claim rejected (409)", cl2.status === 409);

  const dn = await req("POST", `/tasks/${id}/complete`, { result: { text: "done!" } });
  t("complete -> done", dn.status === 200 && dn.body.status === "done" && dn.body.result.text === "done!");

  const list = await req("GET", "/tasks?status=pending");
  t("pending list empty after completion", list.status === 200 && list.body.count === 0);

  // failure path
  const c2 = await req("POST", "/tasks", { type: "video_analyze", payload: { frames: 5 } });
  await req("POST", `/tasks/${c2.body.id}/claim`, { workerId: "w3" });
  const f = await req("POST", `/tasks/${c2.body.id}/fail`, { error: "model crash" });
  t("fail -> failed with error", f.status === 200 && f.body.status === "failed" && f.body.error === "model crash");

  // validation
  const bad = await req("POST", "/tasks", { payload: {} });
  t("missing type rejected (400)", bad.status === 400);

  // auth
  const envA = { ...env, AUTH_TOKEN: "topsecret" };
  const unauth = await worker.fetch(new Request("https://hub.workers.dev/tasks", { method: "POST", body: JSON.stringify({ type: "x" }) }), envA);
  t("auth enforced", unauth.status === 401);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("harness crash:", e); process.exit(2); });