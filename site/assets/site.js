const tabs = [...document.querySelectorAll("[data-install-tab]")];
const commands = [...document.querySelectorAll("[data-install-command]")];

function setInstallPlatform(platform) {
  for (const candidate of tabs) {
    const isActive = candidate.dataset.installTab === platform;
    candidate.classList.toggle("active", isActive);
    candidate.setAttribute("aria-selected", isActive ? "true" : "false");
    candidate.setAttribute("tabindex", isActive ? "0" : "-1");
  }
  for (const command of commands) {
    const isActive = command.dataset.installCommand === platform;
    command.classList.toggle("active", isActive);
    command.setAttribute("aria-hidden", isActive ? "false" : "true");
  }
}

for (const tab of tabs) {
  tab.addEventListener("click", () =>
    setInstallPlatform(tab.dataset.installTab),
  );
}

const initialPlatform = tabs.find((tab) => tab.classList.contains("active"))
  ?.dataset.installTab;
if (initialPlatform) {
  setInstallPlatform(initialPlatform);
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
