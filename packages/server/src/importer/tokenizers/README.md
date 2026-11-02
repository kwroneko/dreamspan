# Local tokenizer data

These gzip files contain unmodified, published `tokenizer.json` files. No model
weights, account text or runtime downloads are involved. `sources.json` pins the
repository revisions and SHA-256 of the **uncompressed** bytes. The API archive
also has its own SHA-256. Gzip timestamps are zero.

- Mistral 7B v0.3 and Qwen2.5/Qwen3: Apache 2.0 (`APACHE-LICENSE.txt`).
- DeepSeek V3 and V4: MIT (the adjacent license files). The API demo is published
  by DeepSeek at the address in `sources.json`; it differs from V4-Pro's added
  image/table tokens and is kept separately.
- Gemma 2: Google Gemma Terms of Use (`GEMMA-TERMS.txt`). Gemma is provided under
  and subject to the Gemma Terms of Use found at https://ai.google.dev/gemma/terms.
  The bytes come from the pinned Unsloth mirror and match Google's official
  `google/gemma-2-2b-it` revision `299a8560bedf22ed1c72a8a11e7dce4a7f9f51f8`
  LFS SHA-256, `3f289bc05132635a8bc7aca7aa21255efd5e18f3710f43e3cdb96bcd41be4922`.
  The mirror avoids requiring Hugging Face credentials at build or runtime.

The runtime is `@huggingface/tokenizers` 0.2.0, pinned in the server package.
Llama 3 uses `llama3-tokenizer-js` 1.2.0, also pinned, without BOS/EOS. OpenAI
encodings continue to use `tiktoken` 1.0.22 (the Wasm binding, avoiding the old JavaScript binding's stall on long unbroken words).

`test/support/textTokenReferences.json` contains independently computed token
IDs, using Python Hugging Face `tokenizers==0.22.1` on these exact uncompressed
files, with `encode(text, add_special_tokens=False).ids`. The fixture includes
English, Chinese, accents, currency, emoji, code, whitespace, empty input and
special-token spelling. To verify it independently after installing that Python
package:

```python
import gzip, json
from pathlib import Path
from tokenizers import Tokenizer

root = Path("packages/server")
refs = json.loads((root / "test/support/textTokenReferences.json").read_text())
for name, cases in refs.items():
    data = gzip.decompress((root / f"src/importer/tokenizers/{name}.json.gz").read_bytes())
    tokenizer = Tokenizer.from_str(data.decode())
    for case in cases:
        assert tokenizer.encode(case["text"], add_special_tokens=False).ids == case["ids"]
```

Llama's fixtures are Meta's published `llama/test_tokenizer.py` encode and dialog
examples: `This is a test sentence.` has six content tokens, and `This is a
response.` has five, after excluding BOS/EOS and chat framing.

Mappings are deliberately versioned in `providers/localTextModels.ts` and used
by the provider registry's `open-model-encodings` contribution. Unsupported
Mistral versions, Gemma 3, unknown aliases, Claude and Gemini retain the marked
`o200k_base` approximation. Google’s Gemma 2 report says it shares the historical
Gemini tokenizer, but does not establish equivalence for current Gemini models.
