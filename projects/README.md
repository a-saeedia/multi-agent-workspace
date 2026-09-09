# Multi-Project Index

Master index of projects extracted from the conversation (2026-09-08).

## Projects

| # | Project | Owner Agent(s) | Status |
|---|---------|----------------|--------|
| 01 | Telegram Bot on Cloudflare Workers (No VPS) | backend, devops, security | Ready |
| 02 | Agent-Driven Video Editing (FFmpeg + Hermes + OpenCode) | architect, backend, explore, reviewer | Ready |
| 03 | City World Animation (Blender + Agents) | architect, backend, general, reviewer | Ready |
| 04 | Multi-Agent Orchestration Layer | architect, backend, devops, reviewer | Ready |

## Agent → Project Map

| Agent | Project(s) | Primary Responsibility |
|-------|------------|------------------------|
| **backend** | 01, 02, 03, 04 | Implementation, controllers, scripts |
| **devops** | 01, 04 | Deploy (wrangler), parallelism/failure handling |
| **security** | 01 | Webhook validation, token guarding |
| **architect** | 02, 03, 04 | Pipeline & coordination design |
| **explore** | 02 | Codebase mapping |
| **general** | 03 | Blender automation research |
| **reviewer** | 02, 03, 04 | Pre-ship validation |

## Themes Threading Through All Projects
- **Zero budget** — all tools open-source / free tier.
- **Agent-driven** — Hermes orchestrates, OpenCode infers, humans direct.
- **Serverless where possible** (Project 01) — no persistent VPS.
- **Massive parallelization** (Project 04) powers Projects 02 and 03.

## Suggested Build Order
1. **04 Orchestration layer** — the foundation, everything else uses it.
2. **01 Telegram bot on Workers** — quickest win, standalone, validates CF path.
3. **02 Video editing pipeline** — uses the orchestration layer + FFmpeg.
4. **03 City world** — the marathon; layers built on prior projects.
