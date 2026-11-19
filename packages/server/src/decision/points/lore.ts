// The `lore` decision point (spec/AGENTIC.md §7; DESIGN §1.3 [D]: decision models can decide
// whether an entry is included, and this stays optional). Before a reply is assembled, each
// lorebook entry the keywords left out but that has a question for the decision model
// (`decision_hint`) is asked about over the recent messages; the ones it answers yes go in.
// Without a model, the keywords alone decide (today's behaviour). The admitted entries are frozen
// in the reply's snapshot (`decisionAssembly`), so a rebuild of the context is exact.
import type { DecisionQuestion } from "@dreamspan/shared/decisions.ts"
import type { DecisionPoint } from "../engine.ts"

/** At most this many entries are asked about per reply; the highest-ordered first. */
const MAX_LORE_QUESTIONS = 32

/** An entry the keywords left out, with the question its author wrote for the decision model. */
interface LoreCandidate {
  /** `<book>:<uid>`, as the assembler admits it. */
  readonly key: string
  readonly title: string
  readonly question: string
}

export interface LoreInput {
  readonly candidates: ReadonlyArray<LoreCandidate>
  readonly recent: ReadonlyArray<{ readonly from: string; readonly text: string }>
}

const id = (index: number) => `e${index}`

/** An entry the model admitted, with how sure it was. */
export interface LoreAdmission {
  readonly entry: string
  readonly probability: number
}

export const lorePoint: DecisionPoint<LoreInput, ReadonlyArray<LoreAdmission>> = {
  id: "lore",
  label: "Lorebook entries",
  description:
    "Before each reply, asks about the lorebook entries whose keys didn't match but that have a question for the decision model, and includes those it answers yes. Without it, only keys include entries.",
  instead: "Only the entries' keys decided which were included.",
  appliesTo: ({ loreAsked }) => loreAsked,
  defaultThreshold: 0.7,
  questions: ({ candidates }) =>
    Object.fromEntries(
      candidates.slice(0, MAX_LORE_QUESTIONS).map((c, i): [string, DecisionQuestion] => [
        id(i),
        {
          type: "noul",
          instructions: c.question,
          criteria: {
            true: `Yes: the lorebook entry${c.title ? ` “${c.title}”` : ""} matters for the next message of this story.`,
            false: "No: the next message doesn't need it."
          }
        }
      ])
    ),
  state: ({ recent }) => ({ recent }),
  resolve: (answers, { candidates }, threshold) =>
    candidates.slice(0, MAX_LORE_QUESTIONS).flatMap((c, i) => {
      const answer = answers[id(i)]
      return answer?.type === "noul" && answer.noul >= threshold ? [{ entry: c.key, probability: answer.noul }] : []
    }),
  fallback: () => []
}
