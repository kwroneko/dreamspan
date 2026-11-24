import { createHash } from "node:crypto"
import { toolDataBody, toolDataPage, TOOL_RESULT_CHARS } from "../toolData.ts"
// The way back to a run's tool results (spec/WORKSHOP-CONTEXT.md §3.2), reference-harness's
// read_session_transcript as a delta: a message's own steps, read from the run that wrote it.
// Causal: only messages on the path before the one being generated, each cut at its own post.
import { Type } from "@earendil-works/pi-ai"
import type { AgentMessage } from "@earendil-works/pi-agent-core"
import { isDeepStrictEqual } from "node:util"
import type { StoryAt, VersionId } from "@dreamspan/shared/chat.ts"
import { STRETCH_VIEW } from "@dreamspan/shared/knowledge.ts"
import { Effect } from "effect"
import { activeRunSummaries } from "../compaction.ts"
import { storyReadStamp } from "../continuity.ts"
import { placedSteps } from "../steps.ts"
import { attachedStory } from "../storyReadScope.ts"
import type { FrozenTool, RolloutTool, ToolContext } from "../tools.ts"
import { historyTools, safely } from "./history.ts"

const tokensOf = (text: string) => Math.ceil(text.length / 4)

/** One message's tool steps, numbered from 1, with their results, from its stored run. */
const messageSteps = (context: ToolContext, versionId: VersionId) =>
  Effect.gen(function* () {
    const material = yield* context.reader.RolloutMaterial({ userId: context.userId, versionId }).pipe(Effect.option)
    if (material._tag === "None" || !material.value.transcript) return null
    const frozen = JSON.parse(material.value.snapshot) as {
      agent?: { tools: ReadonlyArray<FrozenTool> }
      storyAt?: StoryAt
      storyStamp?: string | null
    }
    const transcript = JSON.parse(material.value.transcript) as Array<AgentMessage>
    return {
      storyAt: frozen.storyAt,
      storyStamp: frozen.storyStamp,
      steps: placedSteps(transcript, frozen.agent?.tools ?? [], material.value.status !== "running", versionId)
        .flatMap(({ step }) => (step.kind === "tool" ? [step] : []))
        .map((step, at) => ({ ...step, n: at + 1 }))
    }
  })

const STORY_WITHHELD =
  "(Story text from another position or an older version of the story: read it again with read_story or search_story, which read it where the user's tab shows it now.)"

/**
 * A side chat reads its story only at the request's position (spec/WORKSHOP.md §4). An earlier
 * run's story reads come back only when it read at this same position of the unchanged story, as
 * a carried request keeps them (continuity's check); otherwise they're withheld.
 */
const storyReadsStand = (
  context: ToolContext,
  run: { readonly storyAt: StoryAt | undefined; readonly storyStamp: string | null | undefined }
) =>
  Effect.gen(function* () {
    if ((yield* attachedStory(context)) === undefined) return true
    if (context.storyAt === undefined || !isDeepStrictEqual(run.storyAt, context.storyAt)) return false
    const now = yield* storyReadStamp(context.reader, context.userId, context.storyAt)
    return typeof now === "string" && run.storyStamp === now
  })

const readRun: RolloutTool<{
  readonly message: number
  readonly call?: string
  readonly query?: string
  readonly from_step?: number
  readonly max_tokens?: number
}> = {
  source: import.meta.url,
  id: "read_run",
  storyRead: "conversation",
  label: "Read earlier steps",
  explanation: "Read the tool calls and results behind an earlier message",
  effect: "read",
  description:
    "Reads the tool calls an earlier message of yours made, with their arguments and results, from the run that wrote it. Use it when a result was left out to save room, or to check what an earlier lookup returned, instead of looking it up again. Give the message's number; a call id or words narrow it.",
  parameters: Type.Object({
    message: Type.Integer({
      minimum: 0,
      description: "The earlier message number, or 0 for steps of this run (including summarized results)."
    }),
    call: Type.Optional(Type.String({ description: "Only the step with this tool call id." })),
    query: Type.Optional(Type.String({ description: "Only steps whose arguments or result contain all these words." })),
    from_step: Type.Optional(Type.Integer({ minimum: 1, description: "Start at this step number." })),
    max_tokens: Type.Optional(Type.Integer({ minimum: 200, maximum: 8000, description: "At most this much (2000)." }))
  }),
  summarize: ({ message }) => `Message ${message}`,
  execute: (context, { message, call, query, from_step = 1, max_tokens = 2000 }) =>
    safely(
      "read_run",
      Effect.gen(function* () {
        const version =
          message > 0 && Number.isSafeInteger(message) && context.leafSlotId !== null
            ? yield* context.reader.ReadPathVersionAt({
                userId: context.userId,
                chatId: context.chatId,
                forkId: context.forkId,
                leafSlotId: context.leafSlotId,
                position: message - 1
              })
            : null
        if (message !== 0 && version === null)
          return { text: `Message ${message} isn't one of the earlier messages.`, isError: true }
        // A separate context's character reads only its own runs (spec/CHARACTER-CONTEXT.md §9.2). A
        // stretch view (spec/THREADS.md §7.3: the whole path with a character speaking) isn't one:
        // it filters only a separate join's stretch, and the workshops this tool is offered in have
        // no joins, as the history tools read a stretch view whole where no separate join is on it.
        if (
          version &&
          context.viewers !== null &&
          !context.viewers.includes(STRETCH_VIEW) &&
          !context.viewers.includes(version.speakerEntityId ?? "")
        )
          return { text: `Message ${message}'s steps aren't yours to read.`, isError: true }
        const run =
          message === 0 && context.transcript
            ? {
                storyAt: context.storyAt,
                storyStamp: context.storyAt
                  ? yield* storyReadStamp(context.reader, context.userId, context.storyAt)
                  : undefined,
                steps: placedSteps(context.transcript(), context.offer?.tools ?? [], false)
                  .flatMap(({ step }) => (step.kind === "tool" ? [step] : []))
                  .map((step, at) => ({ ...step, n: at + 1 }))
              }
            : version
              ? yield* messageSteps(context, version.id)
              : null
        if (run === null || run.steps.length === 0)
          return { text: `Message ${message} was written without tool calls.` }
        // All positioned results count, including casts, setup results and plugin readers.
        // Without a declaration, withhold rather than replaying an unpositioned story fact.
        const readsStory = (id: string) => {
          const mode = context.storyReadOf?.(id)
          return mode === undefined || mode === "positioned"
        }
        const stands = run.steps.some((s) => readsStory(s.tool)) ? yield* storyReadsStand(context, run) : true
        const steps = stands
          ? run.steps
          : run.steps.map((s) => (readsStory(s.tool) ? { ...s, args: {}, result: STORY_WITHHELD } : s))
        const words = (query ?? "").toLowerCase().split(/\s+/).filter(Boolean)
        // Ordinary story tools retain their existing result bytes. Only the workshop
        // executor opts new calls into the data boundary and within-result paging.
        if (!context.formatResult) {
          const chosen = steps.filter(
            (s) =>
              s.n >= from_step &&
              (call === undefined || s.id === call) &&
              words.every((w) => `${JSON.stringify(s.args)}\n${s.result ?? ""}`.toLowerCase().includes(w))
          )
          if (chosen.length === 0)
            return { text: `No step of message ${message} matches (it has ${steps.length}).`, isError: true }
          const shown: Array<string> = []
          let used = 0
          for (const s of chosen) {
            const part = `<step n="${s.n}" call="${s.id}" tool="${s.tool}"${s.status === "error" ? ' failed="true"' : ""}>\n${JSON.stringify(s.args)}\n<result>\n${s.result ?? "(no result)"}\n</result>\n</step>`
            if (shown.length > 0 && used + tokensOf(part) > max_tokens) break
            shown.push(part)
            used += tokensOf(part)
          }
          const left = chosen.length - shown.length
          const next = chosen[shown.length]?.n
          return {
            text: `${shown.join("\n")}${left > 0 ? `\n[${left} more steps: read_run with from_step=${next}.]` : ""}`
          }
        }
        // `call` is already a string in the frozen definition. Continuation cursors use it
        // without changing any tool declaration in an existing chat's provider prefix.
        const cursor = steps.some((s) => s.id === call)
          ? undefined
          : call?.match(/^page:(v[12]):(\d+):(\d+):([a-f0-9]{24})$/)
        const offset = Number(cursor?.[3] ?? 0)
        // Provider call ids and plugin tool names are source text too, not app metadata. A stored
        // quoted result is paged from its original, so the page quotes it once, by its offsets.
        const payload = (s: (typeof steps)[number], legacy: boolean) => {
          const result = s.result ?? "(no result)"
          return `${JSON.stringify({ call: s.id, tool: s.tool })}\n${JSON.stringify(s.args)}\n${legacy ? result : toolDataBody(result)}`
        }
        const fingerprint = (s: (typeof steps)[number], content: string) =>
          createHash("sha256")
            .update(
              JSON.stringify([
                context.userId,
                context.chatId,
                context.forkId,
                version?.id ?? context.rolloutId,
                s.n,
                s.id,
                s.tool,
                content
              ])
            )
            .digest("hex")
            .slice(0, 24)
        const cursorStep = cursor && steps.find((s) => s.n === Number(cursor[2]))
        // For a time v1 was also emitted for decoded bodies. The digest identifies which was paged.
        const legacy =
          cursor?.[1] === "v1" && !!cursorStep && fingerprint(cursorStep, payload(cursorStep, true)) === cursor[4]
        const pageVersion = legacy ? "v1" : "v2"
        const chosen = steps.filter(
          (s) =>
            s.n >= from_step &&
            (cursor ? s.n === Number(cursor[2]) : call === undefined || s.id === call) &&
            words.every((w) => payload(s, legacy).toLowerCase().includes(w))
        )
        if (chosen.length === 0)
          return { text: `No step of message ${message} matches (it has ${steps.length}).`, isError: true }
        if (cursor) {
          const first = chosen[0]!
          const content = payload(first, legacy)
          if (fingerprint(first, content) !== cursor[4] || !Number.isSafeInteger(offset) || offset >= content.length)
            return {
              text: "That result page is unavailable. Read the step again without its page cursor.",
              isError: true
            }
        }
        // Identities, counts, offsets and recovery directions are app-owned framing. A
        // response can hold several complete steps, then a page within one large step.
        const limit = Math.min(TOOL_RESULT_CHARS, max_tokens * 4)
        const prepared = new Map<number, { content: string; stamp: string }>()
        const renderPage = (budget: number) => {
          const shown: Array<string> = []
          let used = 0
          for (const [i, step] of chosen.entries()) {
            let original = prepared.get(step.n)
            if (original === undefined) {
              const content = payload(step, legacy)
              original = { content, stamp: fingerprint(step, content) }
              prepared.set(step.n, original)
            }
            const { content, stamp } = original
            const frame = `<step n="${step.n}"${step.status === "error" ? ' failed="true"' : ""} offset="${offset}" total_characters="${content.length}" />`
            const next = chosen[i + 1]?.n ?? (cursor ? steps.find((s) => s.n > step.n)?.n : undefined)
            const following =
              next === undefined ? "" : `\n[More steps: read_run with message ${message} and from_step=${next}.]`
            const page = toolDataPage(content, {
              offset,
              limit: Math.min(limit, budget) - used - following.length,
              frame,
              notice: i === 0,
              minimumProgress: i === 0,
              more: (end) =>
                `[Result continues: read_run with message ${message} and call "page:${pageVersion}:${step.n}:${end}:${stamp}"; keep query and from_step unchanged.]`
            })
            if (!page.text || page.end === offset) {
              shown.push(`[More steps: read_run with message ${message} and from_step=${step.n}.]`)
              break
            }
            shown.push(page.text)
            used += page.text.length + 1
            if (page.end < content.length) {
              if (following) shown.push(following.trimStart())
              break
            }
            if (cursor && following) shown.push(following.trimStart())
          }
          return shown.join("\n")
        }
        return { text: renderPage(limit), dataOnly: true as const, renderPage }
      })
    )
}

export const runTools: ReadonlyArray<RolloutTool<never>> = [readRun] as unknown as ReadonlyArray<RolloutTool<never>>

/** The history tools a workshop offers, in order (WORKSHOP-CONTEXT §3.3). */
export const WORKSHOP_HISTORY_TOOLS: ReadonlyArray<string> = [
  "search_chat",
  "read_messages",
  "expand_summary",
  "search_summaries",
  "read_run"
]

/** Workshop wording for the story history tools: the same reads over this conversation. */
const WORKSHOP_WORDING: Readonly<Record<string, { readonly description: string; readonly explanation: string }>> = {
  search_chat: {
    explanation: "Search this conversation's earlier messages",
    description:
      "Searches this conversation's earlier messages for words, newest first, and returns short excerpts with their message numbers. Use it to find when something was said or done, then read_messages or read_run. Don't use it for what's already in front of you."
  },
  read_messages: {
    explanation: "Read earlier messages in full",
    description:
      "Reads earlier messages of this conversation verbatim, from a message number on. Use it after search_chat or expand_summary to read a passage in full."
  },
  expand_summary: {
    explanation: "Open a summary for more detail",
    description:
      "Opens a summary of earlier parts of this conversation, named by the messages it covers (its from and to): a first-level summary gives its messages, a higher one the summaries it condenses. Use it when a summary leaves out a detail you need."
  },
  search_summaries: {
    explanation: "Search the summaries",
    description:
      "Searches the summaries of earlier parts of this conversation for words, and returns which messages each match covers. Use it to find roughly when something was done, then expand_summary, read_messages or read_run."
  }
}

/** `workshop:<id>` variants (`kindTools`): same execution, workshop wording. */
export const workshopHistoryVariants = historyTools.flatMap((tool) => {
  const wording = WORKSHOP_WORDING[tool.id]
  return wording
    ? [
        {
          id: `workshop:${tool.id}`,
          tool: {
            ...tool,
            ...wording,
            storyRead: "conversation" as const,
            ...(tool.id === "expand_summary"
              ? {
                  execute: (context: ToolContext, args: never) =>
                    Effect.gen(function* () {
                      const asked = args as { messages: string; max_tokens?: number }
                      if (asked.messages.startsWith("run:")) {
                        const transcript = context.transcript?.() ?? []
                        const summary = activeRunSummaries(transcript).find((s) => `run:${s.id}` === asked.messages)
                        if (!summary) return { text: "That summary isn't in this run.", isError: true }
                        const before = placedSteps(
                          transcript.slice(0, summary.from),
                          context.offer?.tools ?? [],
                          false
                        ).filter(({ step }) => step.kind === "tool").length
                        return yield* readRun.execute(
                          { ...context, transcript: () => transcript.slice(0, summary.through) },
                          {
                            message: 0,
                            from_step: before + 1,
                            ...(asked.max_tokens === undefined ? {} : { max_tokens: asked.max_tokens })
                          }
                        )
                      }
                      const result = yield* tool.execute(context, args)
                      const numbers = asked.messages.match(/^\s*(\d+)\s*[–-]\s*(\d+)\s*$/)
                      if (!numbers || result.isError || result.text.includes("<summary")) return result
                      const parts: Array<string> = [result.text]
                      let used = tokensOf(result.text)
                      const cap = asked.max_tokens ?? 2000
                      for (let n = Number(numbers[1]); n <= Number(numbers[2]) && used < cap; n++) {
                        const steps = yield* readRun.execute(context, {
                          message: n,
                          max_tokens: Math.max(200, cap - used)
                        })
                        if (!steps.isError && steps.text.includes("<step")) {
                          parts.push(steps.text)
                          used += tokensOf(steps.text)
                        }
                      }
                      return { text: parts.join("\n\n") }
                    })
                }
              : {}),
            ...(tool.id === "search_summaries"
              ? {
                  execute: (context: ToolContext, args: never) =>
                    Effect.gen(function* () {
                      const result = yield* tool.execute(context, args)
                      const words = (args as { query: string }).query.toLowerCase().split(/\s+/).filter(Boolean)
                      const found = activeRunSummaries(context.transcript?.() ?? []).filter((s) =>
                        words.every((w) => s.content.toLowerCase().includes(w))
                      )
                      return {
                        ...result,
                        text: [
                          result.text,
                          ...found.map((s) => `<summary messages="run:${s.id}">\n${s.content}\n</summary>`)
                        ].join("\n")
                      }
                    })
                }
              : {})
          }
        }
      ]
    : []
})
