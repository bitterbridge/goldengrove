//! Dump a generated system as pretty JSON: cargo run -p gg-gen --example dump -- <seed>

fn main() {
    let seed: u64 = std::env::args()
        .nth(1)
        .expect("usage: dump <seed>")
        .parse()
        .expect("seed must be a u64");
    let desc = gg_gen::generate(seed);
    println!("{}", serde_json::to_string_pretty(&desc).unwrap());
}
