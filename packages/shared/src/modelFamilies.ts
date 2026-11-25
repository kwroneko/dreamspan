// Wire capabilities inferred from versioned IDs, including namespace and inference-profile prefixes.
export const openAIStructuredTools = /(?:^|[./])gpt-(?:4o|4\.1|[5-9]|[1-9]\d+)(?:$|[.-])/i
export const openAIResponseToolSearch = /(?:^|[./])gpt-(?:5\.(?:[4-9]|[1-9]\d+)|(?:[6-9]|[1-9]\d+)(?:\.\d+)?)(?:$|-)/i
export const openAIExplicitCacheMode = /(?:^|[./])gpt-(?:5\.(?:[6-9]|[1-9]\d+)|(?:[6-9]|[1-9]\d+)(?:\.\d+)?)(?:$|-)/i
