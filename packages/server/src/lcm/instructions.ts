/** Kept byte-for-byte for existing requests and direct worker callers. Execution
 * strategies supply their instructions to the reader as data, never executable code. */
export const DIRECT_INSTRUCTION = "\nReturn only the summary, without commentary."
export const TOOL_INSTRUCTION =
  "\nWrite the summary with summary_tool. Create a draft and finalize it; assistant prose is not the summary."
