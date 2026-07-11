---
type: feature
status: active
project: storefront
unit: loyalty-flow
after: [cart-icon-fix]
budget: 15.00
---

# loyalty-flow

Reward repeat storefront buyers with points redeemable at checkout, promoted from the
loyalty-program idea. Waits on `cart-icon-fix`; now that it has shipped, this unit's start gate
is open for the Conductor to kick off kestrel's flow (PRD §6 start gate, §9 `start` verb).
