/*
FILE:      examples/express.ts
CREATED:   2026-11-16 01:52 +03
TASK:      int-clerk int-neon
AUTHOR:    M Alhassoun
WHAT:      Express server with both webhooks behind toExpress().
WHY:       Signatures cover the raw bytes, so the webhook routes use express.raw() and are mounted before any express.json().
*/
import express from "express";
import { toExpress } from "kwtsms-auth-relay";
import { createClerkHandler } from "kwtsms-auth-relay/clerk";
import { createNeonHandler } from "kwtsms-auth-relay/neon";

const kwtsms = {
  username: process.env.KWTSMS_USERNAME,
  password: process.env.KWTSMS_PASSWORD,
  senderId: process.env.KWTSMS_SENDER_ID,
  live: process.env.KWTSMS_LIVE === "1",
};

const app = express();
app.post("/webhooks/clerk", express.raw({ type: "*/*" }), toExpress(createClerkHandler({ kwtsms, appName: "Shop" })));
app.post("/webhooks/neon", express.raw({ type: "*/*" }), toExpress(createNeonHandler({ kwtsms, neonAuthUrl: process.env.NEON_AUTH_URL!, appName: "Shop" })));
app.use(express.json()); // everything else, after the webhooks

app.listen(3000);
