---
name: model-pricing
tags: [cost, reference]
---

# Model pricing

This table is the KNOWN-MODEL set (NOTES F11): `levare validate` rejects any agent or
studio declaration naming a model not listed here (`UNKNOWN_MODEL`) — a model absent from
this table can never be declared in the first place.

It also prices a `kind: cli`/`remote` member's receipt: those members report tokens, and
levare estimates `usd` from these USD-per-million-token rates. Subscription-plan members
price at 0 with the plan noted instead; unpriceable receipts record `usd: null`.

A `kind: native` member's receipt prices differently: `usd` is the Claude Agent SDK's own
reported cost (real vendor billing), used verbatim — this table never prices it, and the
table's flat per-model rate won't exactly reproduce it from `tokens_in`/`tokens_out` alone,
since the SDK's cost also accounts for prompt-cache read/write tokens (`tokens_cache_read`/
`tokens_cache_write` on the receipt) at their own separate rates this table doesn't carry.

| model             | tokens_in (/M) | tokens_out (/M) |
| ----------------- | --------------- | --------------- |
| claude-opus-4-8   | 5.00            | 25.00           |
| claude-sonnet-5   | 3.00            | 15.00           |
| claude-haiku-4-5  | 1.00            | 5.00            |
| claude-sonnet-4-5 | 3.00            | 15.00           |
| claude-opus-4-1   | 15.00           | 75.00           |
