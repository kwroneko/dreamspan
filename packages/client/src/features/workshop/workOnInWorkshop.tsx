// "Work on in a workshop" (spec/WORKSHOP-CARDS.md §4.1 point 3, unit C5): in a card's menus and
// a lorebook's and a preset's editor toolbars, a submenu of the workshops open in this browser
// tab's frames, most recent first, up to five, then A new workshop. Picking one puts the item in
// that workshop's message (its composer's tiles) and shows its tab with the composer focused; a
// new one opens the workshop not made yet with the item in its first message (`workshopAttach`).
import type { ComposerLibraryItem } from "@dreamspan/shared/composerApi.ts"
import type { LibraryRef, RefId } from "@dreamspan/shared/library.ts"
import { useAtomValue } from "@effect/atom-react"
import { useNavigate } from "@tanstack/react-router"
import { AsyncResult } from "effect/reactivity"
import { useSyncExternalStore } from "react"
import { Button } from "../../ui/Button.tsx"
import { Icon } from "../../ui/Icon.tsx"
import { Menu, MenuAction, MenuItem, MenuSubmenu, useMenuActions } from "../../ui/Menu.tsx"
import { cardContributions, type CardSurfaceContext } from "../cardForks/surfaces.tsx"
import { browsable, shellAtom } from "../characters/shellData.tsx"
import type { ChatCardActionProps } from "../chat/CardForkDialogs.tsx"
import { type LiveLibraryComposer, useLiveLibraryComposers } from "../chat/libraryAttachments.tsx"
import { chatCardActions } from "../chat/presentation.tsx"
import { editorActions } from "../editor/editorSlots.ts"
import { panelEditorActions } from "../editor/panelActions.tsx"
import type { EditorStore } from "../editor/store.ts"
import { useEditorState } from "../editor/store.ts"
import { libraryListAtom } from "../library/queries.ts"
import { useWorkbench } from "../workbench/tab.tsx"
import { WORKSHOP_ATTACH_KEY } from "./workshopStart.ts"

const LABEL = "Work on in a workshop"
const HINT = "Puts this in a workshop's message, so the assistant can work on it."
const MAX_LISTED = 5

const noop = () => () => {}
const NO_RECENT: ReadonlyArray<string> = []

/** The workshop composers open in this browser tab's frames, the most recently focused first. */
function useOpenWorkshops(): ReadonlyArray<LiveLibraryComposer> {
  const composers = useLiveLibraryComposers()
  const store = useWorkbench()
  const recent = useSyncExternalStore(store?.subscribe ?? noop, () => store?.layout.recent ?? NO_RECENT)
  const rank = (composer: LiveLibraryComposer) => {
    const at = composer.tabId === null ? -1 : recent.indexOf(composer.tabId)
    return at === -1 ? recent.length : at
  }
  const seen = new Set<string>()
  return [...composers]
    .sort((a, b) => rank(a) - rank(b))
    .filter((composer) => !seen.has(composer.chatId) && seen.add(composer.chatId))
    .slice(0, MAX_LISTED)
}

/** The submenu's rows: the open workshops, then A new workshop. */
function WorkshopChoices({ refId }: { refId: string }) {
  const workshops = useOpenWorkshops()
  const store = useWorkbench()
  const navigate = useNavigate()
  return (
    <>
      {workshops.map((workshop) => {
        const title = workshop.title || "Workshop"
        return (
          <MenuItem
            key={workshop.chatId}
            icon="tool"
            description={`Puts it in ${title}'s message and shows that workshop.`}
            onClick={() => {
              workshop.add([refId])
              if (workshop.tabId !== null) store?.focusTab(workshop.tabId)
              workshop.focus()
            }}
          >
            {title}
          </MenuItem>
        )
      })}
      <MenuAction
        hint="Starts a workshop with this in its first message."
        href={`/new/workshop?${new URLSearchParams({ [WORKSHOP_ATTACH_KEY]: refId })}`}
        onClick={() => void navigate({ to: "/new/workshop", search: { [WORKSHOP_ATTACH_KEY]: refId } })}
      >
        A new workshop
      </MenuAction>
    </>
  )
}

/**
 * The toolbar widths under which the button shows only its icon, so its toolbar keeps one row:
 * the frame's, not the window's (each toolbar is a container). A preset's row needs 59rem with
 * Convert to workshop's label, about 71rem with this one's too; a lorebook's about 42rem.
 */
const NARROW = {
  preset: { button: "@max-[72rem]:w-8 @max-[72rem]:px-0!", label: "@max-[72rem]:hidden" },
  lorebook: { button: "@max-[44rem]:w-8 @max-[44rem]:px-0!", label: "@max-[44rem]:hidden" }
} as const

/** Nested in a menu; elsewhere a button opening the same choices (`compact`: its icon only). */
function WorkOnIn({
  refId,
  compact = false,
  toolbar
}: {
  refId: string
  compact?: boolean
  toolbar?: keyof typeof NARROW
}) {
  const inMenu = useMenuActions()
  if (inMenu)
    return (
      <MenuSubmenu label={LABEL} description={HINT}>
        <WorkshopChoices refId={refId} />
      </MenuSubmenu>
    )
  const narrow = toolbar ? NARROW[toolbar] : null
  return (
    <Menu
      label={LABEL}
      hint={HINT}
      trigger={
        <Button
          className={compact ? "h-8! w-8 px-0!" : `h-8! px-2! ${narrow?.button ?? ""}`}
          aria-label={LABEL}
          hint={HINT}
        >
          <Icon name="tool" />
          {!compact && <span className={narrow?.label}>{LABEL}</span>}
        </Button>
      }
    >
      <WorkshopChoices refId={refId} />
    </Menu>
  )
}

/** A card's library ref, from its entity: the menus that show a card know it by its entity. */
function useCardRef(entityId: string) {
  const shell = useAtomValue(shellAtom)
  return AsyncResult.isSuccess(shell)
    ? (browsable(shell.value).find((entry) => entry.card.entityId === entityId)?.card.refId ?? null)
    : null
}

function CardWorkOnIn({ entityId }: CardSurfaceContext) {
  const refId = useCardRef(entityId)
  return refId === null ? null : <WorkOnIn refId={refId} />
}

function ChatCardWorkOnIn({ card }: ChatCardActionProps) {
  const inMenu = useMenuActions()
  return inMenu ? <CardWorkOnIn entityId={card.entityId} /> : null
}

const editorWorkOnIn = (compact: boolean) =>
  function EditorWorkOnIn({ store }: { store: EditorStore }) {
    const ref = useEditorState(store).snapshot?.ref
    if (ref?.kind !== "lorebook" && ref?.kind !== "preset") return null
    return <WorkOnIn refId={ref.id} compact={compact} toolbar={ref.kind} />
  }

const KINDS = ["card", "lorebook", "preset"] as const
const listOf = (lists: ReadonlyArray<AsyncResult.AsyncResult<ReadonlyArray<LibraryRef>, unknown>>) =>
  lists.flatMap((result) => (AsyncResult.isSuccess(result) ? result.value : []))

/** The named items for ref ids (a link's `workshopAttach`): the ones in the library, in order. */
export function useLibraryItems(refIds: ReadonlyArray<string>): ReadonlyArray<ComposerLibraryItem> {
  const cards = useAtomValue(libraryListAtom("card"))
  const lorebooks = useAtomValue(libraryListAtom("lorebook"))
  const presets = useAtomValue(libraryListAtom("preset"))
  const refs = new Map(listOf([cards, lorebooks, presets]).map((ref) => [ref.id as string, ref]))
  return refIds.flatMap((refId) => {
    const ref = refs.get(refId)
    const kind = KINDS.find((entry) => entry === ref?.kind)
    return ref && kind ? [{ kind, refId: ref.id as RefId, name: ref.label }] : []
  })
}

export const registerWorkOnInWorkshop = () => [
  chatCardActions.register({ id: "workshop.work-on", order: 36, component: ChatCardWorkOnIn }),
  cardContributions.register({
    id: "workshop.work-on",
    placement: "actions",
    overflow: true,
    order: 36,
    component: CardWorkOnIn,
    menu: CardWorkOnIn
  }),
  editorActions.register({ id: "workshop.work-on", order: 25, component: editorWorkOnIn(false) }),
  panelEditorActions.register({ id: "workshop.work-on", order: 35, component: editorWorkOnIn(true) })
]
