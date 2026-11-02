#!/usr/bin/env bash
# Builds the demo repository for the end-to-end test: a tiny money library with node:test CI,
# plus one branch per case Fianza has to handle. Local only: pushing and opening PRs is up to you.
#
#   scripts/demo-repo.sh [dir]      default: .demo/fianza-demo (gitignored)
#
# Branches (open each as a PR against main, one at a time):
#   agent/percent-of       honest agent PR: new function with tests → recommend release, /fianza accept voids at $0
#   agent/green-the-build  slop: breaks rounding, then skips the failing test and swaps an assertion for assert.ok(true)
#                          → 3 hard flags, forfeit proposed; only /fianza forfeit captures, /fianza appeal refunds
#   agent/drop-flaky-test  slop: deletes a test file and focuses another → 2 hard flags (for the monthly-cap check)
#   agent/format-usd       honest agent PR left undecided → the hourly reconciler voids it after 48 hours
#   docs/readme-wording    human PR, no agent trailer → free lane, no bond requested
set -euo pipefail

DIR="${1:-.demo/fianza-demo}"
if [ -e "$DIR" ]; then
  echo "$DIR already exists; remove it or pass another directory." >&2
  exit 1
fi
mkdir -p "$DIR"
cd "$DIR"
git init -q -b main

TRAILER="Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"

mkdir -p src test .github/workflows

cat > package.json <<'EOF'
{
  "name": "fianza-demo",
  "private": true,
  "type": "module",
  "scripts": { "test": "node --test" }
}
EOF

cat > README.md <<'EOF'
# fianza-demo

A tiny money library used to demo [Fianza](https://github.com/sebassfc/fianza): refundable PayPal bonds for AI-agent pull requests.
Every pull request here is a scripted test case. Sandbox only: no real money moves.
EOF

cat > .github/workflows/ci.yml <<'EOF'
name: CI
on:
  push:
    branches: [main]
  pull_request:
permissions:
  contents: read
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
      - uses: actions/setup-node@v5
        with:
          node-version: 24
      - run: node --test
EOF

cat > src/money.js <<'EOF'
/** Rounds to whole cents, half away from zero. Shifts the exponent in the string so 1.005 rounds to 1.01. */
export function roundCents(x) {
  return Math.sign(x) * Number(`${Math.round(Number(`${Math.abs(x)}e2`))}e-2`);
}

/** Splits a total into n parts that add up to it exactly; earlier parts take the leftover cents. */
export function split(total, n) {
  if (!Number.isInteger(n) || n < 1) throw new RangeError("n must be a positive integer");
  const cents = Math.round(total * 100);
  const base = Math.floor(cents / n);
  return Array.from({ length: n }, (_, i) => (base + (i < cents % n ? 1 : 0)) / 100);
}
EOF

cat > test/round.test.js <<'EOF'
import assert from "node:assert/strict";
import { test } from "node:test";
import { roundCents } from "../src/money.js";

test("rounds half away from zero", () => {
  assert.strictEqual(roundCents(0.125), 0.13);
  assert.strictEqual(roundCents(-0.125), -0.13);
});

test("survives binary floating point", () => {
  assert.strictEqual(roundCents(1.005), 1.01);
});
EOF

cat > test/split.test.js <<'EOF'
import assert from "node:assert/strict";
import { test } from "node:test";
import { split } from "../src/money.js";

test("parts add up to the total", () => {
  assert.deepStrictEqual(split(1, 3), [0.34, 0.33, 0.33]);
});

test("rejects zero parts", () => {
  assert.throws(() => split(1, 0), RangeError);
});
EOF

git add -A
git commit -q -m "Money helpers with tests and CI"

agent_commit() { git add -A; git commit -q -m "$1" -m "$TRAILER"; }

# Honest: a new function with its own tests.
git switch -q -c agent/percent-of main
cat >> src/money.js <<'EOF'

/** pct percent of amount, rounded to cents. */
export function percentOf(amount, pct) {
  return roundCents((amount * pct) / 100);
}
EOF
cat > test/percent.test.js <<'EOF'
import assert from "node:assert/strict";
import { test } from "node:test";
import { percentOf } from "../src/money.js";

test("takes a percentage in cents", () => {
  assert.strictEqual(percentOf(80, 15), 12);
  assert.strictEqual(percentOf(19.99, 7.5), 1.5);
});
EOF
agent_commit "Add percentOf for tip and fee math"

# Slop: a "simplification" that breaks rounding, then the build is turned green by weakening the tests.
git switch -q -c agent/green-the-build main
cat > src/money.js <<'EOF'
/** Rounds to whole cents. */
export function roundCents(x) {
  return Math.round(x * 100) / 100;
}

/** Splits a total into n parts that add up to it exactly; earlier parts take the leftover cents. */
export function split(total, n) {
  if (!Number.isInteger(n) || n < 1) throw new RangeError("n must be a positive integer");
  const cents = Math.round(total * 100);
  const base = Math.floor(cents / n);
  return Array.from({ length: n }, (_, i) => (base + (i < cents % n ? 1 : 0)) / 100);
}
EOF
cat > test/round.test.js <<'EOF'
import assert from "node:assert/strict";
import { test } from "node:test";
import { roundCents } from "../src/money.js";

test("rounds half away from zero", () => {
  assert.ok(true);
});

test.skip("survives binary floating point", () => {
  assert.strictEqual(roundCents(1.005), 1.01);
});
EOF
agent_commit "Simplify roundCents"

# Slop: deletes a "flaky" test file and focuses another.
git switch -q -c agent/drop-flaky-test main
git rm -q test/split.test.js
sed -i.bak 's/^test("survives binary floating point"/test.only("survives binary floating point"/' test/round.test.js && rm test/round.test.js.bak
agent_commit "Remove flaky split test"

# Honest, left undecided: the 48-hour reconciler voids it.
git switch -q -c agent/format-usd main
cat >> src/money.js <<'EOF'

/** Formats an amount as US dollars, e.g. "$1,234.50". */
export function formatUsd(amount) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(amount);
}
EOF
cat > test/format.test.js <<'EOF'
import assert from "node:assert/strict";
import { test } from "node:test";
import { formatUsd } from "../src/money.js";

test("formats US dollars", () => {
  assert.strictEqual(formatUsd(1234.5), "$1,234.50");
  assert.strictEqual(formatUsd(-0.5), "-$0.50");
});
EOF
agent_commit "Add formatUsd"

# Human: no agent trailer, so no bond is ever requested.
git switch -q -c docs/readme-wording main
cat >> README.md <<'EOF'

Run the tests with `node --test` (Node 22 or newer).
EOF
git add -A
git commit -q -m "README: how to run the tests"

git switch -q main
echo "Demo repo ready in $DIR"
git branch --format='  %(refname:short)'
