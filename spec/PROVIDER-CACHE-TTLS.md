# Provider prompt-cache lifetimes

**Status**: Reference, 2026-10-13. How long each provider keeps a prompt cache, from official documentation where it exists, researched by GPT-6.1-Sol. Every figure quotes its source. Used for the cache-warmth estimate's built-in defaults (DESIGN §5.5).

Research date: **2026-10-13, Europe/Rome** (retrieval began 2026-10-12 UTC). Every source linked below was searched/read or fetched on **2026-10-13** in that timezone. Publication/update dates are recorded when the retrieved page supplies them; otherwise they are **not stated**. This is a dated snapshot, not a promise about future API behavior.

## What the indicator should mean

Use three states: **hit confirmed on the last request**, **likely warm until an estimated expiry**, and **unknown**. A TTL countdown cannot establish that the next request will hit: the prefix must still match and routing must reach a server with the entry. A hit proves reuse on that request only. A partial hit might cover much less than the character card and conversation the app intends to cache.

The final table uses seconds. **0 means “not documented sufficiently to assign a numeric countdown”; it does not mean caching is disabled.** “Documented” describes the published TTL policy, not guaranteed cache availability. “Inferred” identifies an application fallback, including using 0 for unknown. Extended rows apply only when that option was actually requested/accepted. Do not interpret a 24-hour retention ceiling as a 24-hour minimum.

Start a sliding timer from the request that actually wrote/read the relevant prefix. Anthropic specifically measures from **request start**, including generation time. For a conservative implementation use request-start time elsewhere too, unless the provider gives an explicit resource expiry. For explicit Gemini objects, use the returned **expireTime**, not a sliding timer.

Multipliers below are relative to that model's ordinary, uncached input-token price. A write price is the total price for those write tokens unless explicitly described as an additional fee. “No write surcharge” means ordinary input processing remains billable. Storage fees are separate.

Short exact lifetime quotations appear below. Where the whole sentence or multiple sentences would exceed a source's quotation allowance, I identify an **exact excerpt** or **table text** instead of presenting it as a complete sentence. All numbers are supported by the adjacent source.

## Provider inventory and boundaries

Read only the requested dependency's code/metadata and system skill instructions; no user-data directories were inspected. Local source, read 2026-10-13: ~/projects/rp-harness/node_modules/@earendil-works/pi-ai/package.json and dist/types.d.ts, version **1.0.3**. Its KnownProvider list is:

amazon-bedrock, ant-ling, anthropic, google, google-vertex, openai, azure, openai-codex, radius, typesafe, nvidia, deepseek, github-copilot, xai, groq, cerebras, openrouter, vercel-ai-gateway, zai, zai-coding-cn, mistral, minimax, minimax-cn, moonshotai, moonshotai-cn, huggingface, fireworks, together, baseten, opencode, opencode-go, kimi-coding, meta, cloudflare-workers-ai, cloudflare-ai-gateway, qwen-token-plan, qwen-token-plan-cn, qwen-token-plan-individual, xiaomi, xiaomi-token-plan-cn, xiaomi-token-plan-ams, xiaomi-token-plan-sgp.

The additional documented cache providers found are Azure, MiniMax, Cerebras, Vercel AI Gateway, Baseten, Cloudflare Workers AI, Xiaomi MiMo, and GitHub Copilot. NVIDIA documents NIM caching, but that is a self-hosted product, not a TTL contract for pi-ai's integrate.api.nvidia.com endpoint. OpenCode documents cache pricing; its current page could not be fetched successfully, so its evidence is weaker. Regional/coding/token-plan identifiers are not automatically equivalent to each provider's pay-as-you-go API.

pi-ai defines normalized usage.cacheRead and usage.cacheWrite, plus Anthropic usage.cacheWrite1h. Verify that the selected adapter actually preserves the provider's raw fields before using the normalized values. The dependency's own promptCache metadata is not an official provider guarantee.

## Anthropic — Claude Messages

**Opt-in:** explicit block markers, or automatic breakpoint placement enabled by top-level cache_control. Default marker: {"type":"ephemeral"}; explicitly selecting the default may use ttl:"5m"; extended: {"type":"ephemeral","ttl":"1h"}. Automatic placement still requires opt-in.

**Lifetime:** 300 seconds default; 3,600 seconds extended; hits renew the selected duration free of another write charge. These are minimum lifetimes, not published absolute maxima. Exact default sentence: “By default, the cache has a 5-minute lifetime.” Extended pricing table text: “Cache valid for 1 hour”. Countdown runs from request start. [Caching documentation](https://platform.claude.com/docs/en/build-with-claude/prompt-caching), [pricing](https://platform.claude.com/docs/en/about-claude/pricing) — both read 2026-10-13; page update dates not stated in retrieved text.

**Minimum prefix:** 512 tokens for Fable 5.1, Mythos 5.1, Opus 5.5/5, Sonnet 5.5, Fable/Mythos 5 and Haiku 5.5; 1,024 for Opus 4.8 and Sonnet 5/4.6/4.5/4 and Opus 4.1/4; 2,048 for Opus 4.7/Mythos Preview and Haiku 3.5; 4,096 for Opus 4.6/4.5 and Haiku 4.5. Availability varies. Use Bedrock's own thresholds there. [Caching documentation](https://platform.claude.com/docs/en/build-with-claude/prompt-caching), read 2026-10-13.

**Response/cost:** usage.cache_read_input_tokens > 0 confirms a read; usage.cache_creation_input_tokens counts writes; usage.cache_creation.ephemeral_5m_input_tokens and ephemeral_1h_input_tokens split writes. Ordinary usage.input_tokens excludes both reads and writes. Writes: 1.25× for 5m, 2× for 1h. Reads: usually 0.1×; Fable/Mythos 5.1: 0.025×; Opus/Sonnet 5.5: 0.05×. [Pricing](https://platform.claude.com/docs/en/about-claude/pricing), read 2026-10-13.

## OpenAI — automatic caching, newer explicit mode, model differences

The current documentation has changed substantially from the original 2024 policy.

| Model group | Enable/request | Published lifetime |
| --- | --- | --- |
| GPT-5.6 and later | Automatic implicit by default; prompt_cache_options.mode:"explicit" plus prompt_cache_breakpoint for explicit boundaries; prompt_cache_options.ttl:"30m" | Minimum 1,800 seconds after latest write/reuse; may last longer; no numeric maximum documented |
| Earlier models, in_memory | Automatic; prompt_cache_retention:"in_memory" where supported | Typically 300–600 seconds idle, up to 3,600 seconds |
| Earlier models, 24h | Automatic; prompt_cache_retention:"24h" where supported | Typically about 1,800 seconds; maximum 86,400 seconds, not a guaranteed full day |
| GPT-5.5 / GPT-5.5 Pro | Only 24h retention supported | Same extended policy |

Exact lifetime excerpts from the current guide: “5 to 10 minutes of inactivity, up to one hour.” and “around 30 minutes and can retain them for up to 24 hours.” For the new default, the exact sentence is: “The only supported value, `30m`, is also the default.” The latter sentence is quoted from Microsoft's corresponding GPT-5.6 policy; OpenAI's own guide independently documents the same 30-minute minimum. [OpenAI caching guide](https://developers.openai.com/api/docs/guides/prompt-caching), [Azure caching guide](https://learn.microsoft.com/en-us/azure/foundry/openai/how-to/prompt-caching) — read 2026-10-13; update dates not stated in retrieved text.

OpenAI explicitly says reuse refreshes lifetime without another write charge. On earlier dual-policy models, current defaults depend on organization policy: without ZDR, 24h; with ZDR, in_memory. Extended support is listed for gpt-5.5, gpt-5.5-pro, gpt-5.4, gpt-5.2, gpt-5.1-codex-max, gpt-5.1, gpt-5.1-codex, gpt-5.1-codex-mini, gpt-5.1-chat-latest, gpt-5, gpt-5-codex and gpt-4.1. Minimum is 1,024 visible tokens on GPT-5.6+; older models' effective minimum varies with request settings. Older cached counts round down to 128-token multiples. [OpenAI caching guide](https://developers.openai.com/api/docs/guides/prompt-caching), read 2026-10-13.

Responses: usage.input_tokens_details.cached_tokens; newer write reporting: usage.input_tokens_details.cache_write_tokens. Chat Completions uses usage.prompt_tokens_details.cached_tokens; do not assume every older endpoint reports a separate write count. A stable prompt_cache_key helps older-model routing but does not pin a machine; GPT-5.6+ handles routing automatically. Capacity/overflow can produce a miss despite valid lifetime. [OpenAI caching guide](https://developers.openai.com/api/docs/guides/prompt-caching), read 2026-10-13.

**Costs:** GPT-5.6+ writes 1.25×; reads generally 0.1×, GPT-6.1 Sol 0.05×. Earlier models have no separate write premium; examples: GPT-5/5.1/5.2/5.4 reads 0.1×, GPT-4.1/o3/o4-mini 0.25×, GPT-4o/4o-mini/o1 0.5×. Some models have no cached-input price; do not infer support from API family alone. [Official pricing](https://developers.openai.com/api/docs/pricing), read 2026-10-13.

The original policy was published **2024-10-01**, but it is historical: newer model policies above take precedence. [Original announcement](https://openai.com/index/api-prompt-caching/), search-result excerpt read 2026-10-13; not used to override current docs.

## Google Gemini Developer API

**Implicit:** automatic on Gemini 2.5+. Minimum, typical, maximum lifetime and whether hits renew it are **not documented by Google**. Google's guidance is only to send matching prefixes close together. Its current Interactions guide reports hits in usage.total_cached_tokens. generateContent reports usageMetadata.cachedContentTokenCount; Python SDK spelling is usage_metadata.cached_content_token_count. No separate implicit write count. Current documented minimums: Gemini 2.5 Flash/Pro 2,048; listed Gemini 3 Flash/Pro models 4,096. [Current caching guide](https://ai.google.dev/gemini-api/docs/caching), [generateContent caching guide](https://ai.google.dev/gemini-api/docs/generate-content/caching) — read 2026-10-13; current guide updated **2026-10-09**.

**Best available secondary evidence:** OpenRouter says Gemini implicit TTL averages 3–5 minutes, with variation. This is OpenRouter's claim about its routes, not a Google guarantee or evidence that hits slide the timer. A 180-second estimate is optional for those routes; the conservative Google-direct table value remains 0. See the OpenRouter section.

**Explicit:** create cachedContents with ttl (duration such as "3600s") or expireTime, then reference its name in generateContent.cachedContent. Default 3,600 seconds. Exact sentences: “If not set, the TTL defaults to 1 hour.” and “There are no minimum or maximum bounds on the TTL.” The explicit guide leaves the minimum cached-token size model-dependent rather than publishing a separate universal threshold. Hits do not update the resource expiry; patch it explicitly. Creation returns expireTime and usageMetadata.totalTokenCount; generation's cachedContentTokenCount confirms use. The Interactions API does not support explicit cached-content objects. [generateContent caching guide](https://ai.google.dev/gemini-api/docs/generate-content/caching), [cachedContents API reference](https://ai.google.dev/api/caching) — read 2026-10-13; update dates not stated in retrieved portions.

**Costs:** model/tier-specific. Standard Gemini 2.5 Flash: $0.30 ordinary vs $0.03 cached per million text tokens = 0.1×; Pro: $1.25 vs $0.125 in the lower context tier = 0.1×. Explicit storage: $1/M token-hour for 2.5 Flash/Flash-Lite, $4.50/M token-hour for 2.5 Pro. Implicit has no separately managed storage fee. Do not reuse the old universal 0.25× claim. [Developer API pricing](https://ai.google.dev/gemini-api/docs/pricing), read 2026-10-13.

## DeepSeek — context caching on disk

**Automatic:** every request can construct disk cache; prefix units must have been persisted and fully match. Current guide describes request/output boundaries, detected common prefixes and fixed intervals, so the old “every common prefix hits immediately” simplification is unsafe.

**Lifetime:** minimum and numeric maximum **not documented**; typical unused retention is a few hours to days. Exact sentence: “Unused cache entries are automatically cleared, typically within a few hours to days.” The guide's exact qualification is “The cache system works on a "best-effort" basis and does not guarantee a 100% cache hit rate.” Hit-refresh semantics are **not explicitly documented**; cleanup being based on non-use suggests sliding activity, but that is inference. Construction can take seconds. [Current guide](https://api-docs.deepseek.com/guides/kv_cache), [official launch notice](https://api-docs.deepseek.com/news/news0802/) — read 2026-10-13; launch notice **2024-08-02**, guide update not stated. The launch notice is historical first-party corroboration.

**Minimum/usage:** launch notice specifies 64-token storage units and no caching below 64; current guide does not restate a minimum, so treat 64 as historical, not a guarantee for V4's changed persistence rules. Reads: usage.prompt_cache_hit_tokens; misses: usage.prompt_cache_miss_tokens; misses are not a dedicated count of successfully persisted writes. [Guide](https://api-docs.deepseek.com/guides/kv_cache), [launch notice](https://api-docs.deepseek.com/news/news0802/), read 2026-10-13.

**Cost:** fetched current pricing lists Flash $0.006 hit/$0.30 miss = 0.02×; V4 Pro $0.044/$1.32 = 1/30 ≈ 0.0333× at peak; both ratios hold off-peak. No separate write surcharge listed. These replace older V3 ratios often reproduced elsewhere. [Models and pricing](https://api-docs.deepseek.com/quick_start/pricing), read with Exa 2026-10-13; pricing notes refer to **2026-09-14**. A later web-tool fetch timed out; the earlier complete fetch succeeded.

## OpenRouter — upstream caches and its routing timer

OpenRouter supports provider-side caching on **supported provider/model endpoints**, not a guarantee that every endpoint supports every upstream parameter. It forwards/normalizes explicit markers and uses automatic upstream caches. Route changes/fallbacks can lose reuse. Anthropic top-level cache_control is translated to a trailing breakpoint for Bedrock; per-block markers work with supported Claude providers. Upstream minimums/costs apply, but compare the actual endpoint price: some examples in OpenRouter's guide lag current upstream pricing.

**Separate timers:** sticky routing idles out after 600 seconds; successful requests reset it. Exact excerpt: “10 minutes of inactivity.” Use session_id or x-session-id to identify a conversation; prompt_cache_key is a fallback key. Manual provider.order takes priority over automatic stickiness. Pin provider.only if the indicator depends on upstream identity. Sticky routing tracks a provider endpoint, not a guarantee of a specific cache-bearing machine.

**Gemini via OpenRouter:** implicit is automatic; exact TTL excerpt: “on average 3-5 minutes, but will vary.” Explicit uses cache_control and managed upstream cache objects; exact sentence: “Cache Writes have a 5 minute Time-to-Live (TTL) that does not update.” Therefore explicit default is 300 seconds **fixed**, unlike Claude's sliding lifetime.

Reads: usage.prompt_tokens_details.cached_tokens; writes: usage.prompt_tokens_details.cache_write_tokens. cache_discount is a money effect, not a reliable substitute for token hit count. Claude's TTL can remain valid after sticky routing expires; use 600 seconds as a routing cap for a conservative unpinned extended-Claude indicator, or retain 3,600 only with known stable upstream selection.

Source for this section: [OpenRouter prompt caching](https://openrouter.ai/docs/guides/best-practices/prompt-caching), read 2026-10-13; update date not stated. It is **primary documentation for OpenRouter behavior**, and **secondary evidence for Google's undocumented implicit TTL**. Its direct-Gemini minimums/prices conflict with the current Google docs; do not propagate them to Google-direct settings.

OpenRouter also documents full **response caching** with its own headers and TTL. It is a different feature, not prefix/KV warmth. [Response caching](https://openrouter.ai/docs/guides/features/response-caching), search-result content read 2026-10-13.

## xAI Grok

Automatic on Grok language models. Numeric minimum, typical and maximum lifetime, hit-refresh rule, and minimum prefix are **not documented**. Exact availability qualification: “Cache entries can be evicted at any time due to server load or restarts.” Use x-grok-conv-id for sticky routing, or prompt_cache_key in Responses. [Overview](https://docs.x.ai/developers/advanced-api-usage/prompt-caching), [how it works](https://docs.x.ai/developers/advanced-api-usage/prompt-caching/how-it-works), [FAQ](https://docs.x.ai/developers/advanced-api-usage/prompt-caching/best-practices), [routing](https://docs.x.ai/developers/advanced-api-usage/prompt-caching/maximizing-cache-hits) — read 2026-10-13; overview/how-it-works updated **2026-03-16**, FAQ **2026-05-10**.

Chat reads: usage.prompt_tokens_details.cached_tokens; Responses: usage.input_tokens_details.cached_tokens. No distinct write accounting or premium documented in caching billing. Current examples: Grok 4.7/4.6 reads 0.25×; 4.5 0.15×; 4.3 0.16×; Grok Build 0.20×. [Cache usage/pricing](https://docs.x.ai/developers/advanced-api-usage/prompt-caching/usage-and-pricing), [pricing](https://docs.x.ai/developers/pricing) — read 2026-10-13; usage page updated **2026-05-10**, pricing update not stated. Keep TTL 0; no reputable numeric secondary TTL was established.

## Mistral

API-managed prefix caching; documented enable/routing practice is a stable prompt_cache_key on related requests. The guide does not establish that caching is disabled without a key. Minimum block is 64 tokens; cached counts are multiples of 64. Reads: usage.prompt_tokens_details.cached_tokens, zero or omitted on a miss. A separate write field is **not documented**.

Minimum/typical/maximum TTL and hit-refresh rule are **not documented in the fetched official guide**. The key improves odds rather than guaranteeing a hit. Reads cost 0.1×; uncached remainder ordinary rate; no separate write premium is shown. [Prompt caching](https://docs.mistral.ai/studio/conversations/advanced/prompt-caching), [pricing](https://mistral.ai/pricing/) — read 2026-10-13; update dates not stated. Search surfaced informal claims about 5–10 minutes, but no qualifying official or reputable engineering source was established, so they are not used.

## Moonshot/Kimi

**Kimi K3:** Chat Completions/Responses automatically use 5m. Override with prompt_cache_options:{"mode":"implicit","ttl":"1h"}. Messages API requires **top-level** cache_control to write; omitting it only reads existing 5m cache. Per-message markers are ignored on this endpoint. Exact sentence: “Cache Write supports two TTLs: `5m` and `1h`.” Defaults: 300 seconds; extended: 3,600; hits renew the original TTL free. TTL is locked at first write; wait for expiry before changing it. No longer retention maximum documented. [Current cache guide](https://platform.kimi.ai/docs/guide/context-caching), read 2026-10-13; update date not stated.

K3 minimum numerical prefix is **not documented** in the current guide (it requires complete cache blocks). Older automatic-cache material said the previous prompt must exceed 256 tokens, but the URL now redirects to the new guide; do not apply that historical threshold as a K3 contract. K2.7/K2.6 explicitly do not support the new Cache Write feature; their numeric retention/hit-refresh contract is **not established**.

Reads/writes: Chat usage.prompt_tokens_details.cached_tokens/cache_write_tokens; Responses usage.input_tokens_details.cached_tokens/cache_write_tokens; Messages usage.cache_read_input_tokens/cache_creation_input_tokens, with usage.cache_creation.ephemeral_5m_input_tokens/ephemeral_1h_input_tokens. Streaming Chat requires stream_options.include_usage:true. [Current guide](https://platform.kimi.ai/docs/guide/context-caching), read 2026-10-13.

Costs, K3: 5m write $3/M = 1× ordinary input; 1h write $6/M = 2×; read $0.30/M = 0.1×. Exact default sentence: “If no TTL is specified, the 5min tier applies by default.” [Pricing explanation](https://platform.kimi.ai/docs/pricing/chat), read 2026-10-13. The upgrade announcement is dated **2026-09-28** and corroborates the change. [Official announcement](https://forum.moonshot.ai/t/context-caching-upgrade-5-min-1-hour-ttl-options/613), search excerpt read 2026-10-13; first-party announcement, supplementary evidence.

Kimi Coding uses a separate endpoint; no official numeric TTL contract was established. A third-party SDK author has empirical tests, but its status is neither an official guarantee nor a sufficiently broad engineering reference to assign a default here. Thus table TTL 0. [SDK cache experiments](https://github.com/Leechael/pi-provider-kimi-code/blob/main/docs/caching.md), search excerpt read 2026-10-13; **secondary, limited empirical evidence**, not used for a numeric timer.

## Zhipu GLM / Z.AI

Automatic. Minimum prefix, numeric minimum/typical/maximum retention and hit-refresh rule are **not documented** by the fetched Z.AI guide. Best evidence is its statement that caches have time limits and recalculation follows expiry; it supplies no number. Reads: usage.prompt_tokens_details.cached_tokens. Distinct write token field not documented. [Context caching](https://docs.z.ai/guides/capabilities/cache), read 2026-10-13; update date not stated.

Use model pricing rather than the guide's illustrative “usually 50%” discount. GLM-5.3 $0.26/$1.40 ≈ 0.1857×; GLM-5 $0.20/$1 = 0.20×; GLM-4.7 $0.11/$0.60 ≈ 0.1833×. Storage is listed as limited-time free; no separate write premium shown. [Official pricing](https://docs.z.ai/guides/overview/pricing), read 2026-10-13; update date not stated. Alibaba documents 512 tokens for **Zhipu-deployed GLM routes**; that is platform-specific evidence, not a direct-Z.AI minimum. [Alibaba cache guide](https://www.alibabacloud.com/help/en/model-studio/context-cache), read 2026-10-13.

## Qwen / Alibaba DashScope / Model Studio

Two mutually exclusive modes. **Implicit:** automatic, cannot be disabled; no fixed expiry; minimum 1,024 tokens on Alibaba-hosted models. Numeric typical/maximum TTL and renewal semantics **not documented**. **Explicit:** cache_control:{"type":"ephemeral"} on content blocks; minimum 1,024; default/only documented duration 300 seconds, sliding on hits. Exact sentence: “Each hit resets the cache block's validity period to 5 minutes.” No extended explicit TTL documented. Cache is created after generation completes.

OpenAI-compatible and DashScope reads: usage.prompt_tokens_details.cached_tokens; explicit writes: usage.prompt_tokens_details.cache_creation_input_tokens (not OpenRouter's cache_write_tokens). Anthropic-compatible reads/writes: usage.cache_read_input_tokens/cache_creation_input_tokens.

Implicit creation ordinary price 1×, reads usually 0.2×. Explicit writes usually 1.25× and reads 0.1×; eligible models/deployment scopes and tiered prices vary. Responses API has separate session-cache settings, so do not apply this explicit-marker contract to it without checking that API. [Cache guide](https://www.alibabacloud.com/help/en/model-studio/context-cache), [model pricing](https://www.alibabacloud.com/help/en/model-studio/model-pricing) — read 2026-10-13; update dates not stated. The token-plan provider IDs have no independently established TTL contract here.

## Groq

Automatic, currently documented for openai/gpt-oss-20b, openai/gpt-oss-120b and openai/gpt-oss-safeguard-20b. Exact sentence: “All cached data automatically expires after 2 hours without use.” Therefore the published idle window is 7,200 seconds; a use renews activity by inference from “without use,” not an explicit “each hit resets TTL” statement. No shorter guaranteed retention or absolute active-session maximum is documented. Hits are not guaranteed.

Minimum prefix varies **128–1,024 tokens** by model; the guide does not map exact thresholds to each listed model. Reads: usage.prompt_tokens_details.cached_tokens. Writes not separately reported. Read price 0.5×; no write surcharge; the cache discount does not stack with Batch's discount. [Groq prompt caching, including pricing](https://console.groq.com/docs/prompt-caching), read 2026-10-13; update date not stated. The public groq.com/pricing URL redirected to the home page, so it did not supply an independent price table. Do not extend the current supported-model list from older OpenRouter examples.

## Together AI

Automatic on serverless and dedicated inference. Exact sentences: “Cache entries typically last about an hour.” and “This is done on a best effort basis.” Thus typical 3,600 seconds, **no guaranteed minimum or numeric maximum**; heavy load can evict earlier. Hit-refresh is **not documented**. Minimum/granularity varies by model and can change; no fixed numerical threshold. prompt_cache_key improves routing; on dedicated endpoints it also supplies deployment stickiness.

Reads: usage.prompt_tokens_details.cached_tokens; some models instead return usage.cached_tokens. No separate write surcharge. Serverless reads use model-specific cached-input rates; models without a cached-input price bill input at 1×. Dedicated is GPU-time billed, not token multipliers. [Prompt caching, including billing](https://docs.together.ai/docs/inference/chat/prompt-caching), read 2026-10-13; update date not stated.

A separate **v1 dedicated-endpoint** page says prefixes stay active while the endpoint is running. That page is version-scoped and v1 is slated for deprecation at end-2026; it is not a transferable serverless guarantee or a fixed TTL. [v1 endpoint settings](https://docs.together.ai/docs/dedicated-endpoints/v1/settings), read 2026-10-13; update date not stated. The official pricing page was subsequently fetched successfully: MiniMax M3 reads $0.06/$0.30 = 0.2×; GLM-5.3 $0.26/$1.40 ≈0.1857×; DeepSeek V4.1 Flash $0.006/$0.30 = 0.02×. No write surcharge. [Together pricing](https://www.together.ai/pricing), read 2026-10-13; update date not stated. Kimi has promotional values on that page, so do not treat a promotional ratio as universal.

## Fireworks

Automatic on all models/deployments. Typical lower-duration exact excerpt: “at least several minutes.” Upper-duration exact sentence: “Depending on the model, load level, and deployment configuration, it can be up to several hours.” These are qualitative expectations, **not numeric minimum/maximum guarantees**. Hit-refresh rule and minimum prefix size **not documented**.

Cache lives on one replica. Send user or x-session-affinity to improve routing. Dedicated hit evidence: response header fireworks-cached-prompt-tokens; total prompt header fireworks-prompt-tokens. Serverless reads: usage.prompt_tokens_details.cached_tokens, confirmed by Fireworks' official SDK types generated from its OpenAPI specification. The prose caching guide only explicitly documents dedicated headers. No documented separate write count there. [Official cache guide](https://docs.fireworks.ai/guides/prompt-caching), read 2026-10-13; update date not stated.

Pricing guide's general default is 0.5× reads; current per-model prices differ considerably: Kimi K3 0.1×, DeepSeek V4.1 Flash 0.02×, GLM 5.3 Flash 0.2×, GLM 5.3 ≈0.1857×. No separate write premium shown; dedicated is GPU-time billing. [Serverless pricing](https://docs.fireworks.ai/serverless/pricing), [pricing landing page](https://fireworks.ai/pricing), read 2026-10-13. Primary field evidence: [Fireworks SDK UsageInfo](https://raw.githubusercontent.com/fw-ai-external/python-sdk/main/src/fireworks/types/shared/usage_info.py) and [PromptTokensDetails](https://raw.githubusercontent.com/fw-ai-external/python-sdk/main/src/fireworks/types/shared/prompt_tokens_details.py), fetched 2026-10-13; file update dates not stated. [LangChain adapter](https://searchcode.com/repo/github.com/langchain-ai/langchain/file?path=libs%2Fpartners%2Ffireworks%2Flangchain_fireworks%2Fchat_models.py) was also read as a search excerpt 2026-10-13; supplementary SDK evidence, not TTL evidence.

## AWS Bedrock — Claude, OpenAI, and Gemini availability

Claude caching uses **explicit checkpoints**: Converse/ConverseStream content cachePoint:{"type":"default"}, or InvokeModel Claude cache_control:{"type":"ephemeral"}. Extended uses ttl:"1h" on the checkpoint; omit ttl for older models without extended support. Simplified automatic breakpoint management is available for supported integrations, but do not assume a direct Claude top-level field is accepted unchanged by every Bedrock API.

Default 300 seconds; extended 3,600 on supported current Claude models. Exact default sentence: “If no `ttl` value is provided, the default 5-minute caching behavior applies.” Cache hits reset TTL. Exact extended announcement sentence: “Amazon Bedrock now supports a 1-hour time-to-live (TTL) option for prompt caching for select Anthropic Claude models.” No numeric maximum beyond the chosen inactivity TTL is documented. [Bedrock caching](https://docs.aws.amazon.com/bedrock/latest/userguide/prompt-caching.html), [extended-duration announcement](https://aws.amazon.com/about-aws/whats-new/2026/01/amazon-bedrock-one-hour-duration-prompt-caching/) — read 2026-10-13; announcement **2026-01-26**.

Minimums: current 5.5 Claude/Fable/Mythos/Opus 5 groups 512; Sonnet 5/4.6/4.5 and Opus 4.8 1,024; **Bedrock Opus 4.7/4.6/4.5 and Haiku 4.5 4,096**. Converse reads/writes: usage.cacheReadInputTokens/cacheWriteInputTokens; InvokeModel Claude uses usage.cache_read_input_tokens/cache_creation_input_tokens. Writes 1.25× or 2×; read ratios model-specific; familiar Claude 4.x examples 0.1×. [Caching docs](https://docs.aws.amazon.com/bedrock/latest/userguide/prompt-caching.html), [pricing](https://aws.amazon.com/bedrock/pricing/), read 2026-10-13.

Bedrock also documents GPT-5.6/6.1 cache models with 1,024-token minimum and 30-minute minimum TTL. Responses/Chat cache options and usage paths follow the applicable OpenAI-compatible API; Converse does not support explicit GPT-6.1 caching. Exact sentence: “The TTL is set via `prompt_cache_options.ttl` and defaults to `30m`.” [Bedrock caching docs](https://docs.aws.amazon.com/bedrock/latest/userguide/prompt-caching.html), read 2026-10-13. (This quotation plus the default-Claude sentence exceeds neither source's short quotation allowance.)

**Gemini on Bedrock:** no Bedrock-hosted Gemini cache API or policy was established from the supported-model/caching documentation; mark **not applicable / availability not established**, not 300 seconds by analogy. Bedrock AgentCore's ability to call external Gemini is not Bedrock-hosted Gemini inference. [Supported foundation models](https://docs.aws.amazon.com/bedrock/latest/userguide/models-supported.html), read 2026-10-13; the page now delegates its catalog to model cards.

## Google Vertex AI — Claude and Gemini

The requested Vertex documentation URLs currently redirect to Google's **Gemini Enterprise Agent Platform** documentation. API contracts below are from those fetched official successors; keep endpoint/version compatibility in view.

**Claude:** explicit cache_control with default 300 seconds; ttl:"1h" for extended 3,600. Exact default excerpt: “five-minute lifetime or time to live (TTL).” Exact extended excerpt: “extend the TTL to one hour”. Hits refresh it. Older 3.7/3.5 Sonnet and Claude 3 Opus lack one-hour support. Minimums follow applicable Claude model documentation; read/write fields are Anthropic usage.cache_read_input_tokens/cache_creation_input_tokens. Writes 1.25×/2×; the platform guide lists reads 0.1×; model-specific successor prices should be checked in platform pricing. [Claude caching](https://docs.cloud.google.com/vertex-ai/generative-ai/docs/partner-models/claude/prompt-caching), [platform pricing](https://cloud.google.com/vertex-ai/generative-ai/pricing) — read 2026-10-13; Claude guide updated **2026-10-09**.

**Gemini implicit:** automatic for projects; lifetime minimum/typical/maximum and hit-refresh **not documented**. Reads: usageMetadata.cachedContentTokenCount. Minimums: Gemini 2 family 2,048; Gemini 3 family generally 4,096; listed 3.0 Flash Preview, 3.1 Pro Preview, 3.7 Flash and 3.8 Flash **implicit** minimum 6,144. Reads 0.1×; ordinary creation input 1×; no implicit storage fee. [Context caching overview](https://docs.cloud.google.com/vertex-ai/generative-ai/docs/context-cache/context-cache-overview), read 2026-10-13.

**Gemini explicit:** create cachedContents, select ttl/expireTime and reference name in generation. Default 3,600 seconds. Exact sentence: “The default expiration time of a context cache is 60 minutes after its creation time.” [Update a context cache](https://docs.cloud.google.com/vertex-ai/generative-ai/docs/context-cache/context-cache-update), read 2026-10-13.

Range table exact text: “1 minute” minimum; “There isn't a maximum cache duration” maximum. Thus minimum 60 seconds; no maximum stated. Reads do not renew expireTime; update explicitly before expiry. Reads: usageMetadata.cachedContentTokenCount; creation usageMetadata.totalTokenCount measures cached content, not read use. Explicit reads 0.1× on 2.5+, 0.25× on 2.0; creation ordinary input 1× plus model-specific token-hour storage. [Overview](https://docs.cloud.google.com/vertex-ai/generative-ai/docs/context-cache/context-cache-overview), [pricing](https://cloud.google.com/vertex-ai/generative-ai/pricing), read 2026-10-13; overview/update dates not stated in retrieved portions.

## Additional pi-ai providers with cache documentation

### Azure OpenAI / Microsoft Foundry

Automatic. GPT-5.6+ supports the 1,800-second minimum and newer explicit boundaries; reuse-relative refresh is not stated as clearly in Microsoft's page, so mark unknown rather than importing OpenAI's operational guarantee. Earlier in_memory typical 300–600 seconds, removed within 3,600 after last use. Earlier extended ceiling 86,400, no minimum given. Exact lifetime excerpts: “5 to 10 minutes of inactivity” and “up to a maximum of 24 hours.” For GPT-5.4 and older default is in_memory; GPT-5.5 defaults to extended. This differs from OpenAI-direct defaults.

Minimum 1,024, old 128-token increments. Chat read/write fields: usage.prompt_tokens_details.cached_tokens/cache_write_tokens (write field for newer models); Responses uses input_tokens_details. Standard read multipliers are model-specific; provisioned cached reads can be discounted up to 100% (0×). Earlier models have no write surcharge. GPT-5.6+ writes can incur charges, but numeric write/read multipliers could not be established from the inaccessible Azure pricing page; they are **not established here**, rather than copied from OpenAI-direct prices. PTU-M does not expose the newer write field or support explicit breakpoints. Azure specifically recommends prompt_cache_key even for GPT-5.6+. [Microsoft guide](https://learn.microsoft.com/en-us/azure/foundry/openai/how-to/prompt-caching), read 2026-10-13; update date not stated. Its 30m default sentence was quoted in the OpenAI section above. Microsoft lists the page update date as **2026-08-11**; Azure pricing fetch was inaccessible on 2026-10-13. Extended support list includes Azure's gpt-5.3-codex; use the Azure-specific list.

### MiniMax

**Automatic/passive:** available on documented M3 and M2.x models; minimum 512 input tokens; TTL adjusts with system load, numerical lifetime and renewal **not documented**. Reads: usage.prompt_tokens_details.cached_tokens; no additional passive-write charge.

**Explicit Anthropic-compatible:** cache_control markers; 300-second sliding TTL. Exact sentence: “Cached content has a lifetime of 5 minutes.” Hits renew free. Its explicit guide does not separately publish a minimum; don't silently claim the passive 512 threshold guarantees explicit eligibility. Reads/writes: usage.cache_read_input_tokens/cache_creation_input_tokens. One-hour explicit retention not documented. [Passive caching](https://platform.minimax.io/docs/api-reference/text-prompt-caching), [explicit caching](https://platform.minimax.io/docs/api-reference/anthropic-api-compatible-cache), read 2026-10-13; update dates not stated.

M2.7 ordinary $0.30/M, reads $0.06/M = 0.2×; explicit writes $0.375/M = 1.25×. M2.7-highspeed ordinary $0.60/M with same $0.06/$0.375 = 0.1× read, 0.625× write, so universal Anthropic multipliers are incorrect here. M3 passive reads 0.2×. [Pay-as-you-go pricing](https://platform.minimax.io/docs/guides/pricing-paygo), read 2026-10-13.

### Cerebras

Automatic; optional prompt_cache_key helps routing. Exact sentence: “We guarantee a Time-To-Live (TTL) of 5 minutes, though caches may persist up to 1 hour depending on system load.” Minimum lifetime 300 seconds, possible maximum 3,600; hit-refresh **not documented**. Keep a write-anchored 300-second timer instead of extending solely on reads. Blocks 128 tokens; numeric minimum beyond block eligibility not explicitly specified. Reads: usage.prompt_tokens_details.cached_tokens (prose has a singular prompt_token_details typo; JSON is plural). Writes not separately reported. **Reads 1×, writes ordinary 1×; no caching discount**, although latency improves. [Cerebras caching](https://inference-docs.cerebras.ai/capabilities/prompt-caching), [pricing](https://www.cerebras.ai/pricing), read 2026-10-13; update dates not stated.

### Vercel AI Gateway

Passes upstream caching; caching:"auto" under providerOptions.gateway adds required markers for providers such as Claude/MiniMax. Other providers cache automatically. No independent KV retention duration documented. Use known upstream TTL/threshold/price, and invalidate on provider/model fallback. Current provider-options page also documents Responses controls cache_ttl (five minutes/one hour) and cache_anchor_items; its linked detailed automatic-caching page repeatedly timed out. Thus do not rely on an older article's claim that automatic mode can never select 1h.

AI SDK confirmed-hit field: usage.inputTokenDetails.cacheReadTokens; native Anthropic Messages usage.cache_read_input_tokens. Do not assume the raw OpenAI-compatible route exposes every SDK-normalized field. [Provider options](https://vercel.com/docs/ai-gateway/models-and-providers/provider-options), [official worked cache example](https://vercel.com/academy/ai-gateway/prompt-caching), [Messages API](https://vercel.com/docs/ai-gateway/sdks-and-apis/anthropic-messages-api), search result read 2026-10-13; provider options fetched 2026-10-13. Update dates not stated. [Provider article](https://vercel.com/i/prompt-caching-across-providers), search excerpts read 2026-10-13; **secondary/supplementary**, potentially stale.

### Baseten

Automatic on Model APIs; x-session-affinity routes related requests to the same replica. Numeric TTL minimum/typical/maximum, renewal and minimum prefix **not documented**. Reads: usage.prompt_tokens_details.cached_tokens, explicitly shown in pricing/limits examples; no dedicated write field/premium documented. Reads use model-specific cached-input prices: current Kimi K3 and GLM-5.3 examples 0.1×, GLM-5.3-Flash 0.2×, DeepSeek V4.1 Flash $0.007/$0.30 ≈0.0233×. No separate write surcharge listed. GPT-OSS has no cached-input price listed. [Pricing and limits](https://docs.baseten.co/inference/model-apis/pricing-and-limits), [pricing page](https://www.baseten.co/pricing/), [Model APIs overview](https://docs.baseten.co/inference/model-apis/overview), read 2026-10-13.

An older changelog established discounted caching starting **2026-04-17**, excluding GPT-OSS then; don't turn that historical exclusion into a current policy without checking the model price. [Official changelog](https://www.baseten.co/resources/changelog/cache-token-pricing-for-model-apis/), read 2026-10-13; published **2026-04-16**, supplementary first-party evidence.

### Cloudflare Workers AI and AI Gateway

**Workers AI prefix cache:** automatic on select models; x-session-affinity improves same-instance routing. TTL minimum/typical/maximum, renewal, numeric minimum prefix and a universal read/write multiplier **not documented**. Guide says cached counts appear in usage but does not identify a field path. Need model-specific schema; do not invent usage.prompt_tokens_details.cached_tokens for every Workers AI endpoint. Cached input is discounted, pricing model-specific. [Workers AI prompt caching](https://developers.cloudflare.com/workers-ai/features/prompt-caching/), read 2026-10-13; updated **2026-04-21**.

**AI Gateway:** its documented cache is **whole-response exact-request caching**, not KV caching. This does not demonstrate that an upstream prompt cache was touched/refreshed. Header cf-aig-cache-status:HIT proves a response-cache hit only; upstream cached-token counts in that old response cannot prove new upstream activity. Its configured/default response-cache TTL is a separate feature. Keep it out of the prefix countdown. [Gateway caching](https://developers.cloudflare.com/ai-gateway/features/caching/), read 2026-10-13; updated **2026-09-30**.

### Xiaomi MiMo

Pricing documents automatic prefix-cache hit billing; numeric TTL minimum/typical/maximum, renewal and minimum prefix **not documented**. API reference search excerpt identifies usage.prompt_tokens_details.cached_tokens, but full API-reference fetch yielded no readable body; field confidence is lower than the fetched pricing evidence. Write storage is limited-time free; ordinary miss input still billed. Current overseas examples: MiMo V2.6 Pro $0.0036/$0.435 ≈0.00828×; Flash $0.0028/$0.14 =0.02×. Do not reuse old model rates or assume token-plan quota rules equal cash pricing. [Official pricing](https://mimo.mi.com/docs/en-US/price/pay-as-you-go), [Chat API](https://mimo.mi.com/docs/en-US/api/chat) — read 2026-10-13; pricing updated **2026-10-08**. Chat field is **official search-excerpt evidence**, full fetch unavailable.

### GitHub Copilot, OpenCode, and NVIDIA

**Copilot:** GitHub officially says it uses prompt caching for Claude and Gemini, but does not publish an independent TTL, minimum, renewal, raw hit field, or per-token cache multipliers for pi-ai's Copilot transport. Don't assume OpenAI-direct or Claude-direct lifetimes apply unchanged. [Model hosting](https://docs.github.com/en/copilot/reference/ai-models/model-hosting), read 2026-10-13; update date not stated.

**OpenCode Zen:** official search results show cache read/write pricing and upstream-specific API routes. No independent TTL, renewal or minimum was established; raw field depends on the actual route and was not validated from a successfully fetched page. [Zen](https://opencode.ai/docs/zen), official search excerpts read 2026-10-13; repeated official page fetches returned 404. Treat as documented pricing existence, not a numeric cache contract.

**NVIDIA:** NIM self-hosted KV reuse is configured via NIM_ENABLE_KV_CACHE_REUSE, with engine/memory-dependent eviction. That does not establish caching/TTL for pi-ai's hosted integrate.api.nvidia.com API. TTL, prefix minimum, renewal, hosted response field and hosted cache multipliers remain **not documented** in the retrieved evidence. [NIM KV reuse](https://docs.nvidia.com/nim/large-language-models/1.15.0/kv-cache-reuse.html), read 2026-10-13; version **1.15.0**, publication date not stated.

For ant-ling, radius, typesafe, meta, Hugging Face router, OpenAI Codex subscription transport, regional coding plans and Qwen/Xiaomi token-plan variants, no additional independently documented numeric KV-cache contract was established. This is a research finding, not a claim those endpoints never cache. Keep unknown by default or inherit a known upstream contract only after verifying actual routing/parameters. Ant Ling's [official introduction](https://developer.ant-ling.com/en/docs/) and [FAQ](https://developer.ant-ling.com/en/docs/faq/) were seen in search results 2026-10-13; neither established a prompt-cache TTL.

## Retrieval audit and remaining limitations

Official pages were preferred. Supplemental provider announcements were used only to date changes or corroborate documentation; secondary TTL evidence is limited to OpenRouter's Gemini implicit estimate. Informal forum reports, third-party copied docs and unverified TTL measurements were not promoted into defaults.

Hugging Face official [Inference Providers overview](https://huggingface.co/docs/inference-providers/en/index) and [provider registration/billing](https://huggingface.co/docs/inference-providers/register-as-a-provider) were fetched 2026-10-13; no independent KV TTL/renewal/minimum contract was found. The latter mentions a cached *response* as a billing example, which does not establish a prefix cache. Update dates not stated. The [Azure pricing URL](https://azure.microsoft.com/en-us/pricing/details/cognitive-services/openai-service/) was attempted 2026-10-13 but failed.

Successful additional pages read 2026-10-13 but not used to establish a TTL: [OpenAI GPT-5.5 model page](https://developers.openai.com/api/docs/models/gpt-5.5), [Together structured outputs](https://docs.together.ai/docs/inference/chat/structured-outputs), [Xiaomi rate-limit page](https://mimo.mi.com/docs/en-US/api/guidance/rate-limit), [Groq home redirect](https://groq.com/). Publication/update dates not stated in the retrieved portions.

Failed/empty fetch attempts on 2026-10-13: Gemini's old /gemini-api/pricing path (replaced successfully by /gemini-api/docs/pricing); Together /docs/prompt-caching (replaced successfully by /docs/inference/chat/prompt-caching) and guessed chat-model pricing paths; xAI /prompt-caching/usage (replaced by /usage-and-pricing); Baseten guessed /development/model/performance/prompt-caching and /model-apis paths (replaced by pricing-and-limits); Vercel automatic-caching and Responses pages; Kimi guessed /docs/coding/context-caching; OpenCode Zen page variants; NVIDIA hosted search; OpenAI guessed /api/reference/responses/create; Bedrock guessed models-at-a-glance path. These failures are **not evidence that caching is absent**. Older Moonshot guide URLs redirected to the current Kimi quickstart/cache guide; no historical TTL is carried forward from those redirects.

The table's zero defaults are deliberate application decisions. A product can show “last request hit; current warmth unknown” for those providers. For qualitative best-effort caches (DeepSeek, Fireworks, Together), telemetry-informed estimates could be added later, clearly identified as estimates.

## App-ready table

A nonzero token field proves a hit **on the returned request**, not future availability. In the table, **0 = unknown; no countdown**. Where renewal is unknown, only a confirmed write may reset the conservative timer. For explicit objects, honor expireTime even if the table's default is 3,600. Linked provider names point to the supporting documentation.

| Provider | API / cache mode | Default TTL to assume, seconds | Hits refresh? | Usage field proving a hit (>0 unless noted) | Confidence |
| --- | --- | ---: | --- | --- | --- |
| [Anthropic](https://platform.claude.com/docs/en/build-with-claude/prompt-caching) | Messages, default | 300 | Yes | usage.cache_read_input_tokens | documented |
| Anthropic | Messages, requested 1h | 3600 | Yes | usage.cache_read_input_tokens | documented |
| [OpenAI](https://developers.openai.com/api/docs/guides/prompt-caching) | GPT-5.6+, Responses | 1800 | Yes | usage.input_tokens_details.cached_tokens | documented |
| OpenAI | Earlier Chat, in_memory | 300 | Yes | usage.prompt_tokens_details.cached_tokens | documented, typical |
| OpenAI | Earlier Responses, 24h | 1800 | Yes | usage.input_tokens_details.cached_tokens | documented, typical |
| [Google Gemini](https://ai.google.dev/gemini-api/docs/generate-content/caching) | generateContent, implicit | 0 | Not documented | usageMetadata.cachedContentTokenCount | inferred: unknown TTL |
| Google Gemini | Interactions, implicit | 0 | Not documented | usage.total_cached_tokens | inferred: unknown TTL |
| Google Gemini | generateContent + cachedContents, explicit | 3600 | No; update expireTime | usageMetadata.cachedContentTokenCount | documented |
| [DeepSeek](https://api-docs.deepseek.com/guides/kv_cache) | Chat, disk cache | 0 | Not documented | usage.prompt_cache_hit_tokens | inferred: qualitative TTL |
| [OpenRouter](https://openrouter.ai/docs/guides/best-practices/prompt-caching) | Chat, Claude default | 300 | Yes upstream | usage.prompt_tokens_details.cached_tokens | documented |
| OpenRouter | Chat, Claude 1h, unpinned route | 600 | Yes; route timer also slides | usage.prompt_tokens_details.cached_tokens | inferred routing cap |
| OpenRouter | Chat, Claude 1h, known pinned upstream | 3600 | Yes upstream | usage.prompt_tokens_details.cached_tokens | documented upstream |
| OpenRouter | Chat, Gemini implicit | 180 estimate | Not documented | usage.prompt_tokens_details.cached_tokens | secondary for Gemini TTL |
| OpenRouter | Chat, Gemini explicit | 300 | No | usage.prompt_tokens_details.cached_tokens | documented |
| OpenRouter | Other upstream / unknown route | 0 | Upstream-specific | usage.prompt_tokens_details.cached_tokens | inferred: unknown upstream |
| [xAI](https://docs.x.ai/developers/advanced-api-usage/prompt-caching/best-practices) | Grok Chat / Responses | 0 | Not documented | usage.prompt_tokens_details.cached_tokens / usage.input_tokens_details.cached_tokens | inferred: unknown TTL |
| [Mistral](https://docs.mistral.ai/studio/conversations/advanced/prompt-caching) | Chat, prompt_cache_key | 0 | Not documented | usage.prompt_tokens_details.cached_tokens | inferred: unknown TTL |
| [Moonshot/Kimi](https://platform.kimi.ai/docs/guide/context-caching) | K3 Chat / Responses, default | 300 | Yes | usage.prompt_tokens_details.cached_tokens / usage.input_tokens_details.cached_tokens | documented |
| Moonshot/Kimi | K3 Chat / Responses, requested 1h | 3600 | Yes | usage.prompt_tokens_details.cached_tokens / usage.input_tokens_details.cached_tokens | documented |
| Moonshot/Kimi | K3 Messages with top-level cache_control | 300; 3600 if 1h | Yes | usage.cache_read_input_tokens | documented |
| Moonshot/Kimi | K2.x / separate Coding transport | 0 | Not established | Route-specific; validate raw usage | inferred: unknown contract |
| [Z.AI / Zhipu](https://docs.z.ai/guides/capabilities/cache) | GLM Chat | 0 | Not documented | usage.prompt_tokens_details.cached_tokens | inferred: unknown TTL |
| [Qwen / DashScope](https://www.alibabacloud.com/help/en/model-studio/context-cache) | Chat, implicit | 0 | Not documented | usage.prompt_tokens_details.cached_tokens | inferred: unknown TTL |
| Qwen / DashScope | Chat, explicit | 300 | Yes | usage.prompt_tokens_details.cached_tokens | documented |
| [Groq](https://console.groq.com/docs/prompt-caching) | Supported GPT-OSS Chat | 7200 | Inferred from idle expiry | usage.prompt_tokens_details.cached_tokens | documented TTL; inferred renewal |
| [Together](https://docs.together.ai/docs/inference/chat/prompt-caching) | Serverless / dedicated | 0 | Not documented | usage.prompt_tokens_details.cached_tokens or usage.cached_tokens | inferred: best-effort TTL |
| [Fireworks](https://docs.fireworks.ai/guides/prompt-caching) | Serverless Chat | 0 | Not documented | usage.prompt_tokens_details.cached_tokens | inferred: qualitative TTL |
| Fireworks | Dedicated | 0 | Not documented | fireworks-cached-prompt-tokens response header | inferred: qualitative TTL |
| [AWS Bedrock](https://docs.aws.amazon.com/bedrock/latest/userguide/prompt-caching.html) | Claude Converse / Stream, default | 300 | Yes | usage.cacheReadInputTokens | documented |
| AWS Bedrock | Claude Converse / Stream, requested 1h | 3600 | Yes | usage.cacheReadInputTokens | documented |
| AWS Bedrock | Claude InvokeModel, default / 1h | 300; 3600 if 1h | Yes | usage.cache_read_input_tokens | documented |
| AWS Bedrock | GPT-5.6+ / 6.1, OpenAI-compatible APIs | 1800 | Yes per cache policy | usage.input_tokens_details.cached_tokens / usage.prompt_tokens_details.cached_tokens | documented |
| AWS Bedrock | Gemini hosted API | 0 / N/A | N/A | Not established | inferred: availability unestablished |
| [Google Vertex](https://docs.cloud.google.com/vertex-ai/generative-ai/docs/partner-models/claude/prompt-caching) | Claude Messages, default / 1h | 300; 3600 if 1h | Yes | usage.cache_read_input_tokens | documented |
| Google Vertex | Gemini generateContent, implicit | 0 | Not documented | usageMetadata.cachedContentTokenCount | inferred: unknown TTL |
| Google Vertex | Gemini cachedContents, explicit | 3600 | No; update expireTime | usageMetadata.cachedContentTokenCount | documented |
| [Azure OpenAI](https://learn.microsoft.com/en-us/azure/foundry/openai/how-to/prompt-caching) | GPT-5.6+, Chat / Responses | 1800 | Not explicitly documented | usage.prompt_tokens_details.cached_tokens / usage.input_tokens_details.cached_tokens | documented TTL |
| Azure OpenAI | Earlier in_memory | 300 | Inferred from last-use policy | usage.prompt_tokens_details.cached_tokens / usage.input_tokens_details.cached_tokens | documented typical TTL |
| Azure OpenAI | Earlier 24h | 0 | Not explicitly documented | usage.prompt_tokens_details.cached_tokens / usage.input_tokens_details.cached_tokens | inferred: only ceiling published |
| [MiniMax](https://platform.minimax.io/docs/api-reference/text-prompt-caching) | Passive Chat | 0 | Not documented | usage.prompt_tokens_details.cached_tokens | inferred: load-dependent TTL |
| MiniMax | Explicit Messages | 300 | Yes | usage.cache_read_input_tokens | documented |
| [Cerebras](https://inference-docs.cerebras.ai/capabilities/prompt-caching) | Chat | 300 from write | Not documented | usage.prompt_tokens_details.cached_tokens | documented TTL |
| [Vercel AI Gateway](https://vercel.com/docs/ai-gateway/models-and-providers/provider-options) | Known Claude/MiniMax auto route | 300; 3600 only when accepted | Upstream-specific | SDK usage.inputTokenDetails.cacheReadTokens; Messages usage.cache_read_input_tokens | documented upstream; inferred routing |
| Vercel AI Gateway | Unknown / changing upstream | 0 | Upstream-specific | SDK usage.inputTokenDetails.cacheReadTokens | inferred: unknown upstream |
| [Baseten](https://docs.baseten.co/inference/model-apis/pricing-and-limits) | Model APIs Chat | 0 | Not documented | usage.prompt_tokens_details.cached_tokens | inferred: unknown TTL |
| [Cloudflare Workers AI](https://developers.cloudflare.com/workers-ai/features/prompt-caching/) | Model-specific prefix cache | 0 | Not documented | usage cached count; exact path model-specific | inferred: unknown TTL/schema |
| [Cloudflare AI Gateway](https://developers.cloudflare.com/ai-gateway/features/caching/) | Upstream KV cache | 0 | Upstream-specific | Upstream usage; cf-aig-cache-status proves only response caching | inferred: unknown upstream |
| [Xiaomi MiMo](https://mimo.mi.com/docs/en-US/price/pay-as-you-go) | Chat | 0 | Not documented | usage.prompt_tokens_details.cached_tokens (official search excerpt) | inferred: unknown TTL |
| [GitHub Copilot](https://docs.github.com/en/copilot/reference/ai-models/model-hosting) | Copilot transport | 0 | Not documented | Raw hit field not established | inferred: unknown contract |
| [OpenCode Zen](https://opencode.ai/docs/zen) | Upstream API routes | 0 | Not established | Route-specific; not validated | inferred: official search evidence only |
| [NVIDIA](https://docs.nvidia.com/nim/large-language-models/1.15.0/kv-cache-reuse.html) | Hosted integrate.api.nvidia.com | 0 | Not documented | Hosted hit field not established | inferred: NIM docs do not establish hosted contract |

