// Landing page: copy buttons on the install steps.

for (const b of Array.from(document.querySelectorAll<HTMLButtonElement>("button[data-copy]"))) {
  b.addEventListener("click", async () => {
    const label = b.querySelector("span");
    try {
      await navigator.clipboard.writeText(b.dataset.copy ?? "");
      if (label) label.textContent = "Copied";
    } catch {
      if (label) label.textContent = "Select and copy";
    }
    setTimeout(() => label && (label.textContent = "Copy"), 1600);
  });
}
