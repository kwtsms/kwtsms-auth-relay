/*
FILE:      src/okta.ts
CREATED:   2026-11-16 20:45 +03
TASK:      job 60, int-okta (Boss Telegram 975: Okta, approved with the Twilio gap list)
AUTHOR:    M Alhassoun
WHAT:      Okta Telephony Inline Hook handler: Okta posts the user's phone number and the one-time code, the handler
           sends the SMS through kwtSMS and answers with the com.okta.telephony.action command Okta expects.
WHY:       Okta orgs in Kuwait can send their sign-in codes from their own kwtSMS account and Sender ID. Any answer
           other than SUCCESSFUL (an error object) makes Okta fall back to its own telephony providers, so a user is
           never locked out: test mode, refusals and kwtSMS errors all answer with an error object.
USAGE:     import { createOktaHandler } from "kwtsms-auth-relay/okta";
           export const POST = createOktaHandler({ kwtsms: { username, password, senderId, live: true }, appName: "Acme" });
DEPENDS:   ./relay (shared send path), ./template (one-part OTP text). Contract: developer.okta.com telephony inline
           hook guide and the Okta SDK models TelephonyRequest / TelephonyResponse (read 2026-11-16).
*/

import { createRelay, fillTemplate, json, readEnv, MAX_BODY_BYTES, TAG, type RelayOptions, type RelayResult } from "./relay";
import { buildOtpMessage, type Lang } from "./template";

export type { RelayOptions, Store, SmsClient, KwtsmsConfig } from "./relay";

/** The part of Okta's telephony request this handler reads. */
export interface OktaTelephonyRequest {
  eventType?: string;
  requestType?: string;
  data?: {
    messageProfile?: {
      phoneNumber?: string;
      otpCode?: string;
      deliveryChannel?: string;
      locale?: string;
      msgTemplate?: string;
      otpExpires?: string;
    };
    userProfile?: Record<string, unknown>;
  };
}

export interface OktaHandlerOptions extends RelayOptions {
  /** The Authentication secret set on the hook in Okta (the whole header value). Default env OKTA_HOOK_SECRET. Min 16 characters. */
  secret?: string;
  /** The Authentication field set on the hook in Okta. Default "authorization". */
  authHeader?: string;
  /** Your own text: a string with {code} and {app}, or a function. Default: built-in one-part text. */
  message?: string | ((req: OktaTelephonyRequest) => string);
  /** Language of the built-in text. Default: Arabic when the Okta user's locale starts with "ar", else English. */
  lang?: Lang | ((req: OktaTelephonyRequest) => Lang);
  /**
   * Default false: in test mode the handler answers Okta with an error, so Okta sends the code itself and nobody is
   * locked out. true = answer SUCCESSFUL in test mode (only for the Preview tab in Okta: the code is NOT delivered).
   */
  reportTestAsSuccess?: boolean;
}

const MIN_SECRET = 16;

function sameText(a: string, b: string): boolean {
  const x = new TextEncoder().encode(a);
  const y = new TextEncoder().encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

function success(transactionId: string | undefined, metadata: string): Response {
  const value: Record<string, string> = { status: "SUCCESSFUL", provider: "kwtSMS", transactionMetadata: metadata };
  if (transactionId) value.transactionId = transactionId;
  return json(200, { commands: [{ type: "com.okta.telephony.action", value: [value] }] });
}

/** Error object: Okta treats the call as failed and falls back to its own providers. */
function failure(summary: string): Response {
  return json(200, { error: { errorSummary: summary } });
}

function summarize(r: RelayResult): string {
  if (r.status === "refused") return `kwtSMS relay refused: ${r.reason}`;
  if (r.status === "failed") return `kwtSMS error: ${r.code ?? "UNKNOWN"}`;
  if (r.status === "not_sent") return "kwtSMS not reachable";
  return "kwtSMS: not sent";
}

export function createOktaHandler(options: OktaHandlerOptions): (req: Request) => Promise<Response> {
  const secret = options.secret ?? readEnv("OKTA_HOOK_SECRET");
  if (!secret) throw new Error(`${TAG} secret (or env OKTA_HOOK_SECRET) is required`);
  if (secret.length < MIN_SECRET) throw new Error(`${TAG} the Okta hook secret must be at least ${MIN_SECRET} characters`);
  const header = (options.authHeader ?? "authorization").toLowerCase();
  // Okta waits 3 s, so answer before that; no resend cooldown (a refusal only hands the send back to Okta), 10 per number per hour
  const relay = createRelay({ cooldownSeconds: 0, maxPerHour: 10, sendTimeoutMs: 2500, ...options });

  function buildText(r: OktaTelephonyRequest, code: string): string {
    const m = options.message;
    if (typeof m === "function") return m(r);
    if (typeof m === "string") return fillTemplate(m, { code, app: relay.appName });
    const l =
      typeof options.lang === "function"
        ? options.lang(r)
        : (options.lang ?? (/^ar/i.test(String(r.data?.messageProfile?.locale ?? "")) ? "ar" : "en"));
    return buildOtpMessage(l === "ar" ? "ar" : "en", relay.appName, code);
  }

  return async function oktaHandler(req: Request): Promise<Response> {
    if (req.method !== "POST") return json(405, { status: "method_not_allowed" });
    if (!sameText(req.headers.get(header) ?? "", secret)) return json(401, { status: "unauthorized" });
    const len = Number(req.headers.get("content-length") ?? 0);
    if (len > MAX_BODY_BYTES) return json(413, { status: "too_large" });
    const raw = await req.text();
    if (raw.length > MAX_BODY_BYTES) return json(413, { status: "too_large" });
    let body: OktaTelephonyRequest;
    try {
      body = JSON.parse(raw) as OktaTelephonyRequest;
    } catch {
      return json(400, { status: "bad_json" });
    }
    const mp = body.data?.messageProfile ?? {};
    if (!/sms/i.test(String(mp.deliveryChannel ?? ""))) return failure("kwtSMS sends SMS only, not voice calls");
    const phone = String(mp.phoneNumber ?? "");
    const code = String(mp.otpCode ?? "");
    if (!code) return failure("kwtSMS relay: no otpCode in the request");

    let text: string;
    try {
      text = buildText(body, code);
    } catch {
      console.error(`${TAG} message option threw`);
      return failure("kwtSMS relay: message builder failed");
    }
    // Okta sends no event id; a new code means a new request, so phone + code identifies a retry
    const result = await relay.send({ phone, message: text, eventKey: `okta:${phone.replace(/\D/g, "")}:${code}` });
    if (result.status !== "sent" && result.status !== "duplicate") return failure(summarize(result));
    if (!relay.live && !options.reportTestAsSuccess) {
      return failure("kwtSMS test mode: queued, not delivered (set kwtsms.live: true)");
    }
    const id = result.status === "sent" ? result.msgId : undefined;
    return success(id, (relay.live ? "live" : "test mode, not delivered") + (id ? "" : ", duplicate"));
  };
}
