// Notes that replace prompts (DESIGN §4.2; spec/NOTE-OVERRIDES.md): each part registered the way
// a plugin's would be, so a plugin can override or disable any of them by id.
import { chatSurfaceProviders } from "../chat/presentation.tsx"
import { fieldViews, noteMenuItems, noteSettingSections } from "../editor/fieldViews.ts"
import { ReplaceChatProvider } from "./chat.tsx"
import { ReplacedFieldView } from "./fields.tsx"
import { CopyCurrentText, ReplacesSetting } from "./settings.tsx"

export const register = () => [
  // Inside the chat's editor workspace (`chat.preset-workspace`, order 20).
  chatSurfaceProviders.register({ id: "note-overrides.chat", order: 25, component: ReplaceChatProvider }),
  fieldViews.register({ id: "note-overrides.field", component: ReplacedFieldView }),
  noteSettingSections.register({ id: "note-overrides.replaces", order: 10, component: ReplacesSetting }),
  noteMenuItems.register({ id: "note-overrides.copy", order: 10, component: CopyCurrentText })
]
