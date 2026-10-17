import { describe, expect, it } from "vitest";
import { parseClientMessage } from "../shared/protocol";
import { fromBase64Url, importKey, newKeyText, openJson, randomId, sealJson, toBase64Url } from "../shared/crypto";

describe("room encryption", () => {
  it("round-trips JSON with the right key", async () => {
    const key = await importKey(newKeyText());
    const blob = await sealJson(key, { text: "hi there" });
    expect(await openJson(key, blob)).toEqual({ text: "hi there" });
  });

  it("rejects blobs sealed with another key or tampered with", async () => {
    const a = await importKey(newKeyText());
    const b = await importKey(newKeyText());
    const blob = await sealJson(a, { x: 1 });
    expect(await openJson(b, blob)).toBeNull();
    const flipped = blob.slice(0, -2) + (blob.endsWith("A") ? "B" : "A") + blob.slice(-1);
    expect(await openJson(a, flipped)).toBeNull();
    expect(await openJson(a, "not base64!")).toBeNull();
  });

  it("uses a fresh IV each time", async () => {
    const key = await importKey(newKeyText());
    expect(await sealJson(key, 1)).not.toEqual(await sealJson(key, 1));
  });

  it("base64url round-trips and rejects bad keys", async () => {
    const bytes = crypto.getRandomValues(new Uint8Array(33));
    expect(fromBase64Url(toBase64Url(bytes))).toEqual(bytes);
    await expect(importKey(toBase64Url(new Uint8Array(16)))).rejects.toThrow();
    expect(randomId(12)).toMatch(/^[a-z2-9]{12}$/);
  });
});

describe("protocol limits", () => {
  it("lets profiles carry a photo but keeps other blobs small", () => {
    const big = "A".repeat(10000);
    expect(parseClientMessage(JSON.stringify({ t: "profile", profile: big }))).not.toBeNull();
    expect(parseClientMessage(JSON.stringify({ t: "hello", profile: big }))).not.toBeNull();
    expect(parseClientMessage(JSON.stringify({ t: "chat", blob: big }))).toBeNull();
    expect(parseClientMessage(JSON.stringify({ t: "profile", profile: "A".repeat(13000) }))).toBeNull();
  });
});

