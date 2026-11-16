# Changelog

## [Unreleased]

- Okta: a Telephony Inline Hook handler (`kwtsms-auth-relay/okta`) sends Okta SMS sign-in codes through kwtSMS and answers Okta in its own format. Anything not delivered (test mode, voice calls, refused numbers, kwtSMS errors) is handed back so Okta sends the code itself.

## [0.1.0] - 2026-11-16

- First release: send Clerk and Neon Auth SMS (OTP) through kwtSMS. Web-standard handlers for Clerk's `sms.created` webhook and Neon Auth's `send.otp` webhook, an Express adapter, and examples for Next.js, Cloudflare Workers and Express.
- Webhook signatures are verified before anything is sent: Svix for Clerk, Ed25519 for Neon Auth.
- Safe by default: test mode unless `live: true`, country allowlist (Kuwait), resend cooldown, per-number hourly cap, one send per event id, and logs that never hold the code or the full number.
