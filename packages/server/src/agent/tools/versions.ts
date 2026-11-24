// The assistant's version tools (spec/WORKSHOP-CARDS.md §9, unit C9), beside the built
// list_revisions and restore_revision: read_revision (git show) and diff_revisions (git diff).
// revert_change (git revert) writes, so it's with the other write tools in setup.ts. All take an
// item by kind and name or id, and a revision by number (as list_revisions numbers them), id or
// "latest". They're loaded with the Versions skill, so the immediate tool list doesn't grow.
import { Type } from "@earendil-works/pi-ai"
import type { LibraryRef, Revision, RevisionId } from "@dreamspan/shared/library.ts"
import { unifiedDiff } from "@dreamspan/shared/unifiedDiff.ts"
import { Effect } from "effect"
import { documentDiff } from "../../db/agentDocuments.ts"
import { type CountEffect, estimateCount, pageEnd, pageTokens, visibleDoc } from "../libraryView.ts"
import { toolResultFrame } from "../toolData.ts"
import type { RolloutTool, ToolContext } from "../tools.ts"
import { pagedView, resolveLibrary, VIEWS, viewHelp } from "./library.ts"

type Kind = "card" | "preset" | "lorebook"
const KINDS = Type.Union([Type.Literal("card"), Type.Literal("preset"), Type.Literal("lorebook")])
const item = Type.String({ minLength: 1, maxLength: 200, description: "The item's name or id." })
const revisionArg = (description: string) => Type.String({ minLength: 1, maxLength: 100, description })
const HISTORY_PAGE_SIZE = 500

/** The ref's revision a tool names: "latest", a number from list_revisions (also "#3"), or an id. */
export const findRevision = (ctx: ToolContext, ref: LibraryRef, wanted: string) =>
  Effect.gen(function* () {
    const target = wanted.trim().toLowerCase()
    const number = /^#?(\d+)$/.exec(target)?.[1]
    const id = target === "latest" ? ref.headRevisionId : wanted.trim()
    let before: RevisionId | undefined
    for (;;) {
      const revisions: ReadonlyArray<Revision> = yield* ctx.reader.RefHistory({
        userId: ctx.userId,
        refId: ref.id,
        limit: HISTORY_PAGE_SIZE,
        ...(before ? { before } : {})
      })
      const found = revisions.find((r) => (number !== undefined ? r.number === Number(number) : r.id === id))
      if (found) return { revision: found }
      if (revisions.length < HISTORY_PAGE_SIZE) break
      before = revisions.at(-1)!.id
    }
    return { error: `${ref.label} has no revision ${wanted}. Use list_revisions to see its revisions.` }
  })

const count = (ctx: ToolContext): CountEffect =>
  ctx.countTokens
    ? (text) => ctx.countTokens!(text).pipe(Effect.orElseSucceed(() => Math.ceil(text.length / 4)))
    : estimateCount

const failRead = (error: unknown) =>
  Effect.logWarning("Workshop revision read failed", error).pipe(
    Effect.as({
      text: "That revision could not be read. Check the item and revision with list_revisions.",
      isError: true
    })
  )

/** A revision as the tools name it: its number, id and message. */
const named = (revision: Revision) => ({
  revision: revision.id,
  ...(revision.number === undefined ? {} : { number: revision.number }),
  ...(revision.message ? { message: revision.message } : {}),
  created: new Date(revision.createdAt).toISOString()
})

const readRevision: RolloutTool<Readonly<Record<string, unknown>>> = {
  source: import.meta.url,
  id: "read_revision",
  storyRead: "library",
  label: "Read a revision",
  explanation: "Read a library item as it was at an earlier revision.",
  effect: "read",
  capability: "library.read",
  description: `Reads a card, preset or lorebook as it was at one revision (as git show): by number from list_revisions, id, or latest. fields picks a card's fields. Read like read_card, read_preset and read_lorebook, whole when that fits, otherwise in pages. ${viewHelp.card}`,
  parameters: Type.Object({
    kind: KINDS,
    item,
    revision: revisionArg("The revision: its number from list_revisions, its id, or latest."),
    fields: Type.Optional(Type.Array(Type.String())),
    view: Type.Optional(Type.Union(VIEWS.map((view) => Type.Literal(view)))),
    field: Type.Optional(Type.String({ description: "For view field: the field, such as description." })),
    greeting: Type.Optional(Type.Integer({ minimum: 1, description: "For field alternate_greetings: which, from 1." })),
    entry: Type.Optional(Type.Union([Type.Integer(), Type.String()], { description: "For view entry: its uid." })),
    prompt: Type.Optional(Type.String({ description: "For view prompt: its identifier." })),
    offset: Type.Optional(Type.Integer({ minimum: 0, description: "Where a page starts, in characters." })),
    max_tokens: Type.Optional(Type.Integer({ minimum: 200, maximum: 8000 })),
    after: Type.Optional(
      Type.Union([Type.Integer(), Type.String()], { description: "For view index: the last uid or identifier read." })
    )
  }),
  summarize: (args) => `${String(args.item)}, revision ${String(args.revision)}`,
  execute: (ctx, args) =>
    Effect.gen(function* () {
      const kind = args.kind as Kind
      const resolved = yield* resolveLibrary(ctx, kind, String(args.item))
      if ("error" in resolved) return { text: resolved.error, isError: true }
      const found = yield* findRevision(ctx, resolved.ref, String(args.revision))
      if ("error" in found) return { text: found.error, isError: true }
      const doc = yield* ctx.reader.GetRevisionDoc({
        userId: ctx.userId,
        refId: resolved.ref.id,
        revisionId: found.revision.id
      })
      const visible = visibleDoc(kind, doc)
      const fields = args.fields as ReadonlyArray<string> | undefined
      const shown =
        kind === "card" && fields
          ? Object.fromEntries(Object.entries(visible).filter(([key]) => fields.includes(key)))
          : visible
      const number = found.revision.number === undefined ? "" : ` number ${found.revision.number}`
      const message = found.revision.message ? `, message ${JSON.stringify(found.revision.message)}` : ""
      const head = `${kind} "${resolved.ref.label}" (id ${resolved.ref.id}) at revision ${found.revision.id}${number}${message}`
      const frame = toolResultFrame({
        id: resolved.ref.id,
        entityId: resolved.ref.entityId,
        revision: found.revision.id
      })
      const viewed = yield* pagedView(kind, visible, shown, head, args, count(ctx), ctx.window)
      if (viewed !== null) return { frame, ...viewed }
      return {
        frame,
        text: JSON.stringify({ id: resolved.ref.id, name: resolved.ref.label, ...named(found.revision), doc: shown })
      }
    }).pipe(Effect.catch(failRead))
}

/** The top-level field a diff path is in: `entries["3"].content` is in entries. */
const topField = (path: string) => /^[^[.:\s]+/.exec(path)?.[0] ?? path

/** One field's difference as the assistant reads it: prose as a unified diff, settings in words. */
const section = (change: ReturnType<typeof documentDiff>[number]) => {
  if (change.beforeAbsent) return `${change.field}: added\n${change.after}`
  if (change.afterAbsent) return `${change.field}: removed (it was:)\n${change.before}`
  const prose =
    change.before.includes("\n") || change.after.includes("\n") || change.before.length + change.after.length > 160
  return prose
    ? `${change.field}:\n${unifiedDiff(change.before, change.after)}`
    : `${change.field}: ${change.before} → ${change.after}`
}

const diffRevisions: RolloutTool<{
  readonly kind: Kind
  readonly item: string
  readonly from: string
  readonly to?: string
  readonly fields?: ReadonlyArray<string>
  readonly max_tokens?: number
  readonly cursor?: string
}> = {
  source: import.meta.url,
  id: "diff_revisions",
  storyRead: "library",
  label: "Compared revisions",
  explanation: "Compare two revisions of a library item.",
  effect: "read",
  capability: "library.read",
  description:
    "Shows what changed in a card, preset or lorebook between two revisions (as git diff): from, and to (default: the saved item now; unsaved drafts aren't included), each a number from list_revisions, an id, or latest. Prose comes as a unified diff (- taken out, + put in), lorebook entries and preset prompts by their uid or identifier, settings as before → after. fields limits it to some fields. If the result ends with a cursor, repeat the request with that cursor and the same fields to read on.",
  parameters: Type.Object({
    kind: KINDS,
    item,
    from: revisionArg("The earlier revision: number, id or latest."),
    to: Type.Optional(revisionArg("The later revision; the saved item now when left out.")),
    fields: Type.Optional(Type.Array(Type.String())),
    max_tokens: Type.Optional(Type.Integer({ minimum: 200, maximum: 8000 })),
    cursor: Type.Optional(Type.String({ maxLength: 224, description: "The cursor returned on the previous page." }))
  }),
  summarize: (args) => `${args.item}: ${args.from} → ${args.to ?? "now"}`,
  execute: (ctx, args) =>
    Effect.gen(function* () {
      const resolved = yield* resolveLibrary(ctx, args.kind, args.item)
      if ("error" in resolved) return { text: resolved.error, isError: true }
      const ref = resolved.ref
      const invalidCursor = { text: "Use the cursor from the previous diff page with the same fields.", isError: true }
      const cursor = /^([\w-]{1,100}):([\w-]{1,100}):(\d{1,9}):(\d{1,9})$/.exec(args.cursor ?? "")
      if (args.cursor !== undefined && cursor === null) return invalidCursor
      const from = yield* findRevision(ctx, ref, cursor?.[1] ?? args.from)
      if ("error" in from) return { text: from.error, isError: true }
      const wantedTo = cursor?.[2] ?? args.to
      const to = wantedTo === undefined ? null : yield* findRevision(ctx, ref, wantedTo)
      if (to !== null && "error" in to) return { text: to.error, isError: true }
      const toId = to?.revision.id ?? ref.headRevisionId
      const read = (revisionId: RevisionId) =>
        ctx.reader.GetRevisionDoc({ userId: ctx.userId, refId: ref.id, revisionId })
      const before = visibleDoc(args.kind, yield* read(from.revision.id))
      const after = visibleDoc(args.kind, yield* read(toId))
      const changes = documentDiff(before, after).filter(
        (c) => args.fields === undefined || args.fields.includes(topField(c.field))
      )
      const head = `${args.kind} "${ref.label}" (id ${ref.id}): revision ${from.revision.number ?? from.revision.id} → ${to === null ? "now" : (to.revision.number ?? to.revision.id)}`
      const start = Number(cursor?.[3] ?? 0)
      if (cursor && start >= changes.length) return invalidCursor
      const budget = pageTokens(args.max_tokens)
      const counter = count(ctx)
      const tooSmall = "The token limit is too small to show this diff."
      const tooSmallResult = () =>
        Effect.map(counter(tooSmall), (size) => ({ text: size <= budget ? tooSmall : "", isError: true }))
      if (changes.length === 0) {
        const noDiff = `No differences${args.fields ? " in those fields" : ""}.`
        const page = `${head}\n${noDiff}`
        if ((yield* counter(page)) <= budget) return { text: page }
        if ((yield* counter(noDiff)) <= budget) return { text: noDiff }
        return yield* tooSmallResult()
      }
      const footer = (at: number, offset: number) =>
        at < changes.length ? `[Continue with cursor="${from.revision.id}:${toId}:${at}:${offset}"]` : ""
      let heading = cursor ? "" : head
      const render = (parts: ReadonlyArray<string>, next: string) =>
        [heading, ...parts, next].filter(Boolean).join("\n\n")
      const shown: Array<string> = []
      let page = ""
      for (let at = start; at < changes.length; at++) {
        const offset = at === start ? Number(cursor?.[4] ?? 0) : 0
        const current = section(changes[at]!)
        if (offset >= current.length) return invalidCursor
        const text = current.slice(offset)
        const next = footer(at + 1, 0)
        const candidate = render([...shown, text], next)
        if ((yield* counter(candidate)) <= budget) {
          shown.push(text)
          page = candidate
          continue
        }
        if (page) return { text: page }

        // Choose the end against the exact rendering, with its continuation on the same page.
        const renderCut = (body: string) =>
          render([body], body.length === text.length ? next : footer(at, offset + body.length))
        const first = String.fromCodePoint(text.codePointAt(0)!)
        if ((yield* counter(renderCut(first))) > budget) heading = ""
        let end = yield* pageEnd(current, offset, budget, (body) => counter(renderCut(body)))
        if (end < current.length && (current.codePointAt(end - 1) ?? 0) > 0xffff) end--
        const partial = renderCut(current.slice(offset, Math.max(end, offset + first.length)))
        if ((yield* counter(partial)) <= budget) return { text: partial }
        const minimum = renderCut(first)
        if ((yield* counter(minimum)) <= budget) return { text: minimum }
        return yield* tooSmallResult()
      }
      return { text: page }
    }).pipe(Effect.catch(failRead))
}

export const versionTools: ReadonlyArray<RolloutTool<never>> = [readRevision, diffRevisions].map((tool) => ({
  ...(tool as RolloutTool<never>),
  replyTool: false as const
}))
