const tabs = [...document.querySelectorAll("[data-install-tab]")];
const commands = [...document.querySelectorAll("[data-install-command]")];

for (const tab of tabs) {
  tab.addEventListener("click", () => {
    const platform = tab.dataset.installTab;
    for (const candidate of tabs) {
      candidate.classList.toggle(
        "active",
        candidate.dataset.installTab === platform,
      );
      candidate.setAttribute(
        "aria-selected",
        candidate.dataset.installTab === platform ? "true" : "false",
      );
    }
    for (const command of commands) {
      command.classList.toggle(
        "active",
        command.dataset.installCommand === platform,
      );
    }
  });
}

for (const button of document.querySelectorAll("[data-copy]")) {
  button.addEventListener("click", async () => {
    const selector = button.dataset.copy;
    const target = selector ? document.querySelector(selector) : null;
    if (!target) return;
    const copyText = button.dataset.copyText ?? target.textContent.trim();
    await navigator.clipboard.writeText(copyText);
    const original = button.textContent;
    button.textContent = button.dataset.copiedLabel ?? "Copied";
    button.classList.add("copied");
    window.setTimeout(() => {
      button.textContent = original;
      button.classList.remove("copied");
    }, 1600);
  });
}
