// Clobber-proof DOM reads for the field modules. DOM-only, zero runtime dependencies: this runs in
// the content script on hostile pages.
//
// `<form>` is [LegacyOverrideBuiltIns]: a control named like one of its properties replaces that
// property on the form (`<form><input name="nodeType">` makes `form.nodeType` an element, and
// `name="parentNode"` or `name="firstChild"` redirect a tree walk). Any element that can be a form
// (an ancestor, a label's content, an aria-labelledby target) must therefore be read through the
// prototype accessors captured here, never through `el.prop`. The prototypes are the content
// script's own (isolated world), which the page cannot modify. Controls themselves (input, select,
// textarea) have no named-property getter, so reading them directly is safe.

function getter<T>(proto: object, prop: string): (node: object) => T {
  const get = Object.getOwnPropertyDescriptor(proto, prop)?.get;
  if (get === undefined) throw new Error(`missing accessor ${prop}`);
  return (node) => get.call(node) as T;
}

export const nodeType = getter<number>(Node.prototype, "nodeType");
export const parentNode = getter<Node | null>(Node.prototype, "parentNode");
export const firstChild = getter<Node | null>(Node.prototype, "firstChild");
export const nextSibling = getter<Node | null>(Node.prototype, "nextSibling");

export const localName = getter<string>(Element.prototype, "localName");
export const shadowRoot = getter<ShadowRoot | null>(
  Element.prototype,
  "shadowRoot",
);
export const scrollHeight = getter<number>(Element.prototype, "scrollHeight");
export const scrollWidth = getter<number>(Element.prototype, "scrollWidth");
export const scrollTop = getter<number>(Element.prototype, "scrollTop");
export const clientHeight = getter<number>(Element.prototype, "clientHeight");
export const clientWidth = getter<number>(Element.prototype, "clientWidth");
export const clientLeft = getter<number>(Element.prototype, "clientLeft");
export const clientTop = getter<number>(Element.prototype, "clientTop");

export const hasAttr = (el: Element, name: string): boolean =>
  Element.prototype.hasAttribute.call(el, name);
export const getAttr = (el: Element, name: string): string | null =>
  Element.prototype.getAttribute.call(el, name);
export const boundingRect = (el: Element): DOMRect =>
  Element.prototype.getBoundingClientRect.call(el);
