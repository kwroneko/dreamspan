// The draft a chat's summarization instruction is typed into (useUserDraft), per branch: the box
// under This chat → Summary settings and the instruction's own tab (textTabs.tsx) share it.

export const instructionTarget = (chatId: string, forkId: string | null) => `chat:${chatId}:fork:${forkId}`
export const INSTRUCTION_FIELD = "Summarization instruction"
