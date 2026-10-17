import { describe, expect, it } from "vitest";
import { deriveKeys, isAuthKey, normalizeEmail, openProfile, parseSavedAccount, sealProfile } from "../shared/account";

describe("account keys", () => {
  it("normalizes emails and rejects junk", () => {
    expect(normalizeEmail("  Neel@Example.COM ")).toBe("neel@example.com");
    expect(normalizeEmail("no-at-sign")).toBeNull();
    expect(normalizeEmail("a@b")).toBeNull();
    expect(normalizeEmail(42)).toBeNull();
  });

  it("derives a stable auth key that differs from the profile key", async () => {
    const a = await deriveKeys("a@example.com", "correct horse");
    const b = await deriveKeys("a@example.com", "correct horse");
    expect(a).toEqual(b);
    expect(isAuthKey(a.auth)).toBe(true);
    expect(a.auth).not.toBe(a.key);
    expect((await deriveKeys("b@example.com", "correct horse")).auth).not.toBe(a.auth);
    expect((await deriveKeys("a@example.com", "correct horse!")).key).not.toBe(a.key);
  });

  it("seals profiles so only the right password opens them", async () => {
    const { key } = await deriveKeys("a@example.com", "correct horse");
    const other = await deriveKeys("a@example.com", "wrong horse");
    const blob = await sealProfile(key, { name: "Neel", color: 2 });
    expect(blob).not.toContain("Neel");
    expect(await openProfile(key, blob)).toEqual({ name: "Neel", color: 2 });
    expect(await openProfile(other.key, blob)).toBeNull();
  });

  it("validates a saved account", async () => {
    const { key } = await deriveKeys("a@example.com", "correct horse");
    expect(parseSavedAccount({ email: "A@example.com", token: "t", key })).toEqual({ email: "a@example.com", token: "t", key });
    expect(parseSavedAccount({ email: "a@example.com", token: "t", key: "short" })).toBeNull();
    expect(parseSavedAccount(null)).toBeNull();
  });
});
