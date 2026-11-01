// A card's names at the top of its editor, the same in the chat's character tab and the full
// editor (owner, 2026-11-01): the display name as the title, the version as a small badge
// beside it, and the nickname under it as what it does ("In chat: Mio", or a faint "Add a chat
// name"). Each is renamed in place with the pencil (`ui/InlineRename`), and none has an
// on-screen label: each one's tooltip says what it is. A change of the name chats use asks
// about past messages right there, on confirm (`renameQuestion`, the registered `cardSaved`
// question), never after a later Save. Under the names, the card's token counts.
import { renameQuestion } from "@rp/shared/cardNames.ts"
import { cardTokenCounts } from "@rp/shared/cardTokens.ts"
import { ChatId, ForkId } from "@rp/shared/chat.ts"
import { textField } from "@rp/shared/editing.ts"
import { useSearch } from "@tanstack/react-router"
import { Schema } from "effect"
import { type ReactNode, useState } from "react"
import { useSession } from "../../session.ts"
import { InlineRename } from "../../ui/InlineRename.tsx"
import { Tooltip } from "../../ui/Tooltip.tsx"
import type { Caller } from "./caller.ts"
import { type CardSaved, type RenameAnswer, showCardSaved } from "./cardSaved.ts"
import { checkCardNames } from "./checkCardNames.ts"
import { useSearchMatch } from "./searchNavigation.ts"
import { type EditorStore, useEditorState, useText, useWorkingDoc } from "./store.ts"

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

/** The card's total and permanent token counts, live as you type, with what each counts. */
export function CardTokens({ store }: { store: EditorStore }) {
  const counts = cardTokenCounts(useWorkingDoc(store))
  return (
    <Tooltip
      label={
        <>
          Total: every card field a chat can send: its name, description, personality, scenario, first message, example
          messages, and its own system prompt and post-history instructions. Permanent: what every request carries, as
          ST counts it: the name, description, personality and scenario. Estimates, at four characters a token, as the
          app counts wherever the model's tokenizer isn't used.
        </>
      }
    >
      <span
        tabIndex={0}
        data-card-tokens
        className="w-fit rounded text-xs text-muted tabular-nums outline-none focus-visible:ring-2 focus-visible:ring-focus"
      >
        ~{counts.total.toLocaleString()} tokens · ~{counts.permanent.toLocaleString()} permanent
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
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
        {/* The pencil beside the heading, not in it: the heading's name is the card's name. */}
        <InlineRename
          value={name}
          label="the display name"
          hint={DISPLAY_HINT}
          fieldLabel="Display name"
          goTo={nameMatch}
          onRename={async (next) => !(await clashes(next, version)) && rename({ name: next, nickname })}
        >
          <Tooltip label={DISPLAY_HINT}>
            <Title
              className={`min-w-0 font-semibold [overflow-wrap:anywhere] ${heading === "h1" ? "text-2xl" : "text-lg leading-snug"}`}
            >
              {name || "Unnamed card"}
            </Title>
          </Tooltip>
        </InlineRename>
        <InlineRename
          value={version}
          label="the version"
          hint={VERSION_HINT}
          fieldLabel="Version"
          goTo={versionMatch}
          allowEmpty
          className="text-sm"
          onRename={async (next) => {
            if (await clashes(name, next)) return false
            write({ version: next })
          }}
        >
          <Tooltip label={VERSION_HINT}>
            {version ? (
              <span className="max-w-full rounded-full border border-border px-2 py-0.5 text-xs text-muted [overflow-wrap:anywhere]">
                {version}
              </span>
            ) : (
              <span className="text-xs text-muted/70">Add a version</span>
            )}
          </Tooltip>
        </InlineRename>
        {after}
      </div>
      <InlineRename
        value={nickname}
        label="the chat name"
        hint={NICKNAME_HINT}
        fieldLabel="Chat name (nickname)"
        goTo={nicknameMatch}
        allowEmpty
        className="text-sm"
        onRename={(next) => rename({ name, nickname: next })}
      >
        <Tooltip label={NICKNAME_HINT}>
          {nickname ? (
            <span className="min-w-0 text-muted [overflow-wrap:anywhere]">In chat: {nickname}</span>
          ) : (
            <span className="text-muted/70">Add a chat name</span>
          )}
        </Tooltip>
      </InlineRename>
      {problem && (
        <p role="alert" className="text-sm text-danger">
          {problem}
        </p>
      )}
    </div>
  )
}
