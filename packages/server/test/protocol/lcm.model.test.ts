import type { SummaryJob } from "../../src/db/lcmJobs.ts"
import { assert, it } from "@effect/vitest"
import { NewVersion, type SlotId, type VersionId } from "@rp/shared/chat.ts"
import type { Summary } from "@rp/shared/lcm.ts"
import { Cause, Effect, Exit } from "effect"
import { Reader, Writer } from "../../src/db/Database.ts"
import type { AppendResult } from "../../src/db/ops.ts"
import type { ContextSnapshot } from "../../src/assembler/types.ts"
import { client, posted, testConfig } from "../support/config.ts"
import { completeFixture, fixtureSql } from "../support/lcmFixtures.ts"
import { lastText, lcmServer, PLANTED } from "../support/lcmHarness.ts"
import { docFor } from "../support/docs.ts"
import { completionChunks, sse, startMockProvider } from "../support/mockProvider.ts"

const SEEDS = Number(process.env.LCM_MODEL_SEEDS ?? 4)
const STEPS = Number(process.env.LCM_MODEL_STEPS ?? 150)
const ONLY = process.env.LCM_MODEL_SEED
const kinds = [
  "append",
  "reply",
  "branch",
  "edit",
  "swipe",
  "select",
  "amend",
  "delete",
  "restore",
  "hide",
  "summary",
  "condense",
  "edit-summary",
  "select-summary",
  "settings",
  "enqueue",
  "run-job",
  "refuse-job",
  "release-job",
  "maintain",
  "maintain",
  "summary",
  "summary"
] as const
interface Step {
  readonly kind: (typeof kinds)[number]
  readonly a: number
  readonly b: number
  readonly large: boolean
}
interface Node {
  readonly id: SlotId
  readonly parent: SlotId | null
  readonly depth: number
  readonly versions: Array<VersionId>
  selected: VersionId
  rowVersion: number
  hidden: boolean
  deleted: boolean
  bin: string | null
}
interface Version {
  readonly id: VersionId
  content: string
  readonly writer: "human" | "model"
  amends: number
}
interface Artifact {
  readonly batchId: string | null
  readonly id: Summary["id"]
  readonly first: SlotId
  readonly last: SlotId
  readonly level: number
  readonly inputs: Summary["inputs"]
  readonly children: Summary["children"]
  readonly revisions: Map<Summary["revisionId"], string>
  revision: Summary["revisionId"]
  rowVersion: number
}

/** What the seeds' job steps came to, across the run: a model that never refused would prove nothing. */
const exercised: Record<string, number> = {}
/** Every summary carries this after what it encodes, so a few of them put the layer over its budget. */
const PAD = " ·".repeat(120)
const randomOf = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}
const stepsOf = (seed: number, count: number): Array<Step> => {
  const random = randomOf(seed)
  return Array.from({ length: count }, () => ({
    kind: kinds[Math.floor(random() * kinds.length)]!,
    a: random(),
    b: random(),
    large: random() < 0.1
  }))
}
const pick = <A>(list: ReadonlyArray<A>, at: number): A | undefined => list[Math.floor(at * list.length)]
const runOnce = (steps: ReadonlyArray<Step>) => {
  const config = testConfig(),
    server = lcmServer(config),
    trace: Array<string> = []
  return Effect.gen(function* () {
    // What the summarizer's model answers to the next summarization request: the test sets it
    // from its own model of the graph. The judge is a fake that refuses what the test planted.
    let script: "hard" | "soft" | { readonly text: string } = { text: "" }
    const mock = yield* Effect.acquireRelease(
      Effect.promise(() =>
        startMockProvider((req, res) => {
          if (req.body?.model === "judge-model")
            return sse(
              res,
              completionChunks([lastText(req).includes(PLANTED) ? "REFUSED" : "OK"], {
                prompt_tokens: 50,
                completion_tokens: 3
              })
            )
          const messages = (req.body?.messages ?? []) as Array<{ content: string }>
          if (!messages.at(-1)?.content?.includes("Return only the summary"))
            return sse(res, completionChunks(["Model reply."], { prompt_tokens: 50, completion_tokens: 3 }))
          if (script === "hard")
            return sse(res, [
              {
                id: "r",
                object: "chat.completion.chunk",
                model: "m",
                choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: "content_filter" }]
              }
            ])
          sse(
            res,
            completionChunks([script === "soft" ? `${PLANTED} I cannot.` : script.text], {
              prompt_tokens: 50,
              completion_tokens: 3
            })
          )
        })
      ),
      (m) => Effect.promise(() => m.close())
    )
    const api = yield* client(),
      writer = yield* Writer,
      reader = yield* Reader,
      summarizer = server.summarizer(),
      user = yield* api.Whoami()
    const connection = yield* api.CreateConnection({
      kind: "openai-chat",
      settings: {
        name: "Synthetic",
        baseUrl: `${mock.url}/v1`,
        compat: {},
        cacheTtlS: 300,
        maxConcurrent: null,
        presetOverrideRefId: null
      }
    })
    const model = yield* api.AddUserModel({
      connectionId: connection.id,
      key: "synthetic-model",
      overrides: { context: 2048 }
    })
    const judgeModel = yield* api.AddUserModel({ connectionId: connection.id, key: "judge-model", overrides: {} })
    const fallbackModel = yield* api.AddUserModel({ connectionId: connection.id, key: "fallback-model", overrides: {} })
    yield* api.SetGenerationDefaults({
      defaults: {
        model: { connection: connection.id, model: model.id },
        judge: { connection: connection.id, model: judgeModel.id },
        lcm: { fallback: { connection: connection.id, model: fallbackModel.id } },
        preset: null
      }
    })
    const card = yield* writer.CreateEntity({
      userId: user.id,
      kind: "card",
      label: "Oracle",
      subtitle: "",
      doc: docFor("card", "Oracle"),
      schemaVersion: 1,
      origin: "user",
      sourcePath: null
    })
    const chat = yield* writer.CreateChat({
      userId: user.id,
      kind: "rp",
      status: "active",
      title: "LCM model",
      participants: [card.entityId],
      greeting: null
    })
    const call = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect)
    // A fanout of two and a small condensation target make every condensation path reachable in a short run.
    const knobs = { fanout: 2, condenseTarget: 100 }
    yield* writer.AddStateEvent({
      userId: user.id,
      chatId: chat.id,
      slotId: null,
      versionId: null,
      scope: null,
      data: { key: "lcm.settings", value: { enabled: true, ...knobs } }
    })
    const nodes = new Map<SlotId, Node>(),
      versions = new Map<VersionId, Version>(),
      artifacts = new Map<Summary["id"], Artifact>()
    const jobs = new Map<string, SummaryJob>()
    // Absorbed summaries, the origin of each revision, and the failed rows whose inputs may still stand.
    const superseded = new Set<string>(),
      origins = new Map<string, string>(),
      failedRows: Array<Artifact> = []
    const snapshots: Array<string> = []
    const counts: Record<string, number> = {}
    let leaf: SlotId | null = null,
      enabled = true
    const path = (tip: SlotId | null) => {
      const result: Array<Node> = []
      while (tip !== null) {
        const node = nodes.get(tip)!
        result.unshift(node)
        tip = node.parent
      }
      return result
    }
    const effective = (node: Node) =>
      node.deleted || node.hidden || !versions.get(node.selected)!.content ? null : node.selected
    const fresh = (summary: Artifact): boolean =>
      summary.inputs.every((i) => {
        const node = nodes.get(i.slotId)!,
          version = versions.get(node.selected)!
        return effective(node) === i.versionId && (i.versionId === null || i.amendCount === version.amends)
      }) &&
      summary.children.every((p) => {
        const child = artifacts.get(p.summaryId)!
        return fresh(child) && child.revision === p.revisionId
      })
    const chain = (summary: Artifact) => {
      const full = path(summary.last)
      return full.slice(full.findIndex((n) => n.id === summary.first))
    }
    const accept = (entry: Pick<AppendResult, "slotId" | "version">, parent: SlotId | null) => {
      versions.set(entry.version.id, {
        id: entry.version.id,
        content: entry.version.content,
        writer: entry.version.writer,
        amends: 0
      })
      nodes.set(entry.slotId, {
        id: entry.slotId,
        parent,
        depth: parent === null ? 0 : nodes.get(parent)!.depth + 1,
        selected: entry.version.id,
        versions: [entry.version.id],
        rowVersion: 1,
        hidden: false,
        deleted: false,
        bin: null
      })
      leaf = entry.slotId
    }
    const newVersion = (content: string) =>
      new NewVersion({
        speakerEntityId: null,
        writer: "human",
        content,
        status: "complete",
        macroMode: "verbatim",
        origin: "user_written"
      })
    const append = async (parent: SlotId | null, content: string, branch: boolean) => {
      const result = await call(
        writer.AppendMessage({
          userId: user.id,
          chatId: chat.id,
          parentSlotId: parent,
          branch,
          version: newVersion(content),
          commitDraft: null
        })
      )
      accept(result, parent)
    }
    const remember = (summary: Summary, inputs: Summary["inputs"], children: ReadonlyArray<Artifact>) => {
      const lineage = children.map((s) => ({ summaryId: s.id, revisionId: s.revision }))
      const text = JSON.stringify(children.length ? lineage.map((s) => [s.summaryId, s.revisionId]) : inputs) + PAD
      assert.strictEqual(summary.content, text)
      origins.set(summary.revisionId, summary.origin)
      artifacts.set(summary.id, {
        batchId: summary.batchId,
        id: summary.id,
        first: children[0]?.first ?? inputs[0]!.slotId,
        last: children.at(-1)?.last ?? inputs.at(-1)!.slotId,
        level: summary.level,
        inputs,
        children: lineage,
        revisions: new Map([[summary.revisionId, text]]),
        revision: summary.revisionId,
        rowVersion: 1
      })
    }
    const expectedLayer = (history: ReadonlyArray<Node>) => {
      const onPath = new Set(history.map((n) => n.id)),
        selected: Array<Artifact> = []
      let at = history.length - 1
      while (at >= 0) {
        const options = [...artifacts.values()]
          .filter(
            (s) =>
              !superseded.has(s.id) &&
              onPath.has(s.last) &&
              s.last === history[at]!.id &&
              ![...jobs.values()].some(
                (j) => j.batchId === s.batchId && s.batchId !== null && ["pending", "processing"].includes(j.status)
              )
          )
          .sort((a, b) => Number(fresh(b)) - Number(fresh(a)) || b.level - a.level || b.id.localeCompare(a.id))
        const chosen = options[0]
        if (chosen) {
          selected.unshift(chosen)
          at = nodes.get(chosen.first)!.depth - 1
        } else {
          if (selected.length) selected.splice(0)
          at--
        }
      }
      return enabled ? selected : []
    }
    const checkContext = async (target: Node) => {
      const { snapshot: json } = await call(
        reader.AssembleContext({
          userId: user.id,
          chatId: chat.id,
          slotId: target.id,
          versionId: target.selected,
          now: 123456,
          timeZone: "UTC",
          frozen: null
        })
      )
      const snapshot = JSON.parse(json) as ContextSnapshot,
        history = path(target.parent)
      const selected = snapshot.lcm?.selected ?? []
      const expected = expectedLayer(history)
      assert.deepStrictEqual(
        selected.map((s) => s.id),
        expected.map((s) => s.id),
        "I1/I3: selection against graph oracle"
      )
      for (const pin of selected) {
        const artifact = artifacts.get(pin.id as Summary["id"])!
        assert.strictEqual(pin.stale, !fresh(artifact), "I3: freshness")
        const visit = (s: Artifact) => {
          const range = chain(s)
          assert.strictEqual(range[0]!.id, s.first)
          assert.strictEqual(range.at(-1)!.id, s.last)
          for (const node of range)
            assert.isTrue(
              history.some((p) => p.id === node.id),
              "I1: summary is on path"
            )
          for (let i = 1; i < range.length; i++) assert.strictEqual(range[i]!.parent, range[i - 1]!.id)
          for (const child of s.children) visit(artifacts.get(child.summaryId)!)
        }
        visit(artifact)
        const piece = snapshot.pieces.find((p) => p.source.kind === "summary" && p.source.id === pin.id)!
        assert.isNotEmpty(piece.messages, "I2: selected summary is rendered")
        assert.isTrue(
          piece.messages.every((i) => snapshot.request.messages[i]!.content.includes(piece.text)),
          "I2: attributed summary text actually appears"
        )
        assert.strictEqual(
          piece.text,
          artifact.revisions.get(pin.revision as Summary["revisionId"]),
          "I4: revision text"
        )
      }
      if (snapshot.lcm)
        for (const node of history) {
          const depth = node.depth + 1
          const covering = selected.filter((s) => depth >= s.from && depth <= s.to).length
          const verbatim =
            snapshot.lcm.verbatim && depth >= snapshot.lcm.verbatim.from && depth <= snapshot.lcm.verbatim.to ? 1 : 0
          const omitted = snapshot.lcm.omitted.filter((r) => depth >= r.from && depth <= r.to).length
          assert.strictEqual(covering + verbatim + omitted, 1, "I2: exact partition")
          if (covering || omitted)
            assert.isFalse(
              snapshot.pieces.some(
                (p) => p.source.kind === "message" && p.source.slot === node.id && p.messages.length > 0
              ),
              "I2: covered or omitted originals are not rendered"
            )
          if (verbatim && effective(node) !== null)
            assert.isTrue(
              snapshot.pieces.some(
                (p) => p.source.kind === "message" && p.source.slot === node.id && p.messages.length > 0
              ),
              "I2: retained originals are rendered"
            )
        }
      const summaryMessages = snapshot.pieces.filter((p) => p.source.kind === "summary").flatMap((p) => p.messages)
      const rawMessages = snapshot.pieces.filter((p) => p.source.kind === "message").flatMap((p) => p.messages)
      if (summaryMessages.length && rawMessages.length)
        assert.isBelow(Math.max(...summaryMessages), Math.min(...rawMessages), "I2: layer precedes raw history")
      snapshots.push(json)
      return snapshot
    }
    let immutable = new Map<string, string>()
    const checkRetention = async () => {
      const tables = ["summaries", "summary_revisions", "summary_inputs", "summary_parents"]
      const results = await call(
        fixtureSql(
          config.dataDir,
          tables.map((table) => ({ sql: `SELECT * FROM ${table}` }))
        )
      )
      const current = new Map<string, string>()
      for (const [index, rows] of results.entries())
        for (const row of rows) {
          const { selected_revision_id: _selection, row_version: _rowVersion, status: _status, ...fixed } = row
          const key = `${tables[index]}:${row.id ?? `${row.summary_id}:${row.ordinal}`}`
          current.set(key, JSON.stringify(fixed))
        }
      for (const [key, value] of immutable) assert.strictEqual(current.get(key), value, "I4: immutable retained rows")
      immutable = current
      for (const summary of artifacts.values()) {
        const inputRows = results[2]!
          .filter((r) => r.summary_id === summary.id)
          .sort((a, b) => Number(a.ordinal) - Number(b.ordinal))
        assert.deepStrictEqual(
          inputRows.map((r) => ({ slotId: r.slot_id, versionId: r.version_id, amendCount: r.amend_count })),
          [...summary.inputs],
          "I4: recorded inputs equal fixture rendering"
        )
        const parents = results[3]!
          .filter((r) => r.summary_id === summary.id)
          .sort((a, b) => Number(a.ordinal) - Number(b.ordinal))
        assert.deepStrictEqual(
          parents.map((r) => ({ summaryId: r.parent_id, revisionId: r.parent_revision_id })),
          [...summary.children],
          "I4: pinned child revisions"
        )
      }
      const revisionRows = results[1]!
      for (const row of revisionRows)
        if (row.origin === "generated")
          assert.isFalse(String(row.content).includes(PLANTED), "I5: no generated revision holds a refusal")
      for (const summary of artifacts.values())
        for (const [id, text] of summary.revisions)
          assert.strictEqual(revisionRows.find((r) => r.id === id)?.content, text)
    }
    type Mode = "ok" | "hard" | "soft"
    const jobRow = async (id: string) =>
      (
        await call(
          fixtureSql(config.dataDir, [
            {
              sql: "SELECT status,attempts,result_summary_id,input_child_ids,absorbed_parent_id FROM summarization_jobs WHERE id=?",
              params: [id]
            }
          ])
        )
      )[0]![0]!
    /** Runs a claimed job through the real summarizer and folds its outcome into the oracle. */
    const runClaimed = async (job: SummaryJob, mode: Mode) => {
      jobs.set(job.id, job)
      const declared = await jobRow(job.id)
      const childIds = declared.input_child_ids ? (JSON.parse(declared.input_child_ids as string) as string[]) : []
      const kids = childIds.map((id) => artifacts.get(id as never)!)
      assert.isTrue(
        kids.every((k) => k !== undefined),
        "a condensation's parts are summaries the oracle knows"
      )
      const chain = path(job.lastSlotId).slice(nodes.get(job.firstSlotId)!.depth)
      const expected = chain.map((n) => ({
        slotId: n.id,
        versionId: effective(n),
        amendCount: effective(n) === null ? 0 : versions.get(n.selected)!.amends
      }))
      const assembly = await call(
        Effect.exit(reader.AssembleSummary({ userId: user.id, jobId: job.id, attempt: job.epoch }))
      )
      if (!Exit.isFailure(assembly)) {
        const snapshot = JSON.parse(assembly.value.snapshot) as ContextSnapshot
        if (job.level === 1) assert.deepStrictEqual(snapshot.summaryJob!.inputs, expected, "I7: exact request versions")
        else
          assert.deepStrictEqual(
            snapshot.summaryJob!.children,
            kids.map((k) => ({ summaryId: k.id, revisionId: k.revision })),
            "I7: a condensation sends exactly its parts at their selected revisions"
          )
        snapshots.push(assembly.value.snapshot)
      }
      script =
        mode !== "ok"
          ? mode
          : { text: JSON.stringify(job.level > 1 ? kids.map((k) => [k.id, k.revision]) : expected) + PAD }
      await call(summarizer.runJob(job))
      const row = await jobRow(job.id)
      jobs.set(job.id, { ...job, status: row.status as SummaryJob["status"], attempts: Number(row.attempts) })
      const tally = `${mode === "ok" ? "run" : "refuse"}-job:${row.status}:L${job.level > 1 ? "n" : 1}`
      counts[tally] = (counts[tally] ?? 0) + 1
      if (row.status === "complete") {
        assert.strictEqual(mode, "ok", "I5: a refusal is never saved as a summary")
        remember(
          await call(reader.GetSummary({ userId: user.id, summaryId: row.result_summary_id as never })),
          job.level > 1 ? [] : expected,
          kids
        )
        if (job.level > 1)
          counts[declared.absorbed_parent_id ? "absorbed" : "condensed"] =
            (counts[declared.absorbed_parent_id ? "absorbed" : "condensed"] ?? 0) + 1
        if (declared.absorbed_parent_id) {
          const parent = artifacts.get(declared.absorbed_parent_id as never)!
          const originals = new Set(parent.children.map((c) => c.summaryId as string))
          superseded.add(parent.id)
          for (const kid of kids) if (!originals.has(kid.id)) superseded.add(kid.id)
        }
      }
      if (row.status === "failed" && row.result_summary_id) {
        const failed = await call(reader.GetSummary({ userId: user.id, summaryId: row.result_summary_id as never }))
        assert.strictEqual(failed.status, "failed")
        assert.strictEqual(failed.content, "")
        assert.isFalse(artifacts.has(failed.id), "I5: a failed summary is not one the oracle may select")
        failedRows.push({
          batchId: failed.batchId,
          id: failed.id,
          first: failed.firstSlotId,
          last: failed.lastSlotId,
          level: failed.level,
          inputs: failed.inputs,
          children: failed.children,
          revisions: new Map([[failed.revisionId, ""]]),
          revision: failed.revisionId,
          rowVersion: failed.rowVersion
        })
      }
      const [saved] = await call(
        fixtureSql(config.dataDir, [
          { sql: "SELECT count(*) AS n FROM summaries WHERE status IN ('complete','truncated','superseded')" }
        ])
      )
      assert.strictEqual(Number(saved![0]!.n), artifacts.size, "I5: only accepted outputs became summaries")
      return row.status as string
    }
    const claimAndRun = async (mode: Mode, limit = 60) => {
      let ran = 0
      for (let n = 0; n < limit; n++) {
        const job = await call(writer.ClaimSummaryJob({ userId: user.id }))
        if (!job) break
        await runClaimed(job, mode)
        ran++
      }
      return ran
    }
    // Why a stale summary may still be in a context after the planner is quiet: the user wrote it, or
    // it sits over one they wrote, or nothing in its range has content, or its rewrite failed and the
    // failure still stands (spec/LCM.md §2.2, §2.8).
    const handWritten = (a: Artifact) => origins.get(a.revision) !== "generated"
    const heldByFailure = (a: Artifact) =>
      failedRows.some((f) => f.level === a.level && f.first === a.first && f.last === a.last && fresh(f))
    const hasFreshBelow = (c: Artifact, below: number) =>
      [...artifacts.values()].some(
        (o) => o.first === c.first && o.last === c.last && o.level < below && !superseded.has(o.id) && fresh(o)
      )
    const explain = (a: Artifact, depth = 0): string =>
      JSON.stringify({
        id: a.id.slice(-6),
        level: a.level,
        first: nodes.get(a.first)!.depth,
        last: nodes.get(a.last)!.depth,
        fresh: fresh(a),
        hand: handWritten(a),
        held: heldByFailure(a),
        content: a.level === 1 ? chain(a).map((n) => effective(n) !== null) : undefined,
        children: depth < 3 ? a.children.map((c) => explain(artifacts.get(c.summaryId)!, depth + 1)) : undefined,
        replaced: [...artifacts.values()]
          .filter((o) => o.id !== a.id && o.first === a.first && o.last === a.last)
          .map((o) => [o.level, fresh(o), superseded.has(o.id)])
      })
    const excused = (a: Artifact): boolean => {
      if (handWritten(a) || heldByFailure(a)) return true
      if (a.level === 1) return !chain(a).some((n) => effective(n) !== null)
      return a.children.some((p) => {
        const part = artifacts.get(p.summaryId)!
        return !hasFreshBelow(part, a.level) && excused(part)
      })
    }
    /**
     * What a reply on the path ending at `target.parent` sets going: planning as a reply, then every
     * job run, then planning as each finished job would, until nothing is left. Checks that only
     * stale summaries are written again, each once, and only by the reply's own pass.
     */
    const cascade = async (target: Node | undefined) => {
      if (!enabled || !target || target.deleted || target.parent === null) return false
      const position = { userId: user.id, chatId: chat.id, leafSlotId: target.parent }
      const before = [...artifacts.values()].map((a) => ({ a, fresh: fresh(a) }))
      const seen = new Set<string>()
      let reason: "reply" | "completion" = "reply"
      for (let pass = 0; pass < 40; pass++) {
        const made = await call(summarizer.planNow(position, reason))
        for (const job of made) {
          jobs.set(job.id, job)
          const same = before.filter(
            (b) =>
              !superseded.has(b.a.id) &&
              b.a.level === job.level &&
              b.a.first === job.firstSlotId &&
              b.a.last === job.lastSlotId
          )
          if (!same.length) continue
          const key = `${job.level}:${job.firstSlotId}:${job.lastSlotId}`
          counts[`rewritten:L${job.level > 1 ? "n" : 1}`] = (counts[`rewritten:L${job.level > 1 ? "n" : 1}`] ?? 0) + 1
          assert.isTrue(
            same.every((b) => !b.fresh),
            "only a stale summary is written again"
          )
          assert.isFalse(seen.has(key), "at most one re-summarization per affected summary per reply")
          seen.add(key)
          if (job.level === 1) assert.strictEqual(reason, "reply", "a finished job does not start a re-summarization")
        }
        const ran = await claimAndRun("ok")
        if (!made.length && !ran) return true
        reason = "completion"
      }
      return assert.fail("planning did not reach quiescence")
    }
    const assertQuiet = async (target: Node) => {
      const snapshot = await checkContext(target)
      for (const pin of snapshot.lcm?.selected ?? [])
        if (pin.stale)
          assert.isTrue(
            excused(artifacts.get(pin.id as never)!),
            `quiescence: a stale summary in a context is excused ${explain(artifacts.get(pin.id as never)!)}`
          )
      assert.isTrue(
        [...jobs.values()].every((j) => !["pending", "processing"].includes(j.status)),
        "quiescence: no live job"
      )
    }
    const run = async () => {
      await append(null, "root", false)
      await append(leaf, "middle", false)
      await append(leaf, "leaf", false)
      for (const [index, step] of steps.entries()) {
        trace.push(`${index}: ${JSON.stringify(step)}`)
        const live = [...nodes.values()].filter((n) => !n.deleted)
        const node = pick(live, step.a)
        if (step.kind === "append" || step.kind === "branch") {
          if (step.kind === "branch" && node) await append(node.id, `branch-${index}`, true)
          else await append(leaf, step.large ? `large-${index} `.repeat(1600) : `message-${index}`, false)
        } else if (step.kind === "reply" && leaf && !nodes.get(leaf)!.deleted) {
          const parent = leaf
          const result = await call(posted(api.Generate({ chatId: chat.id, parentSlotId: parent, branch: false })))
          let version = result.entry.version
          for (let attempts = 0; version.status === "generating" && attempts < 1000; attempts++) {
            await new Promise((r) => setTimeout(r, 5))
            version = (await call(api.ListVersions({ slotId: result.entry.slotId }))).find((v) => v.id === version.id)!
          }
          assert.strictEqual(version.status, "complete")
          accept({ slotId: result.entry.slotId, version }, parent)
        } else if ((step.kind === "edit" || step.kind === "swipe") && node) {
          const version = await call(
            writer.AddVersion({
              userId: user.id,
              slotId: node.id,
              version: newVersion(`${step.kind}-${index}`),
              select: true,
              commitDraft: null
            })
          )
          node.versions.push(version.id)
          node.selected = version.id
          node.rowVersion++
          versions.set(version.id, { id: version.id, content: version.content, writer: version.writer, amends: 0 })
        } else if (step.kind === "select" && node) {
          const selected = pick(node.versions, step.b)!
          const result = await call(
            writer.SelectVersion({
              userId: user.id,
              slotId: node.id,
              versionId: selected,
              expectedRowVersion: node.rowVersion
            })
          )
          node.selected = selected
          node.rowVersion = result.rowVersion
        } else if (step.kind === "amend" && node && versions.get(node.selected)!.writer === "human") {
          const version = versions.get(node.selected)!
          await call(
            api.AmendVersion({
              versionId: version.id,
              content: `amend-${index}`,
              expectedRowVersion: version.amends + 1
            })
          )
          version.amends++
          version.content = `amend-${index}`
        } else if (step.kind === "delete" && node && node.id !== leaf) {
          const bin = await call(writer.DeleteMessage({ userId: user.id, slotId: node.id }))
          node.deleted = true
          node.bin = bin.id
        } else if (step.kind === "restore") {
          const deleted = pick(
            [...nodes.values()].filter((n) => n.deleted),
            step.a
          )
          if (deleted) {
            await call(writer.RestoreBinItem({ userId: user.id, itemId: deleted.bin! }))
            deleted.deleted = false
            deleted.bin = null
          }
        } else if (step.kind === "hide" && node) {
          node.hidden = !node.hidden
          await call(
            fixtureSql(config.dataDir, [
              {
                sql: "UPDATE slots SET context_excluded=?,row_version=row_version+1 WHERE id=?",
                params: [Number(node.hidden), node.id]
              }
            ])
          )
          node.rowVersion++
        } else if (step.kind === "summary" && leaf) {
          const history = path(nodes.get(leaf)!.parent)
          if (history.length) {
            // Mostly pairs on a grid, which tile and so can be condensed; sometimes any range at all.
            const any = Math.floor(step.a * history.length)
            const start = step.b < 0.7 ? any - (any % 2) : any,
              end = step.b < 0.7 ? start + 2 : start + 1 + Math.floor(step.b * (history.length - start))
            const inputs = history.slice(start, end).map((n) => ({
              slotId: n.id,
              versionId: effective(n),
              amendCount: effective(n) === null ? 0 : versions.get(n.selected)!.amends
            }))
            if (
              ![...jobs.values()].some(
                (j) =>
                  ["pending", "processing"].includes(j.status) &&
                  j.firstSlotId === inputs[0]!.slotId &&
                  j.lastSlotId === inputs.at(-1)!.slotId
              )
            )
              remember(
                await call(completeFixture(config.dataDir, writer, user.id, chat.id, inputs, [], PAD)),
                inputs,
                []
              )
          }
        } else if (step.kind === "enqueue" && leaf && enabled) {
          const history = path(leaf)
          if (history.length > 2 && ![...jobs.values()].some((j) => ["pending", "processing"].includes(j.status))) {
            const split = Math.max(1, Math.floor(history.length / 3))
            const chunks = [history.slice(0, split), history.slice(split, split * 2)].map((chunk) => ({
              target: 600,
              inputs: chunk.map((n) => ({
                slotId: n.id,
                versionId: effective(n),
                amendCount: effective(n) === null ? 0 : versions.get(n.selected)!.amends
              }))
            }))
            const added = await call(
              writer.EnqueueSummaries({
                userId: user.id,
                chatId: chat.id,
                leafSlotId: leaf,
                chunks,
                requestClass: "idle"
              })
            )
            for (const job of added) jobs.set(job.id, job)
            assert.lengthOf(
              await call(
                writer.EnqueueSummaries({
                  userId: user.id,
                  chatId: chat.id,
                  leafSlotId: leaf,
                  chunks,
                  requestClass: "idle"
                })
              ),
              0,
              "I7: only one live job per chain"
            )
          }
        } else if (["run-job", "refuse-job", "release-job"].includes(step.kind)) {
          // A clean job to run: a short chain of live, visible messages on the active path, unless
          // one is queued already. Refusal steps then run it until its retries and its fallback are spent.
          if (step.kind !== "release-job" && leaf && enabled && !nodes.get(leaf)!.deleted) {
            const history = path(leaf)
            const clean = (n: Node) => !n.deleted && !n.hidden && versions.get(n.selected)!.content !== ""
            const start = Math.floor(step.b * history.length)
            const chain = history.slice(start, start + 1 + (index % 3)).filter(clean)
            const queued = [...jobs.values()].some((j) => ["pending", "processing"].includes(j.status))
            if (!queued && chain.length && history.slice(start, start + chain.length).every(clean)) {
              const added = await call(
                writer.EnqueueSummaries({
                  userId: user.id,
                  chatId: chat.id,
                  leafSlotId: leaf,
                  requestClass: "idle",
                  chunks: [
                    {
                      target: 600,
                      inputs: chain.map((n) => ({
                        slotId: n.id,
                        versionId: effective(n),
                        amendCount: effective(n) === null ? 0 : versions.get(n.selected)!.amends
                      }))
                    }
                  ]
                })
              )
              for (const job of added) jobs.set(job.id, job)
            }
          }
          for (let attempt = 0; attempt < 6; attempt++) {
            const job = await call(writer.ClaimSummaryJob({ userId: user.id }))
            if (!job) break
            jobs.set(job.id, job)
            if (job.level === 1) {
              // One level-1 job at a time per chat: another claim finds only condensations.
              const another = await call(writer.ClaimSummaryJob({ userId: user.id }))
              if (another) {
                assert.isAbove(another.level, 1, "I7: one L1 per chat")
                await call(writer.ReleaseSummaryJob({ userId: user.id, jobId: another.id, attempt: another.epoch }))
                jobs.set(another.id, { ...another, status: "pending", attempts: another.attempts - 1 })
              }
              const earlier = [...jobs.values()].filter(
                (j) =>
                  j.level === 1 &&
                  j.status === "pending" &&
                  nodes.get(j.firstSlotId)!.depth < nodes.get(job.firstSlotId)!.depth
              )
              assert.lengthOf(earlier, 0, "I7: oldest path segment first")
            }
            if (step.kind === "release-job") {
              await call(writer.ReleaseSummaryJob({ userId: user.id, jobId: job.id, attempt: job.epoch }))
              jobs.set(job.id, { ...job, status: "pending", attempts: job.attempts - 1 })
              break
            }
            const status = await runClaimed(job, step.kind === "refuse-job" ? (step.b < 0.5 ? "hard" : "soft") : "ok")
            if (status !== "pending") break
          }
        } else if (step.kind === "maintain") {
          const target = leaf ? nodes.get(leaf) : undefined
          if (await cascade(target)) await assertQuiet(target!)
        } else if (step.kind === "condense") {
          const pairs: Array<ReadonlyArray<Artifact>> = []
          for (const a of artifacts.values())
            for (const b of artifacts.values()) if (nodes.get(b.first)!.parent === a.last) pairs.push([a, b])
          const children = pick(pairs, step.a)
          if (children) {
            const fixtureChildren = children.map(
              (s) =>
                ({
                  id: s.id,
                  revisionId: s.revision,
                  firstSlotId: s.first,
                  lastSlotId: s.last,
                  level: s.level
                }) as Summary
            )
            remember(
              await call(completeFixture(config.dataDir, writer, user.id, chat.id, [], fixtureChildren, PAD)),
              [],
              children
            )
          }
        } else if ((step.kind === "edit-summary" || step.kind === "select-summary") && artifacts.size) {
          const summary = pick([...artifacts.values()], step.a)!
          if (step.kind === "edit-summary") {
            const text = `edited-summary-${index} {{incvar::literal}}`
            const result = await call(
              api.EditSummary({
                summaryId: summary.id,
                content: text,
                expectedRowVersion: summary.rowVersion,
                commitDraft: null
              })
            )
            summary.revision = result.summary.revisionId
            summary.rowVersion = result.summary.rowVersion
            summary.revisions.set(summary.revision, text)
            origins.set(summary.revision, "user")
          } else {
            const revision = pick([...summary.revisions.keys()], step.b)!
            const result = await call(
              api.SelectSummaryRevision({
                summaryId: summary.id,
                revisionId: revision,
                expectedRowVersion: summary.rowVersion
              })
            )
            summary.revision = revision
            summary.rowVersion = result.rowVersion
          }
        } else if (step.kind === "settings") {
          enabled = !enabled
          await call(
            writer.AddStateEvent({
              userId: user.id,
              chatId: chat.id,
              slotId: null,
              versionId: null,
              scope: null,
              data: { key: "lcm.settings", value: { enabled, ...knobs } }
            })
          )
        }
        if (leaf && !nodes.get(leaf)!.deleted) await checkContext(nodes.get(leaf)!)
        const other = pick(
          [...nodes.values()].filter((n) => !n.deleted),
          step.b
        )
        if (other) await checkContext(other)
        await checkRetention()
        const old = pick(snapshots, step.a)
        if (old) {
          const rebuilt = await call(reader.RebuildContext({ userId: user.id, snapshot: old }))
          assert.ok(rebuilt._tag === "Rebuilt")
          assert.deepStrictEqual(
            JSON.parse(rebuilt.snapshot),
            JSON.parse(old),
            "I6: frozen rebuild after graph/summary changes"
          )
        }
      }
      // Run to quiescence (spec/LCM.md §4): whatever the steps left, a reply's pass and its cascade
      // settle, and then no context on those paths holds a stale summary the planner could have replaced.
      if (!enabled) {
        enabled = true
        await call(
          writer.AddStateEvent({
            userId: user.id,
            chatId: chat.id,
            slotId: null,
            versionId: null,
            scope: null,
            data: { key: "lcm.settings", value: { enabled, ...knobs } }
          })
        )
      }
      const live = [...nodes.values()].filter((n) => !n.deleted && n.parent !== null && !nodes.get(n.parent)!.deleted)
      const targets = [leaf ? nodes.get(leaf) : undefined, pick(live, 0.25), pick(live, 0.6), pick(live, 0.9)]
      for (const target of targets)
        if (target && (await cascade(target))) {
          await assertQuiet(target)
          counts["quiescent"] = (counts["quiescent"] ?? 0) + 1
        }
    }
    const exit = yield* Effect.tryPromise(run).pipe(Effect.exit)
    for (const [key, n] of Object.entries(counts)) exercised[key] = (exercised[key] ?? 0) + n
    return { failure: Exit.isFailure(exit) ? Cause.pretty(exit.cause) : null, trace }
  }).pipe(Effect.provide(server.layer))
}

const shrink = (steps: ReadonlyArray<Step>) =>
  Effect.gen(function* () {
    let smallest = [...steps],
      result = yield* runOnce(smallest)
    for (let size = Math.floor(smallest.length / 2); size >= 1; size = Math.floor(size / 2)) {
      for (let at = 0; at < smallest.length;) {
        const candidate = [...smallest.slice(0, at), ...smallest.slice(at + size)]
        const tested = yield* runOnce(candidate)
        if (tested.failure !== null) {
          smallest = candidate
          result = tested
        } else at += size
      }
    }
    return result
  })
for (const seed of ONLY === undefined ? Array.from({ length: SEEDS }, (_, i) => i + 1) : [Number(ONLY)])
  it.live(
    `LCM graph invariants 1–4 and 6, seed ${seed}`,
    () =>
      Effect.gen(function* () {
        const steps = stepsOf(seed, STEPS),
          result = yield* runOnce(steps)
        if (result.failure === null) return
        const report = process.env.LCM_MODEL_SHRINK === "0" ? result : yield* shrink(steps)
        assert.fail(`seed ${seed}: ${report.failure}\n${report.trace.join("\n")}`)
      }),
    { timeout: 600_000 }
  )

if (ONLY === undefined && STEPS >= 100)
  it("the seeds ran jobs to completion, to retry, and to failure under planted refusals", () => {
    for (const key of [
      "run-job:complete:L1",
      "refuse-job:pending:L1",
      "refuse-job:failed:L1",
      "condensed",
      "quiescent",
      "rewritten:L1",
      "absorbed"
    ])
      assert.isAbove(exercised[key] ?? 0, 0, key + JSON.stringify(exercised))
  })
