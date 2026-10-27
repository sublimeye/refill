// Single-page wizard: "Next" replaces step 1's fields with step 2's in place. The URL never
// changes and nothing navigates, so only a DOM re-scan can see step 2.
const title = document.getElementById("step-title");
const step = document.getElementById("step");

function row(text, control) {
  const p = document.createElement("p");
  const label = document.createElement("label");
  label.append(`${text} `, control);
  p.append(label);
  return p;
}

function input(attrs) {
  const el = document.createElement("input");
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
}

function select(name, options) {
  const el = document.createElement("select");
  el.name = name;
  for (const value of options) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = value === "" ? "Choose…" : value;
    el.append(option);
  }
  return el;
}

function button(text, onClick) {
  const el = document.createElement("button");
  el.type = "button";
  el.textContent = text;
  el.addEventListener("click", onClick);
  return el;
}

function stepOne() {
  title.textContent = "Step 1 of 2";
  step.replaceChildren(
    row("Full name", input({ name: "fullName", autocomplete: "name" })),
    row(
      "Email",
      input({ name: "email", type: "email", autocomplete: "email" }),
    ),
    button("Next", stepTwo),
  );
}

function stepTwo() {
  title.textContent = "Step 2 of 2";
  step.replaceChildren(
    row("Street address", input({ name: "street" })),
    row("City", input({ name: "city" })),
    row("State", select("state", ["", "CA", "NY", "TX"])),
    row("Paperless billing", input({ name: "paperless", type: "checkbox" })),
    button("Back", stepOne),
  );
}

stepOne();
