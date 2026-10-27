// Encrypted records in storage.local: JSON sealed with the DEK under a caller-supplied AAD that
// binds the ciphertext to its key/role (see crypto/aad.ts).
import { DecryptError, open, seal } from "../crypto/aead";
import { fromUtf8, utf8 } from "../crypto/bytes";
import { getItem, setItems, type StoreTx } from "../store/local";
import { TAG_BYTES, parseSealed } from "./header";
import { getDek } from "./vault";

/**
 * Seals `JSON.stringify(value)` and writes it. Pass `tx` when called inside a `withStoreLock`
 * job (the public writer would deadlock there). Throws `LockedError` when locked, `TypeError`
 * for a value with no JSON form.
 */
export async function putEncrypted(
  key: string,
  aadBytes: Uint8Array,
  value: unknown,
  tx?: StoreTx,
): Promise<void> {
  const dek = await getDek();
  const json = JSON.stringify(value) as string | undefined;
  if (json === undefined) {
    throw new TypeError("value has no JSON representation");
  }
  const pt = utf8(json);
  let sealed;
  try {
    sealed = await seal(dek, pt, aadBytes);
  } finally {
    pt.fill(0);
  }
  const item = { [key]: sealed };
  await (tx ? tx.setItems(item) : setItems(item));
}

/**
 * `undefined` when absent. Throws `LockedError` when locked and `DecryptError` for a malformed,
 * tampered or mismatched-AAD record. Pass `tx` to read inside a `withStoreLock` job, so a
 * read-modify-write sees no interleaved write.
 */
export async function getEncrypted<T>(
  key: string,
  aadBytes: Uint8Array,
  tx?: StoreTx,
): Promise<T | undefined> {
  const dek = await getDek();
  const raw = await (tx ? tx.getItem(key) : getItem(key));
  if (raw === undefined) return undefined;
  const sealed = parseSealed(raw, TAG_BYTES, Number.MAX_SAFE_INTEGER);
  if (!sealed) throw new DecryptError();
  const pt = await open(dek, sealed, aadBytes);
  try {
    return JSON.parse(fromUtf8(pt)) as T;
  } finally {
    pt.fill(0);
  }
}
