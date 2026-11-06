// Background service worker for the Microburbs Facts extension.
chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  if (reason !== "install") return;

  try {
    await chrome.tabs.create({
      url: chrome.runtime.getURL("welcome/welcome.html"),
      active: true,
    });
  } catch (error) {
    console.error("Could not open the Microburbs Facts welcome page.", error);
  }
});
