// One marker for persona-folder membership, or for the card played in the open chat.
import { Tooltip } from "./Tooltip.tsx"

export function PersonaBadge({ played = false, portrait = false }: { played?: boolean; portrait?: boolean }) {
  return (
    <Tooltip
      label={played ? "You play this card in this chat." : "In the persona folder: a card you can play in chats."}
    >
      <span
        data-persona-badge
        {...(portrait ? { "data-layout-overlay": "The persona badge sits over the portrait" } : {})}
        tabIndex={0}
        className={`${portrait ? "absolute bottom-1 left-1 max-w-[calc(100%-0.5rem)]" : "inline-flex w-fit shrink-0"} truncate rounded-sm bg-accent px-1.5 text-[0.6875rem] leading-4 font-medium text-accent-contrast shadow-sm outline-none focus-visible:ring-2 focus-visible:ring-focus`}
      >
        {played ? "You" : "Persona"}
      </span>
    </Tooltip>
  )
}
