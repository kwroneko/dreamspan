// Whether a popup of these roles is open: a key such as Escape is then its. A popover kept
// mounted while closed (`keepMounted`, as the Cast rows' menus) stays in the page marked
// `data-closed`, and doesn't count.
export const popupOpen = (roles: ReadonlyArray<string> = ["dialog", "alertdialog"]) =>
  typeof document !== "undefined" &&
  document.querySelector(roles.map((role) => `[role="${role}"]:not([data-closed])`).join(", ")) !== null
