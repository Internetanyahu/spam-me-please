# Spam Me Please

A personal, opt-in research dashboard for discovering promotions, sweepstakes, rewards programs, survey panels, and ad-supported publishers that may request a phone number.

## Scope

This project discovers and catalogs websites. It does **not** submit your phone number, create accounts, complete surveys, send SMS messages, or bypass consent, CAPTCHA, rate limits, or anti-abuse controls. Each result is a research lead for you to inspect and decide on manually.

## How it works

- GitHub Actions runs discovery daily, with a manual workflow option.
- Search results are collected for configurable categories.
- Candidate pages are classified and deduplicated by domain.
- The scanner looks for public privacy-policy links and phone-related language.
- Results are written to `data/discovered_sites.json`.
- A static dashboard lets you filter and inspect the catalog.

No phone number or API key is required. The workflow does not request personal information.

## Run locally

Requires Python 3.11+.

```bash
python -m pip install -r requirements.txt
python discovery/run.py --output data/discovered_sites.json
```

## Configure searches

Edit `config.json` to add or remove search phrases and tune the maximum number of results per phrase. Keep requests modest and respect the terms and robots policies of services you access.

## GitHub Actions

The workflow runs once daily and can also be started from the Actions tab. It commits the updated catalog only when the file changes.

## Data handling

The catalog contains public URLs, page titles, short text excerpts, timestamps, and a basic classification. It must not contain phone numbers, email addresses, passwords, session cookies, or other personal data. A site's presence in the catalog is not an endorsement or a guarantee that it accepts submissions or shares data.
