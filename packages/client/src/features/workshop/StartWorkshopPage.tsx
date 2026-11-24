// /new/workshop: a workshop of its own before it exists (owner, 2026-11-17: "The chat is created
// when the first message is sent"). The Chats page's New workshop opens it, making nothing: the
// chat's surface with the workshop's header (its title, "new", the kind's badge), an intro where
// its messages will be with the start card's choices (the assistant, the persona, in the URL as
// there) and its title (the same draft as the card's), still changeable, and the saved
// workshop's composer (`PendingWorkshop`). The first send makes it, then its page opens in place.
import type { CastCard } from "@dreamspan/shared/chat.ts"
import { useAtomValue } from "@effect/atom-react"
import { useNavigate } from "@tanstack/react-router"
import { AsyncResult } from "effect/reactivity"
import { Input } from "../../ui/Field.tsx"
import { Badge } from "../../ui/Surface.tsx"
import { Tooltip } from "../../ui/Tooltip.tsx"
import { useViewPrefs } from "../../ui/viewPrefs.ts"
import { useUserDraft, UserDraftStatus } from "../editor/userDraft.tsx"
import { aboutLine, ChatHeaderFrame } from "../chat/ChatHeader.tsx"
import { KindBadge } from "../chat/KindBadge.tsx"
import { useTitle } from "../shell.tsx"
import { PendingWorkshop } from "./PendingWorkshop.tsx"
import { StartChoices, useWorkshopStart } from "./StartCard.tsx"
import { workshopDefaultsAtom } from "./workshopPersona.tsx"
import { NEW_WORKSHOP_COPY, NEW_WORKSHOP_TITLE } from "./workshopStart.ts"

const INTRO =
  "Ask an assistant about your cards, presets and lorebooks, outside any story. It can read and change your library and set up chats. Your first message starts the workshop."

export function StartWorkshopPage() {
  const navigate = useNavigate()
  const prefs = useViewPrefs().prefs
  const { card, setCard, persona, setPersona } = useWorkshopStart()
  const defaults = useAtomValue(workshopDefaultsAtom)
  const stored = AsyncResult.isSuccess(defaults) ? defaults.value : null
  const titleDraft = useUserDraft(NEW_WORKSHOP_TITLE, "Title", "")
  const title = titleDraft.text.trim() || "New workshop"
  useTitle(title)
  // The assistant's portrait where the saved workshop's header shows it, so the first send moves nothing.
  const header = (characters: ReadonlyArray<CastCard>) => (
    <ChatHeaderFrame
      characters={characters}
      portraitsOpen={false}
      loading={false}
      about={aboutLine(characters, title, null)}
      actions={null}
      title={
        <>
          <h1 className="min-w-0 truncate text-base font-semibold">{title}</h1>
          <Tooltip label="Not saved yet: sending the first message saves the workshop.">
            <span
              tabIndex={0}
              className="shrink-0 rounded-md outline-none focus-visible:ring-2 focus-visible:ring-focus"
            >
              <Badge>new</Badge>
            </span>
          </Tooltip>
          <KindBadge kind="workshop" />
        </>
      }
    />
  )
  const intro = (
    <div data-workshop-intro="" className="mx-3 flex flex-col gap-2 rounded-lg bg-surface-raised px-3 py-2">
      <p className="text-sm text-muted">{INTRO}</p>
      <UserDraftStatus draft={titleDraft} />
      <StartChoices card={card} setCard={setCard} persona={persona} setPersona={setPersona} />
      <Input
        aria-label="Title of the new workshop"
        placeholder="Title (optional)"
        value={titleDraft.text}
        disabled={!titleDraft.ready}
        onChange={(event) => titleDraft.setText(event.currentTarget.value)}
      />
    </div>
  )
  return (
    <div data-fill className="flex min-h-0 min-w-0 flex-1 flex-col">
      <PendingWorkshop
        start={{ card, persona }}
        // Your persona at the speaker chip is the same choice as the card's You.
        onPersona={(id) => setPersona(id === stored?.persona ? "" : id)}
        title={titleDraft.text}
        header={header}
        intro={intro}
        copyKey={NEW_WORKSHOP_COPY}
        portraitWidth={{ small: 48, default: 60, large: 72, largest: 84 }[prefs.portraitSize]}
        onTitleSent={() => titleDraft.commit(titleDraft.text, async () => true)}
        // Its own page opens in place: the same surface, now saved.
        onCreated={(chat) => void navigate({ to: "/chats/$chatId", params: { chatId: chat.id }, replace: true })}
      />
    </div>
  )
}
