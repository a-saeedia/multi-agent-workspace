# P02 — Agent-Driven Video Editing

Local FFmpeg pipeline coordinated by agents, AI analysis on Cloudflare Workers AI.

## Layout
```
test-media/          sample.mp4 (6s testsrc+audio), frames, base64 test images
pipeline/
  lib/ffmpeg.js      ffmpeg/ffprobe runners + probe()
  ops/extract.js     frames at fps interval
  ops/trim.js        sub-clip cut (stream-copy safe: -ss before -i)
  ops/concat.js      concat demuxer (same-codec clips)
  ops/filter.js      grayscale / speed / scale / rotate / custom
  ops/contact-sheet.js  tile of frames into one image
  vision.js          Workers AI client (LLaVA→LlamaVision→distilbert fallback)
  pipeline.js        job orchestrator (steps chain)
  cli.js             CLI
worker/              Cloudflare Worker: /analyze (vision), /agree, /models
scripts/test-smoke.* local end-to-end smoke tests
```

## CLI
```
node pipeline/cli.js info <video>                          # ffprobe JSON
node pipeline/cli.js quick <video> --trim 1:4 --gray       # trim→gray→frames
node pipeline/cli.js run <job.json>                        # arbitrary step chain
node pipeline/cli.js analyze <image>                       # Workers AI vision (needs CF creds env)
```

## Job spec
```json
{ "input": "clip.mp4", "outDir": "out",
  "steps": [
    { "op": "trim",      "start": 0, "end": 2 },
    { "op": "filter",    "preset": "grayscale" },
    { "op": "extract",   "fps": 1 },
    { "op": "analyze",   "frames": ["out/step3/frames/*"] }
  ]
}
```

## Verified behaviors
- PROBE: streams + format JSON ✔
- TRIM: `-c copy` needs `-ss` BEFORE `-i` — output-seek copy silently drops video (video:0KiB). Fixed & documented.
- FILTER: grayscale, speed (atempo for audio), scale ✔
- EXTRACT: 1fps → jpg frames ✔
- VISION: LLaVA errors 3016 (account-level decode issue on every payload shape incl. public image URL); llama-vision needs one-time Model Agreement (`/agree` on the worker); distilbert sentiment works. `vision.js` tries in order and reports which model answered.

## Status
**Implemented & locally verified** (real FFmpeg, end-to-end trim→filter→extract). AI analysis ready to run via deployed worker or with a write-capable token.