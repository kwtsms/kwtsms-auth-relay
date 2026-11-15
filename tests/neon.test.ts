/*
FILE:      tests/neon.test.ts
CREATED:   2026-11-16 01:52 +03
TASK:      int-clerk int-neon
AUTHOR:    M Alhassoun
WHAT:      Neon handler tests: Ed25519 detached JWS, stale timestamp, JWKS refetch limit, dedupe, delivery_preference, Arabic text, 503 rule.
WHY:       The signature path is the security boundary; fixtures are signed with a key pair generated in the test, no network.
*/
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createNeonHandler } from "../src/neon";
import { fake, jwksFetch, makeKey, neonPayload, neonRequest, spyConsole, type TestKey } from "./helpers";

let key: TestKey;
let con: ReturnType<typeof spyConsole>;
beforeEach(async () => {
  con = spyConsole();
  key = await makeKey("kid-1");
});
afterEach(() => vi.restoreAllMocks());

function make(extra: Record<string, unknown> = {}, keys: () => TestKey[] = () => [key]) {
  const f = fake();
  const fetchFn = jwksFetch(keys);
  const handler = createNeonHandler({
    neonAuthUrl: "https://ep-test.neonauth.example/neondb/auth",
    kwtsms: { client: f.client },
    fetch: fetchFn,
    cooldownSeconds: 0,
    appName: "Shop",
    ...extra,
  });
  return { handler, sent: f.sent, fetchFn };
}

describe("neon signature", () => {
  it("valid send.otp sends the English OTP text", async () => {
    const { handler, sent, fetchFn } = make();
    const res = await handler(await neonRequest(key, neonPayload()));
    expect(res.status).toBe(200);
    expect(sent).toHaveLength(1);
    expect(sent[0].mobile).toBe("96551234567");
    expect(sent[0].message).toBe("Shop: your code is 482915. Valid 5 min. Do not share it.");
    expect(fetchFn).toHaveBeenCalledWith("https://ep-test.neonauth.example/neondb/auth/.well-known/jwks.json", expect.anything());
  });
  it("401 on a bad signature", async () => {
    const { handler, sent } = make();
    expect((await handler(await neonRequest(key, neonPayload(), { badSig: true }))).status).toBe(401);
    expect(sent).toHaveLength(0);
  });
  it("401 when the body was changed after signing", async () => {
    const { handler, sent } = make();
    const good = await neonRequest(key, neonPayload());
    const bad = new Request(good.url, { method: "POST", headers: good.headers, body: (await good.text()).replace("482915", "000000") });
    expect((await handler(bad)).status).toBe(401);
    expect(sent).toHaveLength(0);
  });
  it("401 when signed by a different key under the same kid", async () => {
    const other = await makeKey("kid-1");
    const { handler, sent } = make();
    expect((await handler(await neonRequest(other, neonPayload()))).status).toBe(401);
    expect(sent).toHaveLength(0);
  });
  it("401 on a stale timestamp (6 minutes old), signed correctly", async () => {
    const { handler, sent } = make();
    const ts = String(Math.floor(Date.now() / 1000) - 6 * 60);
    expect((await handler(await neonRequest(key, neonPayload(), { timestamp: ts }))).status).toBe(401);
    expect(sent).toHaveLength(0);
  });
  it("accepts an ISO timestamp too", async () => {
    const { handler, sent } = make();
    expect((await handler(await neonRequest(key, neonPayload(), { timestamp: new Date().toISOString() }))).status).toBe(200);
    expect(sent).toHaveLength(1);
  });
  it("401 on a missing signature header", async () => {
    const { handler } = make();
    expect((await handler(new Request("https://x.example/", { method: "POST", body: "{}" }))).status).toBe(401);
  });
});

describe("neon JWKS cache", () => {
  it("unknown kid: at most one refetch per 10 minutes", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const { handler, fetchFn } = make();
      const unknown = async () => handler(await neonRequest(key, neonPayload(), { kid: "kid-unknown" }));
      expect((await handler(await neonRequest(key, neonPayload()))).status).toBe(200); // fetch 1
      expect(fetchFn).toHaveBeenCalledTimes(1);
      expect((await unknown()).status).toBe(401);
      expect((await unknown()).status).toBe(401);
      expect(fetchFn).toHaveBeenCalledTimes(1); // known keys cached, unknown kid inside 10 min: no refetch
      vi.advanceTimersByTime(10 * 60 * 1000 + 1000);
      expect((await handler(await neonRequest(key, neonPayload(), { timestamp: String(Math.floor(Date.now() / 1000)) }))).status).toBe(200);
      expect((await unknown()).status).toBe(401);
      expect(fetchFn).toHaveBeenCalledTimes(2); // one refetch after 10 min
      expect((await unknown()).status).toBe(401);
      expect(fetchFn).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
  it("key rotation: a new kid is picked up by the refetch", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const k2 = await makeKey("kid-2");
      let keys = [key];
      const { handler, sent } = make({}, () => keys);
      expect((await handler(await neonRequest(key, neonPayload()))).status).toBe(200);
      keys = [key, k2];
      vi.advanceTimersByTime(11 * 60 * 1000);
      expect((await handler(await neonRequest(k2, neonPayload()))).status).toBe(200);
      expect(sent).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });
  it("503 when the JWKS cannot be fetched at all (nothing sent, Neon retries)", async () => {
    const f = fake();
    const handler = createNeonHandler({
      neonAuthUrl: "https://ep-test.neonauth.example/neondb/auth",
      kwtsms: { client: f.client },
      fetch: (async () => new Response("no", { status: 500 })) as typeof fetch,
    });
    expect((await handler(await neonRequest(key, neonPayload()))).status).toBe(503);
    expect(f.sent).toHaveLength(0);
  });
});

describe("neon rules", () => {
  it("dedupes by X-Neon-Event-Id", async () => {
    const { handler, sent } = make();
    const p = neonPayload();
    expect((await handler(await neonRequest(key, p))).status).toBe(200);
    expect((await handler(await neonRequest(key, p))).status).toBe(200);
    expect(sent).toHaveLength(1);
  });
  it("delivery_preference other than sms is skipped with 200", async () => {
    const { handler, sent } = make();
    const res = await handler(await neonRequest(key, neonPayload({}, { delivery_preference: "email" })));
    expect(res.status).toBe(200);
    expect(sent).toHaveLength(0);
  });
  it("another event type is skipped with 200", async () => {
    const { handler, sent } = make();
    expect((await handler(await neonRequest(key, neonPayload({ event_type: "user.created" })))).status).toBe(200);
    expect(sent).toHaveLength(0);
  });
  it("lang ar and a custom Arabic message option", async () => {
    const a = make({ lang: "ar" });
    await a.handler(await neonRequest(key, neonPayload()));
    expect(a.sent[0].message).toBe("Shop: رمز التحقق 482915. صالح 5 دقائق. لا تشاركه.");
    const b = make({ message: "{app}: رمزك {code}" });
    await b.handler(await neonRequest(key, neonPayload()));
    expect(b.sent[0].message).toBe("Shop: رمزك 482915");
  });
  it("503 only when nothing was sent; 200 on kwtSMS ERR", async () => {
    const off = make({ kwtsms: { client: fake({ result: "ERROR", code: "NOT_SENT" }).client } });
    expect((await off.handler(await neonRequest(key, neonPayload()))).status).toBe(503);
    const err = make({ kwtsms: { client: fake({ result: "ERROR", code: "ERR025" }).client } });
    expect((await err.handler(await neonRequest(key, neonPayload()))).status).toBe(200);
  });
  it("log hygiene: no code and no full number in any console output, even on failure", async () => {
    const f = make({ kwtsms: { client: fake({ result: "ERROR", code: "ERR010", description: "x" }).client } });
    await f.handler(await neonRequest(key, neonPayload()));
    const out = con.all();
    expect(out).toContain("ERR010");
    expect(out).not.toContain("482915");
    expect(out).not.toContain("96551234567");
    expect(out).not.toContain("51234567");
  });
});
