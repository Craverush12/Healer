import { Markup } from "telegraf";
import type { Env } from "../config/env";
import type { UserState } from "../db/usersRepo";

export const MENU_LABELS = {
  subscribe: "Subscribe",
  browse: "Browse Library",
  startHere: "Start Here",
  manage: "Manage Subscription",
  cancel: "Cancel Subscription",
  help: "Help"
} as const;

export function buildMainMenuKeyboard(state: UserState, env?: Env, audio?: any) {
  const paymentsEnabled = env?.ENABLE_PAYMENTS ?? false;

  if (state === "ACTIVE_SUBSCRIBER" || state === "CANCEL_PENDING") {
    const buttons: any[] = [];

    if (audio) {
      const recommendedCategory = audio.manifest.categories.find((c: any) => c.recommended);
      const recommendedItem = audio.manifest.items.find((i: any) => i.recommended);
      if (recommendedCategory || recommendedItem) {
        buttons.push([Markup.button.callback(MENU_LABELS.startHere, "menu:start-here")]);
      }
    }

    buttons.push([Markup.button.callback(MENU_LABELS.browse, "menu:browse")]);

    if (paymentsEnabled) {
      buttons.push([
        Markup.button.callback(MENU_LABELS.manage, "menu:manage"),
        Markup.button.callback(MENU_LABELS.cancel, "menu:cancel")
      ]);
    }

    buttons.push([Markup.button.callback(MENU_LABELS.help, "menu:help")]);

    return Markup.inlineKeyboard(buttons);
  }

  return Markup.inlineKeyboard([
    [Markup.button.callback(MENU_LABELS.subscribe, "menu:subscribe")],
    [Markup.button.callback(MENU_LABELS.help, "menu:help")]
  ]);
}

export function renderHelpText() {
  return [
    "Peace of Mind Bot - Help",
    "",
    "Commands:",
    "/start - Show main menu",
    "/browse - Browse audio library (subscribers only)",
    "/subscribe - Subscribe to access content",
    "/help - Show this help message",
    "",
    "Tips:",
    "- Use Start Here for recommended content",
    "- Browse by category to find what you need",
    "",
    "Need help?",
    "Email: support@oscarvore.com"
  ].join("\n");
}

