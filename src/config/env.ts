import { z } from "zod";

const EnvSchema = z.object({
  BOT_TOKEN: z.string().min(1),
  PORT: z.coerce.number().int().positive().default(3000),
  DB_PATH: z.string().min(1).default("./data/bot.sqlite"),

  // Feature flag: set to "true" to enable payment/subscription features
  ENABLE_PAYMENTS: z
    .string()
    .optional()
    .transform((val) => {
      if (!val) return false;
      const lower = val.toLowerCase().trim();
      return lower === "true" || lower === "1" || lower === "yes";
    })
    .default(() => false),

  // Payment-related (required only if ENABLE_PAYMENTS=true)
  GHL_CHECKOUT_URL_TEMPLATE: z.string().optional(),
  MANAGE_SUBSCRIPTION_URL: z.string().optional(),
  RETENTION_COUPON_CODE: z.string().optional(),

  // Webhook auth (prefer signature). If missing, WEBHOOK_TOKEN must be set.
  // Required only if ENABLE_PAYMENTS=true
  GHL_WEBHOOK_SECRET: z.string().optional(),
  WEBHOOK_TOKEN: z.string().optional(),

  // Optional read-only contact lookup fallback.
  GHL_API_BASE_URL: z.string().default("https://services.leadconnectorhq.com"),
  GHL_API_KEY: z.string().optional(),

  // Optional admin list (comma-separated Telegram numeric user ids).
  // Used for admin-only ingest commands that cache Telegram file_ids.
  ADMIN_TELEGRAM_USER_IDS: z
    .string()
    .optional()
    .transform((val) => {
      if (!val) return [];
      return val
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
        .map((s) => Number(s))
        .filter((n) => Number.isFinite(n));
    })
    .default(() => []),

  // Resync cooldown for /start and /resync (minutes).
  RESYNC_COOLDOWN_MINUTES: z.coerce.number().int().min(0).default(10)
});

export type Env = z.infer<typeof EnvSchema>;

export function loadEnv(raw: NodeJS.ProcessEnv): Env {
  const parsed = EnvSchema.safeParse(raw);
  if (!parsed.success) {
    // eslint-disable-next-line no-console
    console.error(parsed.error.flatten().fieldErrors);
    throw new Error("Invalid environment variables.");
  }

  const env = parsed.data;

  // Validate payment-related config only if payments are enabled
  if (env.ENABLE_PAYMENTS) {
    if (!env.GHL_CHECKOUT_URL_TEMPLATE || !env.MANAGE_SUBSCRIPTION_URL || !env.RETENTION_COUPON_CODE) {
      throw new Error(
        "Payment features enabled but missing required config: GHL_CHECKOUT_URL_TEMPLATE, MANAGE_SUBSCRIPTION_URL, RETENTION_COUPON_CODE"
      );
    }

    const hasSig = !!env.GHL_WEBHOOK_SECRET && env.GHL_WEBHOOK_SECRET.trim().length > 0;
    const hasToken = !!env.WEBHOOK_TOKEN && env.WEBHOOK_TOKEN.trim().length > 0;
    if (!hasSig && !hasToken) {
      throw new Error("Webhook auth not configured: set GHL_WEBHOOK_SECRET or WEBHOOK_TOKEN.");
    }

    const placeholder = "{telegram_user_id}";
    if (!env.GHL_CHECKOUT_URL_TEMPLATE.includes(placeholder)) {
      throw new Error(`GHL_CHECKOUT_URL_TEMPLATE must include placeholder ${placeholder}`);
    }
    if (env.GHL_CHECKOUT_URL_TEMPLATE.includes("{token}")) {
      throw new Error("GHL_CHECKOUT_URL_TEMPLATE should no longer use {token}; use {telegram_user_id} instead.");
    }

    const sampleUrl = env.GHL_CHECKOUT_URL_TEMPLATE.replace(placeholder, "123456789");
    try {
      // eslint-disable-next-line no-new
      new URL(sampleUrl);
    } catch {
      throw new Error("GHL_CHECKOUT_URL_TEMPLATE did not produce a valid URL after substituting {telegram_user_id}.");
    }
  }

  return env;
}
