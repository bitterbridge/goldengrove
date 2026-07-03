//! Deterministic transcendental math for generation paths.
//!
//! Rust's std float methods use the platform libm on native targets but
//! Rust-internal code on wasm32 — ULP-level differences that break the
//! bit-identical descriptor contract (the canonical target is wasm32; see
//! the spec's Determinism contract). `libm` computes identical bits on
//! every target. All descriptor-affecting code MUST use these wrappers.
//! IEEE-exact ops (`sqrt`, `powi`, `floor`, `round`, `fract`) are fine as
//! std methods. gg-ephemeris intentionally keeps std math: its output is
//! per-frame rendering, never byte-pinned.

#[inline]
pub fn powf(x: f64, y: f64) -> f64 {
    libm::pow(x, y)
}

#[inline]
pub fn ln(x: f64) -> f64 {
    libm::log(x)
}

#[inline]
pub fn exp(x: f64) -> f64 {
    libm::exp(x)
}

#[inline]
pub fn cbrt(x: f64) -> f64 {
    libm::cbrt(x)
}

#[inline]
pub fn cos(x: f64) -> f64 {
    libm::cos(x)
}
