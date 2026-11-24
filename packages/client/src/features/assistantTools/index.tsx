// Settings → Assistant tools: what the assistant's tools may use and spend, in sections other
// features register (`assistant-tools.sections`): the subagents' models and limits
// (spec/SUBAGENTS.md §5.1, §6.2) now, the terminal's settings later (spec/FILES-AND-ENVIRONMENT.md §5.4).
import { routes } from "../../routes.tsx"
import { defineSlot, SlotOutlet } from "../../slots.tsx"
import { CardHeader } from "../../ui/Surface.tsx"
import { useTitle } from "../shell.tsx"

/** The page's sections; a plugin adds one, or replaces or disables one by id. */
export const assistantToolsSections = defineSlot<Record<string, never>>("assistant-tools.sections")

function AssistantToolsPage() {
  useTitle("Assistant tools")
  return (
    <div className="flex flex-col gap-4">
      <CardHeader
        center
        title="Assistant tools"
        about="What the assistant's tools may use and spend in your chats. Nothing here sends anything by itself."
      />
      <SlotOutlet slot={assistantToolsSections} props={{}} />
    </div>
  )
}

export const register = () => {
  routes.register({
    id: "settings.assistant-tools",
    parent: "settings",
    path: "assistant-tools",
    component: AssistantToolsPage,
    nav: {
      label: "Assistant tools",
      group: "tools",
      order: 20,
      description: "What the assistant may look at always, and its subagents' models, limits and kinds."
    }
  })
}
