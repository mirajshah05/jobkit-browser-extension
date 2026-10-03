# Security and privacy

## Publication scope

Only the extension source, documentation, license, publication check, and synthetic tests are intended for publication. No backend data or browser storage exports are part of this repository. Copyright attribution uses the project name, not a private contact address.

`scripts/check_publication.py` validates the complete tracked-file set and scans text for common contact, local-path, and credential formats. The ignore rules are an allowlist rather than a general `git add .` safety net. Before each release, inspect the staged diff and run the check against the exact commit contents. Automated scans cannot identify every possible form of personal information; manual source review is also required.

## Boundaries

- Users may supply their own PDF through the local popup; a trusted local backend supplies prepared form answers and an optional tailored resume. This repository cannot secure another backend, the operating system, or a compromised browser profile.
- The service worker rejects messages from other extensions and unsupported page URLs. Opening jobs and connecting from the popup require the extension's own popup sender.
- Resume URLs must match approved PDF endpoints on `http://127.0.0.1:8765`. The bearer token cannot be sent to a supplied remote URL or through a redirect. Resume responses must have a PDF signature and fit the 10 MiB limit.
- API tokens use session storage; old persistent token keys are removed on connection. The user-selected PDF, contact details, and answers use local extension storage and should be treated as private data. Cached contexts expire for reuse after 15 minutes; expiration does not erase stored entries.
- Fill and submission controls ignore synthetic page-script clicks. Submission still requires the user's explicit action and review. Extension UI lives in the page DOM, so a hostile employer page can alter that UI or observe populated fields; it is not a trusted security dialog.
- There is no `externally_connectable` declaration, remote code loader, telemetry service, `eval`, or broad `all_urls` permission.
- The bootstrap endpoint is a local trust assumption. Bind the backend to loopback, authenticate other endpoints, validate origins/Host headers, and do not expose the API on a public network. Local malware or another process running as the user is outside this extension's protection.

## Reporting

Use the repository's **Security → Report a vulnerability** option if available. If private reporting is unavailable, use an issue containing only a minimal synthetic reproduction and a request for a private reporting channel. Do not post exploit details requiring confidentiality, real applicant data, resumes, authentication tokens, or screenshots containing personal details in public issues.

The current release has automated unit and static checks. It has not received an independent penetration test or a Chrome Web Store review.
