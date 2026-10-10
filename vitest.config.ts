import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "server",
          root: "packages/server",
          include: ["test/**/*.test.ts"],
          environment: "node",
          testTimeout: 30_000
        }
      }
    ]
  }
})
