import { Switch } from "../../ui/Choice.tsx"
import { Tooltip } from "../../ui/Tooltip.tsx"
import { useSummariesInChat, writeSummariesInChat } from "./chatViewParams.ts"

/** The same choice at the boundary and in the Summaries tab: this browser tab's (chatViewParams.ts). */
export function TimelineToggle() {
  const on = useSummariesInChat()
  return (
    <div className="text-sm">
      <Tooltip label="Show the summaries the model reads in place of older messages; each opens to its messages. In every chat.">
        <span className="inline-flex">
          <Switch checked={on} onCheckedChange={writeSummariesInChat}>
            Summaries in chat
          </Switch>
        </span>
      </Tooltip>
    </div>
  )
}
