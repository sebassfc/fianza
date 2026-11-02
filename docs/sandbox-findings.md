# PayPal sandbox findings

What the real PayPal sandbox returned when the bond lifecycle ran against it, as opposed to the fakes in the unit tests.
Run with `pnpm smoke run` on **November 2, 2026** with a US business sandbox account (the merchant) and a US personal sandbox account (the buyer). The buyer approved each hold in the browser.

**Result: 19 of 19 steps behaved as expected.**

## A. Release: the default outcome, $0

| Step | PayPal returned |
|---|---|
| Create the order, `intent: AUTHORIZE` | `PAYER_ACTION_REQUIRED` (the buyer still has to approve) |
| Authorize after approval | `201`, authorization `CREATED`, $5.00, expires 29 days later (Nov 2 → Dec 1) |
| Void | `204` |
| Read it back | `VOIDED` |
| Void again with the same `PayPal-Request-Id` | `204`: the replay is harmless |
| Capture the voided hold | `422 AUTHORIZATION_VOIDED`: a released bond can never be charged |

## B. Forfeit with an injected failure, then an appeal

| Step | PayPal returned |
|---|---|
| Authorize after approval | `201`, `CREATED`, $5.00 |
| Capture with `PayPal-Mock-Response: INTERNAL_SERVER_ERROR` | `500`; Fianza marks the outcome as unknown instead of guessing |
| Read the authorization after the failure | Still `CREATED`: nothing was charged |
| Retry the capture with the same `PayPal-Request-Id` | `201`, capture `COMPLETED`, $5.00 |
| Replay the capture with the same `PayPal-Request-Id` | `200` with **the same capture id**: no double charge |
| Refund the capture (appeal won) | `201`, refund `COMPLETED` |

The replay answers `200` where the first capture answered `201`; both carry the capture, and the code accepts either.

## C. Reauthorization (pending)

A third hold was placed and left open (`CREATED`, expires Dec 1). `pnpm smoke reauth` reauthorizes it once and checks that a second reauthorization is refused. It can only run after PayPal's 3-day honor period, so on **November 6 or later**. Its result goes here.

## Notes

- The raw results of every run are written to `.smoke/` (gitignored).
- The first US personal sandbox account created on November 1 could not log in to checkout and was flagged for too many attempts. A new one created on November 2 logged in on the first try.
