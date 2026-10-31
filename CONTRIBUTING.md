# Contributing

Issues and pull requests are welcome, in English or Spanish.

## Setup

```bash
pnpm install
pnpm lint && pnpm typecheck && pnpm test
```

Tests need no credentials. To try the sandbox flow, copy `.env.example` to `.env.local` and use your own PayPal **sandbox** app. Never commit `.env.local` or paste credentials into issues.

## Rules for money paths

These keep a retry from ever charging twice and keep models away from money:

1. Every PayPal POST carries a deterministic `PayPal-Request-Id` from `requestId(ref, op)` in `src/lib/paypal/bond.ts`.
2. On an unknown outcome (timeout or 5xx), look the payment up before doing anything else. Never retry a 4xx.
3. Never trust the browser or a webhook body for state: read PayPal's authorization or capture first.
4. Model output can add soft flags to a report. It can never change a recommendation or trigger a capture.
5. New behavior on a money path comes with a test that fails without it.

## Agent-written pull requests

Welcome. Keep the agent's `Co-authored-by` trailer.
