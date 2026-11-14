import { completionSound } from "./completionSoundPart.tsx"
import { noticeChannels } from "./noticeContributions.tsx"

export const register = () => noticeChannels.register(completionSound)
