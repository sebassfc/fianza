import { createHash } from "node:crypto";
import {
  CheckoutPaymentIntent,
  PaypalExperienceUserAction,
  PaypalWalletContextShippingPreference,
} from "@paypal/paypal-server-sdk";
import { env } from "@/lib/env";
import { orders, payments, toPayPalError } from "./client";

/** The pull request a bond is posted for. The head SHA pins the bond to one exact diff. */
export type BondRef = { owner: string; repo: string; pr: number; headSha: string };

export type BondOp = "create" | "authorize" | "void" | "capture" | "reauthorize" | "refund";

/** Optional sandbox negative-testing code, sent as PayPal-Mock-Response. */
export type Mock = { mock?: string };

/** Used as the order's custom_id (max 127 chars), so very long repo names are hashed. */
export function bondLabel(ref: BondRef): string {
  const pr = `#${ref.pr}@${ref.headSha.slice(0, 12)}`;
  const label = `${ref.owner}/${ref.repo}${pr}`;
  if (label.length <= 127) return label;
  return `${createHash("sha256").update(`${ref.owner}/${ref.repo}`).digest("hex").slice(0, 16)}${pr}`;
}

/**
 * Deterministic PayPal-Request-Id: retrying the same operation on the same bond can never move money twice.
 * Long repo names are hashed so the key stays within PayPal's header limit.
 */
export function requestId(ref: BondRef, op: BondOp): string {
  const key = `bond:${bondLabel(ref)}:${op}`;
  if (key.length <= 100) return key;
  return `bond:${createHash("sha256").update(key).digest("hex").slice(0, 40)}:${op}`;
}

const mockHeader = (code?: string) =>
  code ? JSON.stringify({ mock_application_codes: code }) : undefined;

export type CreatedBond = { orderId: string; status: string; approvalUrl: string };

export async function createBondOrder(
  ref: BondRef,
  urls: { returnUrl: string; cancelUrl: string },
): Promise<CreatedBond> {
  const amount = env().BOND_AMOUNT_USD;
  try {
    const { result } = await orders().createOrder({
      paypalRequestId: requestId(ref, "create"),
      prefer: "return=representation",
      body: {
        intent: CheckoutPaymentIntent.Authorize,
        purchaseUnits: [
          {
            referenceId: "bond",
            customId: bondLabel(ref),
            description: `Refundable express review bond: ${ref.owner}/${ref.repo}#${ref.pr}`.slice(0, 127),
            amount: {
              currencyCode: "USD",
              value: amount,
              breakdown: { itemTotal: { currencyCode: "USD", value: amount } },
            },
            items: [
              {
                name: "Express review bond (refundable)",
                quantity: "1",
                unitAmount: { currencyCode: "USD", value: amount },
              },
            ],
          },
        ],
        paymentSource: {
          paypal: {
            experienceContext: {
              brandName: "Fianza",
              shippingPreference: PaypalWalletContextShippingPreference.NoShipping,
              userAction: PaypalExperienceUserAction.Continue,
              returnUrl: urls.returnUrl,
              cancelUrl: urls.cancelUrl,
            },
          },
        },
      },
    });
    const approvalUrl = result.links?.find((l) => l.rel === "payer-action" || l.rel === "approve")?.href;
    if (!result.id || !approvalUrl) throw new Error("order response has no id or approval link");
    return { orderId: result.id, status: String(result.status), approvalUrl };
  } catch (err) {
    throw toPayPalError(err, "create bond order");
  }
}

export type Authorization = {
  authorizationId: string;
  status: string;
  amount: string;
  expirationTime?: string;
};

/** Runs after the operator approves in PayPal. Places the hold; nothing is charged. */
export async function authorizeBond(orderId: string, ref: BondRef, opts: Mock = {}): Promise<Authorization> {
  try {
    const { result } = await orders().authorizeOrder({
      id: orderId,
      paypalRequestId: requestId(ref, "authorize"),
      paypalMockResponse: mockHeader(opts.mock),
      prefer: "return=representation",
    });
    const auth = result.purchaseUnits?.[0]?.payments?.authorizations?.[0];
    if (!auth?.id) throw new Error("authorize response has no authorization");
    return {
      authorizationId: auth.id,
      status: String(auth.status),
      amount: auth.amount?.value ?? "",
      expirationTime: auth.expirationTime,
    };
  } catch (err) {
    throw toPayPalError(err, "authorize bond");
  }
}

/** Source of truth before every state change: a webhook alone never moves a bond. */
export async function getAuthorization(authorizationId: string): Promise<Authorization> {
  try {
    const { result } = await payments().getAuthorizedPayment({ authorizationId });
    return {
      authorizationId,
      status: String(result.status),
      amount: result.amount?.value ?? "",
      expirationTime: result.expirationTime,
    };
  } catch (err) {
    throw toPayPalError(err, "get authorization");
  }
}

/** The default outcome: releases the hold, the operator pays $0. */
export async function voidBond(authorizationId: string, ref: BondRef, opts: Mock = {}): Promise<void> {
  try {
    await payments().voidPayment({
      authorizationId,
      paypalRequestId: requestId(ref, "void"),
      paypalMockResponse: mockHeader(opts.mock),
    });
  } catch (err) {
    throw toPayPalError(err, "void bond");
  }
}

export type Capture = { captureId: string; status: string; amount: string };

/** Forfeit: only after a maintainer confirms a forfeit the policy proposed. */
export async function captureBond(authorizationId: string, ref: BondRef, opts: Mock = {}): Promise<Capture> {
  try {
    const { result } = await payments().captureAuthorizedPayment({
      authorizationId,
      paypalRequestId: requestId(ref, "capture"),
      paypalMockResponse: mockHeader(opts.mock),
      prefer: "return=representation",
      body: { finalCapture: true },
    });
    if (!result.id) throw new Error("capture response has no id");
    return { captureId: result.id, status: String(result.status), amount: result.amount?.value ?? "" };
  } catch (err) {
    throw toPayPalError(err, "capture bond");
  }
}

/** Allowed once, after the 3-day honor period. Returns a new authorization id. */
export async function reauthorizeBond(authorizationId: string, ref: BondRef): Promise<Authorization> {
  try {
    const { result } = await payments().reauthorizePayment({
      authorizationId,
      paypalRequestId: requestId(ref, "reauthorize"),
      prefer: "return=representation",
    });
    if (!result.id) throw new Error("reauthorize response has no id");
    return {
      authorizationId: result.id,
      status: String(result.status),
      amount: result.amount?.value ?? "",
      expirationTime: result.expirationTime,
    };
  } catch (err) {
    throw toPayPalError(err, "reauthorize bond");
  }
}

/** Appeals: a won appeal refunds the full bond. */
export async function refundBond(captureId: string, ref: BondRef, opts: Mock = {}): Promise<{ refundId: string; status: string }> {
  try {
    const { result } = await payments().refundCapturedPayment({
      captureId,
      paypalRequestId: requestId(ref, "refund"),
      paypalMockResponse: mockHeader(opts.mock),
      prefer: "return=representation",
    });
    if (!result.id) throw new Error("refund response has no id");
    return { refundId: result.id, status: String(result.status) };
  } catch (err) {
    throw toPayPalError(err, "refund bond");
  }
}
