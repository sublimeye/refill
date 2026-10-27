// Minimal react-select behaviour: focusing the combobox opens the listbox, clicking an option
// stores its value in the hidden input and shows its label. Typing alone selects nothing.
const combo = document.getElementById("react-select-3-input");
const listbox = document.getElementById("react-select-3-listbox");
const hidden = document.querySelector('input[name="state"]');
const placeholder = document.getElementById("react-select-3-placeholder");

function open(state) {
  listbox.hidden = !state;
  combo.setAttribute("aria-expanded", String(state));
}

combo.addEventListener("focus", () => open(true));
combo.addEventListener("blur", () => open(false));
listbox.addEventListener("mousedown", (e) => {
  const option = e.target.closest('[role="option"]');
  if (option === null) return;
  hidden.value = option.dataset.value;
  placeholder.textContent = option.textContent;
  combo.value = "";
  open(false);
});
