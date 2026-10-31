# Security

Fianza only talks to the PayPal sandbox, but it verifies webhooks, holds secrets and moves (sandbox) money, so security reports matter.

## Reporting

Use GitHub's **private vulnerability reporting** on this repository (Security → Report a vulnerability). Please do not open a public issue.

Include what you found, how to reproduce it, and what an attacker could do with it. Never include real credentials or real payment data.

## In scope

- Forging or replaying PayPal or GitHub webhooks
- Making Fianza capture, void or refund a bond it should not, or twice
- Making a model's output or text inside a PR move money or change a recommendation
- Reaching `/api/cron/reconcile` without the secret
- Leaking secrets through logs, pages or comments
