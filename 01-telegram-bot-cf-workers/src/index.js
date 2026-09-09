/**
 * P01 Telegram Funnel Bot — Cloudflare Worker v3 (کیمیاگر / The Alchemist).
 *
 * Polished, fully-Persian AI assistant + funnel + shop + weekly trends.
 * All state in KV (STATE binding), AI via Workers AI binding, webhook delivery,
 * cron triggers for the weekly trend engine and daily tool post.
 *
 * Secrets (wrangler secret put):
 *   BOT_TOKEN  — from @BotFather
 *   ADMIN_ID   — numeric Telegram id of the owner
 *   SECRET     — optional webhook secret token
 *
 * ---------------------------------------------------------------------------
 * COMMAND SURFACE (all Farsi)
 *   /start                welcome + inline main menu (handles ?start=REF_<uid> referrals)
 *   /cheat <text>|فری‌تکست  chatbot (llama-3.3-70b, per-user memory, typing indicator)
 *   /imagine <prompt>     text-to-image (SDXL lightning)
 *   /summary <text>       Persian summary
 *   voice message         Whisper transcription -> replied + fed to chat
 *   /trending             this week's AI platforms report
 *   /shop                 product cards with buy buttons
 *   /order <id>           place order
 *   /myorders             your last orders + status
 *   /ref                  your referral link + stats
 *   /help /about          help text / about
 *   /broadcast <text>     admin: DM all users
 *   /stats                admin: users / orders / products / referrals
 *   /orders               admin: open orders with confirm buttons
 *   /paid <oid>           admin: mark paid
 *   /deliver <oid>        admin: mark delivered
 *   /panel                admin: inline admin panel
 *   /latest /list /adminid /id /who /echo /ai /learn /recall
 *
 * Inline callbacks: menu:*, back:menu, buy:<pid>, panel:*, paid:<oid>,
 *   deliver:<oid>, cancel:<oid>
 *
 * REST APIs (all JSON)
 *   GET  /                      health + bot info
 *   GET  /content               public tool store   | PUT (admin Bearer)
 *   GET  /products              shop catalog        | PUT (admin Bearer)
 *   GET  /orders   (admin)      all orders
 *   POST /cron     (admin)      run weekly trend job now
 *
 * Cron:  0 9 * * *  daily  -> post "ابزار امروز" (content:latest) to channel
 *         0 10 * * 1 weekly -> research + Farsi report + post to @cyberalchemistt
 *                              + auto-refill /latest + /list
 * ---------------------------------------------------------------------------
 */
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/") return json(await health(env));

    if (url.pathname === "/content") {
      if (request.method === "GET") return json({ ok: true, ...(await readContent(env)) });
      if (request.method === "PUT") {
        if (!isAdminReq(request, env)) return json({ error: "unauthorized" }, 401);
        const b = await request.json().catch(() => null);
        if (!b) return json({ error: "bad body" }, 400);
        await putContent(env, b.latest === undefined ? null : b.latest, Array.isArray(b.list) ? b.list : []);
        return json({ ok: true, latest: b.latest ?? null, count: Array.isArray(b.list) ? b.list.length : 0 });
      }
      return json({ error: "method" }, 405);
    }

    if (url.pathname === "/products") {
      if (request.method === "GET") return json({ ok: true, list: await readProducts(env) });
      if (request.method === "PUT") {
        if (!isAdminReq(request, env)) return json({ error: "unauthorized" }, 401);
        const b = await request.json().catch(() => null);
        if (!Array.isArray(b)) return json({ error: "bad body (array expected)" }, 400);
        await env.STATE.put("content:products", JSON.stringify(b));
        return json({ ok: true, count: b.length });
      }
      return json({ error: "method" }, 405);
    }

    if (url.pathname === "/orders" && request.method === "GET") {
      if (!isAdminReq(request, env)) return json({ error: "unauthorized" }, 401);
      return json({ ok: true, orders: await listOrders(env) });
    }

    if (url.pathname === "/cron" && request.method === "POST") {
      if (!isAdminReq(request, env)) return json({ error: "unauthorized" }, 401);
      ctx.waitUntil(runWeeklyTrends(env).catch((e) => console.error("cron:", e)));
      return json({ ok: true, running: true });
    }

    if (request.method === "POST" && url.pathname === "/webhook") {
      const u = await request.json().catch(() => null);
      if (!u) return json({ error: "bad update" }, 400);
      if (env.SECRET && request.headers.get("X-Telegram-Bot-Api-Secret-Token") !== env.SECRET) {
        return json({ error: "bad secret" }, 403);
      }
      ctx.waitUntil(handleUpdate(u, env).catch((e) => console.error("handler:", e)));
      return json({ ok: true });
    }

    return json({ error: "not found" }, 404);
  },

  async scheduled(event, env, ctx) {
    if (String(event.cron || "").includes("10")) {
      ctx.waitUntil(runWeeklyTrends(env).catch((e) => console.error("sched:", e)));
    } else {
      ctx.waitUntil(postDailyTool(env).catch((e) => console.error("sched:", e)));
    }
  },
};

// ---------------------------------------------------------------------------
// Main update dispatcher (messages + callbacks)
// ---------------------------------------------------------------------------

async function handleUpdate(u, env) {
  // ---- inline callback ----
  if (u.callback_query) {
    const cb = u.callback_query;
    const chat = cb.message?.chat;
    if (!chat) return;
    const from = cb.from || {};
    const d = String(cb.data || "");
    const adminId = env.ADMIN_ID || (await env.STATE.get("meta:admin"));
    const isAdmin = String(from.id ?? "") === String(adminId);
    await answerCallback(env, cb.id);
    await handleCommand(env, d, chat, from, isAdmin);
    return;
  }

  const msg = u.message;
  if (!msg || msg.chat?.type === "channel") return;
  const chat = msg.chat;
  const from = msg.from || {};
  if (!chat?.id) return;
  await registerUser(env, from, chat.id);

  const adminId = env.ADMIN_ID || (await env.STATE.get("meta:admin"));
  const isAdmin = String(from.id ?? chat.id) === String(adminId);

  // deep-link referral: /start REF_123 (t.me/bot?start=)
  if (String(msg.text || "").startsWith("/start")) {
    const payload = String(msg.text || "").trim().split(/\s+/)[1] || "";
    if (payload.startsWith("REF_")) await creditReferral(env, from, payload.slice(4));
  }

  // voice note -> transcribe + chat
  if (msg.voice?.file_id || msg.audio?.file_id) {
    const fid = msg.voice?.file_id || msg.audio?.file_id;
    await typing(env, chat.id);
    const text = await transcribeVoice(env, fid).catch(() => null);
    if (!text) return send(env, chat.id, "✖️ نتونستم صداتو بفهمم. یه پیام دیگه بفرست یا متن بفرست.");
    await send(env, chat.id, `🎙️ <i>«${esc(text)}»</i>`);
    const reply = await chatReply(env, from.id, `(پیام صوتی:) ${text}`).catch((e) => fallbackChat(e));
    return sendPlain(env, chat.id, reply);
  }

  const text = (msg.text || "").trim();
  if (!text) return send(env, chat.id, "⌨️ فقط متن، صدا یا دستور میفهمم.");
  return handleCommand(env, text, chat, from, isAdmin);
}

async function handleCommand(env, text, chat, from, isAdmin) {
  const chatId = chat.id;
  const uid = from.id ?? chatId;
  const [cmd, ...rest] = text.split(/\s+/);
  const arg = rest.join(" ").trim();
  const reply = (html, mk = null) => (mk ? send(env, chatId, html, mk) : send(env, chatId, html));
  const replyPlain = (t) => sendPlain(env, chatId, t);

  // ---- callback data routes ----
  if (cmd.startsWith("buy:")) return placeOrder(env, from, chat, cmd.slice(4), isAdmin, reply);
  if (cmd.startsWith("paid:")) return paidOrder(env, cmd.slice(5), isAdmin, reply);
  if (cmd.startsWith("deliver:")) return deliverOrder(env, cmd.slice(8), isAdmin, reply);
  if (cmd.startsWith("cancel:")) return cancelOrder(env, cmd.slice(7), isAdmin, reply);
  if (cmd.startsWith("panel:")) return panelAction(env, cmd.slice(6), from, chat, isAdmin, reply);
  if (cmd === "back:menu") return reply("🗂 منوی اصلی:", mainMenu());
  if (cmd === "menu:latest") return showLatest(env, reply);
  if (cmd === "menu:list") return showList(env, reply);
  if (cmd === "menu:shop") return showShop(env, reply);
  if (cmd === "menu:trending") return showTrending(env, reply);
  if (cmd === "menu:help") return reply(helpText(), mainMenu());
  if (cmd === "menu:ref") return showRef(env, uid, reply);
  if (cmd === "menu:imagine") return reply("🎨 بساز! مثال: /imagine یک ربات طلایی در شهر آینده", mainMenu());

  switch (cmd) {
    case "/start": {
      const who = from.first_name || "";
      return reply(
        `⚗️ <b>خوش اومدی ${esc(who)}!</b>\n` +
        `من «کیمیاگر» هستم — دستیار هوشمند فارسیات.\n` +
        `ابزارهای رایگان AI، ترندهای هفته، آموزش و فروشگاه تخصصی. 🔥\n\n` +
        `🧰 ابزار امروز: /latest\n🔥 ترندهای هفته: /trending\n🛒 فروشگاه: /shop\n🤖 چت آزاد: همینجا هرچی خواستی بنویس!\n\n` +
        `📌 کانال: <a href="https://t.me/cyberalchemistt">Cyber Alchemist</a>`,
        mainMenu()
      );
    }
    case "/menu":
      return reply("🗂 منوی اصلی:", mainMenu());
    case "/help":
      return reply(helpText(), mainMenu());
    case "/about":
      return reply(
        `⚗️ <b>درباره «کیمیاگر»</b>\n\n` +
        `ربات هوشمند کانال Cyber Alchemist برای کیمیاگری با تکنولوژی.\n` +
        `ساخته‌شده روی Cloudflare Workers: بدون سرور، بدون هزینه، ۲۴/۷.\n\n` +
        `✨ امکانات:\n` +
        `• چت‌بات فارسی با حافظه (AI)\n` +
        `• ساخت تصویر با هوش مصنوعی\n` +
        `• تبدیل صدای شما به متن\n` +
        `• ترندهای هفتگی پلتفرم‌های AI\n` +
        `• فروشگاه و سفارش آنلاین\n` +
        `• سیستم دعوت دوستان\n\n` +
        `🆔 ایدی تو: <code>${faNum(uid)}</code>`
      );
    case "/latest":
      return showLatest(env, reply);
    case "/list":
      return showList(env, reply);
    case "/trending":
      return showTrending(env, reply);

    // ---------------------------- AI assistant ------------------------------
    case "/chat": {
      if (!arg) return reply("🤖 بگو، گوش میدم: `/chat <متن>` یا همینجا بنویس!");
      await typing(env, chatId);
      const res = await chatReply(env, uid, arg).catch((e) => fallbackChat(e));
      return replyPlain(res);
    }
    case "/summary": {
      if (!arg) return reply("📝 متن رو بفرست: `/summary <متن>`");
      await typing(env, chatId);
      const s = await summarize(env, arg).catch((e) => fallbackChat(e));
      return send(env, chatId, `📝 <b>خلاصه:</b>\n${esc(s)}`);
    }
    case "/imagine": {
      if (!arg) return reply("🎨 چی می‌خوای بسازم؟ مثال: `/imagine ربات طلایی`");
      await send(env, chatId, "🎨 دارم تصویر می‌سازم… چند ثانیه صبر کن");
      await typing(env, chatId, "upload_photo");
      try {
        const img = await imagine(env, arg);
        return await sendPhoto(env, chatId, img, `🎨 ${arg}`);
      } catch (e) {
        console.error("imagine:", e.message || e);
        return reply("✖️ ساخت تصویر خطا خورد. بعداً دوباره تلاش کن.");
      }
    }

    // ------------------------------- shop -----------------------------------
    case "/shop":
      return showShop(env, reply);
    case "/order": {
      if (!arg) return reply("🛍 استفاده: /order <ایدی محصول>. لیست: /shop");
      return placeOrder(env, from, chat, arg, isAdmin, reply);
    }
    case "/myorders": {
      const mine = (await listOrders(env)).filter((o) => String(o.uid) === String(uid)).slice(0, 5);
      if (!mine.length) return reply("🧾 هنوز سفارشی نداری. /shop");
      const lines = mine.map((o) => `#${o.id} • ${esc(o.product)} • ${orderStatus(o)}`);
      return reply(`🧾 <b>سفارش‌های تو</b>\n\n${lines.join("\n")}`);
    }

    // ------------------------------ referral --------------------------------
    case "/ref":
      return showRef(env, uid, reply);

    // ------------------------------- admin ----------------------------------
    case "/panel": {
      if (!isAdmin) return reply("⛔ فقط ادمین.");
      return reply("🛠 <b>پنل مدیریت</b>", adminPanel());
    }
    case "/stats": {
      if (!isAdmin) return reply("⛔ فقط ادمین.");
      const users = await countPrefix(env.STATE, "user:");
      const orders = await listOrders(env);
      const products = await readProducts(env);
      const c = await readContent(env);
      const refs = await countPrefix(env.STATE, "ref:");
      const tr = await env.STATE.get("trends:latest", "json").catch(() => null);
      return reply(
        `📊 <b>آمار کیمیاگر</b>\n\n` +
        `👥 کاربران: ${faNum(users)}\n` +
        `🧰 ابزارها: ${faNum((c.list || []).length)}\n` +
        `🛍 محصولات: ${faNum(products.length)}\n` +
        `🧾 سفارش‌های باز: ${faNum(orders.filter((o) => o.status === "new").length)}\n` +
        `🎁 دعوت‌ها: ${faNum(refs)}\n` +
        `🔥 هفته گزارش: ${tr?.week || "—"}`
      );
    }
    case "/orders": {
      if (!isAdmin) return reply("⛔ فقط ادمین.");
      const fresh = (await listOrders(env)).filter((o) => o.status === "new");
      if (!fresh.length) return reply("✅ سفارش باز نیست!", adminPanel());
      const cards = fresh.map((o) => {
        const name = esc(o.name || o.username || "کاربر");
        return `<b>#${o.id}</b> • ${esc(o.product)} • ${esc(o.price || "")}\n👤 ${name} (@${esc(o.username || "—")}) [${faNum(o.uid)}]`;
      }).join("\n\n");
      return reply(`🧾 <b>سفارش‌های باز: ${faNum(fresh.length)}</b>\n\n${cards}`, orderButtons(fresh));
    }
    case "/paid":
      if (!isAdmin) return reply("⛔ فقط ادمین.");
      if (!arg) return reply("استفاده: /paid <شماره سفارش>");
      return paidOrder(env, arg, isAdmin, reply);
    case "/deliver":
      if (!isAdmin) return reply("⛔ فقط ادمین.");
      if (!arg) return reply("استفاده: /deliver <شماره سفارش>");
      return deliverOrder(env, arg, isAdmin, reply);
    case "/broadcast": {
      if (!isAdmin) return reply("⛔ فقط ادمین.");
      const payload = text.slice("/broadcast".length).trim();
      if (!payload) return reply("📣 استفاده: /broadcast <متن>");
      let sent = 0, failed = 0;
      let page = await env.STATE.list({ prefix: "user:" });
      while (true) {
        for (const k of page.keys) {
          const u = await env.STATE.get(k.name, "json").catch(() => null);
          if (!u?.id) { failed++; continue; }
          try { await send(env, u.id, payload); sent++; } catch { failed++; }
        }
        if (!page.cursor) break;
        page = await env.STATE.list({ prefix: "user:", cursor: page.cursor });
      }
      return reply(`📣 ارسال شد: ${faNum(sent)} نفر${failed ? ` (${faNum(failed)} ناموفق)` : ""}`);
    }

    // ------------------------------ misc ------------------------------------
    case "/adminid":
      return reply(`🆔 ایدی عددی تو: <code>${faNum(uid)}</code>`);
    case "/id":
      return reply(`🆔 تو: <code>${faNum(uid)}</code>\n📩 چت: <code>${faNum(chatId)}</code>`);
    case "/who": {
      const u = await env.STATE.get(`user:${uid}`, "json").catch(() => null);
      if (!u) return reply("🤔 هنوز نمیشناسمت — /start بزن!");
      return reply(
        `👤 <b>${esc(u.first_name || "")}</b>\n` +
        `@${esc(u.username || "—")}\n` +
        `🆔 ${faNum(u.id)}\n` +
        `📅 عضویت: ${faNum(new Date(u.firstSeenAt).toLocaleDateString("fa-IR"))}\n` +
        `💬 پیامها: ${faNum(u.payloadCount)}`
      );
    }
    case "/echo":
      return reply(esc(arg || "…"));
    case "/ai":
      if (!arg) return reply("🤖 یه جمله بفرست مثل /ai هوا امروز عالیه");
      await typing(env, chatId);
      try {
        const r = await env.AI.run("@cf/huggingface/distilbert-sst-2-int8", { text: arg.slice(0, 500) });
        const top = r?.[0] || { label: "?", score: 0 };
        const mood = top.label === "POSITIVE" ? "😊 مثبت" : "😒 منفی";
        return reply(`${mood} (${faNum(Number((top.score * 100).toFixed(0)))})`);
      } catch {
        return reply("✖️ AI الان جواب نمیده، بعداً تلاش کن.");
      }
    case "/learn": {
      const [k, v] = arg.split("=");
      if (!k || !v) return reply("آموزش: /learn کلید=مقدار");
      await env.STATE.put(`pair:${k}`, v);
      return reply(`🧠 یاد گرفتم: ${esc(k)} = ${esc(v)}`);
    }
    case "/recall": {
      const v = await env.STATE.get(`pair:${arg}`).catch(() => null);
      return reply(v !== null ? `🧠 ${esc(arg)} = ${esc(v)}` : `یادم نیست «${esc(arg)}» — /learn ${esc(arg)}=مقدار`);
    }

    // ---------------------- free text -> chatbot ----------------------------
    default:
      if (!cmd.startsWith("/")) {
        await typing(env, chatId);
        const res = await chatReply(env, uid, text).catch((e) => fallbackChat(e));
        return replyPlain(res);
      }
      return reply("من این دستور رو نمیفهمم. /help بزن 👇", mainMenu());
  }
}

// ---------------------------------------------------------------------------
// Inline keyboards
// ---------------------------------------------------------------------------

function btn(t, d, url = null) {
  const b = { text: t };
  if (url) b.url = url;
  else b.callback_data = d;
  return b;
}

function mainMenu() {
  return {
    inline_keyboard: [
      [btn("🔥 ابزار امروز", "menu:latest"), btn("🧰 لیست کامل", "menu:list")],
      [btn("🛒 فروشگاه", "menu:shop"), btn("🔥 ترندهای هفته", "menu:trending")],
      [btn("🎨 بساز!", "menu:imagine"), btn("🎁 دعوت دوستان", "menu:ref")],
      [btn("ℹ️ راهنما", "menu:help"), btn("📌 کانال", null, "https://t.me/cyberalchemistt")],
    ],
  };
}

function adminPanel() {
  return {
    inline_keyboard: [
      [btn("📊 آمار", "panel:stats"), btn("🧾 سفارشها", "panel:orders")],
      [btn("🛍 محصولات", "panel:products"), btn("🔥 اجرای ترند", "panel:cron")],
      [btn("🏠 منوی اصلی", "back:menu")],
    ],
  };
}

function orderButtons(orders) {
  const rows = orders.map((o) => [
    btn(`✅ تأیید #${o.id}`, `paid:${o.id}`),
    btn(`⛔ لغو`, `cancel:${o.id}`),
  ]);
  return { inline_keyboard: [...rows, [btn("🏠 منوی اصلی", "back:menu")]] };
}

// ---------------------------------------------------------------------------
// feature actions (shared by commands + callbacks)
// ---------------------------------------------------------------------------

async function showLatest(env, reply) {
  const c = await readContent(env);
  if (!c.latest) return reply("🧪 هنوز ابزاری منتشر نشده — هفتگی آپدیت میشه!\nبه کانال ما سر بزن: <a href=\"https://t.me/cyberalchemistt\">Cyber Alchemist</a>");
  return reply(`🔥 <b>ابزار امروز</b>\n\n${toolCard(c.latest)}`, mainMenu());
}

async function showList(env, reply) {
  const c = await readContent(env);
  const list = c.list || [];
  if (!list.length) return reply("🧪 لیست هنوز خالیه — هفتگی پر میشه!");
  const lines = list.map((t, i) => `${faNum(i + 1)}️⃣ ${toolCard(t)}`).join("\n\n");
  return reply(`🧰 <b>ابزارهای رایگان AI</b> (آپدیت هفتگی)\n\n${lines}`, mainMenu());
}

async function showTrending(env, reply) {
  const t = await env.STATE.get("trends:latest", "json").catch(() => null);
  if (!t || !(t.top || []).length) return reply("🔥 گزارش هفتگی هنوز آماده نشده.\nهر دوشنبه خودکار منتشر میشه!");
  const lines = (t.top || []).slice(0, 8)
    .map((x, i) => `${faNum(i + 1)}. <a href="${escAttr(x.link)}">${esc(x.name)}</a>`)
    .join("\n");
  return reply(`🔥 <b>ترندهای AI این هفته</b>\n(تا ${faNum(t.week)})\n\n${lines}`, mainMenu());
}

async function showShop(env, reply) {
  const products = await readProducts(env);
  if (!products.length) return reply("🛒 فروشگاه به‌زودی باز میشه — صبر کن!", mainMenu());
  const cards = products.map((p) => productCard(p)).join("\n\n");
  const rows = products.map((p) => [btn(`🛒 ${p.name}`, `buy:${p.id}`)]);
  const mk = { inline_keyboard: [...rows, [btn("🏠 منوی اصلی", "back:menu")]] };
  return reply(`🛒 <b>فروشگاه کیمیاگر</b>\n\n${cards}`, mk);
}

async function showRef(env, uid, reply) {
  const count = Number(await env.STATE.get(`ref:${uid}`).catch(() => null) || 0);
  const link = `https://t.me/theeeeealchemistbot?start=REF_${uid}`;
  return reply(
    `🎁 <b>دعوت از دوستان</b>\n\n` +
    `با لینک زیر دوستات رو دعوت کن و کلی امتیاز ببر:\n\n` +
    `<code>${link}</code>\n\n` +
    `👥 دعوت‌شده‌ها تا حالا: <b>${faNum(count)}</b> نفر\n` +
    `🆔 کد دعوت تو: <code>${faNum(uid)}</code>`
  );
}

async function placeOrder(env, from, chat, productId, isAdmin, reply) {
  const uid = from.id ?? chat.id;
  const products = await readProducts(env);
  const p = products.find((x) => String(x.id) === String(productId));
  if (!p) return reply("🛍 این محصول پیدا نشد. /shop");

  // block duplicates while still pending
  const open = (await listOrders(env)).find((o) => String(o.uid) === String(uid) && o.status === "new");
  if (open) return reply(`🕐 قبلاً سفارش #${open.id} دادی و هنوز توی صف تأییده.\nمدیریت: /myorders`);

  const oid = `o${Date.now().toString(36)}${Math.floor(Math.random() * 900 + 100)}`;
  const order = {
    id: oid, uid, name: from.first_name || "", username: from.username || null,
    product: p.name, price: p.price || "", status: "new", createdAt: Date.now(),
  };
  await env.STATE.put(`order:${oid}`, JSON.stringify(order));

  await reply(
    `🧾 <b>سفارش ثبت شد!</b>\n\n` +
    `#${oid}\n💰 ${esc(p.name)} — ${esc(p.price || "")}\n\n` +
    `🕐 در انتظار تأیید ادمین. وضعیت: /myorders`
  );

  // notify admin
  const adminId = env.ADMIN_ID || (await env.STATE.get("meta:admin"));
  if (adminId) {
    const buyer = `👤 ${esc(from.first_name || "کاربر")} (@${esc(from.username || "—")}) [${faNum(uid)}]`;
    const mk = {
      inline_keyboard: [[
        btn(`✅ تأیید پرداخت`, `paid:${oid}`),
        btn(`❌ لغو`, `cancel:${oid}`),
      ]],
    };
    await send(env, adminId,
      `🧾 <b>سفارش جدید!</b>\n#${oid}\n💰 ${esc(p.name)} — ${esc(p.price || "")}\n${buyer}`, mk);
  }
  return;
}

async function paidOrder(env, oid, isAdmin, reply) {
  if (!isAdmin) return reply("⛔ فقط ادمین.");
  const o = await env.STATE.get(`order:${oid}`, "json").catch(() => null);
  if (!o) return reply("⚠️ سفارش پیدا نشد!");
  o.status = "paid"; o.paidAt = Date.now();
  await env.STATE.put(`order:${oid}`, JSON.stringify(o));
  await send(env, o.uid, `✅ <b>پرداخت سفارش #${o.id} تأیید شد!</b>\n\n${esc(o.product)}\n📦 به‌زودی تحویل داده میشه.`);
  return reply(`✅ سفارش #${oid} تأیید شد — به کاربر اطلاع داده شد.`);
}

async function deliverOrder(env, oid, isAdmin, reply) {
  if (!isAdmin) return reply("⛔ فقط ادمین.");
  const o = await env.STATE.get(`order:${oid}`, "json").catch(() => null);
  if (!o) return reply("⚠️ سفارش پیدا نشد!");
  o.status = "delivered"; o.deliveredAt = Date.now();
  await env.STATE.put(`order:${oid}`, JSON.stringify(o));
  await send(env, o.uid, `🚚 <b>سفارش #${o.id} تحویل داده شد!</b>\n\n${esc(o.product)}\n💬 هر سوالی داشتی بپرس.`);
  return reply(`✅ سفارش #${oid} تحویل شد.`);
}

async function cancelOrder(env, oid, isAdmin, reply) {
  if (!isAdmin) return reply("⛔ فقط ادمین.");
  const o = await env.STATE.get(`order:${oid}`, "json").catch(() => null);
  if (!o) return reply("⚠️ سفارش پیدا نشد!");
  o.status = "cancelled"; o.cancelledAt = Date.now();
  await env.STATE.put(`order:${oid}`, JSON.stringify(o));
  await send(env, o.uid, `❌ <b>سفارش #${o.id} لغو شد.</b>\n\n${esc(o.product)}\n🧾 اگر اشتباه بود دوباره /shop بزن.`);
  return reply(`✅ سفارش #${oid} لغو شد.`);
}

async function panelAction(env, action, from, chat, isAdmin, reply) {
  if (!isAdmin) return reply("⛔ فقط ادمین.");
  switch (action) {
    case "stats": return handleCommand(env, "/stats", chat, from, true);
    case "orders": return handleCommand(env, "/orders", chat, from, true);
    case "products": {
      const products = await readProducts(env);
      if (!products.length) return reply("🛍 محصولی ثبت نشده.");
      const lines = products.map((p) => `• <b>${esc(p.name)}</b> — ${esc(p.price || "")} [${esc(p.id)}]`);
      return reply(`🛍 <b>محصولات فروشگاه</b>\n\n${lines.join("\n")}`, adminPanel());
    }
    case "cron": {
      reply("🔥 دارم ترندهای هفته رو اجرا میکنم… چند دقیقه صبر کن!");
      try { await runWeeklyTrends(env); } catch (e) { console.error("panel cron:", e.message || e); }
      await send(env, chat.id, "✅ ترندها اجرا شد. /trending بزن.");
      return;
    }
    default: return reply("🗂 منوی اصلی:", mainMenu());
  }
}

// ---------------------------------------------------------------------------
// chat + AI
// ---------------------------------------------------------------------------

const CHAT_MODELS = [
  "@cf/meta/llama-3.3-70b-instruct-fp8-fast",  // 1.7s, quality
  "@cf/google/gemma-4-26b-a4b-it",              // 1.5s, Farsi good
  "@cf/meta/llama-4-scout-17b-16e-instruct",     // 1.1s, fallback
];

const CHAT_SYSTEM =
  `تو «کیمیاگر» (The Alchemist) هستی؛ دستیار هوشمند فارسی کانال Cyber Alchemist. ` +
  `همیشه به فارسی پاسخ بده، مگر اینکه کاربر صراحتاً زبان دیگری بخواهد. ` +
  `سبک دوستانه، گرم و صمیمی؛ پاسخ‌ها کوتاه و کاربردی (حداکثر ۱۵۰ کلمه). ` +
  `اگر کاربر درباره ابزار رایگان پرسید بگو «/latest» بزنه؛ برای ترندها «/trending»؛ برای خرید «/shop». ` +
  `کانال: t.me/cyberalchemistt. هرگز نگو که مدل زبانی هستی؛ خودت را دستیار هوشمند ایرانی معرفی کن.`;

async function chatReply(env, uid, userText) {
  const memKey = `mem:${uid}`; // conversation memory (fixed namespace — no collision)
  const mem = (await env.STATE.get(memKey, "json").catch(() => null)) || [];
  const msgs = [{ role: "system", content: CHAT_SYSTEM }];
  for (const t of mem.slice(-8)) msgs.push({ role: t.r, content: t.t });
  msgs.push({ role: "user", content: userText });

  let out = null, lastErr = null;
  for (const model of CHAT_MODELS) {
    try {
      const r = await env.AI.run(model, { messages: msgs, max_tokens: 400 });
      out = r?.response || r?.result?.response || "";
      if (out) break;
    } catch (e) { lastErr = e; }
  }
  if (!out) throw lastErr || new Error("chat unavailable");
  out = String(out).slice(0, 1800);
  mem.push({ r: "user", t: userText }, { r: "assistant", t: out });
  await env.STATE.put(memKey, JSON.stringify(mem.slice(-20)));
  return out;
}

async function summarize(env, input) {
  const r = await env.AI.run(CHAT_MODELS[0], {
    messages: [
      { role: "system", content: "متن داده‌شده را به فارسی خلاصه کن؛ حداکثر ۱۰۰ کلمه، با بولت‌پوینت." },
      { role: "user", content: input.slice(0, 4000) },
    ],
    max_tokens: 300,
  });
  return r?.response || "خلاصه در دسترس نیست.";
}

async function imagine(env, prompt) {
  const r = await env.AI.run("@cf/bytedance/stable-diffusion-xl-lightning", {
    prompt: prompt.slice(0, 500),
    negative_prompt: "blurry, low quality, text, watermark, logo",
    num_steps: 8,
  });
  if (!r?.image) throw new Error("no image");
  return r.image;
}

async function transcribeVoice(env, fileId) {
  const meta = await (await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/getFile?file_id=${fileId}`)).json();
  const fp = meta?.result?.file_path;
  if (!fp) return null;
  const buf = await (await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${fp}`)).arrayBuffer();
  const r = await env.AI.run("@cf/openai/whisper-large-v3-turbo", { audio: [b64(buf)] });
  return (r?.text || r?.result?.text || "").trim() || null;
}

function fallbackChat(e) {
  console.error("chat fallback:", e.message || e);
  return "🤖 یه لحظه مغزم قاطی کرد! الان دوباره امتحان کن یا /help بزن.";
}

// ---------------------------------------------------------------------------
// referrals / orders / content helpers
// ---------------------------------------------------------------------------

async function creditReferral(env, from, refUid) {
  const uid = String(from.id);
  refUid = String(refUid || "").trim();
  if (!refUid || refUid === uid) return;
  const u = await env.STATE.get(`user:${uid}`, "json").catch(() => null);
  if (u && u.referralFrom) return; // already referred; no double credit
  if (u) { u.referralFrom = refUid; await env.STATE.put(`user:${uid}`, JSON.stringify(u)); }
  const cur = Number(await env.STATE.get(`ref:${refUid}`).catch(() => null) || 0);
  await env.STATE.put(`ref:${refUid}`, String(cur + 1));
  const ref = await env.STATE.get(`user:${refUid}`, "json").catch(() => null);
  if (ref?.id) {
    await send(env, ref.id, `🎁 <b>دعوت جدید!</b> ${esc(from.first_name || "کاربر جدید")} با لینک تو اومد. آفرین!`);
  }
}

async function listOrders(env) {
  let page = await env.STATE.list({ prefix: "order:" });
  const out = [];
  while (true) {
    for (const k of page.keys) {
      const o = await env.STATE.get(k.name, "json").catch(() => null);
      if (o) out.push(o);
    }
    if (!page.cursor) break;
    page = await env.STATE.list({ prefix: "order:", cursor: page.cursor });
  }
  return out.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
}

function orderStatus(o) {
  const map = { new: "🕐 در انتظار", paid: "✅ پرداخت شد", delivered: "🚚 تحویل شد", cancelled: "❌ لغو شد" };
  return map[o.status] || o.status;
}

async function readContent(env) {
  const [lr, ls] = await Promise.all([
    env.STATE.get("content:latest").catch(() => null),
    env.STATE.get("content:list").catch(() => null),
  ]);
  let latest = null, list = [];
  try { latest = lr ? JSON.parse(lr) : null; } catch { latest = null; }
  try { list = ls ? JSON.parse(ls) : []; } catch { list = []; }
  return { latest, list };
}

async function putContent(env, latest, list) {
  await Promise.all([
    env.STATE.put("content:latest", JSON.stringify(latest)),
    env.STATE.put("content:list", JSON.stringify(list)),
  ]);
}

async function readProducts(env) {
  const raw = await env.STATE.get("content:products").catch(() => null);
  try { return raw ? JSON.parse(raw) : []; } catch { return []; }
}

async function registerUser(env, from, chatId) {
  const uid = String(from.id ?? chatId);
  const key = `user:${uid}`;
  const prev = await env.STATE.get(key, "json").catch(() => null);
  if (prev) {
    prev.username = from.username || prev.username;
    prev.lastSeenAt = Date.now();
    prev.payloadCount = (prev.payloadCount || 0) + 1;
    await env.STATE.put(key, JSON.stringify(prev));
  } else {
    await env.STATE.put(key, JSON.stringify({
      id: String(from.id ?? chatId), first_name: from.first_name || "", username: from.username || null,
      firstSeenAt: Date.now(), lastSeenAt: Date.now(), payloadCount: 1, referralFrom: null,
    }));
    if (!env.ADMIN_ID && !(await env.STATE.get("meta:admin"))) await env.STATE.put("meta:admin", uid);
  }
  const tkey = `chat:${chatId}`; // last-seen tally (separate from mem: memory)
  if (!(await env.STATE.get(tkey))) await env.STATE.put(tkey, String(Date.now()));
}

function isAdminReq(request, env) {
  const h = request.headers.get("authorization") || "";
  return h === `Bearer ${env.ADMIN_ID || ""}`;
}

// ---------------------------------------------------------------------------
// weekly trends + daily tool
// ---------------------------------------------------------------------------

const TREND_FEEDS = [
  { url: "https://www.producthunt.com/feed", w: 3 },
  { url: "https://hnrss.org/show", w: 2 },
  { url: "https://hnrss.org/newest?q=Show%20HN", w: 2 },
  { url: "https://techcrunch.com/category/artificial-intelligence/feed/", w: 1 },
];
const AI_KEYWORDS = ["ai", "artificial intelligence", "llm", "gpt", "chatgpt", "copilot", "machine learning", "neural", "model", "agent", "chatbot", "openai", "anthropic", "gemini", "llama", "image generator", "text to video", "voice clone", "stable diffusion", "midjourney", "automation", "workflow"];
const NEWS_NOISE = /\b(lawsuit|sues|sued|settlement|probe|investigat|court|ban|banned|breach|hack|hacker|steal|stealing|layoff|fired|quit|resign|cease|fine|fined|sentence|trial|verdict|funding round|raises?\$|IPO)\b/i;

async function runWeeklyTrends(env) {
  const items = [];
  for (const f of TREND_FEEDS) {
    try {
      const xml = await (await fetch(f.url, { headers: { "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" }, signal: AbortSignal.timeout(15000) })).text();
      const parsed = xml.includes("<entry") ? parseAtom(xml) : parseRSS(xml);
      for (const it of parsed) it.weight = f.w;
      items.push(...parsed);
    } catch { /* skip dead feed */ }
  }
  const seen = new Set();
  const scored = [];
  for (const it of items) {
    if (seen.has(it.link)) continue;
    seen.add(it.link);
    const s = aiScore(it);
    if (s > 0 && !NEWS_NOISE.test(it.title)) scored.push({ ...it, score: s });
  }
  scored.sort((a, b) => b.score - a.score || (b.pubTs || 0) - (a.pubTs || 0));
  const top = scored.slice(0, 8).map((x) => ({ name: x.title, link: x.link, blurb: stripHtml(x.desc || "").slice(0, 160) }));
  if (!top.length) return { week: null, top: [] };

  // Persian report via llama
  let report = "";
  try {
    const r = await env.AI.run(CHAT_MODELS[0], {
      messages: [
        { role: "system", content: "تو روزنامه‌نگار فناوری ایرانی؛ گزارش کوتاه هفتگی (حداکثر ۳۵۰ کلمه) از پلتفرم‌های AI پرطرفدار برای کانال تلگرام بنویس. فارسی، گرم، با هشتگ. ساختار: چند خط مقدمه، لیست شماره‌دار با یک خط توضیح و دامنه هر پلتفرم، در پایان یک نکته مفید." },
        { role: "user", content: JSON.stringify(top.map((t) => ({ name: t.name, link: t.link }))) },
      ],
      max_tokens: 700,
    });
    report = r?.response || "";
  } catch { report = ""; }

  const week = new Date().toISOString().slice(0, 10);
  const saved = { week, top, report: report || fallbackReport(top) };
  await env.STATE.put("trends:latest", JSON.stringify(saved));

  const list = top.slice(0, 5).map((t) => ({ name: t.name, what: t.blurb, link: t.link }));
  await putContent(env, list[0] || null, list);

  const post = `🔥 <b>ترندهای AI این هفته</b>\n\n${saved.report}`;
  try { await send(env, "@cyberalchemistt", post); } catch { /* channel may reject */ }
  console.log("trend job done:", top.length, "items");
  return saved;
}

async function postDailyTool(env) {
  const c = await readContent(env);
  if (!c.latest) return;
  const t = c.latest;
  const post = `🧪 <b>ابزار امروز</b>\n\n${toolCard(t)}\n\n🧰 بقیه ابزارها: /list\n🤖 چت با ربات: @theeeeealchemistbot`;
  await send(env, "@cyberalchemistt", post);
  console.log("daily tool posted");
}

const XML_CDATA = /<!\[CDATA\[([\s\S]*?)\]\]>/g;

function parseRSS(xml) {
  const out = [];
  const re = /<item[\s>][\s\S]*?<\/item>/g;
  let m;
  while ((m = re.exec(xml))) {
    const b = m[0];
    const g = (tag) => { const r = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i").exec(b); return r ? r[1].trim() : ""; };
    const title = stripCDATA(g("title"));
    const link = stripCDATA(g("link")).trim();
    const pubTs = g("pubDate") ? (Date.parse(g("pubDate")) || 0) : 0;
    if (title && link) out.push({ title, link, desc: g("description"), pubTs });
  }
  return out;
}

function parseAtom(xml) {
  const out = [];
  const re = /<entry[\s>][\s\S]*?<\/entry>/g;
  let m;
  while ((m = re.exec(xml))) {
    const b = m[0];
    const g = (tag) => { const r = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i").exec(b); return r ? r[1].trim() : ""; };
    const title = stripCDATA(g("title"));
    const link = (/<link[^>]*href="([^"]+)"/i.exec(b) || [])[1] || "";
    const pubTs = (g("published") || g("updated")) ? (Date.parse(g("published") || g("updated")) || 0) : 0;
    if (title && link) out.push({ title, link, desc: g("summary") || g("content"), pubTs });
  }
  return out;
}

function stripCDATA(s) {
  return String(s || "").replace(XML_CDATA, "$1").replace(/^\s+|\s+$/g, "");
}

function aiScore(it) {
  const hay = `${it.title}\n${it.desc}`.toLowerCase();
  let s = 0;
  for (const k of AI_KEYWORDS) if (hay.includes(k)) s += it.title.toLowerCase().includes(k) ? 2 : 1;
  s *= (it.weight || 1);
  if (/\.ai\b|\.app\b/.test(it.title)) s += 3;
  if (/\b(app|tool|platform|generator|studio|bot|assistant|engine|sdk)\b/i.test(it.title)) s += 2;
  if (it.title.length < 60) s += 1;
  return s;
}

function fallbackReport(top) {
  return top.slice(0, 6).map((t, i) => `${faNum(i + 1)}. ${t.name}\n${t.link}`).join("\n");
}

// ---------------------------------------------------------------------------
// Telegram transport
// ---------------------------------------------------------------------------

async function typing(env, chatId, action = "typing") {
  try {
    await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/sendChatAction`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, action }),
    });
  } catch { /* fire and forget */ }
}

async function answerCallback(env, cbId, text = "") {
  try {
    await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/answerCallbackQuery`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ callback_query_id: cbId, text, show_alert: false }),
    });
  } catch { /* ignore */ }
}

async function send(env, chatId, html, replyMarkup = null) {
  const body = { chat_id: chatId, text: String(html).slice(0, 4000), parse_mode: "HTML", disable_web_page_preview: true };
  if (replyMarkup) body.reply_markup = replyMarkup;
  const r = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const j = await r.json();
  if (!j.ok) console.error("send err:", JSON.stringify(j).slice(0, 300));
  return j;
}

async function sendPlain(env, chatId, text) {
  const body = { chat_id: chatId, text: String(text).slice(0, 4000), disable_web_page_preview: true };
  const r = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return (await r.json());
}

async function sendPhoto(env, chatId, base64Png, caption = "") {
  const bin = atob(base64Png);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const fd = new FormData();
  fd.append("chat_id", chatId);
  if (caption) fd.append("caption", String(caption).slice(0, 200).replace(/[<>]/g, ""));
  fd.append("photo", new Blob([bytes], { type: "image/png" }), "kimia.png");
  const r = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/sendPhoto`, { method: "POST", body: fd });
  return (await r.json());
}

function getMe(token) {
  return fetch(`https://api.telegram.org/bot${token}/getMe`, { method: "POST" }).then((r) => r.json());
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

async function health(env) {
  const me = env.BOT_TOKEN ? await getMe(env.BOT_TOKEN).catch((e) => ({ error: e.message })) : { error: "BOT_TOKEN missing" };
  const bot = me?.ok && me?.result ? me.result : me;
  const [users, products] = await Promise.all([countPrefix(env.STATE, "user:"), readProducts(env)]);
  const content = await readContent(env);
  const trends = await env.STATE.get("trends:latest", "json").catch(() => null);
  return {
    ok: true, bot,
    kv: { users, products: products.length, latest: !!content.latest, listSize: (content.list || []).length },
    trends: trends ? { week: trends.week, n: (trends.top || []).length } : null,
  };
}

function toolCard(t) {
  const name = esc(t.name || t.link || "?");
  const nameTag = t.link ? `<a href="${escAttr(t.link)}">${name}</a>` : name;
  return `${nameTag}\n${esc(t.what || "")}` + (t.note ? `\n💡 ${esc(t.note)}` : "");
}

function productCard(p) {
  return (
    `💰 <b>${esc(p.name)}</b>\n` +
    `📝 ${esc(p.desc || "")}\n` +
    `💵 قیمت: <b>${esc(p.price || "")}</b>`
  );
}

function helpText() {
  return (
    `⚗️ <b>راهنمای کیمیاگر</b>\n\n` +
    `🤖 <b>چت:</b> هرچی می‌خوای همینجا بنویس!\n` +
    `🎨 <b>تصویر:</b> /imagine یک ربات طلایی\n` +
    `🎙️ <b>صدا:</b> وویس بفرست تا متنشو بگیری\n` +
    `📝 <b>خلاصه:</b> /summary <متن>\n` +
    `🧰 <b>ابزار:</b> /latest و /list\n` +
    `🔥 <b>ترندها:</b> /trending\n` +
    `🛒 <b>فروشگاه:</b> /shop — سفارش‌ها: /myorders\n` +
    `🎁 <b>دعوت:</b> /ref\n\n` +
    `ویدئوها و آموزش‌ها: <a href="https://t.me/cyberalchemistt">کانال</a>`
  );
}

function esc(s) { return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }
function escAttr(s) { return esc(s).replace(/"/g, "&quot;"); }
function stripHtml(s) {
  return String(s || "").replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\s+/g, " ").trim();
}
function faNum(s) { return String(s ?? "").replace(/\d/g, (d) => "۰۱۲۳۴۵۶۷۸۹"[d]); }
const b64 = (buf) => {
  let bin = "";
  const bytes = new Uint8Array(buf);
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
};

async function countPrefix(kv, prefix) {
  try {
    let page = await kv.list({ prefix });
    let n = page.keys.length;
    while (page.cursor) { page = await kv.list({ prefix, cursor: page.cursor }); n += page.keys.length; }
    return n;
  } catch { return -1; }
}

function json(o, s = 200) {
  return new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json" } });
}