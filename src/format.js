/** Shared number formatting for the CLIs and the live view. */

/** "12,345" with thousands separators, or "—" for a missing value. */
export const fmt = (n) => (n === null || n === undefined ? '—' : n.toLocaleString('en-US'));
