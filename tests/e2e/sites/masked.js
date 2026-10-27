// A keystroke-driven phone mask that keeps its own model: it formats what the user types (trusted
// `input` events) and puts its own value back when a script writes the field (untrusted events).
const phone = document.querySelector('input[name="phone"]');
let shown = "";

function format(digits) {
  const d = digits.slice(0, 10);
  if (d.length < 4) return d;
  if (d.length < 7) return `(${d.slice(0, 3)}) ${d.slice(3)}`;
  return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`;
}

phone.addEventListener("input", (e) => {
  if (e.isTrusted) {
    shown = format(phone.value.replace(/\D/g, ""));
    document.documentElement.dataset.maskTrusted = "1";
  }
  phone.value = shown;
});
