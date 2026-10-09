# CLAUDE.md: rp-harness

## What this is

An agentic roleplay harness and web app to replace SillyTavern. Read `README.md`, then `spec/OVERVIEW.md` and `spec/DESIGN.md`, before proposing designs.

## Design docs

- `spec/*.md` holds proposals and design records. They are tracked and committed.
- Once code exists, `ARCHITECTURE.md` will document only what is implemented. A spec's content moves there in the same commit as the code that implements it. Implemented specs are marked obsolete in their status header, never deleted. Only the maintainer deletes specs.
- `spec/DESIGN.md` marks each item **Decided** (the owner stated or confirmed it), **Proposed** (suggested, not yet confirmed) or **Open**. Never promote a Proposed item to Decided without the owner's confirmation.

## Reference implementation

The owner's reference-harness (`reference-harness/`; use the most recently modified worktree) already implements much of the core: LCM summarization (ARCHITECTURE.md §9b), timeline/rollout separation, session resume and fork (`src/agent/recovery.ts`, `src/agent/fork.ts`), cache breakpoints, decision models (`spec/DECISION-MODEL.md`), and OpenAI prefill (`spec/OPENAI-PREFILL.md`). Before designing any of these, read how reference-harness does it, and present designs as deltas from it.

## Privacy

Never read the owner's chat logs or character card definitions: not in the SillyTavern data directory, not in reference-harness data directories, nowhere. Use synthetic fixtures for tests, and the public ST source for format details.
