import { describe, expect, test } from "bun:test";
import { schnorr } from "@noble/curves/secp256k1.js";
import { hexToBytes } from "@noble/hashes/utils.js";
import {
  b64url,
  channel,
  KIND,
  type Message,
  manualCode,
  newSecret,
  open,
  readManualCode,
  seal,
  signEvent,
  unb64url,
} from "./signal";

const msg = (over: Partial<Message> = {}): Message => ({
  t: "offer",
  from: "abcdefgh1234",
  sdp: "v=0\r\n",
  name: "Sam",
  ts: Math.floor(Date.now() / 1000),
  ...over,
});

describe("room signaling", () => {
  test("a message opens only with its own link's secret", async () => {
    const a = await channel(newSecret());
    const b = await channel(newSecret());
    const sealed = await seal(a, msg());
    expect(await open(a, sealed)).toEqual(msg({ ts: (await open(a, sealed))?.ts as number }));
    expect(await open(b, sealed)).toBeNull();
    expect(a.topic).toMatch(/^[0-9a-f]{64}$/);
    expect(a.topic).not.toBe(b.topic);
  });

  test("the same secret gives the same topic, and the topic does not reveal the secret", async () => {
    const s = newSecret();
    const one = await channel(s);
    const two = await channel(s.slice());
    expect(one.topic).toBe(two.topic);
    expect(one.topic).not.toContain(Buffer.from(s).toString("hex").slice(0, 16));
  });

  test("tampered, stale or malformed messages are dropped", async () => {
    const ch = await channel(newSecret());
    const sealed = await seal(ch, msg());
    const raw = unb64url(sealed);
    raw[20] = (raw[20] as number) ^ 1;
    expect(await open(ch, b64url(raw))).toBeNull();
    expect(
      await open(ch, await seal(ch, msg({ ts: Math.floor(Date.now() / 1000) - 600 }))),
    ).toBeNull();
    expect(await open(ch, await seal(ch, msg({ from: "NOT VALID" })))).toBeNull();
    expect(await open(ch, await seal(ch, msg({ name: "x".repeat(41) })))).toBeNull();
    expect(await open(ch, "!!")).toBeNull();
  });

  test("relay events are valid Nostr events: ephemeral, tagged by topic, signed", () => {
    const sk = schnorr.utils.randomSecretKey();
    const ev = signEvent(sk, "ab".repeat(32), "sealed");
    expect(ev.kind).toBe(KIND);
    expect(ev.kind).toBeGreaterThanOrEqual(20000);
    expect(ev.kind).toBeLessThan(30000);
    expect(ev.tags).toEqual([["x", "ab".repeat(32)]]);
    expect(schnorr.verify(hexToBytes(ev.sig), hexToBytes(ev.id), hexToBytes(ev.pubkey))).toBe(true);
  });

  test("manual codes carry a role and survive line breaks from chat apps", () => {
    const code = manualCode("g", "abc_DEF-123");
    expect(readManualCode(code)).toEqual({ role: "g", sealed: "abc_DEF-123" });
    expect(readManualCode(`  ${code.slice(0, 8)}\n${code.slice(8)} `)).toEqual({
      role: "g",
      sealed: "abc_DEF-123",
    });
    expect(readManualCode("obscura-x.abc")).toBeNull();
    expect(readManualCode("hello")).toBeNull();
  });
});
