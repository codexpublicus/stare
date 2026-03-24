pub mod alto;
pub mod case;
pub mod config;
pub mod index;

#[cfg(not(target_arch = "wasm32"))]
pub mod resolve;
