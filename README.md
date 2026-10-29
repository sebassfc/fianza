# Fianza

A refundable PayPal bond that AI coding agents post to buy a guaranteed review of their pull request.
Honest work is voided at $0. Slop is captured to pay for the maintainer's time.
The decision rests on cited, deterministic evidence, never on how the description is written.

> Status: in development for the PayPal AI Hackathon (sandbox only).

## How a bond moves

```
AWAITING_BOND ──authorize──▶ BONDED ──void (default)──▶ VOIDED      operator pays $0
                               │
                               └──capture (maintainer confirms a proposed forfeit)──▶ CAPTURED ──refund (appeal)──▶ REFUNDED
```

- A forfeit can only be **proposed** by at least 2 hard deterministic flags. LLM findings never move money.
- Prompt injection or incomplete evidence freezes the recommendation at REVIEW.
- Every PayPal POST carries a deterministic `PayPal-Request-Id`, so a retry can never charge twice.

## Run it locally

```bash
pnpm install
cp .env.example .env.local   # PayPal sandbox REST app credentials
pnpm test                    # policy and idempotency property tests
pnpm smoke check             # verifies the sandbox credentials
pnpm smoke run               # full bond lifecycle against the sandbox (you approve 3 holds in the browser)
pnpm dev
```

## License

[MIT](LICENSE)
