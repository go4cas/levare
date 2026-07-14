---
name: model-pricing
tags: [cost, reference]
---

# Model pricing

USD-per-million-token estimates used to price usage receipts (§10). Subscription-plan
members price at 0 with the plan noted; unpriceable receipts record `usd: null`.

This table is also the KNOWN-MODEL set (NOTES F11): `levare validate` rejects any agent or
studio declaration naming a model not listed here (`UNKNOWN_MODEL`) — an unpriceable model
means silently wrong cost accounting, so a model that cannot be priced cannot be declared.

| model             | tokens_in (/M) | tokens_out (/M) |
| ----------------- | --------------- | --------------- |
| claude-opus-4-8   | 5.00            | 25.00           |
| claude-sonnet-5   | 3.00            | 15.00           |
| claude-haiku-4-5  | 1.00            | 5.00            |
| claude-sonnet-4-5 | 3.00            | 15.00           |
| claude-opus-4-1   | 15.00           | 75.00           |
