# Security policy

## Reporting a vulnerability

Please report vulnerabilities **privately** through GitHub Security Advisories:
<https://github.com/sublimeye/refill/security/advisories/new>

Do not open a public issue or pull request for a suspected vulnerability. Include the Refill
version (or commit), the Chromium version, and steps or a proof of concept to reproduce. I will
acknowledge a report as soon as I can and coordinate a fix and disclosure with you. This is a
single-maintainer, spare-time project, so there is no response-time SLA.

## Scope

In scope:

- The extension source in this repository (`src/`) and the release builds produced from it.
- Anything that breaks the properties in [`docs/security/threat-model.md`](docs/security/threat-model.md): saved
  values leaking to a page, another extension or the network; decryption without the passphrase;
  filling into the wrong origin, field or frame; bypassing the lock policy; weakening of the
  manifest permissions or CSP.
- Build and CI supply-chain issues in this repository (workflows, pinned actions, dependencies).

Out of scope (accepted residual risk, listed in the threat model, section "Out of scope"):

- Malware with OS-level access (keyloggers, memory readers).
- An attacker with write access to the browser profile who patches the extension itself.
- Scripts on the same origin reading values after Refill fills them into that origin's form.
- Vulnerabilities in Chromium, the operating system or third-party sites.
- Findings that need a rooted or already-compromised machine, or social engineering of the user.

## Bounty

There is no bug bounty. Credit in the advisory and release notes is offered if you want it.

## Supported versions

Only the latest release (and `main`) receives security fixes.
