import { test } from "@playwright/test"
import { googleConnectionTests } from "./support/googleConnection.ts"

test.describe("native Google", googleConnectionTests)
