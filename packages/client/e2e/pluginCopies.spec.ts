import { pluginDisplayCopyTests } from "./support/pluginDisplayCopies.ts"
import { pluginCopyApprovalTests } from "./support/pluginCopyApproval.ts"
import { pluginCopyTests, copiedPresenceTests } from "./support/pluginCopies.ts"

pluginCopyTests()

copiedPresenceTests()

pluginCopyApprovalTests()

pluginDisplayCopyTests()
