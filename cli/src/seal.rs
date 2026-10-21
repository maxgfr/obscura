//! Sealed recordings (FORMAT.md), byte-compatible with the web app's
//! `src/crypto/format.ts` and `src/crypto/stream.ts`: a header naming the
//! Argon2id costs and salt, then AES-256-GCM chunks whose nonce is
//! `prefix(7) ‖ counter u32 BE ‖ last(1)` and whose AAD is SHA-256(header).

use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{Aes256Gcm, Nonce};
use anyhow::{bail, Context, Result};
use sha2::{Digest, Sha256};
use std::io::{BufRead, Read, Write};
use zeroize::Zeroizing;

use crate::kdf;

pub const MAGIC: &[u8; 8] = b"OBSCURA1";
pub const KDF_ARGON2ID: u8 = 1;
pub const SALT_LEN: usize = 16;
pub const PREFIX_LEN: usize = 7;
pub const TAG_LEN: usize = 16;
pub const DEFAULT_CHUNK_LOG2: u8 = 16;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct KdfParams {
    pub m: u32,
    pub t: u32,
    pub p: u8,
}

pub const DEFAULT_KDF: KdfParams = KdfParams { m: 64 * 1024, t: 3, p: 1 };

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Header {
    pub kdf: KdfParams,
    pub salt: [u8; SALT_LEN],
    pub prefix: [u8; PREFIX_LEN],
    pub chunk_log2: u8,
    pub mime: String,
}

impl Header {
    pub fn chunk_size(&self) -> usize {
        1usize << self.chunk_log2
    }

    pub fn encode(&self) -> Result<Vec<u8>> {
        check(&self.kdf, self.chunk_log2)?;
        let mime = self.mime.as_bytes();
        if mime.len() > 255 {
            bail!("mime too long");
        }
        let mut out = Vec::with_capacity(44 + mime.len());
        out.extend_from_slice(MAGIC);
        out.push(KDF_ARGON2ID);
        out.extend_from_slice(&self.kdf.m.to_be_bytes());
        out.extend_from_slice(&self.kdf.t.to_be_bytes());
        out.push(self.kdf.p);
        out.extend_from_slice(&self.salt);
        out.extend_from_slice(&self.prefix);
        out.push(self.chunk_log2);
        out.extend_from_slice(&(mime.len() as u16).to_be_bytes());
        out.extend_from_slice(mime);
        Ok(out)
    }

    /// Reads a header; returns it with its raw bytes (the AAD is their hash).
    pub fn read(r: &mut impl Read) -> Result<(Header, Vec<u8>)> {
        let mut fixed = [0u8; 44];
        r.read_exact(&mut fixed).context("not a sealed recording (too short)")?;
        if &fixed[..8] != MAGIC {
            bail!("not a sealed recording (bad magic)");
        }
        if fixed[8] != KDF_ARGON2ID {
            bail!("unknown key derivation {}", fixed[8]);
        }
        let kdf = KdfParams {
            m: u32::from_be_bytes(fixed[9..13].try_into()?),
            t: u32::from_be_bytes(fixed[13..17].try_into()?),
            p: fixed[17],
        };
        let chunk_log2 = fixed[41];
        check(&kdf, chunk_log2)?;
        let mime_len = u16::from_be_bytes(fixed[42..44].try_into()?) as usize;
        if mime_len > 255 {
            bail!("mime too long");
        }
        let mut mime = vec![0u8; mime_len];
        r.read_exact(&mut mime).context("truncated header")?;
        let mut raw = fixed.to_vec();
        raw.extend_from_slice(&mime);
        let header = Header {
            kdf,
            salt: fixed[18..34].try_into()?,
            prefix: fixed[34..41].try_into()?,
            chunk_log2,
            mime: String::from_utf8(mime).context("mime is not UTF-8")?,
        };
        Ok((header, raw))
    }

    pub fn fresh(mime: &str, kdf: KdfParams) -> Result<Header> {
        let mut salt = [0u8; SALT_LEN];
        let mut prefix = [0u8; PREFIX_LEN];
        getrandom::fill(&mut salt).map_err(|e| anyhow::anyhow!("no randomness: {e}"))?;
        getrandom::fill(&mut prefix).map_err(|e| anyhow::anyhow!("no randomness: {e}"))?;
        Ok(Header { kdf, salt, prefix, chunk_log2: DEFAULT_CHUNK_LOG2, mime: mime.to_string() })
    }
}

/// The bounds a reader accepts, so a forged header cannot make it allocate gigabytes.
fn check(k: &KdfParams, chunk_log2: u8) -> Result<()> {
    if !(1..=8).contains(&k.p) {
        bail!("bad lanes");
    }
    if !(1..=16).contains(&k.t) {
        bail!("bad iterations");
    }
    if k.m < 8.max(8 * k.p as u32) || k.m > 1024 * 1024 {
        bail!("bad memory cost");
    }
    if !(10..=24).contains(&chunk_log2) {
        bail!("bad chunk size");
    }
    Ok(())
}

pub fn nonce(prefix: &[u8; PREFIX_LEN], counter: u32, last: bool) -> [u8; 12] {
    let mut n = [0u8; 12];
    n[..7].copy_from_slice(prefix);
    n[7..11].copy_from_slice(&counter.to_be_bytes());
    n[11] = last as u8;
    n
}

pub fn cipher(key: &[u8; 32]) -> Aes256Gcm {
    Aes256Gcm::new_from_slice(key).expect("32-byte key")
}

pub fn derive(passphrase: &str, h: &Header) -> Result<Zeroizing<[u8; 32]>> {
    kdf::derive(passphrase.as_bytes(), &h.salt, h.kdf)
}

/// Seals `input` to `out`. Chunks are emitted only when more than a chunk is
/// buffered, so the last chunk is never empty unless the input is.
pub fn seal(input: &mut impl Read, out: &mut impl Write, key: &[u8; 32], header: &Header) -> Result<u64> {
    let raw = header.encode()?;
    let aad: [u8; 32] = Sha256::digest(&raw).into();
    let aes = cipher(key);
    out.write_all(&raw)?;
    let size = header.chunk_size();
    let mut cur = read_full(input, size)?;
    let mut counter: u32 = 0;
    let mut written = raw.len() as u64;
    loop {
        let next = if cur.len() == size { read_full(input, size)? } else { Vec::new() };
        let last = next.is_empty();
        let n = nonce(&header.prefix, counter, last);
        let ct = aes
            .encrypt(Nonce::from_slice(&n), Payload { msg: &cur, aad: &aad })
            .map_err(|_| anyhow::anyhow!("encryption failed"))?;
        out.write_all(&ct)?;
        written += ct.len() as u64;
        if last {
            return Ok(written);
        }
        counter = counter.checked_add(1).context("too many chunks")?;
        cur = next;
    }
}

fn read_full(r: &mut impl Read, size: usize) -> Result<Vec<u8>> {
    let mut buf = vec![0u8; size];
    let mut n = 0;
    while n < size {
        let k = r.read(&mut buf[n..])?;
        if k == 0 {
            break;
        }
        n += k;
    }
    buf.truncate(n);
    Ok(buf)
}

#[derive(Debug, PartialEq, Eq)]
pub enum Outcome {
    Complete,
    /// The stream ended before its last chunk (a crash); everything authenticated was written.
    Truncated,
}

pub struct OpenReport {
    pub outcome: Outcome,
    pub chunks: u32,
    pub plaintext: u64,
}

/// Opens a sealed stream chunk by chunk. With `partial`, a stream cut short
/// yields what was authenticated so far instead of an error. `out` may be a
/// sink (verification without writing).
pub fn open(
    input: &mut impl BufRead,
    out: &mut impl Write,
    header: &Header,
    raw_header: &[u8],
    key: &[u8; 32],
    partial: bool,
) -> Result<OpenReport> {
    let aad: [u8; 32] = Sha256::digest(raw_header).into();
    let aes = cipher(key);
    let sealed = header.chunk_size() + TAG_LEN;
    let mut counter: u32 = 0;
    let mut plaintext = 0u64;
    let truncated = |counter, plaintext| Ok(OpenReport { outcome: Outcome::Truncated, chunks: counter, plaintext });
    loop {
        let chunk = read_full(input, sealed)?;
        if chunk.len() < TAG_LEN {
            if partial && counter > 0 {
                return truncated(counter, plaintext);
            }
            bail!("truncated: the last chunk is missing");
        }
        // Last when nothing follows a full chunk, or when the chunk is short.
        let last = chunk.len() < sealed || input.fill_buf()?.is_empty();
        let try_open = |flag: bool| {
            aes.decrypt(Nonce::from_slice(&nonce(&header.prefix, counter, flag)), Payload { msg: &chunk, aad: &aad })
        };
        match try_open(last) {
            Ok(pt) => {
                out.write_all(&pt)?;
                plaintext += pt.len() as u64;
            }
            Err(_) => {
                if last && chunk.len() == sealed {
                    // A full chunk at the very end that only opens as "not last": the stream was cut here.
                    if let Ok(pt) = try_open(false) {
                        if partial {
                            out.write_all(&pt)?;
                            return truncated(counter + 1, plaintext + pt.len() as u64);
                        }
                        bail!("truncated: the last chunk is missing (use --partial to recover what is there)");
                    }
                }
                if counter == 0 {
                    bail!("wrong passphrase, or not an intact recording");
                }
                if partial {
                    return truncated(counter, plaintext);
                }
                bail!("chunk {counter} failed to authenticate (truncated or tampered; --partial recovers what is before it)");
            }
        }
        counter = counter.checked_add(1).context("too many chunks")?;
        if last {
            return Ok(OpenReport { outcome: Outcome::Complete, chunks: counter, plaintext });
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    const FAST: KdfParams = KdfParams { m: 64, t: 1, p: 1 };

    fn header() -> Header {
        Header { chunk_log2: 10, ..Header::fresh("video/mp4", FAST).unwrap() }
    }

    fn roundtrip(len: usize) {
        let h = header();
        let key = [7u8; 32];
        let data: Vec<u8> = (0..len).map(|i| (i * 31 % 251) as u8).collect();
        let mut sealed = Vec::new();
        seal(&mut Cursor::new(&data), &mut sealed, &key, &h).unwrap();
        let mut r = Cursor::new(&sealed);
        let (h2, raw) = Header::read(&mut r).unwrap();
        assert_eq!(h2, h);
        let mut out = Vec::new();
        let rep = open(&mut r, &mut out, &h2, &raw, &key, false).unwrap();
        assert_eq!(rep.outcome, Outcome::Complete);
        assert_eq!(out, data);
    }

    #[test]
    fn roundtrips_across_chunk_boundaries() {
        for len in [0, 1, 1023, 1024, 1025, 2048, 5000] {
            roundtrip(len);
        }
    }

    #[test]
    fn detects_truncation_and_recovers_with_partial() {
        let h = header();
        let key = [9u8; 32];
        let data = vec![42u8; 5000];
        let mut sealed = Vec::new();
        seal(&mut Cursor::new(&data), &mut sealed, &key, &h).unwrap();
        let raw = h.encode().unwrap();
        let cut = &sealed[..raw.len() + 2 * 1040];
        let mut r = Cursor::new(cut);
        let (h2, raw2) = Header::read(&mut r).unwrap();
        assert!(open(&mut r, &mut Vec::new(), &h2, &raw2, &key, false).is_err());
        let mut r = Cursor::new(cut);
        Header::read(&mut r).unwrap();
        let mut out = Vec::new();
        let rep = open(&mut r, &mut out, &h2, &raw2, &key, true).unwrap();
        assert_eq!(rep.outcome, Outcome::Truncated);
        assert_eq!(out, &data[..2048]);
    }

    #[test]
    fn rejects_wrong_key_and_tampering() {
        let h = header();
        let mut sealed = Vec::new();
        seal(&mut Cursor::new(vec![1u8; 3000]), &mut sealed, &[1u8; 32], &h).unwrap();
        let mut r = Cursor::new(&sealed);
        let (h2, raw) = Header::read(&mut r).unwrap();
        assert!(open(&mut r, &mut Vec::new(), &h2, &raw, &[2u8; 32], false).is_err());
        let mut bad = sealed.clone();
        let at = bad.len() - 5;
        bad[at] ^= 1;
        let mut r = Cursor::new(&bad);
        Header::read(&mut r).unwrap();
        assert!(open(&mut r, &mut Vec::new(), &h2, &raw, &[1u8; 32], false).is_err());
    }

    #[test]
    fn rejects_hostile_headers() {
        let mut raw = header().encode().unwrap();
        raw[9..13].copy_from_slice(&u32::MAX.to_be_bytes());
        assert!(Header::read(&mut Cursor::new(&raw)).is_err());
        let mut raw = header().encode().unwrap();
        raw[0] = b'X';
        assert!(Header::read(&mut Cursor::new(&raw)).is_err());
    }
}
