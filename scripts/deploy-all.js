#!/usr/bin/env node
/**
 * One-shot deploy helper for the three Workers.
 *
 * Pre-flight:
 *   1. wrangler must be authenticated — either:
 *        setx CLOUDFLARE_API_TOKEN "<token-with-workers:edit & kv:write>"
 *        (or run `wrangler login`, or `wrangler auth login`)
 *   2. P01 needs Telegram: node set-webhook.js <BOT_TOKEN> <webhook-url>
 *   3. P02 task-hub KV: namespace id is already wired to the "arman" ns.
 *
 * Usage:
 *   node scripts/deploy-all.js [--dry-run]
 */
const { execSync } = require("node:child_process");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const WRANGLER = process.env.WRANGLER || "wrangler";

const projects = [
  { name: "p04-task-hub", dir: path.join(ROOT, "04-multiagent-orchestration", "worker"), secretEnv: [] },
  { name: "p02-video-ai", dir: path.join(ROOT, "02-agent-video-editing", "worker"), secretEnv: [] },
  { name: "p01-telegram-bot", dir: path.join(ROOT, "01-telegram-bot-cf-workers"), secretEnv: ["BOT_TOKEN", "SECRET"] },
];

const args = process.argv.slice(2);
const dry = args.includes("--dry-run");

function sh(cmd, cwd) {
  console.log(`\n> ${cmd}`);
  if (dry) { console.log("  (dry-run, skipped)"); return; }
  execSync(cmd, { cwd, stdio: "inherit", env: process.env });
}

sh(`${WRANGLER} --version`, ROOT); // sanity

for (const p of projects) {
  console.log(`\n=== deploying ${p.name} ===`);
  sh(`${WRANGLER} deploy`, p.dir);
}

console.log("\n=== done. Next steps ===");
console.log("1. P01: set secrets (if not done):");
console.log("   wrangler secret put BOT_TOKEN  (in 01-telegram-bot-cf-workers)");
console.log("   wrangler secret put SECRET      (optional)");
console.log("2. P01: register webhook (after deploy + secrets):");
console.log("   node scripts/set-webhook.js <BOT_TOKEN> https://<your-subdomain>.workers.dev/webhook [SECRET]");
console.log("3. P02: run a pipeline locally:");
console.log("   node pipeline/cli.js quick path/to/video.mp4 --trim 0:3 --gray");
console.log("4. P04: connect controller to deployed hub:");
console.log("   node controller/controller.js poll --hub https://<p04-url> --handler controller/workers-sample/handlers.js");