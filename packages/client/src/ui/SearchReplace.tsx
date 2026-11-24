// Shared controlled search fields and matching options; each host owns searching and writes.
import { type ReactNode, type KeyboardEventHandler, useState } from "react"
import { Icon } from "./Icon.tsx"
import { pressedButtonClass } from "./InlinePanel.tsx"
import type { Ref } from "react"
import { Button } from "./Button.tsx"
import { Field, Input } from "./Field.tsx"

/**
 * An option with its explanation on hover and focus: under the label it would make the
 * preset's sticky search bar too tall.
 */
function SearchOption({
  checked,
  onCheckedChange,
  hint,
  children
}: {
  checked: boolean
  onCheckedChange: (checked: boolean) => void
  hint: string
  children: ReactNode
}) {
  const symbol =
    children === "Whole word"
      ? "ab"
      : children === "Match case"
        ? "Aa"
        : children === "Regular expression"
          ? ".*"
          : "aA"
  return (
    <Button
      variant="ghost"
      role="checkbox"
      aria-checked={checked}
      aria-label={String(children)}
      hint={`Click to ${checked ? "turn off" : "turn on"} ${String(children).toLowerCase()}. ${hint}`}
      className={`size-8 px-0! font-mono ${checked ? "bg-accent/15 text-accent" : ""}`}
      onClick={() => onCheckedChange(!checked)}
    >
      {symbol}
    </Button>
  )
}

export function SearchReplace({
  find,
  setFind,
  replace,
  setReplace,
  wholeWord,
  setWholeWord,
  preserveCase,
  setPreserveCase,
  regex,
  setRegex,
  caseSensitive,
  setCaseSensitive,
  inline = false,
  idPrefix,
  findActions,
  replaceActions,
  scopeControl,
  alwaysShowOptions = false,
  onFindKeyDown,
  scopeChanged = false
}: {
  find: string
  setFind: (value: string) => void
  replace: string
  setReplace: (value: string) => void
  wholeWord: boolean
  setWholeWord: (value: boolean) => void
  preserveCase: boolean
  setPreserveCase: (value: boolean) => void
  regex: boolean
  setRegex: (value: boolean) => void
  caseSensitive: boolean
  setCaseSensitive: (value: boolean) => void
  inline?: boolean
  idPrefix: string
  findActions: ReactNode
  replaceActions: ReactNode
  scopeControl?: ReactNode
  alwaysShowOptions?: boolean
  scopeChanged?: boolean
  onFindKeyDown?: KeyboardEventHandler<HTMLInputElement>
}) {
  const [options, setOptions] = useState(false)
  const chosen = [wholeWord, preserveCase, regex, caseSensitive, scopeChanged].filter(Boolean).length
  return (
    <div className="@container flex min-w-0 flex-col gap-2">
      <div className="grid min-w-0 max-w-5xl grid-cols-[minmax(0,1fr)_max-content] items-end gap-2 @2xl:grid-cols-[minmax(0,1fr)_max-content_minmax(0,1fr)_max-content]">
        <div className="contents">
          <Field label="Find" labelHidden={inline} className="flex-1">
            <Input
              {...(inline ? { placeholder: "Find" } : {})}
              value={find}
              onKeyDown={onFindKeyDown}
              onChange={(event) => setFind(event.currentTarget.value)}
              className={regex ? "font-mono" : ""}
            />
          </Field>
          <div className="flex items-center gap-1">{findActions}</div>
        </div>
        <div className="contents">
          <Field label="Replace with" labelHidden={inline} className="flex-1">
            <Input
              {...(inline ? { placeholder: "Replace with" } : {})}
              value={replace}
              onChange={(event) => setReplace(event.currentTarget.value)}
            />
          </Field>
          <div className="flex items-center gap-1">
            {replaceActions}
            {/* On a phone the options fold beside Replace all, keeping the bar short. */}
            {inline && !alwaysShowOptions && (
              <Button
                variant="ghost"
                className="px-2! sm:hidden"
                aria-expanded={options}
                aria-controls={`${idPrefix}-options`}
                hint={options ? "Click to hide matching options" : "Click to show matching options"}
                onClick={() => setOptions(!options)}
              >
                Options{chosen > 0 ? ` (${chosen})` : ""}
              </Button>
            )}
          </div>
        </div>
      </div>

      <div
        className={`${inline && !alwaysShowOptions && !options ? "hidden sm:flex" : "flex"} min-w-0 flex-wrap items-center gap-1`}
      >
        <div
          id={`${idPrefix}-options`}
          className={`${inline ? `${options || alwaysShowOptions ? "flex" : "hidden"} sm:flex` : "flex"} min-w-0 flex-wrap items-center gap-1`}
        >
          <SearchOption
            checked={wholeWord}
            onCheckedChange={setWholeWord}
            hint="Only where it isn't part of a longer word."
          >
            Whole word
          </SearchOption>
          <SearchOption
            checked={preserveCase}
            onCheckedChange={setPreserveCase}
            hint="The replacement takes each match's case: all capitals, all lower case, or a capital first."
          >
            Preserve case
          </SearchOption>
          <SearchOption
            checked={regex}
            onCheckedChange={setRegex}
            hint="Find is a JavaScript regular expression; Replace with can use $1 or $<name> for its groups."
          >
            Regular expression
          </SearchOption>
          <SearchOption
            checked={caseSensitive}
            onCheckedChange={setCaseSensitive}
            hint="Capitals and lower case count as different letters."
          >
            Match case
          </SearchOption>
        </div>
      </div>
      {(!inline || alwaysShowOptions || options) && scopeControl}
      {inline && !alwaysShowOptions && !options && <div className="hidden sm:block">{scopeControl}</div>}
    </div>
  )
}

/** Every editor uses the same entry control, including its pressed state and explanation. */
export function SearchReplaceButton({
  open,
  onClick,
  controls,
  ref,
  className = ""
}: {
  open: boolean
  onClick: () => void
  controls: string
  ref?: Ref<HTMLButtonElement>
  className?: string
}) {
  return (
    <Button
      ref={ref}
      aria-label="Search and replace"
      aria-controls={controls}
      aria-pressed={open}
      className={`h-8! shrink-0 px-2! ${pressedButtonClass} ${className}`}
      hint={open ? "Click to close search and replace" : "Click to open search and replace"}
      onClick={onClick}
    >
      <Icon name="replace" />
      {/* A toolbar can hide it when its frame is narrow (`data-narrow-label`), leaving the icon. */}
      <span data-narrow-label="">Search and replace</span>
    </Button>
  )
}
