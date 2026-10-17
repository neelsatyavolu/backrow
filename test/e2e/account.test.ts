// Runs against a local dev server without a Resend key, which hands codes back
// in the response: `npm run dev`, then `BACKROW_SERVER=http://localhost:8787 npm run test:e2e`.
import { describe, expect, it } from "vitest";
import { AccountApi, AccountError, deriveKeys, openProfile, sealProfile } from "../../shared/account";

const SERVER = process.env.BACKROW_SERVER ?? "http://localhost:8787";
const api = new AccountApi(SERVER);

async function status(p: Promise<unknown>): Promise<number> {
  try {
    await p;
    return 200;
  } catch (err) {
    return err instanceof AccountError ? err.status : -1;
  }
}

describe("live accounts", () => {
  it("signs up, syncs an encrypted profile, signs in, resets and deletes", async () => {
    const email = `test-${Date.now()}@example.com`;
    const keys = await deriveKeys(email, "first password");

    const { devCode } = await api.signup(email, keys.auth);
    expect(devCode).toMatch(/^\d{6}$/);
    expect(await status(api.verify(email, devCode === "000000" ? "111111" : "000000"))).toBe(400);
    const { token } = await api.verify(email, devCode!);

    const blob = await sealProfile(keys.key, { name: "Tester", color: 3 });
    await api.putProfile(token, blob);
    const stored = (await api.getProfile(token)).profile!;
    expect(stored).not.toContain("Tester");
    expect(await openProfile(keys.key, stored)).toEqual({ name: "Tester", color: 3 });

    // A second signup with the same email doesn't reveal or replace the account.
    expect((await api.signup(email, keys.auth)).devCode).toBeUndefined();

    expect(await status(api.login(email, (await deriveKeys(email, "wrong password")).auth))).toBe(401);
    const second = await api.login(email, keys.auth);
    await api.logout(second.token);
    expect(await status(api.getProfile(second.token))).toBe(401);

    const reset = await api.requestReset(email);
    const newKeys = await deriveKeys(email, "second password");
    const after = await api.reset(email, reset.devCode!, newKeys.auth);
    expect(await status(api.getProfile(token))).toBe(401);
    expect((await api.getProfile(after.token)).profile).toBeNull();
    expect(await status(api.login(email, keys.auth))).toBe(401);

    await api.remove(after.token);
    expect(await status(api.login(email, newKeys.auth))).toBe(401);
  });

  it("answers a reset request for an unknown email the same way", async () => {
    expect(await api.requestReset(`nobody-${Date.now()}@example.com`)).toEqual({ ok: true });
  });

  it("rejects requests without a session", async () => {
    expect(await status(api.getProfile("a".repeat(40)))).toBe(401);
  });
});
