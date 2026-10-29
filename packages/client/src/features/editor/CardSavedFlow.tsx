import { useEffect, useSyncExternalStore } from "react"
import { cardSavedContribution, cardSavedContributions, type CardSaved } from "./cardSaved.ts"

// Resolve at the rendering boundary, including recovered and already queued offers.
// A plugin replacement or disablement must apply to those offers too.
export function CardSavedFlow({ change, onDone }: { change: CardSaved; onDone: (stay?: boolean) => void }) {
  useSyncExternalStore(
    cardSavedContributions.subscribe,
    cardSavedContributions.snapshot,
    cardSavedContributions.snapshot
  )
  const contribution = cardSavedContribution(change)
  useEffect(() => {
    if (!contribution) onDone()
  }, [contribution, onDone])
  return contribution && <contribution.component change={change} onDone={onDone} />
}
