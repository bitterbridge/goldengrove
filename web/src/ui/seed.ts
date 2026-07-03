const U64_MAX = 0xffffffffffffffffn;

/** Validate a bare decimal-u64 string; return its CANONICAL form (leading
 * zeros stripped) or null. The canonical form is what Rust emits back in
 * descriptor JSON, so URLs stay stable round-trip. */
export function parseSeedValue(s: string): string | null {
  if (!/^\d+$/.test(s)) return null;
  const v = BigInt(s); // cannot throw: regex guarantees digits
  return v <= U64_MAX ? v.toString() : null;
}

/** Extract a seed from a legacy `#seed=42`-style hash. */
export function parseSeedFromHash(hash: string): string | null {
  const m = /^#seed=(\d+)$/.exec(hash);
  return m ? parseSeedValue(m[1]!) : null;
}

export function randomSeed(): string {
  const buf = new BigUint64Array(1);
  crypto.getRandomValues(buf);
  return buf[0]!.toString();
}
