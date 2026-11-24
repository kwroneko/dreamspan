// Links to the existing reply controls; turn picking is not duplicated in chat settings.
import { Link, useNavigate } from "@tanstack/react-router"
import { Button } from "../../ui/Button.tsx"
import { Fieldset } from "../../ui/Field.tsx"
import { Tooltip } from "../../ui/Tooltip.tsx"
import { useWorkbenchTab } from "../workbench/tab.tsx"

export function ReplyChoicesSetting() {
  const navigate = useNavigate()
  const tab = useWorkbenchTab()
  const choose = async () => {
    await navigate({
      to: ".",
      search: ({ panel: _panel, ...prev }: Record<string, unknown>) => prev,
      state: (prev) => ({ ...prev, chatPanel: true }),
      resetScroll: false
    })
    tab?.store.focusTab(tab.tabId)
    // Let a phone's sheet return focus before opening the composer's existing picker.
    window.setTimeout(() => {
      const scope = tab ? document.querySelector(`[data-workbench-tab="${CSS.escape(tab.tabId)}"]`) : document
      const trigger = scope?.querySelector<HTMLButtonElement>("[data-reply-picker] button")
      trigger?.scrollIntoView({ block: "nearest", inline: "nearest" })
      trigger?.focus()
      trigger?.click()
    }, 250)
  }
  return (
    <section aria-label="Who replies">
      <Fieldset
        legend="Who replies"
        about="Choose Auto, No one or a character under Next in the composer. Decision connections can help Auto choose who replies."
      >
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="ghost" hint="Opens the next-reply picker in the composer." onClick={() => void choose()}>
            Choose next reply
          </Button>
          <Tooltip label="Opens connections, where decision models and their decision points are set.">
            <Link
              to="/settings/connections"
              className="text-sm text-accent hover:underline focus-visible:ring-2 focus-visible:ring-focus"
            >
              Decision connections
            </Link>
          </Tooltip>
        </div>
      </Fieldset>
    </section>
  )
}
