// The workshop's card on the Chats page (spec/WORKSHOP.md §2.2): where a workshop of its own is
// started. One beside a story is made from that story (SidePanel.tsx), never by slipping into one.
// The assistant's card and the user's persona start as the workshop defaults; choosing others
// here changes only the new workshop (spec/WORKSHOP-CONTEXT.md §4.3). The choice is in the URL.
// New workshop makes nothing (owner, 2026-11-17: "The chat is created when the first message is
// sent"): it opens the workshop not made yet (`/new/workshop`, StartWorkshopPage.tsx) with these
// choices and the title, where they can still change, and its first message makes it.
import { SidebarStartLink } from "../characters/NewCharacterChat.tsx"
import type { EntityId } from "@dreamspan/shared/chat.ts"
import { useAtomValue } from "@effect/atom-react"
import type { RefId } from "@dreamspan/shared/library.ts"
import { AsyncResult } from "effect/reactivity"
import { type ReactNode, useEffect } from "react"
import { SlotOutlet } from "../../slots.tsx"
import { Card, CardHeader } from "../../ui/Surface.tsx"
import { usePlaceParam } from "../../usePlaceParam.ts"
import { browsable, shellAtom } from "../characters/shellData.tsx"
import { StartChatForm } from "../chat/ChatsPage.tsx"
import { cardPickers } from "../pickers/DocumentPickers.tsx"
import { PickerFooterButton, PickerPopover } from "../pickers/PickerParts.tsx"
import { workshopDefaultsAtom } from "./workshopPersona.tsx"
import { NEW_WORKSHOP_TITLE, NO_PERSONA, WORKSHOP_CARD_KEY, WORKSHOP_PERSONA_KEY } from "./workshopStart.ts"

const CARD_KEY = WORKSHOP_CARD_KEY
const PERSONA_KEY = WORKSHOP_PERSONA_KEY
const NONE = NO_PERSONA

function Choice({
  label,
  title,
  name,
  hint,
  children,
  footer
}: {
  label: string
  title: string
  name: string
  hint: string
  children: Parameters<typeof PickerPopover>[0]["children"]
  footer?: Parameters<typeof PickerPopover>[0]["footer"]
}) {
  return (
    <div className="flex min-w-0 items-center gap-2 text-sm">
      <span className="w-20 shrink-0 text-muted">{label}</span>
      <PickerPopover
        title={title}
        trigger={
          <span data-layout-name className="min-w-0 truncate">
            {name}
          </span>
        }
        triggerLabel={`${label}: ${name}`}
        triggerClassName="flex h-8 min-w-0 max-w-full items-center rounded-md border border-border px-2 text-left text-text outline-none hover:bg-surface-raised focus-visible:ring-2 focus-visible:ring-focus/40 data-popup-open:bg-surface-raised"
        hint={hint}
        side="bottom"
        {...(footer ? { footer } : {})}
      >
        {children}
      </PickerPopover>
    </div>
  )
}

/** Who the new workshop starts with: the assistant's card and the user's persona. */
export function StartChoices({
  card,
  setCard,
  persona,
  setPersona
}: {
  card: string
  setCard: (id: string, replace?: boolean) => void
  persona: string
  setPersona: (id: string, replace?: boolean) => void
}): ReactNode {
  const shell = useAtomValue(shellAtom)
  const defaults = useAtomValue(workshopDefaultsAtom)
  const data = AsyncResult.isSuccess(shell) ? browsable(shell.value) : []
  const stored = AsyncResult.isSuccess(defaults) ? defaults.value : null
  const byEntity = new Map(data.map((c) => [c.card.entityId as string, c]))
  const byRef = new Map(data.map((c) => [c.card.refId as string, c]))
  const cardId = card || stored?.card || ""
  const personaId = persona === NONE ? "" : persona || stored?.persona || ""
  // An id the library no longer has (a deleted card, a link from another account) isn't a choice:
  // it's dropped from the URL, so the card shows and starts with what it says.
  const loaded = AsyncResult.isSuccess(shell)
  const staleCard = loaded && card !== "" && !byEntity.has(card)
  const stalePersona = loaded && persona !== "" && persona !== NONE && byEntity.get(persona)?.persona !== true
  useEffect(() => {
    if (staleCard) setCard("", true)
  }, [staleCard, setCard])
  useEffect(() => {
    if (stalePersona) setPersona("", true)
  }, [stalePersona, setPersona])
  const cardName = byEntity.get(cardId)?.card.label ?? "Assistant"
  const personaName =
    persona === NONE
      ? "No persona"
      : (byEntity.get(personaId)?.card.label ??
        (persona === "" && stored?.makesPersona ? "A new persona with your name" : "No persona"))
  return (
    <div className="flex flex-col gap-1">
      <Choice
        label="Assistant"
        title="Assistant"
        name={cardName}
        hint="The card the assistant speaks as. Its skills come with it. Changing it here changes only this workshop."
      >
        {(body) => (
          <SlotOutlet
            slot={cardPickers}
            props={{
              ...body,
              value: (byEntity.get(cardId)?.card.refId ?? "") as RefId,
              persona: false,
              rowHint: ({ current }) => (current ? "The assistant now" : "The assistant speaks as this card"),
              onChoose: (refId) => {
                const chosen = byRef.get(refId)
                if (chosen) setCard(chosen.card.entityId === stored?.card ? "" : chosen.card.entityId)
              }
            }}
          />
        )}
      </Choice>
      <Choice
        label="You"
        title="Your persona"
        name={personaName}
        hint="Who you are in this workshop. Changing it here changes only this workshop."
        footer={(close) => (
          <PickerFooterButton
            hint="You take part as yourself, with no persona."
            onClick={() => {
              setPersona(NONE)
              close()
            }}
          >
            No persona
          </PickerFooterButton>
        )}
      >
        {(body) => (
          <SlotOutlet
            slot={cardPickers}
            props={{
              ...body,
              value: (byEntity.get(personaId)?.card.refId ?? "") as RefId,
              persona: true,
              personasOnly: true,
              rowHint: ({ current }) => (current ? "Your persona now" : "You take part as this persona"),
              onChoose: (refId) => {
                const chosen = byRef.get(refId)
                if (chosen) setPersona(chosen.card.entityId === stored?.persona ? "" : chosen.card.entityId)
              }
            }}
          />
        )}
      </Choice>
    </div>
  )
}

/** The workshop choices in the URL, as this card and the page of the workshop not made yet read them. */
export const useWorkshopStart = () => {
  const [card, setCard] = usePlaceParam(CARD_KEY, "")
  const [persona, setPersona] = usePlaceParam(PERSONA_KEY, "")
  return { card, setCard, persona, setPersona }
}

/** The sidebar's "New Workshop", beside New Roleplay above All chats (owner, 2026-11-24). */
export function NewWorkshopStart() {
  return (
    <SidebarStartLink
      to="/new/workshop"
      icon="tool"
      label="New Workshop"
      hint="Start a workshop: a chat with an assistant about your cards, presets and lorebooks, outside any story."
    />
  )
}

/**
 * "New Workshop with <name>" above a character's chats (owner, 2026-11-24): a new workshop whose
 * assistant speaks as that card (its personality, as in a roleplay), chosen as the start card's
 * Assistant is (`workshopCard`), and still changeable there before the first message.
 */
export function NewWorkshopWithCharacter({ entityId, label }: { entityId: EntityId; label: string }) {
  return (
    <SidebarStartLink
      to="/new/workshop"
      search={{ [CARD_KEY]: entityId }}
      icon="tool"
      label="New Workshop"
      name={label}
      hint={`Start a workshop with ${label} as the assistant: for writing and editing cards, presets and lorebooks.`}
    />
  )
}

export function WorkshopStartCard() {
  const { card, setCard, persona, setPersona } = useWorkshopStart()
  return (
    <Card>
      <CardHeader
        title="Workshop"
        about="Ask an assistant about your cards, presets and lorebooks, outside any story."
      />
      <StartChatForm
        draft={NEW_WORKSHOP_TITLE}
        label="Title of the new workshop"
        button="New workshop"
        hint="Opens a new workshop. It's saved when you send its first message. The assistant can read and change your library and set up chats."
        extra={<StartChoices card={card} setCard={setCard} persona={persona} setPersona={setPersona} />}
        to="/new/workshop"
        search={{
          ...(card === "" ? {} : { [CARD_KEY]: card }),
          ...(persona === "" ? {} : { [PERSONA_KEY]: persona })
        }}
      />
    </Card>
  )
}
