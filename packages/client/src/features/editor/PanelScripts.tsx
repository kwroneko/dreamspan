import { ExternalMediaChoice } from "../chat/externalMedia.tsx"
// A card's or preset's panel permissions (spec/HTML-MESSAGES.md §3.4, §3.5): "Run panel scripts"
// and, once they run, "Let panels use the internet". Only SetHtmlApproval changes them, never
// a draft, an import or a merge (`html_scripts_approved`, `html_network_approved`).
import { useState } from "react"
import { ErrorAlert } from "../../actions.tsx"
import type { AppError } from "../../errors.ts"
import { Switch } from "../../ui/Choice.tsx"
import { Card, CardHeader } from "../../ui/Surface.tsx"
import { useCaller } from "./caller.ts"
import { type EditorStore, useEditorState, useValue } from "./store.ts"

const WHO = { card: "this card draws", preset: "this preset's scripts draw" } as const

function PanelScripts({ store, holder }: { store: EditorStore; holder: "card" | "preset" }) {
  const call = useCaller()
  const scripts = useValue<boolean>(store, ["html_scripts_approved"]) === true
  const networkSet = useValue<boolean>(store, ["html_network_approved"]) === true
  const network = scripts && networkSet
  const { snapshot } = useEditorState(store)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<AppError | null>(null)

  const set = async (next: { scripts: boolean; network: boolean }) => {
    setPending(true)
    setError(null)
    const result = await call(
      (client) =>
        client("SetHtmlApproval", {
          refId: store.refId,
          scripts: next.scripts,
          network: next.scripts && next.network,
          expectedRowVersion: snapshot!.ref.rowVersion
        }),
      ["library"]
    )
    setPending(false)
    if (result.ok) await store.refresh()
    else setError(result.error)
  }

  return (
    <Card>
      <CardHeader title="Panels" />
      <div className="flex flex-col gap-3">
        <ErrorAlert error={error} />
        {holder === "card" && snapshot && (
          <ExternalMediaChoice
            target={{ _tag: "Card", id: snapshot.ref.entityId }}
            label="Images from other sites from this card"
          />
        )}
        <Switch
          checked={scripts}
          disabled={pending || snapshot === null}
          onCheckedChange={(on) => void set({ scripts: on, network: on && network })}
          about={`Panels are boxes ${WHO[holder]} in messages. Their scripts run walled off: they can't reach your account, your chats or other sites.`}
        >
          Run panel scripts
        </Switch>
        <Switch
          checked={network}
          disabled={pending || !scripts || snapshot === null}
          onCheckedChange={(on) => void set({ scripts: true, network: on })}
          about="Panels can then load from other sites and send them what they show, your messages included. Only with their scripts running."
        >
          Let panels use the internet
        </Switch>
      </div>
    </Card>
  )
}

/** The card editor's Panels section, registered in `cardEditorSections`. */
export const CardPanelScripts = ({ store }: { store: EditorStore }) => <PanelScripts store={store} holder="card" />

/** The preset editor's Panels section, registered in `presetEditorSections`. */
export const PresetPanelScripts = ({ store }: { store: EditorStore }) => <PanelScripts store={store} holder="preset" />
