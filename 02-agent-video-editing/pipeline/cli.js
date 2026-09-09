#!/usr/bin/env node
/**
 * CLI entry for the video pipeline.
 *
 *   node cli.js run <job.json>                          # run a job spec
 *   node cli.js quick <input> [--trim 0:3] [--gray]     # one-liner demo job
 *   node cli.js analyze <image>                         # AI vision on one image
 *   node cli.js info <video>                            # ffprobe summary
 */
const path = require("node:path");
const fs = require("node:fs");
const { runJob } = require("./pipeline");
const { analyzeImage } = require("./vision");
const { probe } = require("./lib/ffmpeg");

function flag(args, name) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);

  if (cmd === "run") {
    const jobFile = rest[0];
    if (!jobFile) throw new Error("run needs <job.json>");
    const job = JSON.parse(fs.readFileSync(path.resolve(jobFile), "utf8"));
    if (flag(rest, "--out-dir")) job.outDir = path.resolve(flag(rest, "--out-dir"));
    const out = await runJob(job);
    console.log(JSON.stringify({ final: out.final, steps: out.log.map((l) => ({ op: l.op, name: l.name })) }, null, 2));
    return;
  }

  if (cmd === "analyze") {
    const img = rest[0];
    if (!img) throw new Error("analyze needs <image>");
    const r = await analyzeImage(path.resolve(img));
    console.log(JSON.stringify(r, null, 2));
    return;
  }

  if (cmd === "info") {
    const v = rest[0];
    if (!v) throw new Error("info needs <video>");
    const meta = await probe(path.resolve(v));
    console.log(JSON.stringify(meta, null, 2));
    return;
  }

  if (cmd === "quick") {
    const input = rest[0];
    if (!input) throw new Error("quick needs <input>");
    const trimArg = flag(rest, "--trim"); // e.g. 0:3
    const gray = rest.includes("--gray");
    const outDir = flag(rest, "--out-dir") || "out";
    const steps = [];
    if (trimArg) {
      const [s, e] = trimArg.split(":");
      steps.push({ op: "trim", start: parseInt(s), end: parseInt(e) });
    }
    if (gray) steps.push({ op: "filter", preset: "grayscale", outDir });
    steps.push({ op: "extract", fps: 1, outDir });
    const job = { input: path.resolve(input), outDir, steps };
    const out = await runJob(job);
    console.log(JSON.stringify({ final: out.final, steps: out.log.map((l) => l.op) }, null, 2));
    return;
  }

  console.log(`usage:
  node cli.js run <job.json> [--out-dir dir]
  node cli.js quick <input> [--trim S:E] [--gray] [--out-dir dir]
  node cli.js analyze <image>
  node cli.js info <video>
`);
}

main().catch((e) => { console.error(e.message || e); process.exit(1); });