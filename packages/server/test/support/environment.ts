// Direct service tests use the same scrub before importing any provider modules.
import { scrubProviderEnvironment } from "../../src/providerEnvironment.ts"

scrubProviderEnvironment()
