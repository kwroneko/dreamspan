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
   * How it takes this reasoning: as signed blocks bound to what preceded them (checked against
   * the request before the reply), as plain text, or not, and why.
   */
  readonly accepts: (
    native: NativeReasoning
  ) => { readonly form: "signed" | "text" } | { readonly form: "none"; readonly reason: ThinkingSendReason }
}

const signed = (native: NativeReasoning) =>
  native.parts.length > 0 && native.parts.every((part) => (part.signature ?? "").trim() !== "")

const responsesItem = (signature: string | undefined) => {
  try {
    const item: unknown = JSON.parse(signature ?? "")
    return (
      typeof item === "object" &&
      item !== null &&
      (item as Record<string, unknown>).type === "reasoning" &&
      typeof (item as Record<string, unknown>).encrypted_content === "string"
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
 * Sources (2026-11-23): Anthropic takes earlier thinking blocks only with their signature and
 * the conversation they were written in; OpenAI Responses its encrypted reasoning items, the
 * same way; OpenRouter documents `reasoning` (plain text, `reasoning_content` an alias) and
 * `reasoning_details` on assistant messages; DeepSeek ignores `reasoning_content` in a request
 * without tools; Google documents no way to send thought summaries back. Others: not sent.
 */
const builtinReplayRules: ReadonlyArray<ReasoningReplayRule> = [
  {
    id: "anthropic-messages",
    appliesTo: (model) => model.api === "anthropic-messages",
    accepts: (native) => (signed(native) ? { form: "signed" } : { form: "none", reason: "provider" })
  },
  {
    id: "openai-responses",
    appliesTo: (model) => model.api === "openai-responses",
    accepts: (native) =>
      native.parts.length > 0 && native.parts.every((part) => responsesItem(part.signature))
        ? { form: "signed" }
        : { form: "none", reason: "provider" }
  },
  {
    id: "openrouter",
    appliesTo: (model) => model.kind === "openrouter" && model.api === "openai-completions",
    accepts: (native) =>
      reasoningDetails(native)
        ? { form: "signed" }
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

const LEFT_OUT: Partial<Record<ThinkingSendReason, (n: number) => string>> = {
  changed: (n) =>
    `Reasoning from ${n === 1 ? "an earlier reply" : `${n} earlier replies`} wasn't sent back: the request before it changed since it was written, so the provider would refuse it.`,
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
 * `max_additions`), each sent back when the user didn't hide it and the provider takes it.
 * Signed reasoning also needs the same model and connection and everything before its reply
 * unchanged; at the first that changed, it and every later signed one are left out, as the
 * provider layer's check does. A tool run starts from the replies' text, and a summary sees
 * their text only. Records the tagged-thinking decisions of `reply-sections` beside its own.
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
          if (!found?.reasoning) continue
          chosen.push({ entry, native: found.native })
          if (chosen.length === n) break
        }
      }
      const at = messageOf(assembly)
      const rule = rules.find((r) => r.appliesTo(model))
      const decided: Array<{ versionId: string; reason: ThinkingSendReason; replay?: ReplayedReasoning }> = []
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
        const terms = rule?.accepts(value) ?? { form: "none" as const, reason: "provider" as const }
        if (terms.form === "none") {
          decided.push({ versionId, reason: terms.reason })
          continue
        }
        if (
          value.connectionId !== model.connectionId ||
          value.modelId !== model.modelId ||
          value.key !== model.key ||
          value.api !== model.api ||
          (value.connectionRevision ?? null) !== (model.connectionRevision ?? null)
        ) {
          decided.push({ versionId, reason: "model" })
          continue
        }
        const message = at.get(versionId)
        if (message === undefined || message === "merged") {
          decided.push({ versionId, reason: "merged" })
          continue
        }
        decided.push({ versionId, reason: "sent", replay: { message, form: terms.form, native: value } })
      }
      // Signed reasoning, oldest first: kept while what precedes it is what it was written after.
      const signedReplays = decided
        .filter((d) => d.replay?.form === "signed")
        .toSorted((a, b) => a.replay!.message - b.replay!.message)
      const result = need(assembly, "result")
      const digests = prefixDigests(result.messages, new Set(signedReplays.map((d) => d.replay!.message)))
      let dropping = false
      for (const d of signedReplays) {
        if (!dropping && digests.get(d.replay!.message) !== d.replay!.native.prefix) dropping = true
        if (dropping) {
          d.reason = "changed"
          delete d.replay
        }
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
