//! The web app's own output (cli/tests/vectors.json, written by scripts/vectors.ts)
//! must open here byte for byte.

use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use serde_json::Value;
use std::io::Cursor;

use crate::seal::{self, Header, KdfParams, Outcome};
use crate::{kdf, scene};

fn vectors() -> Value {
    serde_json::from_str(include_str!("../tests/vectors.json")).expect("vectors.json")
}

fn b64(v: &Value) -> Vec<u8> {
    STANDARD.decode(v.as_str().expect("string")).expect("base64")
}

#[test]
fn argon2id_key_matches_the_web_app() {
    let v = vectors();
    let k = &v["kdf"];
    let salt: Vec<u8> =
        (0..16).map(|i| u8::from_str_radix(&k["salt"].as_str().unwrap()[2 * i..2 * i + 2], 16).unwrap()).collect();
    let params = KdfParams {
        m: k["m"].as_u64().unwrap() as u32,
        t: k["t"].as_u64().unwrap() as u32,
        p: k["p"].as_u64().unwrap() as u8,
    };
    let key = kdf::derive(k["passphrase"].as_str().unwrap().as_bytes(), &salt, params).unwrap();
    let hex: String = key.iter().map(|b| format!("{b:02x}")).collect();
    assert_eq!(hex, k["key"].as_str().unwrap());
}

fn open(bytes: &[u8], pass: &str, partial: bool) -> anyhow::Result<(Vec<u8>, Outcome)> {
    let mut r = Cursor::new(bytes);
    let (h, raw): (Header, Vec<u8>) = Header::read(&mut r)?;
    let key = seal::derive(pass, &h)?;
    let mut out = Vec::new();
    let rep = seal::open(&mut r, &mut out, &h, &raw, &key, partial)?;
    Ok((out, rep.outcome))
}

#[test]
fn opens_a_file_sealed_by_the_web_app() {
    let v = vectors();
    let s = &v["sealed"];
    let pass = s["passphrase"].as_str().unwrap();
    let (out, outcome) = open(&b64(&s["file"]), pass, false).unwrap();
    assert_eq!(outcome, Outcome::Complete);
    assert_eq!(out, b64(&s["plaintext"]));
    assert!(open(&b64(&s["file"]), "wrong", false).is_err());
    assert!(open(&b64(&s["truncated"]), pass, false).is_err());
    let (part, outcome) = open(&b64(&s["truncated"]), pass, true).unwrap();
    assert_eq!(outcome, Outcome::Truncated);
    assert_eq!(part, b64(&s["truncated_plaintext"]));
}

#[test]
fn reads_a_link_made_by_the_web_app() {
    let v = vectors();
    let doc = scene::decode_link(&format!("#{}", v["link"]["fragment"].as_str().unwrap())).unwrap();
    assert_eq!(doc, v["link"]["doc"]);
}
