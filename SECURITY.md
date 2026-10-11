# Security policy

## Reporting a vulnerability

Please report vulnerabilities in roost privately through [GitHub security advisories](https://github.com/thinkingraven/roost/security/advisories/new), or email **hello@thinkingraven.com**. Don't open a public issue.

We aim to reply within 3 working days and to ship a fix or mitigation within 30 days, and we'll credit you in the release notes unless you'd rather we didn't.

## In scope

- Any way roost makes a network request, or prompt or response text from a session log ends up in its output, reports or summaries.
- Any way a crafted log file makes roost execute code, or read or write outside the folders it was pointed at.
- Crafted input that hangs or crashes roost.
- The home folder or other personal paths leaking into reports.

## Supported versions

Only the latest release gets security fixes.
