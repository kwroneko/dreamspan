// Whose summaries the Summaries panel, the rail, the timeline and the history search show in a chat
// with separate contexts (spec/CHARACTER-CONTEXT.md §2.3, unit C7's reads), or with one shared
// context once a join kept each character to its own thread (spec/THREADS.md §7.3, TH7): the
// shared ones, or a character's, which are the shared ones up to where it missed something and
// its own from there.
// The choice is the tab's URL (`summariesOf`), so a reload or a copied link shows the same view;
// a character no longer offered there reads as Shared. A summary written for one character
// carries that character's name.
import type { EntityId } from "@dreamspan/shared/chat.ts"
import type { Cast } from "@dreamspan/shared/chatSetupApi.ts"
import type { LcmState, LcmSummary } from "@dreamspan/shared/lcm.ts"
import { useEffect, useSyncExternalStore } from "react"
import { usePlaceParam } from "../../usePlaceParam.ts"
import { Field } from "../../ui/Field.tsx"
import { Select } from "../../ui/Select.tsx"
import type { ChatSession } from "./session.ts"

const SHARED = "shared"
/** The URL's key for whose summaries are shown; absent: the shared ones. */
const SUMMARIES_OF = "summariesOf"

/**
 * The characters that can have summaries of their own: not a narrator or a persona. None in a
 * shared context, unless a join on this path kept each character to its own thread (`stretchViews`).
 */
export const summaryViewers = (cast: Cast | null, lcm: Pick<LcmState, "stretchViews"> | null = null) => {
  if (cast === null || (cast.contextPerSpeaker !== "separate" && lcm?.stretchViews !== true)) return []
  const name = (id: string) => {
    const card = cast.cards.find((c) => c.entityId === id)
    return card?.name ?? "Unnamed"
  }
  return cast.participants
    .filter((id) => !cast.playedByMe.includes(id) && cast.roles?.[id] !== "narrator")
    .map((id) => ({ id: id as EntityId, name: name(id) }))
}

/** Whose own summary this is, by name; null: shared. An audience lists a character's identities. */
export const audienceName = (summary: Pick<LcmSummary, "audience">, cast: Cast | null) => {
  if (!summary.audience?.length) return null
  const card = cast?.cards.find((c) => summary.audience!.includes(c.entityId))
  return card?.name ?? "One character"
}

/**
 * Keeps the session's viewer to the URL. Until the cast is read nothing changes; then an id that
 * isn't one of the characters offered (a character who left, a chat set back to one context, a
 * mistyped link) falls back to Shared and leaves the URL.
 */
export function useSummariesOfUrl(session: ChatSession) {
  const cast = useSyncExternalStore(session.subscribe, () => session.snapshot().cast)
  const lcm = useSyncExternalStore(session.subscribe, () => session.snapshot().lcm)
  const [raw, setRaw] = usePlaceParam(SUMMARIES_OF, "")
  // A shared context offers characters only once the summaries say a join made them views.
  const loaded = cast !== null && (cast.contextPerSpeaker === "separate" || lcm !== null)
  const viewer = loaded && summaryViewers(cast, lcm).some((v) => v.id === raw) ? (raw as EntityId) : null
  useEffect(() => {
    if (!loaded) return
    session.setLcmViewer(viewer)
    if (raw !== "" && viewer === null) setRaw("", true)
  }, [session, loaded, viewer, raw, setRaw])
}

/** What the choice does in a chat with separate contexts. */
const SEPARATE_ABOUT =
  "With separate contexts, a character who missed part of the chat gets summaries of its own from where it missed something, written from what it knew; before that it reads the shared ones. Pick a character to see what its replies read. Example: Wren was away for messages 40–55, so Wren's summaries from 40 on leave that stretch out."

/** What it does in a chat with one shared context after a join that kept each to its own thread. */
const JOIN_ABOUT =
  "A join here kept each character to its own thread, so a character who missed one of them gets summaries of its own from there, written from what it knew; before that it reads the shared ones. Pick a character to see what its replies read. Example: Wren was at the docks while Mira was at the Lantern, so Wren's summaries leave the Lantern out."

export function SummaryViewer({
  session,
  about
}: {
  session: ChatSession
  /** What the choice does where it is shown; absent: what it does in this chat. */
  about?: string
}) {
  const cast = useSyncExternalStore(session.subscribe, () => session.snapshot().cast)
  const lcm = useSyncExternalStore(session.subscribe, () => session.snapshot().lcm)
  const viewer = useSyncExternalStore(session.subscribe, () => session.snapshot().lcmViewer)
  const [, setRaw] = usePlaceParam(SUMMARIES_OF, "")
  const viewers = summaryViewers(cast, lcm)
  if (viewers.length === 0) return null
  return (
    <Field label="Summaries of" about={about ?? (cast?.contextPerSpeaker === "separate" ? SEPARATE_ABOUT : JOIN_ABOUT)}>
      <Select
        items={[
          {
            value: SHARED,
            label: "Shared",
            description: "The summaries every character reads up to where it missed something."
          },
          ...viewers.map((v) => ({
            value: v.id as string,
            label: v.name,
            description: `What ${v.name}'s replies read: the shared summaries, then ${v.name}'s own.`
          }))
        ]}
        value={viewer ?? SHARED}
        onValueChange={(value) => setRaw(value === SHARED ? "" : value, true)}
      />
    </Field>
  )
}
