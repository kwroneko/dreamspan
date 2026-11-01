// Which lab made the model that wrote a version, and its mark beside the model's name in the
// message header (msgmeta, owner 2026-11-01; ST's "Model Icons"). The lab comes from the
// model's key first ("anthropic/claude-3.5-sonnet" through OpenRouter is Anthropic's), then
// from the provider (a connection's kind, or the API SillyTavern recorded), so a router or a
// lab's own API both show the lab when the key names one. The marks are simple monochrome
// drawings of our own, in the text colour, not the labs' logo files: ST's icons are AGPL-3.0
// and this app is not, so none is copied. Each mark is a registry entry (spec/PLUGINS.md §8):
// a plugin adds a lab, or replaces a drawing with the lab's own artwork, by id.
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

/** A mark's drawing: 24-unit box, filled in the text colour, hidden from assistive technology. */
function Mark({ size, children, stroke = false }: { size: number; children: ReactNode; stroke?: boolean }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      aria-hidden="true"
      className="shrink-0"
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
    // An A and a slash.
    component: ({ size }) => (
      <Mark size={size} stroke>
        <path d="M3 20 8.5 4h1L15 20" />
        <path d="M5.2 14h7.6" />
        <path d="M14.5 4 21 20" />
      </Mark>
    )
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
    // A four-pointed sparkle.
    component: ({ size }) => (
      <Mark size={size}>
        <path d="M12 2c.6 5.4 4.6 9.4 10 10-5.4.6-9.4 4.6-10 10-.6-5.4-4.6-9.4-10-10 5.4-.6 9.4-4.6 10-10Z" />
      </Mark>
    )
  },
  {
    id: "deepseek",
    label: "DeepSeek",
    order: 40,
    models: /deepseek/,
    providers: ["deepseek"],
    // A whale.
    component: ({ size }) => (
      <Mark size={size}>
        <path
          fillRule="evenodd"
          d="M2.5 11.5c0-3.3 3.6-5.5 8-5.5 4.6 0 8 2.6 8.6 6.2l2.4-2.7v5.3l-2.9-.9C17.6 17 14.6 19 10.8 19 6 19 2.5 15.8 2.5 11.5ZM8.7 11a1.2 1.2 0 1 0-2.4 0 1.2 1.2 0 1 0 2.4 0Z"
        />
      </Mark>
    )
  },
  {
    id: "mistral",
    label: "Mistral AI",
    order: 50,
    models: /mistral|mixtral|codestral|magistral|ministral|pixtral|devstral|voxtral/,
    providers: ["mistralai"],
    // An M in blocks.
    component: ({ size }) => (
      <Mark size={size}>
        {[
          [2, 3],
          [2, 7.5],
          [2, 12],
          [2, 16.5],
          [18, 3],
          [18, 7.5],
          [18, 12],
          [18, 16.5],
          [6, 7.5],
          [14, 7.5],
          [10, 12]
        ].map(([x, y]) => (
          <rect key={`${x},${y}`} x={x} y={y} width="4" height="4.5" />
        ))}
      </Mark>
    )
  },
  {
    id: "meta",
    label: "Meta",
    order: 60,
    models: /llama|meta-|meta\//,
    // A looped ribbon.
    component: ({ size }) => (
      <Mark size={size} stroke>
        <path d="M12 12C10 8.6 8.2 6.5 6 6.5 3.8 6.5 2.5 9 2.5 12s1.3 5.5 3.5 5.5c2.2 0 4-2.1 6-5.5 2-3.4 3.8-5.5 6-5.5 2.2 0 3.5 2.5 3.5 5.5s-1.3 5.5-3.5 5.5c-2.2 0-4-2.1-6-5.5Z" />
      </Mark>
    )
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
    // A hexagon around a smaller one.
    component: ({ size }) => (
      <Mark size={size} stroke>
        <path d="M12 2.5 20.5 7.25v9.5L12 21.5 3.5 16.75v-9.5Z" />
        <path d="M12 8l3.5 2v4L12 16l-3.5-2v-4Z" />
      </Mark>
    )
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
    // A crescent moon.
    component: ({ size }) => (
      <Mark size={size}>
        <path d="M14.5 2.5A9.5 9.5 0 1 0 21.5 15 7.5 7.5 0 0 1 14.5 2.5Z" />
      </Mark>
    )
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    order: 200,
    // A router, not a lab: shown only when the key names no lab above.
    providers: ["openrouter"],
    // One line splitting in two, each to an arrow.
    component: ({ size }) => (
      <Mark size={size} stroke>
        <path d="M2.5 12H8c3 0 4-5 7-5h5" />
        <path d="M8 12c3 0 4 5 7 5h5" />
        <path d="m17.5 4.5 2.5 2.5-2.5 2.5" />
        <path d="m17.5 14.5 2.5 2.5-2.5 2.5" />
      </Mark>
    )
  }
]

export const registerModelMarks = () => builtins.map((mark) => modelMarks.register(mark))
