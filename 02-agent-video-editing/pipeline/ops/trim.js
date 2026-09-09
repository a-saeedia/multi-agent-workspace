/**
 * Op: trim — cut a sub-clip [start, end] seconds.
 */
const path = require("node:path");
const { run, probe } = require("../lib/ffmpeg");

async function trim(opts) {
  const { input, start = 0, end = null, output = null, outDir = null, reencode = false } = opts;
  if (!output && !outDir) throw new Error("trim: need output or outDir");
  const out = output || path.join(outDir, `trim_${start}_${end || "end"}.mp4`);

  const meta = await probe(input);
  const duration = parseFloat(meta.format?.duration || 0);
  const endSec = end ?? duration;

  const args = ["-y"];
  // Input seek for stream-copy accuracy: -ss BEFORE -i seeks at demuxer level
  // and keeps the video stream aligned. Output seek (-to) stays after -i.
  args.push("-ss", String(start), "-i", input, "-to", String(endSec));
  if (!reencode) {
    args.push("-c", "copy");
  } else {
    args.push("-c:v", "libx264", "-preset", "fast", "-crf", "18", "-c:a", "aac");
  }
  args.push("-avoid_negative_ts", "make_zero", out);

  await run(args);
  return { output: out, start, end: endSec, duration: endSec - start };
}

module.exports = { trim };