//! Studio documents and links, mirroring `src/studio/scene.ts`: the same
//! fields, bounds and strictness (unknown fields are refused, so nothing like
//! a device id can ride along). A link is `#s=` + base64url(deflate-raw(JSON)).

use anyhow::{anyhow, bail, Context, Result};
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use flate2::read::{DeflateDecoder, DeflateEncoder};
use flate2::Compression;
use serde_json::{json, Map, Value};
use std::collections::HashSet;
use std::io::Read;

pub const DEFAULT_BASE: &str = "https://maxgfr.github.io/obscura/";
const MAX_SCENES: usize = 20;
const MAX_LAYERS: usize = 32;
const MAX_NAME: usize = 60;
const MAX_TEXT: usize = 500;
const MAX_LINK: usize = 16_000;
const MAX_JSON: u64 = 256 * 1024;
const KINDS: [&str; 8] = ["display", "camera", "image", "text", "color", "mask", "mic", "guest"];

pub fn new_id() -> Result<String> {
    let mut b = [0u8; 8];
    getrandom::fill(&mut b).map_err(|e| anyhow!("no randomness: {e}"))?;
    Ok(b.iter().map(|x| std::char::from_digit((x % 36) as u32, 36).unwrap_or('0')).collect())
}

fn layer(kind: &str, name: &str, rect: [f64; 4]) -> Result<Value> {
    let mut l = json!({
        "id": new_id()?, "kind": kind, "name": name, "visible": true, "locked": false,
        "rect": { "x": rect[0], "y": rect[1], "w": rect[2], "h": rect[3] },
        "crop": { "l": 0, "t": 0, "r": 0, "b": 0 },
        "opacity": 1, "radius": 0, "shape": "rect", "flip": false, "chroma": null,
    });
    let o = l.as_object_mut().expect("object");
    match kind {
        "display" => {
            o.insert("source".into(), json!(new_id()?));
            o.insert("audio".into(), json!({ "gain": 1, "muted": false, "noise": "off" }));
        }
        "mic" => {
            o.insert("source".into(), json!(new_id()?));
            o.insert("audio".into(), json!({ "gain": 1, "muted": false, "noise": "browser" }));
        }
        "camera" => {
            o.insert("source".into(), json!(new_id()?));
        }
        _ => {}
    }
    Ok(l)
}

/// The studio's starting layout: a screen with a round camera bubble and a microphone.
pub fn default_doc() -> Result<Value> {
    let aspect = 16.0 / 9.0;
    let (w, h) = (0.2, 0.2 * aspect);
    let mut cam = layer("camera", "Camera", [1.0 - w - 0.025, 1.0 - h - 0.025 * aspect, w, h])?;
    cam["radius"] = json!(0.5);
    cam["shape"] = json!("circle");
    cam["flip"] = json!(true);
    Ok(json!({
        "v": 1,
        "canvas": { "width": 1920, "height": 1080, "fps": 30 },
        "transition": { "kind": "fade", "ms": 300 },
        "active": 0,
        "scenes": [{
            "id": new_id()?, "name": "Screen + camera",
            "layers": [layer("display", "Screen", [0.0, 0.0, 1.0, 1.0])?, cam, layer("mic", "Microphone", [0.0, 0.0, 1.0, 1.0])?],
        }],
    }))
}

// ── Validation ──────────────────────────────────────────────────────────

fn obj<'a>(v: &'a Value, at: &str) -> Result<&'a Map<String, Value>> {
    v.as_object().ok_or_else(|| anyhow!("{at}: expected an object"))
}

fn only(o: &Map<String, Value>, keys: &[&str], at: &str) -> Result<()> {
    for k in o.keys() {
        if !keys.contains(&k.as_str()) {
            bail!("{at}: unknown field \"{k}\"");
        }
    }
    Ok(())
}

fn num(v: Option<&Value>, min: f64, max: f64, at: &str) -> Result<f64> {
    match v.and_then(Value::as_f64) {
        Some(n) if n.is_finite() && n >= min && n <= max => Ok(n),
        _ => bail!("{at}: expected a number in [{min}, {max}]"),
    }
}

fn int(v: Option<&Value>, min: f64, max: f64, at: &str) -> Result<f64> {
    let n = num(v, min, max, at)?;
    if n.fract() != 0.0 {
        bail!("{at}: expected an integer");
    }
    Ok(n)
}

fn boolean(v: Option<&Value>, at: &str) -> Result<()> {
    v.and_then(Value::as_bool).map(|_| ()).ok_or_else(|| anyhow!("{at}: expected a boolean"))
}

fn string(v: Option<&Value>, max: usize, at: &str) -> Result<()> {
    match v.and_then(Value::as_str) {
        // Same unit as JavaScript's length: UTF-16 code units.
        Some(s) if s.encode_utf16().count() <= max => Ok(()),
        _ => bail!("{at}: expected a string of at most {max} characters"),
    }
}

fn one_of(v: Option<&Value>, values: &[Value], at: &str) -> Result<()> {
    match v {
        Some(x) if values.contains(x) => Ok(()),
        _ => bail!("{at}: expected one of {}", values.iter().map(Value::to_string).collect::<Vec<_>>().join(", ")),
    }
}

fn color(v: Option<&Value>, at: &str) -> Result<()> {
    match v.and_then(Value::as_str) {
        Some(s) if s.len() == 7 && s.starts_with('#') && s[1..].chars().all(|c| matches!(c, '0'..='9' | 'a'..='f')) => {
            Ok(())
        }
        _ => bail!("{at}: expected #rrggbb"),
    }
}

fn id(v: Option<&Value>, at: &str) -> Result<String> {
    match v.and_then(Value::as_str) {
        Some(s)
            if !s.is_empty() && s.len() <= 16 && s.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit()) =>
        {
            Ok(s.to_string())
        }
        _ => bail!("{at}: bad id"),
    }
}

fn strs(v: &[&str]) -> Vec<Value> {
    v.iter().map(|s| json!(s)).collect()
}

fn validate_layer(v: &Value, at: &str, ids: &mut HashSet<String>) -> Result<()> {
    let o = obj(v, at)?;
    only(
        o,
        &[
            "id", "kind", "name", "visible", "locked", "rect", "crop", "opacity", "radius", "shape", "flip", "chroma",
            "text", "color", "mask", "audio", "image", "source",
        ],
        at,
    )?;
    one_of(o.get("kind"), &strs(&KINDS), &format!("{at}.kind"))?;
    let kind = o["kind"].as_str().unwrap_or_default();
    let r = obj(o.get("rect").unwrap_or(&Value::Null), &format!("{at}.rect"))?;
    only(r, &["x", "y", "w", "h"], &format!("{at}.rect"))?;
    let c = obj(o.get("crop").unwrap_or(&Value::Null), &format!("{at}.crop"))?;
    only(c, &["l", "t", "r", "b"], &format!("{at}.crop"))?;
    let mut crop = [0.0; 4];
    for (i, k) in ["l", "t", "r", "b"].iter().enumerate() {
        crop[i] = num(c.get(*k), 0.0, 0.95, &format!("{at}.crop.{k}"))?;
    }
    if crop[0] + crop[2] >= 0.98 || crop[1] + crop[3] >= 0.98 {
        bail!("{at}.crop: nothing left to show");
    }
    let layer_id = id(o.get("id"), &format!("{at}.id"))?;
    if !ids.insert(layer_id.clone()) {
        bail!("{at}: duplicate id {layer_id}");
    }
    string(o.get("name"), MAX_NAME, &format!("{at}.name"))?;
    boolean(o.get("visible"), &format!("{at}.visible"))?;
    boolean(o.get("locked"), &format!("{at}.locked"))?;
    num(r.get("x"), -2.0, 3.0, &format!("{at}.rect.x"))?;
    num(r.get("y"), -2.0, 3.0, &format!("{at}.rect.y"))?;
    num(r.get("w"), 0.005, 4.0, &format!("{at}.rect.w"))?;
    num(r.get("h"), 0.005, 4.0, &format!("{at}.rect.h"))?;
    num(o.get("opacity"), 0.0, 1.0, &format!("{at}.opacity"))?;
    num(o.get("radius"), 0.0, 0.5, &format!("{at}.radius"))?;
    one_of(o.get("shape"), &strs(&["rect", "circle"]), &format!("{at}.shape"))?;
    boolean(o.get("flip"), &format!("{at}.flip"))?;
    match o.get("chroma") {
        Some(Value::Null) => {}
        Some(k) => {
            let k = obj(k, &format!("{at}.chroma"))?;
            only(k, &["color", "similarity", "smoothness"], &format!("{at}.chroma"))?;
            color(k.get("color"), &format!("{at}.chroma.color"))?;
            num(k.get("similarity"), 0.0, 1.0, &format!("{at}.chroma.similarity"))?;
            num(k.get("smoothness"), 0.0, 1.0, &format!("{at}.chroma.smoothness"))?;
        }
        None => bail!("{at}.chroma: expected an object"),
    }
    let rule = |field: &str, applies: bool| -> Result<()> {
        match (applies, o.contains_key(field)) {
            (true, false) if field != "image" => bail!("{at}: a {kind} layer needs \"{field}\""),
            (false, true) => bail!("{at}: \"{field}\" does not apply to a {kind} layer"),
            _ => Ok(()),
        }
    };
    rule("text", kind == "text")?;
    rule("color", kind == "color")?;
    rule("mask", kind == "mask")?;
    rule("audio", matches!(kind, "mic" | "display" | "guest"))?;
    rule("image", kind == "image")?;
    rule("source", matches!(kind, "display" | "camera" | "mic" | "guest"))?;
    if let Some(t) = o.get("text") {
        let a = format!("{at}.text");
        let t = obj(t, &a)?;
        only(t, &["value", "font", "size", "weight", "color", "background", "align"], &a)?;
        string(t.get("value"), MAX_TEXT, &format!("{a}.value"))?;
        one_of(t.get("font"), &strs(&["sans", "serif", "mono"]), &format!("{a}.font"))?;
        int(t.get("size"), 8.0, 400.0, &format!("{a}.size"))?;
        one_of(t.get("weight"), &[json!(400), json!(700)], &format!("{a}.weight"))?;
        color(t.get("color"), &format!("{a}.color"))?;
        if t.get("background") != Some(&Value::Null) {
            color(t.get("background"), &format!("{a}.background"))?;
        }
        one_of(t.get("align"), &strs(&["left", "center", "right"]), &format!("{a}.align"))?;
    }
    if o.contains_key("color") {
        color(o.get("color"), &format!("{at}.color"))?;
    }
    if let Some(m) = o.get("mask") {
        let a = format!("{at}.mask");
        let m = obj(m, &a)?;
        only(m, &["mode", "color", "block"], &a)?;
        one_of(m.get("mode"), &strs(&["solid", "pixelate"]), &format!("{a}.mode"))?;
        color(m.get("color"), &format!("{a}.color"))?;
        int(m.get("block"), 4.0, 128.0, &format!("{a}.block"))?;
    }
    if let Some(au) = o.get("audio") {
        let a = format!("{at}.audio");
        let au = obj(au, &a)?;
        only(au, &["gain", "muted", "noise"], &a)?;
        num(au.get("gain"), 0.0, 4.0, &format!("{a}.gain"))?;
        boolean(au.get("muted"), &format!("{a}.muted"))?;
        one_of(au.get("noise"), &strs(&["off", "browser", "rnnoise"]), &format!("{a}.noise"))?;
    }
    if o.contains_key("image") {
        id(o.get("image"), &format!("{at}.image"))?;
    }
    if o.contains_key("source") {
        id(o.get("source"), &format!("{at}.source"))?;
    }
    Ok(())
}

/// Checks a studio document with the web app's rules.
pub fn validate(v: &Value) -> Result<()> {
    let o = obj(v, "doc")?;
    only(o, &["v", "canvas", "transition", "active", "scenes"], "doc")?;
    if o.get("v") != Some(&json!(1)) {
        bail!("doc.v: unsupported version");
    }
    let c = obj(o.get("canvas").unwrap_or(&Value::Null), "doc.canvas")?;
    only(c, &["width", "height", "fps"], "doc.canvas")?;
    let t = obj(o.get("transition").unwrap_or(&Value::Null), "doc.transition")?;
    only(t, &["kind", "ms"], "doc.transition")?;
    let scenes = o.get("scenes").and_then(Value::as_array).ok_or_else(|| anyhow!("doc.scenes: expected a list"))?;
    if scenes.is_empty() || scenes.len() > MAX_SCENES {
        bail!("doc.scenes: expected 1 to {MAX_SCENES} scenes");
    }
    let mut ids = HashSet::new();
    for (i, s) in scenes.iter().enumerate() {
        let at = format!("doc.scenes[{i}]");
        let so = obj(s, &at)?;
        only(so, &["id", "name", "layers"], &at)?;
        let layers = so
            .get("layers")
            .and_then(Value::as_array)
            .filter(|l| l.len() <= MAX_LAYERS)
            .ok_or_else(|| anyhow!("{at}.layers: at most {MAX_LAYERS} layers"))?;
        let sid = id(so.get("id"), &format!("{at}.id"))?;
        string(so.get("name"), MAX_NAME, &format!("{at}.name"))?;
        if !ids.insert(sid.clone()) {
            bail!("{at}: duplicate id {sid}");
        }
        for (j, l) in layers.iter().enumerate() {
            validate_layer(l, &format!("{at}.layers[{j}]"), &mut ids)?;
        }
    }
    let w = int(c.get("width"), 160.0, 3840.0, "doc.canvas.width")?;
    let h = int(c.get("height"), 160.0, 3840.0, "doc.canvas.height")?;
    one_of(c.get("fps"), &[json!(24), json!(25), json!(30), json!(50), json!(60)], "doc.canvas.fps")?;
    one_of(t.get("kind"), &strs(&["cut", "fade"]), "doc.transition.kind")?;
    int(t.get("ms"), 0.0, 3000.0, "doc.transition.ms")?;
    int(o.get("active"), 0.0, (scenes.len() - 1) as f64, "doc.active")?;
    if w % 2.0 != 0.0 || h % 2.0 != 0.0 {
        bail!("doc.canvas: width and height must be even");
    }
    Ok(())
}

// ── Links ───────────────────────────────────────────────────────────────

/// A link carries layout only: local image assets are dropped.
pub fn shareable(doc: &Value) -> Value {
    let mut d = doc.clone();
    if let Some(scenes) = d.get_mut("scenes").and_then(Value::as_array_mut) {
        for s in scenes {
            if let Some(layers) = s.get_mut("layers").and_then(Value::as_array_mut) {
                for l in layers {
                    if let Some(o) = l.as_object_mut() {
                        o.remove("image");
                    }
                }
            }
        }
    }
    d
}

pub fn encode_link(doc: &Value, base: &str) -> Result<String> {
    validate(doc)?;
    let json = serde_json::to_vec(&shareable(doc))?;
    let mut z = Vec::new();
    DeflateEncoder::new(&json[..], Compression::best()).read_to_end(&mut z)?;
    let base = base.split('#').next().unwrap_or(base);
    Ok(format!("{base}#s={}", URL_SAFE_NO_PAD.encode(z)))
}

/// Accepts a full link or just its `#s=…` fragment.
pub fn decode_link(link: &str) -> Result<Value> {
    let frag = link.split_once('#').map(|(_, f)| f).unwrap_or(link);
    let data = frag.strip_prefix("s=").ok_or_else(|| anyhow!("no scene in this link"))?;
    if data.len() > MAX_LINK {
        bail!("link too long");
    }
    let z = URL_SAFE_NO_PAD.decode(data).context("link: not base64url")?;
    let mut json = Vec::new();
    DeflateDecoder::new(&z[..]).take(MAX_JSON + 1).read_to_end(&mut json).context("link: corrupted")?;
    if json.len() as u64 > MAX_JSON {
        bail!("link: scene too large");
    }
    let v: Value = serde_json::from_slice(&json).context("link: not a scene")?;
    validate(&v)?;
    Ok(v)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_doc_is_valid_and_round_trips() {
        let d = default_doc().unwrap();
        validate(&d).unwrap();
        let link = encode_link(&d, DEFAULT_BASE).unwrap();
        assert!(link.starts_with("https://maxgfr.github.io/obscura/#s="));
        assert_eq!(decode_link(&link).unwrap(), d);
    }

    #[test]
    fn refuses_unknown_fields_and_bad_values() {
        let mut d = default_doc().unwrap();
        d["scenes"][0]["layers"][0]["deviceId"] = json!("abc");
        assert!(validate(&d).unwrap_err().to_string().contains("deviceId"));
        let mut d = default_doc().unwrap();
        d["canvas"]["fps"] = json!(29);
        assert!(validate(&d).is_err());
        let mut d = default_doc().unwrap();
        d["scenes"][0]["layers"][1]["text"] = json!({});
        assert!(validate(&d).is_err());
    }

    #[test]
    fn accepts_guest_slots() {
        let mut d = default_doc().unwrap();
        let mut g = d["scenes"][0]["layers"][2].clone();
        g["kind"] = json!("guest");
        g["name"] = json!("Guest 1");
        g["audio"]["noise"] = json!("off");
        d["scenes"][0]["layers"].as_array_mut().unwrap().push(g.clone());
        d["scenes"][0]["layers"][3]["id"] = json!("guestlayer1");
        validate(&d).unwrap();
        g.as_object_mut().unwrap().remove("source");
        g["id"] = json!("guestlayer2");
        d["scenes"][0]["layers"].as_array_mut().unwrap().push(g);
        assert!(validate(&d).is_err());
    }

    #[test]
    fn refuses_decompression_bombs() {
        let zeros = vec![b' '; 4 * 1024 * 1024];
        let mut z = Vec::new();
        DeflateEncoder::new(&zeros[..], Compression::best()).read_to_end(&mut z).unwrap();
        let link = format!("#s={}", URL_SAFE_NO_PAD.encode(z));
        assert!(decode_link(&link).is_err());
    }
}
