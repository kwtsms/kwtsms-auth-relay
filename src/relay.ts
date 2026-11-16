/*
FILE:      src/relay.ts
CREATED:   2026-11-16 01:52 +03
TASK:      int-clerk int-neon
AUTHOR:    M Alhassoun
WHAT:      Shared send path for the Clerk and Neon handlers: options, store, number checks, dedupe, cooldown, hourly cap, kwtSMS call, outcome.
WHY:       Both providers must behave the same on the same input: test mode by default, allowlist before any send, one send per event id, and logs that never hold the code or the full number.
*/

import { KwtSMS, maskPhone, cleanMessage } from "kwtsms";
import { normalizePhone } from "./phone";

export interface SendOutcome {
  result: string;
  code?: string;
  description?: string;
  /** kwtSMS msg-id on OK. 2026-11-16 20:40 +03: added for the Okta transactionId, job 60 int-okta */
  msgId?: string;
}

/**
 * Injectable sender (tests, custom gateways). Return `{ result: "ERROR", code: "NOT_SENT" }` (or throw)
 * when the request never left (DNS or connect error); any other answer means kwtSMS was reached.
 */
export interface SmsClient {
  send(mobile: string, message: string): Promise<SendOutcome>;
}

/** Tiny key-value store for dedupe, cooldown and caps. Default is in-memory (one process only). */
export interface Store {
  get(key: string): string | undefined | Promise<string | undefined>;
  set(key: string, value: string, ttlSeconds: number): void | Promise<void>;
  delete?(key: string): void | Promise<void>;
}

export interface KwtsmsConfig {
  username?: string;
  password?: string;
  /** Default "KWT-SMS" (shared test Sender ID, refused in live mode). */
  senderId?: string;
  /** Default false: kwtSMS test mode (test=1), messages are queued, not delivered. */
  live?: boolean;
  /** Replaces the kwtsms library (tests). */
  client?: SmsClient;
}

export interface RelayOptions {
  kwtsms: KwtsmsConfig;
  /** Default "App"; ASCII only, cut to 16 characters. */
  appName?: string;
  /** Default ["965"]. */
  allowedCountries?: string[];
  /** Per-number resend cooldown. Default 60, 0 disables. */
  cooldownSeconds?: number;
  /** Max sends per number per hour. Default 5, 0 disables. */
  maxPerHour?: number;
  /** Default in-memory. Use a shared store (KV, Redis) on serverless or several instances. */
  store?: Store;
  /** Give up waiting for kwtSMS after this long (the request was sent, so the answer is 200). Default 4000. */
  sendTimeoutMs?: number;
  /** Called after a failed send with the ERR code and a masked number only. */
  onError?: (info: { code?: string; description?: string; phone: string }) => void;
}

export type RelayResult =
  | { status: "sent"; msgId?: string } // 2026-11-16 20:40 +03: msgId for Okta, job 60
  | { status: "failed"; code?: string }
  | { status: "duplicate" }
  | { status: "refused"; reason: "INVALID_PHONE" | "COUNTRY_NOT_ALLOWED" | "COOLDOWN" | "RATE_LIMIT" | "EMPTY_MESSAGE" }
  | { status: "not_sent" };

export const TAG = "[kwtsms-auth-relay]";
const DEFAULT_SENDER = "KWT-SMS";
const NOT_SENT_RE = /ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ENETUNREACH|EHOSTUNREACH/i;

export function memoryStore(): Store {
  const m = new Map<string, { v: string; exp: number }>();
  return {
    get(key) {
      const e = m.get(key);
      if (!e) return undefined;
      if (e.exp <= Date.now()) {
        m.delete(key);
        return undefined;
      }
      return e.v;
    },
    set(key, v, ttl) {
      if (m.size > 5000) {
        const now = Date.now();
        for (const [k, e] of m) if (e.exp <= now) m.delete(k);
      }
      m.set(key, { v, exp: Date.now() + ttl * 1000 });
    },
    delete(key) {
      m.delete(key);
    },
  };
}

/** Replaces {name} with vars[name]; unknown names become an empty string. */
export function fillTemplate(tpl: string, vars: Record<string, unknown>): string {
  return tpl.replace(/\{(\w+)\}/g, (_m, k: string) => {
    const v = vars[k];
    return v === undefined || v === null || typeof v === "object" ? "" : String(v);
  });
}

export interface Relay {
  send(input: { phone: string; message: string; eventKey?: string }): Promise<RelayResult>;
  appName: string;
  /** 2026-11-16 20:40 +03: true = kwtSMS live mode (Okta reports test mode as an error), job 60 */
  live: boolean;
}

export function createRelay(options: RelayOptions): Relay {
  const cfg = options.kwtsms ?? {};
  const live = cfg.live === true;
  const senderId = cfg.senderId ?? DEFAULT_SENDER;
  const customAllow = options.allowedCountries !== undefined;
  const allowed = options.allowedCountries ?? ["965"];
  const cooldown = Math.max(0, options.cooldownSeconds ?? 60);
  const maxPerHour = Math.max(0, options.maxPerHour ?? 5);
  const timeoutMs = Math.max(1, options.sendTimeoutMs ?? 4000);
  const store = options.store ?? memoryStore();
  const appName = options.appName ?? "App";

  if (live) {
    if (!cfg.client && (!cfg.username || !cfg.password)) {
      throw new Error(`${TAG} live mode needs username and password`);
    }
    if (!senderId || senderId === DEFAULT_SENDER) {
      throw new Error(`${TAG} live mode needs your own senderId, not the shared ${DEFAULT_SENDER}`);
    }
  } else {
    console.warn(
      `${TAG} test mode: messages are queued, not delivered. Set kwtsms.live: true (with your own senderId) to deliver them.`,
    );
  }
  if (!customAllow) {
    console.warn(`${TAG} allowedCountries is the default ["965"] (Kuwait only). Set it to send to other countries.`);
  }

  // client built lazily: the kwtsms constructor throws without credentials and test mode must construct anyway
  let built: SmsClient | undefined = cfg.client;
  function getClient(): SmsClient {
    if (built) return built;
    const kwt = new KwtSMS(cfg.username ?? "", cfg.password ?? "", {
      senderId,
      testMode: !live,
      logFile: "", // the library would log message text (the code)
      appName: "kwtsms-auth-relay",
    });
    built = {
      async send(mobile, message) {
        const r = await kwt.send(mobile, message);
        const desc = r.description ?? "";
        if (r.result !== "OK" && r.code === "NETWORK" && NOT_SENT_RE.test(desc)) {
          return { result: "ERROR", code: "NOT_SENT", description: desc };
        }
        // 2026-11-16 20:40 +03: pass msg-id through (Okta transactionId), job 60 int-okta
        const id = (r as Record<string, unknown>)["msg-id"];
        return { result: r.result, code: r.code, description: r.description, msgId: id == null ? undefined : String(id) };
      },
    };
    return built;
  }

  async function del(key: string): Promise<void> {
    if (store.delete) await store.delete(key);
    else await store.set(key, "", 1);
  }

  function report(info: { code?: string; description?: string; phone: string }): void {
    console.error(`${TAG} send failed: ${info.code ?? "NO_CODE"} for ${info.phone}`);
    try {
      options.onError?.(info);
    } catch {
      // a broken hook must not break the webhook answer
    }
  }

  async function send(input: { phone: string; message: string; eventKey?: string }): Promise<RelayResult> {
    const p = normalizePhone(input.phone, allowed);
    if (!p.ok) return { status: "refused", reason: p.reason };
    const message = cleanMessage(String(input.message ?? ""));
    if (!message.trim()) return { status: "refused", reason: "EMPTY_MESSAGE" };
    const masked = maskPhone(p.digits);

    // dedupe: claim the event id first so a concurrent vendor retry is a duplicate
    const evKey = input.eventKey ? `ev:${input.eventKey}` : undefined;
    if (evKey) {
      if (await store.get(evKey)) return { status: "duplicate" };
      await store.set(evKey, "1", 600);
    }
    const cdKey = `cd:${p.digits}`;
    const capKey = `cap:${p.digits}:${Math.floor(Date.now() / 3_600_000)}`;
    let capCount = 0;
    const rollback = async (): Promise<void> => {
      if (evKey) await del(evKey);
      if (cooldown > 0) await del(cdKey);
      if (maxPerHour > 0) await store.set(capKey, String(Math.max(0, capCount - 1)), 3600);
    };
    if (cooldown > 0 && (await store.get(cdKey))) {
      if (evKey) await del(evKey);
      return { status: "refused", reason: "COOLDOWN" };
    }
    if (maxPerHour > 0) {
      capCount = Number(await store.get(capKey)) || 0;
      if (capCount >= maxPerHour) {
        if (evKey) await del(evKey);
        return { status: "refused", reason: "RATE_LIMIT" };
      }
      capCount += 1;
      await store.set(capKey, String(capCount), 3600);
    }
    if (cooldown > 0) await store.set(cdKey, "1", cooldown);

    let res: SendOutcome;
    try {
      const call = getClient().send(p.digits, message);
      call.catch(() => undefined); // a late failure after the timeout must not be unhandled
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<"timeout">((r) => {
        timer = setTimeout(() => r("timeout"), timeoutMs);
      });
      const winner = await Promise.race([call, timeout]);
      clearTimeout(timer);
      if (winner === "timeout") {
        report({ code: "TIMEOUT", phone: masked });
        return { status: "failed", code: "TIMEOUT" };
      }
      res = winner;
    } catch (e) {
      await rollback();
      report({ code: e instanceof Error ? e.name : "ERROR", phone: masked });
      return { status: "not_sent" };
    }
    if (res.result === "OK") return { status: "sent", msgId: res.msgId };
    if (res.code === "NOT_SENT") {
      await rollback();
      report({ code: res.code, description: res.description, phone: masked });
      return { status: "not_sent" };
    }
    report({ code: res.code, description: res.description, phone: masked });
    return { status: "failed", code: res.code };
  }

  return { send, appName, live };
}

export function readEnv(name: string): string | undefined {
  const g = globalThis as { process?: { env?: Record<string, string | undefined> } };
  return g.process?.env?.[name];
}

export const MAX_BODY_BYTES = 65_536;

export function json(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** Maps a relay result to the HTTP answer: 503 only when nothing was sent, 2xx otherwise. */
export function toResponse(r: RelayResult): Response {
  if (r.status === "not_sent") return json(503, { status: "not_sent" });
  if (r.status === "refused") return json(200, { status: "refused", reason: r.reason });
  return json(200, { status: r.status });
}
