# Project 04: Multi-Agent Orchestration Layer

## Origin
User noticed "Claude Code" can open ~6 instances simultaneously and work in
parallel. Wants the same capability with Hermes + OpenCode + (free) open tools —
zero budget.

## Goal
A lightweight **multi-agent coordination layer** with no proprietary lock-in:
agent instances run in parallel, each on a discrete unit of work, coordinated
by Hermes.

## Orchestration Loop (from conversation)
1. **Task generation** — the controller defines a queue of units of work
   (video frame, dialogue prompt, render chunk).
2. **Agent dispatch** — Hermes dispatches tasks to separate worker agents,
   each on its own thread/process.
3. **Parallel processing** — workers run concurrently (OpenCode does inference,
   FFmpeg slices frames, etc.).
4. **Result aggregation** — controller collects and synchronizes results back.

## Controller Shape (Python)
```python
# queue -> dispatch -> parallel workers -> aggregate
task_queue = ...
for task in task_queue:
    dispatch_to_agent(task)     # spawn worker
results = collect(all_workers)  # gather + sync
```
"FreeBuf" — the user means a free/open scaling mechanism, not the security site.
Treat as: scale requests across infra with open tools (asyncio / multiprocessing /
subprocess workers calling OpenCode/Hermes CLIs).

## Agent Assignment
- **architect** — coordination design, worker model, message passing.
- **backend** — Python controller, dispatch/sync, parallelism.
- **devops** — process/multiprocessing management, failure handling.
- **reviewer** — concurrency correctness, resource limits.

## Deliverables
- Parallel dispatch controller (Python).
- Worker abstraction wrapping Hermes/OpenCode/FFmpeg subprocesses.
- Result aggregation + error handling.
- Concurrency-safe, free, open-source.
