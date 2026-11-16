/*
FILE:      tests/okta.test.ts
CREATED:   2026-11-16 20:55 +03
TASK:      job 60, int-okta
AUTHOR:    M Alhassoun
WHAT:      Okta telephony hook tests: header secret, SMS vs voice, test mode answers an error (Okta falls back),
           live answers SUCCESSFUL with the msg-id, retries, refusals, Arabic from locale, no code in logs.
WHY:       A wrong answer either locks users out (SUCCESSFUL without a delivered SMS) or sends two codes; both cases
           are pinned here. No network: the kwtSMS client is a fake.
*/
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createOktaHandler } from "../src/okta";
import { fake, spyConsole } from "./helpers";

const SECRET = "Basic dGVzdHVzZXI6dGVzdHBhc3N3b3Jk";
let con: ReturnType<typeof spyConsole>;
beforeEach(() => {
  con = spyConsole();
});
afterEach(() => vi.restoreAllMocks());

function body(over: Record<string, unknown> = {}) {
  return {
    eventType: "com.okta.telephony.provider",
    requestType: "com.okta.user.telephony.mfa-verification",
    data: {
      messageProfile: {
        phoneNumber: "+965 5000 0000",
        otpCode: "123456",
        deliveryChannel: "SMS",
        locale: "EN-US",
        msgTemplate: "Your code is ${code}",
        ...over,
      },
    },
  };
}

function req(b: unknown, opts: { secret?: string | null; method?: string; header?: string } = {}) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (opts.secret !== null) headers[opts.header ?? "authorization"] = opts.secret ?? SECRET;
  return new Request("https://example.test/okta", {
    method: opts.method ?? "POST",
    headers,
    body: opts.method === "GET" ? undefined : JSON.stringify(b),
  });
}

function make(extra: Record<string, unknown> = {}, live = true, result = { result: "OK", msgId: "abc123" }) {
  const f = fake(result);
  const handler = createOktaHandler({
    secret: SECRET,
    kwtsms: { client: f.client, live, senderId: "MYSENDER" },
    appName: "Acme",
    ...extra,
  });
  return { handler, sent: f.sent };
}

describe("okta handler", () => {
  it("live: sends the SMS and answers SUCCESSFUL with the msg-id", async () => {
    const { handler, sent } = make();
    const r = await handler(req(body()));
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.commands[0].type).toBe("com.okta.telephony.action");
    expect(j.commands[0].value[0]).toMatchObject({ status: "SUCCESSFUL", provider: "kwtSMS", transactionId: "abc123" });
    expect(sent).toHaveLength(1);
    expect(sent[0].mobile).toBe("96550000000");
    expect(sent[0].message).toBe("Acme: your code is 123456. Valid 5 min. Do not share it.");
  });

  it("rejects a wrong or missing secret before reading the body", async () => {
    const { handler, sent } = make();
    expect((await handler(req(body(), { secret: "Basic wrong" }))).status).toBe(401);
    expect((await handler(req(body(), { secret: null }))).status).toBe(401);
    expect(sent).toHaveLength(0);
  });

  it("uses a custom header name", async () => {
    const { handler } = make({ authHeader: "X-Okta-Secret" });
    expect((await handler(req(body(), { header: "x-okta-secret" }))).status).toBe(200);
    expect((await handler(req(body()))).status).toBe(401);
  });

  it("refuses a short secret at startup", () => {
    expect(() => createOktaHandler({ secret: "short", kwtsms: { client: fake().client } })).toThrow(/at least 16/);
  });

  it("405 on GET", async () => {
    const { handler } = make();
    expect((await handler(req(null, { method: "GET" }))).status).toBe(405);
  });

  it("voice call: no send, error object so Okta uses its own voice provider", async () => {
    const { handler, sent } = make();
    const j = await (await handler(req(body({ deliveryChannel: "Voice call" })))).json();
    expect(j.error.errorSummary).toMatch(/SMS only/);
    expect(j.commands).toBeUndefined();
    expect(sent).toHaveLength(0);
  });

  it("test mode: queues the SMS but answers an error so Okta falls back (nobody locked out)", async () => {
    const { handler, sent } = make({}, false);
    const j = await (await handler(req(body()))).json();
    expect(sent).toHaveLength(1);
    expect(j.error.errorSummary).toMatch(/test mode/);
    expect(j.commands).toBeUndefined();
  });

  it("test mode with reportTestAsSuccess answers SUCCESSFUL (Preview only)", async () => {
    const { handler } = make({ reportTestAsSuccess: true }, false);
    const j = await (await handler(req(body()))).json();
    expect(j.commands[0].value[0].status).toBe("SUCCESSFUL");
    expect(j.commands[0].value[0].transactionMetadata).toMatch(/not delivered/);
  });

  it("kwtSMS error: error object with the ERR code", async () => {
    const { handler } = make({}, true, { result: "ERROR", code: "ERR010" } as never);
    const j = await (await handler(req(body()))).json();
    expect(j.error.errorSummary).toBe("kwtSMS error: ERR010");
  });

  it("number outside allowedCountries: refused, error object, nothing sent", async () => {
    const { handler, sent } = make();
    const j = await (await handler(req(body({ phoneNumber: "+12025550100" })))).json();
    expect(j.error.errorSummary).toBe("kwtSMS relay refused: COUNTRY_NOT_ALLOWED");
    expect(sent).toHaveLength(0);
  });

  it("Okta retry of the same code sends once and still answers SUCCESSFUL", async () => {
    const { handler, sent } = make();
    await handler(req(body()));
    const j = await (await handler(req(body()))).json();
    expect(sent).toHaveLength(1);
    expect(j.commands[0].value[0].status).toBe("SUCCESSFUL");
  });

  it("a new code to the same number is sent (no resend cooldown), up to 10 per hour", async () => {
    const { handler, sent } = make();
    for (let i = 0; i < 11; i++) await handler(req(body({ otpCode: String(100000 + i) })));
    expect(sent).toHaveLength(10);
  });

  it("Arabic text when the Okta locale is Arabic", async () => {
    const { handler, sent } = make();
    await handler(req(body({ locale: "ar" })));
    expect(sent[0].message).toContain("رمز التحقق 123456");
  });

  it("custom message template", async () => {
    const { handler, sent } = make({ message: "{app} code {code}" });
    await handler(req(body()));
    expect(sent[0].message).toBe("Acme code 123456");
  });

  it("never logs the code or the full number", async () => {
    const { handler } = make({}, true, { result: "ERROR", code: "ERR003" } as never);
    await handler(req(body()));
    expect(con.all()).not.toContain("123456");
    expect(con.all()).not.toContain("96550000000");
  });
});
