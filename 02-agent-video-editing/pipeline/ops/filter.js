/**
 * Op: filter — apply video filters (grayscale, speed, scale, crop, rotate).
 * Accepts raw filter chains too.
 */
const path = require("node:path");
const { run, probe } = require("../lib/ffmpeg");

/**
 * @param {object} opts {input, output?, outDir?, filter?|preset?, ...}
 * presets: grayscale | speedx2 | scale | crop | rotate90 | custom
 */
async function filter(opts) {
  const { input, output = null, outDir = null, preset = null, filter = null, value = null } = opts;
  if (!output && !outDir) throw new Error("filter: need output or outDir");
  const out = output || path.join(outDir, `filtered_${preset || "custom"}.mp4`);

  let vf;
  switch (preset) {
    case "grayscale": vf = "hue=s=0"; break;
    case "speedx2": vf = "setpts=0.5*PTS"; break;
    case "speedx4": vf = "setpts=0.25*PTS"; break;
    case "scale": vf = `scale=${value || "640:360"}`; break;
    case "rotate90": vf = "transpose=1"; break;
    case "custom": vf = filter; break;
    default: vf = filter; break;
  }
  if (!vf) throw new Error(`filter: no filter specified (preset=${preset})`);

  const meta = await probe(input);
  const hasAudio = (meta.streams || []).some((s) => s.codec_type === "audio");

  const args = ["-y", "-i", input, "-vf", vf];
  // Audio must be re-encoded when timestamps change (speed preset).
  const audioReencode = preset && preset.startsWith("speed");
  if (audioReencode && hasAudio) {
    args.push("-c:v", "libx264", "-preset", "fast", "-crf", "18", "-af", "atempo=2.0", "-c:a", "aac");
  } else {
    args.push("-c:v", "libx264", "-preset", "fast", "-crf", "18", hasAudio ? "-c:a" : null, hasAudio ? "aac" : null);
  }
  args.push("-movflags", "+faststart", out);

  await run(args.filter((a) => a !== null));
  return { output: out, vf };
}

module.exports = { filter };