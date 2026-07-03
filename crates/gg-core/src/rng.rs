use rand::{Rng, SeedableRng};
use rand_pcg::Pcg64;

/// Deterministic RNG stream. Child streams are derived from the parent's
/// BASE seed (not its current state) plus a label, so adding new draw sites
/// in future versions never shifts existing streams.
pub struct RngStream {
    base: u64,
    rng: Pcg64,
}

const FNV_OFFSET: u64 = 0xcbf2_9ce4_8422_2325;
const FNV_PRIME: u64 = 0x0000_0100_0000_01b3;

/// FNV-1a over (seed bytes ++ label bytes). Implemented inline so the child
/// derivation can never change out from under us via a dependency update.
fn derive_seed(base: u64, label: &str) -> u64 {
    let mut h = FNV_OFFSET;
    for b in base.to_le_bytes() {
        h ^= u64::from(b);
        h = h.wrapping_mul(FNV_PRIME);
    }
    for b in label.as_bytes() {
        h ^= u64::from(*b);
        h = h.wrapping_mul(FNV_PRIME);
    }
    h
}

impl RngStream {
    pub fn root(seed: u64) -> Self {
        Self { base: seed, rng: Pcg64::seed_from_u64(seed) }
    }

    pub fn child(&self, label: &str) -> Self {
        let seed = derive_seed(self.base, label);
        Self { base: seed, rng: Pcg64::seed_from_u64(seed) }
    }

    pub fn uniform(&mut self, lo: f64, hi: f64) -> f64 {
        lo + (hi - lo) * self.rng.gen::<f64>()
    }

    pub fn log_uniform(&mut self, lo: f64, hi: f64) -> f64 {
        self.uniform(lo.ln(), hi.ln()).exp()
    }

    /// Sample p(x) ∝ x^(-alpha) on [lo, hi] by inverse CDF. Requires alpha != 1.
    pub fn power_law(&mut self, alpha: f64, lo: f64, hi: f64) -> f64 {
        let u = self.rng.gen::<f64>();
        let k = 1.0 - alpha;
        (lo.powf(k) * (1.0 - u) + hi.powf(k) * u).powf(1.0 / k)
    }

    pub fn chance(&mut self, p: f64) -> bool {
        self.rng.gen::<f64>() < p
    }

    pub fn pick_count(&mut self, lo: usize, hi: usize) -> usize {
        // Width-independent: sample a full u64 so 32-bit (wasm32) and 64-bit
        // targets consume the stream identically. Modulo bias is ~span/2^64 —
        // irrelevant for the tiny spans we draw (and determinism is what matters).
        let span = (hi - lo + 1) as u64;
        lo + (self.rng.gen::<u64>() % span) as usize
    }
}
