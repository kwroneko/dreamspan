// The message renderer is an effective registration, including in previews and dialogs.
// Plugins can replace its id, wrap the current component, or add a higher-priority renderer.
import { Component, Suspense, useSyncExternalStore, type ComponentType, type ReactNode } from "react"
import { makeRegistry } from "../registry.ts"
import { reportChunkFailure } from "../staleBuild.tsx"

export interface MessageTextProps {
  text: string
  sourceText?: string
  streaming: boolean
}
export const messageRenderers = makeRegistry<{
  id: string
  order: number
  component: ComponentType<MessageTextProps>
}>()

/** A renderer failure belongs to this body; text and registry changes give it another try. */
class MessageRenderBoundary extends Component<{
  children: ReactNode
  plain: ReactNode
  text: string
  sourceText: string | undefined
  renderer: ComponentType<MessageTextProps>
}> {
  override state = {
    failed: false,
    text: this.props.text,
    sourceText: this.props.sourceText,
    renderer: this.props.renderer
  }
  static getDerivedStateFromError() {
    return { failed: true }
  }
  override componentDidCatch(error: unknown) {
    void reportChunkFailure(error)
  }
  static getDerivedStateFromProps(props: MessageRenderBoundary["props"], state: MessageRenderBoundary["state"]) {
    if (props.text !== state.text || props.sourceText !== state.sourceText || props.renderer !== state.renderer)
      return { failed: false, text: props.text, sourceText: props.sourceText, renderer: props.renderer }
    return null
  }
  override render() {
    return this.state.failed ? this.props.plain : this.props.children
  }
}

export function Markdown(props: MessageTextProps) {
  const snapshot = useSyncExternalStore(
    messageRenderers.subscribe,
    messageRenderers.snapshot,
    messageRenderers.snapshot
  )
  const renderer = [...snapshot.entries].sort((a, b) => b.order - a.order)[0]
  const plain = (
    <div
      className="markdown whitespace-pre-wrap"
      data-source-map={
        props.sourceText === undefined || props.sourceText === props.text
          ? JSON.stringify({ chars: 0, length: props.text.length, start: 0, end: props.text.length })
          : undefined
      }
    >
      {props.text}
    </div>
  )
  return renderer ? (
    <MessageRenderBoundary plain={plain} text={props.text} sourceText={props.sourceText} renderer={renderer.component}>
      <Suspense fallback={plain}>
        <renderer.component {...props} />
      </Suspense>
    </MessageRenderBoundary>
  ) : (
    plain
  )
}
