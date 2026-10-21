//! Passphrase → key: Argon2id v1.3, 32 bytes, with the costs from the header.
//! The passphrase is hashed as typed (UTF-8, no normalization), like the web app.

use anyhow::{anyhow, Result};
use argon2::{Algorithm, Argon2, Params, Version};
use zeroize::Zeroizing;

use crate::seal::KdfParams;

pub fn derive(passphrase: &[u8], salt: &[u8], k: KdfParams) -> Result<Zeroizing<[u8; 32]>> {
    let params = Params::new(k.m, k.t, k.p as u32, Some(32)).map_err(|e| anyhow!("bad key derivation costs: {e}"))?;
    let argon = Argon2::new(Algorithm::Argon2id, Version::V0x13, params);
    let mut key = Zeroizing::new([0u8; 32]);
    argon.hash_password_into(passphrase, salt, key.as_mut()).map_err(|e| anyhow!("key derivation failed: {e}"))?;
    Ok(key)
}
