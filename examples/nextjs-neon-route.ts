/*
FILE:      examples/nextjs-neon-route.ts
CREATED:   2026-11-16 01:52 +03
TASK:      int-clerk int-neon
AUTHOR:    M Alhassoun
WHAT:      Next.js App Router route handler for Neon Auth's send.otp webhook. Save as app/api/neon-otp/route.ts.
WHY:       Shows the whole setup for Neon Auth; the handler verifies the Ed25519 signature before it sends.
*/
import { createNeonHandler } from "kwtsms-auth-relay/neon";

export const POST = createNeonHandler({
  neonAuthUrl: process.env.NEON_AUTH_URL!,
  kwtsms: {
    username: process.env.KWTSMS_USERNAME,
    password: process.env.KWTSMS_PASSWORD,
    senderId: process.env.KWTSMS_SENDER_ID,
    live: process.env.KWTSMS_LIVE === "1",
  },
  appName: "Shop",
  lang: "ar", // "en" (default) or "ar"
});
