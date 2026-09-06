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

const checkinCoreOrigin = "https://agentmesh360.com";
const checkinLaunchLifetimeMs = 15 * 60 * 1000;
let activeCheckinLaunch = null;

function newCheckinRequestId() {
  return (
    globalThis.crypto?.randomUUID?.().replaceAll("-", "") ??
    `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`
  );
}

for (const link of document.querySelectorAll("[data-checkin-link]")) {
  link.addEventListener("click", (event) => {
    if (
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey
    ) {
      return;
    }
    event.preventDefault();
    const id = newCheckinRequestId();
    const target = new URL(link.href);
    target.searchParams.set("source_origin", window.location.origin);
    target.searchParams.set("source_surface", link.dataset.checkinSurface);
    target.searchParams.set("request_id", id);
    const popup = window.open(
      target.toString(),
      "agentmesh360-checkin",
      "popup=yes,width=520,height=760",
    );
    if (!popup) {
      window.location.assign(target.toString());
      return;
    }
    activeCheckinLaunch = { id, link, popup, startedAt: Date.now() };
  });
}

window.addEventListener("message", (event) => {
  if (
    !activeCheckinLaunch ||
    Date.now() - activeCheckinLaunch.startedAt > checkinLaunchLifetimeMs
  ) {
    activeCheckinLaunch = null;
    return;
  }
  if (
    event.origin !== checkinCoreOrigin ||
    event.source !== activeCheckinLaunch.popup ||
    event.data?.type !== "agentmesh360:checkin-complete" ||
    event.data?.request_id !== activeCheckinLaunch.id ||
    event.data?.state !== "claimed"
  ) {
    return;
  }
  const current = Number(event.data.progress_current || 0);
  const target = Number(event.data.progress_target || 7);
  const label =
    activeCheckinLaunch.link.dataset.checkinCompleteLabel || "Checked in";
  activeCheckinLaunch.link.textContent = current
    ? `${label} ${current}/${target}`
    : label;
  activeCheckinLaunch.link.dataset.checkinState = "claimed";
  activeCheckinLaunch = null;
});
