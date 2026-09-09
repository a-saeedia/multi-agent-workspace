/**
 * Sample task handlers for the orchestration controller.
 * These simulate parallel "agents" — here mostly toy work so tests are fast
 * and deterministic. Swap these with real agent calls (runAgent to opencode/
 * hermes CLIs, runFfmpeg for video ops) in production.
 */
const { runAgent, runFfmpeg } = require("../controller");
const FFMPEG = process.env.FFMPEG || "C:\\Users\\User\\tools\\ffmpeg\\ffmpeg.exe";
const FFPROBE = process.env.FFPROBE || "C:\\Users\\User\\tools\\ffmpeg\\ffprobe.exe";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

module.exports = {
  /** Simulated LLM inference agent (e.g. OpenCode): returns an echo + latency. */
  async llm_infer(payload) {
    await sleep(payload.latencyMs || 50);
    return { model: payload.model || "opencode", text: `processed: ${payload.text || ""}` };
  },

  /** Simulated video-frame agent: returns a fake "analysis". */
  async video_analyze(payload) {
    await sleep(payload.latencyMs || 30);
    return { frames: payload.frames || 1, verdict: "clean", source: payload.path || "n/a" };
  },

  /** Real agent CLI runner example: `opencode run "do x"`. */
  async opencode_run(payload) {
    const parts = payload.command.trim().split(/\s+/);
    return runAgent(parts[0], parts.slice(1), { cwd: payload.cwd });
  },

  /** Real FFmpeg task: probe a video file's duration using ffprobe. */
  async media_probe(payload) {
    return new Promise((resolve, reject) => {
      require("node:child_process").execFile(
        FFPROBE,
        ["-v", "error", "-show_entries", "format=duration,size", "-of", "json", payload.path],
        { timeout: 60000, windowsHide: true },
        (err, stdout) => {
          if (err) reject(new Error(`ffprobe failed: ${err.message}`));
          else resolve(JSON.parse(stdout));
        }
      );
    });
  },
};