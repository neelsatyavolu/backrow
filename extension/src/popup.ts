import { AccountApi, parseSavedAccount, type SavedAccount } from "../../shared/account";
import { AVATAR_COLORS, type Profile } from "../../shared/payload";
import { accountView } from "../../shared/ui/account-form";
import { fileToAvatar, photoCanvas } from "../../shared/ui/avatar-image";
import { SERVICE_LABELS } from "../../shared/services";
import { SERVER, type PopupStatus, type RuntimeIn } from "./messages";

const view = document.getElementById("view")!;
const nameInput = document.getElementById("name") as HTMLInputElement;
const swatches = document.getElementById("swatches")!;
const avatarEl = document.getElementById("avatar")!;
const photoBtn = document.getElementById("photo") as HTMLButtonElement;
const removeBtn = document.getElementById("removePhoto") as HTMLButtonElement;
const photoFile = document.getElementById("photoFile") as HTMLInputElement;
const photoError = document.getElementById("photoError")!;
const accountRow = document.getElementById("accountRow")!;
const accountPage = document.getElementById("accountPage")!;
(document.getElementById("home") as HTMLAnchorElement).href = `${SERVER}/host`;

const remoteLogBox = document.getElementById("remoteLog") as HTMLInputElement;
void chrome.storage.local.get("remoteLog").then(({ remoteLog }) => (remoteLogBox.checked = remoteLog === true));
remoteLogBox.onchange = () => void chrome.storage.local.set({ remoteLog: remoteLogBox.checked });

let tabId = -1;
let profile: Profile = { name: "Guest", color: 0 };

const ask = <T>(msg: RuntimeIn): Promise<T> => chrome.runtime.sendMessage(msg) as Promise<T>;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = "", text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function renderProfile(): void {
  nameInput.value = profile.name;
  avatarEl.style.background = AVATAR_COLORS[profile.color] ?? AVATAR_COLORS[0]!;
  avatarEl.replaceChildren(profile.photo ? photoCanvas(profile.photo, "") : document.createTextNode(profile.name.slice(0, 1).toUpperCase()));
  photoBtn.textContent = profile.photo ? "Change photo" : "Upload photo";
  removeBtn.hidden = !profile.photo;
  swatches.replaceChildren(
    ...AVATAR_COLORS.map((color, i) => {
      const b = el("button", "swatch");
      b.style.background = color;
      b.setAttribute("aria-label", `Color ${i + 1}`);
      b.setAttribute("aria-pressed", String(i === profile.color));
      b.onclick = () => saveProfile({ ...profile, color: i });
      return b;
    }),
  );
}

async function saveProfile(next: Profile): Promise<void> {
  const name = next.name.trim().slice(0, 24);
  if (!name) return;
  profile = { ...next, name };
  renderProfile();
  await ask({ type: "set-profile", profile });
}

nameInput.addEventListener("change", () => saveProfile({ ...profile, name: nameInput.value }));
// On macOS the file picker closes the toolbar popup before a file comes back,
// so from the popup this opens the same page in a tab, where picking works.
const inToolbarPopup = chrome.extension.getViews({ type: "popup" }).includes(window);
const editing = new URLSearchParams(location.search).get("edit");
const profileOnly = editing === "profile" || editing === "account";
photoBtn.addEventListener("click", () => {
  if (inToolbarPopup) void chrome.tabs.create({ url: chrome.runtime.getURL("popup.html?edit=profile") });
  else photoFile.click();
});
photoFile.addEventListener("change", async () => {
  const file = photoFile.files?.[0];
  photoFile.value = "";
  if (!file) return;
  photoError.hidden = true;
  try {
    await saveProfile({ ...profile, photo: await fileToAvatar(file) });
  } catch (err) {
    photoError.textContent = err instanceof Error ? err.message : "That image couldn't be used.";
    photoError.hidden = false;
  }
});
removeBtn.addEventListener("click", () => {
  const { photo: _removed, ...rest } = profile;
  void saveProfile(rest);
});

// ---------------- Account ----------------

const loadAccount = async () => parseSavedAccount((await chrome.storage.local.get("account")).account);

/** Opens the account page in a tab, where it survives switching to the inbox for a code. */
const openAccountPage = () => void chrome.tabs.create({ url: chrome.runtime.getURL("popup.html?edit=account") });

async function renderAccountRow(): Promise<void> {
  if (editing === "account") return accountRow.replaceChildren();
  const account = await loadAccount();
  const text = el("span", "meta", account ? `Saved to ${account.email}` : "Keep this profile on every device");
  const button = el("button", "btn ghost small", account ? "Account" : "Sign in");
  button.onclick = () => (inToolbarPopup ? openAccountPage() : (location.search = "?edit=account"));
  accountRow.replaceChildren(text, button);
}

if (editing === "account") {
  accountPage.hidden = false;
  accountView(accountPage, {
    api: new AccountApi(SERVER),
    load: loadAccount,
    save: async (account: SavedAccount | null) => {
      if (account) await chrome.storage.local.set({ account });
      else await chrome.storage.local.remove("account");
    },
    getProfile: () => ask<Profile>({ type: "get-profile" }),
    applyProfile: async (next) => {
      await ask({ type: "set-profile", profile: next, fromAccount: true });
      profile = next;
      renderProfile();
    },
  });
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && "account" in changes) void renderAccountRow();
  if (area === "local" && changes.profile?.newValue && document.activeElement !== nameInput) {
    profile = changes.profile.newValue as Profile;
    renderProfile();
  }
});

function render(status: PopupStatus): void {
  view.replaceChildren();
  if (status.session) {
    const s = status.session;
    const count = s.snapshot?.members.length ?? 0;
    const state = el("div", "status");
    state.append(el("span", "dot"), document.createTextNode(`${s.status === "open" ? "live" : s.status} · ${count} watching`));
    const row = el("div", "row");
    const field = el("input", "field");
    field.readOnly = true;
    field.value = s.invite;
    field.setAttribute("aria-label", "Invite link");
    const copy = el("button", "btn", "Copy");
    copy.onclick = async () => {
      await navigator.clipboard.writeText(s.invite);
      copy.textContent = "Copied";
      setTimeout(() => (copy.textContent = "Copy"), 1500);
    };
    row.append(field, copy);
    const leave = el("button", "btn ghost", "Leave party");
    leave.onclick = async () => {
      await ask({ type: "leave", tabId });
      void refresh();
    };
    view.append(state, el("span", "label", "Invite link"), row, el("p", "meta", "Anyone with this link can join. The part after # is the encryption key and never reaches our server."), leave);
    return;
  }
  if (!status.supported) {
    view.append(
      el("p", "title", "Open a video to start a party"),
      el("p", "meta", "Backrow works on Netflix, Hulu, Peacock, YouTube, Prime Video, HBO Max and Disney+. To watch your own file, stream it from the Backrow site."),
    );
    return;
  }
  if (!status.video) {
    view.append(el("p", "title", "Pick something to watch"), el("p", "meta", "Open a show or video, then start the party from here."));
    return;
  }
  const v = status.video;
  const toggle = el("label", "toggle");
  const hostOnly = el("input");
  hostOnly.type = "checkbox";
  toggle.append(hostOnly, document.createTextNode("Only I can control playback"));
  const start = el("button", "btn accent", "Start party");
  const error = el("p", "error");
  start.onclick = async () => {
    start.disabled = true;
    start.textContent = "Starting";
    const res = await ask<{ ok: boolean; error?: string }>({ type: "start", tabId, hostOnly: hostOnly.checked });
    if (!res.ok) {
      error.textContent = res.error ?? "Could not start the party.";
      start.disabled = false;
      start.textContent = "Start party";
      return;
    }
    setTimeout(() => void refresh(), 600);
  };
  view.append(el("span", "label", SERVICE_LABELS[v.service]), el("p", "title", v.title ?? "This video"), toggle, start, error);
}

async function refresh(): Promise<void> {
  // ?tab=<id> lets the popup be opened as a page for a specific tab (used by tests).
  const forced = Number(new URLSearchParams(location.search).get("tab"));
  if (Number.isInteger(forced) && forced > 0) {
    tabId = forced;
  } else {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id === undefined) return;
    tabId = tab.id;
  }
  const status = await ask<PopupStatus>({ type: "popup-status", tabId });
  profile = status.profile;
  renderProfile();
  render(status);
  void renderAccountRow();
  // A profile changed on another device arrives through storage.onChanged.
  void ask({ type: "account-pull" }).catch(() => undefined);
}

if (profileOnly) {
  document.body.classList.add("profile-page");
  view.hidden = true;
}

refresh().catch(() => {
  view.replaceChildren(el("p", "error", "Something went wrong. Reload the page and try again."));
});
