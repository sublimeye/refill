// Refill's drop-in replacement for the `deepmerge` npm package (4.x API: deepmerge(target, source,
// options) and deepmerge.all), wired in through `pnpm.overrides` in package.json. Upstream 4.3.1
// has an unfixed prototype-poisoning advisory (GHSA-gcqx-w48m-w2h4). Build-time only: the Svelte
// Vite plugin merges its own config with it; nothing of it ships in the extension.
// Same behaviour as upstream, except that `__proto__`, `constructor` and `prototype` keys are never
// copied, at any depth, and keys the target only inherits are never written (as upstream).
"use strict";

const UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const hasOwn = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);
const isEnumerable = (obj, key) =>
  Object.prototype.propertyIsEnumerable.call(obj, key);

function defaultIsMergeableObject(value) {
  if (value === null || typeof value !== "object") return false;
  const tag = Object.prototype.toString.call(value);
  return tag !== "[object RegExp]" && tag !== "[object Date]";
}

function emptyTarget(value) {
  return Array.isArray(value) ? [] : {};
}

function cloneUnlessOtherwiseSpecified(value, options) {
  return options.clone !== false && options.isMergeableObject(value)
    ? deepmerge(emptyTarget(value), value, options)
    : value;
}

function defaultArrayMerge(target, source, options) {
  return target
    .concat(source)
    .map((element) => cloneUnlessOtherwiseSpecified(element, options));
}

/** Own enumerable string keys and symbols. */
function keysOf(obj) {
  return [
    ...Object.keys(obj),
    ...Object.getOwnPropertySymbols(obj).filter((s) => isEnumerable(obj, s)),
  ];
}

function isObjectLike(value) {
  return (
    value !== null && (typeof value === "object" || typeof value === "function")
  );
}

/** True for a dangerous key, or one the target has only through its prototype chain. */
function isUnsafe(target, key) {
  if (UNSAFE_KEYS.has(key)) return true;
  if (!isObjectLike(target)) return false;
  return key in target && !(hasOwn(target, key) && isEnumerable(target, key));
}

function mergeFunction(key, options) {
  if (!options.customMerge) return deepmerge;
  const custom = options.customMerge(key);
  return typeof custom === "function" ? custom : deepmerge;
}

function mergeObject(target, source, options) {
  const destination = {};
  if (options.isMergeableObject(target)) {
    for (const key of keysOf(target)) {
      if (UNSAFE_KEYS.has(key)) continue;
      destination[key] = cloneUnlessOtherwiseSpecified(target[key], options);
    }
  }
  for (const key of keysOf(source)) {
    if (isUnsafe(target, key)) continue;
    if (
      isObjectLike(target) &&
      hasOwn(target, key) &&
      options.isMergeableObject(source[key])
    ) {
      destination[key] = mergeFunction(key, options)(
        target[key],
        source[key],
        options,
      );
    } else {
      destination[key] = cloneUnlessOtherwiseSpecified(source[key], options);
    }
  }
  return destination;
}

function deepmerge(target, source, options) {
  const opts = Object.assign({}, options);
  opts.arrayMerge = opts.arrayMerge || defaultArrayMerge;
  opts.isMergeableObject = opts.isMergeableObject || defaultIsMergeableObject;
  // Exposed to custom arrayMerge functions, as upstream does.
  opts.cloneUnlessOtherwiseSpecified = cloneUnlessOtherwiseSpecified;
  const sourceIsArray = Array.isArray(source);
  if (sourceIsArray !== Array.isArray(target)) {
    return cloneUnlessOtherwiseSpecified(source, opts);
  }
  if (sourceIsArray) return opts.arrayMerge(target, source, opts);
  return mergeObject(target, source, opts);
}

deepmerge.all = function all(array, options) {
  if (!Array.isArray(array)) {
    throw new Error("first argument should be an array");
  }
  return array.reduce((prev, next) => deepmerge(prev, next, options), {});
};

module.exports = deepmerge;
