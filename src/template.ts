/*
FILE:      src/template.ts
CREATED:   2026-11-16 01:50 +03
TASK:      int-clerk int-neon
AUTHOR:    M Alhassoun
WHAT:      synced from kwtsms-better-auth src/template.ts 2026-11-16 (copy, do not edit here; change it there and re-sync)
           OTP SMS text in English (ASCII, 1 part of 160) and Arabic (UCS-2, 1 part of 70).
WHY:       Short fixed texts keep every code in one SMS part.
*/

import { cleanMessage } from "kwtsms";

export type Lang = "en" | "ar";

/** Keep the app name short and ASCII-safe so the message stays one part. */
export function safeAppName(name: string): string {
  return name.replace(/[^\x20-\x7e]/g, "").trim().slice(0, 16) || "App";
}

export function buildOtpMessage(lang: Lang, appName: string, code: string): string {
  const app = safeAppName(appName);
  const text =
    lang === "ar"
      ? `${app}: رمز التحقق ${code}. صالح 5 دقائق. لا تشاركه.`
      : `${app}: your code is ${code}. Valid 5 min. Do not share it.`;
  return cleanMessage(text);
}
