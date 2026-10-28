// Shared builders for the recorder model tests (not a test file itself).
import type { ControlKind } from "../../../src/lib/fields/eligibility";
import type { Sig } from "../../../src/lib/fields/signature";
import type { ScanControl } from "../../../src/lib/messaging/content-protocol";
import { sigKey } from "../../../src/lib/match/match";
import type { Profile } from "../../../src/lib/profiles/types";
import type { Capture } from "../../../src/lib/recorder/types";

export const sig = (over: Partial<Sig> = {}): Sig => ({
  name: null,
  idStable: null,
  autocomplete: null,
  type: "text",
  labelText: null,
  ordinal: 0,
  formAction: null,
  nameIdDerived: false,
  ...over,
});

/** A control named and labelled `name`, at ordinal `i` within its form. */
export const ctrl = (
  i: number,
  name: string,
  over: Partial<Sig> = {},
  kind: ControlKind = "text",
): ScanControl => ({
  i,
  kind,
  sig: sig({ name, labelText: name, ordinal: i, ...over }),
});

export const page = (...names: string[]): ScanControl[] =>
  names.map((n, i) => ctrl(i, n));

export const keys = (controls: ScanControl[]): string[] =>
  controls.map((c) => sigKey(c.sig, c.kind));

export const capture = (
  c: ScanControl,
  value: string,
  over: Partial<Capture> = {},
): Capture => ({
  sig: c.sig,
  kind: c.kind,
  value,
  pageDefault: "",
  fieldId: null,
  ...over,
});

export const ORIGIN = "https://pay.example.com";

export function savedProfile(over: Partial<Profile> = {}): Profile {
  const step0 = page("acct", "zip");
  const step1 = page("amount", "memo");
  return {
    v: 1,
    id: "p1",
    name: "Bill pay",
    origin: ORIGIN,
    pathPrefix: "/billpay/",
    fillMode: "gesture",
    createdAt: 1_700_000_000_000,
    lastUsedAt: 1_700_000_500_000,
    steps: [
      { index: 0, pathHint: "/billpay/one", fingerprint: keys(step0) },
      { index: 1, pathHint: "/billpay/two", fingerprint: keys(step1) },
    ],
    fields: [
      {
        id: "f1",
        sig: step0[0]!.sig,
        step: 0,
        kind: "text",
        value: "12345",
        pageDefault: "",
        policy: "save",
      },
      {
        id: "f4",
        sig: step1[0]!.sig,
        step: 1,
        kind: "text",
        value: "45.12",
        pageDefault: "",
        policy: "ask",
      },
    ],
    ...over,
  };
}
