#!/usr/bin/env node
/**
 * Register the Telegram webhook for the bot Worker.
 *
 * Usage:
 *   node scripts/set-webhook.js <BOT_TOKEN> <WEBHOOK_URL> [SECRET]
 *
 *   BOT_TOKEN    from @BotFather
 *   WEBHOOK_URL  e.g. https://telegram-funnel-bot.<your-sub>.workers.dev/webhook
 *   SECRET       optional; if used, must match the Worker's SECRET secret.
 *
 * Verifies with getMe first, then calls setWebhook, then prints the result.
 */
const [botToken, webhookUrl, secret] = process.argv.slice(2);

if (!botToken || !webhookUrl) {
  console.error("usage: node set-webhook.js <BOT_TOKEN> <WEBHOOK_URL> [SECRET]");
  process.exit(1);
}

const API = `https://api.telegram.org/bot${botToken}`;

async function call(method, params = {}) {
  const r = await fetch(`${API}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(params),
  });
  return r.json();
}

(async () => {
  const me = await call("getMe");
  if (!me.ok) {
    console.error("getMe failed:", JSON.stringify(me));
    process.exit(1);
  }
  console.log("bot:", me.result.username, `(@${me.result.username})`);

  const body = { url: webhookUrl, allowed_updates: ["message"] };
  if (secret) body.secret_token = secret;
  if (secret) body.drop_pending_updates = true; // avoid old-queue replays when rotating
  else body.drop_pending_updates = true;

  const res = await call("setWebhook", body);
  console.log("setWebhook:", JSON.stringify(res, null, 2));

  const info = await call("getWebhookInfo");
  console.log("current:", JSON.stringify(info.result, null, 2));
  process.exit(res.ok ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });