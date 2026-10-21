# Sealed recording format

Encrypted recordings (`*.mp4.obscura`, `*.webm.obscura`) use one format, written by
the web app (`src/crypto/format.ts`, `src/crypto/stream.ts`) and read by the CLI
(`cli/src/seal.rs`). Both are tested against the same vectors (`cli/tests/vectors.json`).

## Header

All integers are big-endian.

| Offset | Size | Field |
|---|---|---|
| 0 | 8 | magic `OBSCURA1` |
| 8 | 1 | key derivation: `1` = Argon2id v1.3 |
| 9 | 4 | `m`: memory cost, KiB (8·p … 1 048 576) |
| 13 | 4 | `t`: iterations (1 … 16) |
| 17 | 1 | `p`: lanes (1 … 8) |
| 18 | 16 | salt |
| 34 | 7 | nonce prefix (random, per file) |
| 41 | 1 | `chunk_log2`: plaintext chunk size is 2^chunk_log2 bytes (10 … 24; 16 by default) |
| 42 | 2 | `mime_len` (≤ 255) |
| 44 | mime_len | MIME type of the plaintext, UTF-8 (`video/mp4`, `video/webm`) |

Readers reject values outside these bounds, so a forged header cannot make them
allocate gigabytes or spin forever. The web app uses m = 65 536 (64 MiB), t = 3, p = 1.

## Key

`key = Argon2id(password = passphrase as UTF-8 bytes, salt, m, t, p, length = 32)`

The passphrase is used exactly as typed, with no Unicode normalization. One studio
session derives one key and salt. Each recording of the session gets a fresh random nonce
prefix: 56 bits, so a collision under the same key needs about 2^28 recordings.

## Chunks

The plaintext is cut into chunks of exactly `2^chunk_log2` bytes, except the last,
which holds 0 to 2^chunk_log2 bytes and is empty only when the whole plaintext is.
Chunk `i` is stored as:

```
AES-256-GCM(key, nonce = prefix(7) ‖ i as u32 BE(4) ‖ last(1), aad = SHA-256(header), chunk) = ciphertext ‖ tag(16)
```

`last` is `1` for the final chunk and `0` otherwise. A reader therefore detects:

- **a wrong key**: the first chunk fails to authenticate;
- **tampering, reordering, dropping or splicing**: each chunk is bound to its index, to
  the header and to its position (last or not);
- **truncation**: a stream that ends on a chunk sealed with `last = 0` is incomplete.

A crash during recording leaves a stream with no final chunk. `obscura decrypt
--partial` then writes every chunk that authenticates and reports the stream as cut.
The plaintext inside is fragmented MP4 or append-only WebM, so it plays up to its last
whole fragment, and `obscura repair` trims what follows.
