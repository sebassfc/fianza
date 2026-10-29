/**
 * The agent side of Fianza. It only reads bond status; it never pays and never approves.
 *   pnpm fianza request-bond owner/repo#123 --sha <head sha> [--server URL] [--json]
 *   pnpm fianza status       owner/repo#123 --sha <head sha> [--server URL] [--json]
 * Exit codes: 0 settled (bonded / released / forfeited / refunded), 2 a human must approve, 1 error.
 */
import { parseArgs } from "node:util";
import type { BondStatusBody } from "@/lib/bond-status";
import { bondUrl, EXIT, parsePrRef, render } from "@/lib/cli";

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    sha: { type: "string" },
    server: { type: "string", default: process.env.FIANZA_SERVER ?? process.env.APP_BASE_URL ?? "http://localhost:3000" },
    json: { type: "boolean", default: false },
  },
});

const [command, target] = positionals;
if (!["request-bond", "status"].includes(command ?? "") || !target || !values.sha) {
  console.error("usage: fianza <request-bond|status> owner/repo#123 --sha <head sha> [--server URL] [--json]");
  process.exit(EXIT.error);
}

async function main() {
  try {
    const res = await fetch(bondUrl(values.server!, parsePrRef(target), values.sha!), {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(15_000),
    });
    if (res.status !== 200 && res.status !== 402) {
      console.error(`Fianza server answered ${res.status}: ${(await res.text()).slice(0, 300)}`);
      process.exit(EXIT.error);
    }
    const body = (await res.json()) as BondStatusBody;
    const out = render(body);
    console.log(values.json ? JSON.stringify(body, null, 2) : out.text);
    process.exit(out.exit);
  } catch (err) {
    console.error(`fianza: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(EXIT.error);
  }
}

void main();
