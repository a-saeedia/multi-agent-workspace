/**
 * Op: concat — concatenate clips (same codec/params) using the concat demuxer.
 */
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const { run } = require("../lib/ffmpeg");

async function concat(opts) {
  const { inputs, output } = opts;
  if (!inputs || inputs.length < 2) throw new Error("concat: need >=2 inputs");
  if (!output) throw new Error("concat: need output");

  // List file for concat demuxer. On Windows, escape single quotes.
  const listPath = path.join(os.tmpdir(), `concat-${Date.now()}.txt`);
  const lines = inputs.map((p) => `file '${p.replace(/'/g, "'\\''")}'`);
  fs.writeFileSync(listPath, lines.join("\n") + "\n");

  const args = ["-y", "-f", "concat", "-safe", "0", "-i", listPath, "-c", "copy", output];
  try {
    await run(args);
  } finally {
    fs.rmSync(listPath, { force: true });
  }
  return { output, parts: inputs.length };
}

module.exports = { concat };