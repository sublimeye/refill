// Asks Chrome to prerender the payment page (Speculation Rules), so the content script lands in a
// document that is still prerendering.
const rules = document.createElement("script");
rules.type = "speculationrules";
rules.textContent = JSON.stringify({
  prerender: [{ source: "list", urls: ["/billpay/twins"] }],
});
document.head.append(rules);
