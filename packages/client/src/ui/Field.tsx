import { Field as BaseField } from "@base-ui/react/field"
import { Fieldset as BaseFieldset } from "@base-ui/react/fieldset"
import { Input as BaseInput } from "@base-ui/react/input"
import type { ComponentProps, ReactNode } from "react"

// 16px text on touch screens, so iOS doesn't zoom into a focused field.
const control =
  "w-full min-w-0 rounded-md border border-border bg-surface px-3 text-base text-text shadow-xs outline-none transition-shadow placeholder:text-muted focus-visible:border-focus focus-visible:ring-2 focus-visible:ring-focus/40 disabled:opacity-50 data-invalid:border-danger sm:text-sm"

/**
 * A labelled form control. Base UI ties the label, description and error to the control,
 * so screen readers announce them together.
 */
export function Field({
  label,
  description,
  error,
  children,
  className = ""
}: {
  label: ReactNode
  description?: ReactNode
  /** Shown under the control, and marks it invalid. */
  error?: string | null | undefined
  children: ReactNode
  className?: string
}) {
  return (
    <BaseField.Root invalid={error ? true : undefined} className={`flex min-w-0 flex-col gap-1.5 ${className}`}>
      <BaseField.Label className="text-sm font-medium text-text">{label}</BaseField.Label>
      {children}
      {description && <BaseField.Description className="text-sm text-muted">{description}</BaseField.Description>}
      {error && (
        <BaseField.Error match className="text-sm text-danger">
          {error}
        </BaseField.Error>
      )}
    </BaseField.Root>
  )
}

export function Input({ className = "", ...props }: ComponentProps<typeof BaseInput>) {
  return <BaseInput className={`h-9 ${control} ${className}`} {...props} />
}

/**
 * A secret being typed: an API key, a header value, a proxy URL with a password. Read it
 * from the form's data on submit; `onEmptyChange` reports only whether it's empty.
 * - Uncontrolled, so React never mirrors it into the DOM's `value` attribute.
 * - Plain text, so browsers' password managers don't offer to save it as a password and
 *   later fill it into the login form; the password-manager extensions' own opt-outs too.
 * - `masked` hides the characters with CSS (`-webkit-text-security`), where the browser
 *   supports it; a URL stays readable.
 */
export function SecretInput({
  name,
  masked = true,
  onEmptyChange,
  placeholder,
  className = ""
}: {
  name: string
  masked?: boolean
  onEmptyChange?: (empty: boolean) => void
  placeholder?: string | undefined
  className?: string
}) {
  return (
    <BaseInput
      name={name}
      type="text"
      autoComplete="off"
      autoCapitalize="none"
      autoCorrect="off"
      spellCheck={false}
      placeholder={placeholder}
      data-1p-ignore=""
      data-lpignore="true"
      data-bwignore=""
      data-form-type="other"
      onValueChange={(value) => onEmptyChange?.(value.trim() === "")}
      className={`h-9 ${control} ${masked ? "[-webkit-text-security:disc]" : ""} ${className}`}
    />
  )
}

/** An account password: a real password field for password managers, uncontrolled like `SecretInput`. */
export function PasswordInput({
  name,
  autoComplete,
  onEmptyChange
}: {
  name: string
  autoComplete: "current-password" | "new-password"
  onEmptyChange?: (empty: boolean) => void
}) {
  return (
    <BaseInput
      name={name}
      type="password"
      autoComplete={autoComplete}
      onValueChange={(value) => onEmptyChange?.(value === "")}
      className={`h-9 ${control}`}
    />
  )
}

/**
 * After a submit the client refused: focus the first invalid control once its error has
 * rendered. Its description includes the error, so a screen reader reads it out.
 */
export const focusFirstInvalid = (form: HTMLFormElement) => {
  requestAnimationFrame(() =>
    form.querySelector<HTMLElement>('[aria-invalid="true"], [data-invalid]:is(input, textarea)')?.focus()
  )
}

/** A form field's text, from the form being submitted. */
export const formText = (form: HTMLFormElement, name: string) => {
  const value = new FormData(form).get(name)
  return typeof value === "string" ? value : ""
}

export function Textarea({ className = "", ...props }: ComponentProps<"textarea">) {
  return <BaseField.Control render={<textarea className={`min-h-24 py-2 ${control} ${className}`} {...props} />} />
}

/** A group of related controls with a legend, such as a set of radio buttons. */
export function Fieldset({
  legend,
  description,
  children,
  className = ""
}: {
  legend: ReactNode
  description?: ReactNode
  children: ReactNode
  className?: string
}) {
  return (
    <BaseFieldset.Root className={`flex min-w-0 flex-col gap-2 ${className}`}>
      <BaseFieldset.Legend className="text-sm font-medium text-text">{legend}</BaseFieldset.Legend>
      {description && <p className="text-sm text-muted">{description}</p>}
      {children}
    </BaseFieldset.Root>
  )
}
