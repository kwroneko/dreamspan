// The settings navigation's groups: headings its pages (the "settings" route's children) sit under.
import { makeRegistry } from "../../registry.ts"
import { navEntries, type RouteEntry } from "../../routes.tsx"

export interface SettingsGroup {
  readonly id: string
  readonly label: string
  readonly order: number
  /**
   * Pages (route ids) that sit in this group unless they name a group themselves
   * (`nav.group`): the core's layout, kept in one place. A page that names a group not
   * registered, or that no group claims, goes under "More".
   */
  readonly pages?: ReadonlyArray<string>
}

/** The groups of the settings navigation. A plugin adds one, or overrides or disables one by id. */
export const settingsGroups = makeRegistry<SettingsGroup>()

const MORE: SettingsGroup = { id: "more", label: "More", order: Number.MAX_SAFE_INTEGER }

/** The settings pages this user sees, in their groups; groups with none are left out. */
export const settingsNav = (isAdmin: boolean) => {
  const groups = settingsGroups.list()
  const groupOf = (entry: RouteEntry) => {
    const named = entry.nav?.group
    const claimed = named === undefined ? groups.find((group) => group.pages?.includes(entry.id)) : undefined
    return groups.find((group) => group.id === named) ?? claimed ?? MORE
  }
  const pages = navEntries("settings", isAdmin)
  return [...groups, MORE]
    .sort((a, b) => a.order - b.order)
    .map((group) => ({ group, pages: pages.filter((entry) => groupOf(entry).id === group.id) }))
    .filter((section) => section.pages.length > 0)
}
