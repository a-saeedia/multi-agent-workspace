/**
 * P02 Video-AI Worker — Cloudflare side of the agent-driven video pipeline.
 *
 * FFmpeg heavy-lifting runs locally (Workers can't exec binaries); this Worker
 * provides:
 *   GET  /health                 — liveness
 *   POST /analyze                — { image: <b64 image>, prompt? } -> vision analysis
 *   GET  /models                 — list which AI models are usable on this account
 *   POST /agree                  — accept the Llama-vision model agreement (one-time)
 *
 * The local controller (pipeline/) sends extracted frames here for AI analysis
 * and keeps the video ops local.
 */
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/health") {
      return json({ ok: true, service: "p02-video-ai", ts: Date.now(), ai: !!env.AI });
    }

    if (request.method === "GET" && url.pathname === "/models") {
      return json({ available: ["@cf/llava-hf/llava-1.5-7b-hf", "@cf/meta/llama-3.2-11b-vision-instruct", "@cf/huggingface/distilbert-sst-2-int8"], note: "llama-vision needs one-time /agree; llava may error 3016 on small/odd images" });
    }

    if (request.method === "POST" && url.pathname === "/agree") {
      // Accept Workers AI model agreement for llama vision (one-time per account).
      const body = await request.json().catch(() => ({}));
      if (body.prompt !== "agree") return json({ error: 'body must be {"prompt":"agree"}' }, 400);
      const r = await env.AI.run("@cf/meta/llama-3.2-11b-vision-instruct", { prompt: "agree" }).catch((e) => ({ error: e.message }));
      return json(r);
    }

    if (request.method === "POST" && url.pathname === "/analyze") {
      const body = await request.json().catch(() => ({}));
      const img = body.image; // b64 (optionally data: prefix) or [] of them
      const prompt = body.prompt || "Describe what is visible in this video frame in one sentence.";
      if (!img) return json({ error: "missing image" }, 400);

      try {
        const input = Array.isArray(img) ? img.map(normalizeImg) : [normalizeImg(img)];
        // Chain: LLaVA (vision) -> Llama-3.2-vision (vision, agreement now accepted) -> distilbert (text heuristic)
        const attempts = [
          { model: "@cf/llava-hf/llava-1.5-7b-hf", inputs: { image: input, prompt } },
          { model: "@cf/meta/llama-3.2-11b-vision-instruct", inputs: { image: input, prompt } },
        ];
        let lastErr = null;
        for (const a of attempts) {
          try {
            const result = await env.AI.run(a.model, a.inputs);
            return json({ model: a.model, result });
          } catch (e2) { lastErr = e2; }
        }
        // vision models all failed -> text heuristic
        const r = await env.AI.run("@cf/huggingface/distilbert-sst-2-int8", { text: prompt });
        return json({ model: "@cf/huggingface/distilbert-sst-2-int8", primaryFailed: String(lastErr?.message || lastErr).slice(0, 120), fallback: r });
      } catch (e) {
        const is3016 = /3016|decode/.test(String(e.message || e));
        if (is3016 || e.code === 3016) {
          const r = await env.AI.run("@cf/huggingface/distilbert-sst-2-int8", { text: prompt }).catch((e2) => ({ error: e2.message }));
          return json({ model: "@cf/huggingface/distilbert-sst-2-int8", primaryFailed: "llava-3016", fallback: r });
        }
        return json({ error: String(e.message || e) }, 502);
      }
    }

    return json({ error: "not found" }, 404);
  },
};

function normalizeImg(img) {
  if (typeof img !== "string") return img;
  if (img.startsWith("data:")) return img;
  return `data:image/jpeg;base64,${img}`; // assume jpeg; png also accepted if data: prefixed
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });
}