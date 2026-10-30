// Wording shared by the popup and the on-page notice. No imports: the content bundle must not pull
// `wxt/browser` (or anything else) through this file.

/** "1 field", "0 fields", "3 fields". */
export function fields(n: number): string {
  return `${n} ${n === 1 ? "field" : "fields"}`;
}
