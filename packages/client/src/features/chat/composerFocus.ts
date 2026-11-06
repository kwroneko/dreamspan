// The composer to focus from a chat's command: the focused frame's, since two frames can each
// show a chat (features/workbench), then any.
export const focusComposer = (options?: FocusOptions) => {
  const composer =
    document.querySelector<HTMLElement>('[data-frame][data-focused] textarea[data-testid="composer"]') ??
    document.querySelector<HTMLElement>('textarea[data-testid="composer"]')
  composer?.focus(options)
}
