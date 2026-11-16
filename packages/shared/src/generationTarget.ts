// A reply generation has an explicit destination and never invents message ids.
import type { VersionId } from "./chat.ts"

export type GenerationTarget = { readonly kind: "version"; readonly versionId: VersionId }
