# Development workflow

**Status**: Proposed, 2026-10-11. Nothing here is confirmed by the owner yet.

**Goal:** defects and bloat get caught in the change that introduces them, not later, and without slowing work down. The rule that does most of it: no change is committed without a review by an agent that didn't write it, and debt never spans more than one slice.

## 1. Where we are (2026-10-11)

- **Independent review:** of the ~7,400 server lines, only the provider layer (8 commits, 2026-10-10) had a review by a separate agent, and that review found 9 defects (`dedd8cd`). Everything else was built and checked by the agent that wrote it:
  - the scaffold, server wiring and auth
  - the schema and message graph
  - library operations and three-way merge
  - drafts and the recycle bin
  - host-bound credentials and the registry
- **Today's exposure work** (three review rounds by one agent, about 6 minutes in total):
  - Round 1 found 4 defects, 2 of them security holes, all in code whose tests passed.
  - Round 2, on the fixes and the new cross-site guard, found 4 more. One broke every nginx-style proxy setup.
  - Round 3 found a gap: rebinding against a proxy-mode instance.
  - A mutation check showed that one of my own tests (rebinding) passed against the bug it was meant to catch.
  - A cross-cutting look found what no single diff contained: any website could drive a local instance's RPC API.
  - So diff reviews alone aren't enough, and neither are tests that are never checked against the bug they guard.
- **End-to-end:**
  - The server is tested at its real boundary: a real server, real database workers, and real sockets and WebSockets.
  - Providers run against mock servers, never a live one.
  - The Docker image is built in CI but never run there. It was run by hand once, today.
  - There's no browser test: the client is a 150-line shell.

## 2. The slice loop

A slice is one commit-sized change.
1. **Ask first** if it touches anything Open or Proposed. Questions are batched in PLAN.md's "Decisions waiting on the owner", so work doesn't stop on each one.
2. **Build it with tests at the real boundary:** the real workers, a real server, and later a real browser.
3. **Check each security test against its bug:** run it against the broken version and watch it fail. Today's half-open socket test passed against the bug until it checked that no handler ran.
4. **Trim:** before review, the author removes:
   - comments that restate the code
   - handling for states that can't occur
   - duplicated helpers
   - unused exports
5. **`npm run check`.**
6. **Independent review** by a fresh agent with none of the author's context:
   - Adversarial, ranked by DESIGN's priorities: isolation, secrets, RCE and exposure, then correctness.
   - Every finding must be reproduced. A separate section covers bloat.
   - How much depends on risk:

| Tier | What | Review |
|---|---|---|
| A | Isolation, secrets, auth, exposure, storage writes, plugins, anything that parses imported files | Full review, then the same agent verifies the fixes |
| B | Logic: assembler, graph, providers, LCM | One review |
| C | Docs only, styling, renames | No agent: the author's trim pass |

7. **Fix and commit.** The commit message lists the findings that were fixed.

**Speed:** the review runs in the background while the next slice starts. The rule is that slice N+1 isn't committed until slice N's findings are fixed, so debt is never more than one slice deep.

## 3. Guards that make classes of defects hard to forget

- **An isolation matrix test:** it lists every RPC in `AppApi`. Each must have a cross-user probe, or be marked global or create-only. A new RPC without an entry fails the suite. Today 12 of 26 RPCs have no cross-user test at the RPC level. Some are covered at the storage level, but nothing enforces it.
- **knip in `npm run check`:** fails on unused files, exports and dependencies.
- **A size line per commit:** source, test, comment and doc line counts, so growth is visible and gets questioned.
- **A Docker smoke test in CI:** the image must refuse to start without exposure settings, and serve `/healthz` with them.

## 4. Test tiers

- **Server (exists):** the real server, workers and sockets.
- **Browser:** Playwright from the first real screen (the connection settings). Every phase 2 feature gets a flow, and the performance harness (CLIENT-FRAMEWORK §7) runs on the same setup.
- **Live providers:** opt-in, run by the owner with real keys, never in CI.
- **ST differential tests:** phase 1, as planned.

## 5. Periodic audits

At the end of each phase, or after about ten slices:
- A fresh-eyes audit of whole subsystems, not diffs. Cross-cutting holes like the Origin one only show up this way.
- A check that ARCHITECTURE.md still matches the code.
- A trim of specs that the code has made obsolete.

**Backlog:** everything listed as unreviewed in §1 gets a tier A audit, one agent per subsystem, before phase 1 builds on it.

## 6. Parallel work

**Coding speed isn't the bottleneck.** Three things are:
- **The owner's decisions:** login is waiting on them, and so is every UI design.
- **Integration:** a few files every feature touches.
- **Review:** each stream needs its own reviewed slices.

So a parallel stream pays only when it needs none of these: decided already, in files no other stream touches, and with a test oracle of its own.

**Shared files, where parallel streams would collide:**
- `db/migrations.ts`: migrations are numbered in order.
- `db/ops.ts`: every storage operation.
- `shared/api.ts`: every RPC.
- `ARCHITECTURE.md` and `PLAN.md`.

Only one stream, the main one, edits these. Other streams write their ARCHITECTURE section into a note in their own directory, and it moves in when their work merges.

**Worth running in parallel now:**
1. **The main stream, sequential:** auth and security. Built-in login once the owner answers. Until then, the guards from §3: the isolation matrix, knip, and the Docker smoke test.
2. **Phase 1 format parsers, in a worktree:**
   - What: character cards (V1–V3 as JSON, PNG and CHARX, import and export), then lorebooks and presets, then the macro engine.
   - Why it fits:
     - These are pure functions.
     - Their spec is ST's public source.
     - They're tested with synthetic fixtures.
     - They don't touch the schema until the importer writes into it, and that step comes back to the main stream.
3. **The backlog audit, read-only:** fixes it finds go into the main stream's queue, so nothing collides.
4. **The connection settings UI design, as a proposal:** a mockup for the owner to review, with no code until it's approved.

**Not yet:**
- UI code before its design is approved: UI quality is the top priority, so rework is likely.
- Two streams adding migrations.
- The ST differential harness: it's worth doing, but its first user is the assembler (phase 2).
- More than two coding streams: review and integration go through one agent, and a third stream would mostly queue.

**Rules for a parallel stream:**
- It runs in its own git worktree, with its own `npm ci`.
- It follows the same slice loop and review tier as the main stream.
- It rebases onto `master` before every slice.
- The main stream merges it.
- Nothing merges with open findings.
- The host is shared, so test runs use random ports and their own data directories (they already do), and performance numbers are only trusted after checking `uptime`.
