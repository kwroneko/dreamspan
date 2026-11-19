// Whether a message's panels run their scripts (spec/HTML-MESSAGES.md §3.4, "Approval"): as
// display-regex approval follows its source, a panel's scripts run only when every source that
// could have written them allowed it. Its text is its character's (messageCharacter), as are
// that card's own scripts; applicable preset display scripts count too, since captures or
// multiple replacements can assemble scripts. The user's global scripts are the user's own.
// A message with no character (a user's in a group) runs none and asks nothing.
import type { EntityId } from "@dreamspan/shared/chat.ts"
import type { RefId } from "@dreamspan/shared/library.ts"
import { useCallback, useMemo, useSyncExternalStore } from "react"
import type { PanelPermit } from "../../ui/html/messageHtml.ts"
import { useDisplayContext } from "./DisplaySettings.tsx"
import { displayRegexApplies, messageCharacter } from "./displayScripts.ts"

/** A card or preset a panel comes from, with what it allowed. */
interface PanelSource {
  readonly refId: RefId
  readonly name: string
  readonly scripts: boolean
  readonly network: boolean
}

/** Runs nothing and asks nothing. */
export const OFF: PanelPermit = { scripts: false, network: false, ask: null }
const noSubscription = () => () => {}

/**
 * A preset with applicable display transforms is a source of the resulting panels. Looking
 * for script syntax in a replacement is insufficient: captures, macros and composed
 * replacements can supply it. Conservatively require its approval for any such transform.
 */
export const writesScripts = displayRegexApplies

/**
 * The permit for panels from `sources`: scripts once all of them allowed them, the internet once
 * all allowed that too, and otherwise the first one to ask. A source not read yet (null) runs
 * nothing and asks nothing, until it's known.
 */
export const panelPermit = (
  sources: ReadonlyArray<PanelSource | null>,
  allow: (refId: RefId) => Promise<boolean>
): PanelPermit => {
  if (sources.length === 0 || sources.some((source) => source === null)) return OFF
  const known = sources as ReadonlyArray<PanelSource>
  const waiting = known.find((source) => !source.scripts)
  if (waiting !== undefined)
    return { scripts: false, network: false, ask: { name: waiting.name, allow: () => allow(waiting.refId) } }
  return { scripts: true, network: known.every((source) => source.network), ask: null }
}

/** The permit for a message's panels; undefined outside a chat view or with HTML shown as text. */
export function usePanelPermit(speaker: EntityId | null, placement: 1 | 2): PanelPermit | undefined {
  const display = useDisplayContext()
  const panels = display.panels
  const characterId = panels === null ? null : messageCharacter(panels.cast, speaker, placement)
  const read = useCallback(() => panels?.cards.panels(characterId) ?? null, [panels, characterId])
  const card = useSyncExternalStore(panels?.cards.subscribe ?? noSubscription, read)
  const presetWrites = useMemo(() => writesScripts(display.preset, placement), [display.preset, placement])
  return useMemo(() => {
    if (panels === null) return undefined
    if (characterId === null) return OFF
    return panelPermit([card, ...(presetWrites ? [panels.preset] : [])], panels.allow)
  }, [panels, characterId, card, presetWrites])
}
