const U64_MAX = 0xffffffffffffffffn;

/** Extract a u64 decimal seed from a location hash like `#seed=42`. */
export function parseSeedFromHash(hash: string): string | null {
  const m = /^#seed=(\d+)$/.exec(hash);
  if (!m) return null;
  const s = m[1]!;
  try {
    return BigInt(s) <= U64_MAX ? s : null;
  } catch {
    return null;
  }
}

export function randomSeed(): string {
  const buf = new BigUint64Array(1);
  crypto.getRandomValues(buf);
  return buf[0]!.toString();
}
