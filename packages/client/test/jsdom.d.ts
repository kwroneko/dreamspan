// The part of jsdom the tests use. @types/jsdom isn't installed: Vitest's optional types import
// it when present, which would put the DOM's types into the server's compilation.
declare module "jsdom" {
  export class JSDOM {
    constructor(html?: string)
    readonly window: Window & typeof globalThis
  }
}
