import {
  ApiError,
  Client,
  Environment,
  LogLevel,
  OrdersController,
  PaymentsController,
} from "@paypal/paypal-server-sdk";
import { env } from "@/lib/env";

// The SDK fetches a client-credentials token on first use and fetches a new one once it expires,
// so long-running servers never hold a stale token (the Agent Toolkit's token never refreshes).
let client: Client | undefined;

function paypalClient(): Client {
  if (client) return client;
  const { PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET } = env();
  client = new Client({
    clientCredentialsAuthCredentials: {
      oAuthClientId: PAYPAL_CLIENT_ID,
      oAuthClientSecret: PAYPAL_CLIENT_SECRET,
    },
    environment: Environment.Sandbox,
    timeout: 20_000,
    logging: {
      logLevel: LogLevel.Warn,
      logRequest: { logBody: false },
      logResponse: { logHeaders: false },
    },
  });
  return client;
}

export const orders = () => new OrdersController(paypalClient());
export const payments = () => new PaymentsController(paypalClient());

/** A PayPal failure with the fields support and the ledger need. */
export class PayPalError extends Error {
  constructor(
    message: string,
    readonly statusCode: number | undefined,
    readonly issue: string | undefined,
    readonly debugId: string | undefined,
  ) {
    super(message);
    this.name = "PayPalError";
  }

  /** 5xx and timeouts leave the outcome unknown: look the resource up before retrying. */
  get outcomeUnknown(): boolean {
    return this.statusCode === undefined || this.statusCode >= 500;
  }
}

export function toPayPalError(err: unknown, op: string): PayPalError {
  if (err instanceof ApiError) {
    const body = parseBody(err.body);
    const issue = body?.details?.[0]?.issue ?? body?.name;
    return new PayPalError(
      `${op} failed: ${err.statusCode} ${issue ?? ""} ${body?.message ?? ""}`.trim(),
      err.statusCode,
      issue,
      body?.debug_id,
    );
  }
  const message = err instanceof Error ? err.message : String(err);
  return new PayPalError(`${op} failed: ${message}`, undefined, undefined, undefined);
}

type ErrorBody = { name?: string; message?: string; debug_id?: string; details?: { issue?: string }[] };

function parseBody(body: unknown): ErrorBody | undefined {
  if (typeof body !== "string") return undefined;
  try {
    return JSON.parse(body) as ErrorBody;
  } catch {
    return undefined;
  }
}
