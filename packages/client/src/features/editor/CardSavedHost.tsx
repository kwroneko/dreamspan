import { useSession } from "../../session.ts"
import { useCardSaved } from "./cardSaved.ts"

export function CardSavedHost() {
  const request = useCardSaved(useSession().user.id)
  return request && <request.contribution.component key={request.id} change={request.change} onDone={request.onDone} />
}
