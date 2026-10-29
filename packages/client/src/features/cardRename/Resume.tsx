import type { CardSaved } from "../editor/cardSaved.ts"
import { useState } from "react"
import type { EntityId } from "@rp/shared/chat.ts"
import { useSession } from "../../session.ts"
import { Button } from "../../ui/Button.tsx"
import { usePending } from "./pending.ts"
import { RenameHistory } from "./RenameHistory.tsx"

export function Resume({ entityId }: { entityId: EntityId }) {
  const user = useSession().user.id
  const pending = usePending(user, entityId)
  const [opened, setOpened] = useState<CardSaved | null>(null)
  if (!pending && !opened) return null
  return (
    <>
      <Button onClick={() => setOpened(pending)}>Resume history replacement</Button>
      {opened && <RenameHistory change={opened} onDone={() => setOpened(null)} />}
    </>
  )
}
