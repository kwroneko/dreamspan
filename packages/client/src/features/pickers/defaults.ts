// The account's selections (GenerationDefaults), which every chat's next reply uses: read once
// for every picker, and read again when a write names "settings".
import { AppClient } from "../../rpc.ts"

export const defaultsAtom = AppClient.query("GetGenerationDefaults", undefined, { reactivityKeys: ["settings"] })
