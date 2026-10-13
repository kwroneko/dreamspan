import { assert, it } from "@effect/vitest"
import { NewVersion, type SlotId, type VersionId } from "@rp/shared/chat.ts"
import type { Summary } from "@rp/shared/lcm.ts"
import { Cause, Effect, Exit } from "effect"
import { Reader, Writer } from "../../src/db/Database.ts"
import type { AppendResult } from "../../src/db/ops.ts"
import type { ContextSnapshot } from "../../src/assembler/types.ts"
import { client, posted, serverLayer, testConfig } from "../support/config.ts"
import { completeFixture, fixtureSql } from "../support/lcmFixtures.ts"
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
  "settings"
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
    trace: Array<string> = []
  return Effect.gen(function* () {
    const mock = yield* Effect.acquireRelease(
      Effect.promise(() =>
        startMockProvider((_req, res) =>
          sse(res, completionChunks(["Model reply."], { prompt_tokens: 50, completion_tokens: 3 }))
        )
      ),
      (m) => Effect.promise(() => m.close())
    )
    const api = yield* client(),
      writer = yield* Writer,
      reader = yield* Reader,
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
    const model = yield* api.AddUserModel({ connectionId: connection.id, key: "synthetic-model", overrides: {} })
    yield* api.SetGenerationDefaults({
      defaults: { model: { connection: connection.id, model: model.id }, preset: null }
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
    const nodes = new Map<SlotId, Node>(),
      versions = new Map<VersionId, Version>(),
      artifacts = new Map<Summary["id"], Artifact>()
    const snapshots: Array<string> = []
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
      const text = JSON.stringify(children.length ? lineage.map((s) => [s.summaryId, s.revisionId]) : inputs)
      assert.strictEqual(summary.content, text)
      artifacts.set(summary.id, {
        id: summary.id,
        first: children[0]?.first ?? inputs[0]!.slotId,
        last: children.at(-1)?.last ?? inputs.at(-1)!.slotId,
        level: children.length ? Math.max(...children.map((s) => s.level)) + 1 : 1,
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
          .filter((s) => onPath.has(s.last) && s.last === history[at]!.id)
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
      for (const summary of artifacts.values())
        for (const [id, text] of summary.revisions)
          assert.strictEqual(revisionRows.find((r) => r.id === id)?.content, text)
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
            const start = Math.floor(step.a * history.length),
              end = start + 1 + Math.floor(step.b * (history.length - start))
            const inputs = history.slice(start, end).map((n) => ({
              slotId: n.id,
              versionId: effective(n),
              amendCount: effective(n) === null ? 0 : versions.get(n.selected)!.amends
            }))
            remember(await call(completeFixture(config.dataDir, writer, user.id, chat.id, inputs)), inputs, [])
          }
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
              await call(completeFixture(config.dataDir, writer, user.id, chat.id, [], fixtureChildren)),
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
              data: { key: "lcm.settings", value: { enabled } }
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
    }
    const exit = yield* Effect.tryPromise(run).pipe(Effect.exit)
    return { failure: Exit.isFailure(exit) ? Cause.pretty(exit.cause) : null, trace }
  }).pipe(Effect.provide(serverLayer(config)))
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
