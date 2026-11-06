// Links to the existing reply controls; turn picking is not duplicated in chat settings.
import { Link, useNavigate } from "@tanstack/react-router"
import { Button } from "../../ui/Button.tsx"
import { Fieldset } from "../../ui/Field.tsx"
import { Tooltip } from "../../ui/Tooltip.tsx"

export function SharedContextSetting() {
  return (
    <section aria-label="Context">
      <Fieldset legend="Context" about="Every reply sees the same conversation history.">
        <p className="text-sm text-muted">One shared context.</p>
      </Fieldset>
    </section>
  )
}

export function ReplyChoicesSetting() {
  const navigate = useNavigate()
  const choose = async () => {
    const trigger =
      document.querySelector<HTMLButtonElement>("[data-frame][data-focused] [data-reply-picker] button") ??
      document.querySelector<HTMLButtonElement>("[data-reply-picker] button")
    await navigate({
      to: ".",
      search: ({ panel: _panel, ...prev }: Record<string, unknown>) => prev,
      state: (prev) => ({ ...prev, chatPanel: true }),
      resetScroll: false
    })
    // Let a phone's sheet return focus before opening the composer's existing picker.
    window.setTimeout(() => {
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
