# Spam Me Please

A public research directory for consumer promotions, sweepstakes, survey panels, quote marketplaces, subscription offers, and other signup pages that may request a phone number and disclose marketing-related data sharing.

## What counts as a strong match

The crawler keeps broad **discovery leads** but distinguishes them from stronger matches:

- **Phone form found:** a checked public page contains a form field whose name, label, placeholder, or accessibility label refers to a phone, mobile, cell, or telephone number.
- **Marketing disclosure found:** the linked privacy policy contains a targeted phrase indicating sale/sharing for marketing, advertising, lead generation, or telephone solicitation.
- **Qualified:** both of the above were found.
- **Explicit telemarketing wording:** the policy also contains a direct term such as "telemarketing", "telemarketers", "telephone solicitation", "telephone marketing", "marketing calls", or "sales calls".

These are automated text and form detections, not legal conclusions. A generic "sell" mention is not sufficient. A policy may describe exceptions, opt-outs, state-specific rights, or uses that do not include telemarketing. Open the source policy and the signup form to verify the current wording and consent choices.

## Scale and operation

- The crawler runs daily and can be started manually from GitHub Actions.
- Search coverage now spans dozens of query patterns across sweepstakes, giveaways, paid surveys, research panels, rewards, free samples, quote marketplaces, insurance, home services, subscriptions, coupons, and lead-generation offers.
- Each search can return up to 20 candidate pages. Results accumulate across runs and are deduplicated by domain; the catalogue is not reset each day.
- For each candidate, the crawler checks the landing page and up to three relevant signup/registration/entry pages, detects visible phone fields, follows a public privacy-policy link, and stores targeted policy evidence excerpts.
- Search coverage is inherently incomplete. Search engines limit results and change ranking; a large catalogue takes repeated runs and additional source-specific discovery.

## Dashboard

The GitHub Pages dashboard filters by category, review status, phone-form detection, combined qualification, and explicit telemarketing wording. Every entry links to the site, checked signup pages, and its privacy policy when found.

## Run locally

Requires Python 3.11+.

```bash
python -m pip install -r requirements.txt
python discovery/run.py --output data/discovered_sites.json
```

Edit `config.json` to add search phrases, categories, and detection patterns. Keep request rates modest and respect website terms and access controls.

## Data handling and limits

The project catalogs public URLs, page titles, short search excerpts, detected form-field metadata, policy-language excerpts, and timestamps. It must not store phone numbers, email addresses, passwords, cookies, or submitted form contents. It does not submit forms, create accounts, send messages, bypass CAPTCHA, or evade rate limits. The user reviews each site and makes any participation decision manually.

A detected disclosure does not prove that a company sells a phone number to a telemarketer. The evidence and the exact policy language must be checked manually.

## Review checklist

The dashboard displays every catalogued domain as a checklist. Checking an item marks it complete and moves it below unfinished items. Checklist state is stored in the browser's local storage; it is not written to the repository and does not sync between browsers.

## Form Review Helper extension

A separate Manifest V3 extension lives in `form-filler/`.

- It scans the current page and lets the user select exactly one visible form.
- It fills only visible, enabled text/email/telephone/address fields that can be identified from their labels or autocomplete metadata.
- It does not fill consent checkboxes, passwords, payment fields, or hidden fields.
- It never submits a form, creates an account, or operates across multiple sites.
- Profile values are held only in the popup while it is open; they are not persisted or transmitted to a server.
- To install, open `chrome://extensions`, enable Developer mode, choose **Load unpacked**, and select the repository's `form-filler/` folder.
- Open **Updates** in the extension, save a fine-grained GitHub token restricted to this repository with Contents: Read-only, and link the same `form-filler/` folder once. The updater follows the PPUSA updater design: compare the remote Git tree, download only changed blobs, verify Git blob SHA-1 values, write changed files, and write `manifest.json` last. It does not use ZIP downloads.

