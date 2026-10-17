// Runs in each streaming site's own page context (manifest world: MAIN).
//
// The browser forces a fullscreen element to cover the whole screen, so the
// party chat could only sit on top of the video. While a party is active,
// fullscreen requests are redirected to the whole page instead, where
// page.css can shrink the player beside the chat. The site is still told its
// own element is fullscreen, so its buttons and icons keep working. Outside a
// party nothing is changed.

export {};

const html = document.documentElement;
const originalRequest = Element.prototype.requestFullscreen;
const realElement = Object.getOwnPropertyDescriptor(Document.prototype, "fullscreenElement")?.get;
let requested: Element | null = null;

const partyActive = () => html.classList.contains("backrow-watch");

Element.prototype.requestFullscreen = function (this: Element, options?: FullscreenOptions): Promise<void> {
  if (!partyActive() || this === html) {
    requested = null;
    return originalRequest.call(this, options);
  }
  requested = this;
  html.dataset.backrowFsRedirect = "1";
  return originalRequest.call(html, options).catch((err: unknown) => {
    requested = null;
    delete html.dataset.backrowFsRedirect;
    throw err;
  });
};

if (realElement) {
  Object.defineProperty(Document.prototype, "fullscreenElement", {
    configurable: true,
    enumerable: true,
    get(this: Document) {
      const real = realElement.call(this) as Element | null;
      return real === html && requested ? requested : real;
    },
  });
}

document.addEventListener(
  "fullscreenchange",
  () => {
    if (realElement?.call(document) === null) {
      requested = null;
      delete html.dataset.backrowFsRedirect;
    }
  },
  true,
);
