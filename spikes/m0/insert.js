const input = document.getElementById("field");
const logEl = document.getElementById("log");
window.__events = [];
function log(s) { logEl.textContent += s + "\n"; }
for (const type of ["beforeinput", "input"]) {
  input.addEventListener(type, (event) => {
    window.__events.push({ type, isTrusted: event.isTrusted, inputType: event.inputType, data: event.data });
    log(type + " isTrusted=" + event.isTrusted + " inputType=" + event.inputType);
  });
}
document.getElementById("go").onclick = () => {
  input.focus();
  input.select();
  const ok = document.execCommand("insertText", false, "x");
  window.__execOk = ok;
  log("execCommand returned " + ok + "; value=" + input.value);
};
