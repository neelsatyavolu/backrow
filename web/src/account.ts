// The /account page: sign in or create an account, and edit the profile that
// is saved to it.

import { accountView } from "../../shared/ui/account-form";
import { accountApi, el, loadAccount, loadProfile, saveAccount, saveProfile } from "./local";
import { profileForm } from "./profile-form";

const root = document.getElementById("account")!;

accountView(root, {
  api: accountApi,
  load: async () => loadAccount(),
  save: async (account) => saveAccount(account),
  getProfile: async () => loadProfile(),
  applyProfile: async (profile) => saveProfile(profile, false),
  signedInExtras: () => {
    const form = profileForm();
    const saved = el("p", "meta");
    const save = el("button", "btn accent", "Save profile");
    save.onclick = () => {
      form.commit();
      saved.textContent = "Saved. It updates in the extension the next time you open it.";
    };
    // The form's own "sign in" link points back here; drop it.
    return [...form.nodes.slice(0, -1), save, saved];
  },
});
