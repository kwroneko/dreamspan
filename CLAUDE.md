# CLAUDE.md: Dreamspan

## What this is

An agentic roleplay harness and web app to replace SillyTavern. Read `README.md`, then `spec/OVERVIEW.md` and `spec/DESIGN.md`, before proposing designs.

## Design docs

- `spec/*.md` holds proposals and design records. They are tracked and committed.
- Once code exists, `ARCHITECTURE.md` will document only what is implemented. A spec's content moves there in the same commit as the code that implements it. Implemented specs are marked obsolete in their status header, never deleted. Only the maintainer deletes specs.
- `spec/DESIGN.md` marks each item **Decided** (the owner stated or confirmed it), **Proposed** (suggested, not yet confirmed) or **Open**. Never promote a Proposed item to Decided without the owner's confirmation.

## Reference implementation

The owner's reference-harness (a public repository; read a current clone of it) already implements much of the core: LCM summarization (ARCHITECTURE.md §9b), timeline/rollout separation, session resume and fork (`src/agent/recovery.ts`, `src/agent/fork.ts`), cache breakpoints, decision models (`spec/DECISION-MODEL.md`), and OpenAI prefill (`spec/OPENAI-PREFILL.md`). Before designing any of these, read how reference-harness does it, and present designs as deltas from it.

## Code conventions

- Read `ARCHITECTURE.md` before changing code. It documents what's implemented.
- **Effect 4.x only.** Agents tend to write Effect 3 APIs. Work from `node_modules/effect/AGENTS.md`, `node_modules/effect/ai-docs/` and the module sources, not from memory or web search.
- **SQLite never runs on the main thread.** Add storage operations to `packages/server/src/db/ops.ts` and implement them in the writer or reader worker. A write operation is one synchronous transaction with no non-database work inside.
- **Client styling uses semantic tokens only** (the default Tailwind palette is removed). Feature code imports UI from `packages/client/src/ui/`, never from Base UI directly.
- Pin dependencies to exact versions, and only to releases at least 5 days old.
- Run `npm run check` before committing: static checks and the fast tests. `npm run test:slow` runs the scale, model-based, timing and process-spawn tests that `npm test` leaves out (ARCHITECTURE.md §1); the coordinator runs it before a deploy. `npm run build` builds the client and the database worker bundles.

## Privacy

Never read the owner's chat logs or character card definitions: not in the SillyTavern data directory, not in reference-harness data directories, nowhere. Use synthetic fixtures for tests, and the public ST source for format details.
