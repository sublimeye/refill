document.getElementById("req").onclick = async () => {
  // Clear stale results from earlier clicks so they cannot read as success.
  await chrome.storage.session.remove(["before", "after"]);
  await chrome.storage.session.set({ before: Date.now() });
  try {
    const granted = await chrome.permissions.request({ origins: ["https://example.com/*"] });
    // If the popup closed while the dialog was open, this code may never run.
    await chrome.storage.session.set({ after: Date.now(), granted });
  } catch (e) {
    await chrome.storage.session.set({ after: Date.now(), error: String(e) });
  }
};
