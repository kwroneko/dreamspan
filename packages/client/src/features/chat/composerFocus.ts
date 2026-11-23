// The composer to focus from a chat's command: the focused frame's, since two frames can each
// show a chat (features/workbench), then any.

/**
 * The element that takes a composer's text inside `scope`: the chat composer's editor content,
 * in its editor's shadow root (`data-composer-text`, Composer.tsx), or a plain composer textarea
 * (a new chat's first message, a pending workshop).
 */
export const composerTextbox = (scope: ParentNode = document): HTMLElement | null => {
  for (const box of scope.querySelectorAll<HTMLElement>("[data-composer-text]")) {
    for (const host of box.querySelectorAll<HTMLElement>("*")) {
      const content = host.shadowRoot?.querySelector<HTMLElement>('[data-testid="composer"]')
      if (content) return content
    }
  }
  return scope.querySelector<HTMLElement>('textarea[data-testid="composer"]')
}

export const focusComposer = (options?: FocusOptions) => {
  const focused = document.querySelector("[data-frame][data-focused]")
  const composer = (focused ? composerTextbox(focused) : null) ?? composerTextbox()
  composer?.focus(options)
}
