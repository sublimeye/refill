// Framework-style generated identifiers: a new random name and id for every field on every load.
// Hex only, so no generated name can spell a word the sensitive-field rules react to.
function randomHex() {
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

for (const input of document.querySelectorAll("input[data-field]")) {
  const id = `f_${randomHex()}`;
  input.id = id;
  input.name = `f_${randomHex()}`;
  const label = document.querySelector(
    `label[data-for="${input.dataset.field}"]`,
  );
  if (label !== null) label.htmlFor = id;
}
