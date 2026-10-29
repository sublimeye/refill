// A React-style SPA: the form is rendered by script into an action-less form (its action is the
// document's own path), and the router later rewrites the URL to a different case and route with
// history.replaceState. Nothing re-renders, so no DOM mutation follows the rewrite.
const SEARCH = "/billpay/spa-rewrite-search";

function row(id, text) {
  const p = document.createElement("p");
  const label = document.createElement("label");
  label.htmlFor = id;
  label.textContent = text;
  const input = document.createElement("input");
  input.id = id;
  input.type = "text";
  p.append(label, " ", input);
  return p;
}

const form = document.createElement("form");
form.append(row("id1", "Account number"), row("id2", "Service ZIP code"));
form.addEventListener("input", () => {
  if (location.pathname !== SEARCH) {
    history.replaceState(null, "", SEARCH);
  }
});
document.getElementById("app").append(form);

// At the lowercase spelling of the recorded path the app also shows a contact panel, so the page
// no longer looks like the recorded form (Jaccard 2/5): it fills only because the path is under
// the prefix in another case (ADR 0034).
if (location.pathname === "/billpay/sparewrite") {
  const contact = document.createElement("form");
  contact.append(
    row("contact-email", "Email for receipts"),
    row("contact-phone", "Phone"),
    row("contact-nick", "Nickname"),
  );
  document.getElementById("app").append(contact);
}
