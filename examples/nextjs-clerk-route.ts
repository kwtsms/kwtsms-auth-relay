/*
FILE:      examples/nextjs-clerk-route.ts
CREATED:   2026-11-16 01:52 +03
TASK:      int-clerk int-neon
AUTHOR:    M Alhassoun
WHAT:      Next.js App Router route handler for Clerk's sms.created webhook. Save as app/api/clerk-sms/route.ts.
WHY:       Shows the whole setup: the handler is already (Request) => Response, so it is exported as POST.
*/
import { createClerkHandler } from "kwtsms-auth-relay/clerk";

export const POST = createClerkHandler({
  signingSecret: process.env.CLERK_WEBHOOK_SIGNING_SECRET, // "whsec_..."
  kwtsms: {
    username: process.env.KWTSMS_USERNAME,
    password: process.env.KWTSMS_PASSWORD,
    senderId: process.env.KWTSMS_SENDER_ID, // your own Sender ID, needed for live
    live: process.env.KWTSMS_LIVE === "1",
  },
  appName: "Shop",
  // Optional: replace Clerk's English text, for example with Arabic.
  // message: "{app}: رمز التحقق {otp_code}. لا تشاركه.",
});
