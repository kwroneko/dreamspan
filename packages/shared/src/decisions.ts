// Decision models (DESIGN §7.6; spec/AGENTIC.md §7), as reference-harness's `src/decisions/types.ts`:
// the System-One wire body `{ model, state, questions }` and its typed answers, and the user's
// settings, which say per connection which decision points may send anything (owner rule:
// nothing goes to a provider without the user's opt-in on that connection).
import { Schema } from "effect"
import { ConnectionId, ModelId } from "./providers.ts"

/** Instructions and criteria may be a string, an object, or an array. */
type DecisionText = string | Readonly<Record<string, unknown>> | ReadonlyArray<unknown>

/** `choice`: pick one option key; `criteria` maps option key → description. */
interface ChoiceQuestion {
  readonly type: "choice"
  readonly instructions: DecisionText
  readonly criteria: Readonly<Record<string, DecisionText>>
}

/** `score`: pick one level; `criteria` lists the levels in order. */
interface ScoreQuestion {
  readonly type: "score"
  readonly instructions: DecisionText
  readonly criteria: ReadonlyArray<DecisionText>
}

/** `noul`: a calibrated probability that the statement holds. */
interface NoulQuestion {
  readonly type: "noul"
  readonly instructions: DecisionText
  readonly criteria?: { readonly true?: DecisionText; readonly false?: DecisionText }
}

export type DecisionQuestion = ChoiceQuestion | ScoreQuestion | NoulQuestion

interface ChoiceAnswer {
  readonly type: "choice"
  readonly choice: string
  readonly probabilities: Readonly<Record<string, number>>
  /** The model's own calibration signal, not the top probability. */
  readonly confidence: number
}

interface ScoreAnswer {
  readonly type: "score"
  readonly score: number
  readonly probabilities: Readonly<Record<string, number>>
  readonly confidence: number
}

interface NoulAnswer {
  readonly type: "noul"
  /** Probability that the statement is true. */
  readonly noul: number
}

type DecisionAnswer = ChoiceAnswer | ScoreAnswer | NoulAnswer
export type DecisionAnswers = Readonly<Record<string, DecisionAnswer>>

const isProbability = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1

const probabilityMap = (value: unknown): Record<string, number> => {
  const out: Record<string, number> = {}
  if (!value || typeof value !== "object") return out
  for (const [key, p] of Object.entries(value as Record<string, unknown>)) if (isProbability(p)) out[key] = p
  return out
}

/**
 * The `answers` of a decision response, checked against the questions asked. Undefined when any
 * question has no well-formed answer: a partial map is malformed, never "the rest are unknown".
 */
export const parseAnswers = (
  raw: unknown,
  questions: Readonly<Record<string, DecisionQuestion>>
): DecisionAnswers | undefined => {
  if (!raw || typeof raw !== "object") return undefined
  const source = raw as Record<string, unknown>
  const out: Record<string, DecisionAnswer> = {}
  for (const [id, question] of Object.entries(questions)) {
    const answer = source[id]
    if (!answer || typeof answer !== "object") return undefined
    const a = answer as Record<string, unknown>
    if (question.type === "noul") {
      if (!isProbability(a["noul"])) return undefined
      out[id] = { type: "noul", noul: a["noul"] }
    } else if (question.type === "choice") {
      const choice = a["choice"]
      if (typeof choice !== "string" || !Object.hasOwn(question.criteria, choice)) return undefined
      if (!isProbability(a["confidence"])) return undefined
      out[id] = { type: "choice", choice, probabilities: probabilityMap(a["probabilities"]), confidence: a["confidence"] }
    } else {
      const score = typeof a["score"] === "string" ? Number(a["score"]) : a["score"]
      if (typeof score !== "number" || !Number.isInteger(score) || score < 0 || score >= question.criteria.length)
        return undefined
      if (!isProbability(a["confidence"])) return undefined
      out[id] = { type: "score", score, probabilities: probabilityMap(a["probabilities"]), confidence: a["confidence"] }
    }
  }
  return out
}

/** The bare body, or Cloudflare's `{ result: { … } }` envelope around it. */
export const unwrapEnvelope = (parsed: unknown): Record<string, unknown> => {
  if (!parsed || typeof parsed !== "object") return {}
  const obj = parsed as Record<string, unknown>
  if (!("answers" in obj) && obj["result"] && typeof obj["result"] === "object")
    return obj["result"] as Record<string, unknown>
  return obj
}

/** The response's usage: tokens (either naming) and the provider's own cost, when it says. */
export const readDecisionUsage = (
  raw: unknown
): { readonly inputTokens: number | null; readonly outputTokens: number | null; readonly cost: number | null } => {
  const u = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {}
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null)
  return {
    inputTokens: num(u["input_tokens"]) ?? num(u["prompt_tokens"]),
    outputTokens: num(u["output_tokens"]) ?? num(u["completion_tokens"]),
    cost: num(u["cost"])
  }
}

// --- Settings -----------------------------------------------------------------

/** A decision point on one connection: whether it may ask, and the confidence it needs. */
export const DecisionPointSetting = Schema.Struct({
  on: Schema.Boolean,
  /** 0.5..1: how sure the model must be before its answer replaces the fallback. */
  threshold: Schema.Number.check(Schema.isBetween({ minimum: 0.5, maximum: 1 }))
})
export type DecisionPointSetting = typeof DecisionPointSetting.Type

/** One connection's decision settings: which of its models answers, and the points it answers. */
export const ConnectionDecisions = Schema.Struct({
  connectionId: ConnectionId,
  model: Schema.NullOr(ModelId),
  points: Schema.Record(Schema.String, DecisionPointSetting)
})
export type ConnectionDecisions = typeof ConnectionDecisions.Type

/** A registered decision point, as the settings show it. */
export const DecisionPointInfo = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
  /** User-facing: what the point decides, and what happens without a model. */
  description: Schema.String,
  defaultThreshold: Schema.Number
})
export type DecisionPointInfo = typeof DecisionPointInfo.Type
