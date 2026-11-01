import type { CardSaved } from "../editor/cardSaved.ts"
import { useState, useSyncExternalStore } from "react"
import type { EntityId } from "@rp/shared/chat.ts"
import { useSession } from "../../session.ts"
import { Button } from "../../ui/Button.tsx"
import { usePending } from "./pending.ts"
import { CardSavedFlow } from "../editor/CardSavedFlow.tsx"
import { cardSavedContribution, cardSavedContributions } from "../editor/cardSaved.ts"

export function Resume({ entityId }: { entityId: EntityId }) {
  const user = useSession().user.id
  const pending = usePending(user, entityId)
  const [opened, setOpened] = useState<CardSaved | null>(null)
  useSyncExternalStore(
    cardSavedContributions.subscribe,
    cardSavedContributions.snapshot,
    cardSavedContributions.snapshot
  )
  if (!opened && (!pending || !cardSavedContribution(pending))) return null
  return (
    <>
      <Button
        hint="Asks again whether to put the card's new name in place of the old one in past messages."
        onClick={() => setOpened(pending)}
      >
        Resume history replacement
      </Button>
      {opened && <CardSavedFlow change={opened} onDone={() => setOpened(null)} />}
    </>
  )
}
