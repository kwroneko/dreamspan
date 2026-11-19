import { chatKinds } from "@dreamspan/shared/chatKinds.ts"
// "Merge another chat into this one" (spec/CHAT-MERGE.md §7; owner decisions DESIGN §3.3,
// 2026-11-05). One dialog for both entry points, the ⋯ menu (after the newest message) and a
// message's actions (after that message): pick the chat or branch to bring in, see what comes in
// and how the model will read it, and merge. Nothing is sent to a model here; the preview is
// computed by the server from what's stored. Its thread mode (spec/THREADS.md §7.1, "Join
// threads") takes its sources from a picker the threads feature passes, several at once.
import type { ChatId, EntityId, Fork, ForkId, PathEntry, SlotId } from "@dreamspan/shared/chat.ts"
import {
  type ChatMergePreview,
  fillMergeTemplate,
  MERGE_BLOCK_SECTION_DEFAULT,
  MERGE_SECTION_DEFAULT,
  type MergeNote,
  type MergeTimelines
} from "@dreamspan/shared/mergeApi.ts"
import { usePlaceParam } from "../../usePlaceParam.ts"
import { useChatPlaceKey } from "./chatPlace.ts"
import { useNavigate } from "@tanstack/react-router"
import { type ComponentType, useEffect, useMemo, useState, useSyncExternalStore } from "react"
import { ErrorAlert, useAction } from "../../actions.tsx"
import type { AppError } from "../../errors.ts"
import { Button } from "../../ui/Button.tsx"
import { Checkbox, RadioGroup, Switch } from "../../ui/Choice.tsx"
import { Dialog, DialogActions } from "../../ui/Dialog.tsx"
import { Field, Input, Textarea } from "../../ui/Field.tsx"
import { Select } from "../../ui/Select.tsx"
import { Spinner } from "../../ui/Spinner.tsx"
import { Alert } from "../../ui/Surface.tsx"
import { showToast } from "../../ui/Toast.tsx"
import { Tooltip } from "../../ui/Tooltip.tsx"
import { useCast } from "./cast.ts"
import type { ChatCommandDialogProps } from "./commands.tsx"
import { branchLabel, forksChanged } from "./forks.ts"
import type { MessageActionProps } from "./messageActions.tsx"
import { positionOf } from "./position.ts"
import type { ChatSession } from "./session.ts"
import { useSplitChats } from "./splitChats.ts"

const NEWEST = "newest"
const AT_JOIN = "join"

const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString()} ${n === 1 ? one : many}`
const firstWords = (text: string) => {
  const line = text.replace(/\s+/g, " ").trim()
  return line.length > 48 ? `${line.slice(0, 47)}…` : line
}

/** What comes in, in one line: "Shares #1–86 · merges 54 messages from #87". */
const relation = (preview: ChatMergePreview) =>
  preview.continues
    ? `Merged before · ${plural(preview.messages, "new message")} since then, from #${preview.from}`
    : preview.shared > 0
      ? `Shares #1–${preview.shared} · merges ${plural(preview.messages, "message")} from #${preview.from}`
      : `Merges ${plural(preview.messages, "message")}`

/** A thread's part in one line: "Joins 10 messages since #40", or "3 new since the last join". */
const joined = (preview: ChatMergePreview) =>
  preview.thread !== true
    ? relation(preview)
    : preview.continues
      ? `${plural(preview.messages, "new message")} since the last join`
      : `Joins ${plural(preview.messages, "message")} since #${preview.from - 1}`

const nameList = (names: ReadonlyArray<string>) =>
  names.length <= 1 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)!}`

/** Which replies will read a note brought by the merge, in one line. */
const noteReaders = (note: MergeNote) => {
  const card = note.card ?? "its character"
  switch (note.when) {
    case "moved":
      return `Only ${card}'s own replies read the moved passage; every reply reads the rest of the field.`
    case "own_turn":
      return `Only ${card}'s own replies read it.`
    case "turn":
      return `Only replies by ${nameList(note.names)} read it.`
    case "not_muted":
      return `Every reply reads it while ${note.names.length > 1 ? "one of " : ""}${nameList(note.names)} isn't muted, this chat's characters' too.`
    default:
      return note.kind === "card"
        ? `Every reply reads it while ${card} is in this chat, this chat's characters' too.`
        : "Every reply reads it, this chat's characters' too."
  }
}

/** The cast after every source joins: each member once, added if any source adds it. */
const unionCast = (previews: ReadonlyArray<ChatMergePreview>) => {
  const members = new Map<string, ChatMergePreview["cast"][number]>()
  for (const one of previews)
    for (const member of one.cast) {
      const seen = members.get(member.entity)
      if (!seen || (!seen.added && member.added)) members.set(member.entity, member)
    }
  return [...members.values()]
}

/**
 * A chat to merge, as the chat list shows it: a chat made from a branch ("Make this branch its
 * own chat") is listed under its own name, apart from the chat it came from.
 */
export interface MergeSource {
  /** The chat that stores its messages. */
  readonly chat: ChatId
  /** The chat as listed: `chat`, or the branch it was made from for a split-off chat. */
  readonly listed: ChatId
  readonly title: string
  readonly fork: ForkId
}

/** What a thread mode's picker gets: the dialog's position and what's ticked. */
export interface MergeSourcePickerProps {
  readonly session: ChatSession
  readonly forkId: ForkId
  readonly at: SlotId | null
  readonly chosen: ReadonlyArray<MergeSource>
  readonly onChoose: (next: ReadonlyArray<MergeSource>) => void
}

function SourcePicker({
  chatId,
  forkId,
  chosen,
  onChoose
}: {
  chatId: ChatId
  forkId: ForkId | null
  chosen: MergeSource | null
  onChoose: (next: MergeSource) => void
}) {
  const [search, setSearch] = useState("")
  const [chats, setChats] = useState<ReadonlyArray<MergeSource> | null>(null)
  const [listed, setListed] = useState<{ fork: ForkId; forks: ReadonlyArray<Fork> } | null>(null)
  const reader = useAction()
  const forksReader = useAction()
  const thisChat = useSplitChats(chatId, forkId)?.group.id ?? chatId
  useEffect(() => {
    let live = true
    const query = search.trim()
    const timer = setTimeout(
      () =>
        void reader
          .run((client) =>
            client("GetShellForks", {
              entity: null,
              chat: null,
              search: query.slice(0, 200),
              sort: "recent",
              sections: [{ id: "chats", limit: 30 }]
            })
          )
          .then((result) => {
            if (live && result.ok)
              setChats(
                (result.value.sections[0]?.rows ?? [])
                  .filter((row) => chatKinds.get(row.chat.kind)?.allowsMerge === true)
                  .map((row) => ({
                    chat: row.sourceChatId ?? row.chat.id,
                    listed: row.chat.id,
                    title: row.chatName,
                    fork: row.forkId as ForkId
                  }))
              )
          }),
      query === "" ? 0 : 250
    )
    return () => {
      live = false
      clearTimeout(timer)
    }
    // `reader` is a fresh object each render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search])
  /** The branches of `source`'s chat as listed (a split-off chat's own), this branch left out. */
  const branchesOf = async (source: MergeSource) => {
    const all = await forksReader.run((client) => client("ListForks", { chatId: source.chat }))
    const split = await forksReader.run((client) =>
      client("GetSplitChats", { chatId: source.chat, forkId: source.fork })
    )
    if (!all.ok) return null
    const own = split.ok ? new Set<string>(split.value.forkIds) : null
    return all.value.filter((f) => (own === null || own.has(f.id)) && f.id !== forkId)
  }
  const chosenKey = chosen === null ? null : `${chosen.listed} ${chosen.fork}`
  useEffect(() => {
    if (chosen === null) return
    let live = true
    void branchesOf(chosen).then((forks) => {
      if (live && forks !== null) setListed({ fork: chosen.fork, forks })
    })
    return () => {
      live = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chosenKey])
  const forks = listed !== null && chosen !== null && listed.fork === chosen.fork ? listed.forks : null
  const pick = (source: MergeSource) => {
    // This chat's own branch can't be merged into itself: its newest other branch instead.
    if (source.fork !== forkId) onChoose(source)
    else
      void branchesOf(source).then((others) => {
        const other = [...(others ?? [])].sort((a, b) => (b.endAt ?? b.createdAt) - (a.endAt ?? a.createdAt))[0]
        if (other) onChoose({ ...source, fork: other.id })
        else showToast({ title: "This chat has no other branch to merge" })
      })
  }
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <Field label="Chat to merge" description="This chat's other branches are listed too.">
        <Input
          type="search"
          value={search}
          placeholder="Search by title or character"
          onChange={(event) => setSearch(event.currentTarget.value)}
        />
      </Field>
      <ul
        aria-label="Chats"
        className="flex max-h-48 min-w-0 flex-col gap-0.5 overflow-y-auto rounded-md border border-border p-2"
      >
        {chats === null && (
          <li className="flex items-center gap-2 p-2 text-sm text-muted">
            <Spinner /> Loading chats…
          </li>
        )}
        {chats?.length === 0 && <li className="p-2 text-sm text-muted">No chats match.</li>}
        {chats?.map((chat) => (
          <li key={chat.listed}>
            <Tooltip label={chat.listed === thisChat ? "Merge another branch of this chat." : `Merge “${chat.title}”.`}>
              <button
                type="button"
                aria-pressed={chosen?.listed === chat.listed}
                onClick={() => pick(chat)}
                className="flex w-full min-w-0 items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left text-sm outline-none hover:bg-hover focus-visible:ring-2 focus-visible:ring-focus aria-pressed:bg-surface-raised aria-pressed:font-medium"
              >
                <span data-layout-name className="min-w-0 truncate">
                  {chat.title || "Untitled chat"}
                </span>
                {chat.listed === thisChat && <span className="shrink-0 text-xs text-muted">This chat</span>}
              </button>
            </Tooltip>
          </li>
        ))}
      </ul>
      {chosen && forks !== null && forks.length > 1 && (
        <Field label="Branch">
          <Select
            value={chosen.fork}
            onValueChange={(fork) => onChoose({ ...chosen, fork })}
            items={forks.map((fork) => ({ value: fork.id, label: branchLabel(fork) }))}
          />
        </Field>
      )}
    </div>
  )
}

interface MergeSetup {
  sources?: ReadonlyArray<MergeSource>
  at?: SlotId | null
  start?: SlotId | null
  includeLeftOut?: boolean
  timelines?: MergeTimelines
  notes?: ReadonlyArray<string>
  reader?: EntityId | null
}

const readSetup = (raw: string): MergeSetup => {
  try {
    const value = JSON.parse(raw) as MergeSetup
    if (!value || typeof value !== "object") return {}
    return {
      sources: Array.isArray(value.sources)
        ? value.sources
            .filter(
              (s) =>
                s &&
                typeof s.chat === "string" &&
                typeof s.listed === "string" &&
                typeof s.fork === "string" &&
                typeof s.title === "string"
            )
            .slice(0, 32)
        : [],
      ...(typeof value.at === "string" || value.at === null ? { at: value.at } : {}),
      ...(typeof value.start === "string" || value.start === null ? { start: value.start } : {}),
      includeLeftOut: value.includeLeftOut === true,
      timelines: value.timelines === "separate" ? "separate" : "together",
      notes: Array.isArray(value.notes) ? value.notes.filter((n) => typeof n === "string").slice(0, 500) : [],
      reader: typeof value.reader === "string" ? value.reader : null
    }
  } catch {
    return {}
  }
}

export function MergeChatDialog({
  session,
  at: initialAt,
  onClose: finishClose,
  threads: ThreadPicker
}: {
  session: ChatSession
  /** The message to merge after; null: the newest. */
  at: SlotId | null
  onClose: () => void
  /** Thread mode: other threads of this branch, from this picker, joined (`JoinThreads`). */
  threads?: ComponentType<MergeSourcePickerProps>
}) {
  const view = useSyncExternalStore(session.subscribe, session.snapshot)
  const { cast } = useCast()
  const navigate = useNavigate()
  const [forkId] = useState(() => view.forkId ?? view.chat?.currentForkId ?? null)
  const [saved, setSaved] = usePlaceParam(useChatPlaceKey("mergeSetup"), "")
  const setup = useMemo(() => readSetup(saved), [saved])
  const changeSetup = (next: Partial<MergeSetup>) => setSaved(JSON.stringify({ ...setup, ...next }), true)
  const onClose = () => {
    setSaved("", true)
    finishClose()
  }
  const sourceKey = JSON.stringify(setup.sources ?? [])
  const sources = useMemo(() => JSON.parse(sourceKey) as ReadonlyArray<MergeSource>, [sourceKey])
  const setSources = (next: ReadonlyArray<MergeSource>) => changeSetup({ sources: next })
  const source = sources[0] ?? null
  const joining = ThreadPicker !== undefined
  const at = setup.at === undefined ? initialAt : setup.at
  const setAt = (next: SlotId | null) => changeSetup({ at: next })
  const start = setup.start ?? null
  const setStart = (next: SlotId | null) => changeSetup({ start: next })
  const includeLeftOut = setup.includeLeftOut ?? false
  const setIncludeLeftOut = (next: boolean) => changeSetup({ includeLeftOut: next })
  /** How the characters see a join, in a chat with one shared context (spec/THREADS.md §7.1). */
  const timelines = setup.timelines ?? "together"
  const setTimelines = (next: MergeTimelines) => changeSetup({ timelines: next })
  /** Each source's preview, in order, once all are read. */
  const [read, setRead] = useState<{ readonly for: unknown; readonly previews: ReadonlyArray<ChatMergePreview> }>({
    for: null,
    previews: []
  })
  const [previewError, setPreviewError] = useState<AppError | null>(null)
  /** "What the model reads" for one character, with separate timelines; null: the first. */
  const reader_ = setup.reader ?? null
  const setReaderFor = (next: EntityId | null) => changeSetup({ reader: next })
  /** null: the source's own title. */
  const [title, setTitle] = useState<string | null>(null)
  const [framing, setFraming] = useState<string | null>(null)
  const [stale, setStale] = useState(false)
  /** The merged chat's notes ticked to bring (`MergeNote.id`). */
  const ticked = new Set(setup.notes ?? [])
  const setTicked = (next: ReadonlySet<string> | ((was: ReadonlySet<string>) => ReadonlySet<string>)) =>
    changeSetup({ notes: [...(typeof next === "function" ? next(ticked) : next)] })
  const reader = useAction()
  const writer = useAction()

  const requests = useMemo(
    () =>
      forkId
        ? sources.map((one) => ({
            chatId: session.id,
            forkId,
            at,
            source: { chatId: one.chat, forkId: one.fork },
            ...(start === null ? {} : { start }),
            includeLeftOut,
            ...(timelines === "separate" ? { timelines } : {})
          }))
        : [],
    [session.id, forkId, at, sources, start, includeLeftOut, timelines]
  )
  const request = requests[0] ?? null
  const previewAll = () => Promise.all(requests.map((one) => reader.run((client) => client("PreviewChatMerge", one))))
  useEffect(() => {
    if (requests.length === 0) return
    let live = true
    void previewAll().then((results) => {
      if (!live) return
      const failed = results.find((result) => !result.ok)
      setRead({ for: requests, previews: results.flatMap((result) => (result.ok ? [result.value] : [])) })
      setPreviewError(failed && !failed.ok ? failed.error : null)
    })
    return () => {
      live = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requests])
  // Previews read for the sources and span chosen now, all of them.
  const previews = read.for === requests ? read.previews : []
  const complete = requests.length > 0 && previews.length === requests.length && previewError === null
  const preview = complete ? (previews[0] ?? null) : null
  const all = complete ? previews : []
  const several = all.length > 1
  const layout = cast?.mergeLayout ?? "parallel"
  const shownTitle = title?.trim() || preview?.sourceTitle || ""
  const defaultFraming = preview
    ? fillMergeTemplate(
        layout === "join" ? MERGE_BLOCK_SECTION_DEFAULT : MERGE_SECTION_DEFAULT,
        shownTitle,
        preview.castNames
      )
    : ""
  const framingText = framing ?? defaultFraming
  const marker = preview ? preview.join.split(`“${preview.sourceTitle}”`).join(`“${shownTitle}”`) : ""
  const views = preview?.views ?? null
  const readerFor = views === null ? null : (views.find((v) => v.entity === reader_) ?? views[0] ?? null)
  /** One source's part of "What the model reads": its framing, its text (for whom it's read), its marker. */
  const readOf = (one: ChatMergePreview) => {
    const view = readerFor === null ? null : one.views?.find((v) => v.entity === readerFor.entity)
    const text = view === null || view === undefined ? one.section : view.readable ? view.section : null
    return several
      ? [one.framing, text ?? `[Nothing of “${one.sourceTitle}”: ${readerFor?.name ?? "they"} wasn't there.]`, one.join]
      : [framingText.trim(), text ?? `[Nothing of “${shownTitle}”: ${readerFor?.name ?? "they"} wasn't there.]`]
  }
  const leftOut = all.reduce((n, one) => n + one.leftOut, 0)
  const leftOutTokens = all.reduce((n, one) => n + one.leftOutTokens, 0)

  const entries = view.entries.filter((e) => e.version.origin !== "merge")
  const positions = [...entries].reverse().slice(0, 200)
  const positionItems = [
    { value: NEWEST, label: "After the newest message" },
    ...positions.map((entry: PathEntry) => ({
      value: entry.slotId as string,
      label: `After #${positionOf(entry) + 1} · ${firstWords(entry.version.content)}`
    }))
  ]
  const atNumber = preview?.at.number ?? null
  const startItems = [
    {
      value: AT_JOIN,
      label: atNumber === null ? "From the message it follows" : `From #${atNumber}, the message it follows`,
      description: "Only the message it's merged after ran beside it."
    },
    ...positions
      .filter((entry) => atNumber !== null && positionOf(entry) + 1 < atNumber)
      .map((entry) => ({
        value: entry.slotId as string,
        label: `From #${positionOf(entry) + 1} · ${firstWords(entry.version.content)}`
      }))
  ]

  const ownFraming = framing === null || framing.trim() === defaultFraming ? null : framing
  const notes = !joining && !several ? (preview?.notes ?? []) : []
  const brought = notes.filter((note) => note.conflict === null && ticked.has(note.id)).map((note) => note.id)
  const merge = async () => {
    if (!request || !preview || !forkId) return
    const result = joining
      ? await writer.run(
          (client) =>
            client("JoinThreads", {
              chatId: session.id,
              forkId,
              at,
              includeLeftOut,
              ...(timelines === "separate" ? { timelines } : {}),
              joins: all.map((one, index) => ({
                forkId: sources[index]!.fork,
                title: several ? one.sourceTitle : shownTitle,
                framing: several ? null : ownFraming,
                digest: one.digest
              }))
            }),
          ["chats"]
        )
      : await writer.run(
          (client) =>
            client("MergeChat", {
              ...request,
              ...(brought.length > 0 ? { notes: brought } : {}),
              title: shownTitle,
              framing: ownFraming,
              digest: preview.digest
            }),
          ["chats"]
        )
    if (result.ok) {
      // The threads' joined state (ThreadsOf) is read again.
      if (joining) forksChanged(session.id)
      onClose()
      showToast(
        joining
          ? {
              title: several ? `Joined ${all.length} threads` : `Joined “${shownTitle}”`,
              description: "Each is one entry in the timeline; open it to read it."
            }
          : { title: `Merged “${shownTitle}”`, description: "It's one entry in the timeline; open it to read it." }
      )
      return
    }
    if (result.error.tag === "MergeChanged") {
      setStale(true)
      const again = await previewAll()
      if (again.every((one) => one.ok))
        setRead({ for: requests, previews: again.flatMap((one) => (one.ok ? [one.value] : [])) })
    }
  }
  const summarizeFirst = () => {
    const first = sources.find((_, index) => (all[index]?.leftOut ?? 0) > 0) ?? source
    if (!first) return
    onClose()
    void navigate({
      to: "/chats/$chatId",
      params: { chatId: first.chat },
      search: { fork: first.fork, panel: "summaries" }
    })
  }

  return (
    <Dialog
      open
      wide
      placement="top"
      onOpenChange={(open) => !open && !writer.pending && onClose()}
      title={joining ? "Join threads" : "Merge a chat into this one"}
      description={
        joining
          ? "Each thread's messages since they parted join this one as one entry, read by the model as a line that ran alongside. This thread's settings apply; the other threads stay as they are and can be joined again later."
          : "Its messages join this chat as one entry, read by the model as a line that ran alongside. This chat's settings, preset and model apply; the other chat stays as it is."
      }
    >
      <div className="grid min-w-0 gap-4 sm:grid-cols-2">
        <div className="flex min-w-0 flex-col gap-4">
          {forkId && ThreadPicker && (
            <ThreadPicker
              session={session}
              forkId={forkId}
              at={at}
              chosen={sources}
              onChoose={(next) => {
                setStale(false)
                setTitle(null)
                setFraming(null)
                setSources(next)
              }}
            />
          )}
          {forkId && !ThreadPicker && (
            <SourcePicker
              chatId={session.id}
              forkId={forkId}
              chosen={source}
              onChoose={(next) => {
                // A new source: its own title, the default framing line and span again.
                setStale(false)
                setTitle(null)
                setFraming(null)
                changeSetup({ sources: [next], start: null, includeLeftOut: false, notes: [], reader: null })
              }}
            />
          )}
          <Field label={joining ? "Join after" : "Merge after"}>
            <Select
              value={at ?? NEWEST}
              onValueChange={(value) => setAt(value === NEWEST ? null : (value as SlotId))}
              items={positionItems}
            />
          </Field>
          {preview && !preview.sameChat && !preview.continues && (
            <Field
              label="It ran alongside"
              about="Where this chat's own messages start running at the same time as the merged chat's. The model reads the merged chat's messages before them."
            >
              <Select
                value={start ?? AT_JOIN}
                onValueChange={(value) => setStart(value === AT_JOIN ? null : (value as SlotId))}
                items={startItems}
              />
            </Field>
          )}
        </div>
        <div className="flex min-w-0 flex-col gap-4">
          {source === null && (
            <p className="text-sm text-muted">
              {joining ? "Choose a thread to see what it brings in." : "Choose a chat to see what it brings in."}
            </p>
          )}
          {previewError && <ErrorAlert error={previewError} title={joining ? "Can't join this" : "Can't merge this"} />}
          {source && !preview && !previewError && (
            <p className="flex items-center gap-2 text-sm text-muted">
              <Spinner /> Reading “{source.title}”…
            </p>
          )}
          {preview && (
            <>
              {all.map((one) => (
                <section
                  key={one.sourceTitle + one.digest}
                  aria-label={several ? `What comes in from “${one.sourceTitle}”` : "What comes in"}
                  className="flex flex-col gap-1 text-sm"
                >
                  <p className="font-medium" data-testid="merge-relation">
                    {several ? `“${one.sourceTitle}”: ` : ""}
                    {joined(one)}
                  </p>
                  <p className="text-muted">
                    {[
                      one.verbatim > 0 && `${plural(one.verbatim, "message")} as written`,
                      one.summarized > 0 &&
                        `${plural(one.summarized, "message")} through ${plural(one.summaries, "summary", "summaries")}`,
                      one.leftOut > 0 && !includeLeftOut && `${plural(one.leftOut, "message")} left out`
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                    {` · about ${one.tokens.toLocaleString()} tokens`}
                  </p>
                </section>
              ))}
              {leftOut > 0 && (
                <Alert
                  tone="warning"
                  title={includeLeftOut ? "Older messages included as written" : "Older messages left out"}
                  actions={
                    <Button
                      hint="Opens the other chat's summaries, to summarize these messages there. Nothing is sent until you start it."
                      onClick={summarizeFirst}
                    >
                      Summarize there first
                    </Button>
                  }
                >
                  {plural(leftOut, "older message")} (about {leftOutTokens.toLocaleString()} tokens) have no summary in
                  the other {joining ? "thread" : "chat"}, and this {joining ? "thread" : "chat"}'s recent stretch is
                  about {preview.spanTokens.toLocaleString()} tokens.
                </Alert>
              )}
              {leftOut > 0 && (
                <Switch
                  checked={includeLeftOut}
                  onCheckedChange={setIncludeLeftOut}
                  hint={
                    includeLeftOut
                      ? "Click to leave the older messages out."
                      : "Click to include the older messages as written."
                  }
                >
                  Include them as written
                </Switch>
              )}
              {preview.rewrites && (
                <p className="text-sm text-muted">
                  The summary of #{preview.rewrites.from}–#{preview.rewrites.to} is written again with your next reply,
                  to include the merge.
                </p>
              )}
              <section aria-label="Cast" className="flex flex-col gap-1 text-sm">
                <span className="font-medium">Cast</span>
                <ul className="flex flex-wrap gap-1.5">
                  {unionCast(all).map((member) => (
                    <li key={member.entity}>
                      <Tooltip
                        label={
                          member.added
                            ? `${member.name} joins this chat.`
                            : all.some((one) => one.back?.includes(member.entity))
                              ? `${member.name} is here again from the join on.`
                              : `${member.name} is already here.`
                        }
                      >
                        <span
                          tabIndex={0}
                          className={`inline-flex items-center gap-1 rounded border px-1.5 py-0.5 ${member.added ? "border-accent text-accent" : "border-border text-muted"}`}
                        >
                          {member.added && <span aria-hidden="true">+</span>}
                          {member.name}
                        </span>
                      </Tooltip>
                    </li>
                  ))}
                </ul>
              </section>
              {notes.length > 0 && (
                <section aria-labelledby="merge-notes-label" className="flex min-w-0 flex-col gap-2 text-sm">
                  <span id="merge-notes-label" className="font-medium">
                    Notes to bring
                  </span>
                  <p className="text-muted">
                    Notes on in “{preview.sourceTitle}”. Each one ticked is on in this chat from the merge on.
                  </p>
                  {notes.map((note) => (
                    <Checkbox
                      key={note.id}
                      checked={note.conflict === null && ticked.has(note.id)}
                      disabled={note.conflict !== null}
                      onCheckedChange={(checked) =>
                        setTicked((was) => {
                          const next = new Set(was)
                          if (checked) next.add(note.id)
                          else next.delete(note.id)
                          return next
                        })
                      }
                      hintInline={false}
                      hint={
                        note.conflict ??
                        (note.kind === "chat"
                          ? "Copies this note into this chat. The other chat keeps its own."
                          : `Switches ${note.card ?? "the character"}'s note on in this chat.`)
                      }
                      description={
                        <span className="flex min-w-0 flex-col gap-0.5 [overflow-wrap:anywhere]">
                          <span>{note.conflict ?? noteReaders(note)}</span>
                          {note.excerpt && <span className="text-muted">“{note.excerpt}”</span>}
                        </span>
                      }
                    >
                      {note.kind === "card" ? `${note.title} · ${note.card ?? "Character"}'s note` : note.title}
                    </Checkbox>
                  ))}
                </section>
              )}
              {preview.choosesTimelines === true && (
                <section aria-labelledby="join-view-label" className="flex flex-col gap-2 text-sm">
                  <span id="join-view-label" className="font-medium">
                    How the characters see it
                  </span>
                  <RadioGroup<MergeTimelines>
                    aria-labelledby="join-view-label"
                    value={timelines}
                    onValueChange={setTimelines}
                    options={
                      joining
                        ? [
                            {
                              value: "together",
                              label: several ? "Everyone reads every thread" : "Everyone reads both threads",
                              description: several
                                ? "Every reply sees all of them, the other threads as sections before this one's messages since they parted."
                                : `Every reply sees both, the other thread as a section before this one's messages since #${preview.from - 1}.`
                            },
                            {
                              value: "separate",
                              label: "Each character reads only its own thread",
                              description: "Characters see only the thread they were in. A narrator sees every thread."
                            }
                          ]
                        : [
                            {
                              value: "together",
                              label: "Everyone reads both chats",
                              description: "Every reply sees this chat and the merged one."
                            },
                            {
                              value: "separate",
                              label: "Each character keeps its own chat's past",
                              description:
                                "This chat's characters don't read the merged chat, and its characters don't read this chat's past. Everyone reads what follows the merge. A narrator reads both."
                            }
                          ]
                    }
                  />
                </section>
              )}
              {preview.choosesTimelines !== true && (
                <p className="text-sm text-muted" data-testid="join-view">
                  {joining
                    ? "Each character reads what it was present for (this chat's Context setting). A narrator reads every thread."
                    : "Each character reads only what it was present for, in either chat (this chat's Context setting). A narrator reads both."}
                </p>
              )}
            </>
          )}
        </div>
      </div>
      {preview && (
        <div className="flex min-w-0 flex-col gap-4">
          {!several && (
            <div className="grid min-w-0 gap-4 sm:grid-cols-2">
              <Field
                label="Title"
                about="What the timeline calls the merged messages, and the name the model reads for them."
              >
                <Input
                  value={title ?? preview.sourceTitle}
                  maxLength={200}
                  onChange={(event) => setTitle(event.currentTarget.value)}
                />
              </Field>
              <Field
                label="Framing line"
                about="The line the model reads before the merged messages. Left as it is, the preset's own line is used when it has one."
              >
                <Textarea
                  className="min-h-16!"
                  value={framingText}
                  maxLength={2000}
                  onChange={(event) => setFraming(event.currentTarget.value)}
                />
              </Field>
            </div>
          )}
          {several && (
            <p className="text-sm text-muted">
              Each thread comes in under its own name, with the preset's framing line. Join one at a time to change
              them.
            </p>
          )}
          <details className="group min-w-0 rounded-md border border-border">
            <summary className="cursor-pointer list-none px-3 py-2 text-sm font-medium text-muted outline-none hover:text-text focus-visible:ring-2 focus-visible:ring-focus">
              What the model reads
            </summary>
            {views !== null && readerFor !== null && (
              <div className="border-t border-border px-3 py-2">
                <Field
                  label="For"
                  about={
                    readerFor.from === undefined
                      ? "With this chat's separate contexts, each character reads only what it was present for. A narrator and your own characters read it all."
                      : "Each character reads only its own chat's past, and everything after the merge. A narrator and your own characters read it all."
                  }
                >
                  <Select
                    value={readerFor.entity as string}
                    onValueChange={(value) => setReaderFor(value as EntityId)}
                    items={views.map((v) => ({
                      value: v.entity as string,
                      label: v.name,
                      description: v.readable ? undefined : "Wasn't there: reads none of it"
                    }))}
                  />
                </Field>
              </div>
            )}
            <pre
              data-testid="merge-section"
              className="max-h-64 min-w-0 overflow-y-auto border-t border-border px-3 py-2 text-xs whitespace-pre-wrap [overflow-wrap:anywhere]"
            >
              {[
                ...all.flatMap((one) => readOf(one)),
                readerFor?.from === "merged"
                  ? `[Of this chat before the merge, only what ${readerFor.name} was there for]`
                  : layout === "join"
                    ? null
                    : `[This ${joining ? "thread" : "chat"}'s own messages${preview.start ? ` from #${preview.start.number}` : ""}]`,
                several ? null : marker
              ]
                .filter(Boolean)
                .join("\n\n")}
            </pre>
          </details>
        </div>
      )}
      {stale && preview && (
        <Alert tone="warning">
          {joining
            ? "One of the threads changed while this was open. This is what joining brings now."
            : "One of the chats changed while this was open. This is what merging brings now."}
        </Alert>
      )}
      <ErrorAlert error={writer.error && writer.error.tag !== "MergeChanged" ? writer.error : null} />
      <DialogActions>
        <Button hint={joining ? "Closes this without joining." : "Closes this without merging."} onClick={onClose}>
          Cancel
        </Button>
        <Button
          variant="primary"
          disabled={!preview || reader.pending}
          pending={writer.pending}
          hint={
            joining
              ? "Adds each chosen thread's messages to this thread as one entry, after the message chosen. Their characters are here again from there on."
              : "Adds the merged messages to this chat as one entry, after the message chosen."
          }
          onClick={() => void merge()}
        >
          {joining ? "Join" : "Merge"}
        </Button>
      </DialogActions>
    </Dialog>
  )
}

/** The ⋯ menu's entry: after the newest message. */
export function MergeChatCommandDialog({ context, onClose }: ChatCommandDialogProps) {
  return <MergeChatDialog session={context.session} at={null} onClose={onClose} />
}

/** A message's action: after this message. */
export function MergeChatHereDialog({ session, entry, closeDialog }: MessageActionProps) {
  return <MergeChatDialog session={session} at={entry.slotId} onClose={closeDialog} />
}
