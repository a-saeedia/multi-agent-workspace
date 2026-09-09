/**
 * Op: contact-sheet — grid of frames from a video into one image.
 */
const path = require("node:path");
const { run } = require("../lib/ffmpeg");

/**
 * @param {object} opts {input, output, cols=4, rows=3, interval?}
 */
async function contactSheet(opts) {
  const { input, output, cols = 4, rows = 3, interval = null, thumbnail = "100" } = opts;
  if (!output) throw new Error("contact-sheet: need output");
  const total = cols * rows;
  const select = interval
    ? `select='not(mod(n\\,${Math.max(1, Math.round(interval))}))'`
    : `select='not(mod(n\\,2))'`;
  const vf = `${select},scale=${thumbnail}:-1,tile=${cols}x${rows}`;

  const args = ["-y", "-i", input, "-vf", vf, "-frames:v", "1", output];
  await run(args);
  return { output, tiles: total };
}

module.exports = { contactSheet };