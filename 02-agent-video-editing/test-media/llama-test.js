async (b64) => {
  const r = await cloudflare.request({
    method: "POST",
    path: "/accounts/28290e9dd8d7b066c3f2c1dd7ff12fc3/ai/run/@cf/meta/llama-3.2-11b-vision-instruct",
    body: { image: [b64], prompt: "Reply with ONLY what object/pattern is in this image, one word." }
  });
  return r;
}