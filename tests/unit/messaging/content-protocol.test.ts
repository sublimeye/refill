import { describe, expect, it } from "vitest";
import {
  MAX_CAPTURE_VALUE,
  MAX_CONTROLS,
  MAX_ORDINAL,
  MAX_SIG_STRING,
  parseContentRequest,
} from "../../../src/lib/messaging/content-protocol";

const sig = (o: Record<string, unknown> = {}) => ({
  name: "email",
  idStable: "email",
  autocomplete: "email",
  type: "email",
  labelText: "email",
  ordinal: 0,
  formAction: null,
  nameIdDerived: false,
  ...o,
});
const control = (i: unknown, o: Record<string, unknown> = {}) => ({
  i,
  kind: "text",
  sig: sig(),
  ...o,
});
const scan = (o: Record<string, unknown> = {}) => ({
  type: "scan-report",
  controls: [control(0)],
  truncated: false,
  ...o,
});
const result = (o: Record<string, unknown> = {}) => ({
  type: "fill-result",
  filled: 1,
  skipped: 0,
  unsupported: 0,
  ...o,
});

describe("parseContentRequest", () => {
  it("accepts both shapes and returns fresh objects", () => {
    const raw = scan();
    const parsed = parseContentRequest(raw);
    expect(parsed).toEqual(raw);
    expect(parsed).not.toBe(raw);
    if (parsed?.type !== "scan-report") throw new Error("unreachable");
    expect(parsed.controls).not.toBe(raw.controls);
    expect(parsed.controls[0]).not.toBe(raw.controls[0]);
    expect(parsed.controls[0]!.sig).not.toBe(raw.controls[0]!.sig);
    expect(parseContentRequest(result())).toEqual(result());
  });

  it("accepts every control kind, null sig strings and an empty report", () => {
    const controls = ["text", "select", "checkbox", "radio"].map((kind, i) =>
      control(i, {
        kind,
        sig: sig({
          name: null,
          idStable: null,
          autocomplete: null,
          labelText: null,
          formAction: null,
          nameIdDerived: true,
        }),
      }),
    );
    expect(parseContentRequest(scan({ controls }))).not.toBeNull();
    expect(
      parseContentRequest(scan({ controls: [], truncated: true })),
    ).not.toBeNull();
  });

  it("accepts 300 controls and rejects 301", () => {
    const ok = Array.from({ length: MAX_CONTROLS }, (_, i) => control(i));
    expect(MAX_CONTROLS).toBe(300);
    expect(parseContentRequest(scan({ controls: ok }))).not.toBeNull();
    const tooMany = [...ok, control(0)];
    expect(parseContentRequest(scan({ controls: tooMany }))).toBeNull();
  });

  it("accepts 256-char sig strings and rejects 257", () => {
    expect(MAX_SIG_STRING).toBe(256);
    for (const key of [
      "name",
      "idStable",
      "autocomplete",
      "type",
      "labelText",
      "formAction",
    ]) {
      const at = scan({
        controls: [control(0, { sig: sig({ [key]: "x".repeat(256) }) })],
      });
      const over = scan({
        controls: [control(0, { sig: sig({ [key]: "x".repeat(257) }) })],
      });
      expect(parseContentRequest(at), key).not.toBeNull();
      expect(parseContentRequest(over), key).toBeNull();
    }
  });

  it.each([
    ["page message type", { type: "vault-unlock", passphrase: "x" }],
    [
      "unknown type",
      { type: "record-start", tabId: 1, origin: "https://a.example" },
    ],
    ["array", [scan()]],
    ["null", null],
    ["string", "scan-report"],
    ["class instance", Object.assign(new (class X {})(), scan())],
    ["payload origin", scan({ origin: "https://evil.example" })],
    ["payload url", scan({ url: "https://evil.example/" })],
    ["payload now", result({ now: 1 })],
    ["missing truncated", { type: "scan-report", controls: [] }],
    ["truncated not boolean", scan({ truncated: 0 })],
    ["controls not array", scan({ controls: { 0: control(0) } })],
    ["control extra key", scan({ controls: [control(0, { value: "x" })] })],
    ["control missing key", scan({ controls: [{ i: 0, kind: "text" }] })],
    ["control not object", scan({ controls: [0] })],
    ["sparse controls", scan({ controls: new Array(1) })],
    ["duplicate i", scan({ controls: [control(3), control(3)] })],
    ["negative i", scan({ controls: [control(-1)] })],
    ["i 300", scan({ controls: [control(300)] })],
    ["fractional i", scan({ controls: [control(1.5)] })],
    ["string i", scan({ controls: [control("1")] })],
    ["unknown kind", scan({ controls: [control(0, { kind: "password" })] })],
    [
      "sig extra key",
      scan({ controls: [control(0, { sig: sig({ value: "x" }) })] }),
    ],
    [
      "sig missing key",
      scan({
        controls: [
          control(0, {
            sig: Object.fromEntries(
              Object.entries(sig()).filter(([k]) => k !== "labelText"),
            ),
          }),
        ],
      }),
    ],
    [
      "sig type null",
      scan({ controls: [control(0, { sig: sig({ type: null }) })] }),
    ],
    [
      "sig name number",
      scan({ controls: [control(0, { sig: sig({ name: 1 }) })] }),
    ],
    [
      "sig ordinal negative",
      scan({ controls: [control(0, { sig: sig({ ordinal: -1 }) })] }),
    ],
    [
      "sig ordinal over cap",
      scan({
        controls: [control(0, { sig: sig({ ordinal: MAX_ORDINAL + 1 }) })],
      }),
    ],
    [
      "sig ordinal fractional",
      scan({ controls: [control(0, { sig: sig({ ordinal: 0.5 }) })] }),
    ],
    [
      "sig derived not boolean",
      scan({ controls: [control(0, { sig: sig({ nameIdDerived: "no" }) })] }),
    ],
    ["sig null", scan({ controls: [control(0, { sig: null })] })],
    ["filled negative", result({ filled: -1 })],
    ["filled 301", result({ filled: 301 })],
    ["skipped fractional", result({ skipped: 0.5 })],
    ["unsupported string", result({ unsupported: "1" })],
    ["unsupported NaN", result({ unsupported: NaN })],
    ["fill-result missing key", { type: "fill-result", filled: 0, skipped: 0 }],
  ])("rejects %s", (_name, raw) => {
    expect(parseContentRequest(raw)).toBeNull();
  });

  it("accepts the caps exactly: ordinal 10 000, i 299, counts 300", () => {
    expect(MAX_ORDINAL).toBe(10_000);
    expect(
      parseContentRequest(
        scan({ controls: [control(299, { sig: sig({ ordinal: 10_000 }) })] }),
      ),
    ).not.toBeNull();
    expect(
      parseContentRequest(
        result({ filled: 300, skipped: 300, unsupported: 300 }),
      ),
    ).not.toBeNull();
  });

  it("rejects a JSON-parsed __proto__ key at every level", () => {
    const top = JSON.parse(
      '{"type":"fill-result","filled":0,"skipped":0,"unsupported":0,"__proto__":{}}',
    ) as unknown;
    expect(parseContentRequest(top)).toBeNull();
    const nested = JSON.parse(
      JSON.stringify(scan()).replace('"i":0', '"i":0,"__proto__":{}'),
    ) as unknown;
    expect(parseContentRequest(nested)).toBeNull();
  });

  it("rejects a symbol key", () => {
    const raw = { ...result(), [Symbol("x")]: 1 };
    expect(parseContentRequest(raw)).toBeNull();
  });
});

const without = (o: Record<string, unknown>, key: string) =>
  Object.fromEntries(Object.entries(o).filter(([k]) => k !== key));

describe("recording requests", () => {
  const cap = (o: Record<string, unknown> = {}) => ({
    type: "record-capture",
    kind: "text",
    sig: sig(),
    value: "v",
    pageDefault: "",
    fieldId: null,
    ...o,
  });

  it("accepts the three shapes and returns fresh objects", () => {
    expect(parseContentRequest({ type: "record-status" })).toEqual({
      type: "record-status",
    });
    expect(parseContentRequest({ type: "record-finish" })).toEqual({
      type: "record-finish",
    });
    const raw = cap({ fieldId: "f_1-A" });
    const parsed = parseContentRequest(raw);
    expect(parsed).toEqual(raw);
    expect(parsed).not.toBe(raw);
    if (parsed?.type !== "record-capture") throw new Error("unreachable");
    expect(parsed.sig).not.toBe(raw.sig);
  });

  it("accepts every kind, a 4096-char value and page default, and a 64-char field id", () => {
    expect(MAX_CAPTURE_VALUE).toBe(4096);
    for (const kind of ["text", "select", "checkbox", "radio"]) {
      expect(parseContentRequest(cap({ kind })), kind).not.toBeNull();
    }
    expect(
      parseContentRequest(
        cap({
          value: "x".repeat(4096),
          pageDefault: "y".repeat(4096),
          fieldId: "f".repeat(64),
        }),
      ),
    ).not.toBeNull();
  });

  it.each([
    ["status extra key", { type: "record-status", tabId: 1 }],
    ["finish extra key", { type: "record-finish", id: "abc" }],
    ["finish payload now", { type: "record-finish", now: 1 }],
    ["capture extra key", cap({ origin: "https://evil.example" })],
    ["capture missing fieldId", without(cap(), "fieldId")],
    ["capture missing pageDefault", without(cap(), "pageDefault")],
    ["a 4097-char value", cap({ value: "x".repeat(4097) })],
    ["a 4097-char page default", cap({ pageDefault: "x".repeat(4097) })],
    ["a value that is not a string", cap({ value: 1 })],
    ["a null value", cap({ value: null })],
    ["a page default that is not a string", cap({ pageDefault: false })],
    ["an empty field id", cap({ fieldId: "" })],
    ["a field id with a space", cap({ fieldId: "f 1" })],
    ["a field id with a slash", cap({ fieldId: "../f1" })],
    ["a 65-char field id", cap({ fieldId: "f".repeat(65) })],
    ["a numeric field id", cap({ fieldId: 1 })],
    ["an unknown kind", cap({ kind: "password" })],
    ["a sig with an extra key", cap({ sig: sig({ value: "x" }) })],
    [
      "a 257-char sig string",
      cap({ sig: sig({ labelText: "x".repeat(257) }) }),
    ],
    ["a null sig", cap({ sig: null })],
  ])("rejects %s", (_name, raw) => {
    expect(parseContentRequest(raw)).toBeNull();
  });

  it("rejects record-start, a page-only request", () => {
    expect(
      parseContentRequest({
        type: "record-start",
        tabId: 1,
        origin: "https://a.example",
      }),
    ).toBeNull();
    expect(parseContentRequest({ type: "record-start" })).toBeNull();
  });
});
