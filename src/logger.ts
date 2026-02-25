import pino from "pino";

const REDACT_PATHS = [
  "authorization",
  "token",
  "secret",
  "password",
  "apiKey",
  "api_key",
  "BOT_TOKEN",
  "GHL_API_KEY",
  "GHL_WEBHOOK_SECRET",
  "WEBHOOK_TOKEN",
  "sampleCheckoutUrl",
  "req.query.token",
  "req.headers.authorization",
  "headers.authorization",
  "customData.token",
  "customData.checkoutToken",
  "payload.token",
  "payload.checkoutToken"
];

export const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  base: undefined,
  redact: {
    paths: REDACT_PATHS,
    censor: "[redacted]"
  }
});

