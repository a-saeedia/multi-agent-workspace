/**
 * Op: extract — pull frames from a video at a fixed interval (or as contact sheet).
 */
const path = require("node:path");
const { run } = require("../lib/ffmpeg");

/**
 * @param {object} opts {input, outDir, fps?, pattern?, scale?, maxFrames?}
 * @returns {{framesDir: string, pattern: string, count: number}}
 */
async function extract(opts) {
  const { input, outDir, fps = 1, scale = null, pattern = "frame-%04d.jpg", maxFrames = 0 } = opts;
  const framesDir = path.join(outDir, "frames");
  require("node:fs").mkdirSync(framesDir, { recursive: true });
  const outPattern = path.join(framesDir, pattern);

  const args = ["-y", "-i", input, "-vf", `fps=${fps}${scale ? `,scale=${scale}` : ""}`];
  if (maxFrames > 0) args.push("-frames:v", String(maxFrames));
  args.push("-q:v", "3", outPattern);

  await run(args);
  const fs = require("node:fs");
  const count = fs.readdirSync(framesDir).filter((f) => /\.(jpg|png)$/i.test(f)).length;
  return { framesDir, pattern, count };
}

module.exports = { extract };