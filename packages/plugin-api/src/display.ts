/** Browser-only display API v1. Text returned here is untrusted content: the host
 * retains sanitisation, panel permissions and CSP. Nothing here changes stored or
 * model-facing text. Callbacks run in a terminable browser worker, not the page.
 * Import this entry for pure display helpers; import client only for types.
 */
/** Explicit v1 fields keep the browser declarations independent of Effect,
 * render implementations and server-schema inference. Host projections use only these fields. */
export interface CardFields {
  readonly description?: string
  readonly personality?: string
  readonly scenario?: string
  readonly persona?: string
  readonly mesExamples?: string
  readonly systemPrompt?: string
  readonly postHistoryInstructions?: string
  readonly depthPrompt?: string
  readonly creatorNotes?: string
  readonly version?: string
  readonly firstMessage?: string
  readonly alternateGreetings?: ReadonlyArray<string>
  readonly joinedVolatile?: ReadonlyArray<"description" | "personality" | "scenario">
  readonly joined?: { readonly description: string; readonly personality: string; readonly scenario: string }
}
export type FrozenValues = Readonly<Record<string, string>>
export interface RegexScript {
  readonly id: string
  readonly name: string
  readonly find_regex: string
  readonly replace_string: string
  readonly trim_strings: ReadonlyArray<string>
  readonly placement: ReadonlyArray<number>
  readonly disabled: boolean
  readonly markdown_only: boolean
  readonly prompt_only: boolean
  readonly run_on_edit: boolean
  readonly substitute_regex: "none" | "raw" | "escaped"
  readonly min_depth: number | null
  readonly max_depth: number | null
  readonly unsupported?: Readonly<Record<string, unknown>>
}
/** Supplied by the worker-safe host facade; identical to built-in display expansion. */
export declare const expandForDisplay: (
  text: string,
  macroMode: "template" | "verbatim",
  names: { readonly user: string; readonly char: string },
  card?: CardFields,
  frozen?: FrozenValues,
  displayRule?: boolean
) => { readonly text: string; readonly frozen: FrozenValues; readonly issue?: string }
/** Existing bounded regex runner; imported patterns execute only in the worker. */
export declare const runDisplayRegex: (job: {
  readonly text: string
  readonly scripts: ReadonlyArray<RegexScript>
  readonly placement: number
  readonly depth: number | null
  readonly names: { readonly user: string; readonly char: string }
  readonly card: CardFields
}) => DisplayResultV1

/** Display registrations are made during activate and owned by the plugin's
 * worker lifetime. Page-registry lookup/mutation/disposer methods are deliberately
 * absent: the host restores every original when this worker closes.
 */
export interface DisplayRegistryV1<A> {
  readonly register: (entry: A) => void
}

export interface DisplayInputV1 {
  readonly text: string
  readonly version: {
    readonly macroMode: "template" | "verbatim"
    readonly writer: "human" | "model"
    readonly frozenMacros: FrozenValues | null
  }
  readonly names: { readonly user: string; readonly char: string }
  readonly card: CardFields
  readonly prefs: { readonly outputMacros: boolean; readonly displayRegex: boolean }
  readonly scripts: ReadonlyArray<RegexScript>
  /** 1: user-side text, 2: character-side text, 6: reasoning. */
  readonly placement: 1 | 2 | 6
  /** Distance from the current tip; null while that tip is not known. */
  readonly depth: number | null
  readonly streaming?: boolean
}
export interface DisplayResultV1 {
  readonly text: string
  readonly issues: ReadonlyArray<string>
}
export interface DisplayTransformV1 {
  readonly api: 1
  readonly id: string
  readonly order: number
  readonly source?: string
  /** Ordered by order, at most 20 stages. Receives the preceding stage's text.
   * One call has a 50 ms deadline after loading; failure restores the built-in
   * for this call and turns the entire copy off in this tab.
   */
  readonly transform: (input: DisplayInputV1) => DisplayResultV1 | Promise<DisplayResultV1>
}
export interface DisplayListContextV1 {
  /** Only the user's global scripts and explicitly approved preset/card scripts. */
  readonly global: ReadonlyArray<RegexScript>
  readonly preset: ReadonlyArray<RegexScript>
  readonly character: ReadonlyArray<RegexScript>
  readonly characterId: string | null
  readonly placement: number
}
export interface DisplayScriptListV1 {
  readonly api: 1
  readonly id: string
  readonly order: number
  readonly source?: string
  /** Lists run by order, before transforms. Script placement, enabled/display-only
   * flags and min/max depths are still applied by the display regex runner.
   * Same 50 ms deadline/fallback as text transforms. Asked once per distinct
   * input, not once per message: return the same list for the same input.
   */
  readonly scripts: (context: DisplayListContextV1) => ReadonlyArray<RegexScript> | Promise<ReadonlyArray<RegexScript>>
}

/** Timeline rules manipulate data rows. Existing message/summary/notice bodies stay
 * host-owned; a rule can select, reorder, resize them or insert literal text.
 * They never receive React renderers, sessions, RPC or model-request state.
 */
export interface TimelineRowV1 {
  readonly key: string
  readonly estimate: number
  readonly from: number
  readonly to: number
  readonly lastSlotId?: string
  readonly entry?: {
    readonly slotId: string
    readonly depth: number
    readonly position?: number | undefined
    readonly version: { readonly origin: string } | null
  }
  readonly body?: { readonly kind: string; readonly ref?: string; readonly text?: string } | undefined
}
export interface TimelineInputV1 {
  readonly rows: ReadonlyArray<TimelineRowV1>
  readonly entries: ReadonlyArray<{
    readonly slotId: string
    readonly depth: number
    readonly position?: number | undefined
  }>
  /** The loaded window has no earlier history. */
  readonly atHistoryStart?: boolean
  readonly hasBudget: boolean
  readonly assemblyError: boolean
  readonly historyDivider: number
  /** Where the line saying the messages above are hidden goes (an entry index); absent or -1: none. */
  readonly hiddenDivider?: number
  readonly divider: number
  readonly summaries: boolean
  readonly lcm: {
    readonly cursor: number
    readonly layer: ReadonlyArray<{
      readonly id: string
      readonly from: number
      readonly to: number
      readonly lastSlotId: string
    }>
  } | null
  readonly threads: ReadonlyArray<{ readonly splitId: string; readonly slotId: string }>
}
export interface TimelineTransformV1 {
  readonly api: 1
  readonly id: string
  readonly order: number
  readonly source?: string
  /** Same worker and 50 ms call deadline as text rules. The original rows remain
   * visible while a copy answers; failure restores the original for that call
   * and turns the whole copy off in this tab. Maximum 2,000 input and returned rows; larger windows restore the original.
   */
  readonly transform: (input: TimelineInputV1) => ReadonlyArray<TimelineRowV1> | Promise<ReadonlyArray<TimelineRowV1>>
}
