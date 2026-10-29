import { z } from "zod";

// Fianza only ever talks to the PayPal sandbox. A production value is a config error, not a mode.
const schema = z.object({
  PAYPAL_CLIENT_ID: z.string().min(10),
  PAYPAL_CLIENT_SECRET: z.string().min(10),
  PAYPAL_ENV: z.literal("sandbox").default("sandbox"),
  APP_BASE_URL: z.url().default("http://localhost:3000"),
  BOND_AMOUNT_USD: z
    .string()
    .regex(/^\d+\.\d{2}$/, "use a decimal string like 5.00")
    .default("5.00"),
});

export type Env = z.infer<typeof schema>;

let cached: Env | undefined;

export function env(): Env {
  if (cached) return cached;
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const fields = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
    throw new Error(`Invalid environment. Copy .env.example to .env.local and fill it in.\n  ${fields.join("\n  ")}`);
  }
  cached = parsed.data;
  return cached;
}
