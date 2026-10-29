/**
 * Sandbox smoke test for the bond lifecycle. Talks to the PayPal sandbox only.
 *
 *   pnpm smoke check    credentials work (creates one unapproved order, no browser needed)
 *   pnpm smoke run      3 bonds you approve in the browser: void, capture (with an injected 500) + refund, and one seeded hold
 *   pnpm smoke reauth   reauthorize the seeded hold once, then confirm a second reauthorization is refused (run 4+ days after `run`)
 *
 * Results go to .smoke/ (gitignored); the write-up goes in docs/sandbox-findings.md.
 */
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import {
  type BondRef,
  authorizeBond,
  captureBond,
  createBondOrder,
  getAuthorization,
  reauthorizeBond,
  refundBond,
  voidBond,
} from "../src/lib/paypal/bond";
import { PayPalError } from "../src/lib/paypal/client";

const PORT = Number(process.env.SMOKE_PORT ?? 4545);
const DIR = ".smoke";
const results: { step: string; ok: boolean; detail: string }[] = [];

function record(step: string, ok: boolean, detail: unknown) {
  const text = detail instanceof PayPalError
    ? `${detail.statusCode ?? "-"} ${detail.issue ?? ""} debug_id=${detail.debugId ?? "-"}`
    : typeof detail === "string" ? detail : JSON.stringify(detail);
  results.push({ step, ok, detail: text });
  console.log(`${ok ? "✔" : "✘"} ${step}: ${text}`);
}

async function attempt<T>(step: string, fn: () => Promise<T>): Promise<T | undefined> {
  try {
    const value = await fn();
    record(step, true, value ?? "ok");
    return value;
  } catch (err) {
    record(step, false, err instanceof Error ? err : String(err));
    return undefined;
  }
}

/** Expects a failure: ok means PayPal refused, which is what we want to see. */
async function expectFailure(step: string, fn: () => Promise<unknown>): Promise<PayPalError | undefined> {
  try {
    const value = await fn();
    record(step, false, `unexpectedly succeeded: ${JSON.stringify(value)}`);
  } catch (err) {
    record(step, true, err instanceof Error ? err : String(err));
    if (err instanceof PayPalError) return err;
  }
  return undefined;
}

function newRef(pr: number): BondRef {
  return { owner: "fianza-smoke", repo: "sandbox", pr, headSha: randomBytes(20).toString("hex") };
}

// --- approval capture: PayPal redirects the browser back here after the buyer approves ---

const waiting = new Map<string, { resolve: () => void; reject: (e: Error) => void }>();
const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
  const token = url.searchParams.get("token") ?? "";
  const approved = url.pathname === "/return";
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(`<meta charset="utf-8"><body style="font:20px system-ui;padding:3rem">${
    approved ? "✔ Fianza aprobada. Vuelve a la terminal." : "✘ Cancelada. Vuelve a la terminal."
  }</body>`);
  const w = waiting.get(token);
  if (!w) return;
  waiting.delete(token);
  if (approved) w.resolve();
  else w.reject(new Error("buyer cancelled in PayPal"));
});

async function approvedBond(ref: BondRef, label: string) {
  const order = await createBondOrder(ref, {
    returnUrl: `http://localhost:${PORT}/return`,
    cancelUrl: `http://localhost:${PORT}/cancel`,
  });
  record(`${label}: create AUTHORIZE order`, true, { orderId: order.orderId, status: order.status });
  console.log(`\n→ Aprueba en PayPal con tu cuenta PERSONAL de sandbox:\n  ${order.approvalUrl}\n`);
  execFile("open", [order.approvalUrl], () => {});
  await new Promise<void>((resolve, reject) => waiting.set(order.orderId, { resolve, reject }));
  const auth = await authorizeBond(order.orderId, ref);
  record(`${label}: authorize (hold placed)`, auth.status === "CREATED", auth);
  return { order, auth };
}

async function check() {
  const ref = newRef(1);
  const order = await createBondOrder(ref, { returnUrl: "https://example.com/return", cancelUrl: "https://example.com/cancel" });
  console.log(`✔ Credentials work. Created unapproved order ${order.orderId} (${order.status}).`);
}

async function run() {
  mkdirSync(DIR, { recursive: true });
  await new Promise<void>((r) => server.listen(PORT, r));

  // A. The default outcome: void, the operator pays $0.
  const refA = newRef(101);
  const a = await approvedBond(refA, "A");
  await attempt("A: GET authorization before void", () => getAuthorization(a.auth.authorizationId));
  await attempt("A: void", () => voidBond(a.auth.authorizationId, refA));
  await attempt("A: GET authorization after void (expect VOIDED)", () => getAuthorization(a.auth.authorizationId));
  await attempt("A: void again with the same PayPal-Request-Id (idempotent replay?)", () => voidBond(a.auth.authorizationId, refA));
  await expectFailure("A: capture a voided hold (must fail)", () => captureBond(a.auth.authorizationId, refA));

  // B. Forfeit with an injected 5xx: look up before retrying, then exactly one capture, then an appeal refund.
  const refB = newRef(102);
  const b = await approvedBond(refB, "B");
  const fault = await expectFailure("B: capture with PayPal-Mock-Response INTERNAL_SERVER_ERROR", () =>
    captureBond(b.auth.authorizationId, refB, { mock: "INTERNAL_SERVER_ERROR" }),
  );
  record("B: injected fault leaves the outcome unknown", fault?.outcomeUnknown === true, `outcomeUnknown=${fault?.outcomeUnknown}`);
  await attempt("B: GET authorization after the fault (expect still CREATED)", () => getAuthorization(b.auth.authorizationId));
  const capture = await attempt("B: retry capture with the same PayPal-Request-Id", () => captureBond(b.auth.authorizationId, refB));
  if (capture) {
    const replay = await attempt("B: replay capture with the same PayPal-Request-Id (expect same capture id)", () =>
      captureBond(b.auth.authorizationId, refB),
    );
    record("B: replay returned the same capture (no double charge)", replay?.captureId === capture.captureId, `${capture.captureId} vs ${replay?.captureId}`);
    await attempt("B: refund (appeal won)", () => refundBond(capture.captureId, refB));
  }

  // C. Seed a hold for the reauthorization test, which only works after the 3-day honor period.
  const refC = newRef(103);
  const c = await approvedBond(refC, "C");
  writeFileSync(`${DIR}/seeded.json`, JSON.stringify({ ref: refC, ...c.auth, seededAt: new Date().toISOString() }, null, 2));
  record("C: seeded hold saved for `pnpm smoke reauth`", true, c.auth.authorizationId);

  server.close();
}

async function reauth() {
  const seeded = JSON.parse(readFileSync(`${DIR}/seeded.json`, "utf8")) as { ref: BondRef; authorizationId: string; seededAt: string };
  const days = (Date.now() - Date.parse(seeded.seededAt)) / 86_400_000;
  console.log(`Seeded ${days.toFixed(1)} days ago (${seeded.authorizationId}).`);
  await attempt("reauth: GET seeded authorization", () => getAuthorization(seeded.authorizationId));
  const re = await attempt("reauth: reauthorize once", () => reauthorizeBond(seeded.authorizationId, seeded.ref));
  await expectFailure("reauth: reauthorize a second time (docs disagree; expect refusal)", () =>
    reauthorizeBond(seeded.authorizationId, { ...seeded.ref, headSha: randomBytes(20).toString("hex") }),
  );
  if (re) await attempt("reauth: void the new authorization", () => voidBond(re.authorizationId, seeded.ref));
}

async function main() {
  const command = process.argv[2] ?? "check";
  const commands: Record<string, () => Promise<void>> = { check, run, reauth };
  if (!commands[command]) {
    console.error(`Unknown command "${command}". Use: check | run | reauth`);
    process.exit(1);
  }
  try {
    await commands[command]();
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  } finally {
    if (results.length) {
      mkdirSync(DIR, { recursive: true });
      writeFileSync(`${DIR}/${command}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`, JSON.stringify(results, null, 2));
      const failed = results.filter((r) => !r.ok).length;
      console.log(`\n${results.length - failed}/${results.length} steps as expected.`);
    }
    server.close();
  }
}

void main();
