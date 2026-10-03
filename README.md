# Jobkit Browser Extension

A Chrome Manifest V3 extension that lets you choose your own PDF resume and attach it to a job application. Full form filling uses a package prepared by a local Jobkit backend. Click **Fill + Learn**, review the populated form, and submit explicitly when ready.

This repository contains the browser extension and synthetic tests only. It contains no applicant profile, resume, answers, database, API token, application screenshots, or private backend configuration.

## What it does

- Fills text fields, native dropdowns, React selects, and city autocomplete controls from a prepared package.
- Attaches the prepared PDF resume from the local API.
- Captures application questions and learns user corrections locally after Fill + Learn starts.
- Binds packages and cached answers to the current job; a cached package expires after 15 minutes.
- Requires a real user click to start filling and to use **Submit now**. Page load and timers do not submit applications.
- Leaves missing personal answers blank. Voluntary EEO filling requires an explicit backend opt-in and supplied answers.

Greenhouse forms are the primary supported workflow. Lever, Ashby, and selected employer career pages are recognized, but filling depends on a compatible backend package and the live form. Website changes can break individual widgets; review every answer.

## Use your own resume without a backend

1. Load the `extension/` directory as an unpacked extension in Chrome.
2. Open the extension popup and select **Your resume**: a PDF up to **4 MiB**. You can select a new PDF to replace it, or use **Remove my saved resume**.
3. Open a supported job application page and click Jobkit's **Attach my resume** button. This deliberately shares your selected file with that employer's upload control.
4. Review the attachment and complete the remaining form yourself. This action does not submit the application.

No sample or maintainer resume is bundled. Your selected file is stored in your browser's local extension storage, never in this source repository or on a Jobkit-hosted server. When using Fill + Learn with a backend package, your selected resume takes priority over the backend's PDF. Remove your saved resume to use the backend's prepared version again.

## Install and use full form filling

1. Download this repository or clone it.
2. Start a compatible, trusted Jobkit backend on **`http://127.0.0.1:8765`**, bound to loopback only.
3. In Chrome, open `chrome://extensions`, enable **Developer mode**, select **Load unpacked**, and choose this repository's **`extension/`** directory.
4. Open the extension popup and click **Connect API**.
5. Prepare a job-specific package in your local backend, open that job, and click **Fill + Learn**.
6. Review the contact information, resume attachment, dropdown selections, essay, authorization, and optional demographic answers before submitting.

The Python Jobkit backend and resume editor are **not bundled here**. The standalone resume picker works without that backend. Installing this extension alone does not create resumes or prepare full application packages. Use your own backend and data; this release has no preset applicant identity. Unpacked installation is for development; this repository is not a Chrome Web Store listing.

After updating an unpacked extension, click **Reload** on its extensions card and refresh the job tab.

## Local API contract

The backend must return JSON for these endpoints and use bearer authentication after bootstrap:

| Endpoint | Purpose |
| --- | --- |
| `GET /api/auth/bootstrap` | Return a session token as `{ "token": "..." }`. |
| `GET /api/ledger/applications?limit=1` | Return an `applications` array with the latest prepared application's `apply_url`. |
| `GET /api/extension/context` | Accept `url`, `platform`, `board_token`, `job_id`, and optional `application_id`; return the package for that exact job. |
| `POST /api/extension/capture` | Receive job-scoped fields, question snapshots, validation state, and submission state; return learned answers or refreshed context. |
| `GET /api/ledger/applications/{id}/resume` | Return the prepared PDF resume. |
| `GET /api/projects/{project}/approved/{version}/pdf` | Alternative prepared PDF endpoint. |

Context includes `application_id`, `platform`, `board_token`, `job_id`, `company`, `job_title`, `contact`, `field_values`, `field_meta`, `learned_answers`, `static_answers`, and a local `resume_download_url`. Field metadata supplies each field's `name`, `label`, `widget`, and `required` status. `field_values` supplies explicit answers keyed by DOM field name.

`static_answers` may provide `email`, `current_employer`, `country`, `us_state`, `authorized_to_work`, `requires_sponsorship`, `sponsorship_assistance_detail`, `open_to_relocation`, `interviewed_before`, and `applied_to_role_before`. EEO answers require `fill_voluntary_eeo: true` plus the relevant explicit answers. The backend must protect its own private files and must not substitute another applicant's defaults.

## Privacy and permissions

- **No telemetry, analytics, external scripts, or hosted AI calls are included.** Extension requests go to the fixed loopback API; the employer page handles its own network activity.
- **API credentials stay local.** Tokens use `chrome.storage.session`, which is restricted to trusted extension contexts by default. Authenticated requests reject redirects and non-loopback URLs.
- **Jobkit stores applicant data at runtime.** Your selected PDF resume, job-scoped contact details, field answers, and learned answers are cached in `chrome.storage.local`. That storage is not application-level encrypted. The backend also maintains its own local data.
- **Filling shares data with the employer.** Typing into a third-party form or attaching a resume can make information available to that site before final submission. Click Fill + Learn only for destinations you intend to receive your information.
- **Clear local extension data** with the popup's **Clear extension cache and API session** button, then refresh job tabs. This removes your saved resume and clears extension storage; it does not erase the backend's data or anything already shared with an employer.
- The only Chrome API permission is **`storage`**. Host access is limited to the loopback API and listed ATS/career paths. There is no access to LinkedIn, email, browser history, cookies, or arbitrary websites through this manifest.
- Password, hidden, file, and CAPTCHA inputs are excluded from answer capture. Resume upload uses a separate, deliberate PDF path with a 10 MiB limit.

See [SECURITY.md](SECURITY.md) for the trust boundaries and publication checks. These checks reduce risk; they are not a security certification of every employer page, local backend, or device.

## Development and checks

No package installation is required. Use Node.js 22 or later and Python 3.10 or later:

```sh
node --test tests/*.test.js
python3 scripts/check_publication.py
```

Tests use synthetic data and stubbed browser/API interfaces. They do not contact an employer, upload a resume, or submit an application. Run these checks locally before each publication. A GitHub Actions workflow is not included in this release.

Keep personal profiles, resumes, screenshots, tokens, application logs, and backend folders outside this repository. The ignore rules use an allowlist, and the publication check rejects unexpected tracked files, binaries, common secret formats, personal contact formats, and home-directory paths. Never bypass a failing check to publish private data.

## License

Copyright (c) 2026 Jobkit contributors. All rights reserved except as granted by [LICENSE](LICENSE).

This software is provided under the **[PolyForm Noncommercial License 1.0.0](https://polyformproject.org/licenses/noncommercial/1.0.0)**. Permitted noncommercial use, modification, and redistribution are free of charge, subject to its terms and required notices. Charging for a commercial hosted service, selling the extension, or using it as part of a commercial product is outside the noncommercial grant; a separate permission from the copyright holders would be required.

This is a **source-available, noncommercial** release. It is not advertised as an unrestricted open-source license. The full license controls; preserve it and the required copyright notice in redistributions.
