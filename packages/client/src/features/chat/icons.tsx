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
    <path d="M2.5 8h9M8 3.5 12.5 8 8 12.5" />
  </svg>
)

export const StopIcon = () => (
  <svg {...base}>
    <rect x="3" y="3" width="10" height="10" rx="1.5" fill="currentColor" />
  </svg>
)

export const HistoryIcon = () => (
  <svg {...base}>
    <path d="M2.5 8a5.5 5.5 0 1 0 1.6-3.9M2.5 2.5v2.5H5" />
    <path d="M8 5v3l2 1.5" />
  </svg>
)

export const MoreIcon = () => (
  <svg {...base} width={20} height={20}>
    <circle cx="3" cy="8" r="1.6" fill="currentColor" stroke="none" />
    <circle cx="8" cy="8" r="1.6" fill="currentColor" stroke="none" />
    <circle cx="13" cy="8" r="1.6" fill="currentColor" stroke="none" />
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
