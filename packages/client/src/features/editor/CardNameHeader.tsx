// A card's header at the top of its editor, the same in the chat's character tab and the full
// editor (owner, 2026-11-01, 2026-11-02; `CardHeader`): the portrait beside the names and token
// counts, as tall as they are. The display name is the title, the version a small badge on the
// row under it, then the nickname as what it does ("In chat: Mio", or a faint "Add a chat
// name"). Each is renamed in place with the pencil (`ui/InlineRename`), and none has an
// on-screen label: each one's tooltip says what it is. A change of the name chats use asks
// about past messages right there, on confirm (`renameQuestion`, the registered `cardSaved`
// question), never after a later Save. Under the names, the card's token counts.
import { renameQuestion } from "@rp/shared/cardNames.ts"
import { useAtomValue } from "@effect/atom-react"
import { cardTokenTexts, sumCardTokens } from "@rp/shared/cardTokens.ts"
import { ChatId, ForkId } from "@rp/shared/chat.ts"
import { textField } from "@rp/shared/editing.ts"
import { useSearch } from "@tanstack/react-router"
import { Schema } from "effect"
import { AsyncResult } from "effect/reactivity"
import { type ReactNode, useMemo, useState } from "react"
import { AppClient } from "../../rpc.ts"
import { useSession } from "../../session.ts"
import { InlineRename } from "../../ui/InlineRename.tsx"
import { Tooltip } from "../../ui/Tooltip.tsx"
import type { Caller } from "./caller.ts"
import { type CardSaved, type RenameAnswer, showCardSaved } from "./cardSaved.ts"
import { checkCardNames } from "./checkCardNames.ts"
import { useSearchMatch } from "./searchNavigation.ts"
import { type EditorStore, useEditorState, useText, useWorkingDoc } from "./store.ts"
import { MACROS_COUNTED, useCountMacros } from "./countMacros.ts"
import { tokenizerText, tokensText, useTokenCounts } from "./tokenCounts.ts"

/** The chat the editor is opened from, for "only in this chat". */
export interface RenameChat {
  readonly chatId: string
  readonly forkId: string | null
}

const DISPLAY_HINT =
  "The display name: what the app shows this card by, in the library and here. Chats call them by it too when there's no chat name."
const VERSION_HINT =
  "The version (the card's character_version): shown beside the display name, to tell this card from others with the same name."
const NICKNAME_HINT =
  "The chat name (the card's nickname): what chats and the model call them, and what {{char}} becomes. Empty: the display name."

/** A card's notes on in every chat by default, by their own text: what ST counts as its Character's Note. */
function useDefaultNotes(refId: string): ReadonlyArray<string> {
  const atom = useMemo(
    () => AppClient.query("ListCardNotes", { cardRefId: refId as never }, { reactivityKeys: ["library"] }),
    [refId]
  )
  const notes = useAtomValue(atom)
  const texts = AsyncResult.isSuccess(notes)
    ? notes.value.flatMap(({ doc }) =>
        doc.on_by_default === true && doc.link === undefined && typeof doc.content === "string" ? [doc.content] : []
      )
    : NO_NOTES
  const joined = texts.join("\u0000")
  // eslint-disable-next-line react-hooks/exhaustive-deps -- the texts, by value
  return useMemo(() => texts, [joined])
}
const NO_NOTES: ReadonlyArray<string> = []

/**
 * The card's total and permanent token counts, as ST's character panel has them
 * (@rp/shared/cardTokens.ts), with the chat model's tokenizer, counted as you type.
 */
export function CardTokens({ store }: { store: EditorStore }) {
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
          every request carries, as SillyTavern counts it: the name, description, personality, scenario and those notes.{" "}
          {MACROS_COUNTED} {tokenizerText(tokenizer)}
        </>
      }
    >
      <span
        tabIndex={0}
        data-card-tokens
        data-card-header-row
        aria-busy={pending || undefined}
        className="col-span-full w-fit max-w-full truncate rounded text-xs leading-4 text-muted tabular-nums outline-none focus-visible:ring-2 focus-visible:ring-focus"
      >
        {shown(sums.total)} tokens · {shown(sums.permanent)} permanent
      </span>
    </Tooltip>
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
  // Grid cells of `CardHeader`: each name in the first column, its pencil in the second, so
  // every pencil is on one line; the title takes at most two lines and the others one, so the
  // names never outgrow the portrait beside them.
  return (
    <>
      <InlineRename
        value={name}
        label="the display name"
        hint={DISPLAY_HINT}
        fieldLabel="Display name"
        goTo={nameMatch}
        cells
        className="peer/title"
        onRename={async (next) => !(await clashes(next, version)) && rename({ name: next, nickname })}
      >
        {/* The pencil beside the heading, not in it: the heading's name is the card's name. */}
        <Tooltip label={DISPLAY_HINT}>
          <Title
            data-card-header-row
            className={`col-start-1 line-clamp-2 max-w-96 min-w-0 font-semibold [overflow-wrap:anywhere] ${heading === "h1" ? "text-2xl leading-8" : "text-lg leading-7"}`}
          >
            {name || "Unnamed card"}
          </Title>
        </Tooltip>
      </InlineRename>
      {after && (
        <span className="col-start-3 row-start-1 flex items-center pl-1 peer-data-renaming/title:hidden">{after}</span>
      )}
      <InlineRename
        value={version}
        label="the version"
        hint={VERSION_HINT}
        fieldLabel="Version"
        goTo={versionMatch}
        allowEmpty
        cells
        className="text-sm"
        onRename={async (next) => {
          if (await clashes(name, next)) return false
          write({ version: next })
        }}
      >
        <Tooltip label={VERSION_HINT}>
          {version ? (
            <span
              data-card-header-row
              className="col-start-1 max-w-96 min-w-0 truncate rounded-full border border-border px-2 py-0.5 text-xs text-muted"
            >
              {version}
            </span>
          ) : (
            <span data-card-header-row className="col-start-1 max-w-96 truncate text-xs text-muted/70">
              Add a version
            </span>
          )}
        </Tooltip>
      </InlineRename>
      <InlineRename
        value={nickname}
        label="the chat name"
        hint={NICKNAME_HINT}
        fieldLabel="Chat name (nickname)"
        goTo={nicknameMatch}
        allowEmpty
        cells
        className="text-sm"
        onRename={(next) => rename({ name, nickname: next })}
      >
        <Tooltip label={NICKNAME_HINT}>
          {nickname ? (
            <span data-card-header-row className="col-start-1 max-w-96 min-w-0 truncate text-muted">
              In chat: {nickname}
            </span>
          ) : (
            <span data-card-header-row className="col-start-1 max-w-96 truncate text-muted/70">
              Add a chat name
            </span>
          )}
        </Tooltip>
      </InlineRename>
      {problem && (
        <p role="alert" className="col-span-full text-sm text-danger">
          {problem}
        </p>
      )}
    </>
  )
}

/**
 * A card's header, the same in the chat's character tab and the full editor (owner,
 * 2026-11-02): the portrait (`CardHeaderPortrait`) beside its names and token counts
 * (`CardNameHeader`, `CardTokens` as `children`), the portrait exactly as tall as they are,
 * their first row at its top and the last at its bottom, the rows spread evenly between.
 * Its width sets the portrait's size (a container query), so it holds at any panel width.
 */
export function CardHeader({ portrait, children }: { portrait: ReactNode; children: ReactNode }) {
  return (
    <div data-card-header className="@container flex items-stretch gap-3">
      {portrait}
      <div className="grid min-w-0 flex-1 grid-cols-[minmax(0,max-content)_auto_1fr] content-between items-center justify-items-start gap-x-1">
        {children}
      </div>
    </div>
  )
}
