from __future__ import annotations

import argparse
import json
import re
import time
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import quote_plus, urljoin, urlparse, urlunparse

import requests
from bs4 import BeautifulSoup

ROOT = Path(__file__).resolve().parents[1]
CONFIG_PATH = ROOT / "config.json"


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def normalize_url(url: str) -> str:
    parsed = urlparse(url)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        return ""
    host = parsed.netloc.lower()
    if host.startswith("www."):
        host = host[4:]
    path = parsed.path.rstrip("/")
    return urlunparse(("https", host, path, "", "", ""))


def domain_of(url: str) -> str:
    return urlparse(url).netloc.lower().removeprefix("www.")


def search_duckduckgo(query: str, session: requests.Session, limit: int) -> list[dict]:
    endpoint = "https://html.duckduckgo.com/html/?q=" + quote_plus(query)
    response = session.get(endpoint, timeout=15)
    response.raise_for_status()
    soup = BeautifulSoup(response.text, "html.parser")
    found = []
    for item in soup.select(".result"):
        link = item.select_one(".result__a")
        snippet = item.select_one(".result__snippet")
        if not link or not link.get("href"):
            continue
        url = normalize_url(link["href"])
        if not url:
            continue
        found.append({
            "url": url,
            "title": link.get_text(" ", strip=True),
            "search_snippet": snippet.get_text(" ", strip=True) if snippet else ""
        })
        if len(found) >= limit:
            break
    return found


def fetch_page(url: str, session: requests.Session, timeout: int) -> dict:
    try:
        response = session.get(url, timeout=timeout, allow_redirects=True)
        content_type = response.headers.get("content-type", "").lower()
        if response.status_code >= 400 or "text/html" not in content_type:
            return {"status": response.status_code, "final_url": response.url}
        soup = BeautifulSoup(response.text[:1_500_000], "html.parser")
        for node in soup(["script", "style", "noscript", "svg"]):
            node.decompose()
        text = re.sub(r"\s+", " ", soup.get_text(" ", strip=True))[:12000]
        title = soup.title.get_text(" ", strip=True) if soup.title else ""
        privacy_url = ""
        for anchor in soup.find_all("a", href=True):
            label = anchor.get_text(" ", strip=True).lower()
            href = anchor["href"]
            if "privacy" in label or "privacy" in href.lower():
                privacy_url = urljoin(response.url, href)
                break
        return {
            "status": response.status_code,
            "final_url": response.url,
            "title": title,
            "text": text,
            "privacy_url": privacy_url
        }
    except requests.RequestException as exc:
        return {"error": type(exc).__name__}


def classify(text: str, config: dict) -> list[str]:
    lowered = text.lower()
    return [
        category for category, terms in config.get("categories", {}).items()
        if any(term.lower() in lowered for term in terms)
    ]


def matching_terms(text: str, terms: list[str]) -> list[str]:
    lowered = text.lower()
    return [term for term in terms if term.lower() in lowered]


def load_existing(path: Path) -> dict:
    if not path.exists():
        return {"updated_at": None, "sites": []}
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return {"updated_at": None, "sites": []}


def main() -> None:
    parser = argparse.ArgumentParser(description="Discover public websites for a manual research catalog.")
    parser.add_argument("--output", default=str(ROOT / "data" / "discovered_sites.json"))
    args = parser.parse_args()

    config = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
    output_path = Path(args.output)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    existing = load_existing(output_path)
    records = {site["domain"]: site for site in existing.get("sites", []) if site.get("domain")}

    session = requests.Session()
    session.headers.update({"User-Agent": config.get("user_agent", "ResearchBot/1.0")})
    limit = max(1, min(int(config.get("max_results_per_query", 10)), 25))
    timeout = max(5, min(int(config.get("request_timeout_seconds", 15)), 30))

    for query in config.get("search_queries", []):
        try:
            results = search_duckduckgo(query, session, limit)
        except requests.RequestException as exc:
            print(f"Search failed for query {query!r}: {type(exc).__name__}")
            continue

        for result in results:
            domain = domain_of(result["url"])
            if not domain:
                continue
            page = fetch_page(result["url"], session, timeout)
            page_text = page.get("text", "")
            combined = " ".join([result["title"], result["search_snippet"], page_text])
            categories = classify(combined, config)
            phone_hits = matching_terms(combined, config.get("phone_terms", []))
            privacy_hits = matching_terms(combined, config.get("privacy_terms", []))
            if domain in records:
                site = records[domain]
                site["categories"] = sorted(set(site.get("categories", []) + categories))
                site["phone_language"] = sorted(set(site.get("phone_language", []) + phone_hits))
                site["privacy_language"] = sorted(set(site.get("privacy_language", []) + privacy_hits))
                site["search_queries"] = sorted(set(site.get("search_queries", []) + [query]))
                site["last_seen"] = utc_now()
                if page.get("privacy_url"):
                    site["privacy_url"] = page["privacy_url"]
                continue

            records[domain] = {
                "domain": domain,
                "url": page.get("final_url", result["url"]),
                "title": page.get("title") or result["title"],
                "search_snippet": result["search_snippet"][:500],
                "categories": categories,
                "phone_language": phone_hits,
                "privacy_language": privacy_hits,
                "privacy_url": page.get("privacy_url", ""),
                "http_status": page.get("status"),
                "search_queries": [query],
                "first_seen": utc_now(),
                "last_seen": utc_now(),
                "review_status": "unreviewed",
                "notes": ""
            }
            time.sleep(1.0)

    sites = sorted(records.values(), key=lambda item: (item.get("review_status") != "unreviewed", item["domain"]))
    payload = {
        "updated_at": utc_now(),
        "site_count": len(sites),
        "sites": sites
    }
    output_path.write_text(json.dumps(payload, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"Saved {len(sites)} domains to {output_path}")


if __name__ == "__main__":
    main()
