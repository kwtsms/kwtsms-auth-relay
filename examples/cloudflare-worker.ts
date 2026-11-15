/*
FILE:      examples/cloudflare-worker.ts
CREATED:   2026-11-16 01:52 +03
TASK:      int-clerk int-neon
AUTHOR:    M Alhassoun
WHAT:      Cloudflare Worker serving both webhooks: /clerk and /neon.
WHY:       Workers have no shared memory between requests; pass a KV-backed store so dedupe, cooldown and the hourly cap hold.
*/
import { createClerkHandler } from "kwtsms-auth-relay/clerk";
import { createNeonHandler } from "kwtsms-auth-relay/neon";
import type { Store } from "kwtsms-auth-relay";

interface Env {
  CLERK_WEBHOOK_SIGNING_SECRET: string;
  NEON_AUTH_URL: string;
  KWTSMS_USERNAME: string;
  KWTSMS_PASSWORD: string;
  KWTSMS_SENDER_ID: string;
  KWTSMS_LIVE?: string;
  RELAY_KV: { get(k: string): Promise<string | null>; put(k: string, v: string, o: { expirationTtl: number }): Promise<void>; delete(k: string): Promise<void> };
}

function kvStore(kv: Env["RELAY_KV"]): Store {
  return {
    get: async (k) => (await kv.get(k)) ?? undefined,
    set: (k, v, ttl) => kv.put(k, v, { expirationTtl: Math.max(60, ttl) }), // KV minimum TTL is 60 s
    delete: (k) => kv.delete(k),
  };
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const common = {
      kwtsms: { username: env.KWTSMS_USERNAME, password: env.KWTSMS_PASSWORD, senderId: env.KWTSMS_SENDER_ID, live: env.KWTSMS_LIVE === "1" },
      store: kvStore(env.RELAY_KV),
      appName: "Shop",
    };
    const path = new URL(req.url).pathname;
    if (path === "/clerk") return createClerkHandler({ ...common, signingSecret: env.CLERK_WEBHOOK_SIGNING_SECRET })(req);
    if (path === "/neon") return createNeonHandler({ ...common, neonAuthUrl: env.NEON_AUTH_URL })(req);
    return new Response("not found", { status: 404 });
  },
};
