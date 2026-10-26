document.getElementById("req").onclick = async () => {
  await chrome.storage.session.set({ before: Date.now() });
  const granted = await chrome.permissions.request({ origins: ["https://example.com/*"] });
  // If the popup closed while the dialog was open, this code may never run.
  await chrome.storage.session.set({ after: Date.now(), granted });
};
