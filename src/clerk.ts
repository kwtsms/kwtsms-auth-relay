/*
FILE:      src/clerk.ts
CREATED:   2026-11-16 01:52 +03
TASK:      int-clerk int-neon
AUTHOR:    M Alhassoun
WHAT:      createClerkHandler(): Web-standard (Request) => Response handler for Clerk's sms.created webhook, sending the SMS through kwtSMS.
WHY:       With "Delivered by Clerk" off, Clerk expects the app to send the SMS. The Svix signature is checked first; nothing is sent for an unsigned or stale request.
*/

import { Webhook } from "svix";
import { fillTemplate, createRelay, json, readEnv, toResponse, MAX_BODY_BYTES, TAG, type RelayOptions } from "./relay";

export type { RelayOptions, Store, SmsClient, KwtsmsConfig } from "./relay";

/** The fields of Clerk's SMS message that this handler reads. */
export interface ClerkSmsData {
  to_phone_number?: string;
  message?: string;
  delivered_by_clerk?: boolean;
  slug?: string;
  user_id?: string;
  status?: string;
  data?: Record<string, unknown>;
}

export interface ClerkHandlerOptions extends RelayOptions {
  /** "whsec_..." from the Clerk webhook endpoint. Default: env CLERK_WEBHOOK_SIGNING_SECRET. */
  signingSecret?: string;
  /**
   * Replaces Clerk's own text (for example to send Arabic). A string may use {message}, {app} and any key
   * of Clerk's `data` such as {otp_code}; a function gets the Clerk SMS data and returns the text.
   */
  message?: string | ((sms: ClerkSmsData) => string);
}

export function createClerkHandler(options: ClerkHandlerOptions): (req: Request) => Promise<Response> {
  const secret = options.signingSecret ?? readEnv("CLERK_WEBHOOK_SIGNING_SECRET");
  if (!secret) throw new Error(`${TAG} signingSecret (or env CLERK_WEBHOOK_SIGNING_SECRET) is required`);
  const wh = new Webhook(secret);
  const relay = createRelay(options);

  function buildText(sms: ClerkSmsData): string {
    const m = options.message;
    if (typeof m === "function") return m(sms);
    const original = String(sms.message ?? "");
    if (typeof m === "string") return fillTemplate(m, { ...(sms.data ?? {}), message: original, app: relay.appName });
    return original;
  }

  return async function clerkHandler(req: Request): Promise<Response> {
    if (req.method !== "POST") return json(405, { status: "method_not_allowed" });
    const len = Number(req.headers.get("content-length") ?? 0);
    if (len > MAX_BODY_BYTES) return json(413, { status: "too_large" });
    const raw = await req.text();
    if (raw.length > MAX_BODY_BYTES) return json(413, { status: "too_large" });

    const svixId = req.headers.get("svix-id") ?? "";
    let event: { type?: string; data?: ClerkSmsData };
    try {
      // Svix checks the signature and the 5 minute timestamp tolerance
      wh.verify(raw, {
        "svix-id": svixId,
        "svix-timestamp": req.headers.get("svix-timestamp") ?? "",
        "svix-signature": req.headers.get("svix-signature") ?? "",
      });
      event = JSON.parse(raw) as { type?: string; data?: ClerkSmsData };
    } catch {
      return json(401, { status: "bad_signature" });
    }

    if (event.type !== "sms.created") return json(200, { status: "skipped", reason: "event_type" });
    const sms = event.data ?? {};
    if (sms.delivered_by_clerk === true) return json(200, { status: "skipped", reason: "delivered_by_clerk" });

    let text: string;
    try {
      text = buildText(sms);
    } catch {
      console.error(`${TAG} message option threw`);
      return json(200, { status: "failed", code: "MESSAGE_BUILDER" });
    }
    const result = await relay.send({ phone: String(sms.to_phone_number ?? ""), message: text, eventKey: `clerk:${svixId}` });
    return toResponse(result);
  };
}
