import { Switch } from "../../ui/Choice.tsx"
import { useViewPrefs } from "../../ui/viewPrefs.ts"

/** The same account choice at the boundary and in the Summaries tab. */
export function TimelineToggle() {
  const viewer = useViewPrefs()
  return (
    <div className="text-sm">
      <Switch
        checked={viewer.prefs.timeline === "summaries"}
        disabled={!viewer.ready || viewer.pending}
        onCheckedChange={(on) => void viewer.change({ timeline: on ? "summaries" : "originals" })}
      >
        Summaries in chat
      </Switch>
      {viewer.error && (
        <p role="alert" className="text-danger">
          {viewer.error.message}
        </p>
      )}
    </div>
  )
}
