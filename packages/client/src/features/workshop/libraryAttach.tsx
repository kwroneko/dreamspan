// What a workshop's paperclip attaches from the library (spec/WORKSHOP-CARDS.md §4.1): cards with
// the registered card picker (Characters / Personas / All, search, sorts), lorebooks and presets
// with the document list (Name / Modified, search), each with ticks for several. Registered as
// a plugin would register a kind of its own (chat/libraryAttachments.tsx).
import type { LibraryRef, RefId } from "@dreamspan/shared/library.ts"
import { useAtomValue } from "@effect/atom-react"
import { AsyncResult } from "effect/reactivity"
import { useAtomRevalidated } from "../../actions.tsx"
import { SlotOutlet } from "../../slots.tsx"
import { Avatar } from "../../ui/Avatar.tsx"
import { Icon } from "../../ui/Icon.tsx"
import { browsable, shellAtom } from "../characters/shellData.tsx"
import { libraryAttachKinds, type LibraryPickerProps } from "../chat/libraryAttachments.tsx"
import { libraryListAtom } from "../library/queries.ts"
import { cardPickers, documentPickers, type PickerTicks } from "../pickers/DocumentPickers.tsx"

const ticksOf = ({ chosen, toggle, attached }: LibraryPickerProps, noun: string): PickerTicks => ({
  ticked: (refId) => chosen.has(refId) || attached.has(refId),
  toggle,
  rowHint: (refId) =>
    attached.has(refId)
      ? "Already in your message."
      : chosen.has(refId)
        ? "Ticked: Attach puts it in your message. Choose it again to untick it."
        : `Ticks this ${noun} to attach.`
})

/** No row is "current" in a picking: focus starts in the search. */
const NONE = "" as RefId

function CardList(props: LibraryPickerProps) {
  return (
    <SlotOutlet
      slot={cardPickers}
      props={{
        value: NONE,
        persona: false,
        onChoose: () => {},
        onChosen: () => {},
        focus: "search",
        focusRef: props.focusRef,
        ticks: ticksOf(props, "card")
      }}
    />
  )
}

const documentList = (kind: "lorebook" | "preset") => {
  const atom = libraryListAtom(kind)
  return function DocumentList(props: LibraryPickerProps) {
    const result = useAtomRevalidated(atom)
    const refs: ReadonlyArray<LibraryRef> = AsyncResult.isSuccess(result) ? result.value : []
    return (
      <SlotOutlet
        slot={documentPickers}
        props={{
          subject: kind,
          choices: refs.map((ref) => ({
            value: ref.id,
            label: ref.label,
            subtitle: ref.subtitle || undefined,
            updatedAt: ref.updatedAt
          })),
          value: NONE,
          onChoose: () => {},
          onChosen: () => {},
          focus: "search",
          focusRef: props.focusRef,
          ticks: ticksOf(props, kind)
        }}
      />
    )
  }
}

/** A card's portrait as the shell has it now, filling the tile's height. */
function CardPicture({ refId, name }: { refId: string; name: string }) {
  const shell = useAtomValue(shellAtom)
  const card = AsyncResult.isSuccess(shell)
    ? browsable(shell.value).find((entry) => entry.card.refId === refId)?.card
    : undefined
  return (
    <Avatar
      id={card?.entityId ?? refId}
      name={card?.name ?? name}
      mediaId={card?.avatarMediaId ?? null}
      crop={card?.avatarCrop}
      size="xl"
    />
  )
}

const iconPicture = (icon: "book" | "sliders") =>
  function KindPicture() {
    return <Icon name={icon} size={32} className="text-muted" />
  }

export const registerLibraryAttach = () => [
  libraryAttachKinds.register({
    id: "card",
    order: 10,
    label: "Cards…",
    noun: "card",
    icon: "person",
    hint: "Attach cards from your library. The assistant can read and change them, and nothing else, without asking.",
    Picker: CardList,
    Picture: CardPicture
  }),
  libraryAttachKinds.register({
    id: "lorebook",
    order: 20,
    label: "Lorebooks…",
    noun: "lorebook",
    icon: "book",
    hint: "Attach lorebooks from your library. The assistant can read and change them, and nothing else, without asking.",
    Picker: documentList("lorebook"),
    Picture: iconPicture("book")
  }),
  libraryAttachKinds.register({
    id: "preset",
    order: 30,
    label: "Presets…",
    noun: "preset",
    icon: "sliders",
    hint: "Attach presets from your library. The assistant can read and change them, and nothing else, without asking.",
    Picker: documentList("preset"),
    Picture: iconPicture("sliders")
  })
]
