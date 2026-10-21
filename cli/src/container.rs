//! Just enough of fragmented MP4 (ISO BMFF) and WebM (Matroska/EBML) to
//! describe a recording and to find where it stops being whole: the web app
//! only ever appends fragments or clusters, so a crash leaves a file that is
//! valid up to its last complete one.

use anyhow::{bail, Context, Result};
use serde::Serialize;
use std::io::{Read, Seek, SeekFrom};

#[derive(Debug, PartialEq, Eq, Clone, Copy, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    Mp4,
    Webm,
    Sealed,
    Unknown,
}

pub fn sniff(head: &[u8]) -> Kind {
    if head.starts_with(crate::seal::MAGIC) {
        Kind::Sealed
    } else if head.len() >= 8 && &head[4..8] == b"ftyp" {
        Kind::Mp4
    } else if head.starts_with(&[0x1a, 0x45, 0xdf, 0xa3]) {
        Kind::Webm
    } else {
        Kind::Unknown
    }
}

#[derive(Debug, Default, Serialize, Clone)]
pub struct Track {
    pub id: u64,
    pub kind: String,
    pub codec: String,
    #[serde(skip)]
    pub timescale: u64,
    pub duration: f64,
}

#[derive(Debug, Serialize)]
pub struct Info {
    pub container: Kind,
    pub size: u64,
    pub tracks: Vec<Track>,
    /// Fragments (MP4) or clusters (WebM).
    pub fragments: u64,
    pub duration: f64,
    /// Bytes from the start that form a whole file.
    pub valid_until: u64,
    /// False when the end is cut (a crash or a closed tab during recording).
    pub complete: bool,
}

// ── MP4 ─────────────────────────────────────────────────────────────────

struct BoxHeader {
    kind: [u8; 4],
    start: u64,
    header: u64,
    size: u64,
}

fn read_box_header(f: &mut (impl Read + Seek), at: u64, end: u64) -> Result<Option<BoxHeader>> {
    if at + 8 > end {
        return Ok(None);
    }
    f.seek(SeekFrom::Start(at))?;
    let mut h = [0u8; 16];
    f.read_exact(&mut h[..8])?;
    let small = u32::from_be_bytes(h[..4].try_into()?) as u64;
    let kind: [u8; 4] = h[4..8].try_into()?;
    let (size, header) = match small {
        1 => {
            if at + 16 > end {
                return Ok(None);
            }
            f.read_exact(&mut h[8..16])?;
            (u64::from_be_bytes(h[8..16].try_into()?), 16)
        }
        0 => (end - at, 8),
        n => (n, 8),
    };
    if size < header {
        bail!("corrupt box at {at}");
    }
    Ok(Some(BoxHeader { kind, start: at, header, size }))
}

/// Children of an in-memory box payload.
fn children(buf: &[u8]) -> Vec<(&[u8], [u8; 4])> {
    let mut out = Vec::new();
    let mut at = 0usize;
    while at + 8 <= buf.len() {
        let size = u32::from_be_bytes(buf[at..at + 4].try_into().unwrap_or_default()) as usize;
        let kind: [u8; 4] = buf[at + 4..at + 8].try_into().unwrap_or_default();
        let (hdr, size) = if size == 1 && at + 16 <= buf.len() {
            (16, u64::from_be_bytes(buf[at + 8..at + 16].try_into().unwrap_or_default()) as usize)
        } else {
            (8, size)
        };
        if size < hdr || at + size > buf.len() {
            break;
        }
        out.push((&buf[at + hdr..at + size], kind));
        at += size;
    }
    out
}

fn child<'a>(buf: &'a [u8], kind: &[u8; 4]) -> Option<&'a [u8]> {
    children(buf).into_iter().find(|(_, k)| k == kind).map(|(b, _)| b)
}

fn be(b: &[u8], at: usize, n: usize) -> u64 {
    b.get(at..at + n).map(|s| s.iter().fold(0u64, |acc, x| (acc << 8) | *x as u64)).unwrap_or(0)
}

fn fourcc(b: &[u8]) -> String {
    b.iter().map(|&c| if c.is_ascii_graphic() { c as char } else { '?' }).collect()
}

struct Mp4Track {
    track: Track,
    default_duration: u64,
    end: u64,
}

fn parse_moov(moov: &[u8]) -> Vec<Mp4Track> {
    let mut defaults = std::collections::HashMap::new();
    if let Some(mvex) = child(moov, b"mvex") {
        for (trex, k) in children(mvex) {
            if &k == b"trex" {
                defaults.insert(be(trex, 4, 4), be(trex, 12, 4));
            }
        }
    }
    let mut out = Vec::new();
    for (trak, k) in children(moov) {
        if &k != b"trak" {
            continue;
        }
        let tkhd = child(trak, b"tkhd").unwrap_or_default();
        let id = if tkhd.first() == Some(&1) { be(tkhd, 20, 4) } else { be(tkhd, 12, 4) };
        let mdia = child(trak, b"mdia").unwrap_or_default();
        let mdhd = child(mdia, b"mdhd").unwrap_or_default();
        let timescale = if mdhd.first() == Some(&1) { be(mdhd, 20, 4) } else { be(mdhd, 12, 4) };
        let handler = child(mdia, b"hdlr").map(|h| fourcc(h.get(8..12).unwrap_or_default())).unwrap_or_default();
        let codec = child(mdia, b"minf")
            .and_then(|m| child(m, b"stbl"))
            .and_then(|s| child(s, b"stsd"))
            .and_then(|s| s.get(12..16))
            .map(fourcc)
            .unwrap_or_default();
        let kind = match handler.as_str() {
            "vide" => "video",
            "soun" => "audio",
            other => other,
        }
        .to_string();
        out.push(Mp4Track {
            track: Track { id, kind, codec, timescale: timescale.max(1), duration: 0.0 },
            default_duration: *defaults.get(&id).unwrap_or(&0),
            end: 0,
        });
    }
    out
}

fn parse_moof(moof: &[u8], tracks: &mut [Mp4Track]) {
    for (traf, k) in children(moof) {
        if &k != b"traf" {
            continue;
        }
        let tfhd = child(traf, b"tfhd").unwrap_or_default();
        let flags = be(tfhd, 1, 3);
        let id = be(tfhd, 4, 4);
        let mut at = 8;
        if flags & 0x1 != 0 {
            at += 8;
        }
        if flags & 0x2 != 0 {
            at += 4;
        }
        let Some(t) = tracks.iter_mut().find(|t| t.track.id == id) else { continue };
        let default = if flags & 0x8 != 0 { be(tfhd, at, 4) } else { t.default_duration };
        let base = child(traf, b"tfdt").map(|d| if d.first() == Some(&1) { be(d, 4, 8) } else { be(d, 4, 4) });
        let mut sum = 0u64;
        for (trun, k) in children(traf) {
            if &k != b"trun" {
                continue;
            }
            let f = be(trun, 1, 3);
            let count = be(trun, 4, 4);
            let mut p = 8;
            if f & 0x1 != 0 {
                p += 4;
            }
            if f & 0x4 != 0 {
                p += 4;
            }
            let per = [0x100, 0x200, 0x400, 0x800].iter().filter(|b| f & **b != 0).count() * 4;
            for i in 0..count as usize {
                sum += if f & 0x100 != 0 { be(trun, p + i * per, 4) } else { default };
            }
        }
        let start = base.unwrap_or(t.end);
        t.end = t.end.max(start + sum);
    }
}

pub fn inspect_mp4(f: &mut (impl Read + Seek), size: u64) -> Result<Info> {
    let mut at = 0u64;
    let mut tracks = Vec::new();
    let mut fragments = 0u64;
    let mut valid_until = 0u64;
    let mut pending_moof: Option<Vec<u8>> = None;
    let mut seen_moov = false;
    while let Some(b) = read_box_header(f, at, size)? {
        if b.start + b.size > size {
            break; // cut in the middle of this box
        }
        match &b.kind {
            b"moov" | b"moof" => {
                let mut buf = vec![0u8; (b.size - b.header) as usize];
                f.seek(SeekFrom::Start(b.start + b.header))?;
                f.read_exact(&mut buf)?;
                if &b.kind == b"moov" {
                    tracks = parse_moov(&buf);
                    seen_moov = true;
                    valid_until = b.start + b.size;
                } else {
                    pending_moof = Some(buf);
                }
            }
            b"mdat" => {
                if let Some(moof) = pending_moof.take() {
                    parse_moof(&moof, &mut tracks);
                    fragments += 1;
                }
                valid_until = b.start + b.size;
            }
            _ => {
                if pending_moof.is_none() {
                    valid_until = b.start + b.size;
                }
            }
        }
        at = b.start + b.size;
    }
    if !seen_moov {
        bail!("no movie header: not a recording, or cut before its first second");
    }
    let tracks: Vec<Track> =
        tracks.into_iter().map(|t| Track { duration: t.end as f64 / t.track.timescale as f64, ..t.track }).collect();
    let duration = tracks.iter().map(|t| t.duration).fold(0.0, f64::max);
    Ok(Info { container: Kind::Mp4, size, tracks, fragments, duration, valid_until, complete: valid_until == size })
}

// ── WebM ────────────────────────────────────────────────────────────────

const SEGMENT: u64 = 0x18538067;
const INFO: u64 = 0x1549A966;
const TIMECODE_SCALE: u64 = 0x2AD7B1;
const TRACKS: u64 = 0x1654AE6B;
const TRACK_ENTRY: u64 = 0xAE;
const TRACK_NUMBER: u64 = 0xD7;
const TRACK_TYPE: u64 = 0x83;
const CODEC_ID: u64 = 0x86;
const CLUSTER: u64 = 0x1F43B675;
const CLUSTER_TIMECODE: u64 = 0xE7;
const SIMPLE_BLOCK: u64 = 0xA3;
const BLOCK_GROUP: u64 = 0xA0;
/// Elements that may follow a cluster at the segment level (ends an unknown-size cluster).
const SEGMENT_CHILDREN: [u64; 7] = [CLUSTER, 0x1C53BB6B, 0x1254C367, 0x114D9B74, INFO, TRACKS, 0x1941A469];

/// Reads an EBML variable-length integer: (value, length, all ones = unknown size).
fn vint(b: &[u8], keep_marker: bool) -> Option<(u64, usize, bool)> {
    let first = *b.first()?;
    let len = first.leading_zeros() as usize + 1;
    if len > 8 || b.len() < len {
        return None;
    }
    let mut v = if keep_marker { first as u64 } else { (first as u64) & (0xff >> len) };
    for x in &b[1..len] {
        v = (v << 8) | *x as u64;
    }
    let ones = (1u64 << (7 * len)) - 1;
    let unknown = !keep_marker && v == ones;
    Some((v, len, unknown))
}

struct Element {
    id: u64,
    data: usize,
    /// None when the size is unknown (live/append-only writing).
    size: Option<usize>,
    size_len: usize,
}

fn element(b: &[u8], at: usize) -> Option<Element> {
    let (id, il, _) = vint(b.get(at..)?, true)?;
    let (size, sl, unknown) = vint(b.get(at + il..)?, false)?;
    Some(Element { id, data: at + il + sl, size: if unknown { None } else { Some(size as usize) }, size_len: sl })
}

fn uint(b: &[u8]) -> u64 {
    b.iter().fold(0, |a, x| (a << 8) | *x as u64)
}

struct WebmScan {
    info: Info,
    /// Clusters whose declared size runs past the cut: (offset of the size field, its length, new size).
    resize: Vec<(usize, usize, u64)>,
    /// The segment's size field, when the segment declares a size the file no longer has.
    segment_size: Option<(usize, usize)>,
}

fn scan_webm(b: &[u8]) -> Result<WebmScan> {
    let size = b.len();
    let ebml = element(b, 0).context("not WebM")?;
    let seg_at = ebml.data + ebml.size.context("bad EBML header")?;
    let seg = element(b, seg_at).filter(|e| e.id == SEGMENT).context("no segment")?;
    let seg_end = seg.size.map(|s| (seg.data + s).min(size)).unwrap_or(size);
    let mut scale = 1_000_000u64;
    let mut tracks: Vec<Track> = Vec::new();
    let mut clusters = 0u64;
    let mut last_time = 0i64;
    let mut valid_until = seg.data;
    let mut resize = Vec::new();
    let mut at = seg.data;
    while at < seg_end {
        let Some(e) = element(b, at) else { break };
        match e.id {
            INFO | TRACKS => {
                let Some(len) = e.size.filter(|s| e.data + s <= size) else { break };
                let body = &b[e.data..e.data + len];
                if e.id == INFO {
                    let mut p = 0;
                    while let Some(c) = element(body, p) {
                        let Some(cl) = c.size else { break };
                        if c.id == TIMECODE_SCALE {
                            scale = uint(body.get(c.data..c.data + cl).unwrap_or_default()).max(1);
                        }
                        p = c.data + cl;
                    }
                } else {
                    let mut p = 0;
                    while let Some(te) = element(body, p) {
                        let Some(tl) = te.size else { break };
                        if te.id == TRACK_ENTRY {
                            let entry = body.get(te.data..te.data + tl).unwrap_or_default();
                            let mut t = Track::default();
                            let mut q = 0;
                            while let Some(c) = element(entry, q) {
                                let Some(cl) = c.size else { break };
                                let v = entry.get(c.data..c.data + cl).unwrap_or_default();
                                match c.id {
                                    TRACK_NUMBER => t.id = uint(v),
                                    TRACK_TYPE => {
                                        t.kind = match uint(v) {
                                            1 => "video".into(),
                                            2 => "audio".into(),
                                            n => n.to_string(),
                                        }
                                    }
                                    CODEC_ID => t.codec = String::from_utf8_lossy(v).into_owned(),
                                    _ => {}
                                }
                                q = c.data + cl;
                            }
                            tracks.push(t);
                        }
                        p = te.data + tl;
                    }
                }
                at = e.data + len;
                valid_until = at;
            }
            CLUSTER => {
                let declared_end = e.size.map(|s| e.data + s);
                let end = declared_end.unwrap_or(seg_end).min(seg_end);
                let mut p = e.data;
                let mut base = 0i64;
                let mut whole = e.data;
                while p < end {
                    let Some(c) = element(b, p) else { break };
                    if declared_end.is_none() && SEGMENT_CHILDREN.contains(&c.id) {
                        break; // next top-level element: an unknown-size cluster ends here
                    }
                    let Some(cl) = c.size else { break };
                    if c.data + cl > size {
                        break; // cut inside this block
                    }
                    let body = &b[c.data..c.data + cl];
                    match c.id {
                        CLUSTER_TIMECODE => base = uint(body) as i64,
                        SIMPLE_BLOCK | BLOCK_GROUP => {
                            let block = if c.id == BLOCK_GROUP {
                                element(body, 0).filter(|x| x.id == 0xA1).and_then(|x| body.get(x.data..))
                            } else {
                                Some(body)
                            };
                            if let Some(blk) = block {
                                if let Some((_, tl, _)) = vint(blk, false) {
                                    let rel = i16::from_be_bytes([
                                        *blk.get(tl).unwrap_or(&0),
                                        *blk.get(tl + 1).unwrap_or(&0),
                                    ]) as i64;
                                    last_time = last_time.max(base + rel);
                                }
                            }
                        }
                        _ => {}
                    }
                    p = c.data + cl;
                    whole = p;
                }
                if whole > e.data {
                    clusters += 1;
                    valid_until = whole;
                    if let Some(d) = declared_end {
                        if whole < d {
                            resize.push((e.data - e.size_len, e.size_len, (whole - e.data) as u64));
                        }
                    }
                }
                // Go on only past a whole cluster: its declared end, or (unknown size) the next top-level element.
                let whole_cluster = match declared_end {
                    Some(d) => d <= size && whole == d,
                    None => whole < end && element(b, whole).is_some_and(|c| SEGMENT_CHILDREN.contains(&c.id)),
                };
                if !whole_cluster {
                    break;
                }
                at = whole;
            }
            _ => {
                let Some(len) = e.size.filter(|s| e.data + s <= size) else { break };
                at = e.data + len;
                valid_until = at;
            }
        }
    }
    let duration = last_time as f64 * scale as f64 / 1e9;
    for t in &mut tracks {
        t.duration = duration;
    }
    let complete = valid_until == size && resize.is_empty();
    let segment_size = match seg.size {
        Some(s) if seg.data + s > valid_until => Some((seg.data - seg.size_len, seg.size_len)),
        _ => None,
    };
    Ok(WebmScan {
        info: Info {
            container: Kind::Webm,
            size: size as u64,
            tracks,
            fragments: clusters,
            duration,
            valid_until: valid_until as u64,
            complete,
        },
        resize,
        segment_size,
    })
}

pub fn inspect_webm(f: &mut impl Read) -> Result<Info> {
    let mut b = Vec::new();
    f.read_to_end(&mut b)?;
    Ok(scan_webm(&b)?.info)
}

/// Returns a whole file: the recording up to its last complete fragment or cluster.
pub fn repair(bytes: &[u8]) -> Result<(Vec<u8>, Info)> {
    match sniff(bytes) {
        Kind::Mp4 => {
            let info = inspect_mp4(&mut std::io::Cursor::new(bytes), bytes.len() as u64)?;
            Ok((bytes[..info.valid_until as usize].to_vec(), info))
        }
        Kind::Webm => {
            let scan = scan_webm(bytes)?;
            let mut out = bytes[..scan.info.valid_until as usize].to_vec();
            for (at, len, size) in &scan.resize {
                write_vint(&mut out[*at..*at + *len], *size)?;
            }
            if let Some((at, len)) = scan.segment_size {
                // "Unknown size": valid for a segment, and true once the end is cut.
                out[at] = 0xff >> (len - 1);
                for x in &mut out[at + 1..at + len] {
                    *x = 0xff;
                }
            }
            Ok((out, scan.info))
        }
        Kind::Sealed => bail!("this file is sealed: decrypt it first (obscura decrypt --partial)"),
        Kind::Unknown => bail!("not an MP4 or WebM recording"),
    }
}

/// Rewrites an EBML size in place, keeping its length.
fn write_vint(dst: &mut [u8], v: u64) -> Result<()> {
    let len = dst.len();
    if v >= (1u64 << (7 * len)) - 1 {
        bail!("size does not fit");
    }
    for (i, x) in dst.iter_mut().enumerate() {
        *x = (v >> (8 * (len - 1 - i))) as u8;
    }
    dst[0] |= 0x80 >> (len - 1);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mp4_box(kind: &[u8; 4], body: &[u8]) -> Vec<u8> {
        let mut out = ((body.len() + 8) as u32).to_be_bytes().to_vec();
        out.extend_from_slice(kind);
        out.extend_from_slice(body);
        out
    }

    fn full(kind: &[u8; 4], version: u8, flags: u32, body: &[u8]) -> Vec<u8> {
        let mut b = vec![version];
        b.extend_from_slice(&flags.to_be_bytes()[1..]);
        b.extend_from_slice(body);
        mp4_box(kind, &b)
    }

    fn sample_mp4() -> (Vec<u8>, usize) {
        let ftyp = mp4_box(b"ftyp", b"iso5\0\0\0\0");
        let mut tkhd = vec![0u8; 8];
        tkhd.extend_from_slice(&1u32.to_be_bytes());
        tkhd.extend_from_slice(&[0u8; 60]);
        let mut mdhd = vec![0u8; 8];
        mdhd.extend_from_slice(&1000u32.to_be_bytes());
        mdhd.extend_from_slice(&[0u8; 8]);
        let mut hdlr = vec![0u8; 4];
        hdlr.extend_from_slice(b"vide");
        hdlr.extend_from_slice(&[0u8; 13]);
        let mut stsd = 1u32.to_be_bytes().to_vec();
        stsd.extend_from_slice(&mp4_box(b"avc1", &[0u8; 8]));
        let stbl = mp4_box(b"stbl", &full(b"stsd", 0, 0, &stsd));
        let mdia = mp4_box(
            b"mdia",
            &[full(b"mdhd", 0, 0, &mdhd), full(b"hdlr", 0, 0, &hdlr), mp4_box(b"minf", &stbl)].concat(),
        );
        let trak = mp4_box(b"trak", &[full(b"tkhd", 0, 0, &tkhd), mdia].concat());
        let moov = mp4_box(b"moov", &[full(b"mvhd", 0, 0, &[0u8; 96]), trak].concat());
        let frag = |base: u32| {
            let tfhd = full(b"tfhd", 0, 0x8, &[1u32.to_be_bytes(), 40u32.to_be_bytes()].concat());
            let tfdt = full(b"tfdt", 0, 0, &base.to_be_bytes());
            let trun = full(b"trun", 0, 0, &25u32.to_be_bytes());
            let moof = mp4_box(b"moof", &mp4_box(b"traf", &[tfhd, tfdt, trun].concat()));
            [moof, mp4_box(b"mdat", &[1u8; 100])].concat()
        };
        let whole = [ftyp, moov, frag(0), frag(1000)].concat();
        let len = whole.len();
        ([whole, frag(2000)].concat(), len)
    }

    #[test]
    fn mp4_inspect_and_repair() {
        let (bytes, whole) = sample_mp4();
        let (fixed, info) = repair(&bytes).unwrap();
        assert!(info.complete);
        assert_eq!(info.fragments, 3);
        assert!((info.duration - 3.0).abs() < 1e-9, "{}", info.duration);
        assert_eq!(info.tracks[0].codec, "avc1");
        assert_eq!(fixed.len(), bytes.len());
        // Cut inside the third fragment's mdat: repair keeps the first two.
        let cut = &bytes[..bytes.len() - 30];
        let (fixed, info) = repair(cut).unwrap();
        assert!(!info.complete);
        assert_eq!(fixed.len(), whole);
        assert_eq!(info.fragments, 2);
    }

    /// An element with an 8-byte size field (room for repair to shrink it in place).
    fn ebml(id: &[u8], body: &[u8]) -> Vec<u8> {
        let mut sized = id.to_vec();
        let mut size = (body.len() as u64).to_be_bytes();
        size[0] = 0x01;
        sized.extend_from_slice(&size);
        sized.extend_from_slice(body);
        sized
    }

    fn sample_webm(unknown_cluster: bool) -> Vec<u8> {
        let header = ebml(&[0x1a, 0x45, 0xdf, 0xa3], &ebml(&[0x42, 0x82], b"webm"));
        let info = ebml(&[0x15, 0x49, 0xa9, 0x66], &ebml(&[0x2a, 0xd7, 0xb1], &[0x0f, 0x42, 0x40]));
        let entry = ebml(&[0xae], &[ebml(&[0xd7], &[1]), ebml(&[0x83], &[1]), ebml(&[0x86], b"V_VP9")].concat());
        let tracks = ebml(&[0x16, 0x54, 0xae, 0x6b], &entry);
        let cluster = |t: u8| {
            let block = |rel: u8| ebml(&[0xa3], &[0x81, 0, rel, 0x80, 9, 9, 9]);
            let body = [ebml(&[0xe7], &[t]), block(0), block(100)].concat();
            if unknown_cluster {
                [vec![0x1f, 0x43, 0xb6, 0x75, 0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff], body].concat()
            } else {
                ebml(&[0x1f, 0x43, 0xb6, 0x75], &body)
            }
        };
        let segment = [info, tracks, cluster(0), cluster(200)].concat();
        [header, vec![0x18, 0x53, 0x80, 0x67, 0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff], segment].concat()
    }

    #[test]
    fn webm_inspect_and_repair() {
        for unknown in [false, true] {
            let bytes = sample_webm(unknown);
            let info = scan_webm(&bytes).unwrap().info;
            assert!(info.complete, "unknown={unknown}");
            assert_eq!(info.fragments, 2);
            assert_eq!(info.tracks[0].codec, "V_VP9");
            assert!((info.duration - 0.3).abs() < 1e-9, "{}", info.duration);
            let cut = &bytes[..bytes.len() - 3];
            let (fixed, info) = repair(cut).unwrap();
            assert!(!info.complete);
            assert_eq!(info.fragments, 2);
            let again = scan_webm(&fixed).unwrap().info;
            assert!(again.complete, "repaired file is whole (unknown={unknown})");
            assert!((again.duration - 0.2).abs() < 1e-9);
        }
    }
}
