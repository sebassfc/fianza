"use client";

import { useEffect, useRef, useState } from "react";

const SDK_URL = "https://www.sandbox.paypal.com/web-sdk/v6/core";

type Ref = { owner: string; repo: string; pr: number; headSha: string };
type Status = "loading" | "ready" | "working" | "held" | "cancelled" | "error";

const MESSAGES: Record<Status, string> = {
  loading: "Loading PayPal… · Cargando PayPal…",
  ready: "",
  working: "Placing the hold… · Colocando la retención…",
  held: "Bond held. Nothing was charged. · Fianza retenida. No se cobró nada.",
  cancelled: "You closed PayPal. No hold was placed. · Cerraste PayPal. No se retuvo nada.",
  error: "PayPal could not complete this. No money moved. · PayPal no pudo completarlo. No se movió dinero.",
};

function loadSdk(): Promise<void> {
  if (window.paypal) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(`script[src="${SDK_URL}"]`);
    const script = existing ?? Object.assign(document.createElement("script"), { src: SDK_URL, async: true });
    script.addEventListener("load", () => resolve(), { once: true });
    script.addEventListener("error", () => reject(new Error("PayPal SDK failed to load")), { once: true });
    if (!existing) document.head.appendChild(script);
  });
}

async function postJson(url: string, body: unknown) {
  const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const data = (await res.json().catch(() => ({}))) as { error?: string; orderId?: string };
  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
  return data;
}

/** JS SDK v6 PayPal button. The order (intent AUTHORIZE) is created on click; approval places a refundable hold. */
export function BondButton({ clientId, bondRef }: { clientId: string; bondRef: Ref }) {
  const [status, setStatus] = useState<Status>("loading");
  const [detail, setDetail] = useState("");
  const buttonRef = useRef<HTMLElement>(null);

  useEffect(() => {
    let active = true;
    const fail = (err: unknown) => {
      if (!active) return;
      setStatus("error");
      setDetail(err instanceof Error ? err.message : String(err));
    };

    (async () => {
      await loadSdk();
      const sdk = await window.paypal!.createInstance({ clientId, components: ["paypal-payments"], pageType: "checkout" });
      const session = sdk.createPayPalOneTimePaymentSession({
        onApprove: async ({ orderId }) => {
          setStatus("working");
          try {
            await postJson("/api/bonds/authorize", { ...bondRef, orderId });
            if (active) setStatus("held");
          } catch (err) {
            fail(err);
          }
        },
        onCancel: () => active && setStatus("cancelled"),
        onError: fail,
      });
      const button = buttonRef.current;
      if (!button || !active) return;
      button.addEventListener("click", () => {
        setDetail("");
        // Pass the promise without awaiting it: awaiting first makes browsers block the PayPal popup.
        const order = postJson("/api/bonds/order", bondRef).then((d) => ({ orderId: d.orderId! }));
        session.start({ presentationMode: "auto" }, order).catch(fail);
      });
      button.removeAttribute("hidden");
      setStatus("ready");
    })().catch(fail);

    return () => {
      active = false;
    };
  }, [clientId, bondRef]);

  return (
    <div className="flex flex-col gap-3">
      {status !== "held" && <paypal-button ref={buttonRef} type="pay" hidden />}
      <p role="status" aria-live="polite" className={status === "error" ? "text-red-700 dark:text-red-400" : "text-zinc-700 dark:text-zinc-300"}>
        {MESSAGES[status]}
        {detail && <span className="block font-mono text-sm">{detail}</span>}
      </p>
    </div>
  );
}
