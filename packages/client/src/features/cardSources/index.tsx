// Card sources: the built-in site recognizers. The card editor places `CardSources`.
import { builtinRecognizers, sourceRecognizers } from "./sources.ts"

export { CardSources } from "./CardSources.tsx"
export { cardSources, sourceRecognizers } from "./sources.ts"
export type { CardSource, SourceInput, SourceLink, SourceRecognizer } from "./sources.ts"

export const register = () => builtinRecognizers.map((recognizer) => sourceRecognizers.register(recognizer))
