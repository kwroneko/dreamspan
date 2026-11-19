// Subagents that work on files, after review (review-subagents679 findings 1–4 and 11): a fork in
// a copy works in its copy, not where the reply's conversation last was; a copy is settled when
// the reply is stopped too, and one the app left unsettled is settled later; under Ask first a
// copy is made only once the user allows it; nothing a repository's settings name runs while a
// copy is made or checked; ignored output keeps a copy; a call the reply's limits refuse never
// gets a copy; a re-made copy is held to the quota; a branch that's already there is never
// removed. Copies are made in the sandbox, so these need bubblewrap. Synthetic data, scripted
// loopback provider.
import { existsSync } from "node:fs"
import { readFile, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"
import type { ApprovalPrompt, RolloutStep, SubagentRow } from "@dreamspan/shared/agent.ts"
import type { ChatEvent } from "@dreamspan/shared/chatApi.ts"
import { settleOrphanedCopies } from "../src/agent/subagents.ts"
import type { SubagentCopyRecord } from "../src/db/subagents.ts"
import type { ToolContext } from "../src/agent/tools.ts"
import { Reader, Writer } from "../src/db/Database.ts"
import { ExecutionRegistry } from "../src/execution.ts"
import { linuxBwrap } from "../src/sandbox/linuxBwrap.ts"
import { serverLayer, testConfig } from "./support/config.ts"
import { eventually, finished } from "./support/generation.ts"
import { fixtureSql } from "./support/lcmFixtures.ts"
import {
  type Api,
  childOf,
  filesWorkshop,
  git,
  ownResults,
  parentResults,
  results,
  runTask,
  scripted,
  startTask
} from "./support/subagentFiles.ts"

const commands = (await linuxBwrap.available()).ok

const rowsOf = (steps: ReadonlyArray<RolloutStep>) =>
  steps.flatMap((s): ReadonlyArray<SubagentRow> => (s.kind === "tool" && s.subagent ? [s.subagent] : []))
const hostPath = (root: string, path: string) => join(root, path.slice("/files/".length))
const COMMIT = "git -c user.email=t@example.com -c user.name=T commit -qm first"

/** Waits for the call's step to ask the user, then returns what it asks. */
const prompted = (events: ReadonlyArray<ChatEvent>, callId: string, which: (p: ApprovalPrompt) => boolean) =>
  Effect.gen(function* () {
    const find = () =>
      events
        .flatMap((e) => (e._tag === "Steps" ? e.steps : []))
        .flatMap((s) =>
          s.kind === "tool" && s.id === callId && s.status === "waiting" && s.approval ? [s.approval] : []
        )
        .filter(which)
        .at(-1)
    yield* eventually(() => find() !== undefined, 20_000)
    return find()!
  })
const answer = (api: Api, prompt: ApprovalPrompt, choice: "allow" | "deny") =>
  api.AnswerToolApproval({
    rolloutId: prompt.rolloutId,
    toolCallId: prompt.toolCallId,
    digest: prompt.digest,
    answer: choice
  })

describe.skipIf(!commands)("subagents' copies after review", () => {
  // Finding 1.
  it.live("a fork in a copy starts its commands and file tools in its copy, not the reply's last folder", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      const flow = scripted(
        [
          { name: "bash", args: { command: "mkdir -p draft && echo one > draft/a.txt && cd draft" } },
          { name: "agent", args: { type: "code", task: "[[forked]] Add b.", context: "fork", copy: true } }
        ],
        {
          forked: [
            { name: "bash", args: { command: "pwd" } },
            { name: "write_file", args: { path: "b.txt", content: "bee\n" } }
          ]
        }
      )
      const { api, chat, events, mock, me } = yield* filesWorkshop(flow.handler)
      const versionId = yield* runTask(api, chat, events, "fork in a copy")
      assert.strictEqual(finished(events, versionId)!.status, "complete")
      const root = join(config.dataDir, "files", me.id)
      const steps = ownResults(childOf(mock.requests(), "forked").at(-1)!)
      const [row] = rowsOf(yield* api.GetRolloutSteps({ versionId }))
      const copy = row!.copy!.path
      assert.include(steps[0], `Directory after: ${copy}\n`)
      assert.include(steps[1], `Created ${copy}/b.txt`)
      // The user's folder is untouched; the copy has the change and is kept.
      assert.isFalse(existsSync(join(root, "draft/b.txt")))
      assert.strictEqual(yield* Effect.promise(() => readFile(join(hostPath(root, copy), "b.txt"), "utf8")), "bee\n")
      assert.isTrue(row!.copy!.kept)
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  })

  // Finding 2.
  it.live("stopping the reply settles its subagents' copies: a changed one is kept, with its row in Changes", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      const flow = scripted(
        [
          { name: "bash", args: { command: "mkdir -p notes && echo one > notes/a.txt && cd notes" } },
          { name: "agent", args: { type: "code", task: "[[changing]] Add c.", copy: true } }
        ],
        { changing: [{ name: "write_file", args: { path: "c.txt", content: "sea\n" } }] }
      )
      flow.hold("changing", 1)
      const { api, chat, events, me } = yield* filesWorkshop(flow.handler)
      const versionId = yield* startTask(api, chat, "stop while it works")
      yield* eventually(() => flow.isHeld(), 60_000)
      yield* api.StopGeneration({ versionId })
      yield* eventually(() => finished(events, versionId) !== undefined, 60_000)
      const root = join(config.dataDir, "files", me.id)
      const effects = yield* api.ListRolloutEffects({ chatId: chat.id })
      const kept = effects.find((e) => e.kind === "subagent.copy")
      assert.isDefined(kept, "the kept copy is listed in Changes")
      assert.strictEqual(kept!.subagent?.handle, "code-1")
      const [row] = rowsOf(yield* api.GetRolloutSteps({ versionId }))
      assert.isTrue(row!.copy!.kept)
      assert.isTrue(existsSync(join(hostPath(root, row!.copy!.path), "c.txt")))
      flow.release()
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  })

  // Finding 2.
  it.live("stopping the reply removes an unchanged copy, and a copy the app left unsettled is settled later", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      const flow = scripted(
        [
          { name: "bash", args: { command: "mkdir -p notes && echo one > notes/a.txt && cd notes" } },
          { name: "agent", args: { type: "code", task: "[[looking]] Read a.", copy: true } },
          { name: "agent", args: { type: "code", task: "[[writing]] Add d.", copy: true } }
        ],
        {
          looking: [{ name: "read_file", args: { path: "a.txt" } }],
          writing: [{ name: "write_file", args: { path: "d.txt", content: "dee\n" } }]
        }
      )
      flow.hold("looking", 1)
      const { api, chat, events, me } = yield* filesWorkshop(flow.handler)
      const stoppedId = yield* startTask(api, chat, "stop while it reads")
      yield* eventually(() => flow.isHeld(), 60_000)
      yield* api.StopGeneration({ versionId: stoppedId })
      yield* eventually(() => finished(events, stoppedId) !== undefined, 60_000)
      const root = join(config.dataDir, "files", me.id)
      const [stopped] = rowsOf(yield* api.GetRolloutSteps({ versionId: stoppedId }))
      assert.strictEqual(stopped!.copy!.kept, false)
      assert.isFalse(existsSync(hostPath(root, stopped!.copy!.path)), "the unchanged copy is gone")
      flow.release()

      // A copy whose run ended without settling it (the app stopped mid-run), unchanged again.
      const versionId = yield* runTask(api, chat, events, "write, then the app stops")
      const writing = rowsOf(yield* api.GetRolloutSteps({ versionId })).find((r) => r.copy?.kept === true)!
      yield* fixtureSql(config.dataDir, [
        {
          sql: "DELETE FROM rollout_effects WHERE rollout_id = ? AND tool_call_id = 'subagent-copy'",
          params: [writing.rolloutId]
        },
        {
          sql: "DELETE FROM rollout_receipts WHERE rollout_id = ? AND tool_call_id = 'subagent-copy'",
          params: [writing.rolloutId]
        }
      ])
      yield* Effect.promise(() => rm(join(hostPath(root, writing.copy!.path), "d.txt")))
      const registry = yield* ExecutionRegistry
      const settled = yield* settleOrphanedCopies(
        { reader: yield* Reader, writer: yield* Writer },
        registry.subagentWorkspaces.get("files")!,
        Date.now() + 1
      )
      assert.strictEqual(settled, 1)
      assert.isFalse(existsSync(hostPath(root, writing.copy!.path)))
      const after = rowsOf(yield* api.GetRolloutSteps({ versionId })).find((r) => r.rolloutId === writing.rolloutId)
      assert.strictEqual(after!.copy!.kept, false)
      // Settled once: a second sweep finds nothing.
      assert.strictEqual(
        yield* settleOrphanedCopies(
          { reader: yield* Reader, writer: yield* Writer },
          registry.subagentWorkspaces.get("files")!,
          Date.now() + 1
        ),
        0
      )
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  })

  // Finding 3.
  it.live("under Ask first, a copy is made only once the user allows it, and the question says where", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      const flow = scripted(
        [
          { name: "bash", args: { command: "mkdir -p draft && echo one > draft/a.txt && cd draft" } },
          { name: "agent", args: { type: "code", task: "[[denied]] Anything.", copy: true } },
          { name: "agent", args: { type: "code", task: "[[allowed]] Report.", copy: true } }
        ],
        {}
      )
      const { api, chat, events, mock, me } = yield* filesWorkshop(flow.handler)
      yield* api.SetWorkshopGrant({ chatId: chat.id, capability: "files", mode: "ask" })
      const versionId = yield* startTask(api, chat, "copies under ask first")
      const first = yield* prompted(events, "parent-1", (p) => p.title.includes("copy"))
      const root = join(config.dataDir, "files", me.id)
      assert.deepStrictEqual(
        first.rows.map((r) => r.label),
        ["Copies", "Into"]
      )
      assert.strictEqual(first.rows[0]!.value, "/files/draft")
      assert.match(first.rows[1]!.value, /^\/files\/\.subagents\/code-[a-z0-9]{6}$/)
      assert.isFalse(existsSync(join(root, ".subagents")), "nothing is copied before the answer")
      yield* answer(api, first, "deny")
      const second = yield* prompted(events, "parent-2", (p) => p.title.includes("copy"))
      yield* answer(api, second, "allow")
      yield* eventually(() => finished(events, versionId) !== undefined, 120_000)
      const out = parentResults(mock.requests())
      assert.include(out[1], "allow making the copy")
      assert.isEmpty(childOf(mock.requests(), "denied"))
      assert.include(out[2], "Its copy had no changes and was removed.")
      assert.isNotEmpty(childOf(mock.requests(), "allowed"))
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  })

  // Finding 3.
  it.live("making and checking a git copy runs none of the repository's filters or hooks", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      const setupRepo = [
        "mkdir -p proj && cd proj && git init -q",
        "echo one > a.txt && echo two > b.md",
        "printf '*.txt filter=evil\\n*.md filter=glob\\n' > .gitattributes",
        `git config filter.evil.smudge "sh -c 'touch /files/SMUDGED; cat'"`,
        `git config filter.evil.clean "sh -c 'touch /files/CLEANED; cat'"`,
        `git config --global filter.glob.smudge "sh -c 'touch /files/GLOBAL; cat'"`,
        "mkdir -p .git/hooks && printf '#!/bin/sh\\ntouch /files/HOOKED\\n' > .git/hooks/post-checkout && chmod +x .git/hooks/post-checkout",
        `git -c filter.evil.clean=cat add . && ${COMMIT}`,
        "rm -f /files/CLEANED"
      ].join(" && ")
      const flow = scripted(
        [
          { name: "bash", args: { command: setupRepo } },
          { name: "agent", args: { type: "code", task: "[[reader]] Read a.", copy: true } }
        ],
        { reader: [{ name: "read_file", args: { path: "a.txt" } }] }
      )
      const { api, chat, events, mock, me } = yield* filesWorkshop(flow.handler)
      const versionId = yield* runTask(api, chat, events, "copy a repository with filters")
      assert.strictEqual(finished(events, versionId)!.status, "complete")
      const root = join(config.dataDir, "files", me.id)
      assert.include(results(childOf(mock.requests(), "reader").at(-1)!)[0], "one")
      for (const marker of ["SMUDGED", "CLEANED", "GLOBAL", "HOOKED"])
        assert.isFalse(existsSync(join(root, marker)), `${marker}: nothing of the repository's ran`)
      assert.include(parentResults(mock.requests())[1], "Its copy had no changes and was removed.")
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  })

  // Finding 4.
  it.live("a copy whose only change is an ignored file is kept, not removed as unchanged", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      const flow = scripted(
        [
          {
            name: "bash",
            args: {
              command: `mkdir -p proj && cd proj && git init -q && echo one > a.txt && echo dist/ > .gitignore && git add . && ${COMMIT}`
            }
          },
          { name: "agent", args: { type: "code", task: "[[builder]] Build.", copy: true } }
        ],
        { builder: [{ name: "write_file", args: { path: "dist/out.txt", content: "built\n" } }] }
      )
      const { api, chat, events, mock, me } = yield* filesWorkshop(flow.handler)
      const versionId = yield* runTask(api, chat, events, "build in a copy")
      const root = join(config.dataDir, "files", me.id)
      const [row] = rowsOf(yield* api.GetRolloutSteps({ versionId }))
      assert.isTrue(row!.copy!.kept)
      assert.strictEqual(
        yield* Effect.promise(() => readFile(join(hostPath(root, row!.copy!.path), "dist/out.txt"), "utf8")),
        "built\n"
      )
      assert.include(parentResults(mock.requests())[1], "Its copy, with its changes")
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  })

  // Finding 11.
  it.live("a call the reply's subagent count refuses gets no copy", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      const flow = scripted(
        [
          { name: "bash", args: { command: "mkdir -p draft && echo one > draft/a.txt && cd draft" } },
          { name: "agent", args: { type: "research", task: "[[first]] Look." } },
          { name: "agent", args: { type: "code", task: "[[second]] Change.", copy: true } }
        ],
        {}
      )
      const { api, chat, events, mock } = yield* filesWorkshop(flow.handler)
      yield* api.ChangeSubagentSettings({ limits: { perRun: 1 } })
      const registry = yield* ExecutionRegistry
      const real = registry.subagentWorkspaces.get("files")!
      let made = 0
      yield* registry.subagentWorkspaces.register({
        ...real,
        makeCopy: (...args) => {
          made++
          return real.makeCopy(...args)
        }
      })
      yield* runTask(api, chat, events, "one too many")
      assert.include(parentResults(mock.requests())[2], "This reply has started as many subagents as it may.")
      assert.strictEqual(made, 0, "no copy was made for the refused call")
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  })

  // Finding 11.
  it.live("a branch already named like a copy's is never removed, and a re-made copy is held to the quota", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      const flow = scripted(
        [
          {
            name: "bash",
            args: {
              command: `mkdir -p proj && cd proj && git init -q && head -c 200000 /dev/urandom > big.bin && git add . && ${COMMIT} && git branch subagent/code-taken`
            }
          }
        ],
        {}
      )
      const { api, chat, events, me } = yield* filesWorkshop(flow.handler)
      yield* runTask(api, chat, events, "a repository with a branch")
      const root = join(config.dataDir, "files", me.id)
      const places = (yield* ExecutionRegistry).subagentWorkspaces.get("files")!
      const ctx = { userId: me.id, chatId: chat.id } as unknown as ToolContext
      const taken = yield* places.makeCopy(ctx, "code-taken", "/files/proj").pipe(Effect.flip)
      assert.include((taken as Error).message, "already there")
      assert.include(git(join(root, "proj"), "branch", "--format=%(refname:short)"), "subagent/code-taken")

      // A kept git copy, removed by hand, then made again with no room left.
      const { copy } = yield* places.makeCopy(ctx, "code-again", "/files/proj")
      yield* Effect.promise(() => writeFile(join(hostPath(root, copy.path), "new.txt"), "x"))
      assert.isTrue(yield* places.finishCopy(me.id, copy))
      yield* Effect.promise(() => rm(hostPath(root, copy.path), { recursive: true }))
      yield* api.SetFilesQuota({ userId: me.id, quotaBytes: 1 })
      const refused = yield* places.ensureCopy(ctx, copy as SubagentCopyRecord).pipe(Effect.flip)
      assert.include((refused as Error).message, "Your files use")
      assert.isFalse(existsSync(hostPath(root, copy.path)), "not made again past the quota")
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  })
})
