declare const el: HTMLElement;
declare const html: string;

// ruleid: refill-no-html-sinks
el.innerHTML = html;
// ruleid: refill-no-html-sinks
el.innerHTML += html;
// ruleid: refill-no-html-sinks
el.outerHTML = html;
// ruleid: refill-no-html-sinks
el.outerHTML += html;
// ruleid: refill-no-html-sinks
el["innerHTML"] = html;
// ruleid: refill-no-html-sinks
el["outerHTML"] = html;
// ruleid: refill-no-html-sinks
el.insertAdjacentHTML("beforeend", html);
// ruleid: refill-no-html-sinks
el["insertAdjacentHTML"]("beforeend", html);
// ruleid: refill-no-html-sinks
el.setHTMLUnsafe(html);
// ruleid: refill-no-html-sinks
el["setHTMLUnsafe"](html);
// ruleid: refill-no-html-sinks
Document.parseHTMLUnsafe(html);
// ruleid: refill-no-html-sinks
document.write(html);
// ruleid: refill-no-html-sinks
document.writeln(html);
// ruleid: refill-no-html-sinks
window.document.write(html);
// ruleid: refill-no-html-sinks
window.document.writeln(html);
// ruleid: refill-no-html-sinks
globalThis.document.write(html);
// ruleid: refill-no-html-sinks
document["write"](html);

// ok: refill-no-html-sinks
el.textContent = html;
// ok: refill-no-html-sinks
el.replaceChildren(document.createTextNode(html));
// ok: refill-no-html-sinks
const read = el.innerHTML.length;
