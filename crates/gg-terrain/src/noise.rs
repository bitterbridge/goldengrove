//! Integer-hash value noise. Deliberately libm-free: floor, multiplies, and
//! wrapping integer ops are bit-exact on every target, so the noise field is
//! cross-platform deterministic by construction.

use crate::sphere::V3;

fn hash3(seed: u64, x: i64, y: i64, z: i64) -> f64 {
    let mut h = seed ^ 0x9E37_79B9_7F4A_7C15;
    for v in [x as u64, y as u64, z as u64] {
        h ^= v.wrapping_mul(0xBF58_476D_1CE4_E5B9);
        h = h.rotate_left(31).wrapping_mul(0x94D0_49BB_1331_11EB);
    }
    // top 53 bits -> [-1, 1)
    ((h >> 11) as f64) / ((1u64 << 53) as f64) * 2.0 - 1.0
}

fn smooth(t: f64) -> f64 {
    t * t * (3.0 - 2.0 * t)
}

fn lerp(a: f64, b: f64, t: f64) -> f64 {
    a + (b - a) * t
}

fn value_noise(seed: u64, p: V3) -> f64 {
    let fx = p[0].floor();
    let fy = p[1].floor();
    let fz = p[2].floor();
    let (ix, iy, iz) = (fx as i64, fy as i64, fz as i64);
    let (tx, ty, tz) = (smooth(p[0] - fx), smooth(p[1] - fy), smooth(p[2] - fz));
    let c = |dx: i64, dy: i64, dz: i64| hash3(seed, ix + dx, iy + dy, iz + dz);
    let x00 = lerp(c(0, 0, 0), c(1, 0, 0), tx);
    let x10 = lerp(c(0, 1, 0), c(1, 1, 0), tx);
    let x01 = lerp(c(0, 0, 1), c(1, 0, 1), tx);
    let x11 = lerp(c(0, 1, 1), c(1, 1, 1), tx);
    lerp(lerp(x00, x10, ty), lerp(x01, x11, ty), tz)
}

/// Fractional Brownian motion: octaves of value noise, lacunarity 1.9,
/// gain 0.5, normalized to roughly [-1, 1].
pub fn fbm(seed: u64, p: V3, octaves: u32) -> f64 {
    let mut sum = 0.0;
    let mut amp = 0.5;
    let mut freq = 1.0;
    let mut total = 0.0;
    for k in 0..octaves {
        sum += amp
            * value_noise(
                seed.wrapping_add(k as u64),
                [p[0] * freq, p[1] * freq, p[2] * freq],
            );
        total += amp;
        amp *= 0.5;
        freq *= 1.9;
    }
    sum / total
}

/// Domain-warped fbm: bends ridgelines and coastlines out of the blocky
/// value-noise grid.
pub fn warped_fbm(seed: u64, p: V3, octaves: u32) -> f64 {
    let w = [
        fbm(seed ^ 0x1111, p, 3),
        fbm(seed ^ 0x2222, p, 3),
        fbm(seed ^ 0x3333, p, 3),
    ];
    fbm(
        seed,
        [p[0] + 0.4 * w[0], p[1] + 0.4 * w[1], p[2] + 0.4 * w[2]],
        octaves,
    )
}

/// Micro-detail: walking-scale relief below heightmap resolution
/// (wavelengths ~50 km down to ~45 m). Retuned 2026-07-04 after live QA
/// showed the spectrum-continuation amplitudes (A0≈0.0028) render as
/// glass: slopes were 0.2-0.5% at every scale. Targets now: ~5% slope at
/// 52 km, ~17% at 1 km, ~34% at 100 m before masking (elevation_fine
/// masks plains down to 25% of this). Gain raised to 0.8 (vs. an initial
/// 0.64 trial, which measured only ~0.007 RMS 1 km slope on seed 42 — well
/// under the walking-scale-relief floor): slower per-octave falloff shifts
/// more energy into the walking-scale band without increasing the total
/// octave-sum enough to threaten the coarse/fine seam budget (measured
/// worst-case seam ~0.11 of the 0.20 budget). Libm-free.
pub fn micro(seed: u64, p: V3) -> f64 {
    const A0: f64 = 0.07;
    const F0: f64 = 2.6 * 47.045_880_999_999_99; // 2.6 * 1.9^6 (unchanged)
    let mut sum = 0.0;
    let mut amp = A0;
    let mut freq = F0;
    for k in 0..12u64 {
        sum += amp
            * value_noise(
                seed ^ (0x4D49_4352 + k),
                [p[0] * freq, p[1] * freq, p[2] * freq],
            );
        amp *= 0.8;
        freq *= 1.9;
    }
    sum
}
