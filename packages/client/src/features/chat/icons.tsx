// The few icons the composer and the Cast tab show. Each is decorative: the button around
// it carries the accessible name and a tooltip.
const base = {
  width: 16,
  height: 16,
  viewBox: "0 0 16 16",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.6,
  strokeLinecap: "round",
  strokeLinejoin: "round",
  "aria-hidden": true
} as const

export const SendIcon = () => (
  <svg {...base}>
    <path d="M3 8h10M8.5 3.5 13 8 8.5 12.5" />
  </svg>
)

export const HistoryIcon = () => (
  <svg {...base}>
    <path d="M2.5 8a5.5 5.5 0 1 0 1.6-3.9M2.5 2.5v2.5H5" />
    <path d="M8 5v3l2 1.5" />
  </svg>
)

export const ChevronIcon = ({ up = false }: { up?: boolean }) => (
  <svg {...base} width={12} height={12}>
    <path d={up ? "M4 10l4-4 4 4" : "M4 6l4 4 4-4"} />
  </svg>
)

export const PlusIcon = () => (
  <svg {...base}>
    <path d="M8 3v10M3 8h10" />
  </svg>
)

/** Generating with guidance: a spark, not Send's arrow, so guidance never looks like a message going out. */
export const GenerateIcon = () => (
  <svg {...base}>
    <path d="M8 2.5 9.3 6.7 13.5 8 9.3 9.3 8 13.5 6.7 9.3 2.5 8 6.7 6.7Z" />
  </svg>
)
