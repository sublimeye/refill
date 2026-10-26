declare const code: string;

// ruleid: refill-no-eval
eval(code);
// ruleid: refill-no-eval
window.eval(code);
// ruleid: refill-no-eval
globalThis.eval(code);
// ruleid: refill-no-eval
self.eval(code);
// ruleid: refill-no-eval
window["eval"](code);
// ruleid: refill-no-eval
new Function(code);
// ruleid: refill-no-eval
Function(code);
// ruleid: refill-no-eval
window.Function(code);
// ruleid: refill-no-eval
new window.Function(code);
// ruleid: refill-no-eval
new globalThis.Function("a", code);
// ruleid: refill-no-eval
setTimeout("doIt()", 10);
// ruleid: refill-no-eval
setInterval("doIt()", 10);
// ruleid: refill-no-eval
window.setTimeout("doIt()", 10);
// ruleid: refill-no-eval
globalThis.setInterval("doIt()", 10);

// ok: refill-no-eval
setTimeout(() => code.length, 10);
// ok: refill-no-eval
setInterval(function () {}, 10);
// ok: refill-no-eval
const evaluate = (s: string) => s.length;
