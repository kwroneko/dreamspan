# The price endpoint

A small, optional extension an OpenAI- or Anthropic-compatible server can offer so its clients know
what each model costs on that server, for that key. A client asks only when its user turned it on
for that connection. The JSON Schema is [`price-endpoint.schema.json`](price-endpoint.schema.json).

## Request

```
GET {base}/v1/prices
```

- `{base}` is the base URL the client is configured with, without a trailing `/v1`:
  `https://gw.example/v1` and `https://gw.example` both ask `https://gw.example/v1/prices`.
  The path is the same for OpenAI-style and Anthropic-style servers.
- **Authentication:** the same headers the client sends to `GET {base}/v1/models`:
  `Authorization: Bearer <key>`, or `x-api-key` with `anthropic-version` on an Anthropic-style
  server, plus any custom headers configured for the connection. A server may answer per key: a
  downstream user's discount or markup.
- **Ids** are the ids `/v1/models` returns and that requests send as `model`.
- The client may add `?ids=a,b,c`; a server may ignore it, and the client accepts the full list.
- **Conditional requests:** when the client holds an `ETag` from an earlier answer it sends
  `If-None-Match`; the server may answer `304 Not Modified`.

## Response

`200` with `Content-Type: application/json`:

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
        {
          "input_above": 200000,
          "input": 6.0,
          "output": 22.5,
          "cache_read": 0.6,
          "cache_write": { "5m": 7.5, "1h": 12.0 }
        }
      ],
      "served_by": "pool-a",
      "pct_of_list": 100,
      "order": 0,
      "routes": [
        {
          "target": "fast",
          "upstream": "provider-a",
          "input": 3.0,
          "output": 15.0,
          "list_input": 3.0,
          "list_output": 15.0,
          "pct_of_list": 100
        }
      ]
    }
  ]
}
```

### Fields

| Field | Where | Meaning |
|---|---|---|
| `object` | top | Always `"list"`. |
| `unit` | top | `"USD per 1M tokens"` (or `"<currency> per 1M tokens"`). The only unit defined; a client that doesn't recognise `unit` ignores the whole response. |
| `currency` | top | ISO 4217 code or any short label (at most 16 characters); default `USD`. Overrides the currency in `unit`. Nothing is converted. |
| `fetched_at` | top | When the server computed these prices (RFC 3339). |
| `valid_until` | top | Until when the client may use them without asking again (RFC 3339). `Cache-Control: max-age` says the same. |
| `id` | model | The model id, as `/v1/models` returns it. |
| `available` | model | `false`: the server won't serve the model now. |
| `input`, `output` | model, tier, route | Rates for uncached input and for output. |
| `cache_read` | model, tier, route | Rate for cache reads. |
| `cache_write` | model, tier, route | A number (one rate for every cache lifetime) or an object by lifetime: `"5m"`, `"1h"`, or any `"<n>s"`/`"<n>m"`/`"<n>h"`. |
| `reasoning` | model, tier, route | Rate for reasoning tokens, when it differs from `output`. Absent: `output`. |
| `per_request` | model, tier, route | A flat price per request, in `currency` (not per million). |
| `tiers` | model, route | Long-context tiers: when total input (uncached + cache read + cache write) is above `input_above`, the whole request is billed at that tier's rates. A rate missing from a tier keeps the base rate. |
| `routes` | model | Where the server may send the model and what each route costs (below). |
| `served_by`, `order`, `pct_of_list`, `list_input`, `list_output` | model, route | Display only, for example "80 % of list price". |

All rates are per million tokens in `currency`, except `per_request`.

### Unknown, free and unavailable

- **Unknown:** a rate that's absent or `null` is unknown. The client uses its own known price for
  that rate, never zero. If `input` or `output` is unknown, the model has no price from the server
  and the client's own price applies whole.
- **Free:** `0` means free, explicitly.
- **Out of range:** a negative, non-finite or absurdly large rate (above 1e9) makes that entry
  unknown, not the whole response.
- **Unavailable:** `available: false` means the server won't serve the model now. Its prices, if
  any, may be shown, but nothing is priced from them because nothing is sent.
- **Not listed:** a model `/v1/models` returns but the price list doesn't name has no price from
  the server. A model only the price list names isn't added to the client's models.

### Which rate a request is charged

- The model's own rates are what the client charges: the price the server charges this key for
  this id.
- `routes` are informational. A client prices a request from a route only when the response said
  which route served it (for example OpenAI-style streams' per-chunk `provider` field), matching a
  route's `upstream`, else its `target`. That route's rates apply, the model's filling the rates
  the route leaves unknown. Before a request is sent the route isn't known, so a client that
  reserves a maximum cost uses the dearest route.

## Status codes

| Answer | Meaning to the client |
|---|---|
| `200` with a valid body | Supported: the prices are used. |
| `304` | Unchanged: the prices held stay in use (only the time they were fetched moves). |
| `404`, `405`, `501` | Unsupported: the server doesn't publish prices. The client doesn't ask again until the connection changes (address, key, headers, proxy) or the user refreshes models. |
| `401`, `403` | The key isn't accepted for prices. The client's own prices apply; it asks again later. |
| Anything else, a timeout, or a body that isn't a price list | A failure: the last good prices stay in use, and the client asks again after about 10 minutes. |

## When clients ask

- Only when the user turned the price endpoint on for that connection. Nothing is sent otherwise.
- When the user refreshes the connection's models, after the model list.
- Otherwise at `valid_until` (or `max-age`), kept between 5 minutes and 24 hours, else hourly, and
  only while the connection was used in the last day.
- Never before a request: a request is priced with the prices known when it ended, and a past
  request keeps the price it was charged at.

## Examples

The smallest valid answer (only the base fields):

```json
{
  "object": "list",
  "unit": "USD per 1M tokens",
  "data": [{ "id": "example-model-1", "available": true, "input": 3, "output": 15 }]
}
```

A gateway in euros with one free model, one with an unknown output rate (so the client's own price
applies to it) and one that's paused:

```json
{
  "object": "list",
  "unit": "EUR per 1M tokens",
  "valid_until": "2026-11-16T19:00:00Z",
  "data": [
    { "id": "free-model", "input": 0, "output": 0 },
    { "id": "half-known", "input": 1.2, "output": null },
    { "id": "paused-model", "available": false, "input": 5, "output": 20 }
  ]
}
```

A model with a flat per-request charge and one cache-write rate for every lifetime:

```json
{
  "object": "list",
  "unit": "USD per 1M tokens",
  "data": [{ "id": "search-model", "input": 1, "output": 4, "cache_write": 1.25, "per_request": 0.005 }]
}
```
