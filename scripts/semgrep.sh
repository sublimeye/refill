#!/bin/sh
# Runs Semgrep from the digest-pinned image (ADR 0005). Needs Docker.
#   scripts/semgrep.sh scan       scan the repo with the Refill rules (CI gate)
#   scripts/semgrep.sh selftest   rule tests (.semgrep/tests) + path include/exclude checks
set -eu

IMAGE="semgrep/semgrep@sha256:4a34048c04fef049f71665047f074cffb00cc3d89482f965a5cd151d589237af" # 1.182.0
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# Semgrep does not parse .mts/.cts, so the Refill rules would silently skip them. Fail loudly
# instead (ADR 0006). Usage: reject_unparsed <dir>
reject_unparsed() {
  found="$(find "$1" \( -name '*.mts' -o -name '*.cts' \) -not -path '*/node_modules/*')"
  if [ -n "$found" ]; then
    echo "error: Semgrep cannot parse .mts/.cts files, so the Refill rules would skip them." >&2
    echo "Rename to .ts/.js (ESM/CJS comes from package.json), or extend the rules first:" >&2
    echo "$found" >&2
    return 1
  fi
}

case "${1:-}" in
scan)
  reject_unparsed "$ROOT/src"
  # Target "." (not "src"): the rules' /src/** filters resolve against the scan root, which is
  # the repo root here even if Semgrep cannot detect the git root inside the container.
  exec docker run --rm -v "$ROOT:/src:ro" -w /src "$IMAGE" \
    semgrep --config .semgrep/refill.yml --config .semgrep/refill-svelte.yml \
    --error --metrics=off .
  ;;
selftest)
  # The .mts/.cts guard rejects a directory containing one and accepts one without.
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' EXIT
  mkdir -p "$tmp/clean" "$tmp/bad/sub"
  : > "$tmp/clean/a.ts"
  : > "$tmp/bad/sub/b.mts"
  reject_unparsed "$tmp/clean"
  if reject_unparsed "$tmp/bad" 2>/dev/null; then echo "guard checks FAILED: .mts accepted" >&2; exit 1; fi
  echo "guard checks: ok"
  # The repo .semgrepignore is mounted so the path checks run with it, not Semgrep's defaults.
  docker run --rm -v "$ROOT/.semgrep:/cfg:ro" -v "$ROOT/.semgrepignore:/semgrepignore:ro" -w /work "$IMAGE" sh -eu -c '
    # `semgrep --test` ignores nothing: path filters would hide the fixtures, so strip them.
    # Rule ids must be bare, so the configs live in the working directory.
    for c in refill refill-svelte; do
      awk "/^    paths:\$/{skip=1;next} skip && /^      (include|exclude):/{next} {skip=0; print}" \
        "/cfg/$c.yml" > "$c.yml"
    done
    cp /cfg/tests/* .
    n=0
    for f in *.ts; do
      echo "== $f"; semgrep --test --config refill.yml "$f"; n=$((n+1))
    done
    for f in *.svelte; do
      echo "== $f"; semgrep --test --config refill-svelte.yml "$f"; n=$((n+1))
    done
    echo "rule tests: $n fixture files passed"

    # Path include/exclude behaviour, with the real (unstripped) configs.
    cp -r /cfg/path-fixtures /pf && cp /semgrepignore /pf/.semgrepignore && cd /pf
    semgrep --config /cfg/refill.yml --config /cfg/refill-svelte.yml --metrics=off --quiet --json . \
      | python3 -I -c "
import json, sys
for r in sorted(json.load(sys.stdin)[\"results\"], key=lambda r: (r[\"path\"], r[\"check_id\"])):
    print(r[\"path\"], r[\"check_id\"].rsplit(\".\", 1)[-1])
" > /tmp/actual
    if diff /cfg/path-fixtures/EXPECTED /tmp/actual; then echo "path checks: ok"; else echo "path checks FAILED"; exit 1; fi
  '
  ;;
*)
  echo "usage: scripts/semgrep.sh scan|selftest" >&2
  exit 2
  ;;
esac
