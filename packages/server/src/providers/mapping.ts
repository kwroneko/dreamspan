// Pin mapping capabilities without copying arbitrary compat values into snapshots.
import { createHash } from "node:crypto"
import { canonicalJson } from "@dreamspan/shared/editing.ts"
import type { EffectiveModel } from "@dreamspan/shared/providers.ts"
import type { ModelInput } from "../assembler/types.ts"

export const mappingCapabilities = (model: EffectiveModel): NonNullable<ModelInput["mapping"]> => ({
  reasoning: model.reasoning.value,
  ...(model.midChatSystem.source !== "unknown" ? { midChatSystem: model.midChatSystem.value } : {}),
  supportsDeveloperRole: model.compat.supportsDeveloperRole !== false,
  revision: createHash("sha256")
    .update(
      canonicalJson({
        reasoning: model.reasoning.value,
        vision: model.vision.value,
        maxImages: model.maxImages.value,
        midChatSystem: model.midChatSystem,
        tools: model.tools.value,
        thinkingLevels: model.thinkingLevels.value,
        maxOutput: model.maxOutput.value,
        compat: model.compat,
        sampling: model.sampling
      })
    )
    .digest("hex")
})
