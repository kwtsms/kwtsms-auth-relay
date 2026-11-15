/*
FILE:      src/index.ts
CREATED:   2026-11-16 01:52 +03
TASK:      int-clerk int-neon
AUTHOR:    M Alhassoun
WHAT:      Package entry: shared types, memoryStore and the Express adapter. Handlers live in kwtsms-auth-relay/clerk and kwtsms-auth-relay/neon.
WHY:       Keeps svix (Clerk) out of an app that uses only one provider.
*/

export { memoryStore } from "./relay";
export type { RelayOptions, Store, SmsClient, SendOutcome, KwtsmsConfig, RelayResult } from "./relay";
export { toExpress } from "./express";
export type { Lang } from "./template";
