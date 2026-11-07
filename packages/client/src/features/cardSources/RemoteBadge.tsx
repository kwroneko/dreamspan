// Cards from a card source in a chat not made yet (spec/CARD-SOURCES.md §4.4): one quiet badge
// in the draft chat's header naming the source, and the line at the top of the card's tab
// with Add to my cards. Both go once the card is the user's.
import { useAtomValue } from "@effect/atom-react"
import { remoteOf } from "@rp/shared/cardSources.ts"
import type { CastCard } from "@rp/shared/chat.ts"
import { AsyncResult } from "effect/reactivity"
import { useState } from "react"
import { Button } from "../../ui/Button.tsx"
import { Badge } from "../../ui/Surface.tsx"
import { Tooltip } from "../../ui/Tooltip.tsx"
import { sourcesAtom, useAdoptRemote } from "./remote.ts"

/** A source's name as the user's list has it; its id until the list is in. */
function useSourceName() {
  const sources = useAtomValue(sourcesAtom)
  return (sourceId: string) =>
    (AsyncResult.isSuccess(sources) ? sources.value.sources.find((s) => s.id === sourceId)?.name : undefined) ??
    sourceId
}

/** The header's badge: the source each card not added yet is from. */
export function RemoteSourceBadges({ cards }: { cards: ReadonlyArray<CastCard> }) {
  const sourceName = useSourceName()
  const bySource = new Map<string, Array<string>>()
  for (const card of cards) {
    const from = remoteOf(card.entityId)
    if (from) bySource.set(from.sourceId, [...(bySource.get(from.sourceId) ?? []), card.name])
  }
  return [...bySource].map(([sourceId, names]) => {
    const name = sourceName(sourceId)
    return (
      <Tooltip
        key={sourceId}
        label={`${names.join(", ")} ${names.length === 1 ? "is" : "are"} from ${name} and ${names.length === 1 ? "isn't" : "aren't"} in your cards yet. Sending a message or Add to my cards adds ${names.length === 1 ? "it" : "them"}.`}
      >
        <span
          data-remote-source={sourceId}
          tabIndex={0}
          className="shrink-0 rounded-md outline-none focus-visible:ring-2 focus-visible:ring-focus"
        >
          <Badge>{name}</Badge>
        </span>
      </Tooltip>
    )
  })
}

/**
 * The card tab's line for a card not added yet: "From <source> · not in your cards", with
 * Add to my cards at its end. `onAdded` gets the user's card once it's theirs.
 */
export function RemoteCardLine({ card, onAdded }: { card: CastCard; onAdded?: (entityId: string) => void }) {
  const from = remoteOf(card.entityId)
  const sourceName = useSourceName()
  const adopt = useAdoptRemote()
  const [adding, setAdding] = useState(false)
  if (!from) return null
  const name = sourceName(from.sourceId)
  return (
    <div data-remote-card-line className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
      <p className="min-w-0 text-sm text-muted">From {name} · not in your cards</p>
      <Button
        variant="secondary"
        disabled={adding}
        hint={`Adds ${card.name} to your cards without starting a chat.`}
        onClick={() => {
          setAdding(true)
          void adopt(from.sourceId, name, from.remoteId).then((added) => {
            setAdding(false)
            if (added) onAdded?.(added.entityId)
          })
        }}
      >
        Add to my cards
      </Button>
    </div>
  )
}
