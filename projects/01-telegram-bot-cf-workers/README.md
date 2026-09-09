# Project 01: Telegram Bot on Cloudflare Workers (No VPS)

## Origin
User has a self-hosted Telegram bot ("robot") running on a VPS and wants to
move it to a serverless environment so it "runs directly on Telegram".

## Truth (correcting the narrative)
Telegram does **not** execute your code. It stays a backend. What changed is
you no longer need a persistent VPS — you can hook your bot logic up to a
serverless function (Cloudflare Workers) and let Telegram reach it via webhook.
Same bot, lighter lift, no persistent machine.

## Stack Decision (from conversation)
- **Cloudflare Workers** — lightweight, scalable, free-tier viable, zero VPS.
- Bot framework is flexible (telegraf / grammY / raw webhooks) but must run
  inside a Worker.
- Webhook must be wired so Telegram's API can reach the Worker via HTTPS.

## Key Requirements
1. Bot logic ported into a Cloudflare Worker.
2. `setWebhook` pointing at the Worker's HTTPS URL.
3. Handle Telegram webhook JSON payloads and reply via Telegram Bot API.
4. Free tier works for simple bots; watch limits (CPU time, requests/day).

## Agent Assignment
- **backend** — implement the Worker, bot logic, webhook handler.
- **devops** — `wrangler` setup, deploy, `setWebhook`, secrets.
- **security** — validate incoming webhook signatures, guard tokens.

## Deliverables
- `worker.js` / `wrangler.toml` with bot token as a secret.
- Webhook handler (GET to verify, POST to handle updates).
- Deploy command + webhook registration.
