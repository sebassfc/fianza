# For judges

**Fianza in one line:** coding agents post a refundable PayPal hold to get their pull request reviewed within 48 hours; honest work is released at $0, and only a maintainer, backed by at least two hard deterministic flags, can forfeit it.

Everything runs on the PayPal **sandbox**. You need no API keys: they live on the server.

## Try it in 3 minutes

| | |
|---|---|
| Hosted demo | _(link added at deploy)_ |
| Sandbox buyer account | _(added at deploy; a PayPal sandbox personal account, not a real one)_ |
| Demo repository with the GitHub App installed | _(link added at deploy)_ |

1. **Be the agent.** Open `/bond/acme/widgets/1?sha=abc1234`. You get **HTTP 402** with the amount, the terms, the repo's forfeit rate and an `approval_url` meant for a human. This is what the CLI and the Claude Code skill read; the agent stops here.
2. **Be the human.** Open the `approval_url`. Read the bilingual terms, click the PayPal button and approve with the sandbox buyer. The server places the hold with PayPal and checks the authorization status PayPal returns before the page says the hold is in place; the browser's word is never taken.
3. **Be the maintainer.** Open `/dashboard`: the bond is **Held**, with its history. In the demo repository, a maintainer's `/fianza accept` voids it ($0), `/fianza forfeit` captures it only if the evidence proposed it, and `/fianza appeal` refunds a forfeit.
4. **Do nothing.** A hold nobody decides on is voided by the reconciler after 48 hours.

The full GitHub loop (agent PR → CI → cited report → maintainer command → PayPal) is in the video.

## Where to look, by criterion

**Technical implementation**
- Every money move: [`src/lib/paypal/bond.ts`](src/lib/paypal/bond.ts) (deterministic `PayPal-Request-Id`), [`src/lib/decisions.ts`](src/lib/decisions.ts) (look up before retry on a timeout or 5xx), [`src/lib/reconcile.ts`](src/lib/reconcile.ts) (48-hour guarantee).
- Webhooks verified locally (CRC32 + SHA256withRSA, PayPal-host certificates only) and applied from a fresh GET, never from the event body: [`src/lib/paypal/`](src/lib/paypal/).
- The policy that decides when money may move, in one small file: [`src/lib/policy/index.ts`](src/lib/policy/index.ts).
- Tests run in CI with no secrets; Postgres runs in-process with PGlite.

**Design**
- Bilingual (English and Spanish) pay page, terms, appeal page, report and maintainer commands (`/fianza aceptar · cobrar · apelar`).
- Every state has its own page state: awaiting, held, released, forfeited, refunded, and errors.

**Potential impact**
- Gives maintainers a way to accept agent PRs without paying for the bad ones with their own time, and gives honest agents an express lane that costs $0.

**Innovation**
- An authorization hold used as a *bond*, with void as the default, rather than as a deferred payment.
- An HTTP 402 offer that an agent must hand to its human; the agent never approves or pays.
- AI is used where it is strong (checking a PR's claims against its diff, with citations) and kept away from where it is risky (it can never move money).

## Honest limits

See [README › Honest limits](README.md#honest-limits).
