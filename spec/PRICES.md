# Model prices: known prices, price endpoints, and past costs

**Status**: Built; obsolete as an implementation proposal (2026-11-19). Proposal of 2026-11-16 (pricespec). Built in stages (prices1, 2026-11-16; ARCHITECTURE §6 "Known prices and their order"): §3.2 table and coverage test, §3.3 `Price` fields, §5.1 order, §6 formula ids, and §4's client on Refresh models (parser, opt-in, storage). Built since (mediaprices, 2026-11-19): §4.5 probe state, §4.6 timer and `ETag`, §4.4 route pricing, §5.2 route bounds for endpoints, §6.1 recompute, §7 UI (with b9b77ad8e's switch and source line) and PR6 (`docs/price-endpoint.md`, `docs/price-endpoint.schema.json`). Reasoning rate (prices2, 2026-11-19): the client reads `reasoning`, stores it, prices the reasoning part of output at it and shows it in cost details. Nothing in this spec is unbuilt: every section is obsolete as an implementation proposal (ARCHITECTURE §6). A delta from the pricing code as built (ARCHITECTURE §3.12, §6; spec/PROVIDERS.md §9.3). Each item is marked **[D]** (owner decision, recorded in DESIGN §9), **[P]** (proposed) or **[O]** (open).

## 1. What exists today

- **Price data** is the `Price` shape (`@dreamspan/shared/providers.ts`): per million tokens, `input`, `output`, optional `cacheRead`, `cacheWrite`, and `tiers` by total input (`inputTokensAbove`). It lives in `models.upstream_json.price`, rewritten by every refresh.
- **Where a model's price comes from** (`modelLists.ts`, `catalog.ts`):
  - the model list where it reports prices (OpenRouter's `GET /models` `pricing`, USD per token as decimal strings, scaled to per million);
  - otherwise pi-ai's catalog (`withCatalog` fills `price` only when the list gave none);
  - for an OpenRouter model whose routing pins one provider, that provider's endpoint price from `GET /models/{author}/{slug}/endpoints` (`upstream.endpoints`, discount applied, prompt-length overrides as tiers; 24 h TTL, 10 min retry after a failure). `routedPrice` picks it, falling back to the list price.
- **Cost formulas** (`usage.ts`, `userCosts.ts`), tried newest registration first: `user-pricing` (Settings → Costs rules, `CostRule` in `@dreamspan/shared/costFormulas.ts`, five rates incl. `writeLong`, tiers, currency label), then `reported` (OpenRouter's `usage.cost`), then `builtin` (`priceCost` over the resolved `Price`; long cache writes at 2× input; always USD).
- **The ledger** (`llm_requests`) stores `cost`, `cost_currency` and `cost_formula` (`builtin`, `reported`, or `user:<rule>:<revision>`). A trigger lets only the cost change on a closed row. Recomputing past rows is specified (PROVIDERS §9.3 "Recomputing") but not built.
- **Gaps this spec closes:** no per-TTL write price outside user rules (`builtin` hardcodes 2×); no per-call price; `builtin` can't say which source (catalog, list, endpoint list) its rates came from; no way for a connection's own server to publish prices; no rule for what a price correction may rewrite.

## 2. Owner decisions (2026-11-16) [D]

1. **The app knows the prices of the main models on the providers we support.** Users override only in specific cases; Settings → Costs stays the override place.
2. **A past request keeps the price it was charged at.** Prices of open models on aggregators change by provider and over time. Correcting a wrong built-in or override price may replace estimates on past rows priced from the table or from overrides, never provider-reported charges. (A separate schema job adds a per-request snapshot of the rates used.)
3. **We keep known prices current ourselves:** built-in tables updated with releases, and providers' public price data queried where an API exists (OpenRouter's model-list pricing and per-endpoint pricing).
4. **A generic price endpoint extension.** A connection can opt in, per connection, to fetch prices from its base URL. Nothing is sent without that opt-in. Fetched prices win over our known prices for that connection, which allows dynamic price adjustment. Main users: people running a gateway that serves models to downstream users. Nobody has standardized this, so we define it here and publish it (§4).
5. **Which models need a built-in price.** Owner: "For the major closed source labs, we need prices for *every model that is still available for inference* at the very minimum."
6. **Precedence.** Owner: "Different connections can have totally different prices." A price the user sets on a specific connection beats that connection's fetched prices. An account-wide or per-connection-type price never overrides a connection's own fetched prices. Fetched prices are per connection.

## 3. Known prices

### 3.1 Sources and their order [P]

For one request, the rate table (`Price`) used by the non-user formulas is resolved from the first source that has the model, per connection:

| # | Source | Formula id recorded | Notes |
|---|---|---|---|
| 1 | The connection's price endpoint (§4), when opted in and it lists the model with a known price | `endpoint` | New |
| 2 | OpenRouter's per-endpoint price, when routing pins one provider | `builtin` → split as `list:endpoints` | Exists (`routedPrice`) |
| 3 | The provider's model list price (OpenRouter `GET /models`) | `list` | Exists inside `builtin` today |
| 4 | The built-in table: pi-ai's catalog plus our own supplement (§3.2) | `builtin` | Exists |

Over these, unchanged: `user-pricing` rules first (decision 1: the override place), and `reported` cost before any table (§5.1).

- **[P]** Split today's single `builtin` formula id into source-named ids (`endpoint`, `list`, `builtin`) so the ledger says where the rates came from, without a new column (§6).
- **[P]** `withCatalog` keeps its rule (the list's own price wins over the catalog's). An endpoint price (source 1) is stored separately (§4.7), never merged into `upstream.price`, so turning the opt-in off restores sources 2 to 4 without a refresh.

### 3.2 The built-in table [P]

- **pi-ai's catalog stays the base.** It updates with each pi-ai release (dependencies are pinned, so with our releases).
- **Our own supplement**, `packages/server/src/providers/prices/*.ts`: data, one file per provider, for what pi-ai lacks or gets wrong (a model it hasn't added yet, a cache-write TTL rate, Vertex's 1 h rate, Bedrock's per-region differences). Each entry names its source URL and the date it was checked. A supplement entry replaces pi-ai's entry for that (provider, model) whole, never field by field, so a half-corrected price can't happen.
- **"Main models" coverage test:** a list of (provider, model) pairs that must have a price (every still-available Claude, GPT and Gemini model, and DeepSeek's, on their first-party and cloud providers). `npm run check` fails when a pi-ai upgrade drops one. Main means every model of the major closed-source labs still available for inference (decision 5), not only the current generation.
- **No price fetch at runtime from anything but the connection's own provider.** We don't fetch a price list from a server of ours: that would send a request nobody opted into (DESIGN §9 provider-send rule) and make the app depend on us.

### 3.3 The `Price` shape grows [P]

To carry what the endpoint format (§4) and the supplement can express, `Price` (JSON in `upstream_json`, so no column) gains optional fields, all per million tokens unless said:

- `cacheWriteLong`: the long-TTL write rate (Anthropic's 1 h). Absent: 2× `input`, today's rule.
- `perRequest`: a flat price per request, in the same currency (search add-ons, gateways that charge per call).
- `currency`: a label, default `USD`. As today, nothing converts.
- tiers gain `cacheWriteLong` too.

`priceCost` and `builtin`'s `upperBound` use them. The `CostRule` (user override) already has `writeLong`; it gains an optional `perRequest`.

## 4. The price endpoint extension (published format)

This section is the published specification. It's written so a server author can implement it without reading the rest of the app. **[P]** throughout unless marked.

### 4.1 Endpoint

```
GET {base}/v1/prices
```

- `{base}` is the connection's base URL with any trailing `/v1` removed, so `https://gw.example/v1` and `https://gw.example` both probe `https://gw.example/v1/prices`. The path is the same on an OpenAI-wire and an Anthropic-wire base.
- **Auth:** exactly the headers the client sends to `GET {base}/v1/models` on the same connection (`Authorization: Bearer …`, or `x-api-key` with `anthropic-version` on an Anthropic-wire base, plus the connection's custom headers). A server may return per-key prices: a downstream user's discount or markup.
- **Ids:** the `id`s are the same ids the server's `/v1/models` returns, and that the client sends as `model`.
- Optional query `?ids=a,b,c` may be ignored by the server; the client must accept the full list.
- Conditional requests: the client sends `If-None-Match` when it holds an `ETag`; the server may answer `304`.

### 4.2 Response

```json
{
  "object": "list",
  "unit": "USD per 1M tokens",
  "currency": "USD",
  "fetched_at": "2026-11-16T18:00:00Z",
  "valid_until": "2026-11-16T19:00:00Z",
  "data": [
    {
      "id": "example-model-1",
      "available": true,
      "input": 3.0,
      "output": 15.0,
      "cache_read": 0.3,
      "cache_write": { "5m": 3.75, "1h": 6.0 },
      "per_request": 0,
      "tiers": [
        { "input_above": 200000, "input": 6.0, "output": 22.5, "cache_read": 0.6, "cache_write": { "5m": 7.5, "1h": 12.0 } }
      ],
      "served_by": "…",
      "pct_of_list": 100,
      "order": 0,
      "routes": [
        { "target": "…", "upstream": "…", "input": 3.0, "output": 15.0, "list_input": 3.0, "list_output": 15.0, "pct_of_list": 100 }
      ]
    }
  ]
}
```

**The base fields** (what the existing implementation already returns): `object`, `unit`, `data[].id`, `available`, `served_by`, `input`, `output`, `pct_of_list`, `order`, `routes[]` with `target`, `upstream`, `input`, `output`, `list_input`, `list_output`, `pct_of_list`. One existing implementation serves exactly these, with the same auth and ids as `/v1/models`; it conforms by adding the extension fields it can fill, and a client must accept it as it is today.

**The extension fields** (all optional, so the format is a small superset of that implementation):

| Field | Where | Meaning |
|---|---|---|
| `currency` | top | ISO 4217 code or any short label; default `USD`. Overrides the currency in `unit`. |
| `fetched_at` | top | When the server computed these prices (RFC 3339). |
| `valid_until` | top | Until when the client may use them without asking again (RFC 3339). Also settable by `Cache-Control: max-age`. |
| `cache_read` | model, tier, route | Rate for cache reads. |
| `cache_write` | model, tier, route | A number (one rate for every TTL) or an object by TTL: `"5m"`, `"1h"`, or any `"<n>s"`/`"<n>m"`/`"<n>h"`. |
| `per_request` | model, tier, route | Flat price per request, in `currency` (not per million). |
| `tiers` | model, route | Long-context tiers: total input tokens (uncached + cache read + cache write) above `input_above` bills the whole request at that tier's rates. A field missing from a tier keeps the base rate. |
| `reasoning` | model, tier, route | Rate for reasoning tokens if they differ from `output`; absent means `output`. |

**`unit`.** `"USD per 1M tokens"` is the only unit defined. A client that doesn't recognise `unit` ignores the whole response (treated as unsupported for this fetch, §4.4).

### 4.3 Unknown, free and unavailable

- **Unknown:** a rate that's absent or `null` is unknown. The client then uses its own known price for that field, never zero. If `input` or `output` is unknown, the model has no endpoint price and the client's known price applies whole.
- **Free:** `0` means free, explicitly.
- **Unavailable:** `available: false` means the server won't serve the model now. The client shows it as unavailable on the model page; prices on it, if any, are still recorded but nothing is priced from them because nothing is sent.
- **Not listed:** a model `/v1/models` returns but `/v1/prices` doesn't is unknown, as above.
- Negative, non-finite or absurdly large rates (above the `CostRule` bound, 1e9) make that entry unknown, not the whole response.

### 4.4 Which rate a request is charged

- **The model's own rates** (`input`, `output`, …) are what the client charges. They're the price the server charges this key for this id.
- **`routes`** are informational: where the server may send the request and what each route costs. A client shows them; it prices from a route only when the response reports which route served the request (an `upstream` the ledger captured, matching `routes[].upstream` or `target`). Then that route's rates apply, the model's rates filling unknown fields.
- `served_by`, `order`, `pct_of_list`, `list_input`, `list_output` are display only (the model page can say "80 % of list price").

### 4.5 Detecting support [P]

- **Never probed without the opt-in.** The connection setting `priceEndpoint` (in `ProviderSettings`, off by default for every provider, explained on hover) is the only thing that causes a request to `/v1/prices`.
- When turned on, the client probes once. Results:
  - `200` with a valid body: supported.
  - `404` (and `405`, `501`): **unsupported.** Cached until the connection changes (its `cache_revision` advances: address, key, headers, proxy) or the user presses Refresh models. The setting shows "This server doesn't publish prices".
  - `401`/`403`: the key isn't accepted for prices; shown as such, retried on the next refresh.
  - other errors, timeouts or an invalid body: a failure; the last good prices stay in use, and it's retried after 10 minutes (as `ENDPOINTS_RETRY_MS`).
- The request goes through `Network.fetchFor` with the connection's key, so the credential's origin binding and the same-origin redirect rule apply unchanged.

### 4.6 Refresh policy [P]

- **On Refresh models**, for an opted-in connection, after the model list.
- **On a timer, only if opted in:** at `valid_until` (or `Cache-Control: max-age`) if given, clamped to between 5 minutes and 24 hours; otherwise every hour. The timer runs only while the connection has been used in the last day, so an idle connection sends nothing.
- **Before a request**, never: dispatch doesn't wait on a price fetch. A request is priced with what was known when it closed.
- `ETag` and `304` are used when the server sends them; a `304` only moves `fetchedAt`.
- **[P]** whether the hourly default is right for gateways that change prices often (§8 Q1).

### 4.7 Where fetched prices live [P]

- Per model, in `models.upstream_json` as a new optional field beside `endpoints`: `priceFeed: { fetchedAt, validUntil?, etag?, currency, price: Price | null, routes?, available?, error? }`. Like `endpoints`, it's kept across list refreshes and rewritten only by a price fetch.
- Per connection, the probe state (`supported | unsupported | denied | failed`, at which `cache_revision`, and when): in memory, keyed by connection id and `cache_revision`. After a restart one probe is sent again, only for opted-in connections; that costs one request and saves storing state.
- A model the price list adds but `/v1/models` doesn't list is not created; prices apply only to known models.

## 5. Which formula wins [P]

### 5.1 Order, newest registration first

1. `user-pricing`: the user's Settings → Costs rule naming this connection and model (decisions 1 and 6). It beats this connection's fetched prices.
2. `reported`: the provider's own charge for this request (OpenRouter `usage.cost`; a gateway's reported cost if one is added later). It's the actual charge, so it beats any table.
3. `endpoint`: the opted-in price endpoint's rates for this model (decision 4: it wins over our known prices).
4. `list`: the model list's or per-endpoint list's price.
5. `user-pricing` with an account-wide or per-connection-type scope: it never overrides a connection's own fetched prices (decision 6), so it sits below them.
6. `builtin`: the built-in table.

Each passes (null) when it has no price, so the next one is tried; unknown fields inside a found price fall back field by field to the next table source (§4.3).

### 5.2 Cost reservation and estimates

`upperBound` and `estimate` follow the same order. For an endpoint price with `routes`, the bound is the dearest route (as `userCosts` does for upstream rules), because the route isn't known before dispatch.

## 6. The ledger: "priced from the endpoint at time T" [P]

- `cost_formula` records the source and its version, no new column:
  - `endpoint:<fetchedAt ms>` (plus `:<route>` when a route's rates were used),
  - `list:<fetchedAt ms>` for OpenRouter list or endpoint prices (`list:endpoints:<fetchedAt>` for the pinned per-endpoint price),
  - `builtin:<table version>`, where the table version is the pi-ai version plus the supplement's content hash,
  - unchanged: `reported`, `user:<rule>:<revision>`.
- The **rates snapshot** the separate schema job adds is what the row was charged at; `cost_formula` says where those rates came from and when. Together they answer "priced from the endpoint at time T at these rates".
- The inspector shows it in user terms: "Priced from this server's price list, 16 Nov 18:00" / "Charged by the provider" / "Your price for this model".

### 6.1 Correcting prices (recompute) [P]

Implements PROVIDERS §9.3 "Recomputing" under decision 2.

- **Only on request:** Settings → Costs (after saving a rule) and a built-in correction offer "Apply to past requests", with the count and the date range first.
- **Which rows may change:** rows whose `cost_formula` is `builtin:*`, `list:*` or `user:*` and matches the corrected source (the same model and connection or kind, the same `builtin` version, the same rule). Never `reported`. `endpoint:*` and `list:*` rows change only for a price naming that connection, which replaces them and records them as `user:*` (§8 Q2, as built); an account-wide or per-type price never touches them.
- The new cost, currency, formula and rates snapshot are written in one writer transaction per batch (the trigger already allows only cost changes on a closed row; it must be extended to allow the snapshot column the schema job adds).
- **Not reversible in general:** the old cost, formula and rates are overwritten. Applying an earlier saved price again restores rows that a saved price had set (while that price is the one that applies); rows that were built-in, list or endpoint priced have nothing to go back to, and the dialog says so.
- **`data:` video** stays blocked by design (SAVED-MEDIA §3.4): it names no file to save, so the tag shows as blocked, as it was before video was kept.
- A release that corrects a built-in price doesn't recompute anything by itself; the Costs page offers it for rows priced from the old version.

## 7. UI [P]

- **Connection form, advanced:** "Fetch prices from this server" (off). Hover: "Asks this server for its prices when models are refreshed and every hour. Its prices then replace the app's for this connection." Shows the last fetch and its state.
- **Model page price row:** the price and its source ("from this server's price list, fetched 18:00", "from OpenRouter", "built in", "your price"), plus unavailable and route prices when the server sends them.
- **Settings → Costs** unchanged apart from `perRequest` and "Apply to past requests".

## 8. Coordinator decisions [P]

Proposed by the coordinator; the owner has not decided these and gave no quote.

1. **Refresh interval default:** one hour, `valid_until` overriding.
2. **Past prices:** a past price is corrected only through the user's own price with "Apply to past requests"; an endpoint price is never corrected otherwise. It's the server's own statement of what it charged. That step replaces `endpoint:*` rows, recorded as `user:*`.
3. **Reporting the served route:** a server may report the per-request cost later (a response header or usage field such as `x-price-route` or `usage.cost`), making it `reported`. A later optional extension.

## 9. Build plan [P]

| Phase | What | Baseline |
|---|---|---|
| PR1 | `Price` gains `cacheWriteLong`, `perRequest`, `currency`; `priceCost`, bounds and `CostRule.perRequest`; source-named formula ids (`list`, `builtin:<version>`) | none |
| PR2 | Built-in supplement files, the main-models coverage test, table version hash | none |
| PR3 | Price endpoint client: parser (base and extension fields, unknowns), probe and detection state, `priceFeed` in `upstream_json`, Refresh models hook, timer, `ETag`; `endpoint` formula; recorded-shape tests with a local synthetic server | none |
| PR4 | UI: connection opt-in, model page source line, inspector wording | none |
| PR5 | Recompute on request (§6.1), after the rates-snapshot schema job lands | none beyond that job's |
| PR6 | Publish §4 as a standalone document (`docs/price-endpoint.md`) with a JSON Schema and example responses | none |

**Baseline impact:** none. Fetched prices and detection state live in `models.upstream_json` (JSON) and in memory; the opt-in in `provider_settings_json`; the source and its time in the existing `cost_formula` text. The only schema need is the rates snapshot, already in the separate schema job; its trigger exception (§6.1) belongs in that job.
