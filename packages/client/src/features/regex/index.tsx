// The account's global regex scripts (ST's "Global scripts"): a settings page. They run in
// every chat before the preset's and the character's, with no approval: they're the user's own.
import { routes } from "../../routes.tsx"
import { GlobalRegexPage } from "./GlobalRegexPage.tsx"

export const register = () =>
  routes.register({
    id: "settings.regex",
    parent: "settings",
    path: "regex",
    component: GlobalRegexPage,
    nav: { label: "Regex scripts", order: 22 }
  })
