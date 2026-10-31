import { describe, expect, it } from "vitest";
import { appConfig } from "@/lib/env";

describe("appConfig", () => {
  it("uses Render's public URL when APP_BASE_URL is unset, and an explicit one when set", () => {
    expect(appConfig({ RENDER_EXTERNAL_URL: "https://fianza.onrender.com" }).APP_BASE_URL).toBe("https://fianza.onrender.com");
    expect(appConfig({ APP_BASE_URL: "https://fianza.example", RENDER_EXTERNAL_URL: "https://x.onrender.com" }).APP_BASE_URL).toBe("https://fianza.example");
    expect(appConfig({ APP_BASE_URL: "" }).APP_BASE_URL).toBe("http://localhost:3000");
  });

  it("rejects an amount that is not a two-decimal string", () => {
    expect(() => appConfig({ BOND_AMOUNT_USD: "5" })).toThrow();
    expect(appConfig({}).BOND_AMOUNT_USD).toBe("5.00");
  });
});
