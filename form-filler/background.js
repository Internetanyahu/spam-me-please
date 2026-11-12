importScripts("updater.js");

async function checkForUpdate() {
  const { githubToken = "" } = await chrome.storage.local.get("githubToken");
  try {
    const info = await FormFillerUpdater.check(githubToken);
    await chrome.storage.local.set({ formFillerUpdate: info });
    await chrome.action.setBadgeText({ text: info.updateAvailable ? "UP" : "" });
    if (info.updateAvailable) await chrome.action.setBadgeBackgroundColor({ color: "#d97706" });
    return info;
  } catch (error) {
    const info = { error: error?.message || "Update check failed.", checkedAt: new Date().toISOString() };
    await chrome.storage.local.set({ formFillerUpdate: info });
    return info;
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "CHECK_FORM_FILLER_UPDATE") {
    checkForUpdate().then(info => sendResponse({ ok: !info.error, info })).catch(error => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  if (message?.type === "APPLY_FORM_FILLER_UPDATE") {
    (async () => {
      const { githubToken = "" } = await chrome.storage.local.get("githubToken");
      const result = await FormFillerUpdater.apply(githubToken, { interactive: false });
      if (result.ok && result.reload) setTimeout(() => chrome.runtime.reload(), 500);
      sendResponse(result);
    })().catch(error => sendResponse({ ok: false, error: error?.message || "Update failed." }));
    return true;
  }
});

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create("form-filler-update-check", { periodInMinutes: 60 });
  checkForUpdate();
});
chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.create("form-filler-update-check", { periodInMinutes: 60 });
  checkForUpdate();
});
chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === "form-filler-update-check") checkForUpdate();
});