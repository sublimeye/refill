# ADR 0005: CI supply-chain pinning

## Context
CI runs on every PR and push to `main` and gates merges (`ci / verify`, `codeql / analyze`). Spec §8.2 lists a supply-chain attacker and a hijacked publisher account as in-scope adversaries. Mutable references (`@v4`, `:latest`) let a compromised upstream tag run arbitrary code in our workflows with the repository token and the build output.

## Decision
- Every third-party GitHub Action is referenced by the **full 40-character commit SHA**, with the human-readable tag in a trailing comment: `actions/checkout` v7.0.1, `actions/setup-node` v7.1.0, `pnpm/action-setup` v6.1.0, `google/osv-scanner-action/osv-scanner-action` v2.7.0, `github/codeql-action/{init,analyze}` v4.39.1. Annotated tags were dereferenced to the commit they point to (`gh api .../git/tags/<sha>`), not the tag object.
- Semgrep runs from the container image **`semgrep/semgrep` pinned by sha256 digest** (tag 1.182.0, `sha256:4a34048c…37af`) via `docker run` in `scripts/semgrep.sh` (the one place the digest lives; CI and local runs share it). This is the image formerly published as `returntocorp/semgrep`; the org was renamed. Running the pinned image, not `pip install semgrep`, keeps the tool version independent of PyPI resolution.
- The pinned OSV-Scanner action runs `ghcr.io/google/osv-scanner-action:v2.7.0`, a tag (not a digest) declared inside the action's own `action.yml`. We cannot change that without forking the action; the risk is accepted and noted below.
- Workflows default to `permissions: contents: read`; only the CodeQL job adds `security-events: write`. `actions/checkout` uses `persist-credentials: false`. No secrets are used.
- Node is pinned to the major (`23`) via `actions/setup-node`; pnpm is pinned by the `packageManager` field in `package.json`. All npm dependencies are exact versions with a committed lockfile and `--frozen-lockfile`.
- Bumps are manual: update SHA and comment together, re-resolve the commit from the tag, and note it in the PR.

## Consequences
- A moved or deleted upstream tag cannot silently change what CI executes.
- Pins go stale: security fixes in actions need a deliberate bump. Mitigated by the weekly CodeQL run and OSV-Scanner, but Dependabot for `github-actions` is not enabled; revisit if bump toil is low-risk to automate.
- The OSV-Scanner image tag is the one pin that is not a digest (see Decision).
- The reproducible-build check and Semgrep/OSV gates fail closed: any non-zero exit blocks the merge.

## Status
Accepted.
