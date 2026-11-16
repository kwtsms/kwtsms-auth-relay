// kwtSMS for Authgear: paste this into Authgear Portal, Advanced, Custom SMS Gateway, Custom JS/TS.
// Authgear calls it for every SMS (verification codes, sign-in links) and it sends the text through kwtSMS.
// Test mode is on: messages are queued, not delivered. Set TEST_MODE to false and use your own Sender ID to deliver.
// Use a dedicated kwtSMS API user for this, not your main login.
import type { CustomSMSGatewayPayload, CustomSMSGatewayResponse } from "https://deno.land/x/authgear_deno_hook@v1.5.0/mod.ts";

const KWTSMS_USERNAME = "your_api_username";
const KWTSMS_PASSWORD = "your_api_password";
const SENDER_ID = "KWT-SMS"; // KWT-SMS is for tests only
const TEST_MODE = true;

// "+965 5000 0000", "00965...", Arabic-Indic or Persian digits -> 96550000000
function toKwtsmsNumber(phone: string): string {
  const latin = phone
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0));
  return latin.replace(/\D/g, "").replace(/^0+/, "");
}

export default async function (e: CustomSMSGatewayPayload): Promise<CustomSMSGatewayResponse> {
  const mobile = toKwtsmsNumber(e.to);
  if (mobile.length < 7 || mobile.length > 15) return { code: "invalid_phone_number" };

  let answer: { result?: string; code?: string } = {};
  try {
    const res = await fetch("https://www.kwtsms.com/API/send/", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        username: KWTSMS_USERNAME,
        password: KWTSMS_PASSWORD,
        sender: SENDER_ID,
        mobile,
        message: e.body,
        test: TEST_MODE ? "1" : "0",
      }),
    });
    answer = await res.json().catch(() => ({ code: `HTTP${res.status}` }));
  } catch {
    return { code: "rate_limited", provider_error_code: "NETWORK" };
  }

  if (answer.result === "OK") return { code: "ok" };
  const err = String(answer.code ?? "UNKNOWN");
  if (["ERR001", "ERR003", "ERR004", "ERR005", "ERR024"].includes(err)) return { code: "authentication_failed", provider_error_code: err };
  if (["ERR006", "ERR025"].includes(err)) return { code: "invalid_phone_number", provider_error_code: err };
  if (["ERR013", "ERR028"].includes(err)) return { code: "rate_limited", provider_error_code: err };
  return { code: "delivery_rejected", provider_error_code: err };
}
