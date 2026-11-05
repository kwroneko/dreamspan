// "Merge another chat into this one" (spec/CHAT-MERGE.md §7; owner decisions DESIGN §3.3,
// 2026-11-05). One dialog for both entry points, the ⋯ menu (after the newest message) and a
// message's actions (after that message): pick the chat or branch to bring in, see what comes in
// and how the model will read it, and merge. Nothing is sent to a model here; the preview is
// computed by the server from what's stored.
import type { Chat, ChatId, Fork, ForkId, PathEntry, SlotId } from "@rp/shared/chat.ts"
import {
  type ChatMergePreview,
  fillMergeTemplate,
  MERGE_BLOCK_SECTION_DEFAULT,
  MERGE_SECTION_DEFAULT
} from "@rp/shared/mergeApi.ts"
import { useNavigate } from "@tanstack/react-router"
import { useEffect, useMemo, useState, useSyncExternalStore } from "react"
import { ErrorAlert, useAction } from "../../actions.tsx"
import type { AppError } from "../../errors.ts"
import { Button } from "../../ui/Button.tsx"
import { Switch } from "../../ui/Choice.tsx"
import { Dialog, DialogActions } from "../../ui/Dialog.tsx"
import { Field, Input, Textarea } from "../../ui/Field.tsx"
import { Select } from "../../ui/Select.tsx"
import { Spinner } from "../../ui/Spinner.tsx"
import { Alert } from "../../ui/Surface.tsx"
import { showToast } from "../../ui/Toast.tsx"
import { Tooltip } from "../../ui/Tooltip.tsx"
import { useCast } from "./cast.ts"
import type { ChatCommandDialogProps } from "./commands.tsx"
import { branchLabel } from "./forks.ts"
import type { MessageActionProps } from "./messageActions.tsx"
import { positionOf } from "./position.ts"
import type { ChatSession } from "./session.ts"

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

function SourcePicker({
  chatId,
  forkId,
  chosen,
  onChoose
}: {
  chatId: ChatId
  forkId: ForkId | null
  chosen: { chat: Chat; fork: ForkId } | null
  onChoose: (next: { chat: Chat; fork: ForkId }) => void
}) {
  const [search, setSearch] = useState("")
  const [chats, setChats] = useState<ReadonlyArray<Chat> | null>(null)
  const [listed, setListed] = useState<{ chat: ChatId; forks: ReadonlyArray<Fork> } | null>(null)
  const reader = useAction()
  const forksReader = useAction()
  useEffect(() => {
    let live = true
    const query = search.trim()
    const timer = setTimeout(
      () =>
        void reader
          .run((client) =>
            client("ListChats", { limit: 30, before: null, ...(query === "" ? {} : { search: query.slice(0, 200) }) })
          )
          .then((result) => {
            if (live && result.ok) setChats(result.value)
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
  const chosenChat = chosen?.chat.id ?? null
  useEffect(() => {
    if (chosenChat === null) return
    let live = true
    void forksReader
      .run((client) => client("ListForks", { chatId: chosenChat }))
      .then((result) => {
        if (live && result.ok)
          setListed({
            chat: chosenChat,
            forks: result.value.filter((f) => !(chosenChat === chatId && f.id === forkId))
          })
      })
    return () => {
      live = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chosenChat])
  const forks = listed !== null && listed.chat === chosenChat ? listed.forks : null
  const pick = (chat: Chat) => {
    // This chat's own branch can't be merged into itself: its newest other branch instead.
    const fork = chat.id === chatId && chat.currentForkId === forkId ? null : chat.currentForkId
    if (fork) onChoose({ chat, fork })
    else
      void forksReader
        .run((client) => client("ListForks", { chatId: chat.id }))
        .then((result) => {
          const other = result.ok
            ? [...result.value]
                .filter((f) => f.id !== forkId)
                .sort((a, b) => (b.endAt ?? b.createdAt) - (a.endAt ?? a.createdAt))[0]
            : undefined
          if (other) onChoose({ chat, fork: other.id })
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
          <li key={chat.id}>
            <Tooltip label={chat.id === chatId ? "Merge another branch of this chat." : `Merge “${chat.title}”.`}>
              <button
                type="button"
                aria-pressed={chosenChat === chat.id}
                onClick={() => pick(chat)}
                className="flex w-full min-w-0 items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left text-sm outline-none hover:bg-hover focus-visible:ring-2 focus-visible:ring-focus aria-pressed:bg-surface-raised aria-pressed:font-medium"
              >
                <span className="min-w-0 truncate">{chat.title || "Untitled chat"}</span>
                {chat.id === chatId && <span className="shrink-0 text-xs text-muted">This chat</span>}
              </button>
            </Tooltip>
          </li>
        ))}
      </ul>
      {chosen && forks !== null && forks.length > 1 && (
        <Field label="Branch">
          <Select
            value={chosen.fork}
            onValueChange={(fork) => onChoose({ chat: chosen.chat, fork })}
            items={forks.map((fork) => ({ value: fork.id, label: branchLabel(fork) }))}
          />
        </Field>
      )}
    </div>
  )
}

export function MergeChatDialog({
  session,
  at: initialAt,
  onClose
}: {
  session: ChatSession
  /** The message to merge after; null: the newest. */
  at: SlotId | null
  onClose: () => void
}) {
  const view = useSyncExternalStore(session.subscribe, session.snapshot)
  const { cast } = useCast()
  const navigate = useNavigate()
  const [forkId] = useState(() => view.forkId ?? view.chat?.currentForkId ?? null)
  const [source, setSource] = useState<{ chat: Chat; fork: ForkId } | null>(null)
  const [at, setAt] = useState<SlotId | null>(initialAt)
  const [start, setStart] = useState<SlotId | null>(null)
  const [includeLeftOut, setIncludeLeftOut] = useState(false)
  const [preview, setPreview] = useState<ChatMergePreview | null>(null)
  const [previewError, setPreviewError] = useState<AppError | null>(null)
  /** null: the source's own title. */
  const [title, setTitle] = useState<string | null>(null)
  const [framing, setFraming] = useState<string | null>(null)
  const [stale, setStale] = useState(false)
  const reader = useAction()
  const writer = useAction()

  const request = useMemo(
    () =>
      source && forkId
        ? {
            chatId: session.id,
            forkId,
            at,
            source: { chatId: source.chat.id, forkId: source.fork },
            ...(start === null ? {} : { start }),
            includeLeftOut
          }
        : null,
    [session.id, forkId, at, source, start, includeLeftOut]
  )
  useEffect(() => {
    if (request === null) return
    let live = true
    void reader
      .run((client) => client("PreviewChatMerge", request))
      .then((result) => {
        if (!live) return
        setPreview(result.ok ? result.value : null)
        setPreviewError(result.ok ? null : result.error)
      })
    return () => {
      live = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request])
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

  const merge = async () => {
    if (!request || !preview) return
    const result = await writer.run(
      (client) =>
        client("MergeChat", {
          ...request,
          title: shownTitle,
          framing: framing === null || framing.trim() === defaultFraming ? null : framing,
          digest: preview.digest
        }),
      ["chats"]
    )
    if (result.ok) {
      onClose()
      showToast({ title: `Merged “${shownTitle}”`, description: "It's one entry in the timeline; open it to read it." })
      return
    }
    if (result.error.tag === "MergeChanged") {
      setStale(true)
      const again = await reader.run((client) => client("PreviewChatMerge", request))
      if (again.ok) setPreview(again.value)
    }
  }
  const summarizeFirst = () => {
    if (!source) return
    onClose()
    void navigate({
      to: "/chats/$chatId",
      params: { chatId: source.chat.id },
      search: { fork: source.fork, panel: "summaries" }
    })
  }

  return (
    <Dialog
      open
      wide
      placement="top"
      onOpenChange={(open) => !open && !writer.pending && onClose()}
      title="Merge a chat into this one"
      description="Its messages join this chat as one entry, read by the model as a line that ran alongside. This chat's settings, preset and model apply; the other chat stays as it is."
    >
      <div className="grid min-w-0 gap-4 sm:grid-cols-2">
        <div className="flex min-w-0 flex-col gap-4">
          {forkId && (
            <SourcePicker
              chatId={session.id}
              forkId={forkId}
              chosen={source}
              onChoose={(next) => {
                // A new source: its own title, the default framing line and span again.
                setStale(false)
                setTitle(null)
                setFraming(null)
                setStart(null)
                setIncludeLeftOut(false)
                setSource(next)
              }}
            />
          )}
          <Field label="Merge after">
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
          {source === null && <p className="text-sm text-muted">Choose a chat to see what it brings in.</p>}
          {previewError && <ErrorAlert error={previewError} title="Can't merge this" />}
          {source && !preview && !previewError && (
            <p className="flex items-center gap-2 text-sm text-muted">
              <Spinner /> Reading “{source.chat.title}”…
            </p>
          )}
          {preview && (
            <>
              <section aria-label="What comes in" className="flex flex-col gap-1 text-sm">
                <p className="font-medium" data-testid="merge-relation">
                  {relation(preview)}
                </p>
                <p className="text-muted">
                  {[
                    preview.verbatim > 0 && `${plural(preview.verbatim, "message")} as written`,
                    preview.summarized > 0 &&
                      `${plural(preview.summarized, "message")} through ${plural(preview.summaries, "summary", "summaries")}`,
                    preview.leftOut > 0 && !includeLeftOut && `${plural(preview.leftOut, "message")} left out`
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                  {` · about ${preview.tokens.toLocaleString()} tokens`}
                </p>
              </section>
              {preview.leftOut > 0 && (
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
                  {plural(preview.leftOut, "older message")} (about {preview.leftOutTokens.toLocaleString()} tokens)
                  have no summary in the other chat, and this chat's recent stretch is about{" "}
                  {preview.spanTokens.toLocaleString()} tokens.
                </Alert>
              )}
              {preview.leftOut > 0 && (
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
                  {preview.cast.map((member) => (
                    <li key={member.entity}>
                      <Tooltip
                        label={member.added ? `${member.name} joins this chat.` : `${member.name} is already here.`}
                      >
                        <span
                          tabIndex={0}
                          className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 ${member.added ? "border-accent text-accent" : "border-border text-muted"}`}
                        >
                          {member.added && <span aria-hidden="true">+</span>}
                          {member.name}
                        </span>
                      </Tooltip>
                    </li>
                  ))}
                </ul>
              </section>
            </>
          )}
        </div>
      </div>
      {preview && (
        <div className="flex min-w-0 flex-col gap-4">
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
          <details className="group min-w-0 rounded-md border border-border">
            <summary className="cursor-pointer list-none px-3 py-2 text-sm font-medium text-muted outline-none hover:text-text focus-visible:ring-2 focus-visible:ring-focus">
              What the model reads
            </summary>
            <pre
              data-testid="merge-section"
              className="max-h-64 min-w-0 overflow-y-auto border-t border-border px-3 py-2 text-xs whitespace-pre-wrap [overflow-wrap:anywhere]"
            >
              {[
                framingText.trim(),
                preview.section,
                layout === "join"
                  ? null
                  : `[This chat's own messages${preview.start ? ` from #${preview.start.number}` : ""}]`,
                marker
              ]
                .filter(Boolean)
                .join("\n\n")}
            </pre>
          </details>
        </div>
      )}
      {stale && preview && (
        <Alert tone="warning">One of the chats changed while this was open. This is what merging brings now.</Alert>
      )}
      <ErrorAlert error={writer.error && writer.error.tag !== "MergeChanged" ? writer.error : null} />
      <DialogActions>
        <Button hint="Closes this without merging." onClick={onClose}>
          Cancel
        </Button>
        <Button
          variant="primary"
          disabled={!preview || reader.pending}
          pending={writer.pending}
          hint="Adds the merged messages to this chat as one entry, after the message chosen."
          onClick={() => void merge()}
        >
          Merge
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
