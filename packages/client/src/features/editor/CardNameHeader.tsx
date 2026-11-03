// A card's header at the top of its editor, the same in the chat's character tab and the full
// editor (owner, 2026-11-01, 2026-11-02; `CardHeader`): the portrait beside the names and token
// counts, stacked from the top. The display name is the title, the version a small badge on the
// row under it, then the nickname as what it does ("In chat: Mio", or a faint "Add an in-chat
// nickname"). Each is renamed in place with the pencil (`ui/InlineRename`), and none has an
// on-screen label: each one's tooltip says what it is. A change of the name chats use asks
// about past messages right there, on confirm (`renameQuestion`, the registered `cardSaved`
// question), never after a later Save. Under the names, the card's token counts.
import { renameQuestion } from "@rp/shared/cardNames.ts"
import { useAtomValue } from "@effect/atom-react"
import { cardTokenTexts, sumCardTokens } from "@rp/shared/cardTokens.ts"
import { ChatId, type EntityId, ForkId } from "@rp/shared/chat.ts"
import { textField } from "@rp/shared/editing.ts"
import type { NoteEntry } from "@rp/shared/editorApi.ts"
import { useSearch } from "@tanstack/react-router"
import { Schema } from "effect"
import { AsyncResult } from "effect/reactivity"
import { type ReactNode, useMemo, useState, useSyncExternalStore } from "react"
import { AppClient } from "../../rpc.ts"
import { CardSurface } from "../cardForks/surfaces.tsx"
import { useSession } from "../../session.ts"
import { DISPLAY_HINT, NICKNAME_HINT, VERSION_HINT } from "./cardNameHints.ts"
import { InlineRename } from "../../ui/InlineRename.tsx"
import { Tooltip } from "../../ui/Tooltip.tsx"
import type { Caller } from "./caller.ts"
import { type CardSaved, type RenameAnswer, showCardSaved } from "./cardSaved.ts"
import { checkCardNames } from "./checkCardNames.ts"
import { useSearchMatch } from "./searchNavigation.ts"
import { EditorStore, useEditorState, useText, useWorkingDoc } from "./store.ts"
import { openEditorStore, subscribeOpenEditors } from "./openEditors.ts"
import { MACROS_COUNTED, useCountMacros } from "./countMacros.ts"
import { tokenizerText, tokensText, useTokenCounts } from "./tokenCounts.ts"

/** The chat the editor is opened from, for "only in this chat". */
export interface RenameChat {
  readonly chatId: string
  readonly forkId: string | null
}

/**
 * The text of a card's notes on in every chat by default, as chats send it (what ST counts as
 * its Character's Note): a note's own text, a linked note's shared note's, nothing for a link
 * to a shared note in the bin.
 */
function useDefaultNotes(refId: string): ReadonlyArray<string> {
  const atom = useMemo(
    () => AppClient.query("ListCardNotes", { cardRefId: refId as never }, { reactivityKeys: ["library"] }),
    [refId]
  )
  const notes = useAtomValue(atom)
  const entries = AsyncResult.isSuccess(notes) ? notes.value : NO_ENTRIES
  // A note open in an editor here counts as it's typed, as the card's own fields do; the read
  // has the rest as they were last sent to the server (their drafts included).
  const sentTexts = () =>
    entries
      .flatMap(({ ref, sent }) => {
        if (sent === undefined) return []
        const store = openEditorStore(ref.id)
        const working = store instanceof EditorStore && store.snapshot !== null ? store.working().doc : null
        const on = (working ?? sent).on_by_default === true
        // A linked slot's text is its shared note's, which its own editor doesn't hold.
        const content = typeof sent.link === "string" || working === null ? sent.content : working.content
        return on && typeof content === "string" ? [content] : []
      })
      .join("\u0000")
  const subscribe = useMemo(() => subscribeLiveNotes(entries.map(({ ref }) => ref.id)), [entries])
  const joined = useSyncExternalStore(subscribe, sentTexts)
  return useMemo(() => (joined === "" ? NO_NOTES : joined.split("\u0000")), [joined])
}
const NO_NOTES: ReadonlyArray<string> = []
const NO_ENTRIES: ReadonlyArray<NoteEntry> = []

/** Told when one of `refIds`' open editors changes, or one opens or closes. */
const subscribeLiveNotes = (refIds: ReadonlyArray<string>) => (listener: () => void) => {
  let stores: Array<() => void> = []
  const watch = () => {
    for (const stop of stores) stop()
    stores = refIds.flatMap((refId) => {
      const store = openEditorStore(refId)
      return store instanceof EditorStore ? [store.subscribe("working")(listener)] : []
    })
  }
  watch()
  const stopOpen = subscribeOpenEditors(() => {
    watch()
    listener()
  })
  return () => {
    stopOpen()
    for (const stop of stores) stop()
  }
}

/**
 * The card's total and permanent token counts, as ST's character panel has them
 * (@rp/shared/cardTokens.ts), with the chat model's tokenizer, counted as you type.
 */
function CardTokens({ store }: { store: EditorStore }) {
  const notes = useDefaultNotes(store.refId)
  const parts = cardTokenTexts(useWorkingDoc(store), notes)
  const expand = useCountMacros(store)
  const { counts, tokenizer, pending } = useTokenCounts(parts.map((part) => expand(part.text)))
  const known = counts.every((count) => count !== null)
  const sums = sumCardTokens(
    parts,
    counts.map((count) => count ?? 0)
  )
  const shown = (n: number) => (known ? tokensText(n, tokenizer, pending).replace(/ tokens$/, "") : "…")
  return (
    <Tooltip
      label={
        <>
          Total: every card field a chat can send: its name, description, personality, scenario, first message, example
          messages, its own system prompt and post-history instructions, and its notes on by default. Permanent: what
          every request carries: the name, description, personality, scenario and those notes. {MACROS_COUNTED}{" "}
          {tokenizerText(tokenizer)}
        </>
      }
    >
      <span
        tabIndex={0}
        data-card-tokens
        data-card-header-row
        aria-busy={pending || undefined}
        className="w-fit max-w-full truncate rounded text-xs leading-4 text-muted tabular-nums outline-none focus-visible:ring-2 focus-visible:ring-focus"
      >
        {shown(sums.total)} tokens · {shown(sums.permanent)} permanent
      </span>
    </Tooltip>
  )
}

/**
 * The header's final rows: what's registered for a card's header (`cardContributions`,
 * placement "header": the Persona switch), then the token counts on their own last row.
 * Direct children of CardHeader's stack keep its spacing even below the portrait.
 */
export function CardTokensRow({ store, entityId, label }: { store: EditorStore; entityId: string; label: string }) {
  return (
    <>
      <CardSurface placement="header" entityId={entityId as EntityId} label={label} />
      <CardTokens store={store} />
    </>
  )
}

/**
 * The display name, version and nickname of the card in `store`, renamed in place. `title` is
 * the heading's level and size; `after` sits beside the title (the favourite star).
 */
export function CardNameHeader({
  store,
  call,
  current,
  heading = "h2",
  after
}: {
  store: EditorStore
  call: Caller
  /** The chat it's edited from; else the URL's (`renameChat`, `renameFork`), as the full editor's page has it. */
  current?: RenameChat | undefined
  heading?: "h1" | "h2"
  after?: ReactNode
}) {
  const userId = useSession().user.id
  const ref = useEditorState(store).snapshot!.ref
  const name = useText(store, ["name"]) ?? ""
  const nickname = useText(store, ["nickname"]) ?? ""
  const version = useText(store, ["character_version"]) ?? ""
  const url = useSearch({ strict: false }) as { renameChat?: unknown; renameFork?: unknown }
  const [problem, setProblem] = useState<string | null>(null)
  // Search's Go to a match in a name opens its field with the match selected.
  const nameMatch = useSearchMatch(["name"])
  const versionMatch = useSearchMatch(["character_version"])
  const nicknameMatch = useSearchMatch(["nickname"])
  const chat = (() => {
    if (current?.forkId) return { chatId: current.chatId as ChatId, forkId: current.forkId as ForkId }
    const chatId = Schema.decodeUnknownOption(ChatId)(url.renameChat)
    const forkId = Schema.decodeUnknownOption(ForkId)(url.renameFork)
    return chatId._tag === "Some" && forkId._tag === "Some" ? { chatId: chatId.value, forkId: forkId.value } : null
  })()

  /** Asks the registered question and waits for its answer; none registered: go ahead. */
  const ask = (change: CardSaved) =>
    new Promise<RenameAnswer | undefined>((resolve) =>
      showCardSaved(userId, change, (_stay, answer) => resolve(answer))
    )

  /** Writes the names and sends them now: live text is what's sent. */
  const write = (names: { readonly name?: string; readonly nickname?: string; readonly version?: string }) => {
    for (const [path, value] of [
      [["name"], names.name],
      [["nickname"], names.nickname],
      [["character_version"], names.version]
    ] as const) {
      if (value === undefined) continue
      store.setText(path, value)
      void store.save(textField(path))
    }
  }

  /** A display name or version pair another card has is refused here, as Save refuses it. */
  const clashes = async (nextName: string, nextVersion: string) => {
    const result = await call((client) => checkCardNames(client, nextName, nextVersion, ref))
    setProblem(result.ok ? null : result.error.message)
    return !result.ok
  }

  const rename = async (after: { readonly name: string; readonly nickname: string }) => {
    const before = { name, nickname }
    const question = renameQuestion(before, after)
    if (question === null) {
      write(after)
      return true
    }
    const answer = await ask({
      entityId: ref.entityId,
      oldName: question.oldName,
      newName: question.newName,
      atConfirm: true,
      display: question.kind === "display",
      ...(chat ? { current: chat } : {})
    })
    if (answer === "cancel") return false
    write(answer === "keep" ? { name: after.name, nickname: before.name } : after)
    return true
  }

  const Title = heading
  // Each row fits its own text; the title pencil follows its last visible line.
  return (
    <>
      <InlineRename
        value={name}
        label="the display name"
        hint={DISPLAY_HINT}
        fieldLabel="Display name"
        goTo={nameMatch}
        lastLine
        className="peer/title"
        onRename={async (next) => !(await clashes(next, version)) && rename({ name: next, nickname })}
      >
        {/* The pencil beside the heading, not in it: the heading's name is the card's name. */}
        <Tooltip label={DISPLAY_HINT}>
          <Title
            data-card-header-row
            data-inline-rename-text
            className={`line-clamp-2 min-w-0 font-semibold [overflow-wrap:anywhere] ${heading === "h1" ? "text-2xl leading-8" : "text-lg leading-7"}`}
          >
            {name || "Unnamed card"}
          </Title>
        </Tooltip>
      </InlineRename>
      {after && (
        <span
          data-layout-audit-ignore="inset: Floating favourite shares the enclosing editor header's content inset"
          className="absolute top-0 right-0 flex items-center peer-data-renaming/title:hidden"
        >
          {after}
        </span>
      )}
      <InlineRename
        value={version}
        label="the version"
        hint={VERSION_HINT}
        fieldLabel="Version"
        goTo={versionMatch}
        allowEmpty
        className="w-fit max-w-full text-sm"
        onRename={async (next) => {
          if (await clashes(name, next)) return false
          write({ version: next })
        }}
      >
        <Tooltip label={VERSION_HINT}>
          {version ? (
            <span
              data-card-header-row
              className="min-w-0 truncate rounded-full border border-border px-2 py-0.5 text-xs text-muted"
            >
              {version}
            </span>
          ) : (
            <span data-card-header-row className="truncate text-xs text-muted/70">
              Add a version
            </span>
          )}
        </Tooltip>
      </InlineRename>
      <InlineRename
        value={nickname}
        label="the nickname"
        hint={NICKNAME_HINT}
        fieldLabel="In-chat nickname"
        goTo={nicknameMatch}
        allowEmpty
        className="w-fit max-w-full text-sm"
        onRename={(next) => rename({ name, nickname: next })}
      >
        <Tooltip label={NICKNAME_HINT}>
          {nickname ? (
            <span data-card-header-row className="min-w-0 truncate text-muted">
              In chat: {nickname}
            </span>
          ) : (
            <span data-card-header-row className="truncate text-muted/70">
              Add an in-chat nickname
            </span>
          )}
        </Tooltip>
      </InlineRename>
      {problem && (
        <p role="alert" className="text-sm text-danger">
          {problem}
        </p>
      )}
    </>
  )
}

/**
 * A card's header, the same in the chat's character tab and the full editor (owner,
 * 2026-11-02): the portrait (`CardHeaderPortrait`) beside its names and token counts
 * (`CardNameHeader`, `CardTokens` as `children`), stacked from the top with consistent gaps.
 * Its width sets the portrait's size (a container query), so it holds at any panel width.
 */
export function CardHeader({ portrait, children }: { portrait: ReactNode; children: ReactNode }) {
  return (
    <div data-card-header className="@container flex items-stretch gap-3">
      {portrait}
      <div className="relative flex min-w-0 flex-1 flex-col items-start gap-1 has-[>span.absolute]:pr-8 [&>[data-renaming]]:w-full [&>[data-renaming]]:flex-none">
        {children}
      </div>
    </div>
  )
}
