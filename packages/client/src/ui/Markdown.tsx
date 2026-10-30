// The message renderer is an effective registration, including in previews and dialogs.
// Plugins can replace its id, wrap the current component, or add a higher-priority renderer.
import { Suspense, useSyncExternalStore, type ComponentType } from "react"
import { makeRegistry } from "../registry.ts"

export interface MessageTextProps {
  text: string
  streaming: boolean
}
export const messageRenderers = makeRegistry<{
  id: string
  order: number
  component: ComponentType<MessageTextProps>
}>()

export function Markdown(props: MessageTextProps) {
  const snapshot = useSyncExternalStore(
    messageRenderers.subscribe,
    messageRenderers.snapshot,
    messageRenderers.snapshot
  )
  const renderer = [...snapshot.entries].sort((a, b) => b.order - a.order)[0]
  const plain = <div className="markdown whitespace-pre-wrap">{props.text}</div>
  return renderer ? (
    <Suspense fallback={plain}>
      <renderer.component {...props} />
    </Suspense>
  ) : (
    plain
  )
}
