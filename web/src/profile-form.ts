// Name, color and photo fields for the join screens (host and viewer).

import { AVATAR_COLORS, NAME_MAX, type Profile } from "../../shared/payload";
import { fileToAvatar, photoCanvas } from "../../shared/ui/avatar-image";
import { el, loadAccount, loadProfile, saveProfile } from "./local";

export interface ProfileForm {
  nodes: HTMLElement[];
  /** The profile as entered; also remembered for next time. */
  commit(): Profile;
  focus(): void;
}

export function profileForm(): ProfileForm {
  let profile = loadProfile();
  const name = el("input", "field");
  name.value = profile.name;
  name.maxLength = NAME_MAX;
  name.setAttribute("aria-label", "Display name");
  const swatches = el("div", "swatches");
  const photoRow = el("div", "photo-row");
  const photoErr = el("p", "error");
  const file = el("input");
  file.type = "file";
  file.accept = "image/*";
  file.hidden = true;

  const paintPhoto = () => {
    const face = el("span", "gate-avatar");
    face.style.background = AVATAR_COLORS[profile.color] ?? AVATAR_COLORS[0]!;
    face.append(profile.photo ? photoCanvas(profile.photo, "") : document.createTextNode((name.value || profile.name).slice(0, 1).toUpperCase()));
    const pick = el("button", "btn ghost", profile.photo ? "Change photo" : "Add photo");
    pick.type = "button";
    pick.onclick = () => file.click();
    const parts: HTMLElement[] = [face, pick];
    if (profile.photo) {
      const remove = el("button", "btn ghost", "Remove");
      remove.type = "button";
      remove.onclick = () => {
        const { photo: _removed, ...rest } = profile;
        profile = rest;
        paintPhoto();
      };
      parts.push(remove);
    }
    photoRow.replaceChildren(...parts, file);
  };
  const paintSwatches = () =>
    swatches.replaceChildren(
      ...AVATAR_COLORS.map((c, i) => {
        const b = el("button", "swatch");
        b.type = "button";
        b.style.background = c;
        b.setAttribute("aria-label", `Color ${i + 1}`);
        b.setAttribute("aria-pressed", String(i === profile.color));
        b.onclick = () => {
          profile = { ...profile, color: i };
          paintSwatches();
          paintPhoto();
        };
        return b;
      }),
    );
  file.onchange = async () => {
    const picked = file.files?.[0];
    file.value = "";
    if (!picked) return;
    photoErr.textContent = "";
    try {
      profile = { ...profile, photo: await fileToAvatar(picked) };
      paintPhoto();
    } catch (err) {
      photoErr.textContent = err instanceof Error ? err.message : "That image couldn't be used.";
    }
  };
  name.addEventListener("input", () => !profile.photo && paintPhoto());
  paintSwatches();
  paintPhoto();

  const account = loadAccount();
  const accountLink = el("a", "meta account-link", account ? `Saved to ${account.email}` : "Sign in to keep this profile on every device");
  accountLink.href = "/account";
  accountLink.target = "_blank";
  accountLink.rel = "noopener";

  return {
    nodes: [el("span", "label", "Your photo"), photoRow, photoErr, el("span", "label", "Display name"), name, el("span", "label", "Color"), swatches, accountLink],
    commit() {
      profile = { ...profile, name: name.value.trim().slice(0, NAME_MAX) || profile.name };
      saveProfile(profile);
      return profile;
    },
    focus: () => name.focus(),
  };
}
