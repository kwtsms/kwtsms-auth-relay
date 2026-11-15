/*
FILE:      tests/phone.test.ts
CREATED:   2026-11-16 01:52 +03
TASK:      int-clerk int-neon
AUTHOR:    M Alhassoun
WHAT:      Conformance test for the copied phone normalization: same table as kwtsms-better-auth, run through the Clerk handler.
WHY:       The two packages must treat the same input the same way; a drift in the copied files must fail here.
*/
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createClerkHandler } from "../src/clerk";
import { clerkRequest, clerkSms, fake, spyConsole, svixSecret } from "./helpers";
import { normalizePhone } from "../src/phone";

beforeEach(() => void spyConsole());
afterEach(() => vi.restoreAllMocks());

describe("normalization (same table as kwtsms-better-auth)", () => {
  it.each([
    ["96551234567", "96551234567"],
    ["+965 5123 4567", "96551234567"],
    ["0096551234567", "96551234567"],
    ["51234567", "96551234567"],
    ["٥١٢٣٤٥٦٧", "96551234567"],
    ["۵۱۲۳۴۵۶۷", "96551234567"],
    ["+٩٦٥٥١٢٣٤٥٦٧", "96551234567"],
  ])("%s -> %s", async (input, digits) => {
    const { client, sent } = fake();
    const h = createClerkHandler({ kwtsms: { client }, signingSecret: svixSecret, cooldownSeconds: 0 });
    const res = await h(clerkRequest(clerkSms({ to_phone_number: input })));
    expect(res.status).toBe(200);
    expect(sent).toHaveLength(1);
    expect(sent[0].mobile).toBe(digits);
  });

  it("refuses a number outside allowedCountries and garbage", async () => {
    const { client, sent } = fake();
    const h = createClerkHandler({ kwtsms: { client }, signingSecret: svixSecret });
    expect((await h(clerkRequest(clerkSms({ to_phone_number: "+971501234567" })))).status).toBe(200);
    expect((await h(clerkRequest(clerkSms({ to_phone_number: "abc" })))).status).toBe(200);
    expect(sent).toHaveLength(0);
  });

  it("normalizePhone: allowlist widened", () => {
    expect(normalizePhone("+971501234567", ["965"])).toEqual({ ok: false, reason: "COUNTRY_NOT_ALLOWED" });
    expect(normalizePhone("+971501234567", ["965", "971"]).ok).toBe(true);
    expect(normalizePhone("123", ["965"])).toEqual({ ok: false, reason: "INVALID_PHONE" });
  });
});
