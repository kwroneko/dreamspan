import { Switch } from "../../ui/Choice.tsx"
import { Tooltip } from "../../ui/Tooltip.tsx"
import { useViewPrefs } from "../../ui/viewPrefs.ts"
import { useSummariesInChat } from "./chatViewParams.ts"

/**
 * The same choice at the boundary and in the Summaries tab: this pane's, and the account's
 * default for chats opened later (chatViewParams.ts).
 */
export function TimelineToggle() {
  const viewer = useViewPrefs()
  const [on, setOn] = useSummariesInChat()
  return (
    <div className="text-sm">
      <Tooltip label="Show the summaries the model reads in place of older messages; each opens to its messages. Chats you open next start the same way.">
        <span className="inline-flex">
          <Switch checked={on} onCheckedChange={setOn}>
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
