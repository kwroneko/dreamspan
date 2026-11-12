// Whose summaries the Summaries panel, the rail, the timeline and the history search show in a chat
// with separate contexts (spec/CHARACTER-CONTEXT.md §2.3, unit C7's reads): the shared ones, or a
// character's, which are the shared ones up to where it missed something and its own from there.
// The choice is the tab's URL (`summariesOf`), so a reload or a copied link shows the same view;
// a character no longer offered there reads as Shared. A summary written for one character
// carries that character's name.
import type { EntityId } from "@rp/shared/chat.ts"
import type { Cast } from "@rp/shared/chatSetupApi.ts"
import type { LcmSummary } from "@rp/shared/lcm.ts"
import { useEffect, useSyncExternalStore } from "react"
import { usePlaceParam } from "../../usePlaceParam.ts"
import { Field } from "../../ui/Field.tsx"
import { Select } from "../../ui/Select.tsx"
import type { ChatSession } from "./session.ts"

const SHARED = "shared"
/** The URL's key for whose summaries are shown; absent: the shared ones. */
const SUMMARIES_OF = "summariesOf"

/** The characters that can have summaries of their own: not a narrator or a persona; none in a shared context. */
export const summaryViewers = (cast: Cast | null) => {
  if (cast === null || cast.contextPerSpeaker !== "separate") return []
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
  const [raw, setRaw] = usePlaceParam(SUMMARIES_OF, "")
  const loaded = cast !== null
  const viewer = loaded && summaryViewers(cast).some((v) => v.id === raw) ? (raw as EntityId) : null
  useEffect(() => {
    if (!loaded) return
    session.setLcmViewer(viewer)
    if (raw !== "" && viewer === null) setRaw("", true)
  }, [session, loaded, viewer, raw, setRaw])
}

export function SummaryViewer({
  session,
  about = "With separate contexts, a character who missed part of the chat gets summaries of its own from where it missed something, written from what it knew; before that it reads the shared ones. Pick a character to see what its replies read. Example: Wren was away for messages 40–55, so Wren's summaries from 40 on leave that stretch out."
}: {
  session: ChatSession
  /** What the choice does where it is shown. */
  about?: string
}) {
  const cast = useSyncExternalStore(session.subscribe, () => session.snapshot().cast)
  const viewer = useSyncExternalStore(session.subscribe, () => session.snapshot().lcmViewer)
  const [, setRaw] = usePlaceParam(SUMMARIES_OF, "")
  const viewers = summaryViewers(cast)
  if (viewers.length === 0) return null
  return (
    <Field label="Summaries of" about={about}>
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
