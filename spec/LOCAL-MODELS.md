# Local models for the offline laptop run

**Status**: Research, 2026-10-14, for the owner to pick from; nothing downloaded. Nothing here is Decided. It answers the PLAN.md item "a short list of local models that fit 128 GB unified memory for RP, with measured or reported speeds", and the server and cache-warmth questions that go with it.


## Summary

The candidates differ mostly in how long a cold 30–60k prompt takes to prefill on this chip, and in how well they hold a character over a long scene.

| Pick | Why | Cost |
|---|---|---|
| **Gemma 4 26B-A4B** (stock, or an RP finetune) | Fastest option measured on this chip: prefill about 800–1,000 tok/s, decode 40–70 tok/s. 16–28 GB, so no memory risk. It is the community's default MoE for RP in the last month, and finetunes of it score well on CaliperBench. | Smaller and less coherent over long scenes than the big models. Most 26B finetunes are reported as dumber than stock. |
| **Qwen3.8-Flash-Next** (125B/6B active) | Best measured long-context behaviour: prefill and decode stay roughly flat from 16k to 195k. 75–82 GB. | The base model is weak at RP on CaliperBench (52) and the community reports sycophancy and "Qwen prose". Support is new (not in stock `mlx-lm`). Alibaba calls it an under-trained architecture preview. |
| **GLM-4.5-Air** (106B/12B active) | Proven, boring, 60 GB, MIT, plain attention (cache trims cleanly). CaliperBench RP 72. | 2025 model. Cold 32k prefill is about 3 minutes. |
| **DeepSeek-V4-Flash-0731, 2-bit** | Highest CaliperBench CW/RP of anything that fits (RP 74–78). Measured 28 tok/s on this exact chip. | 92 GB with 2-bit experts, so the memory budget is tight. Stock `mlx-lm` does not run it. Prefill about 220 tok/s. |
| **Step-3.7-Flash** (196B/11B active), 3-bit | Apache-2.0, CaliperBench RP 76 (but CW 54). 74 GB at IQ3_XXS. | Almost no community RP reports; speeds on this chip are from few uploads. |
| **Gemma 4 31B finetune** (dense, reference) | The community's favourite local RP model by far and the top local RP scores on CaliperBench (up to 79.6). | Dense. Measured prefill about 130–180 tok/s and decode 10–18 tok/s on this chip: a cold 32k prompt takes about 4 minutes. Only usable with a warm cache. |

If I had to choose one to download first: **Gemma 4 26B-A4B**, because it is the only one with comfortable memory and prefill times, and the RP finetunes of it are what the community actually uses. Then **Qwen3.8-Flash-Next** or **DeepSeek-V4-Flash 2-bit** for a "big model" feel. This is a recommendation from reported data only. Nobody (including me) has run an RP scene on these on an M3 Max; the owner's own 30-minute bake-off on the laptop will say more than this document (see "Before the flight").

## How reliable the numbers are

- **Speeds** are mostly from the **oMLX community benchmark database** ([omlx.ai/benchmarks](https://omlx.ai/benchmarks)): user-uploaded runs, filterable by chip, RAM and context length. I queried it for "M3 Max" (40-core, 128 GB where possible). These are real measurements, but self-reported, one run each, and many of the decode figures use the model's MTP speculative decoding on a **Python-code** prompt (the run page lists `benchmark_context: Code (Python)`, e.g. [this one](https://omlx.ai/benchmarks/performance/pn83ahgw)). Speculative decoding helps code more than prose (the mlx-serve author measures it "a few percent slower on prose" for Qwen3.8-Flash-Next), so treat the decode numbers as an upper bound. Prefill numbers are not affected by MTP.
- **Quality** is from **CaliperBench** ([caliperbench.com](https://caliperbench.com), "benchmarking LLMs on creative writing and roleplay craft, not their IQ"), a community LLM-judged benchmark that lists 677 models with creative-writing (CW), 50-turn roleplay (RP), ERP, slop and positivity scores. I extracted the scores from the page's embedded data. It is a single community project with no peer review, and its entries are noisy (the same model under two settings can differ by 20 points: Artemis-31B v1m is 73.2 RP non-thinking and 41.1 thinking). Treat differences under about 5 points as noise. The **r/SillyTavernAI "Best Models/API discussion" megathreads** of 2026-09-06 to 2026-10-11 are the community evidence ([20 Sep](https://www.reddit.com/r/SillyTavernAI/comments/1wluzky/), [27 Sep](https://www.reddit.com/r/SillyTavernAI/comments/1wrxo41/), [4 Oct](https://www.reddit.com/r/SillyTavernAI/comments/1wxsier/), [11 Oct](https://www.reddit.com/r/SillyTavernAI/comments/1x3lg2v/), [6 Sep](https://www.reddit.com/r/SillyTavernAI/comments/1w9abpf/)). Reddit blocks the fetch tool, so I read them through the public Arctic Shift archive API. Anecdotes, not measurements.
- **Aggregator sites** (willitrunai.com, llmcheck.net and similar) give modelled estimates, not measurements, and disagree with each other and with the measured data. Example: [willitrunai](https://willitrunai.com/best-local-llm-for/m3-max-128gb) ranks Qwen3.5-122B-A10B first for this laptop at 15 tok/s, but CaliperBench scores that model RP 53 / CW 50, so I dropped it. I did not use them for speeds.
- **Not found:** no llama.cpp prompt-processing figures on an M3 Max for any shortlisted model, and no roleplay reports at all for Mistral Small 4, Step-3.7-Flash or GLM-5.3-Flash on this class of hardware. Where I extrapolate, I say so.

## Memory notes (apply to every entry)

- A Mac's GPU can only wire a fraction of unified memory (about 75% by default on large-memory Macs, which I did not verify here), so models over about 90 GB need `sudo sysctl iogpu.wired_limit_mb=...` (resets at reboot). `mlx_lm.server` calls `maybe_set_recommended_wired_limit()` itself ([server.py](https://github.com/ml-explore/mlx-lm/blob/main/mlx_lm/server.py)); the 108 GB DeepSeek quant below tells users to raise the limit ([card](https://huggingface.co/thetom-ai/DeepSeek-V4-Flash-ConfigI-MLX)).
- KV cache per token, computed from the model configs: GLM-4.5-Air 46 layers x 8 KV heads x 128 dim x 2 (K,V) x 2 bytes = about 184 KB/token, so 60k tokens is about 11 GB. Gemma 4 26B-A4B, Qwen3.8-Flash-Next and DeepSeek V4 use sliding-window, linear or compressed attention, so their KV grows slowly (oMLX's Gemma 4 26B run peaks at 15.3 GB at 1k and 18.8 GB at 64k).
- Dense 120B-class RP models (Behemoth 128B v3 on Mistral Medium 3.5, Behemoth-X 123B, Monstral) are out: at 4-bit they are about 70 GB, and decode is bounded by 400 GB/s / 70 GB, so roughly 5 tok/s at best (my arithmetic, no measurement found). The 100B–200B MoE gap is itself noted by a megathread commenter: "nothing new in 50B-100B dense nor in 100B-200B MoE sizes (at least for RP)" ([27 Sep](https://www.reddit.com/r/SillyTavernAI/comments/1wrxo41/)).

## The shortlist

Speeds are **M3 Max, oMLX, 4-bit unless noted**; "PP" is prefill tok/s, "TG" is decode tok/s. 40c means the 40-core GPU (the owner's laptop); 30c is the cheaper M3 Max, roughly 25% fewer cores and 25% less bandwidth.

### 1. Gemma 4 26B-A4B (25.2B total, about 3.8B active)

- **Repos**
  - Stock MLX: [`mlx-community/gemma-4-26b-a4b-it-4bit`](https://huggingface.co/mlx-community/gemma-4-26b-a4b-it-4bit) (15.3 GB), [`-8bit`](https://huggingface.co/mlx-community/gemma-4-26b-a4b-it-8bit) (28.0 GB). Original: [`google/gemma-4-26B-A4B-it`](https://huggingface.co/google/gemma-4-26B-A4B-it).
  - RP finetunes (GGUF only, no MLX conversions found): [`zerofata/G4-MeroMero-26B-A4B-gguf`](https://huggingface.co/zerofata/G4-MeroMero-26B-A4B-gguf), `SubMaroon/Boulesis-v2.1-26B-A4B` via [`mradermacher/Boulesis-v2.1-26B-A4B-i1-GGUF`](https://huggingface.co/mradermacher/Boulesis-v2.1-26B-A4B-i1-GGUF), [`TheDrummer/Orion-26B-A4B-v1.1`](https://huggingface.co/TheDrummer/Orion-26B-A4B-v1.1), and the plain `gemma-4-26B-A4B-it-heretic` GGUF. An MLX conversion of a finetune is a one-line `mlx_lm.convert` if the owner wants MLX.
- **Memory**: 15–16 GB at 4-bit, 28 GB at 8-bit, plus a few GB of KV even at 64k. Leaves room for a second model (a speculative-decoding draft, or Qwen3.6-35B-A3B as a fast helper).
- **Speed, M3 Max 40c, 128 GB** ([oMLX rows](https://omlx.ai/benchmarks)): PP about 1,000–1,180 at 16k, 810–1,010 at 32k, 670–870 at 64k (one run 392); TG about 52–72 at 16k, 37–51 at 32k, 22–55 at 64k. On a 30c/36 GB machine, [one run](https://omlx.ai/benchmarks/d9clw7nr) shows the same shape: PP 943 at 1k to 581 at 64k, TG 50 at 1k to 12 at 64k. Decode falls off with context because Gemma's global-attention layers still read the whole cache.
- **Usable context**: config says 262,144. A commenter who tested Gemma 4 (31B, Q8 with F16 KV) says it holds up to about 80k and "breaks down rapidly" after 110k ([4 Oct](https://www.reddit.com/r/SillyTavernAI/comments/1wxsier/)). The MeroMero listing gives 32,768 as its context ([Featherless](https://featherless.ai/models/zerofata/G4-MeroMero-26B-A4B)). Realistic: 32–64k.
- **RP quality**: CaliperBench RP (non-thinking): MeroMero-26B-A4B uncensored-heretic 76.6 (CW 76.1), Boulesis-v2 72.0 / v2.1 73.4, Orion v1f 74.0, stock-heretic 66.9, StyleTune-QK merge 72.0. Slop 35–49 (lower is better). Community: Boulesis "pleasant surprise", "most finetunes of 26B are lobotomized, more variety at the cost of coherency" ([6 Sep](https://www.reddit.com/r/SillyTavernAI/comments/1w9abpf/)); MeroMero "best in writing quality and instruction following" for one user, but its author's own page says "Google cooked, there wasn't a lot to improve but there was a lot to break", and one user dropped it for stock heretic ([27 Sep](https://www.reddit.com/r/SillyTavernAI/comments/1wrxo41/)); Orion "writes so well but it is so dumb", used as a prose refiner ([27 Sep](https://www.reddit.com/r/SillyTavernAI/comments/1wrxo41/)). Another: "people moved to the Gemma 4 26B-A4Bs as they run at similar speeds to 12B models. But I haven't found Gemma 4 to be that much an improvement" (same thread). Known repetition of sentence structure.
- **License**: Apache-2.0 (HF metadata on the original and mlx-community repos).
- **Chat template**: [native system turn](https://huggingface.co/google/gemma-4-26B-A4B-it/raw/main/chat_template.jinja) (`system` or `developer` as the first message), thinking toggled with `enable_thinking`, consecutive assistant messages merge, the template does not raise on odd role sequences. Fine for ST-style prompts. Gemma 3 and earlier had no system role (a commenter, [4 Oct](https://www.reddit.com/r/SillyTavernAI/comments/1wxsier/)); Gemma 4 does.

### 2. Qwen3.8-Flash-Next ("QFN": 125B, 6B active, plus a 51B n-gram embedding table)

- **Repos** (pick by server):
  - mlx-serve: [`ddalcu/Qwen3.8-Flash-Next-MLX-Serve-iQ-MLX-4.7bpw`](https://huggingface.co/ddalcu/Qwen3.8-Flash-Next-MLX-Serve-iQ-MLX-4.7bpw): 75 GB resident, 107 GB download. The n-gram table is memory-mapped, not resident. Its [`-iQ-MLX-3.3bpw`](https://huggingface.co/ddalcu/Qwen3.8-Flash-Next-MLX-Serve-iQ-MLX-3.3bpw) is 52 GB resident.
  - oMLX: [`Jundot/Qwen3.8-Flash-Next-oQ4e-mtp`](https://huggingface.co/Jundot/Qwen3.8-Flash-Next-oQ4e-mtp): 106 GB on disk (72 GB backbone + 32 GB n-gram table). Whether the table is resident under oMLX is not stated on the card; a pruned variant's card says oMLX can stream it ([sh0wie](https://huggingface.co/sh0wie/Qwen3.8-Flash-Next-REAP-288-MLX-4bit), 68 GB, REAP-pruned so a quality risk). Check peak memory before relying on it.
  - llama.cpp: [`unsloth/Qwen3.8-Flash-Next-GGUF`](https://huggingface.co/unsloth/Qwen3.8-Flash-Next-GGUF) `UD-IQ3_XXS` (82 GB), `UD-Q3_K_XL` (90 GB), `UD-Q2_K_XL` (79 GB). `qwen4exp` is in llama.cpp mainline's [arch list](https://github.com/ggml-org/llama.cpp/blob/master/src/llama-arch.cpp).
  - Avoid: `mlx-community/Qwen3.8-Flash-Next-4bit` (111 GB; stock `mlx-lm` style packs load the n-gram table onto the GPU, which is [why](https://huggingface.co/ddalcu/Qwen3.8-Flash-Next-MLX-Serve-iQ-MLX-4.7bpw) it is 107+ GB).
- **Memory**: 75–82 GB, plus little KV (hybrid Gated-DeltaNet/sparse attention: "attention cost stays flat with context", per the pack's card).
- **Speed, M3 Max 40c, 128 GB** (oMLX, `oQ4e-mtp`, MTP on, code prompt): PP about 430–650 at 16k, 430–630 at 32k, 300–550 at 64k (noisy); TG about 12–50 at 16k, 31–44 at 32k, 25–37 at 64k. On a 30c/96 GB machine at 3-bit: PP 453–489 at 64k, 435 at 195k; TG 31–37 at 64k, 26 at 195k. Reference from the same family on faster chips: the mlx-serve author measures an M4 Max 128 GB at decode about 60 tok/s (78 with MTP) and prefill about 730 tok/s ([card](https://huggingface.co/ddalcu/Qwen3.8-Flash-Next-MLX-Serve-mixed-4-8bit)), which scales to roughly 450–550 on the M3 Max, consistent with the oMLX rows.
- **Usable context**: 262,144 native, 1M with YaRN. The oMLX rows show no slowdown up to 195k, which is the real strength.
- **RP quality**: weak and inconsistent. CaliperBench RP: base (non-thinking, MTP) **52.0**, CW 55.4; the "uncensored" non-thinking variant 50.6; the same uncensored model **with thinking** 77.7 (CW 81.6, slop 18.6, among the lowest slop scores in the table); heretic-2 thinking 68.8, non-thinking 59.5; Swift-1.5 thinking 68.3, non-thinking 62.7. So CaliperBench says QFN is good only with reasoning on, which costs seconds per turn at 30–40 tok/s. Community: "a bit difficult to get it to not be so acceptive of the user's whims, even when they contradict the card" (an IQ3 user, [27 Sep](https://www.reddit.com/r/SillyTavernAI/comments/1wrxo41/)); "not as bad as 27b" at Qwen prose tics, but a worry about tracking who said what (4 Oct). The wider Qwen3.8 family splits opinion: one user calls the **27B** "the strongest local model I've tried", another "pure slop" prose ([4 Oct](https://www.reddit.com/r/SillyTavernAI/comments/1wxsier/)). The Qwen team described it as an experimental preview of the Qwen4 architecture; a review reports the team said it is intentionally under-trained ([eesel](https://www.eesel.ai/blog/qwen38-flash-next-review)).
- **License**: [Qwen Community License 1.0](https://huggingface.co/Qwen/Qwen3.8-Flash-Next/raw/main/LICENSE): MIT-like, with extra terms only for products over 100M MAU / $20M monthly revenue and for Model-as-a-Service businesses. Fine for personal use.
- **Chat template**: system message supported **but it raises `System message must be at the beginning.`** for any system message that is not first ([template line 106](https://huggingface.co/Qwen/Qwen3.8-Flash-Next/raw/main/chat_template.jinja)), and `No user query found in messages` if there is no user message. ST-style presets with depth-injected system messages (author's note, lorebook entries inserted mid-chat) will return an error unless the harness folds later system messages into the first one or sends them as `user`. This applies to the Qwen family generally.
- **Server support**: not in stock `mlx-lm` main (no `qwen4_exp` among its [model files](https://github.com/ml-explore/mlx-lm/tree/main/mlx_lm/models)). Supported by `mlx-vlm` (`qwen4_exp`), oMLX, mlx-serve and llama.cpp. Whether the LM Studio build the owner has installed loads it, I could not verify.

### 3. GLM-4.5-Air (106B total, 12B active)

- **Repos**: [`mlx-community/GLM-4.5-Air-4bit`](https://huggingface.co/mlx-community/GLM-4.5-Air-4bit) (60.1 GB; the 6-bit is 86.8 GB). GGUF IQ4_XS (about 60 GB) is what a commenter runs. RP finetune: [`TheDrummer/GLM-Steam-106B-A12B-v1`](https://huggingface.co/TheDrummer/GLM-Steam-106B-A12B-v1) (GGUF). Avoid REAP-pruned versions: "REAP is a code focus hack, every REAP model is bad at creative writing" and one IQ3 REAP user was "incredibly disappointed" ([4 Oct](https://www.reddit.com/r/SillyTavernAI/comments/1wxsier/)).
- **Memory**: 60 GB + KV about 184 KB/token (11 GB at 60k).
- **Speed, M3 Max 40c, 128 GB** (oMLX, 4-bit): PP 245–334 at 1–4k; the 6-bit Derestricted gets PP 316 at 4k and 216 at 16k, TG 20 and 14. TG 25–35 at 1–4k. No 32k+ rows exist, so my 32k/60k prefill times are extrapolated.
- **Usable context**: 131,072 (config). Prefill slows as context grows, so in practice 32–64k with a warm cache.
- **RP quality**: CaliperBench RP 72.4, CW 66.2, slop 35.5 (non-thinking); thinking 69.2 / 74.5. GLM-Steam 72.0. One commenter on GLM-4.5-Air-IQ4_XS: "around Gemma 4 26-31b level, but with better knowledge. Is it better than Gemma 4 31B? Nope, better than Gemma 4 26B, but that is it" ([4 Oct](https://www.reddit.com/r/SillyTavernAI/comments/1wxsier/)). The newer GLM-5.3 is the one the cloud-using community likes; the Air line was not updated.
- **License**: MIT.
- **Chat template**: `<|system|>` handled at any position, no raise ([template](https://huggingface.co/zai-org/GLM-4.5-Air/raw/main/chat_template.jinja)). Hybrid thinking, controllable per request.
- **Server support**: everything (stock `mlx-lm` has `glm4_moe`; llama.cpp has `glm4moe`).

### 4. DeepSeek-V4-Flash-0731 at 2-bit (284B/304B total, 13B active)

- **Repos**: [`mlx-community/DeepSeek-V4-Flash-0731-OptiQ-2bit`](https://huggingface.co/mlx-community/DeepSeek-V4-Flash-0731-OptiQ-2bit): 92.5 GB, MIT. Needs `mlx-optiq` or oMLX (stock `mlx-lm` main has `deepseek_v41` but no `deepseek_v4`; the card says "not an architecture stock mlx-lm knows"). GGUF: [`unsloth/DeepSeek-V4-Flash-0731-GGUF`](https://huggingface.co/unsloth/DeepSeek-V4-Flash-0731-GGUF) `UD-IQ2_XXS` (about 91 GB), `UD-IQ1_M` (about 87 GB); llama.cpp mainline has `deepseek4`. A dedicated engine, [antirez/ds4 "DwarfStar"](https://github.com/antirez/ds4), also targets 96–128 GB Macs and has its own OpenAI-compatible server and disk KV cache; I did not evaluate it.
- **Memory**: 92.5 GB weights. Does not meet the 100 GB budget with comfort; DeepSeek's compressed attention keeps KV small, but there are only about 7 GB of margin below 100. The card's headline "6.5 GB resident, 2.5 tok/s" describes SSD expert streaming, which is the wrong mode here.
- **Speed, M3 Max 40c, 128 GB** (oMLX, 2–2.4-bit, uploaded 2026-10-11 and earlier): PP 258–275 at 1–4k, about 210–240 at 16–32k; TG 28–29 at 1–4k, 19–23 at 16–32k.
- **Usable context**: 1,048,576 native. Memory, not the model, is the limit; 32–64k is realistic.
- **RP quality**: the strongest local-fitting model on CaliperBench: base non-thinking RP 74.0 / CW 76.4 (0731), thinking 75.3 / 65.9, earlier snapshot 78.3 / 71.0, heretic 75.8 / 77.5. Slop 34–37, positivity close to 1. Community praise is mostly for the hosted DeepSeek V4/V4.1 Flash through APIs ("pretty good", [27 Sep](https://www.reddit.com/r/SillyTavernAI/comments/1wrxo41/)); one user said a finetune "did not remove the sort of robotic nature of Deepseek Flash" ([20 Sep](https://www.reddit.com/r/SillyTavernAI/comments/1wluzky/)). CaliperBench's runs are presumably full precision from an API, so 2-bit quality loss is unmeasured here. The OptiQ card itself calls 2-bit routed experts "an extreme quant" that is "lossy".
- **License**: MIT.
- **Chat template**: the official repo ships no Jinja template, only a Python encoder (`encoding/encoding_dsv4.py`). The mlx-community conversion includes a `chat_template.jinja` with a system branch; I did not test mid-conversation system messages, nor how closely it matches the Python encoder.
- **Not DeepSeek V4.1 Flash**: the newer V4.1 (2026-09-10; 552B backbone) needs SSD streaming on a 128 GB Mac (its GGUF card: "Use SSD streaming on a single 128 GB Mac"), so it is out.

### 5. Step-3.7-Flash (198B total, about 11B active)

- **Repos**: [`unsloth/Step-3.7-Flash-GGUF`](https://huggingface.co/unsloth/Step-3.7-Flash-GGUF) `UD-IQ3_XXS` (about 74 GB), `UD-Q3_K_XL` (about 89 GB), `UD-IQ2_M` (about 62 GB). oMLX has `Step-3.7-Flash-oQ3e` rows on this chip.
- **Speed, M3 Max 40c, 128 GB** (oMLX): PP 125–330 at 1–8k, TG 19–39 (4-bit Step-3.7-Flash: PP 319–334, TG 37–39 at 4–8k). No long-context rows found.
- **Context**: 262,144 native, sliding window 512 on most layers.
- **RP quality**: CaliperBench RP **76.4** but CW **54.2** (ERP 48.5, slop 25.1, low); the ARA-heretic variant RP 76.4 / CW 72.8. The only community mention found is a cloud user who "enjoys Step 5" (a different model). Little else.
- **License**: Apache-2.0. **Template**: system messages supported anywhere (template has `message.role == "system" and not loop.first` branches).

### 6. Gemma 4 31B finetunes (dense; the quality reference, not a speed pick)

- **Repos**: stock MLX [`mlx-community/gemma-4-31b-it-4bit`](https://huggingface.co/mlx-community/gemma-4-31b-it-4bit) (18.4 GB) / `-8bit` (33.8 GB). Finetunes are GGUF: [`bartowski/sophosympatheia_Glistening-Gem-31B-v2.1-GGUF`](https://huggingface.co/bartowski/sophosympatheia_Glistening-Gem-31B-v2.1-GGUF), [`bartowski/TheDrummer_Artemis-31B-v1.2-GGUF`](https://huggingface.co/bartowski/TheDrummer_Artemis-31B-v1.2-GGUF), zerofata's G4-MeroMero-31B, Dark-Thoughts V2.
- **Speed, M3 Max 40c, 128 GB** (oMLX, 4-bit): PP 176–186 at 1–4k, 144 at 16k, 128 at 32k; TG 17.9–18.8 at 1–4k, 14.6 at 16k, 10.4 at 32k ([rows](https://omlx.ai/benchmarks)). The MTP build got TG 17–19 at 16–32k.
- **RP quality**: the best local RP scores on CaliperBench: Glistening-Gem v2.0 RP 79.6, v2.1 78.6; Dark-Thoughts V2 77.5; MoonGem 77.1; Artemis v1q 73.4; stock 58.9 (non-thinking). The megathreads are dominated by this family (Glistening-Gem 2.1, Skyfall, Artemis, Schattenblume), with complaints of "character bleed" and structure repetition on some, and "KV cache is massive" for long contexts.
- **Why still listed**: the owner asked for MoE-first, so this is the yardstick for what the MoE options give up. A warm cache hides most of the dense model's prefill cost (only the last turn is prefilled, a few seconds), and decode at 14–18 tok/s is readable, so it is usable if the cache stays warm and unusable if it does not.
- **License**: Apache-2.0 (base).

## Cold prefill time for long RP prompts

Computed from the measured PP above (cold cache, whole prompt). The 16k and 32k rows are measured or interpolated; the 60k column for the three dense-ish/older ones and Step-3.7 is extrapolated from lower-context rows.

| Model | 16k | 32k | 60k |
|---|---|---|---|
| Gemma 4 26B-A4B, 4-bit | about 15–20 s | about 35–40 s | about 80–95 s |
| Qwen3.8-Flash-Next, 4-bit | about 25–35 s | about 55–75 s | about 2 min |
| GLM-4.5-Air, 4-bit | about 75 s | about 3 min | about 6–7 min (extrapolated) |
| DeepSeek-V4-Flash 2-bit | about 75 s | about 2.5 min | about 5 min (extrapolated) |
| Step-3.7-Flash 3-bit | about 1 min | about 2.5 min | about 5 min (extrapolated) |
| Gemma 4 31B dense, 4-bit | about 2 min | about 4 min | about 9 min |

Consequence for the harness: on anything but the Gemma 26B and QFN rows, a lost cache is minutes, not seconds. A one-turn-warm cache brings every row below 10 seconds of prefill for a normal turn (the new user message plus the previous reply, 300–1,500 tokens).

## Server: MLX or llama.cpp Metal

There is no clean winner on this chip; the published comparisons conflict and none is on an M3 Max:

- [stared's benchmark](https://github.com/stared/benching-local-llms-on-apple-silicon) (M5 Max 128 GB, Qwen3.6): llama.cpp 10–24% faster decode than MLX, and llama.cpp now has MTP speculative decoding (`--spec-type draft-mtp`). The M5's neural accelerators are not on the M3, so this may not carry over.
- [Rapid-MLX's benchmark](https://rapidmlx.com/blog/mlx-vs-llama-cpp-benchmark) (M2 Pro 32 GB, vendor of an MLX server, disclosed): MLX decodes MoE faster (Qwen3.6-35B-A3B 61.7 vs 39.1 tok/s), llama.cpp prefills faster on short prompts (460 vs 277), and cold TTFT on a 1k prompt favours llama-server. No long-context data.
- **The deciding factor is model support and cache behaviour, not raw speed**: two of the six shortlisted models (Qwen3.8-Flash-Next and DeepSeek-V4-Flash) are not in stock `mlx-lm`. The measured M3 Max numbers above all come from oMLX, not stock `mlx_lm.server`. The RP finetunes the community uses are GGUF-only.

My recommendation, as a proposal:

1. **llama.cpp's `llama-server` as the primary server**: every shortlisted architecture is in mainline (`gemma4`, `qwen4exp`, `deepseek4`, `glm4moe`, `mistral4`, `qwen35moe`), it runs the GGUF finetunes directly, has the most explicit cache controls (below), and per-request `chat_template_kwargs` (`{"enable_thinking": false}`) and `--reasoning-budget`. It is what the harness's OpenAI-compatible provider needs, with no extra app.
2. **oMLX as the MLX alternative** when the model's best build is MLX (QFN, DeepSeek): it serves an OpenAI-compatible API, uses `mlx-lm`'s batch generator, and has a paged, prefix-sharing KV cache with an **SSD cold tier that survives restarts** ([README](https://github.com/jundot/omlx)). Its v0.7.1.dev was published 2026-10-09; it is a young project and the benchmark numbers above come from its own users.
3. **LM Studio** if the owner prefers a GUI: its MLX engine (v1.8.5, June 2026) saves KV checkpoints to disk every 256 tokens and restores the longest matching prefix, "cleared on model unload" ([blog](https://lmstudio.ai/blog/mlx-engine-agentic-workloads), benchmarked on a Qwen3.6 27B 4-bit on an M3 Max). Its llama.cpp runtime did not expose `--ctx-checkpoints`, `--swa-full` or `--slot-prompt-similarity` as of an April feature request ([lmstudio-bug-tracker #1818](https://github.com/lmstudio-ai/lmstudio-bug-tracker/issues/1818)), which is the sort of setting the SWA/hybrid models below need. I could not find which of these LM Studio builds load Qwen3.8-Flash-Next or DeepSeek-V4.
4. **Stock `mlx_lm.server`** is fine for GLM-4.5-Air and Gemma 4 (both supported: `glm4_moe`, `gemma4`), not for QFN or DeepSeek V4.

## Prompt caching, per server

| Server | What it caches | Limits |
|---|---|---|
| `llama-server` | Prefix match against the slot's last prompt (`cache_prompt`, on by default). A second tier in host RAM (`--cache-ram`, default 8,192 MiB) holds other prompts, so swapping between chats or branches does not lose them. `--cache-idle-slots` saves an idle slot into it. `--cache-reuse N` shifts matching chunks after an edit (not usable on recurrent/SWA state). `--slot-save-path` plus `POST /slots/{id}?action=save|restore` persists a slot to disk by hand. Hybrid/SWA models (Gemma 4, QFN) use context checkpoints: `-ctxcp` (default 32) and `-cms` min spacing (default 8,192 tokens). ([server README](https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md)) | Checkpoints spaced 8k apart mean an edit or a regenerate can fall back by up to 8k tokens on SWA/hybrid models; lowering `-cms` trades RAM for finer restore points. "Forcing full prompt re-processing" is logged at verbosity 4. No automatic disk persistence (`--cache-disk` was still a request in July, per [a third-party write-up](https://particula.tech/blog/prompt-reprocessing-swa-hybrid-models-kv-cache)). |
| `mlx_lm.server` | A trie-based in-memory LRU of KV caches keyed by token prefix, stored at assistant/user/system boundaries; a longer cached prompt is trimmed back to the common prefix when the cache type allows it ([cache.py](https://github.com/ml-explore/mlx-lm/blob/main/mlx_lm/models/cache.py)). `--prompt-cache-size` (default 10 entries) and `--prompt-cache-bytes` cap it. Reports `cached_tokens` in `usage`. | Lost on restart (a persistence PR, #1405, is closed; I did not confirm whether it merged). `--kv-bits` turns batching off. Hybrid/SWA caches are not arbitrarily trimmable, which is the same problem LM Studio's checkpoints address. |
| LM Studio (MLX) | Disk KV checkpoints every 256 tokens, longest-prefix restore (mlx-engine 1.8.5). Exact prefixes only; edited or evicted parts are recomputed. | LRU-evicted, cleared on model unload. |
| oMLX | Paged, prefix-sharing, copy-on-write blocks in a hot RAM tier plus an SSD cold tier (`--paged-ssd-cache-dir`, `--hot-cache-max-size`); survives restarts; handles hybrid (GDN) sidecars. | Self-reported "TTFT 30–90 s down to 1–3 s on hits". |

## Keeping the cache warm between turns

Server-side:

1. **Never let the server unload or sleep.** LM Studio: JIT-loaded models unload after a default 60-minute idle TTL and auto-evict other JIT models; load with `lms load <model> --ttl 0`-style (models loaded with `lms` have no TTL by default) and turn auto-evict off ([TTL docs](https://lmstudio.ai/docs/developer/core/ttl-and-auto-evict)). llama-server's `--sleep-idle-seconds` is off by default; leave it off. Run the machine on power if the flight allows it, with `caffeinate -i` so the Mac does not sleep mid-session (general macOS practice, not from these sources).
2. **One slot, big RAM tier** for a single reader: `--parallel 1` (or 2 if swipes should not evict the main line), `--cache-ram 16384` or more, and the model's context set to what the owner actually uses (a 60k chat does not need 262k allocated). Keep `cache_prompt` on and, for the harness, send the same `id_slot` for a chat.
3. **For SWA and hybrid models** (Gemma 4, QFN) raise `-ctxcp` and consider `-cms 2048` so a regenerate or edited last message restores close to the edit point; check with verbosity 4 that "forcing full prompt re-processing" does not appear after turn 2.
4. **Persist across a laptop sleep or restart**: oMLX's SSD tier does it automatically; with llama-server, save the slot to `--slot-save-path` before closing the lid and restore on start.
5. **Reasoning models**: previous turns' reasoning is dropped by the chat template, so only the last assistant turn changes between requests. That costs one reply of re-prefill per turn, not the whole chat. Thinking also costs decode time at 20–50 tok/s, so for RP turn it off or cap it (`enable_thinking: false`, `--reasoning-budget`); CaliperBench shows non-thinking scores close to thinking ones for Gemma and DeepSeek, but not for QFN.

Prompt-side (what the harness controls):

- Keep the system prompt, card, persona, and static lorebook entries **byte-identical** across turns, and put everything that changes per turn (author's note, dynamically activated entries, the one-turn direction) at the tail. An edit at token N invalidates everything after N.
- Summaries or lorebook activations that change mid-prompt will force a full re-prefill at local prefill speeds. Avoid regenerating them on every turn; refresh at fixed points and accept the cold prefill then (a warning in the cache indicator is already in the design).
- **Do not send mid-conversation system messages to Qwen-family templates** (they raise); fold them into the first system message or send them as `user`. Gemma 4, GLM-4.5-Air and Step-3.7 accept them.
- A server restart, a model swap, or changing `--ctx-size` can flush the cache; the harness's cache indicator should treat local servers as `unknown` after any reload, and show the `cached_tokens` / `timings` the server reports (`mlx_lm.server` and llama-server both return it).

## Considered and left out

| Model | Why not |
|---|---|
| Qwen3.5-122B-A10B (4-bit, 69.6 GB) | Aggregators rank it first for this laptop, but CaliperBench RP 53.4 / CW 49.7 (base), and measured on this chip it prefills only 380 tok/s at 1k and 80–230 at 8–32k, decodes 15–31 tok/s. [ArliAI's RpRMax](https://huggingface.co/ArliAI/Qwen3.5-122B-RpRMax-v1) finetune exists but I found no reports. |
| gpt-oss-120b | Fast (PP about 600–660, TG 49–64 on this chip) but CaliperBench RP 29.2 and slop 57. A megathread user got it to work only "fighting hard with system prompt tweaking" and at high reasoning, 2–3 minutes per reply ([11 Oct](https://www.reddit.com/r/SillyTavernAI/comments/1x3lg2v/)). |
| GLM-5.3-Flash (320B/18B) | CaliperBench RP 74.4 / CW 82.6 is excellent, but the 4-bit MLX is 204 GB and the smallest GGUFs (IQ1/IQ2, 87–100 GB) are not usable. One PC user at Q3 found it "very slow to role play with" ([27 Sep](https://www.reddit.com/r/SillyTavernAI/comments/1wrxo41/)). |
| DeepSeek V4.1 Flash (552B) | Needs SSD streaming on 128 GB. |
| MiniMax M3 (427B), Hy3 (295B), MiMo-V2.x (309B) | Too big. |
| Mistral Small 4 (119B/6B active) | In `mlx-lm` (`mistral4`) and llama.cpp, Apache-2.0, 256k context, but I found no RP reports and CaliperBench has no entry. Could be worth a look; no evidence either way. |
| Nemotron-3-Super-120B-A12B, Laguna, Solar-Open2 | CaliperBench RP 54, 51–73 with CW 28–58, no community use. |
| Behemoth 128B / 123B, Monstral, Anubis 70B | Dense; about 5 tok/s decode. Anubis-70B is liked by one megathread user but is a 2025 base. |
| Qwen3.6-35B-A3B | Not an RP model, but the fastest thing on the list (PP 960–1,530, TG 60–147 with MTP at 1–8k on the M3 Max, 30c/40c) and the obvious "fast helper" for summaries or draft work. Qwen3.5-35B-A3B scored RP 62.6. |

## Before the flight (offline)

- Download **every** component while online: the server app and its runtimes (LM Studio runtime packs, or llama.cpp and `uv`/pip wheels for oMLX and mlx), the models, and the tokenizer/template files. The harness itself needs no network when the model is local (PLAN §2).
- Disk: Gemma 26B 16–28 GB; QFN 107 GB download; GLM-4.5-Air 60 GB; DeepSeek 2-bit 92 GB. Choose two or three, not all.
- The bake-off I would run in 30 minutes: load each candidate, send the same 30k-token synthetic RP prompt (no real chat data on the laptop), record cold TTFT, then three follow-up turns (warm TTFT, tok/s), then regenerate once. `mlx_lm.benchmark`, `llama-bench` and oMLX's admin "one-click benchmark" (prefill, generation, partial-prefix-hit) do the speed part. Judge prose by playing one scene per model.
- Settings worth carrying over from the megathreads: for Gemma 4, `min_p` 0.05–0.1 (several commenters); for Qwen, `min_p` 0.1, `top_p` 0.95, `temperature` 0.9 plus a prompt that tells it how to reason ([4 Oct](https://www.reddit.com/r/SillyTavernAI/comments/1wxsier/)).

## Open questions for the owner

1. Is a 2-bit DeepSeek (92 GB, tight memory) worth trying, or should the big-model slot go to QFN?
2. Does the owner want the harness to rewrite mid-chat system messages for Qwen-style templates (a provider-level option), or only use models whose templates accept them?
3. oMLX (young, MLX, SSD cache) versus `llama-server` (mature, GGUF, manual slot saves): the owner's preference decides which runbook goes in the README.

## Sources

Models and quant repos are linked inline above. The main sources:

- Speeds: [oMLX community benchmarks](https://omlx.ai/benchmarks) (filtered to M3 Max; example rows [d9clw7nr](https://omlx.ai/benchmarks/d9clw7nr), [pn83ahgw](https://omlx.ai/benchmarks/performance/pn83ahgw)); [ddalcu's mlx-serve cards](https://huggingface.co/ddalcu/Qwen3.8-Flash-Next-MLX-Serve-iQ-MLX-4.7bpw); [mlx-optiq card](https://huggingface.co/mlx-community/DeepSeek-V4-Flash-0731-OptiQ-2bit); [stared/benching-local-llms-on-apple-silicon](https://github.com/stared/benching-local-llms-on-apple-silicon); [Rapid-MLX comparison](https://rapidmlx.com/blog/mlx-vs-llama-cpp-benchmark).
- Quality: [CaliperBench](https://caliperbench.com) (and its [methodology](https://caliperbench.com/methodology.html)); the r/SillyTavernAI megathreads linked above (read via the Arctic Shift archive).
- Model facts: Hugging Face cards and configs for [Qwen3.8-Flash-Next](https://huggingface.co/Qwen/Qwen3.8-Flash-Next), [GLM-4.5-Air](https://huggingface.co/zai-org/GLM-4.5-Air), [GLM-5.3-Flash](https://huggingface.co/zai-org/GLM-5.3-Flash), [DeepSeek-V4-Flash-0731](https://huggingface.co/deepseek-ai/DeepSeek-V4-Flash-0731), [DeepSeek-V4.1-Flash](https://huggingface.co/deepseek-ai/DeepSeek-V4.1-Flash), [Step-3.7-Flash](https://huggingface.co/stepfun-ai/Step-3.7-Flash), [Gemma 4 26B-A4B](https://huggingface.co/google/gemma-4-26B-A4B-it).
- Servers: [mlx-lm server.py](https://github.com/ml-explore/mlx-lm/blob/main/mlx_lm/server.py) and [cache.py](https://github.com/ml-explore/mlx-lm/blob/main/mlx_lm/models/cache.py); [llama.cpp server README](https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md) and [arch list](https://github.com/ggml-org/llama.cpp/blob/master/src/llama-arch.cpp); [mlx-vlm models](https://github.com/Blaizzy/mlx-vlm/tree/main/mlx_vlm/models); [oMLX README](https://github.com/jundot/omlx); [LM Studio mlx-engine 1.8.5 post](https://lmstudio.ai/blog/mlx-engine-agentic-workloads); [LM Studio TTL docs](https://lmstudio.ai/docs/developer/core/ttl-and-auto-evict); [DwarfStar/ds4](https://github.com/antirez/ds4).
- Unreliable, used only to find leads: [willitrunai](https://willitrunai.com/best-local-llm-for/m3-max-128gb), [llmcheck.net](https://llmcheck.net/blog/qwen3-8-flash-next-on-mac/), [pinggy](https://pinggy.io/blog/top_5_local_llm_tools_and_models/).
