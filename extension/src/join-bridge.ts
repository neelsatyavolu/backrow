// Runs on Backrow's invite and watch pages. Tells the page the extension is
// installed, passes on the "Send debug logs" setting, and hands the party to
// the background worker when asked.

import type { RuntimeIn } from "./messages";

document.documentElement.dataset.backrowExtension = chrome.runtime.getManifest().version;
document.dispatchEvent(new CustomEvent("backrow:extension-ready"));

void chrome.storage.local.get("remoteLog").then(({ remoteLog }) => {
  if (remoteLog !== true) return;
  document.documentElement.dataset.backrowRemoteLog = "1";
  document.dispatchEvent(new CustomEvent("backrow:remote-log"));
});

document.addEventListener("backrow:join", (e) => {
  const detail = (e as CustomEvent<unknown>).detail;
  if (typeof detail !== "string") return;
  try {
    const { roomId, keyText, url } = JSON.parse(detail) as Record<string, unknown>;
    if (typeof roomId !== "string" || typeof keyText !== "string" || typeof url !== "string") return;
    const msg: RuntimeIn = { type: "join", roomId, keyText, url };
    void chrome.runtime.sendMessage(msg);
  } catch {
    // Ignore malformed requests from the page.
  }
});
