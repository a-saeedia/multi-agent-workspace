# P01 — Telegram AI Funnel Bot on Cloudflare Workers

Funnel bot for the Alchemist brand (t.me/theeeeealchemistbot) — now a full AI
assistant: Farsi chatbot, voice transcription, image generation, shop/orders,
and a **self-running weekly trend engine** that researches trending AI
platforms, writes a Persian report, posts it to @cyberalchemistt, and auto-
refills `/latest` + `/list`. All on Cloudflare free tier: KV + Workers AI +
Cron Triggers + webhook.

## Layout
```
src/index.js           Worker: webhook + funnel + AI assistant + shop + trend engine
wrangler.toml          KV (STATE -> "arman") + AI + cron "0 10 * * 1" (Mon 10:00 UTC)
scripts/set-webhook.js one-shot webhook registration
scripts/test-local.js  local harness: 33 assertions, stubbed Telegram/KV/AI/RSS
```

## Deploy (live at https://telegram-funnel-bot.darkestjokepossible.workers.dev)
1. `wrangler secret put BOT_TOKEN` — @BotFather
2. `wrangler secret put ADMIN_ID` — numeric Telegram id
3. `wrangler deploy`
4. `node scripts/set-webhook.js <BOT_TOKEN> https://<sub>.workers.dev/webhook [SECRET]`

## Commands
| command | who | effect |
|---|---|---|
| any free text | all | **AI chatbot** (llama-3.3-70b, Persian, per-user memory) |
| /chat <text> | all | explicit chat |
| /imagine <prompt> | all | text-to-image (SDXL lightning) |
| voice message | all | Whisper transcription → reply |
| /summary <text> | all | Persian summary (llama) |
| /trending | all | this week's AI platforms report |
| /start /latest /list | all | funnel: welcome, latest tool, full list |
| /shop | all | product catalog |
| /order <id> | all | place order → admin gets DM + confirmation |
| /orders, /paid <id> | admin | open orders, mark paid (notifies buyer) |
| /broadcast <t> | admin | DM every registered user |
| /stats | admin | users / tools / open orders |
| /adminid /id /who /echo /ai /learn /recall /help | all | extras |

## Admin APIs
```
GET  /content                  # {latest, list}
PUT  /content  (Bearer)        # {"latest":{...},"list":[...]}
GET  /products                 # shop catalog
PUT  /products (Bearer)        # [{id,name,price,desc}]
GET  /orders   (Bearer)        # orders
POST /cron     (Bearer)        # run weekly trend job now (test)
```

## Weekly trend engine (automatic, Monday 10:00 UTC)
1. Fetches Product Hunt (Atom), Show HN, and TechCrunch AI feeds.
2. Scores items: AI keywords × source weight (products > news) + product-signal
   boosts (.ai / app / tool / platform…), drops news-noise titles (lawsuit…).
3. Top 8 → llama-3.3-70b writes a Persian channel post (with hashtags + links).
4. Posts to **@cyberalchemistt**; stores `trends:latest`; refills `content:latest`
   (top 1) + `content:list` (top 5) so `/latest` and `/list` update themselves.

## Design notes
- Fast-ACK: webhook replies 200 immediately; heavy work (AI/feeds) in `ctx.waitUntil`.
- Chat memory: `chat:<uid>` = last 20 turns, model fallback chain
  llama-3.3-70b → llama-4-scout → deepseek-v4-flash.
- Model notes (this account): LLaVA 3016 still errors; llama-3.2-11b-vision works
  (used in P02); distilbert for /ai sentiment; whisper-large-v3-turbo for voice.
- Telegram constraint: webhook XOR long-polling per token, never both.
- Free tier fits: cron 1×/week, KV, Workers AI @cf models.

## Status
**Live & verified.** 33/33 harness; chat/imagine/shop all tested through the live
webhook; trend job ran end-to-end (8 real AI platforms ranked, genuine Farsi
report **posted to @cyberalchemistt**, /latest + /list auto-refilled). Shop
seeded with 3 products (VIP / course / prompt pack) — manage via PUT /products.