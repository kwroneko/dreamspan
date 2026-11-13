import type { ComponentProps } from "react"
import type { Effect } from "effect"
import { useAction } from "./actions.tsx"
import { Button } from "./ui/Button.tsx"
import { usePluginFailure } from "./pluginBoundary.tsx"

function PluginButton(props: ComponentProps<typeof Button>) {
  const fail = usePluginFailure()
  return (
    <Button
      {...props}
      onClick={(event) => {
        try {
          Promise.resolve(props.onClick?.(event)).catch(fail)
        } catch {
          fail()
        }
      }}
    />
  )
}
function PluginIconButton(props: ComponentProps<typeof Button>) {
  return <PluginButton {...props} className={`h-9 w-9 p-0 ${props.className ?? ""}`} />
}
/** @public Browser plugin UI facade. */
export const ui = Object.freeze({ Button: PluginButton, IconButton: PluginIconButton })
function usePluginAction() {
  const action = useAction()
  return {
    ...action,
    run: (tag: string, payload: unknown) =>
      action.run((client) =>
        (client as unknown as (tag: string, payload: unknown) => Effect.Effect<unknown, unknown>)(tag, payload)
      )
  }
}
/** @public Browser plugin RPC facade. */
export const rpc = Object.freeze({ useAction: usePluginAction })
