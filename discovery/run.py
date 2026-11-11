from __future__ import annotations

import argparse
import base64
import json
import re
import time
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import parse_qs, quote_plus, unquote, urljoin, urlparse, urlunparse

import requests
from bs4 import BeautifulSoup

ROOT = Path(__file__).resolve().parents[1]
CONFIG_PATH = ROOT / "config.json"
SEARCH_HOSTS = {"bing.com", "duckduckgo.com", "google.com", "yahoo.com", "search.brave.com", "ecosia.org", "yandex.com"}
SKIP_SUFFIXES = (".pdf", ".jpg", ".jpeg", ".png", ".gif", ".zip", ".mp4", ".mp3")


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def normalize_url(url: str) -> str:
    parsed = urlparse(url)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        return ""
    if parsed.path.lower().endswith(SKIP_SUFFIXES):
        return ""
    host = parsed.netloc.lower().split("@")[-1]
    if host.startswith("www."):
        host = host[4:]
    return urlunparse(("https", host, parsed.path.rstrip("/"), "", "", ""))


def domain_of(url: str) -> str:
    host = urlparse(url).hostname
    return host.lower().removeprefix("www.") if host else ""


def is_search_host(domain: str) -> bool:
    return any(domain == host or domain.endswith("." + host) for host in SEARCH_HOSTS)


def unwrap_bing_url(href: str) -> str:
    parsed = urlparse(href)
    host = (parsed.hostname or "").lower().removeprefix("www.")
    if not is_search_host(host):
        return href
    encoded = parse_qs(parsed.query).get("u", [""])[0]
    if encoded.startswith("a1"):
        encoded = encoded[2:]
    if encoded:
        try:
            decoded = base64.urlsafe_b64decode(encoded + "=" * (-len(encoded) % 4)).decode("utf-8")
            if urlparse(decoded).scheme in {"http", "https"}:
                return decoded
        except (ValueError, UnicodeDecodeError):
            pass
    return ""


def parse_search_html(html: str, engine: str, limit: int) -> list[dict]:
    soup = BeautifulSoup(html, "html.parser")
    found, seen = [], set()
    selectors = [(".result", ".result__a", ".result__snippet")] if engine == "ddg" else [("li.b_algo", "h2 a", ".b_caption p")]
    for item_selector, link_selector, snippet_selector in selectors:
        for item in soup.select(item_selector):
            link = item.select_one(link_selector)
            snippet = item.select_one(snippet_selector)
            if not link or not link.get("href"):
                continue
            href = link["href"]
            if engine == "ddg":
                target = parse_qs(urlparse(href).query).get("uddg", [""])[0]
                href = unquote(target) if target else href
            else:
                href = unwrap_bing_url(href)
            url = normalize_url(href)
            domain = domain_of(url)
            if not url or not domain or is_search_host(domain) or url in seen:
                continue
            seen.add(url)
            found.append({"url": url, "title": link.get_text(" ", strip=True),
                          "search_snippet": snippet.get_text(" ", strip=True) if snippet else ""})
            if len(found) >= limit:
                return found
    return found


def search(query: str, session: requests.Session, limit: int) -> list[dict]:
    for engine, endpoint in (
        ("bing", "https://www.bing.com/search?q=" + quote_plus(query)),
        ("ddg", "https://html.duckduckgo.com/html/?q=" + quote_plus(query))
    ):
        try:
            response = session.get(endpoint, timeout=18)
            response.raise_for_status()
            results = parse_search_html(response.text, engine, limit)
            if results:
                print(f"{engine}: {len(results)} results")
                return results
        except requests.RequestException as exc:
            print(f"{engine} search failed: {type(exc).__name__}")
    return []


def extract_forms(soup: BeautifulSoup) -> list[dict]:
    forms = []
    for form in soup.find_all("form"):
        fields = []
        for field in form.find_all(["input", "select", "textarea"]):
            name = (field.get("name") or field.get("id") or "").strip()
            field_type = (field.get("type") or field.name).lower()
            label = ""
            if field.get("id"):
                label_node = soup.find("label", attrs={"for": field.get("id")})
                if label_node:
                    label = label_node.get_text(" ", strip=True)
            context = " ".join([name, field_type, field.get("placeholder", ""), field.get("aria-label", ""), label]).lower()
            if any(term in context for term in ("phone", "telephone", "mobile", "cell")):
                fields.append({"name": name[:100], "type": field_type, "label": label[:120]})
        if fields:
            forms.append({"action": urljoin(form.get("action") or "", form.get("action") or ""),
                          "method": (form.get("method") or "get").upper(), "phone_fields": fields})
    return forms


def fetch_page(url: str, session: requests.Session, timeout: int) -> dict:
    try:
        response = session.get(url, timeout=timeout, allow_redirects=True)
        content_type = response.headers.get("content-type", "").lower()
        if response.status_code >= 400 or "text/html" not in content_type:
            return {"status": response.status_code, "final_url": response.url}
        soup = BeautifulSoup(response.text[:1_500_000], "html.parser")
        forms = extract_forms(soup)
        for node in soup(["script", "style", "noscript", "svg"]):
            node.decompose()
        text = re.sub(r"\s+", " ", soup.get_text(" ", strip=True))[:30000]
        title = soup.title.get_text(" ", strip=True) if soup.title else ""
        privacy_url = ""
        signup_links = []
        for anchor in soup.find_all("a", href=True):
            label = anchor.get_text(" ", strip=True).lower()
            href = urljoin(response.url, anchor["href"])
            if not privacy_url and ("privacy" in label or "privacy" in href.lower()):
                privacy_url = href
            if len(signup_links) < 12 and any(term in (label + " " + href.lower()) for term in CONFIG.get("signup_link_terms", [])):
                if domain_of(href) == domain_of(response.url):
                    signup_links.append(href)
        return {"status": response.status_code, "final_url": response.url, "title": title,
                "text": text, "privacy_url": privacy_url, "signup_links": list(dict.fromkeys(signup_links)),
                "phone_forms": forms}
    except requests.RequestException as exc:
        return {"error": type(exc).__name__}


def matching_terms(text: str, terms: list[str]) -> list[str]:
    lowered = text.lower()
    return [term for term in terms if term.lower() in lowered]


def policy_evidence(text: str, config: dict) -> tuple[list[str], list[str], list[str]]:
    lowered = re.sub(r"\s+", " ", text.lower())
    hits, explicit, excerpts = [], [], []
    for pattern in config.get("marketing_patterns", []):
        match = re.search(pattern, lowered, re.I)
        if match:
            hits.append(pattern)
            excerpts.append(lowered[max(0, match.start()-180):min(len(lowered), match.end()+220)])
    for pattern in config.get("explicit_telemarketing_patterns", []):
        if pattern in lowered:
            explicit.append(pattern)
    return sorted(set(hits)), sorted(set(explicit)), list(dict.fromkeys(excerpts))[:8]


def classify(text: str, config: dict) -> list[str]:
    lowered = text.lower()
    return [category for category, terms in config.get("categories", {}).items()
            if any(term.lower() in lowered for term in terms)]


def load_existing(path: Path) -> dict:
    try:
        return json.loads(path.read_text(encoding="utf-8")) if path.exists() else {"sites": []}
    except (json.JSONDecodeError, OSError):
        return {"sites": []}


def main() -> None:
    parser = argparse.ArgumentParser(description="Discover public signup sites and review their public privacy disclosures.")
    parser.add_argument("--output", default=str(ROOT / "data" / "discovered_sites.json"))
    args = parser.parse_args()
    global CONFIG
    CONFIG = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
    output_path = Path(args.output)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    existing = load_existing(output_path)
    records = {site["domain"]: site for site in existing.get("sites", []) if site.get("domain")}
    seen_domains: set[str] = set()
    max_domains = max(25, min(int(CONFIG.get("max_domains_per_run", 250)), 500))
    session = requests.Session()
    session.headers.update({"User-Agent": CONFIG.get("user_agent", "ResearchBot/2.0"), "Accept": "text/html,application/xhtml+xml"})
    limit = max(1, min(int(CONFIG.get("max_results_per_query", 20)), 30))
    timeout = max(5, min(int(CONFIG.get("request_timeout_seconds", 18)), 30))
    delay = max(0.0, min(float(CONFIG.get("request_delay_seconds", 0.25)), 2.0))

    for index, query in enumerate(CONFIG.get("search_queries", []), 1):
        print(f"[{index}/{len(CONFIG['search_queries'])}] {query}")
        for result in search(query, session, limit):
            page = fetch_page(result["url"], session, timeout)
            if not page.get("text") or not page.get("final_url"):
                continue
            domain = domain_of(page["final_url"])
            if not domain or is_search_host(domain) or domain in seen_domains:
                continue
            if len(seen_domains) >= max_domains:
                print(f"Reached per-run domain cap ({max_domains}).")
                break
            seen_domains.add(domain)

            signup_pages = [{"url": page["final_url"], "data": page}]
            for link in page.get("signup_links", [])[:max(0, int(CONFIG.get("max_signup_pages_per_site", 4))-1)]:
                if any(p["url"] == link for p in signup_pages):
                    continue
                subpage = fetch_page(link, session, timeout)
                if subpage.get("text"):
                    signup_pages.append({"url": subpage["final_url"], "data": subpage})
                time.sleep(delay)

            phone_forms = []
            for item in signup_pages:
                for form in item["data"].get("phone_forms", []):
                    phone_forms.append({"page_url": item["url"], **form})
            privacy_url = next((p["data"].get("privacy_url") for p in signup_pages if p["data"].get("privacy_url")), "")
            policy = fetch_page(privacy_url, session, timeout) if privacy_url else {}
            policy_text = policy.get("text", "")
            policy_hits, explicit_hits, excerpts = policy_evidence(policy_text, CONFIG)
            category_text = " ".join([result["title"], result["search_snippet"]] + [p["data"].get("text", "")[:5000] for p in signup_pages])
            categories = classify(category_text, CONFIG)
            has_phone_form = bool(phone_forms)
            has_marketing_disclosure = bool(policy_hits)
            qualifies = has_phone_form and has_marketing_disclosure
            existing_site = records.get(domain, {})
            site = {
                **existing_site,
                "domain": domain,
                "url": page["final_url"],
                "title": page.get("title") or result["title"],
                "search_snippet": result["search_snippet"][:500],
                "categories": sorted(set(existing_site.get("categories", []) + categories)),
                "signup_pages_checked": sorted(set(existing_site.get("signup_pages_checked", []) + [p["url"] for p in signup_pages])),
                "phone_form_detected": has_phone_form or existing_site.get("phone_form_detected", False),
                "phone_forms": (existing_site.get("phone_forms", []) + phone_forms)[-20:],
                "privacy_url": privacy_url or existing_site.get("privacy_url", ""),
                "privacy_policy_checked": bool(policy_text) or existing_site.get("privacy_policy_checked", False),
                "marketing_disclosure_patterns": sorted(set(existing_site.get("marketing_disclosure_patterns", []) + policy_hits)),
                "explicit_telemarketing_terms": sorted(set(existing_site.get("explicit_telemarketing_terms", []) + explicit_hits)),
                "privacy_evidence_excerpts": list(dict.fromkeys(existing_site.get("privacy_evidence_excerpts", []) + excerpts))[:12],
                "qualified_phone_and_marketing_disclosure": qualifies or existing_site.get("qualified_phone_and_marketing_disclosure", False),
                "search_queries": sorted(set(existing_site.get("search_queries", []) + [query])),
                "http_status": page.get("status"),
                "first_seen": existing_site.get("first_seen", utc_now()),
                "last_seen": utc_now(),
                "review_status": existing_site.get("review_status", "unreviewed"),
                "notes": existing_site.get("notes", "")
            }
            records[domain] = site
            time.sleep(delay)
        if len(seen_domains) >= max_domains:
            print(f"Reached per-run domain cap ({max_domains}); ending search pass.")
            break

    sites = sorted(records.values(), key=lambda item: (
        not item.get("qualified_phone_and_marketing_disclosure", False),
        not bool(item.get("explicit_telemarketing_terms")),
        item["domain"]))
    qualified = sum(1 for s in sites if s.get("qualified_phone_and_marketing_disclosure"))
    explicit = sum(1 for s in sites if s.get("explicit_telemarketing_terms"))
    payload = {"updated_at": utc_now(), "site_count": len(sites), "qualified_count": qualified,
               "explicit_telemarketing_count": explicit, "sites": sites}
    output_path.write_text(json.dumps(payload, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"Saved {len(sites)} total domains; {qualified} with phone form + marketing disclosure; {explicit} with explicit telemarketing wording.")
if __name__ == "__main__":
    main()
