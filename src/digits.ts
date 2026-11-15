/*
FILE:      src/digits.ts
CREATED:   2026-11-16 01:50 +03
TASK:      int-clerk int-neon
AUTHOR:    M Alhassoun
WHAT:      synced from kwtsms-better-auth src/digits.ts 2026-11-16 (copy, do not edit here; change it there and re-sync)
           Arabic-Indic and Persian digits to ASCII.
WHY:       Users type phone numbers in either digit set; the gateway needs ASCII digits.
*/

export function toAsciiDigits(input: string): string {
  return Array.from(input, (ch) => {
    const cp = ch.codePointAt(0) ?? 0;
    if (cp >= 0x0660 && cp <= 0x0669) return String(cp - 0x0660);
    if (cp >= 0x06f0 && cp <= 0x06f9) return String(cp - 0x06f0);
    return ch;
  }).join("");
}
