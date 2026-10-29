import { useSession } from "../../session.ts"
import { useCardSaved } from "./cardSaved.ts"
import { CardSavedFlow } from "./CardSavedFlow.tsx"

export function CardSavedHost() {
  const request = useCardSaved(useSession().user.id)
  return request && <CardSavedFlow key={request.id} change={request.change} onDone={request.onDone} />
}
