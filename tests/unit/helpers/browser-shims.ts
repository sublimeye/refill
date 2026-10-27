// fakeBrowser implements neither `scripting` nor `permissions`; these small stand-ins model just
// what the site code uses, including Chrome's "Duplicate script ID" error.
import { vi } from "vitest";
import { fakeBrowser } from "wxt/testing/fake-browser";

export interface TestEvent<A extends unknown[]> {
  addListener(fn: (...a: A) => void): void;
  fire(...a: A): void;
}

function testEvent<A extends unknown[]>(): TestEvent<A> {
  const listeners: ((...a: A) => void)[] = [];
  return {
    addListener: (fn) => void listeners.push(fn),
    fire: (...a) => listeners.forEach((fn) => fn(...a)),
  };
}

export interface RegisteredScript {
  id: string;
  matches: string[];
  js: string[];
  [k: string]: unknown;
}

export function installShims() {
  const scripts = new Map<string, RegisteredScript>();
  const grants = new Set<string>();
  const tick = () => new Promise<void>((r) => setTimeout(r, 0));

  const scripting = {
    registerContentScripts: vi.fn(async (list: RegisteredScript[]) => {
      await tick();
      for (const s of list) {
        if (scripts.has(s.id)) throw new Error(`Duplicate script ID '${s.id}'`);
      }
      for (const s of list) scripts.set(s.id, structuredClone(s));
    }),
    updateContentScripts: vi.fn(async (list: RegisteredScript[]) => {
      await tick();
      for (const s of list) {
        if (!scripts.has(s.id))
          throw new Error(`Nonexistent script ID '${s.id}'`);
      }
      for (const s of list) scripts.set(s.id, structuredClone(s));
    }),
    unregisterContentScripts: vi.fn(async (f?: { ids?: string[] }) => {
      await tick();
      for (const id of f?.ids ?? [...scripts.keys()]) scripts.delete(id);
    }),
    getRegisteredContentScripts: vi.fn(async (f?: { ids?: string[] }) => {
      await tick();
      return [...scripts.values()]
        .filter((s) => !f?.ids || f.ids.includes(s.id))
        .map((s) => structuredClone(s));
    }),
    executeScript: vi.fn(async (opts: unknown) => (void opts, [])),
  };

  const onAdded = testEvent<[{ origins?: string[] }]>();
  const onRemoved = testEvent<[{ origins?: string[] }]>();
  const permissions = {
    contains: vi.fn(async (p: { origins?: string[] }) =>
      (p.origins ?? []).every((o) => grants.has(o)),
    ),
    request: vi.fn(async (p: { origins?: string[] }) => (void p, true)),
    remove: vi.fn(async (p: { origins?: string[] }) => {
      for (const o of p.origins ?? []) grants.delete(o);
      return true;
    }),
    onAdded,
    onRemoved,
  };

  const fb = fakeBrowser as unknown as Record<string, unknown>;
  fb["scripting"] = scripting;
  fb["permissions"] = permissions;

  return {
    scripts,
    grants,
    scripting,
    permissions,
    /** Grant without firing an event (as for a pre-granted or earlier grant). */
    grant: (pattern: string) => void grants.add(pattern),
    /** The user revokes in the browser's own UI: permission gone, `onRemoved` fires. */
    revoke: (pattern: string) => {
      grants.delete(pattern);
      onRemoved.fire({ origins: [pattern] });
    },
    /** The user accepts a request: permission present, `onAdded` fires. */
    accept: (pattern: string) => {
      grants.add(pattern);
      onAdded.fire({ origins: [pattern] });
    },
  };
}
