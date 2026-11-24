// Earlier replies' own reasoning sent back in a plain chat request (owner, 2026-11-23: "it cannot
// be fixed that native thinking is never sent back. That SHOULD be the default setting"). The
// preset's `reasoning_send_back` names how many recent replies send theirs (0, the default:
// none). A reply keeps what the provider sent (`NativeReasoning`, saved with its final text);
// this stage decides, per reply, whether the provider takes it back and records why not, and
// the request carries the ones it sends (`AssembledRequest.replay`), which `wire.ts` puts on
// the wire. The thinking panels' "Sent to the model" reads the same decision (`ThinkingSends`),
// so it can't disagree with the request. The provider layer's final check (providers/
// thinkingBinding.ts) still runs on the payload as it goes out.
import { createHash } from "node:crypto"
import { Effect, Schema } from "effect"
import { reasoningSendBack, replySectionsOf } from "@dreamspan/shared/replySections.ts"
import type { ThinkingSend, ThinkingSendReason } from "@dreamspan/shared/thinkingSends.ts"
import { keyOf, replayTerms } from "../providers/thinkingBinding.ts"
import { AssemblySources, need, type AssemblerStage, type Assembly } from "./pipeline.ts"
import type { ModelInput, RequestMessage } from "./types.ts"

/** One reasoning part as pi-ai returned it: its text, and its signature (or the field it came in). */
const NativeReasoningPart = Schema.Struct({
  text: Schema.String,
  signature: Schema.optionalKey(Schema.String),
  redacted: Schema.optionalKey(Schema.Boolean)
})

/** A plain reply's reasoning as the provider sent it, and what it was written after (`version_texts.native_reasoning`). */
export const NativeReasoning = Schema.Struct({
  api: Schema.String,
  kind: Schema.String,
  key: Schema.String,
  connectionId: Schema.String,
  modelId: Schema.String,
  connectionRevision: Schema.optionalKey(Schema.Number),
  /** `requestDigest` of the request the reply answered (without its prefill). */
  prefix: Schema.String,
  /** The same without its last message, when that was the end-of-request message; absent: it wasn't. */
  bare: Schema.optionalKey(Schema.String),
  /** The effort pi-ai recorded it was written at (`providerThinkingLevel`), part of its prefix where sent. */
  level: Schema.optionalKey(Schema.String),
  parts: Schema.Array(NativeReasoningPart),
  /** The provider layer's record of the payload it answered (thinkingBinding.ts `ThinkingRecord`). */
  record: Schema.optionalKey(Schema.Unknown)
})
export type NativeReasoning = typeof NativeReasoning.Type

const decodeNative = Schema.decodeUnknownOption(Schema.fromJsonString(NativeReasoning))

/** Reasoning a request sends back on one of its messages (an index into `messages`). */
export interface ReplayedReasoning {
  readonly message: number
  /** `signed`: as the provider's own blocks; `text`: in the field the provider takes plain reasoning in. */
  readonly form: "signed" | "text"
  readonly native: NativeReasoning
}

/** What a message contributes to a prefix: role, name, text and the images it sends. */
const row = (message: RequestMessage) =>
  JSON.stringify([
    message.role,
    message.name ?? null,
    message.content,
    (message.images ?? []).filter((image) => image.estimate?.sent !== false).map((i) => i.sha256 ?? i.mediaId)
  ])

/** The digest of a request's messages, all of them: what a reply to it was written after. */
export const requestDigest = (messages: ReadonlyArray<RequestMessage>) => {
  const hash = createHash("sha256")
  for (const message of messages) hash.update(row(message)).update("\n")
  return hash.digest("hex")
}

/** `digests[i]`: the digest of messages before `i`, as `requestDigest` of `messages.slice(0, i)`. */
const prefixDigests = (messages: ReadonlyArray<RequestMessage>, wanted: ReadonlySet<number>) => {
  const hash = createHash("sha256")
  const out = new Map<number, string>()
  for (let i = 0; i <= messages.length; i++) {
    if (wanted.has(i)) out.set(i, hash.copy().digest("hex"))
    if (i < messages.length) hash.update(row(messages[i]!)).update("\n")
  }
  return out
}

/** A provider's terms for earlier replies' reasoning. */
export interface ReasoningReplayRule {
  readonly id: string
  readonly appliesTo: (model: ModelInput) => boolean
  /**
   * How it takes this reasoning, going to `model`: as signed blocks (`bound`: only while what
   * preceded the reply is what it was written after, and as an unbroken run, checked against the
   * request), as plain text, or not, and why. Only what the provider itself checks.
   */
  readonly accepts: (
    native: NativeReasoning,
    model: ModelInput
  ) =>
    | { readonly form: "signed"; readonly bound: boolean }
    | { readonly form: "text" }
    | { readonly form: "none"; readonly reason: ThinkingSendReason }
}

/** Written by the model it goes to, on that connection as it is now: a signature is the account's and model's. */
const sameWriter = (native: NativeReasoning, model: ModelInput) =>
  native.connectionId === model.connectionId &&
  native.api === model.api &&
  native.modelId === model.modelId &&
  native.key === model.key &&
  (native.connectionRevision ?? null) === (model.connectionRevision ?? null)

/** Signed reasoning from the same writer, bound to its prefix where the provider binds it. */
const signedTerms = (native: NativeReasoning, model: ModelInput) =>
  sameWriter(native, model)
    ? { form: "signed" as const, bound: replayTerms({ api: model.api, key: model.key }).prefix }
    : { form: "none" as const, reason: "model" as const }

const signed = (native: NativeReasoning) =>
  native.parts.length > 0 && native.parts.every((part) => (part.signature ?? "").trim() !== "")

const responsesItem = (signature: string | undefined) => {
  try {
    const item: unknown = JSON.parse(signature ?? "")
    return (
      typeof item === "object" &&
      item !== null &&
      (item as Record<string, unknown>).type === "reasoning" &&
      typeof (item as Record<string, unknown>).encrypted_content === "string" &&
      // The provider checks the item under its own id.
      typeof (item as Record<string, unknown>).id === "string"
    )
  } catch {
    return false
  }
}

/** OpenRouter's structured `reasoning_details`, when the reply came with them. */
export const reasoningDetails = (native: NativeReasoning): ReadonlyArray<unknown> | undefined => {
  for (const part of native.parts) {
    try {
      const parsed: unknown = JSON.parse(part.signature ?? "")
      if (Array.isArray(parsed) && parsed.length > 0) return parsed
    } catch {
      // Not details: the name of the field the text came in.
    }
  }
  return undefined
}

/**
 * Sources (2026-11-23; thinkingBinding.ts `replayTerms`): Anthropic Messages takes earlier
 * thinking blocks back from the model that wrote them; bound-thinking models (claudeThinking.ts
 * `claudeBoundThinking`) only with everything before each unchanged and as an unbroken run,
 * earlier models with any history before them while the signature is intact. OpenAI Responses
 * takes its encrypted reasoning items with any history, intact under their own item ids, and
 * another model ignores them. OpenRouter documents `reasoning` (plain text, `reasoning_content`
 * an alias) and `reasoning_details` on assistant messages (taken as bound). DeepSeek ignores
 * `reasoning_content` in a request without tools; Google documents no way to send thought
 * summaries back. Others: not sent.
 */
const builtinReplayRules: ReadonlyArray<ReasoningReplayRule> = [
  {
    id: "anthropic-messages",
    appliesTo: (model) => model.api === "anthropic-messages",
    accepts: (native, model) => (signed(native) ? signedTerms(native, model) : { form: "none", reason: "provider" })
  },
  {
    id: "openai-responses",
    appliesTo: (model) => model.api === "openai-responses",
    accepts: (native, model) =>
      native.parts.length > 0 && native.parts.every((part) => responsesItem(part.signature))
        ? signedTerms(native, model)
        : { form: "none", reason: "provider" }
  },
  {
    id: "openrouter",
    appliesTo: (model) => model.kind === "openrouter" && model.api === "openai-completions",
    accepts: (native, model) =>
      !sameWriter(native, model)
        ? { form: "none", reason: "model" }
        : reasoningDetails(native)
          ? { form: "signed", bound: true }
          : native.parts.some((part) => part.text.trim() !== "")
            ? { form: "text" }
            : { form: "none", reason: "provider" }
  },
  {
    id: "deepseek",
    appliesTo: (model) => model.kind === "deepseek",
    accepts: () => ({ form: "none", reason: "ignored" })
  }
]

/** Each version's message in the request, when it's a message of its own (the model's). */
const messageOf = (assembly: Assembly) => {
  const messages = need(assembly, "messages")
  const at = new Map<string, number | "merged">()
  messages.forEach((message, i) => {
    const versions = new Set<string>()
    let other = false
    for (const p of message.pieces) {
      const source = assembly.pieces[p]?.source
      if (source?.kind === "message") versions.add(source.version)
      else other = true
    }
    for (const version of versions)
      at.set(version, at.has(version) || versions.size > 1 || other || message.role !== "assistant" ? "merged" : i)
  })
  return at
}

/** How many versions a read asks about at once, newest first, until the last N are found. */
const BATCH = 64

/**
 * A reply's last signed block as the provider layer keys it (thinkingBinding.ts `signed`), and
 * the last one its request carried (its record's `prev`): the block it followed.
 */
const chainOf = (native: NativeReasoning) => {
  const details = native.api === "openai-completions" ? reasoningDetails(native) : undefined
  const last = details
    ? keyOf(JSON.stringify(details))
    : native.parts.flatMap((part) => (part.signature ? [keyOf(part.signature)] : [])).at(-1)
  const prev = (native.record as { readonly prev?: unknown } | undefined)?.prev
  return { last, prev: typeof prev === "string" ? prev : null }
}

const LEFT_OUT: Partial<Record<ThinkingSendReason, (n: number) => string>> = {
  changed: (n) =>
    `Reasoning from ${n === 1 ? "an earlier reply" : `${n} earlier replies`} wasn't sent back: the request before it changed since it was written, so the provider would refuse it.`,
  end: (n) =>
    `Reasoning from ${n === 1 ? "an earlier reply" : `${n} earlier replies`} wasn't sent back: this model takes it only with everything before it unchanged, and the end-of-request text it was written after isn't kept in the history.`,
  chain: (n) =>
    `Reasoning from ${n === 1 ? "an earlier reply" : `${n} earlier replies`} wasn't sent back: this model takes earlier reasoning only as an unbroken run, and a later reply's reasoning it was followed by isn't sent.`,
  model: (n) =>
    `Reasoning from ${n === 1 ? "an earlier reply" : `${n} earlier replies`} wasn't sent back: another model or connection wrote it.`,
  provider: (n) =>
    `Reasoning from ${n === 1 ? "an earlier reply" : `${n} earlier replies`} wasn't sent back: this provider doesn't take it.`,
  ignored: (n) =>
    `Reasoning from ${n === 1 ? "an earlier reply" : `${n} earlier replies`} wasn't sent back: this provider ignores it.`,
  unrecorded: (n) =>
    `Reasoning from ${n === 1 ? "an earlier reply" : `${n} earlier replies`} wasn't sent back: it was edited, continued, imported or written in a tool run.`,
  merged: (n) =>
    `Reasoning from ${n === 1 ? "an earlier reply" : `${n} earlier replies`} wasn't sent back: its message is joined with others in this request.`
}

/**
 * The `reasoning-replay` stage, after `request` and `images`: the last N replies of the card
 * being written that have reasoning (as the tagged-thinking send-back counts, ST's
 * `max_additions`), each sent back when the user didn't hide it and the provider takes it, on
 * the terms the provider itself checks (the rules). Signed reasoning a provider binds also needs
 * everything before its reply unchanged, and the bound ones sent must be an unbroken run: from
 * the newest that fits, each older one only while it is the block the next one followed. A tool
 * run starts from the replies' text, and a summary sees their text only. Records the
 * tagged-thinking decisions of `reply-sections` beside its own.
 */
export const reasoningReplayStage = (
  rules: ReadonlyArray<ReasoningReplayRule> = builtinReplayRules
): AssemblerStage => ({
  id: "reasoning-replay",
  run: (assembly) =>
    Effect.gen(function* () {
      const settings = replySectionsOf(need(assembly, "preset").doc)
      const summary = !!assembly.request.summaryJob || !!assembly.request.summarizing
      const toolRun = !!assembly.request.agent
      const n = summary ? 0 : reasoningSendBack(settings)
      const sections = summary ? 0 : settings.send_back
      const items: Array<ThinkingSend> = [...(assembly.thinkingSent ?? [])]
      const finish = () => {
        if (n > 0 || sections > 0)
          assembly.thinkingSends = { sections, reasoning: n, ...(toolRun && n > 0 ? { toolRun: true } : {}), items }
      }
      const model = assembly.model
      // Every request of a chat that sends reasoning back is built so a later one can repeat it.
      if (n > 0 && !toolRun) assembly.result = { ...need(assembly, "result"), replayReasoning: true }
      const sources = yield* AssemblySources
      if (n === 0 || toolRun || !model || !sources.nativeReasoning) return (finish(), assembly)
      const speaker = need(assembly, "cast").speaker?.entity ?? null
      // Newest first, the card being written's own (both known), as `reply-sections` counts.
      const candidates = need(assembly, "resolved")
        .map(({ entry }) => entry)
        .filter((entry) => !(speaker !== null && entry.speaker !== null && entry.speaker !== speaker))
        .reverse()
      const chosen: Array<{ entry: (typeof candidates)[number]; native: string | null }> = []
      for (let from = 0; from < candidates.length && chosen.length < n; from += BATCH) {
        const batch = candidates.slice(from, from + BATCH)
        const read = new Map(
          (yield* sources.nativeReasoning(batch.map((entry) => entry.versionId))).map((row) => [row.versionId, row])
        )
        for (const entry of batch) {
          const found = read.get(entry.versionId)
          if (!found || (!found.reasoning && found.native === null)) continue
          chosen.push({ entry, native: found.native })
          if (chosen.length === n) break
        }
      }
      const at = messageOf(assembly)
      const rule = rules.find((r) => r.appliesTo(model))
      const decided: Array<{
        versionId: string
        reason: ThinkingSendReason
        replay?: ReplayedReasoning
        bound?: boolean
      }> = []
      for (const { entry, native: json } of chosen) {
        const versionId = entry.versionId
        if (entry.thinkingHidden?.includes("reasoning")) {
          decided.push({ versionId, reason: "hidden" })
          continue
        }
        const native = json === null ? undefined : decodeNative(json)
        if (native === undefined || native._tag === "None") {
          decided.push({ versionId, reason: "unrecorded" })
          continue
        }
        const value = native.value
        const terms = rule?.accepts(value, model) ?? { form: "none" as const, reason: "provider" as const }
        if (terms.form === "none") {
          decided.push({ versionId, reason: terms.reason })
          continue
        }
        const message = at.get(versionId)
        if (message === undefined || message === "merged") {
          decided.push({ versionId, reason: "merged" })
          continue
        }
        decided.push({
          versionId,
          reason: "sent",
          replay: { message, form: terms.form, native: value },
          bound: terms.form === "signed" && terms.bound
        })
      }
      // Bound reasoning: each kept only while what precedes its reply is what it was written after.
      const boundReplays = decided
        .filter((d) => d.replay && d.bound)
        .toSorted((a, b) => b.replay!.message - a.replay!.message)
      const result = need(assembly, "result")
      const digests = prefixDigests(result.messages, new Set(boundReplays.map((d) => d.replay!.message)))
      const leave = (d: (typeof decided)[number], reason: ThinkingSendReason) => {
        d.reason = reason
        delete d.replay
      }
      for (const d of boundReplays) {
        const before = digests.get(d.replay!.message)
        // Written with pi-ai's effort messages (before the chat sent reasoning back), which this
        // request doesn't have (Providers.ts `replayReasoning`): its prefix can't match.
        if (d.replay!.native.level !== undefined) {
          leave(d, "changed")
          continue
        }
        if (before === d.replay!.native.prefix) continue
        // Only the end-of-request message it was written before is missing: the history never has it.
        leave(d, before !== undefined && before === d.replay!.native.bare ? "end" : "changed")
      }
      // Then an unbroken run, newest first: leaving out older ones is allowed, one in between not.
      let next: string | null | undefined
      for (const d of boundReplays) {
        if (!d.replay) continue
        const chain = chainOf(d.replay.native)
        if (next !== undefined && (next === null || chain.last !== next)) leave(d, "chain")
        else next = chain.prev
      }
      for (const d of decided)
        items.push({
          versionId: d.versionId as ThinkingSend["versionId"],
          part: "reasoning",
          sent: !!d.replay,
          reason: d.reason
        })
      const replay = decided.flatMap((d) => (d.replay ? [d.replay] : [])).toSorted((a, b) => a.message - b.message)
      if (replay.length > 0) assembly.result = { ...result, replay }
      // Why the others were left out, for the request inspector only (no note under the reply).
      const counts = new Map<ThinkingSendReason, number>()
      for (const d of decided)
        if (!d.replay && d.reason !== "hidden") counts.set(d.reason, (counts.get(d.reason) ?? 0) + 1)
      for (const [reason, count] of counts) {
        const message = LEFT_OUT[reason]?.(count)
        if (message) assembly.issues.push({ kind: "reasoning_left_out", message })
      }
      finish()
      return assembly
    })
})
