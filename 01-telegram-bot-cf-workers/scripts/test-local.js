#!/usr/bin/env node
/**
 * Local test harness for the Telegram bot Worker (v3 — کیمیاگر).
 * Stubs fetch (Telegram API), Response, and KV + AI bindings, then replays
 * webhook updates and asserts the handler behavior.
 *
 * Run:  node scripts/test-local.js
 */
const fs = require("node:fs");
const path = require("node:path");

const SRC = fs.readFileSync(path.join(__dirname, "..", "src", "index.js"), "utf8");
const MOD = SRC.replace("export default", "module.exports =");

// ---- stubs ----
const sent = []; // captured sendMessage payloads
const photos = []; // captured sendPhoto payloads
const KV = new Map(); // in-memory KV
let aiCalls = 0;
let callbackAnswers = [];

globalThis.Response = class {
  constructor(body, init = {}) { this.body = body; this.status = init.status || 200; this.headers = new Headers(init.headers); }
  async json() { return JSON.parse(this.body); }
};
globalThis.Headers = class { constructor(h = {}) { this.h = h; } };

globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  if (u.includes("/sendMessage")) {
    const body = JSON.parse(opts.body);
    sent.push(body);
    return { ok: true, json: async () => ({ ok: true, result: body }) };
  }
  if (u.includes("/sendPhoto")) {
    photos.push(String(url));
    return { ok: true, json: async () => ({ ok: true }) };
  }
  if (u.includes("/answerCallbackQuery")) {
    callbackAnswers.push(JSON.parse(opts.body));
    return { ok: true, json: async () => ({ ok: true }) };
  }
  if (u.includes("/sendChatAction")) {
    return { ok: true, json: async () => ({ ok: true }) };
  }
  if (u.includes("/getMe")) {
    return { ok: true, json: async () => ({ ok: true, result: { username: "testbot" } }) };
  }
  if (u.includes("/getFile")) {
    return { ok: true, json: async () => ({ ok: true, result: { file_path: "voice.ogg" } }) };
  }
  if (u.includes("voice.ogg")) {
    return { ok: true, arrayBuffer: async () => new TextEncoder().encode("fake audio").buffer };
  }
  throw new Error("unexpected fetch: " + u);
};

const env = {
  BOT_TOKEN: "FAKE:token",
  ADMIN_ID: "1",
  SECRET: null,
  STATE: {
    async put(k, v) { KV.set(k, v); },
    async get(k, t) { const v = KV.get(k); return t === "json" && v ? JSON.parse(v) : (v ?? null); },
    async delete(k) { KV.delete(k); },
    async list({ prefix }) { const keys = [...KV.keys()].filter((k) => k.startsWith(prefix)).map((k) => ({ name: k })); return { keys, cursor: null }; },
  },
  AI: {
    async run(model, inputs) {
      aiCalls++;
      if (model.includes("llama") || model.includes("gemma")) return { response: "پاسخ فارسی از مدل." };
      if (model.includes("whisper")) return { text: "متن پیام صوتی." };
      if (model.includes("stable-diffusion") || model.includes("sdxl")) return { image: "aGVsbG8=" }; // base64
      return [{ label: "POSITIVE", score: 0.88 }];
    },
  },
};

const worker = MOD.includes("module.exports") ? eval(MOD) : null;

function update(text, id = 1, name = "Tester") {
  return { message: { message_id: 42, chat: { id: 100 + id }, from: { id, first_name: name }, date: 0, text } };
}

async function post(path2, body) {
  let sideEffect = Promise.resolve();
  const r = await worker.fetch(
    new Request(`https://x.workers.dev${path2}`, { method: "POST", body: JSON.stringify(body) }),
    env,
    { waitUntil: (p) => { sideEffect = p; } }
  );
  await sideEffect.catch((e) => console.error("waitUntil:", e.message)); // drain handler
  return r;
}

(async () => {
  let pass = 0, fail = 0;
  const t = (name, cond) => { if (cond) { pass++; console.log(`  ok  ${name}`); } else { fail++; console.log(`FAIL  ${name}`); } };

  // health (no bot fast-path errors)
  const h = await worker.fetch(new Request("https://x.workers.dev/"), env);
  t("GET / returns 200", h.status === 200);
  const hbody = await h.json();
  t("health reports bot", hbody.bot.username === "testbot");

  // /start — Persian welcome + main menu keyboard
  await post("/webhook", update("/start"));
  t("/start sends welcome", sent.some((m) => m.text.includes("کیمیاگر")));
  t("/start has main menu keyboard", sent.some((m) => JSON.stringify(m.reply_markup).includes("menu:latest")));

  // /id — Persian + Persian digits
  await post("/webhook", update("/id"));
  t("/id echoes ids", sent.some((m) => /تو: <code>۱<\/code>/.test(m.text)));

  // /echo
  await post("/webhook", update("/echo hello world"));
  t("/echo mirrors text", sent.some((m) => m.text === "hello world"));

  // /ai (stubbed AI binding) — Persian mood label
  await post("/webhook", update("/ai great day"));
  t("/ai uses AI binding", aiCalls === 1 && sent.some((m) => m.text.includes("مثبت")));

  // /learn + /recall persisted in KV
  await post("/webhook", update("/learn color=blue"));
  await post("/webhook", update("/recall color"));
  t("learn/recall roundtrip", sent.some((m) => m.text === "🧠 color = blue"));

  // /latest with empty content store
  await post("/webhook", update("/latest"));
  t("/latest empty store message", sent.some((m) => /هنوز ابزاری منتشر نشده/.test(m.text)));

  // /list with empty content store
  await post("/webhook", update("/list"));
  t("/list empty store message", sent.some((m) => /لیست هنوز خالیه/.test(m.text)));

  // /broadcast gated to admin (first registered user = admin when no ADMIN_ID)
  await post("/webhook", update("/broadcast hello all", 1, "Tester"));
  t("/broadcast admin allowed", sent.some((m) => /ارسال شد: ۱ نفر/.test(m.text)));
  await post("/webhook", update("/broadcast hello", 2, "UserTwo"));
  t("/broadcast non-admin blocked", sent.some((m) => m.text === "⛔ فقط ادمین."));

  // /stats as admin — Persian funnel stats, Persian digits
  await post("/webhook", update("/stats", 1, "Tester"));
  t("/stats admin shows users", sent.some((m) => /کاربران: ۲/.test(m.text)));
  await post("/webhook", update("/stats", 2, "UserTwo"));
  t("/stats non-admin blocked", sent.some((m) => m.text === "⛔ فقط ادمین."));

  // unknown command -> Persian default help
  await post("/webhook", update("/nosuchcmd", 1, "Tester"));
  t("unknown command default help", sent.some((m) => m.text.includes("نمیفهمم")));

  // free text -> AI chatbot (llama path)
  await post("/webhook", update("random chatter", 1, "Tester"));
  t("free text hits chatbot", sent.some((m) => /پاسخ فارسی/.test(m.text)));

  // /chat explicit
  await post("/webhook", update("/chat hello", 1, "Tester"));
  t("/chat replies", sent.some((m) => /پاسخ فارسی/.test(m.text)));

  // chat memory persists under mem:<uid> (no collision with chat:<chatId> tally)
  const mem = await env.STATE.get("mem:1", "json");
  t("chat memory persisted", Array.isArray(mem) && mem.some((m) => m.t === "hello"));
  t("chat tally is a timestamp, not an array", typeof KV.get("chat:101") === "string" && !KV.get("chat:101").startsWith("[{"));

  // /summary
  await post("/webhook", update("/summary lots of text here", 1, "Tester"));
  t("/summary replies", sent.some((m) => /خلاصه/.test(m.text)));

  // /imagine -> sendPhoto
  await post("/webhook", update("/imagine a golden robot", 1, "Tester"));
  t("/imagine sends photo", photos.length === 1 && sent.some((m) => m.text.includes("دارم تصویر میسازم")));

  // voice note -> whisper -> text reply
  await post("/webhook", { message: { message_id: 43, chat: { id: 101 }, from: { id: 1, first_name: "Tester" }, date: 0, voice: { file_id: "voi123", duration: 2 } } });
  t("voice transcribes", sent.some((m) => /متن پیام صوتی/.test(m.text)));

  // shop: seed products, /shop lists, /order creates + notifies admin
  await env.STATE.put("content:products", JSON.stringify([{ id: "p1", name: "اشتراک AI", desc: "دسترسی VIP", price: "۵۰۰ هزار تومان" }]));
  await post("/webhook", update("/shop", 3, "Buyer"));
  t("/shop lists products", sent.some((m) => /اشتراک AI/.test(m.text)));
  await post("/webhook", update("/order p1", 3, "Buyer"));
  t("/order confirms", sent.some((m) => /سفارش ثبت شد/.test(m.text)));
  t("/order notifies admin", sent.some((m) => /سفارش جدید/.test(m.text)));
  const orders = await env.STATE.list({ prefix: "order:" });
  t("order persisted in KV", orders.keys.length === 1);

  // duplicate claim blocked while pending
  await post("/webhook", update("/order p1", 3, "Buyer"));
  t("duplicate order blocked", sent.some((m) => /قبلاً سفارش/.test(m.text)));

  // /myorders for the buyer
  await post("/webhook", update("/myorders", 3, "Buyer"));
  t("/myorders lists order", sent.some((m) => /اشتراک AI/.test(m.text) && /در انتظار/.test(m.text)));

  // /orders admin-only
  await post("/webhook", update("/orders", 3, "Buyer"));
  t("/orders non-admin blocked", sent.some((m) => m.text === "⛔ فقط ادمین."));
  await post("/webhook", update("/orders", 1, "Tester"));
  t("/orders admin lists", sent.some((m) => /سفارشهای باز: ۱/.test(m.text)));

  // /paid admin flow
  const oid = orders.keys[0].name.slice("order:".length);
  await post("/webhook", update(`/paid ${oid}`, 1, "Tester"));
  t("/paid confirms and notifies buyer", sent.some((m) => /تأیید شد/.test(m.text)));
  const paidOrder = await env.STATE.get(`order:${oid}`, "json");
  t("/paid persists status", paidOrder.status === "paid");

  // /trending empty
  await post("/webhook", update("/trending", 1, "Tester"));
  t("/trending no report yet", sent.some((m) => /هنوز آماده نشده/.test(m.text)));

  // ---- v3 callback tests ----
  const sentBefore = sent.length;
  await post("/webhook", { callback_query: { id: "c1", from: { id: 1, first_name: "Tester" }, data: "menu:latest", message: { message_id: 5, chat: { id: 101 } } } });
  t("callback answers", callbackAnswers.some((a) => a.callback_query_id === "c1"));
  t("callback menu:latest dispatches", sent.length > sentBefore);

  // place order via buy: callback
  const sentBefore2 = sent.length;
  await post("/webhook", { callback_query: { id: "c2", from: { id: 4, first_name: "CBuyer" }, data: "buy:p1", message: { message_id: 6, chat: { id: 104 } } } });
  t("callback buy: creates order", sent.length > sentBefore2 && sent.slice(sentBefore2).some((m) => /سفارش ثبت شد/.test(m.text)));

  // admin panel callback
  await post("/webhook", { callback_query: { id: "c3", from: { id: 1 }, data: "panel:stats", message: { message_id: 7, chat: { id: 101 } } } });
  t("callback panel:stats admin only", sent.some((m) => /آمار کیمیاگر/.test(m.text)));

  // non-admin panel blocked
  await post("/webhook", { callback_query: { id: "c4", from: { id: 4 }, data: "panel:stats", message: { message_id: 8, chat: { id: 104 } } } });
  t("callback panel non-admin blocked", sent.some((m) => m.text === "⛔ فقط ادمین."));

  // referral: new user via deep link -> credited to admin (uid 1)
  await post("/webhook", update("/start REF_1", 7, "RefUser"));
  const refCount = await env.STATE.get("ref:1");
  t("referral credited", String(refCount) === "1");
  t("referrer notified", sent.some((m) => /دعوت جدید/.test(m.text)));

  // /ref shows link
  await post("/webhook", update("/ref", 7, "RefUser"));
  t("/ref shows link", sent.some((m) => /REF_7/.test(m.text) && /دعوتشدهها/.test(m.text)));

  // /about
  await post("/webhook", update("/about", 7, "RefUser"));
  t("/about explains bot", sent.some((m) => /درباره «کیمیاگر»/.test(m.text)));

  // ---- REST APIs ----
  async function postRaw(path2, body, headers = {}) {
    let sideEffect = Promise.resolve();
    const r = await worker.fetch(
      new Request(`https://x.workers.dev${path2}`, { method: "POST", headers, body: body ? JSON.stringify(body) : undefined }),
      env,
      { waitUntil: (p) => { sideEffect = p; } }
    );
    await sideEffect.catch((e) => { /* job may throw when feeds down */ });
    return r;
  }
  const cronRes = await postRaw("/cron", null);
  t("cron unauth 401", cronRes.status === 401);
  const cronRes2 = await postRaw("/cron", null, { authorization: "Bearer 1" });
  t("cron admin 200", cronRes2.status === 200);

  const putBad = await worker.fetch(new Request("https://x.workers.dev/content", {
    method: "PUT", body: JSON.stringify({ latest: { name: "x" }, list: [] }),
  }), env);
  t("content PUT unauthenticated 401", putBad.status === 401);
  const okPut = await worker.fetch(new Request("https://x.workers.dev/content", {
    method: "PUT", headers: { authorization: "Bearer 1" }, body: JSON.stringify({ latest: { name: "ToolA" }, list: [{ name: "ToolA" }, { name: "ToolB" }] }),
  }), env);
  t("content PUT admin 200", okPut.status === 200);
  const got = await worker.fetch(new Request("https://x.workers.dev/content"), env);
  const gotBody = await got.json();
  t("content GET returns store", gotBody.latest?.name === "ToolA" && gotBody.list?.length === 2);

  // products API
  const gotP = await worker.fetch(new Request("https://x.workers.dev/products"), env);
  t("products GET returns catalog", (await gotP.json()).list?.length >= 1);

  // bad auth when SECRET set
  const envSec = { ...env, SECRET: "s3cret" };
  const rBad = await worker.fetch(new Request("https://x.workers.dev/webhook", { method: "POST", body: JSON.stringify(update("/start")) }), envSec);
  t("webhook rejects missing secret", rBad.status === 403);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("harness crash:", e); process.exit(2); });