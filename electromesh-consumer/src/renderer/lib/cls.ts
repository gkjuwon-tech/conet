/** Tiny classname joiner — falsy values are skipped. */
export function cls(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}
