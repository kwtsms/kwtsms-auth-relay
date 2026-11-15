/*
FILE:      tests/helpers.ts
CREATED:   2026-11-16 01:52 +03
TASK:      int-clerk int-neon
AUTHOR:    M Alhassoun
WHAT:      Test helpers: fake SMS client, Svix signing, Ed25519 signing for Neon fixtures, console spies.
WHY:       No network and no credentials in any test; every signature is made here with keys generated per run.
*/
import { randomBytes } from "node:crypto";
import { vi } from "vitest";
import { Webhook } from "svix";
import type { SmsClient, SendOutcome } from "../src/relay";

export function fake(result: SendOutcome | (() => Promise<SendOutcome>) = { result: "OK" }) {
  const sent: { mobile: string; message: string }[] = [];
  const client: SmsClient = {
    send: async (mobile, message) => {
      sent.push({ mobile, message });
      return typeof result === "function" ? result() : result;
    },
  };
  return { client, sent };
}

export function spyConsole() {
  const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) =>
    vi.spyOn(console, m).mockImplementation(() => {}),
  );
  return {
    all: () => JSON.stringify(spies.flatMap((s) => s.mock.calls)),
    warns: () => JSON.stringify(vi.mocked(console.warn).mock.calls),
  };
}

// ---- Clerk / Svix ----
export const svixSecret = `whsec_${randomBytes(24).toString("base64")}`;

export function clerkRequest(
  data: Record<string, unknown>,
  opts: { secret?: string; id?: string; type?: string; at?: Date; tamper?: boolean; method?: string } = {},
): Request {
  const body = JSON.stringify({ type: opts.type ?? "sms.created", object: "event", data });
  const id = opts.id ?? `msg_${randomBytes(6).toString("hex")}`;
  const at = opts.at ?? new Date();
  const sig = new Webhook(opts.secret ?? svixSecret).sign(id, at, body);
  return new Request("https://app.example/api/clerk", {
    method: "POST",
    headers: {
      "svix-id": id,
      "svix-timestamp": String(Math.floor(at.getTime() / 1000)),
      "svix-signature": sig,
    },
    body: opts.tamper ? body.replace("sms", "smx") : body,
  });
}

export const clerkSms = (over: Record<string, unknown> = {}) => ({
  to_phone_number: "+96551234567",
  message: "Your code is 482915",
  delivered_by_clerk: false,
  slug: "verification_code",
  user_id: "user_1",
  status: "queued",
  data: { otp_code: "482915" },
  ...over,
});

// ---- Neon / Ed25519 ----
const enc = new TextEncoder();
export function b64url(input: Uint8Array | string): string {
  return Buffer.from(typeof input === "string" ? enc.encode(input) : input).toString("base64url");
}

export async function makeKey(kid: string) {
  const pair = (await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"])) as CryptoKeyPair;
  const jwk = { ...(await crypto.subtle.exportKey("jwk", pair.publicKey)), kid, use: "sig", alg: "EdDSA" };
  return { kid, privateKey: pair.privateKey, jwk };
}
export type TestKey = Awaited<ReturnType<typeof makeKey>>;

export function jwksFetch(keys: () => TestKey[]) {
  const fn = vi.fn(async () => new Response(JSON.stringify({ keys: keys().map((k) => k.jwk) }), { status: 200 }));
  return fn as unknown as typeof fetch & ReturnType<typeof vi.fn>;
}

export const neonPayload = (over: Record<string, unknown> = {}, eventData: Record<string, unknown> = {}) => ({
  event_type: "send.otp",
  event_id: `evt_${randomBytes(6).toString("hex")}`,
  event_data: { otp_code: "482915", otp_type: "sign-in", expires_at: new Date(Date.now() + 300000).toISOString(), delivery_preference: "sms", ...eventData },
  user: { phone_number: "+96551234567" },
  ...over,
});

export async function neonRequest(
  key: TestKey,
  payload: Record<string, unknown>,
  opts: { timestamp?: string; kid?: string; eventType?: string; eventId?: string; badSig?: boolean } = {},
): Promise<Request> {
  const raw = JSON.stringify(payload);
  const ts = opts.timestamp ?? String(Math.floor(Date.now() / 1000));
  const headerB64 = b64url(JSON.stringify({ alg: "EdDSA", kid: key.kid, typ: "JWT" }));
  const input = `${headerB64}.${b64url(`${ts}.${b64url(raw)}`)}`;
  const sig = new Uint8Array(await crypto.subtle.sign("Ed25519", key.privateKey, enc.encode(input)));
  if (opts.badSig) sig[0] ^= 0xff;
  return new Request("https://app.example/api/neon", {
    method: "POST",
    headers: {
      "x-neon-signature": `${headerB64}..${b64url(sig)}`,
      "x-neon-signature-kid": opts.kid ?? key.kid,
      "x-neon-timestamp": ts,
      "x-neon-event-type": opts.eventType ?? String(payload.event_type),
      "x-neon-event-id": opts.eventId ?? String(payload.event_id),
      "x-neon-delivery-attempt": "1",
    },
    body: raw,
  });
}
