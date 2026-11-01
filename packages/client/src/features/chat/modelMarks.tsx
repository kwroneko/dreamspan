// Which lab made the model that wrote a version, and its mark beside the model's name in the
// message header (msgmeta, owner 2026-11-01; ST's "Model Icons"). The lab comes from the
// model's key first ("anthropic/claude-3.5-sonnet" through OpenRouter is Anthropic's), then
// from the provider (a connection's kind, or the API SillyTavern recorded), so a router or a
// lab's own API both show the lab when the key names one. The marks are the labs' logos from
// Simple Icons (CC0, vendored below; labicons, owner 2026-11-01), monochrome in the text
// colour; OpenAI, xAI and Cohere aren't in that set, so theirs are simple drawings of our own.
// ST's icons are AGPL-3.0 and this app is not, so none of those is copied. Each mark is a
// registry entry (spec/PLUGINS.md §8): a plugin adds a lab, or replaces a mark, by id.
import type { ModelRef } from "@rp/shared/chat.ts"
import { stApiLabel } from "@rp/shared/stApis.ts"
import type { ComponentType, ReactNode } from "react"
import { useSyncExternalStore } from "react"
import { makeRegistry } from "../../registry.ts"
import { Icon } from "../../ui/Icon.tsx"

export interface ModelMark {
  readonly id: string
  /** The lab's name, as the tooltip says it: "Anthropic", "Google". */
  readonly label: string
  /** Lower first: the first whose `models` matches the key wins, else the first whose `providers` has the provider. */
  readonly order: number
  /** Tested against the model's key, lowercased. */
  readonly models?: RegExp
  /** Provider kinds and ST API ids that are this lab's own. */
  readonly providers?: ReadonlyArray<string>
  readonly component: ComponentType<{ readonly size: number }>
}

export const modelMarks = { id: "message.model-marks", ...makeRegistry<ModelMark>() }

/** The mark for a model: by its key, then its provider; undefined when neither names a lab. */
export const markFor = (marks: ReadonlyArray<ModelMark>, ref: ModelRef): ModelMark | undefined => {
  const sorted = [...marks].sort((a, b) => a.order - b.order)
  const key = ref.model.toLowerCase()
  const provider = ref.provider.toLowerCase()
  return (
    (key === "" ? undefined : sorted.find((mark) => mark.models?.test(key))) ??
    sorted.find((mark) => mark.providers?.includes(provider))
  )
}

export const useModelMarks = () =>
  useSyncExternalStore(modelMarks.subscribe, modelMarks.snapshot, modelMarks.snapshot).entries

/** A provider as people know it: a connection's kind or an ST API id. */
export const providerLabel = (provider: string) =>
  ({
    "openai-chat": "OpenAI-compatible",
    "openai-responses": "OpenAI",
    anthropic: "Anthropic",
    google: "Google",
    deepseek: "DeepSeek",
    openrouter: "OpenRouter"
  })[provider] ?? stApiLabel(provider)

/**
 * The labs' logos from Simple Icons 16.35.0 (https://simpleicons.org, the `simple-icons` npm
 * package), released under CC0 1.0: each icon's one path in a 24-unit box, copied verbatim
 * from `icons/<slug>.svg`, keyed by its slug. The logos remain their owners' trademarks.
 */
const simpleIcons = {
  anthropic:
    "M17.3041 3.541h-3.6718l6.696 16.918H24Zm-10.6082 0L0 20.459h3.7442l1.3693-3.5527h7.0052l1.3693 3.5528h3.7442L10.5363 3.5409Zm-.3712 10.2232 2.2914-5.9456 2.2914 5.9456Z",
  googlegemini:
    "M11.04 19.32Q12 21.51 12 24q0-2.49.93-4.68.96-2.19 2.58-3.81t3.81-2.55Q21.51 12 24 12q-2.49 0-4.68-.93a12.3 12.3 0 0 1-3.81-2.58 12.3 12.3 0 0 1-2.58-3.81Q12 2.49 12 0q0 2.49-.96 4.68-.93 2.19-2.55 3.81a12.3 12.3 0 0 1-3.81 2.58Q2.49 12 0 12q2.49 0 4.68.96 2.19.93 3.81 2.55t2.55 3.81",
  deepseek:
    "M23.748 4.651c-.254-.124-.364.113-.512.233-.051.04-.094.09-.137.137-.372.397-.806.657-1.373.626-.829-.046-1.537.214-2.163.848-.133-.782-.575-1.248-1.247-1.548-.352-.155-.708-.311-.955-.65-.172-.24-.219-.509-.305-.774-.055-.16-.11-.323-.293-.35-.2-.031-.278.136-.356.276-.313.572-.434 1.202-.422 1.84.027 1.436.633 2.58 1.838 3.393.137.094.172.187.129.323-.082.28-.18.553-.266.833-.055.179-.137.218-.328.14a5.5 5.5 0 0 1-1.737-1.179c-.857-.828-1.631-1.743-2.597-2.46a12 12 0 0 0-.689-.47c-.985-.957.13-1.743.387-1.836.27-.098.094-.433-.778-.428-.872.003-1.67.295-2.687.685a3 3 0 0 1-.465.136 9.6 9.6 0 0 0-2.883-.101c-1.885.21-3.39 1.1-4.497 2.622C.082 8.776-.231 10.854.152 13.02c.403 2.284 1.568 4.175 3.36 5.653 1.857 1.533 3.997 2.284 6.438 2.14 1.482-.085 3.132-.284 4.994-1.86.47.234.962.328 1.78.398.629.058 1.235-.031 1.705-.129.735-.155.684-.836.418-.961-2.155-1.004-1.682-.595-2.112-.926 1.095-1.295 2.768-3.598 3.284-6.733.05-.346.115-.834.108-1.114-.004-.171.035-.238.23-.257a4.2 4.2 0 0 0 1.545-.475c1.397-.763 1.96-2.016 2.093-3.517.02-.23-.004-.467-.247-.588M11.58 18.168c-2.088-1.642-3.101-2.183-3.52-2.16-.39.024-.32.472-.234.763.09.288.207.487.371.74.114.167.192.416-.113.603-.673.416-1.842-.14-1.897-.168-1.361-.801-2.5-1.86-3.301-3.306-.775-1.393-1.225-2.888-1.299-4.482-.02-.385.094-.522.477-.592a4.7 4.7 0 0 1 1.53-.038c2.131.311 3.946 1.264 5.467 2.774.868.86 1.525 1.887 2.202 2.89.72 1.066 1.494 2.082 2.48 2.915.348.291.626.513.892.677-.802.09-2.14.109-3.055-.615zm1.001-6.44a.306.306 0 0 1 .415-.287.3.3 0 0 1 .113.074.3.3 0 0 1 .086.214c0 .17-.136.307-.308.307a.303.303 0 0 1-.306-.307m3.11 1.596c-.2.081-.4.151-.591.16a1.25 1.25 0 0 1-.798-.254c-.274-.23-.47-.358-.551-.758a1.7 1.7 0 0 1 .015-.588c.07-.327-.007-.537-.238-.727-.188-.156-.426-.199-.689-.199a.6.6 0 0 1-.254-.078.253.253 0 0 1-.114-.358 1 1 0 0 1 .192-.21c.356-.202.767-.136 1.146.016.352.144.618.408 1.001.782.392.451.462.576.685.915.176.264.336.536.446.848.066.194-.02.353-.25.45",
  mistralai:
    "M17.143 3.429v3.428h-3.429v3.429h-3.428V6.857H6.857V3.43H3.43v13.714H0v3.428h10.286v-3.428H6.857v-3.429h3.429v3.429h3.429v-3.429h3.428v3.429h-3.428v3.428H24v-3.428h-3.43V3.429z",
  meta: "M6.915 4.03c-1.968 0-3.683 1.28-4.871 3.113C.704 9.208 0 11.883 0 14.449c0 .706.07 1.369.21 1.973a6.624 6.624 0 0 0 .265.86 5.297 5.297 0 0 0 .371.761c.696 1.159 1.818 1.927 3.593 1.927 1.497 0 2.633-.671 3.965-2.444.76-1.012 1.144-1.626 2.663-4.32l.756-1.339.186-.325c.061.1.121.196.183.3l2.152 3.595c.724 1.21 1.665 2.556 2.47 3.314 1.046.987 1.992 1.22 3.06 1.22 1.075 0 1.876-.355 2.455-.843a3.743 3.743 0 0 0 .81-.973c.542-.939.861-2.127.861-3.745 0-2.72-.681-5.357-2.084-7.45-1.282-1.912-2.957-2.93-4.716-2.93-1.047 0-2.088.467-3.053 1.308-.652.57-1.257 1.29-1.82 2.05-.69-.875-1.335-1.547-1.958-2.056-1.182-.966-2.315-1.303-3.454-1.303zm10.16 2.053c1.147 0 2.188.758 2.992 1.999 1.132 1.748 1.647 4.195 1.647 6.4 0 1.548-.368 2.9-1.839 2.9-.58 0-1.027-.23-1.664-1.004-.496-.601-1.343-1.878-2.832-4.358l-.617-1.028a44.908 44.908 0 0 0-1.255-1.98c.07-.109.141-.224.211-.327 1.12-1.667 2.118-2.602 3.358-2.602zm-10.201.553c1.265 0 2.058.791 2.675 1.446.307.327.737.871 1.234 1.579l-1.02 1.566c-.757 1.163-1.882 3.017-2.837 4.338-1.191 1.649-1.81 1.817-2.486 1.817-.524 0-1.038-.237-1.383-.794-.263-.426-.464-1.13-.464-2.046 0-2.221.63-4.535 1.66-6.088.454-.687.964-1.226 1.533-1.533a2.264 2.264 0 0 1 1.088-.285z",
  qwen: "M23.919 14.545 20.817 9.17l1.47-2.544a.56.56 0 0 0 0-.566l-1.633-2.83a.57.57 0 0 0-.49-.283h-6.207L12.487.402a.57.57 0 0 0-.49-.284H8.732a.56.56 0 0 0-.49.284L5.139 5.775h-2.94a.56.56 0 0 0-.49.284L.077 8.887a.56.56 0 0 0 0 .567L3.18 14.83l-1.47 2.545a.56.56 0 0 0 0 .566l1.634 2.83a.57.57 0 0 0 .49.283h6.205l1.47 2.545a.57.57 0 0 0 .49.284h3.266a.57.57 0 0 0 .49-.284l3.104-5.375h2.94a.57.57 0 0 0 .49-.283l1.634-2.828a.55.55 0 0 0-.004-.568M8.733.686l1.634 2.828-1.634 2.828H21.8L20.164 9.17H7.425L5.63 6.06Zm1.306 19.801-6.205-.002 1.634-2.83h3.265L2.201 6.344h3.267q3.182 5.517 6.367 11.032zm10.124-5.66L18.53 12l-6.532 11.315-1.634-2.83c2.129-3.673 4.25-7.351 6.373-11.028h3.592l3.102 5.374z",
  moonshotai:
    "m1.053 16.91 9.538 2.55a21 20.981 0 0 0 .06 2.031l5.956 1.592a12 11.99 0 0 1-15.554-6.172m-1.02-5.79 11.352 3.035a21 20.981 0 0 0-.469 2.01l10.817 2.89a12 11.99 0 0 1-1.845 2.004L.658 15.918a12 11.99 0 0 1-.625-4.796m1.593-5.146L13.573 9.17a21 20.981 0 0 0-1.01 1.874l11.297 3.02a21 20.981 0 0 1-.67 2.362l-11.55-3.087L.125 10.26a12 11.99 0 0 1 1.499-4.285ZM6.067 1.58l11.285 3.016a21 20.981 0 0 0-1.688 1.719l7.824 2.091a21 20.981 0 0 1 .513 2.664L2.107 5.218a12 11.99 0 0 1 3.96-3.638M21.68 4.866 7.222 1.003A12 11.99 0 0 1 21.68 4.866",
  openrouter:
    "M16.778 1.844v1.919q-.569-.026-1.138-.032-.708-.008-1.415.037c-1.93.126-4.023.728-6.149 2.237-2.911 2.066-2.731 1.95-4.14 2.75-.396.223-1.342.574-2.185.798-.841.225-1.753.333-1.751.333v4.229s.768.108 1.61.333c.842.224 1.789.575 2.185.799 1.41.798 1.228.683 4.14 2.75 2.126 1.509 4.22 2.11 6.148 2.236.88.058 1.716.041 2.555.005v1.918l7.222-4.168-7.222-4.17v2.176c-.86.038-1.611.065-2.278.021-1.364-.09-2.417-.357-3.979-1.465-2.244-1.593-2.866-2.027-3.68-2.508.889-.518 1.449-.906 3.822-2.59 1.56-1.109 2.614-1.377 3.978-1.466.667-.044 1.418-.017 2.278.02v2.176L24 6.014Z"
} as const

/** A Simple Icons logo: its path in the 24-unit box, filled in the text colour, hidden from assistive technology. */
function SimpleIcon({ size, path }: { size: number; path: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      aria-hidden="true"
      className="shrink-0"
      fill="currentColor"
      data-mark-source="simple-icons"
    >
      <path d={path} />
    </svg>
  )
}

/** A mark's drawing: 24-unit box, filled in the text colour, hidden from assistive technology. */
function Mark({ size, children, stroke = false }: { size: number; children: ReactNode; stroke?: boolean }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      aria-hidden="true"
      className="shrink-0"
      data-mark-source="drawn"
      fill={stroke ? "none" : "currentColor"}
      stroke={stroke ? "currentColor" : "none"}
      strokeWidth={stroke ? 2 : undefined}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {children}
    </svg>
  )
}

/** A model whose lab isn't known: the app's model icon. */
export function GenericModelMark({ size }: { size: number }) {
  return <Icon name="model" size={size} />
}

const builtins: ReadonlyArray<ModelMark> = [
  {
    id: "anthropic",
    label: "Anthropic",
    order: 10,
    models: /claude|anthropic/,
    providers: ["anthropic", "anthropic-explicit-breakpoints", "claude"],
    component: ({ size }) => <SimpleIcon size={size} path={simpleIcons.anthropic} />
  },
  {
    id: "openai",
    label: "OpenAI",
    order: 20,
    models: /(^|\/)(gpt|chatgpt|o[1-9](-|$)|davinci|babbage)|openai/,
    providers: ["openai-responses", "openai", "azure_openai"],
    // Three rings crossed into a six-petalled knot.
    component: ({ size }) => (
      <Mark size={size} stroke>
        <ellipse cx="12" cy="12" rx="9" ry="4" />
        <ellipse cx="12" cy="12" rx="9" ry="4" transform="rotate(60 12 12)" />
        <ellipse cx="12" cy="12" rx="9" ry="4" transform="rotate(120 12 12)" />
      </Mark>
    )
  },
  {
    id: "google",
    label: "Google",
    order: 30,
    models: /gemini|gemma|palm|bison|google\//,
    providers: ["google", "makersuite", "vertexai"],
    // Gemini's sparkle rather than Google's G: the mark of the models people chat with.
    component: ({ size }) => <SimpleIcon size={size} path={simpleIcons.googlegemini} />
  },
  {
    id: "deepseek",
    label: "DeepSeek",
    order: 40,
    models: /deepseek/,
    providers: ["deepseek"],
    component: ({ size }) => <SimpleIcon size={size} path={simpleIcons.deepseek} />
  },
  {
    id: "mistral",
    label: "Mistral AI",
    order: 50,
    models: /mistral|mixtral|codestral|magistral|ministral|pixtral|devstral|voxtral/,
    providers: ["mistralai"],
    component: ({ size }) => <SimpleIcon size={size} path={simpleIcons.mistralai} />
  },
  {
    id: "meta",
    label: "Meta",
    order: 60,
    models: /llama|meta-|meta\//,
    component: ({ size }) => <SimpleIcon size={size} path={simpleIcons.meta} />
  },
  {
    id: "xai",
    label: "xAI",
    order: 70,
    models: /grok|x-ai\//,
    providers: ["xai"],
    // An X with one stroke broken.
    component: ({ size }) => (
      <Mark size={size} stroke>
        <path d="M4 4l16 16" />
        <path d="M20 4l-5.5 5.5" />
        <path d="M9.5 14.5 4 20" />
      </Mark>
    )
  },
  {
    id: "qwen",
    label: "Qwen",
    order: 80,
    models: /qwen|qwq/,
    component: ({ size }) => <SimpleIcon size={size} path={simpleIcons.qwen} />
  },
  {
    id: "cohere",
    label: "Cohere",
    order: 90,
    models: /cohere|command-|^command|(^|\/)aya/,
    providers: ["cohere"],
    // Three rounded shapes.
    component: ({ size }) => (
      <Mark size={size}>
        <path d="M9 3h8a4.5 4.5 0 0 1 0 9H9a4.5 4.5 0 0 1 0-9Z" />
        <circle cx="7" cy="17" r="4" />
        <circle cx="17.5" cy="17.5" r="2.5" />
      </Mark>
    )
  },
  {
    id: "moonshot",
    label: "Moonshot AI",
    order: 100,
    models: /kimi|moonshot/,
    providers: ["moonshot"],
    component: ({ size }) => <SimpleIcon size={size} path={simpleIcons.moonshotai} />
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    order: 200,
    // A router, not a lab: shown only when the key names no lab above.
    providers: ["openrouter"],
    component: ({ size }) => <SimpleIcon size={size} path={simpleIcons.openrouter} />
  }
]

export const registerModelMarks = () => builtins.map((mark) => modelMarks.register(mark))
