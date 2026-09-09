# Project 02: Agent-Driven Video Editing (FFmpeg + Hermes + OpenCode)

## Origin
User tried to edit video in Adobe Premiere via agents and hated it. Wants an
open-source, agent-integrated pipeline. Zero budget.

## Decision
Drop Premiere (proprietary, not agent-friendly). Use:
- **FFmpeg** — frame extraction, slicing, filters, audio, reassembly, AI inference hooks.
- **Python** — controller/scheduler glue.
- **Hermes** — orchestrator agent (dispatches tasks).
- **OpenCode** — model inference / analysis agent (object recognition, style transforms).

## Why Premiere failed for this
Premiere is a GUI behemoth, not designed for agent-driven automation. Its UXP
API is limited for programmatic video manipulation. FFmpeg is a headless,
scriptable powerhouse.

## Pipeline Shape
```
[Hermes orchestrator]
        |  task queue
        v
[OpenCode inference] <--> [FFmpeg frame ops] --> [reassembled video]
```

## Agent Assignment
- **architect** — design the pipeline / task model.
- **backend** — Python controller, FFmpeg wrapper, frame ops.
- **explore** — map existing bot / codebase if any.
- **reviewer** — validate before shipping.

## Deliverables
- Python controller dispatching FFmpeg tasks.
- Hermes ↔ OpenCode coordination.
- Frame-by-frame edit + reassembly scripts.
- 100% free / open-source.
