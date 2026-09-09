# Project 03: City World Animation (South-Park-style Living City)

## Vision
Create a whole animated city with characters — agents that talk, interact, and
live inside it. A personal episodic animation universe.

## Stack Decision
User already works with **Blender**. Blender has a learning curve, but the user
plans to delegate heavy modeling/animation to agents, so Blender stays.

- **Blender** — 3D world / characters / camera / scene assembly.
- **Auto-Rig Pro (add-on)** — character rigging for interaction.
- **AI dialogue** — fine-tuned GPT / OpenCode to generate character dialogue.
- **Hermes** — triggers scenes, orchestrates the pipeline.
- **OpenCode** — dialogue generation + any inference.
- Rendering happens in Blender (EEVEE/Cycles) driven by agents tweaking params.

## Type of work
Not motion graphics per se — stylized **3D animated episodic world** with real
spatial depth, characters acting as interacting agents. A marathon, each layer
achievable with open tools + heavy scripting.

## Layer Breakdown
1. **World building** — city layout, buildings, props (agent-assisted Blender).
2. **Characters** — models, rigs (Auto-Rig Pro / agent-driven), identities.
3. **Agents/dialogue** — LLM-driven conversation between characters.
4. **Animation** — scene triggers, camera paths, lip-sync.
5. **Pipeline** — Hermes orchestrates scenes → OpenCode writes dialogue → Blender animates/renders.

## Agent Assignment
- **architect** — overall pipeline + scene state model.
- **backend** — Blender Python scripting (`bpy`), automation, render orchestration.
- **general** — researching Blender automation patterns / add-ons.
- **reviewer** — validate renders / scene assembly.

## Deliverables
- Blender scene scripts (`.py` driven via `bpy`).
- Character dialogue engine wired to OpenCode.
- Hermes orchestration loop (scene → dialogue → render).
- Rendering automation for episodes.
