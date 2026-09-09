/**
 * Pipeline orchestrator — chains ops into a full job.
 *
 * Job: { input, steps: [ {op, ...opts}, ... ] , outDir }
 * Each step's output feeds the next step's "input".
 * Ops: extract | trim | concat | filter | contact-sheet | analyze
 *
 * Local usage:  node pipeline.js <job.json> [--out-dir dir]
 * Worker usage: import { runJob } from "./pipeline.js";
 */
const path = require("node:path");
const fs = require("node:fs");
const { probe } = require("./lib/ffmpeg");
const { extract } = require("./ops/extract");
const { trim } = require("./ops/trim");
const { concat } = require("./ops/concat");
const { filter } = require("./ops/filter");
const { contactSheet } = require("./ops/contact-sheet");
const { analyzeImage } = require("./vision");

function normalize(opts) {
  const o = { ...opts };
  o.outDir = o.outDir || ".";
  if (o.output === null || o.output === undefined) o.output = null;
  return o;
}

async function runStep(step, current, stepIdx, job) {
  const op = step.op;
  const outDir = step.outDir || path.join(job.outDir || ".", `step${stepIdx}`);
  fs.mkdirSync(outDir, { recursive: true });
  const opts = normalize({ ...step, input: current, outDir, output: step.output || path.join(outDir, `out_${op}.mp4`) });

  let result;
  switch (op) {
    case "extract": result = await extract(opts); break;
    case "trim": result = await trim(opts); break;
    case "concat": result = await concat({ ...opts, inputs: step.inputs || [current] }); break;
    case "filter": {
      // reuse output only for filter/trims; extract/contact-sheet produce different outputs
      const r = await filter(opts);
      result = r;
      break;
    }
    case "contact-sheet": result = await contactSheet(opts); break;
    case "analyze": {
      const ai = { envOrClient: job.ai, accountId: job.accountId, token: job.token };
      const frames = opts.frames || [current];
      const analyses = [];
      for (const f of frames) {
        try { analyses.push(await analyzeImage(f, ai)); } catch (e) { analyses.push({ error: e.message }); }
      }
      result = { analyses, source: current };
      break;
    }
    default: throw new Error(`unknown op: ${op}`);
  }
  return { result, produced: result?.output || result?.framesDir || result?.analyses || null };
}

/**
 * Run a job spec. Returns { stepIndex by name, final }. Each step runs
 * sequentially; parallelism within a step (e.g. batch analyze) is up to op impl.
 */
async function runJob(job, { quiet = false } = {}) {
  if (!job.input) throw new Error("job needs input");
  if (!Array.isArray(job.steps) || job.steps.length === 0) throw new Error("job needs steps[]");

  const meta = await probe(job.input);
  if (!quiet) console.log(`[pipeline] input: ${job.input} (${meta.format?.duration || "?"}s, ${(meta.streams || []).length} streams)`);

  let current = job.input;
  const log = [];
  for (let i = 0; i < job.steps.length; i++) {
    const step = job.steps[i];
    if (!quiet) console.log(`[pipeline] step ${i + 1}/${job.steps.length}: ${step.op}${step.name ? ` (${step.name})` : ""}`);
    const { result, produced } = await runStep(step, current, i + 1, job);
    log.push({ step: i + 1, op: step.op, name: step.name || null, result, produced });
    if (step.output || typeof produced === "string") current = produced || step.output || current;
    else if (Array.isArray(produced) && produced.length) current = produced[produced.length - 1];
  }
  if (!quiet) console.log(`[pipeline] done -> ${current}`);
  return { meta, log, final: current };
}

module.exports = { runJob, runStep };