import { Switch } from "../../ui/Choice.tsx"
import { Tooltip } from "../../ui/Tooltip.tsx"
import { useViewPrefs } from "../../ui/viewPrefs.ts"

/** The same account choice at the boundary and in the Summaries tab. */
export function TimelineToggle() {
  const viewer = useViewPrefs()
  return (
    <div className="text-sm">
      <Tooltip label="Shows the summaries the model reads in place of the older messages. Each opens to its messages. For every chat.">
        <span className="inline-flex">
          <Switch
            checked={viewer.prefs.timeline === "summaries"}
            disabled={!viewer.ready || viewer.pending}
            onCheckedChange={(on) => void viewer.change({ timeline: on ? "summaries" : "originals" })}
          >
            Summaries in chat
          </Switch>
        </span>
      </Tooltip>
      {viewer.error && (
        <p role="alert" className="text-danger">
          {viewer.error.message}
        </p>
      )}
    </div>
  )
}
