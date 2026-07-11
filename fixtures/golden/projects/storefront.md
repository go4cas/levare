---
name: storefront
repo: git@github.com:acme/storefront.git
remote: https://github.com/acme/storefront
default_branch: main
deploy: https://storefront.acme.dev
pace: auto
overrides:
  pace: auto
---

# Storefront — house rules

Ship small, reversible increments. Every user-facing string passes the copy review.
Payments code is protected: changes there always draw a human merge gate regardless of
score. This text is injected into every member context for this project.
