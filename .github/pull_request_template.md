## What and why

## How I checked it

- [ ] `pnpm lint && pnpm typecheck && pnpm test` pass
- [ ] Money paths: any new PayPal call carries a deterministic `PayPal-Request-Id` and handles an unknown outcome by looking the payment up
- [ ] No model output can move money or change a recommendation on its own

If an AI agent wrote this PR, keep its `Co-authored-by` trailer.
