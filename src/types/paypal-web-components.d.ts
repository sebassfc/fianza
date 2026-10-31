import type { DetailedHTMLProps, HTMLAttributes } from "react";

// JS SDK v6 web components and the slice of window.paypal that Fianza uses.
declare module "react" {
  namespace JSX {
    interface IntrinsicElements {
      "paypal-button": DetailedHTMLProps<HTMLAttributes<HTMLElement>, HTMLElement> & { type?: "pay" | "checkout" | "buynow" };
    }
  }
}

declare global {
  interface PayPalOneTimePaymentSession {
    start(options: { presentationMode: "auto" | "popup" | "redirect" | "modal" }, order: Promise<{ orderId: string }>): Promise<void>;
  }
  interface PayPalSdkInstance {
    createPayPalOneTimePaymentSession(callbacks: {
      onApprove: (data: { orderId: string }) => void | Promise<void>;
      onCancel?: () => void;
      onError?: (error: unknown) => void;
    }): PayPalOneTimePaymentSession;
  }
  interface Window {
    paypal?: {
      createInstance(options: { clientId: string; components: string[]; pageType: string }): Promise<PayPalSdkInstance>;
    };
  }
}
