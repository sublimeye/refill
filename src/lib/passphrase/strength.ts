// Passphrase strength for onboarding only. zxcvbn-ts (with its dictionaries) is large, so this
// module must never be imported from the service worker or the popup (ADR 0015).
import { ZxcvbnFactory } from "@zxcvbn-ts/core";
import * as common from "@zxcvbn-ts/language-common";
import * as en from "@zxcvbn-ts/language-en";
import { meetsMinLength } from "./rules";

const zxcvbn = new ZxcvbnFactory({
  graphs: common.adjacencyGraphs,
  dictionary: { ...common.dictionary, ...en.dictionary },
  translations: en.translations,
});

export interface PassphraseScore {
  score: 0 | 1 | 2 | 3 | 4;
  acceptable: boolean;
  feedback: string;
}

/** Acceptable iff zxcvbn score is at least 3 and the NFC form has at least 12 characters. */
export function scorePassphrase(p: string): PassphraseScore {
  const normalized = p.normalize("NFC");
  const result = zxcvbn.check(normalized);
  const longEnough = meetsMinLength(normalized);
  const acceptable = result.score >= 3 && longEnough;
  let feedback =
    result.feedback.warning ?? result.feedback.suggestions[0] ?? "";
  if (!longEnough && p.length > 0) feedback = "Use at least 12 characters.";
  return { score: result.score, acceptable, feedback };
}
