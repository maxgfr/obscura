//! obscura: the companion CLI of the obscura web studio. It opens sealed
//! recordings, checks and repairs recordings cut short by a crash, and
//! builds studio links — all offline.

mod container;
mod kdf;
mod scene;
mod seal;
#[cfg(test)]
mod vectors;

use anyhow::{bail, Context, Result};
use clap::{Parser, Subcommand};
use serde_json::json;
use std::fs::{self, File, OpenOptions};
use std::io::{self, BufReader, BufWriter, Cursor, Read, Write};
use std::path::{Path, PathBuf};
use zeroize::Zeroizing;

use container::Kind;
use seal::{Header, Outcome};

#[derive(Parser)]
#[command(name = "obscura", version, about = "Open, check and repair obscura recordings; build studio links. Offline.")]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Print a studio link with the default layout (screen, round camera, microphone).
    New {
        /// Where the studio lives.
        #[arg(long, default_value = scene::DEFAULT_BASE)]
        base: String,
    },
    /// Check, link or show a studio layout.
    #[command(subcommand)]
    Scene(SceneCmd),
    /// Decrypt a sealed recording (.obscura).
    Decrypt {
        input: PathBuf,
        /// Output file (default: the input without .obscura).
        #[arg(short, long)]
        output: Option<PathBuf>,
        /// Recover what was recorded before a crash cut the file short.
        #[arg(long)]
        partial: bool,
        /// Overwrite the output if it exists.
        #[arg(short, long)]
        force: bool,
        #[command(flatten)]
        pass: Pass,
    },
    /// Seal a file with a passphrase, in the web app's format.
    Encrypt {
        input: PathBuf,
        /// Output file (default: the input with .obscura appended).
        #[arg(short, long)]
        output: Option<PathBuf>,
        #[arg(short, long)]
        force: bool,
        #[command(flatten)]
        pass: Pass,
    },
    /// Describe a recording: container, tracks, duration, whether it is whole.
    Inspect {
        input: PathBuf,
        /// Sealed files: check every chunk with the passphrase (nothing is written).
        #[arg(long)]
        verify: bool,
        #[arg(long)]
        json: bool,
        #[command(flatten)]
        pass: Pass,
    },
    /// Keep a recording up to its last complete fragment (after a crash or a closed tab).
    Repair {
        input: PathBuf,
        #[arg(short, long)]
        output: Option<PathBuf>,
        #[arg(short, long)]
        force: bool,
    },
    /// Check that sealing and links work on this machine (offline).
    Selftest {
        #[arg(long)]
        json: bool,
    },
}

#[derive(Subcommand)]
enum SceneCmd {
    /// Validate a layout file (JSON) with the studio's rules.
    Check { file: PathBuf },
    /// Turn a layout file into a studio link.
    Link {
        file: PathBuf,
        #[arg(long, default_value = scene::DEFAULT_BASE)]
        base: String,
    },
    /// Print the layout inside a studio link, as JSON.
    Show { link: String },
}

#[derive(clap::Args)]
struct Pass {
    /// The passphrase (prefer the environment variable, or the prompt: arguments end up in shell history).
    #[arg(long, env = "OBSCURA_PASSPHRASE", hide_env_values = true)]
    passphrase: Option<String>,
}

impl Pass {
    fn get(&self, confirm: bool) -> Result<Zeroizing<String>> {
        if let Some(p) = &self.passphrase {
            return Ok(Zeroizing::new(p.clone()));
        }
        let p = Zeroizing::new(rpassword::prompt_password("Passphrase: ").context("cannot read the passphrase")?);
        if confirm {
            let again = Zeroizing::new(rpassword::prompt_password("Again: ")?);
            if *again != *p {
                bail!("the passphrases differ");
            }
        }
        if p.is_empty() {
            bail!("empty passphrase");
        }
        Ok(p)
    }
}

fn create(path: &Path, force: bool) -> Result<File> {
    let mut o = OpenOptions::new();
    o.write(true);
    if force {
        o.create(true).truncate(true);
    } else {
        o.create_new(true);
    }
    o.open(path).with_context(|| {
        if path.exists() && !force {
            format!("{} exists (use --force to overwrite)", path.display())
        } else {
            format!("cannot write {}", path.display())
        }
    })
}

fn mime_for(path: &Path) -> &'static str {
    match path.extension().and_then(|e| e.to_str()).map(str::to_ascii_lowercase).as_deref() {
        Some("mp4") => "video/mp4",
        Some("webm") => "video/webm",
        _ => "application/octet-stream",
    }
}

fn ext_for(mime: &str) -> &'static str {
    match mime {
        "video/mp4" => "mp4",
        "video/webm" => "webm",
        _ => "bin",
    }
}

fn decrypt_target(input: &Path, mime: &str) -> PathBuf {
    let s = input.to_string_lossy();
    match s.strip_suffix(".obscura") {
        Some(base) if !base.is_empty() => PathBuf::from(base),
        _ => PathBuf::from(format!("{s}.decrypted.{}", ext_for(mime))),
    }
}

fn decrypt(input: &Path, output: Option<PathBuf>, partial: bool, force: bool, pass: &Pass) -> Result<()> {
    let mut r = BufReader::with_capacity(
        1 << 20,
        File::open(input).with_context(|| format!("cannot open {}", input.display()))?,
    );
    let (header, raw) = Header::read(&mut r)?;
    let out_path = output.unwrap_or_else(|| decrypt_target(input, &header.mime));
    let passphrase = pass.get(false)?;
    eprintln!("deriving the key (Argon2id, {} MiB)…", header.kdf.m / 1024);
    let key = seal::derive(&passphrase, &header)?;
    let file = create(&out_path, force)?;
    let mut w = BufWriter::with_capacity(1 << 20, file);
    let res = seal::open(&mut r, &mut w, &header, &raw, &key, partial).and_then(|rep| {
        w.flush()?;
        Ok(rep)
    });
    match res {
        Ok(rep) => {
            if rep.outcome == Outcome::Truncated {
                eprintln!(
                    "warning: the recording was cut short; recovered {} bytes. Run `obscura repair` on the output if it does not play.",
                    rep.plaintext
                );
            }
            println!("{}", out_path.display());
            Ok(())
        }
        Err(e) => {
            drop(w);
            let _ = fs::remove_file(&out_path);
            Err(e)
        }
    }
}

fn encrypt(input: &Path, output: Option<PathBuf>, force: bool, pass: &Pass) -> Result<()> {
    let out_path = output.unwrap_or_else(|| PathBuf::from(format!("{}.obscura", input.display())));
    let passphrase = pass.get(true)?;
    let header = Header::fresh(mime_for(input), seal::DEFAULT_KDF)?;
    let key = seal::derive(&passphrase, &header)?;
    let mut r = BufReader::with_capacity(
        1 << 20,
        File::open(input).with_context(|| format!("cannot open {}", input.display()))?,
    );
    let mut w = BufWriter::with_capacity(1 << 20, create(&out_path, force)?);
    seal::seal(&mut r, &mut w, &key, &header)?;
    w.flush()?;
    println!("{}", out_path.display());
    Ok(())
}

fn inspect(input: &Path, verify: bool, as_json: bool, pass: &Pass) -> Result<()> {
    let mut f = File::open(input).with_context(|| format!("cannot open {}", input.display()))?;
    let mut head = [0u8; 16];
    let n = f.read(&mut head)?;
    let size = f.metadata()?.len();
    match container::sniff(&head[..n]) {
        Kind::Sealed => {
            let mut r = BufReader::new(File::open(input)?);
            let (h, raw) = Header::read(&mut r)?;
            let mut out = json!({
                "container": "sealed",
                "size": size,
                "mime": h.mime,
                "kdf": { "algorithm": "argon2id", "memory_kib": h.kdf.m, "iterations": h.kdf.t, "lanes": h.kdf.p },
                "chunk_size": h.chunk_size(),
            });
            if verify {
                let key = seal::derive(&pass.get(false)?, &h)?;
                let rep = seal::open(&mut r, &mut io::sink(), &h, &raw, &key, true)?;
                out["verified"] = json!({
                    "complete": rep.outcome == Outcome::Complete,
                    "chunks": rep.chunks,
                    "plaintext_bytes": rep.plaintext,
                });
            }
            if as_json {
                println!("{}", serde_json::to_string_pretty(&out)?);
            } else {
                println!("sealed recording ({} bytes), contains {}", size, h.mime);
                println!("key: Argon2id, {} MiB, {} passes, {} lane(s)", h.kdf.m / 1024, h.kdf.t, h.kdf.p);
                if let Some(v) = out.get("verified") {
                    if v["complete"] == json!(true) {
                        println!(
                            "verified: all {} chunks authentic, {} bytes inside",
                            v["chunks"], v["plaintext_bytes"]
                        );
                    } else {
                        println!(
                            "verified: cut short after {} authentic chunks ({} bytes); `obscura decrypt --partial` recovers them",
                            v["chunks"], v["plaintext_bytes"]
                        );
                    }
                } else {
                    println!("(add --verify to check every chunk with the passphrase)");
                }
            }
            Ok(())
        }
        Kind::Mp4 | Kind::Webm => {
            let mut f = File::open(input)?;
            let info = if container::sniff(&head[..n]) == Kind::Mp4 {
                container::inspect_mp4(&mut f, size)?
            } else {
                container::inspect_webm(&mut f)?
            };
            if as_json {
                println!("{}", serde_json::to_string_pretty(&info)?);
            } else {
                let kind = if info.container == Kind::Mp4 { "MP4 (fragmented)" } else { "WebM" };
                println!("{kind}, {} bytes, {:.2} s, {} fragments", info.size, info.duration, info.fragments);
                for t in &info.tracks {
                    println!("  track {}: {} {}", t.id, t.kind, t.codec);
                }
                if info.complete {
                    println!("whole: yes");
                } else {
                    println!(
                        "whole: no — cut at byte {}; `obscura repair` keeps the {} bytes before it",
                        info.size, info.valid_until
                    );
                }
            }
            Ok(())
        }
        Kind::Unknown => bail!("not an obscura recording (MP4, WebM or sealed)"),
    }
}

fn repair(input: &Path, output: Option<PathBuf>, force: bool) -> Result<()> {
    let bytes = fs::read(input).with_context(|| format!("cannot open {}", input.display()))?;
    let (fixed, info) = container::repair(&bytes)?;
    if info.complete {
        println!("{} is whole; nothing to repair", input.display());
        return Ok(());
    }
    let out_path = output.unwrap_or_else(|| {
        let stem = input.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
        let ext = input.extension().map(|e| e.to_string_lossy().into_owned()).unwrap_or_default();
        input.with_file_name(format!("{stem}.repaired.{ext}"))
    });
    create(&out_path, force)?.write_all(&fixed)?;
    eprintln!("kept {} of {} bytes ({} fragments, {:.2} s)", fixed.len(), bytes.len(), info.fragments, info.duration);
    println!("{}", out_path.display());
    Ok(())
}

fn selftest(as_json: bool) -> Result<()> {
    let mut checks = Vec::new();
    // Sealing round trip, with cheap costs (the format carries them).
    let header = Header { chunk_log2: 10, ..Header::fresh("video/mp4", seal::KdfParams { m: 256, t: 1, p: 1 })? };
    let key = seal::derive("selftest", &header)?;
    let data: Vec<u8> = (0..5000u32).map(|i| (i % 251) as u8).collect();
    let mut sealed = Vec::new();
    seal::seal(&mut Cursor::new(&data), &mut sealed, &key, &header)?;
    let mut r = Cursor::new(&sealed);
    let (h, raw) = Header::read(&mut r)?;
    let mut back = Vec::new();
    seal::open(&mut r, &mut back, &h, &raw, &key, false)?;
    if back != data {
        bail!("seal round trip mismatch");
    }
    checks.push("seal");
    let wrong = seal::derive("not it", &header)?;
    let mut r = Cursor::new(&sealed);
    Header::read(&mut r)?;
    if seal::open(&mut r, &mut io::sink(), &h, &raw, &wrong, false).is_ok() {
        bail!("a wrong passphrase opened the file");
    }
    checks.push("wrong-passphrase");
    let link = scene::encode_link(&scene::default_doc()?, scene::DEFAULT_BASE)?;
    scene::decode_link(&link)?;
    checks.push("link");
    if as_json {
        println!("{}", json!({ "ok": true, "version": env!("CARGO_PKG_VERSION"), "checks": checks }));
    } else {
        println!("ok: {}", checks.join(", "));
    }
    Ok(())
}

fn run(cli: Cli) -> Result<()> {
    match cli.command {
        Command::New { base } => {
            println!("{}", scene::encode_link(&scene::default_doc()?, &base)?);
            Ok(())
        }
        Command::Scene(SceneCmd::Check { file }) => {
            let v: serde_json::Value = serde_json::from_slice(&fs::read(&file)?).context("not JSON")?;
            scene::validate(&v)?;
            println!("ok");
            Ok(())
        }
        Command::Scene(SceneCmd::Link { file, base }) => {
            let v: serde_json::Value = serde_json::from_slice(&fs::read(&file)?).context("not JSON")?;
            println!("{}", scene::encode_link(&v, &base)?);
            Ok(())
        }
        Command::Scene(SceneCmd::Show { link }) => {
            println!("{}", serde_json::to_string_pretty(&scene::decode_link(&link)?)?);
            Ok(())
        }
        Command::Decrypt { input, output, partial, force, pass } => decrypt(&input, output, partial, force, &pass),
        Command::Encrypt { input, output, force, pass } => encrypt(&input, output, force, &pass),
        Command::Inspect { input, verify, json, pass } => inspect(&input, verify, json, &pass),
        Command::Repair { input, output, force } => repair(&input, output, force),
        Command::Selftest { json } => selftest(json),
    }
}

fn main() {
    if let Err(e) = run(Cli::parse()) {
        eprintln!("error: {e:#}");
        std::process::exit(1);
    }
}
