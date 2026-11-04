// Persona-folder membership: an icon at rest, an expanding labelled button when pressed.
import { Button } from "./Button.tsx"
import { Icon } from "./Icon.tsx"

export function PersonaToggle({
  pressed,
  onPressedChange,
  pending = false
}: {
  pressed: boolean
  onPressedChange: (pressed: boolean) => void
  pending?: boolean
}) {
  return (
    <Button
      variant="ghost"
      aria-label="Persona"
      aria-pressed={pressed}
      aria-busy={pending || undefined}
      disabled={pending}
      hint={
        pressed
          ? "Remove the persona mark: this becomes a regular card again."
          : "Mark this card as a persona: a card you play as, listed under Personas."
      }
      className={`h-7! justify-start gap-0! overflow-hidden px-2! [[data-persona-align-start]_&]:focus-visible:ring-inset [[data-persona-align-start]_&]:focus-visible:ring-offset-0! [[data-persona-align-start]_&]:cursor-pointer text-xs transition-[width,background-color,color]! duration-150 motion-reduce:transition-none! ${pressed ? "w-22 bg-accent/10 text-accent!" : "w-8 text-muted [[data-persona-align-start]_&]:px-0! [[data-persona-align-start]_&]:bg-transparent! [[data-persona-align-start]_&]:hover:text-accent!"}`}
      onClick={() => onPressedChange(!pressed)}
    >
      <Icon name="person" className={pressed ? "" : "[[data-persona-align-start]_&]:-translate-x-0.5"} />
      <span aria-hidden={!pressed} className={`ml-1.5 ${pressed ? "opacity-100" : "opacity-0"}`}>
        Persona
      </span>
    </Button>
  )
}
