/*
FILE:      tests/relay.test.ts
CREATED:   2026-11-16 01:52 +03
TASK:      int-clerk int-neon
AUTHOR:    M Alhassoun
WHAT:      Shared send path tests: test-mode warning, live-mode checks, allowlist, cooldown, hourly cap, store, timeout, express adapter.
WHY:       These rules protect credits and the user's number; they must behave the same for Clerk and Neon.
*/
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRelay, memoryStore, fillTemplate } from "../src/relay";
import { toExpress } from "../src/express";
import { fake, spyConsole } from "./helpers";
import { createClerkHandler } from "../src/clerk";
import { clerkRequest, clerkSms, svixSecret } from "./helpers";

let con: ReturnType<typeof spyConsole>;
beforeEach(() => {
  con = spyConsole();
});
afterEach(() => vi.restoreAllMocks());

describe("modes", () => {
  it("test mode warns at startup and when the allowlist is the default", () => {
    createRelay({ kwtsms: { client: fake().client } });
    expect(con.warns()).toContain("test mode");
    expect(con.warns()).toContain("allowedCountries");
  });
  it("no allowlist warning when set; no test-mode warning when live", () => {
    createRelay({ kwtsms: { live: true, senderId: "MyShop", client: fake().client }, allowedCountries: ["965"] });
    expect(con.warns()).toBe("[]");
  });
  it("live refuses the shared sender id and missing credentials", () => {
    expect(() => createRelay({ kwtsms: { live: true, client: fake().client } })).toThrow(/senderId/);
    expect(() => createRelay({ kwtsms: { live: true, senderId: "KWT-SMS", client: fake().client } })).toThrow(/senderId/);
    expect(() => createRelay({ kwtsms: { live: true, senderId: "MyShop" } })).toThrow(/username/);
  });
});

describe("limits", () => {
  const relay = (extra = {}) => {
    const f = fake();
    return { ...f, r: createRelay({ kwtsms: { client: f.client }, ...extra }) };
  };
  it("allowlist refusal never reaches the client", async () => {
    const { r, sent } = relay();
    expect(await r.send({ phone: "+14155550123", message: "hi 1234" })).toEqual({ status: "refused", reason: "COUNTRY_NOT_ALLOWED" });
    expect(sent).toHaveLength(0);
  });
  it("per-number cap of 5 per hour (cooldown off), other numbers unaffected", async () => {
    const { r, sent } = relay({ cooldownSeconds: 0 });
    for (let i = 0; i < 5; i++) expect((await r.send({ phone: "96551234567", message: "m" + i })).status).toBe("sent");
    expect(await r.send({ phone: "96551234567", message: "m5" })).toEqual({ status: "refused", reason: "RATE_LIMIT" });
    expect((await r.send({ phone: "96551234568", message: "m" })).status).toBe("sent");
    expect(sent).toHaveLength(6);
  });
  it("cooldown blocks a second send inside the window", async () => {
    const { r, sent } = relay({ cooldownSeconds: 60 });
    expect((await r.send({ phone: "96551234567", message: "a" })).status).toBe("sent");
    expect(await r.send({ phone: "96551234567", message: "b" })).toEqual({ status: "refused", reason: "COOLDOWN" });
    expect(sent).toHaveLength(1);
  });
  it("a custom store is used for dedupe", async () => {
    const store = memoryStore();
    const f = fake();
    const a = createRelay({ kwtsms: { client: f.client }, store, cooldownSeconds: 0 });
    const b = createRelay({ kwtsms: { client: f.client }, store, cooldownSeconds: 0 });
    expect((await a.send({ phone: "96551234567", message: "a", eventKey: "e1" })).status).toBe("sent");
    expect((await b.send({ phone: "96551234567", message: "a", eventKey: "e1" })).status).toBe("duplicate");
  });
  it("a hung kwtSMS call is answered as sent-unknown (failed TIMEOUT), not 503", async () => {
    const hung = { send: () => new Promise<never>(() => {}) };
    const r = createRelay({ kwtsms: { client: hung }, sendTimeoutMs: 20 });
    expect(await r.send({ phone: "96551234567", message: "a" })).toEqual({ status: "failed", code: "TIMEOUT" });
  });
  it("a throwing client counts as not sent", async () => {
    const r = createRelay({ kwtsms: { client: { send: async () => { throw new Error("boom"); } } } });
    expect((await r.send({ phone: "96551234567", message: "a" })).status).toBe("not_sent");
  });
  it("fillTemplate leaves nothing behind for unknown names", () => {
    expect(fillTemplate("{a}-{b}-{c}", { a: 1, b: undefined })).toBe("1--");
  });
});

describe("express adapter", () => {
  function res() {
    const o = { code: 0, body: "", status(c: number) { o.code = c; return o; }, setHeader() {}, send(b: string) { o.body = b; } };
    return o;
  }
  it("passes a raw Buffer body through to the handler and writes the status", async () => {
    const f = fake();
    const h = createClerkHandler({ kwtsms: { client: f.client }, signingSecret: svixSecret });
    const signed = clerkRequest(clerkSms());
    const body = Buffer.from(await signed.text());
    const headers: Record<string, string> = {};
    signed.headers.forEach((v, k) => (headers[k] = v));
    const o = res();
    await toExpress(h)({ method: "POST", url: "/api/clerk", headers: { ...headers, host: "app.example" }, body }, o);
    expect(o.code).toBe(200);
    expect(f.sent).toHaveLength(1);
  });
  it("500 with a log line when the body was already parsed", async () => {
    const h = createClerkHandler({ kwtsms: { client: fake().client }, signingSecret: svixSecret });
    const o = res();
    await toExpress(h)({ method: "POST", url: "/", headers: {}, body: { type: "sms.created" } }, o);
    expect(o.code).toBe(500);
    expect(con.all()).toContain("express.raw");
  });
});
