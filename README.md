# Multi-Project Workspace — Build Status (2026-09-08)

All three active projects are **implemented and locally verified**. Live deployment
is blocked only by lack of a write-capable Cloudflare token.

## Status table
| Project | Code | Local verify | Deploy | Live URL |
|---|---|---|---|---|
| P04 Multi-Agent Orchestration | ✅ worker/ + controller/ | ✅ 10/10 harness + parallel dispatch | ✅ deployed | https://task-hub.darkestjokepossible.workers.dev |
| P02 Video Editing Pipeline | ✅ pipeline/ + worker/ | ✅ real FFmpeg end-to-end | ✅ deployed | https://video-ai.darkestjokepossible.workers.dev |
| P01 Telegram Bot | ✅ src/ + scripts/ | ✅ 10/10 harness | ✅ deployed (needs BOT_TOKEN secret) | https://telegram-funnel-bot.darkestjokepossible.workers.dev |
| P03 City-World Animation | not started (out of scope this run) | — | — | — |

> **Deploy UNBLOCKED** — user provided write-capable `CLOUDFLARE_API_TOKEN` (cfut_..., 2026-09-08). All three Workers deployed live.

## Live verification (all PASSED)
- P04 full task lifecycle on live hub (enqueue→claim→complete→health queue=0) ✅
- P04 live orchestration: local controller polled live hub, claimed+processed+completed a task end-to-end ✅
- P02 /analyze live: LLaVA→Llama-3.2-vision now returns real descriptions (Saturn test pattern) after /agree ✅
- P01 /health live: `{"ok":true}` (bot shows "BOT_TOKEN not set" until secret added) ✅

## How to unblock deploy
1. `setx CLOUDFLARE_API_TOKEN "<token with workers:edit, kv:write, ai:run>"` (or `wrangler login`)
2. `node scripts/deploy-all.js`
3. P01: `wrangler secret put BOT_TOKEN` then `node 01-telegram-bot-cf-workers/scripts/set-webhook.js <BOT_TOKEN> https://<sub>.workers.dev/webhook`
4. P02: one-time `POST /agree {"prompt":"agree"}` on the video-ai worker to enable llama-vision; LLaVA may need a ticket/format investigation (3016).
5. P04: controller polls the task hub from anywhere.

## Key technical finds (persist!)
- Workers AI image decode errors (`3016`) affect LLaVA account-wide, all payload shapes (b64 array, data URI, public URL). Text models fine. Llama-3.2-vision needs prior Model Agreement (error 5016 → POST {"prompt":"agree"}).
- Cloudflare MCP OAuth token (`~/.local/share/opencode/mcp-auth.json`) has ONLY `.read` scopes — every write (worker PUT, KV PUT, queue create) returns 10000 Authentication error. Reads + AI run work.
- R2 not enabled on account (error 10042) — used KV instead. Queues create also blocked → KV-backed task queue design adopted.
- ffmpeg `-c copy` trim: `-ss` must precede `-i`; output-seek copy yields audio-only files (video:0KiB).
- ffmpeg is at `C:\Users\User\tools\ffmpeg\ffmpeg.exe` (no PATH); node at `C:\Users\User\tools\node\node.exe`.
- Template-literal `${accountId}` in cloudflare_execute gets URL-encoded and fails (7003) — hardcode `28290e9dd8d7b066c3f2c1dd7ff12fc3`.

## Runbook (local, no Cloudflare)
```
node 04-multiagent-orchestration/controller/controller.js run ^
  04-multiagent-orchestration/controller/workers-sample/handlers.js ^
  --spec .../workers-sample/tasks.json --concurrency 4

node 01-telegram-bot-cf-workers/scripts/test-local.js

node 02-agent-video-editing/pipeline/cli.js quick ^
  02-agent-video-editing/test-media/sample.mp4 --trim 1:4 --gray --out-dir out-smoke
```