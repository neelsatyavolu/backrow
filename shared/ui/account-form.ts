// Sign in, create an account, reset a password, or manage a signed-in
// account. Used by the extension (in a tab, so the form survives a trip to
// the inbox) and by the site's /account page.

import {
  AccountApi,
  deriveKeys,
  normalizeEmail,
  PASSWORD_MIN,
  pushProfile,
  syncOnSignIn,
  type SavedAccount,
} from "../account";
import type { Profile } from "../payload";

export interface AccountHost {
  api: AccountApi;
  load(): Promise<SavedAccount | null>;
  save(account: SavedAccount | null): Promise<void>;
  getProfile(): Promise<Profile>;
  /** Applies a profile that came from the account (no need to upload it again). */
  applyProfile(profile: Profile): Promise<void>;
  /** Extra content shown while signed in, such as a profile editor. */
  signedInExtras?(): HTMLElement[];
}

type Step = "signin" | "signup" | "code" | "forgot" | "reset";

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = "", text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function input(type: string, label: string, autocomplete: AutoFill): HTMLInputElement {
  const i = el("input", "field");
  i.type = type;
  i.autocomplete = autocomplete;
  i.setAttribute("aria-label", label);
  i.placeholder = label;
  return i;
}

function linkButton(text: string, onClick: () => void): HTMLButtonElement {
  const b = el("button", "linkish", text);
  b.type = "button";
  b.onclick = onClick;
  return b;
}

export function accountView(root: HTMLElement, host: AccountHost): void {
  let email = "";
  let devCode = "";
  const error = el("p", "error");
  const note = el("p", "meta");

  const busy = async (button: HTMLButtonElement, work: () => Promise<void>) => {
    error.textContent = "";
    const label = button.textContent;
    button.disabled = true;
    button.textContent = "Working…";
    try {
      await work();
    } catch (err) {
      error.textContent = err instanceof Error ? err.message : "Something went wrong";
    } finally {
      button.disabled = false;
      button.textContent = label;
    }
  };

  const finish = async (token: string, key: string, fresh: boolean) => {
    const account: SavedAccount = { email, token, key };
    await host.save(account);
    const local = await host.getProfile();
    if (fresh) await pushProfile(host.api, account, local);
    else await host.applyProfile(await syncOnSignIn(host.api, account, local));
    await render();
  };

  const links = (...items: Array<[string, () => void]>) => {
    const row = el("div", "account-links");
    row.append(...items.map(([text, go]) => linkButton(text, go)));
    return row;
  };

  /** Shows one step: its fields, a submit button that runs `run`, and extras below. */
  const form = (title: string, fields: HTMLElement[], submit: string, run: () => Promise<void>, footer: HTMLElement[]) => {
    const f = el("form", "account-form");
    f.noValidate = true;
    const go = el("button", "btn accent", submit);
    go.type = "submit";
    f.onsubmit = (e) => {
      e.preventDefault();
      void busy(go, run);
    };
    f.append(...fields, go);
    error.textContent = "";
    note.textContent = devCode ? `Dev server: your code is ${devCode}` : "";
    root.replaceChildren(el("p", "title", title), f, error, note, ...footer);
    (fields.find((x) => x instanceof HTMLInputElement && !x.value) as HTMLInputElement | undefined)?.focus();
  };

  const emailField = () => {
    const mail = input("email", "Email", "email");
    mail.value = email;
    return mail;
  };

  const codeField = () => {
    const code = input("text", "6-digit code", "one-time-code");
    code.inputMode = "numeric";
    code.maxLength = 6;
    return code;
  };

  const readEmail = (mail: HTMLInputElement): string => {
    const value = normalizeEmail(mail.value);
    if (!value) throw new Error("Enter a valid email");
    email = value;
    return value;
  };

  const readPassword = (pass: HTMLInputElement): string => {
    if (pass.value.length < PASSWORD_MIN) throw new Error(`Use at least ${PASSWORD_MIN} characters for the password`);
    return pass.value;
  };

  const show = (step: Step, pendingKey = ""): void => {
    if (step === "signin") {
      const mail = emailField();
      const pass = input("password", "Password", "current-password");
      return form("Sign in", [mail, pass], "Sign in", async () => {
        const keys = await deriveKeys(readEmail(mail), pass.value);
        const { token } = await host.api.login(email, keys.auth);
        await finish(token, keys.key, false);
      }, [
        el("p", "meta", "Your photo, name and color follow you to every device. They're encrypted with your password before they leave this browser."),
        links(["Create an account", () => show("signup")], ["Forgot password?", () => show("forgot")]),
      ]);
    }
    if (step === "signup") {
      const mail = emailField();
      const pass = input("password", `Password (${PASSWORD_MIN}+ characters)`, "new-password");
      return form("Create an account", [mail, pass], "Create account", async () => {
        const keys = await deriveKeys(readEmail(mail), readPassword(pass));
        devCode = (await host.api.signup(email, keys.auth)).devCode ?? "";
        show("code", keys.key);
      }, [
        el("p", "meta", "If you ever reset a forgotten password, the profile saved to your account is cleared, because only your old password could unlock it."),
        links(["I already have an account", () => show("signin")]),
      ]);
    }
    if (step === "code") {
      const code = codeField();
      return form("Check your email", [el("p", "meta", `We sent a 6-digit code to ${email}. It expires in 15 minutes.`), code], "Confirm", async () => {
        const { token } = await host.api.verify(email, code.value.trim());
        devCode = "";
        await finish(token, pendingKey, true);
      }, [links(["Use a different email", () => show("signup")])]);
    }
    if (step === "forgot") {
      const mail = emailField();
      return form("Reset your password", [mail], "Email me a code", async () => {
        devCode = (await host.api.requestReset(readEmail(mail))).devCode ?? "";
        show("reset");
      }, [
        el("p", "meta", "Resetting clears the profile saved to your account, since your old password encrypted it. The profile on this device is kept and saved again."),
        links(["Back to sign in", () => show("signin")]),
      ]);
    }
    const code = codeField();
    const pass = input("password", `New password (${PASSWORD_MIN}+ characters)`, "new-password");
    form("Check your email", [el("p", "meta", `If ${email} has an account, we sent it a 6-digit code.`), code, pass], "Set new password", async () => {
      const keys = await deriveKeys(email, readPassword(pass));
      const { token } = await host.api.reset(email, code.value.trim(), keys.auth);
      devCode = "";
      await finish(token, keys.key, true);
    }, [links(["Back to sign in", () => show("signin")])]);
  };

  const render = async () => {
    const account = await host.load();
    if (!account) return show("signin");
    email = account.email;
    const out = el("button", "btn ghost", "Sign out");
    out.onclick = () =>
      void busy(out, async () => {
        await host.api.logout(account.token).catch(() => undefined);
        await host.save(null);
        await render();
      });
    const del = el("button", "linkish danger", "Delete account");
    del.onclick = () => {
      if (!confirm("Delete your Backrow account? Your saved profile is erased. This can't be undone.")) return;
      void busy(del, async () => {
        await host.api.remove(account.token);
        await host.save(null);
        await render();
      });
    };
    const actions = el("div", "account-links");
    actions.append(out, del);
    error.textContent = "";
    root.replaceChildren(
      el("p", "title", "Signed in"),
      el("p", "meta", `${account.email} · your profile is saved, encrypted, to this account.`),
      ...(host.signedInExtras?.() ?? []),
      actions,
      error,
    );
  };

  void render();
}
