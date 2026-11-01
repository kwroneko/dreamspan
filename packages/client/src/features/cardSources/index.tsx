// Card sources: the built-in site recognizers. The card editor places `CardSources`.
import { builtinRecognizers, sourceRecognizers } from "./sources.ts"

export { CardSources } from "./CardSources.tsx"

export const register = () => builtinRecognizers.map((recognizer) => sourceRecognizers.register(recognizer))
