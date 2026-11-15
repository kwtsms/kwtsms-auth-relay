/*
FILE:      tests/clerk.test.ts
CREATED:   2026-11-16 01:52 +03
TASK:      int-clerk int-neon
AUTHOR:    M Alhassoun
WHAT:      Clerk handler tests: Svix signature, stale timestamp, skips, dedupe, custom Arabic message, 503 rule, 200 on kwtSMS ERR.
WHY:       Every response rule in the design is pinned with signed fixtures and a fake client (no network, no credentials).
*/
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createClerkHandler } from "../src/clerk";
import { clerkRequest, clerkSms, fake, spyConsole, svixSecret } from "./helpers";

let con: ReturnType<typeof spyConsole>;
beforeEach(() => {
  con = spyConsole();
});
afterEach(() => vi.restoreAllMocks());

const otherSigningKey = `whsec_${Buffer.from("x".repeat(24)).toString("base64")}`;
const make = (client: ReturnType<typeof fake>["client"], extra = {}) =>
  createClerkHandler({ kwtsms: { client }, signingSecret: svixSecret, cooldownSeconds: 0, ...extra });

describe("clerk signature", () => {
  it("sends Clerk's own message for a valid sms.created", async () => {
    const { client, sent } = fake();
    const res = await make(client)(clerkRequest(clerkSms()));
    expect(res.status).toBe(200);
    expect(sent).toEqual([{ mobile: "96551234567", message: "Your code is 482915" }]);
  });
  it("401 on a wrong secret", async () => {
    const { client, sent } = fake();
    const res = await make(client)(clerkRequest(clerkSms(), { secret: otherSigningKey }));
    expect(res.status).toBe(401);
    expect(sent).toHaveLength(0);
  });
  it("401 on a tampered body", async () => {
    const { client, sent } = fake();
    expect((await make(client)(clerkRequest(clerkSms(), { tamper: true }))).status).toBe(401);
    expect(sent).toHaveLength(0);
  });
  it("401 on a stale timestamp (10 minutes old)", async () => {
    const { client, sent } = fake();
    const res = await make(client)(clerkRequest(clerkSms(), { at: new Date(Date.now() - 10 * 60 * 1000) }));
    expect(res.status).toBe(401);
    expect(sent).toHaveLength(0);
  });
  it("405 on GET", async () => {
    const { client } = fake();
    expect((await make(client)(new Request("https://app.example/x", { method: "GET" }))).status).toBe(405);
  });
});

describe("clerk skips", () => {
  it("delivered_by_clerk true is skipped with 200", async () => {
    const { client, sent } = fake();
    const res = await make(client)(clerkRequest(clerkSms({ delivered_by_clerk: true })));
    expect(res.status).toBe(200);
    expect(sent).toHaveLength(0);
  });
  it("another event type is skipped with 200", async () => {
    const { client, sent } = fake();
    const res = await make(client)(clerkRequest(clerkSms(), { type: "user.created" }));
    expect(res.status).toBe(200);
    expect(sent).toHaveLength(0);
  });
});

describe("clerk dedupe, message option", () => {
  it("the same svix-id twice sends once", async () => {
    const { client, sent } = fake();
    const h = make(client);
    const a = await h(clerkRequest(clerkSms(), { id: "msg_same" }));
    const b = await h(clerkRequest(clerkSms(), { id: "msg_same" }));
    expect([a.status, b.status]).toEqual([200, 200]);
    expect(sent).toHaveLength(1);
  });
  it("string template in Arabic with {otp_code} and {app}", async () => {
    const { client, sent } = fake();
    const h = make(client, { appName: "Shop", message: "{app}: رمز التحقق {otp_code}. لا تشاركه." });
    await h(clerkRequest(clerkSms()));
    expect(sent[0].message).toContain("رمز التحقق 482915");
    expect(sent[0].message.startsWith("Shop:")).toBe(true);
  });
  it("function option gets the Clerk data", async () => {
    const { client, sent } = fake();
    const h = make(client, { message: (s: { data?: Record<string, unknown> }) => `رمزك ${String(s.data?.otp_code)}` });
    await h(clerkRequest(clerkSms()));
    expect(sent[0].message).toBe("رمزك 482915");
  });
});

describe("clerk response rule", () => {
  it("503 only when nothing was sent (NOT_SENT), and the retry then sends", async () => {
    let n = 0;
    const { client, sent } = fake(async () => (++n === 1 ? { result: "ERROR", code: "NOT_SENT" } : { result: "OK" }));
    const h = make(client, { cooldownSeconds: 60 });
    const first = await h(clerkRequest(clerkSms(), { id: "msg_retry" }));
    expect(first.status).toBe(503);
    const retry = await h(clerkRequest(clerkSms(), { id: "msg_retry" }));
    expect(retry.status).toBe(200);
    expect(sent).toHaveLength(2);
  });
  it("200 when kwtSMS answers with an ERR (no retry storm), error logged masked", async () => {
    const { client } = fake({ result: "ERROR", code: "ERR010", description: "no balance" });
    const res = await make(client)(clerkRequest(clerkSms()));
    expect(res.status).toBe(200);
    expect(con.all()).toContain("ERR010");
  });
});
