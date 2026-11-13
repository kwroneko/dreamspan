// The summarization settings (DESIGN §8): resolution from the chat to the account default to the
// built-in, new chats copying the default, field-by-field changes, the two pairs driving the
// planner and assembly, the fit check, "when it runs", and requests without the preset.
import { assert, it } from "@effect/vitest"
import { BUILTIN_SUMMARY_INSTRUCTION } from "@rp/shared/lcmSettings.ts"
import { Effect } from "effect"
import type { ContextSnapshot } from "../src/assembler/types.ts"
import { estimateBackfill } from "../src/lcm/backfill.ts"
import { fixtureSql } from "./support/lcmFixtures.ts"
import { lcmHarness, lcmTest, requestsTo } from "./support/lcmHarness.ts"

/** About 103 tokens as the planner costs messages (characters / 4, plus 3). */
const message = (n: number) => `Line ${String(n).padStart(3, "0")}. ` + "Rain on the harbor roofs. ".repeat(15)

lcmTest("a new chat copies the account default, its fields fall back to it, and null follows it again", (server) =>
  Effect.gen(function* () {
    const h = yield* lcmHarness(server, { messages: 0 })
    yield* h.api.ChangeGenerationDefaults({
      change: { lcm: { recentTarget: 10_000, recentMax: 20_000, withPreset: false } }
    })
    const made = () =>
      h.writer.CreateChat({
        userId: h.userId,
        kind: "rp",
        status: "active",
        title: "New",
        participants: [],
        greeting: null
      })
    const chat = yield* made()
    const read = (chatId: typeof chat.id) => h.api.GetLcmSettings({ chatId, leafSlotId: null })
    const copied = yield* read(chat.id)
    assert.deepStrictEqual(copied.stored, {
      enabled: true,
      withPreset: "raw",
      withNotes: false,
      recentTarget: 10_000,
      recentMax: 20_000,
      layerTarget: 14_000,
      layerMax: 18_000,
      when: "after-reply",
      style: "direct",
      leafTarget: 600
    })
    assert.strictEqual(copied.resolved.from.recentMax, "chat")
    // A later change of the default leaves the chat as it was made (Q2).
    yield* h.api.ChangeGenerationDefaults({ change: { lcm: { recentMax: 30_000 } } })
    assert.strictEqual((yield* read(chat.id)).resolved.recentMax, 20_000)
    // A chat from before the settings stores only its switch and follows the default.
    const legacy = yield* made()
    yield* h.writer.AddStateEvent({
      userId: h.userId,
      chatId: legacy.id,
      slotId: null,
      versionId: null,
      scope: null,
      data: { key: "lcm.settings", value: { enabled: true } }
    })
    const follows = yield* read(legacy.id)
    assert.strictEqual(follows.resolved.recentMax, 30_000)
    assert.strictEqual(follows.resolved.from.recentMax, "account")
    assert.strictEqual(follows.resolved.layerMax, 18_000)
    assert.strictEqual(follows.resolved.from.layerMax, "builtin")
    // One field at a time, the others kept; null makes it follow the default again.
    yield* h.api.ChangeLcmSettings({ chatId: chat.id, change: { layerMax: 15_000 } })
    yield* h.api.ChangeLcmSettings({ chatId: chat.id, change: { recentMax: null } })
    const changed = yield* read(chat.id)
    assert.strictEqual(changed.stored!.layerMax, 15_000)
    assert.strictEqual(changed.stored!.recentTarget, 10_000)
    assert.isUndefined(changed.stored!.recentMax)
    assert.strictEqual(changed.resolved.recentMax, 30_000)
    assert.strictEqual(changed.resolved.from.recentMax, "account")
    // A target at or above its maximum in the chat's own settings is refused, and nothing is written.
    const refused = yield* Effect.flip(h.api.ChangeLcmSettings({ chatId: chat.id, change: { recentMax: 9_000 } }))
    assert.strictEqual(refused._tag, "LcmSettingsInvalid")
    assert.include((refused as { message: string }).message, "must be below")
    assert.isUndefined((yield* read(chat.id)).stored!.recentMax)
    // The old account switch reads as "when": off is "with the next reply"; writing `when` drops it.
    const defaults = yield* h.api.GetGenerationDefaults()
    yield* h.api.SetGenerationDefaults({ defaults: { ...defaults, lcm: { ...defaults.lcm, spendAhead: false } } })
    assert.strictEqual((yield* read(legacy.id)).resolved.when, "next-reply")
    yield* h.api.ChangeGenerationDefaults({ change: { lcm: { when: "after-reply" } } })
    const now = yield* h.api.GetGenerationDefaults()
    assert.strictEqual(now.lcm?.when, "after-reply")
    assert.isUndefined(now.lcm?.spendAhead)
    // An account default with a target over its maximum is refused too.
    const bad = yield* Effect.flip(
      h.api.ChangeGenerationDefaults({ change: { lcm: { layerTarget: 40_000, layerMax: 20_000 } } })
    )
    assert.strictEqual(bad._tag, "LcmSettingsInvalid")
    // The switch for new chats.
    yield* h.api.ChangeGenerationDefaults({ change: { lcm: { enabled: false } } })
    assert.isFalse((yield* read((yield* made()).id)).resolved.enabled)
  })
)

lcmTest("a chunk that doesn't fit twice in the recent band plans nothing, without failing", (server) =>
  Effect.gen(function* () {
    // A band of 1,000 tokens and a chunk of 800: the Summaries section says so under the chunk size.
    const h = yield* lcmHarness(server, {
      messages: 0,
      settings: { recentTarget: 2_000, recentMax: 3_000, layerTarget: 1_000, layerMax: 1_500, leafInput: 800 }
    })
    for (let n = 0; n < 40; n++) yield* h.append(message(n))
    const plan = yield* h.reader.PlanSummaries({
      userId: h.userId,
      chatId: h.chat.id,
      leafSlotId: h.rows.at(-1)!.slotId
    })
    assert.lengthOf(plan.chunks, 0)
  })
)

lcmTest("planning starts at the recent pair's midpoint and keeps its target; assembly uses both pairs", (server) =>
  Effect.gen(function* () {
    const h = yield* lcmHarness(server, {
      messages: 0,
      settings: {
        recentTarget: 2_000,
        recentMax: 3_000,
        layerTarget: 1_000,
        layerMax: 1_500,
        leafInput: 400,
        leafTarget: 60
      }
    })
    const plan = () =>
      h.reader.PlanSummaries({ userId: h.userId, chatId: h.chat.id, leafSlotId: h.rows.at(-1)!.slotId })
    // 23 messages, about 2,370 tokens: above the target, below the midpoint (2,500). Nothing is planned.
    for (let n = 0; n < 23; n++) yield* h.append(message(n))
    const quiet = yield* plan()
    assert.lengthOf(quiet.chunks, 0)
    assert.strictEqual(quiet.windowMax, 3_000)
    // Past the midpoint: the oldest are planned, the newest 2,000 tokens kept.
    for (let n = 23; n < 26; n++) yield* h.append(message(n))
    const busy = yield* plan()
    assert.isAbove(busy.chunks.length, 0)
    const planned = new Set(busy.chunks.flatMap((c) => c.inputs.map((i) => i.slotId)))
    const kept = h.rows.filter((r) => !planned.has(r.slotId))
    const cost = (n: number) => Math.ceil(message(n).length / 4) + 3
    const keptTokens = kept.reduce((sum, r) => sum + cost(h.rows.indexOf(r)), 0)
    assert.isAtLeast(keptTokens, 2_000)
    assert.isBelow(keptTokens, 2_000 + cost(0))
    for (const chunk of busy.chunks) assert.strictEqual(chunk.target, 60)
    // The assembly measures the layer against its pair and cuts recent messages with theirs.
    const last = h.rows.at(-1)!
    const built = JSON.parse(
      (yield* h.reader.AssembleContext({
        userId: h.userId,
        chatId: h.chat.id,
        slotId: last.slotId,
        versionId: last.version.id,
        now: 1,
        timeZone: "UTC",
        frozen: null
      })).snapshot
    ) as ContextSnapshot
    assert.deepStrictEqual(built.lcm!.layerBudget, { target: 1_000, maximum: 1_500 })
    assert.deepStrictEqual(built.lcm!.recentBudget, { target: 2_000, maximum: 3_000 })
    // Summarized back to the target: afterwards nothing more is planned.
    yield* h.settle
    const after = yield* plan()
    assert.lengthOf(after.chunks, 0)
    assert.isFalse(after.over)
  })
)

lcmTest("pairs that don't fit are scaled down and said so, and the reply still assembles", (server) =>
  Effect.gen(function* () {
    const h = yield* lcmHarness(server, {
      settings: { recentTarget: 16_000, recentMax: 24_000, layerTarget: 8_000, layerMax: 12_000, leafInput: 4_000 }
    })
    const view = yield* h.api.GetLcmSettings({ chatId: h.chat.id, leafSlotId: h.rows.at(-1)!.slotId })
    const fits = view.fit.find((m) => m.field === "recentMax")!
    assert.match(
      fits.message,
      /^Recent messages \(24,000\) and summaries \(12,000\) need 36,000 tokens; this model's context leaves [\d,]+ after the preset and reply\.$/
    )
    assert.strictEqual(view.room!.context, 8_192)
    assert.strictEqual(view.room!.reply, 512)
    assert.isTrue(view.fitted!.recent.clamped && view.fitted!.layer.clamped)
    // Both pairs scaled by one factor, inside what the model leaves.
    assert.isAtMost(
      view.fitted!.recent.maximum + view.fitted!.layer.maximum,
      view.room!.context - view.room!.reply - view.room!.fixed
    )
    assert.isBelow(view.fitted!.recent.target, view.fitted!.recent.maximum)
    // The chunk the settings name is too large for the scaled band: said under it.
    assert.isTrue(
      view.fit.some(
        (m) => m.field === "leafInput" && m.message.startsWith("Chunk size 4,000 needs a gap of at least 8,000 tokens.")
      )
    )
    assert.isNotNull(view.now)
    const last = h.rows.at(-1)!
    const built = yield* h.reader.AssembleContext({
      userId: h.userId,
      chatId: h.chat.id,
      slotId: last.slotId,
      versionId: last.version.id,
      now: 1,
      timeZone: "UTC",
      frozen: null
    })
    assert.isAbove((JSON.parse(built.snapshot) as ContextSnapshot).request.messages.length, 0)
    // Pairs that fit leave nothing to say.
    yield* h.api.ChangeLcmSettings({ chatId: h.chat.id, change: { recentTarget: 2_000 } })
    yield* h.api.ChangeLcmSettings({ chatId: h.chat.id, change: { recentMax: 3_000 } })
    yield* h.api.ChangeLcmSettings({ chatId: h.chat.id, change: { layerTarget: 1_000 } })
    yield* h.api.ChangeLcmSettings({ chatId: h.chat.id, change: { layerMax: 1_500 } })
    yield* h.api.ChangeLcmSettings({ chatId: h.chat.id, change: { leafInput: null } })
    const fitting = yield* h.api.GetLcmSettings({ chatId: h.chat.id, leafSlotId: last.slotId })
    assert.deepStrictEqual(fitting.fit, [])
    assert.strictEqual(fitting.fitted!.chunk, 500)
    assert.isFalse(fitting.fitted!.recent.clamped)
  })
)

lcmTest("with the next reply holds claims; right after a reply admits them; the chat's setting decides", (server) =>
  Effect.gen(function* () {
    const h = yield* lcmHarness(server)
    yield* h.api.ChangeLcmSettings({ chatId: h.chat.id, change: { when: "next-reply" } })
    yield* h.enqueue(0, 3, "background")
    assert.isNull(yield* h.writer.ClaimSummaryJob({ userId: h.userId }))
    // The account default says otherwise; the chat's own wins.
    yield* h.defaults({ spendAhead: true })
    assert.isNull(yield* h.writer.ClaimSummaryJob({ userId: h.userId }))
    yield* h.api.ChangeLcmSettings({ chatId: h.chat.id, change: { when: "after-reply" } })
    const claimed = yield* h.writer.ClaimSummaryJob({ userId: h.userId })
    assert.isNotNull(claimed)
    // Following the account default again, which is off.
    yield* h.writer.ReleaseSummaryJob({ userId: h.userId, jobId: claimed!.id, attempt: claimed!.epoch })
    yield* h.defaults({ spendAhead: false })
    yield* h.api.ChangeLcmSettings({ chatId: h.chat.id, change: { when: null } })
    assert.isNull(yield* h.writer.ClaimSummaryJob({ userId: h.userId }))
  })
)

lcmTest("without the preset a summary ends with a user instruction after continuity and the chunk", (server) =>
  Effect.gen(function* () {
    const h = yield* lcmHarness(server, { messages: 9, settings: { withPreset: false } })
    for (const [from, to] of [
      [0, 2],
      [3, 5],
      [6, 8]
    ] as const) {
      yield* h.enqueue(from, to)
      yield* h.runNext
    }
    const sent = requestsTo(h.mock, "primary-model").map(
      (r) => r.body!.messages as Array<{ role: string; content: string }>
    )
    assert.lengthOf(sent, 3)
    const instruction =
      BUILTIN_SUMMARY_INSTRUCTION.replace("{{words}}", "75") + "\nReturn only the summary, without commentary."
    for (const messages of sent) {
      assert.deepStrictEqual(messages.at(-1), { role: "user", content: instruction })
      // Nothing of the preset: its main prompt is not there.
      assert.isFalse(messages.some((m) => m.content.includes("in a fictional chat")))
    }
    // The first chunk alone; then the continuity, one message per earlier summary, then the chunk.
    assert.deepStrictEqual(
      sent[0]!.slice(0, -1).map((m) => m.content.slice(0, 10)),
      ["Message 0.", "Message 1.", "Message 2."]
    )
    assert.strictEqual(sent[1]![0]!.role, "user")
    assert.match(sent[1]![0]!.content, /^<summary level="1" from="1" to="3">\nA summary\.\n<\/summary>$/)
    assert.deepStrictEqual(
      sent[1]!.slice(1, -1).map((m) => m.content.slice(0, 10)),
      ["Message 3.", "Message 4.", "Message 5."]
    )
    // The next chunk repeats the continuity before it byte for byte and adds the new summary after
    // it, so the breakpoint the previous request set is a prefix of this one.
    assert.deepStrictEqual(sent[2]!.slice(0, 1), sent[1]!.slice(0, 1))
    assert.match(sent[2]![1]!.content, /^<summary level="1" from="4" to="6">/)
    assert.deepStrictEqual(
      sent[2]!.slice(2, -1).map((m) => m.content.slice(0, 10)),
      ["Message 6.", "Message 7.", "Message 8."]
    )
    // The breakpoint covers continuity only; the final instruction is outside the reusable prefix.
    const [snapshots] = yield* fixtureSql(h.dataDir, [
      {
        sql: `SELECT p.context_snapshot_json AS s FROM rollouts r JOIN rollout_payloads p ON p.rollout_id = r.id
          WHERE r.chat_id = ? AND r.kind = 'summarize' ORDER BY r.started_at, r.id`,
        params: [h.chat.id]
      }
    ])
    const contexts = snapshots!.map((row) => JSON.parse(row.s as string) as ContextSnapshot)
    assert.deepStrictEqual(contexts[0]!.request.breakpoints, [])
    assert.deepStrictEqual(contexts[1]!.request.breakpoints, [{ message: 0, reason: "summary" }])
    assert.deepStrictEqual(contexts[2]!.request.breakpoints, [{ message: 1, reason: "summary" }])
    assert.isFalse(contexts[1]!.summaryJob!.withPreset)
    // Its inspector pieces name the instruction, the summaries and the messages.
    assert.isTrue(
      contexts[1]!.pieces.some(
        (p) => p.id === "lcm:instruction" && p.messages[0] === contexts[1]!.request.messages.length - 1
      )
    )
    assert.isTrue(contexts[1]!.pieces.some((p) => p.source.kind === "summary" && p.messages[0] === 0))
    // Each rebuilds exactly.
    for (const context of contexts) {
      const rebuilt = yield* h.reader.RebuildContext({ userId: h.userId, snapshot: JSON.stringify(context) })
      assert.strictEqual(rebuilt._tag, "Rebuilt")
      if (rebuilt._tag === "Rebuilt") assert.deepStrictEqual(JSON.parse(rebuilt.snapshot).request, context.request)
    }
  })
)

lcmTest("with the full preset the instruction follows the chat as before", (server) =>
  Effect.gen(function* () {
    const h = yield* lcmHarness(server, { messages: 4 })
    yield* h.enqueue(0, 1)
    yield* h.runNext
    const [messages] = requestsTo(h.mock, "primary-model").map(
      (r) => r.body!.messages as Array<{ role: string; content: string }>
    )
    assert.notStrictEqual(messages![0]!.content.slice(0, 20), BUILTIN_SUMMARY_INSTRUCTION.slice(0, 20))
    assert.strictEqual(messages!.at(-1)!.role, "user")
    assert.strictEqual(
      messages!.at(-1)!.content,
      BUILTIN_SUMMARY_INSTRUCTION.replace("{{words}}", "75") + "\nReturn only the summary, without commentary."
    )
  })
)

it.effect("the estimate prices requests without the preset: only continuity is cached", () =>
  Effect.sync(() => {
    const input = {
      tokens: 100_000,
      messages: 500,
      recentTarget: 16_000,
      recentMax: 24_000,
      layerMax: 12_000,
      prefix: 6_000,
      layer: 0,
      leafInput: 4_000,
      leafTarget: 600,
      fanout: 5,
      condenseTarget: 800,
      cached: true,
      cacheWrites: false
    }
    const preset = estimateBackfill(input)
    const raw = estimateBackfill({ ...input, withPreset: false })
    assert.strictEqual(raw.l1Jobs, preset.l1Jobs)
    assert.strictEqual(raw.condensations, preset.condensations)
    // No 6,000-token preset is read back on every request.
    assert.isBelow(raw.cachedInput, preset.cachedInput - 6_000 * (preset.requests - 2))
    // The first request pays for the instruction only, not the preset.
    assert.strictEqual(raw.plannedRequests[0]!.uncachedInput, preset.plannedRequests[0]!.uncachedInput - 6_000)
    // Every instruction stays in uncached input. With no preset the first request has no reusable prefix.
    assert.strictEqual(raw.plannedRequests[0]!.cachedInput, 0)
    const one = { ...input, tokens: 20_100, messages: 100, recentTarget: 20_000, recentMax: 20_000, withPreset: false }
    assert.strictEqual(estimateBackfill(one).uncachedInput, estimateBackfill({ ...one, cached: false }).uncachedInput)
    // Without a cache, nothing of the preset is sent at all.
    const cold = estimateBackfill({ ...input, cached: false, withPreset: false })
    const coldPreset = estimateBackfill({ ...input, cached: false })
    assert.strictEqual(coldPreset.uncachedInput - cold.uncachedInput, 6_000 * coldPreset.requests)
  })
)

lcmTest("summary style defaults are copied, reset and used by request assembly", (server) =>
  Effect.gen(function* () {
    const h = yield* lcmHarness(server, { messages: 3 })
    yield* h.api.ChangeGenerationDefaults({ change: { lcm: { style: "tool" } } })
    const chat = yield* h.api.CreateChat({ title: "Copies summary style" })
    assert.strictEqual((yield* h.api.GetLcmSettings({ chatId: chat.id, leafSlotId: null })).stored!.style, "tool")
    yield* h.api.ChangeGenerationDefaults({ change: { lcm: { style: "direct" } } })
    assert.strictEqual((yield* h.api.GetLcmSettings({ chatId: chat.id, leafSlotId: null })).resolved.style, "tool")
    yield* h.api.ChangeLcmSettings({ chatId: chat.id, change: { style: null } })
    assert.strictEqual((yield* h.api.GetLcmSettings({ chatId: chat.id, leafSlotId: null })).resolved.style, "direct")
    // The fixture chat predates the setting: the account supplies tool, then the chat overrides it.
    yield* h.api.ChangeGenerationDefaults({ change: { lcm: { style: "tool" } } })
    yield* h.enqueue(0, 2)
    const job = yield* h.writer.ClaimSummaryJob({ userId: h.userId })
    assert.isNotNull(job)
    for (const [n, style] of ["tool", "direct", "tool"].entries()) {
      if (n > 0) yield* h.api.ChangeLcmSettings({ chatId: h.chat.id, change: { style: n === 1 ? "direct" : null } })
      const built = yield* h.reader.AssembleSummary({ userId: h.userId, jobId: job!.id, attempt: job!.epoch })
      assert.strictEqual((JSON.parse(built.snapshot) as ContextSnapshot).summaryJob!.style, style)
    }
  })
)
