/*
FILE:      tests/wso2.test.ts
CREATED:   2026-11-16 22:01 +03
TASK:      job 63, int-grafana (WSO2 recipe)
AUTHOR:    M Alhassoun
WHAT:      WSO2 custom SMS provider handler tests: header secret, the exact JSON WSO2 builds from the documented
           template (+ prefix), retries, refusals and kwtSMS errors answer non-2xx, no code in logs.
WHY:       WSO2 shows a send failure only when the provider answers non-2xx; a wrong 200 leaves the user waiting.
           No network: the kwtSMS client is a fake.
*/
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createWso2Handler } from "../src/wso2";
import { fake, spyConsole } from "./helpers";

const SECRET = "Bearer 0123456789abcdef0123";
let con: ReturnType<typeof spyConsole>;
beforeEach(() => {
  con = spyConsole();
});
afterEach(() => vi.restoreAllMocks());

// What WSO2 posts for the template {"to": {{mobile}}, "content": {{body}}} (CustomProviderTest: quoted, escaped values)
const WSO2_BODY = '{"to": "+96550000000","content": "Your verification code is 769317"}';

function req(raw: string, opts: { secret?: string | null; method?: string } = {}) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (opts.secret !== null) headers.authorization = opts.secret ?? SECRET;
  return new Request("https://example.test/wso2", { method: opts.method ?? "POST", headers, body: opts.method === "GET" ? undefined : raw });
}

function make(live = true, result: Record<string, unknown> = { result: "OK", msgId: "abc123" }) {
  const f = fake(result as never);
  const handler = createWso2Handler({ secret: SECRET, kwtsms: { client: f.client, live, senderId: "MYSENDER" } });
  return { handler, sent: f.sent };
}

describe("wso2 handler", () => {
  it("sends the WSO2 text to the number without +, answers 200", async () => {
    const { handler, sent } = make();
    const res = await handler(req(WSO2_BODY));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "sent", test: false });
    expect(sent).toEqual([{ mobile: "96550000000", message: "Your verification code is 769317" }]);
  });

  it("accepts mobile/body field names too", async () => {
    const { handler, sent } = make();
    await handler(req('{"mobile": "0096550000000", "body": "code 1"}'));
    expect(sent[0]?.mobile).toBe("96550000000");
  });

  it("wrong or missing secret: 401, nothing sent", async () => {
    const { handler, sent } = make();
    expect((await handler(req(WSO2_BODY, { secret: "Bearer wrong-wrong-wrong-1" }))).status).toBe(401);
    expect((await handler(req(WSO2_BODY, { secret: null }))).status).toBe(401);
    expect(sent).toHaveLength(0);
  });

  it("GET is refused; bad JSON is 400", async () => {
    const { handler } = make();
    expect((await handler(req("", { method: "GET" }))).status).toBe(405);
    expect((await handler(req("Body=x&To=y"))).status).toBe(400);
  });

  it("a retry of the same text is not sent twice", async () => {
    const { handler, sent } = make();
    await handler(req(WSO2_BODY));
    const res = await handler(req(WSO2_BODY));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: "duplicate" });
    expect(sent).toHaveLength(1);
  });

  it("number outside allowed countries: 422 refused", async () => {
    const { handler, sent } = make();
    const res = await handler(req('{"to": "+447549293826", "content": "x"}'));
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ status: "refused", reason: "COUNTRY_NOT_ALLOWED" });
    expect(sent).toHaveLength(0);
  });

  it("kwtSMS error: 502 with the ERR code", async () => {
    const { handler } = make(true, { result: "ERROR", code: "ERR010" });
    const res = await handler(req(WSO2_BODY));
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ status: "failed", code: "ERR010" });
  });

  it("test mode answers 200 with test: true", async () => {
    const { handler } = make(false);
    expect(await (await handler(req(WSO2_BODY))).json()).toEqual({ status: "sent", test: true });
  });

  it("short secret refused at start; the code never reaches the logs", async () => {
    expect(() => createWso2Handler({ secret: "short", kwtsms: {} })).toThrow(/16/);
    const { handler } = make(true, { result: "ERROR", code: "ERR010" });
    await handler(req(WSO2_BODY));
    expect(con.all()).not.toContain("769317");
    expect(con.all()).not.toContain("96550000000");
  });
});
