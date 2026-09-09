/**
 * Shared FFmpeg/FFprobe helpers for the video pipeline.
 * Pure functions + one async runner; no global state.
 */
const { execFile } = require("node:child_process");

const FFMPEG = process.env.FFMPEG || "C:\\Users\\User\\tools\\ffmpeg\\ffmpeg.exe";
const FFPROBE = process.env.FFPROBE || "C:\\Users\\User\\tools\\ffmpeg\\ffprobe.exe";

/** Run ffmpeg with the given args; resolve on exit 0, reject with stderr tail. */
function run(args, { timeoutMs = 300000, ffmpeg = FFMPEG } = {}) {
  return new Promise((resolve, reject) => {
    execFile(ffmpeg, args, { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      if (err) reject(new Error((stderr || String(err)).split("\n").slice(-15).join("\n")));
      else resolve(stdout);
    });
  });
}

/** Probe media with ffprobe -> JSON {streams, format}. */
function probe(path, { ffprobe = FFPROBE, timeoutMs = 30000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile(
      ffprobe,
      ["-v", "error", "-show_entries", "stream=index,codec_type,codec_name,width,height,r_frame_rate,sample_rate,channels,duration:format=duration,size,bit_rate,format_name", "-of", "json", path],
      { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, windowsHide: true },
      (err, stdout) => {
        if (err) reject(new Error(`ffprobe failed on ${path}: ${err.message}`));
        else {
          try { resolve(JSON.parse(stdout)); } catch (e) { reject(new Error("bad ffprobe json: " + e.message)); }
        }
      }
    );
  });
}

module.exports = { FFMPEG, FFPROBE, run, probe };