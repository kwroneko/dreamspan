// A message's text as it displays (ARCHITECTURE §10, "Opt-in display transformations"): the
// registered display transforms, macros then display regex, with the scripts of the registered
// lists for its placement. Its body, its reasoning and its "Thinking in the reply" panel all
// display through here, while they stream too, as ST formats a message on every update.
import type { SlotId, Version } from "@rp/shared/chat.ts"
import type { RegexScript } from "@rp/shared/docs/regexScript.ts"
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react"
import { useViewPrefs } from "../../ui/viewPrefs.ts"
import { castView, modelNameOf, useCast } from "./cast.ts"
import { applyDisplayTransforms, type DisplayInput, displayTransforms } from "./displayPipeline.ts"
import { useDisplayContext } from "./DisplaySettings.tsx"
import {
  displayRegexApplies,
  displayScriptLists,
  displayScripts,
  messageCharacter,
  sameScripts
} from "./displayScripts.ts"
import { displayText } from "./macros.ts"
import type { ChatSession } from "./session.ts"

const NO_SCRIPTS: ReadonlyArray<RegexScript> = []
const noSubscription = () => () => {}

/** Where a text displays: its version, and the message's place in the chat. */
export interface DisplayAt {
  readonly version: Version
  readonly session: ChatSession
  readonly parentSlotId: SlotId | null
  readonly depth: number
}

/**
 * The text through the display transforms. Until they answer it shows their last answer for
 * the version, or its macros expanded. A streaming text runs them one at a time, each on the
 * newest text, so a frame never shows text a display script hides; before their first answer
 * it shows nothing where a display script applies (`text: null`). A finished text that waits
 * for its first answer is `pending`: shown invisibly, so it keeps its place without showing
 * what a display script hides. `current` says the shown text came from the scripts, preferences
 * and transforms in effect now (by content: a library refresh with the same scripts keeps it),
 * which a panel's permissions are about: its scripts must not run on text the previous sources
 * wrote (Message.tsx).
 */
export function useDisplayed(
  at: DisplayAt,
  text: string,
  placement: 1 | 2 | 6,
  streaming: boolean
): {
  readonly text: string | null
  readonly issues: ReadonlyArray<string>
  readonly pending?: boolean
  /** The text came from the scripts, preferences and transforms in effect now. */
  readonly current: boolean
} {
  const { version, session, parentSlotId, depth } = at
  const viewer = useViewPrefs()
  const needsContext = version.macroMode === "template" || viewer.prefs.outputMacros || viewer.prefs.displayRegex
  const cast = useCast()
  const read = useCallback(
    () => (needsContext ? session.castAfter(parentSlotId) : undefined),
    [session, parentSlotId, needsContext]
  )
  const subscribe = useCallback(
    (listener: () => void) => session.subscribePosition(parentSlotId, listener),
    [session, parentSlotId]
  )
  const positionCast = useSyncExternalStore(subscribe, read)
  // The speaker card's own fields, for `{{description}}` and the like, as the preview had them.
  const readFields = useCallback(
    () => (!needsContext || version.speakerEntityId === null ? undefined : session.cardFields(version.speakerEntityId)),
    [session, version.speakerEntityId, needsContext]
  )
  const fields = useSyncExternalStore(session.subscribePositions, readFields)
  const here = useMemo(
    () => (positionCast ? castView(positionCast, [...cast.cards.values()]) : cast),
    [positionCast, cast]
  )
  const display = useDisplayContext()
  const characterId = messageCharacter(display.cast, version.speakerEntityId, placement === 1 ? 1 : 2)
  const readCharacterScripts = useCallback(
    () => display.cards?.get(characterId) ?? NO_SCRIPTS,
    [display.cards, characterId]
  )
  const character = useSyncExternalStore(display.cards?.subscribe ?? noSubscription, readCharacterScripts)
  const lists = useSyncExternalStore(displayScriptLists.subscribe, displayScriptLists.snapshot)
  const scripts = useMemo(
    () =>
      displayScripts(lists.entries, {
        global: display.global,
        preset: display.preset,
        character,
        characterId,
        placement
      }),
    [lists, display.global, display.preset, character, characterId, placement]
  )
  const stages = useSyncExternalStore(displayTransforms.subscribe, displayTransforms.snapshot)
  const input = useMemo(
    (): DisplayInput => ({
      text,
      version,
      names: { user: here.user, char: modelNameOf(here, version.speakerEntityId) ?? here.char },
      card: fields ?? {},
      prefs: viewer.prefs,
      scripts,
      placement,
      depth: display.leafDepth === null ? null : Math.max(0, display.leafDepth - depth)
    }),
    [text, version, here, fields, viewer.prefs, scripts, display.leafDepth, depth, placement]
  )
  const [result, setResult] = useState<{
    input: DisplayInput
    stages: typeof stages
    text: string
    issues: ReadonlyArray<string>
  } | null>(null)
  const latest = useRef({ input, stages })
  // Before the run below: a run that ends takes the newest input from here.
  useEffect(() => {
    latest.current = { input, stages }
  }, [input, stages])
  const running = useRef(false)
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  useEffect(() => {
    if (!streaming) {
      let active = true
      void applyDisplayTransforms(input, stages.entries).then((value) => {
        if (active) setResult({ input, stages, ...value })
      })
      return () => {
        active = false
      }
    }
    // Streaming: what arrives during a run is taken by the next one.
    if (running.current) return
    running.current = true
    const next = () => {
      const job = latest.current
      void applyDisplayTransforms(job.input, job.stages.entries).then((value) => {
        if (!mounted.current) return
        setResult({ ...job, ...value })
        if (latest.current.input !== job.input || latest.current.stages !== job.stages) next()
        else running.current = false
      })
    }
    next()
  }, [input, stages, streaming])
  if (result?.input === input && result.stages === stages) return { ...result, current: true }
  // Until the transforms answer: what they last said of this version (a reply that just
  // finished keeps its streamed display rather than flashing its text without the scripts).
  if (result && result.input.version.id === version.id)
    return {
      text: result.text,
      issues: streaming ? [] : result.issues,
      current:
        result.stages === stages &&
        result.input.prefs.displayRegex === viewer.prefs.displayRegex &&
        sameScripts(result.input.scripts, scripts)
    }
  const expanded = displayText(text, version.macroMode, input.names, input.card, version.frozenMacros ?? {})
  if (viewer.prefs.displayRegex && displayRegexApplies(scripts, placement))
    return streaming
      ? { text: null, issues: [], current: false }
      : { text: expanded, issues: [], pending: true, current: false }
  // No display script applies: nothing but the text itself is what a panel's sources wrote.
  return { text: expanded, issues: [], current: true }
}
