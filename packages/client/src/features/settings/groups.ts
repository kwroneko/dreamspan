// The settings navigation's groups: headings its pages (the "settings" route's children) sit under.
import { makeRegistry } from "../../registry.ts"
import { navEntries, type RouteEntry } from "../../routes.tsx"

export interface SettingsGroup {
  readonly id: string
  readonly label: string
  readonly order: number
  /**
   * Pages (route ids) that sit in this group unless they name a group themselves
   * (`nav.group`): the core's layout, kept in one place. A page that names a group this user
   * doesn't see falls back to the groups that claim it; one that no group claims goes under "More".
   */
  readonly pages?: ReadonlyArray<string>
  /**
   * Shown to admins only. A page it claims sits in it for them, and for anyone else in the
   * next group that claims it too (else under "More").
   */
  readonly adminOnly?: boolean
}

/** The groups of the settings navigation. A plugin adds one, or overrides or disables one by id. */
export const settingsGroups = makeRegistry<SettingsGroup>()

const MORE: SettingsGroup = { id: "more", label: "More", order: Number.MAX_SAFE_INTEGER }

/** The settings pages this user sees, in their groups; groups with none are left out. */
export const settingsNav = (isAdmin: boolean) => {
  const groups = settingsGroups
    .list()
    .filter((group) => isAdmin || !group.adminOnly)
    .sort((a, b) => a.order - b.order)
  // A page in several groups' lists sits in an admin-only one first: the place made for admins.
  const claiming = [...groups.filter((group) => group.adminOnly), ...groups.filter((group) => !group.adminOnly)]
  const groupOf = (entry: RouteEntry) => {
    const named = groups.find((group) => group.id === entry.nav?.group)
    return named ?? claiming.find((group) => group.pages?.includes(entry.id)) ?? MORE
  }
  const pages = navEntries("settings", isAdmin)
  return [...groups, MORE]
    .map((group) => ({ group, pages: pages.filter((entry) => groupOf(entry).id === group.id) }))
    .filter((section) => section.pages.length > 0)
}
