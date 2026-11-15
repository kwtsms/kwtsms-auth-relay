/*
FILE:      src/neon.ts
CREATED:   2026-11-16 01:52 +03
TASK:      int-clerk int-neon
AUTHOR:    M Alhassoun
WHAT:      createNeonHandler(): Web-standard (Request) => Response handler for Neon Auth's send.otp webhook, sending the code through kwtSMS.
WHY:       Neon Auth hands the OTP to the app to deliver. The Ed25519 detached JWS is verified against the project's JWKS before anything is sent; the key set is cached and refetched at most once per 10 minutes.
*/

import { createRelay, fillTemplate, json, toResponse, MAX_BODY_BYTES, TAG, type RelayOptions } from "./relay";
import { buildOtpMessage, type Lang } from "./template";

export type { RelayOptions, Store, SmsClient, KwtsmsConfig } from "./relay";
export type { Lang } from "./template";

/** The fields of Neon Auth's send.otp payload that this handler reads. */
export interface NeonOtpPayload {
  event_type?: string;
  event_id?: string;
  event_data?: { otp_code?: string; otp_type?: string; expires_at?: string | number; delivery_preference?: string };
  user?: { phone_number?: string };
}

export interface NeonHandlerOptions extends RelayOptions {
  /** Your Neon Auth URL; the keys are read from <neonAuthUrl>/.well-known/jwks.json. */
  neonAuthUrl: string;
  /** Default "en". */
  lang?: Lang | ((payload: NeonOtpPayload) => Lang);
  /**
   * Replaces the built-in text. A string may use {code}, {app} and {otp_type}; a function gets the payload.
   * The built-in text says "Valid 5 min".
   */
  message?: string | ((payload: NeonOtpPayload) => string);
  /** Replaces global fetch for the JWKS request (tests, proxies). */
  fetch?: typeof fetch;
}

const MAX_AGE_MS = 5 * 60 * 1000;
const JWKS_REFETCH_MS = 10 * 60 * 1000;
const JWKS_RETRY_MS = 5 * 1000;

function b64url(input: Uint8Array | string): string {
  const bytes = typeof input === "string" ? new TextEncoder().encode(input) : input;
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromB64url(s: string): Uint8Array {
  const pad = s.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(s.length / 4) * 4, "=");
  const bin = atob(pad);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

/** Timestamp as seconds, milliseconds or an ISO string; returns epoch ms or NaN. */
function timestampMs(raw: string): number {
  if (/^\d+(\.\d+)?$/.test(raw)) {
    const n = Number(raw);
    return n < 1e11 ? n * 1000 : n;
  }
  return Date.parse(raw);
}

export function createNeonHandler(options: NeonHandlerOptions): (req: Request) => Promise<Response> {
  if (!options.neonAuthUrl) throw new Error(`${TAG} neonAuthUrl is required`);
  const jwksUrl = `${options.neonAuthUrl.replace(/\/+$/, "")}/.well-known/jwks.json`;
  const doFetch = options.fetch ?? globalThis.fetch;
  const relay = createRelay(options);

  const keys = new Map<string, CryptoKey>();
  let lastFetchOk = 0;
  let lastAttempt = 0;
  let inflight: Promise<boolean> | undefined;

  async function loadKeys(): Promise<boolean> {
    lastAttempt = Date.now();
    try {
      const res = await doFetch(jwksUrl, { headers: { accept: "application/json" } });
      if (!res.ok) return false;
      const body = (await res.json()) as { keys?: (JsonWebKey & { kid?: string })[] };
      const next = new Map<string, CryptoKey>();
      for (const jwk of body.keys ?? []) {
        if (!jwk.kid || jwk.kty !== "OKP" || jwk.crv !== "Ed25519") continue;
        try {
          next.set(jwk.kid, await crypto.subtle.importKey("jwk", jwk, "Ed25519", false, ["verify"]));
        } catch {
          // skip a key that does not import
        }
      }
      keys.clear();
      for (const [k, v] of next) keys.set(k, v);
      lastFetchOk = Date.now();
      return true;
    } catch {
      return false;
    }
  }

  /** Known kid: cached key. Unknown kid: refetch, but at most once per 10 minutes. */
  async function keyFor(kid: string): Promise<{ key?: CryptoKey; unavailable?: boolean }> {
    const hit = keys.get(kid);
    if (hit) return { key: hit };
    const now = Date.now();
    const mayFetch = now - lastFetchOk >= JWKS_REFETCH_MS && now - lastAttempt >= JWKS_RETRY_MS;
    if (inflight || mayFetch) {
      inflight ??= loadKeys().finally(() => {
        inflight = undefined;
      });
      const ok = await inflight;
      const key = keys.get(kid);
      if (key) return { key };
      if (!ok && keys.size === 0) return { unavailable: true };
    }
    return {};
  }

  async function verify(req: Request, raw: string): Promise<"ok" | "bad" | "unavailable"> {
    const sig = req.headers.get("x-neon-signature") ?? "";
    const kid = req.headers.get("x-neon-signature-kid") ?? "";
    const ts = req.headers.get("x-neon-timestamp") ?? "";
    const parts = sig.split(".");
    if (parts.length !== 3 || parts[1] !== "" || !parts[0] || !parts[2] || !kid || !ts) return "bad";
    const age = Math.abs(Date.now() - timestampMs(ts));
    if (!(age <= MAX_AGE_MS)) return "bad"; // NaN fails too
    const { key, unavailable } = await keyFor(kid);
    if (unavailable) return "unavailable";
    if (!key) return "bad";
    try {
      const payloadB64 = b64url(raw);
      const signaturePayloadB64 = b64url(`${ts}.${payloadB64}`);
      const signingInput = new TextEncoder().encode(`${parts[0]}.${signaturePayloadB64}`);
      const ok = await crypto.subtle.verify("Ed25519", key, fromB64url(parts[2]) as BufferSource, signingInput);
      return ok ? "ok" : "bad";
    } catch {
      return "bad";
    }
  }

  function buildText(p: NeonOtpPayload): string {
    const code = String(p.event_data?.otp_code ?? "");
    const m = options.message;
    if (typeof m === "function") return m(p);
    if (typeof m === "string") {
      return fillTemplate(m, { code, app: relay.appName, otp_type: p.event_data?.otp_type });
    }
    const l = typeof options.lang === "function" ? options.lang(p) : options.lang;
    return buildOtpMessage(l === "ar" ? "ar" : "en", relay.appName, code);
  }

  return async function neonHandler(req: Request): Promise<Response> {
    if (req.method !== "POST") return json(405, { status: "method_not_allowed" });
    const len = Number(req.headers.get("content-length") ?? 0);
    if (len > MAX_BODY_BYTES) return json(413, { status: "too_large" });
    const raw = await req.text();
    if (raw.length > MAX_BODY_BYTES) return json(413, { status: "too_large" });

    const v = await verify(req, raw);
    if (v === "unavailable") return json(503, { status: "keys_unavailable" });
    if (v === "bad") return json(401, { status: "bad_signature" });

    let payload: NeonOtpPayload;
    try {
      payload = JSON.parse(raw) as NeonOtpPayload;
    } catch {
      return json(400, { status: "bad_json" });
    }
    const type = req.headers.get("x-neon-event-type") ?? payload.event_type;
    if (type !== "send.otp") return json(200, { status: "skipped", reason: "event_type" });
    if (payload.event_data?.delivery_preference !== "sms") return json(200, { status: "skipped", reason: "delivery_preference" });
    const code = payload.event_data?.otp_code;
    const phone = payload.user?.phone_number;
    if (!code || !phone) return json(200, { status: "skipped", reason: "missing_fields" });

    let text: string;
    try {
      text = buildText(payload);
    } catch {
      console.error(`${TAG} message option threw`);
      return json(200, { status: "failed", code: "MESSAGE_BUILDER" });
    }
    const eventId = req.headers.get("x-neon-event-id") ?? payload.event_id;
    const result = await relay.send({ phone, message: text, eventKey: eventId ? `neon:${eventId}` : undefined });
    return toResponse(result);
  };
}
