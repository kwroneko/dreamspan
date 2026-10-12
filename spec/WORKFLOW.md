# Development workflow

**Status**: Proposed, 2026-10-11. Nothing here is confirmed by the owner yet.

**Goal:** defects and bloat get caught in the change that introduces them, not later, and without slowing work down. The rule that does most of it: no change is committed without a review by an agent that didn't write it, and debt never spans more than one slice.

## 1. Where we are (2026-10-11)

- **Every subsystem has had a tier A audit** by a separate agent, then fixes in four parallel worktrees, each reviewed until clean before merging.
  - The audit found 44 defects. Review rounds on the fixes found about 20 more.
  - Several were cross-user holes, the top requirement: any client could become any user in proxy mode; any website could drive a local instance; state events and swipes could reference other users' data; one `UPDATE` could hand rows to another user.
- **Every fix has a test checked against its bug.** Mutation checks caught three tests of my own that passed against the bug they were meant to guard.
- **What went wrong in the process:**
  - An audit agent ran `docker volume prune -f` on the shared host. Every agent prompt now forbids host-wide cleanup.
  - Agents overwrote each other's scripts in the shared scratchpad, so each agent now keeps its own subdirectory.
- **Test tiers:**
  - The server is tested at its real boundary: real server, real database workers, real sockets.
  - The Docker image is built and run in CI.
  - No browser tests yet.

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

**Who reviews (owner, 2026-10-12):** reviewers run on Codex (`codex exec`), on the owner's OpenAI quota, to save Claude quota. At first both GPT-6.1-Sol and GPT-6-Astra review the same branch, each in its own copy of the worktree, and their findings are compared: real findings each one caught, false positives, time. Now and then an Opus reviewer joins for an A/B against them. The results go in §7, and decide the default.

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
- **The owner's decisions:** few block work now. UI is built on stock components without a design gate (owner, 2026-10-11; CLIENT-FRAMEWORK §8).
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
4. **The connection settings UI and the login page,** on stock components (owner, 2026-10-11: no custom design until most functionality exists).
5. **More streams when they don't collide:** the owner wants development speed to pick up (2026-10-11), so independent pure-function work (the macro engine, presets, lorebooks) runs as its own streams.

**Not yet:**
- Two streams adding migrations.
- The ST differential harness: it's worth doing, but its first user is the assembler (phase 2).

**Rules for a parallel stream:**
- It runs in its own git worktree, with its own `npm ci`.
- It follows the same slice loop and review tier as the main stream.
- It rebases onto `master` before every slice.
- The main stream merges it.
- Nothing merges with open findings.
- The host is shared, so test runs use random ports and their own data directories (they already do), and performance numbers are only trusted after checking `uptime`.

## 7. Reviewer comparison

Results of running Codex reviewers (GPT-6.1-Sol, GPT-6-Astra) and Opus reviewers on the same branches. Both Codex reviewers run through `codex exec` at high reasoning effort, the default the owner set in `~/.codex/config.toml` (`model_reasoning_effort = "high"`); the review command doesn't override it.

| Branch | Opus | Sol | Astra |
|---|---|---|---|
| L (ST folder importer), after an Opus review had found and fixed 9 | 9, before the others ran | Crashed at 18 min ("model at capacity") with no report, but left 7 adversarial tests, 6 failing (5 not found by Astra) | 8 min, 5 reproduced findings (1 high) |
| K (chat setup, send queue) | none | 21 min, 7 medium, all with repro tests | 18 min, 7 (2 high); 4 shared with Sol |
| J (context assembler, real generation), after two Opus reviews | 2 rounds, fixed before the others ran | Stopped at 14 min by OpenAI's cybersecurity filter, no report | 17 min, 9 reproduced (1 high) |
| M (card and preset editors) | none | 17 min, 8 (3 high), including the only silent data loss (text stripped at unknown paths) | 12 min, 6 (1 high); 5 shared with Sol, 1 unique |
| N (branch switcher, bin, composer drafts, notifications) | none | 27 min, 14 (7 high), 7 unique to Sol, including queue cleanup deleting the only copy of composer text and EmptyBin purging items added after the confirmation | 15 min, 8 (3 high); 7 shared with Sol, 1 unique (an idle tab overwriting another's newer draft) |
| O (notes in the chat, the author's note in the assembler) | none | 26 min, 7 (2 high); 5 shared with Astra, 2 unique, including an ST mismatch it found by writing its own gate fixtures | 19 min, 8 (2 high); 5 shared, 3 unique |
| P (request inspector, cache warmth) | none | 35 min with a capacity failure and a resume, 12 (1 high); 8 shared with Astra, 4 unique | 17 min, 9 (1 high); 8 shared, 1 unique |
| Lorebook matcher (written by Sol) | none | (author) | 17 min, 7 (2 high): unbounded work on a 10,000-entry book, a long plain key that throws, replay that depends on the clock |
| Lorebook wiring (written by Sol) | none | (author) | 3 rounds: 6 (2 high), then 2 (1 high), then none |
| N fix rounds (Opus twice, then Sol twice) | none | Verified rounds 1–2 and reviewed round 4 fresh: found 5, then 9 (3 high), and showed the model test caught 1 of 6 planted defects | Fresh-eyes review after round 3 found 7 (6 high); final review found 4 (1 medium), model caught 4 of 8 planted defects |
| Integration (N + O + lorebook wiring + P) | none | (fixer) | Seams: 5 (4 medium); final: 4 (1 medium), no loss reproduced |
| Fix verifications (K round 2, L rounds 2–3) | none | 13–25 min each. Found real gaps every time, including a P1 data loss in L's undo path | not run |

So far:
- Each Codex reviewer found real defects that the other missed. On K, three of each reviewer's seven findings were unique to it.
- Both found defects after an Opus review was already done (L).
- Sol writes repro tests for everything. Astra's reports state the method less often.
- Sol failed four times: three times at capacity (twice on 2026-10-12 afternoon, both resumed with `codex exec resume <session id>` without losing work), once on the cybersecurity filter. The filter was triggered by prompt wording ("adversarial", attacks on keys and regex); prompts now ask for a defensive review instead. Astra hasn't failed yet, and is faster here, not slower.
- On M and N, Sol found more, and caught the worse defects. On N, Astra's report was nearly a subset of Sol's, in half the time. On L and J, Astra produced the only complete report.
- A fresh reviewer keeps finding new defect classes in code that earlier rounds called clean (N: Astra's fresh pass after three rounds found 6 high). For protocols with races, stating invariants and testing them with a randomized model, then planting defects to check that model, converged faster than fixing reported cases one by one.
- Fixes by Sol held up as well as fixes by Opus on the same stream (N, P, lorebook), at no Claude quota.
- So far running both is worth it: neither reviewer's findings contain the other's, and both keep finding real defects after Opus reviews.
