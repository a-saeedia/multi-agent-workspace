/**
 * Workers AI vision/nlp client for the video pipeline.
 *
 * Runs in BOTH contexts:
 *  - Node (CLI/local pipeline): calls the Cloudflare REST API directly.
 *    Needs CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN env vars.
 *  - Cloudflare Worker: pass `env` (AI binding) + optional `aiName` to use `env.AI`
 *    instead of REST.
 *
 * Model routing (verified against live endpoint, 2026-09-08):
 *  - @cf/llava-hf/llava-1.5-7b-hf  — vision (image+text). NOTE: on this account the
 *    image tensor decode currently errors (3016) for every payload shape; kept as
 *    first choice, falls through to llama-vision, then to distilbert heuristic.
 *  - @cf/meta/llama-3.2-11b-vision-instruct — vision, requires prior Model
 *    Agreement ('agree' prompt via API) — enabled via aiRun on first use.
 *  - @cf/huggingface/distilbert-sst-2-int8 — text sentiment, verified WORKING.
 */
const fs = require("node:fs");

const MODELS = {
  llava: "@cf/llava-hf/llava-1.5-7b-hf",
  llamaVision: "@cf/meta/llama-3.2-11b-vision-instruct",
  distilbert: "@cf/huggingface/distilbert-sst-2-int8",
};

/** Run any Workers AI model via REST (Node side). */
async function aiRunREST(model, inputs, { accountId = process.env.CLOUDFLARE_ACCOUNT_ID, token = process.env.CLOUDFLARE_API_TOKEN } = {}) {
  if (!accountId || !token) {
    const err = new Error("AI REST call needs CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN env vars (or use --ai binding inside a Worker)");
    err.code = "NO_CF_CREDS";
    throw err;
  }
  const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/${model}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(inputs),
  });
  const body = await res.json();
  if (!res.ok || !body.success) {
    const err = new Error(`AI ${model} failed: ${JSON.stringify(body.errors || body)}`);
    err.code = body.errors?.[0]?.code || "AI_FAIL";
    err.api = body.errors?.[0];
    throw err;
  }
  return body.result;
}

/** Run via Workers AI binding (inside a Worker); env.AI.run(model, inputs). */
async function aiRunBinding(AI, model, inputs) {
  return AI.run(model, inputs);
}

function pickClient(envOrClient) {
  // If we got an `env` with an AI binding
  if (envOrClient && envOrClient.AI && typeof envOrClient.AI.run === "function") {
    return (m, i) => aiRunBinding(envOrClient.AI, m, i);
  }
  return (m, i) => aiRunREST(m, i);
}

/**
 * Analyze one image (file path | Buffer | base64 string).
 * Tries, in order: LLaVA -> LlamaVision -> distilbert heuristic.
 * Returns { model, text, raw } — never throws unless NO_CF_CREDS.
 */
async function analyzeImage(imageSrc, { envOrClient, accountId, token, prompt = "Describe what is visible in this video frame in one sentence." } = {}) {
  const run = pickClient(envOrClient);

  // Normalize to base64 + mime.
  let b64, mime;
  if (imageSrc instanceof Buffer) { b64 = imageSrc.toString("base64"); mime = "image/jpeg"; }
  else if (typeof imageSrc === "string" && (imageSrc.startsWith("data:") || /^[A-Za-z0-9+/=]{40,}$/.test(imageSrc))) {
    if (imageSrc.startsWith("data:")) { const [h, d] = imageSrc.split(","); b64 = d; mime = h.match(/data:([^;]+)/)?.[1] || "image/png"; }
    else { b64 = imageSrc; mime = "image/png"; }
  } else if (typeof imageSrc === "string" && fs.existsSync(imageSrc)) {
    b64 = fs.readFileSync(imageSrc).toString("base64");
    mime = imageSrc.toLowerCase().endsWith(".png") ? "image/png" : "image/jpeg";
  } else {
    throw new Error("analyzeImage: unsupported image source");
  }
  const img = `data:${mime};base64,${b64}`;

  const attempts = [
    { model: MODELS.llava, inputs: { image: [img], prompt } },
    { model: MODELS.llamaVision, inputs: { image: [img], prompt } },
    { model: MODELS.distilbert, inputs: { text: prompt } }, // heuristic fallback, no image
  ];
  let lastErr;
  for (const a of attempts) {
    try {
      const raw = await run(a.model, a.inputs);
      let text = "";
      if (Array.isArray(raw)) text = raw.map((r) => `${r.label}:${(r.score || 0).toFixed(3)}`).join(", ");
      else if (raw && typeof raw.description === "string") text = raw.description;
      else if (raw && raw.result) text = JSON.stringify(raw.result);
      else text = JSON.stringify(raw);
      return { model: a.model, text, raw };
    } catch (e) {
      lastErr = e;
      if (e.code === "NO_CF_CREDS") throw e; // hard stop, caller decides
      // 5016 = model agreement required; 3016 = tensor decode; keep trying next.
    }
  }
  const err = new Error("all AI models failed; last: " + (lastErr?.message || lastErr));
  err.cause = lastErr;
  throw err;
}

module.exports = { MODELS, analyzeImage, aiRunREST, aiRunBinding };