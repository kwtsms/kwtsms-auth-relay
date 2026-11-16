/*
FILE:      src/wso2.ts
CREATED:   2026-11-16 22:00 +03
TASK:      job 63, int-grafana (Boss Telegram 975: Twilio gap list, WSO2 and Authgear recipes)
AUTHOR:    M Alhassoun
WHAT:      WSO2 Identity Server (and Asgardeo) custom SMS provider handler: WSO2 posts the recipient and the finished
           SMS text, the handler sends it through kwtSMS and answers 200, or a non-2xx code so WSO2 reports the failure.
WHY:       WSO2 fills {{mobile}} with the number as stored (often +965...), and kwtSMS refuses a "+" (ERR025), so the
           custom provider cannot post to the kwtSMS API directly. The relay also keeps the API password out of
           WSO2 and adds the per-number limits.
USAGE:     import { createWso2Handler } from "kwtsms-auth-relay/wso2";
           export const POST = createWso2Handler({ kwtsms: { username, password, senderId, live: true } });
           WSO2 console, Notification Channels, SMS Provider, Custom: Payload Template {"to": {{mobile}}, "content": {{body}}},
           Content Type JSON, HTTP Method POST, Headers "authorization: <secret>".
DEPENDS:   ./relay (shared send path). Contract: is.docs.wso2.com 7.2.0 configure-sms-provider (read 2026-11-16) and
           wso2-extensions/identity-local-auth-smsotp CustomProviderTest (JSON mode inserts quoted, escaped strings).
*/

import { createRelay, json, readEnv, MAX_BODY_BYTES, TAG, type RelayOptions } from "./relay";

export type { RelayOptions, Store, SmsClient, KwtsmsConfig } from "./relay";

export interface Wso2HandlerOptions extends RelayOptions {
  /** The whole value of the header WSO2 sends (Headers field). Default env WSO2_SMS_SECRET. Min 16 characters. */
  secret?: string;
  /** Header name. Default "authorization". */
  authHeader?: string;
}

const MIN_SECRET = 16;

function sameText(a: string, b: string): boolean {
  const x = new TextEncoder().encode(a);
  const y = new TextEncoder().encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

export function createWso2Handler(options: Wso2HandlerOptions): (req: Request) => Promise<Response> {
  const secret = options.secret ?? readEnv("WSO2_SMS_SECRET");
  if (!secret) throw new Error(`${TAG} secret (or env WSO2_SMS_SECRET) is required`);
  if (secret.length < MIN_SECRET) throw new Error(`${TAG} the WSO2 header secret must be at least ${MIN_SECRET} characters`);
  const header = (options.authHeader ?? "authorization").toLowerCase();
  // WSO2 waits 20 s by default; no resend cooldown (the user asks for a new code on purpose), 10 per number per hour
  const relay = createRelay({ cooldownSeconds: 0, maxPerHour: 10, ...options });

  return async function wso2Handler(req: Request): Promise<Response> {
    if (req.method !== "POST" && req.method !== "PUT") return json(405, { status: "method_not_allowed" });
    if (!sameText(req.headers.get(header) ?? "", secret)) return json(401, { status: "unauthorized" });
    const len = Number(req.headers.get("content-length") ?? 0);
    if (len > MAX_BODY_BYTES) return json(413, { status: "too_large" });
    const raw = await req.text();
    if (raw.length > MAX_BODY_BYTES) return json(413, { status: "too_large" });
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return json(400, { status: "bad_json", hint: 'Content Type JSON, Payload Template {"to": {{mobile}}, "content": {{body}}}' });
    }
    const phone = String(body.to ?? body.mobile ?? "");
    const text = String(body.content ?? body.body ?? "");
    // WSO2 sends no event id; the same number and text inside the dedupe window is a retry. The text holds the
    // code, so only its hash goes into the store key.
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
    const hash = Array.from(new Uint8Array(digest).slice(0, 12), (b) => b.toString(16).padStart(2, "0")).join("");
    const result = await relay.send({ phone, message: text, eventKey: `wso2:${phone.replace(/\D/g, "")}:${hash}` });
    if (result.status === "sent" || result.status === "duplicate") {
      return json(200, { status: result.status, test: !relay.live });
    }
    if (result.status === "refused") return json(422, { status: "refused", reason: result.reason });
    if (result.status === "failed") return json(502, { status: "failed", code: result.code ?? "UNKNOWN" });
    return json(503, { status: "not_sent" });
  };
}
