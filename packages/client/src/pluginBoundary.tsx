import { Component, Suspense, createContext, useContext, useEffect, type ReactNode, type ComponentType } from "react"

const FailureContext = createContext<() => void>(() => undefined)
/** UI handlers can report asynchronous errors to their entry's boundary as well. */
export const usePluginFailure = () => useContext(FailureContext)

function PendingEntry({ fail }: { readonly fail: () => void }) {
  useEffect(() => {
    const timer = setTimeout(fail, 3000)
    return () => clearTimeout(timer)
  }, [fail])
  return null
}

class EntryBoundary extends Component<
  { readonly fail: () => void; readonly children: ReactNode },
  { failed: boolean }
> {
  override state = { failed: false }
  static getDerivedStateFromError() {
    return { failed: true }
  }
  override componentDidCatch() {
    this.props.fail()
  }
  private fail = () => {
    this.setState({ failed: true })
    this.props.fail()
  }
  override render() {
    return this.state.failed ? null : (
      <FailureContext value={this.fail}>
        <Suspense fallback={<PendingEntry fail={this.fail} />}>{this.props.children}</Suspense>
      </FailureContext>
    )
  }
}

/** Each registration owns a stable boundary; built-in renderers and their props stay unchanged. */
export const pluginComponent = <P extends object>(Content: ComponentType<P>, fail: () => void) =>
  function PluginEntry(props: P) {
    return (
      <EntryBoundary fail={fail}>
        <Content {...props} />
      </EntryBoundary>
    )
  }
