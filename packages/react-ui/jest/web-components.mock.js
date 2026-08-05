/**
 * Stands in for any `@signalwire/web-components/<tag>` subpath.
 *
 * These are genuine custom elements — `customElements.define` really runs and
 * the element really upgrades — but they carry none of the Lit machinery. That
 * keeps the suite hermetic and fast, and it is the right boundary: the Lit
 * components' own behaviour is tested in the SDK repo. What we verify here is
 * the `createComponent` wiring, which needs only a real element to bind to.
 *
 * The stub declares `call` as a real accessor because `createComponent` decides
 * property-versus-attribute by checking whether the name exists on the element
 * prototype. Without it, the object-prop test would pass for the wrong reason.
 */
const created = new Map();

/** `SwCallControls` -> `sw-call-controls` */
const tagFor = (className) =>
  className.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();

function makeElementClass(className) {
  class SwStubElement extends HTMLElement {
    #call;

    get call() {
      return this.#call;
    }

    set call(value) {
      this.#call = value;
    }
  }

  const tag = tagFor(className);
  if (!customElements.get(tag)) {
    customElements.define(tag, SwStubElement);
  }
  return SwStubElement;
}

module.exports = new Proxy(
  {},
  {
    get(_target, name) {
      if (typeof name !== 'string' || name === '__esModule') {
        return undefined;
      }
      if (!created.has(name)) {
        created.set(name, makeElementClass(name));
      }
      return created.get(name);
    },
    has() {
      return true;
    }
  }
);
