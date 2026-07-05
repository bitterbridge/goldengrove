/**
 * Shared biome palette — THE single source of truth for biome colors.
 * Indices mirror `gg-climate`'s `Biome` enum (crates/gg-climate/src/lib.rs).
 */
export const BIOME_COUNT = 13;

export const BIOME_RGB: ReadonlyArray<readonly [number, number, number]> = [
  [12, 42, 82], // 0 DeepOcean
  [42, 92, 138], // 1 Shelf
  [207, 192, 154], // 2 Shore
  [238, 243, 246], // 3 IceCap
  [154, 160, 140], // 4 Tundra
  [63, 95, 66], // 5 BorealForest
  [79, 122, 69], // 6 TemperateForest
  [154, 168, 94], // 7 Grassland
  [185, 164, 95], // 8 Savanna
  [47, 107, 60], // 9 TropicalRainforest
  [217, 181, 120], // 10 HotDesert
  [179, 165, 142], // 11 ColdDesert
  [141, 133, 120], // 12 AlpineRock
];

/**
 * Biome color for a classification index, shaded like `hypsometricColor`'s
 * shade factor. Out-of-range indices clamp to 12 (AlpineRock grey) — the
 * pinned defensive rule for corrupt/unexpected classification data.
 */
export function biomeColor(classIndex: number, shade: number): [number, number, number] {
  const idx = classIndex >= 0 && classIndex < BIOME_COUNT ? classIndex : BIOME_COUNT - 1;
  const [r, g, b] = BIOME_RGB[idx]!;
  return [Math.min(255, r * shade), Math.min(255, g * shade), Math.min(255, b * shade)].map(Math.round) as [
    number,
    number,
    number,
  ];
}
