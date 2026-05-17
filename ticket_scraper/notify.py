"""GitHub issue creation with per-listing dedupe.

Avoids re-alerting on the same listing by searching open issues with the
configured label and a fingerprint embedded in the title.
"""
import logging
import os
from typing import Iterable, List

import requests

from .models import Listing

log = logging.getLogger(__name__)

API = "https://api.github.com"
LABEL = "noah-kahan-ticket-alert"


def _headers(token: str) -> dict:
    return {
        "Authorization": f"Bearer {token}",
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
    }


def _existing_fingerprints(repo: str, token: str) -> set[str]:
    r = requests.get(
        f"{API}/repos/{repo}/issues",
        headers=_headers(token),
        params={"state": "all", "labels": LABEL, "per_page": 100},
        timeout=20,
    )
    if r.status_code != 200:
        log.warning("GitHub list issues failed: %d %s", r.status_code, r.text[:200])
        return set()
    fps: set[str] = set()
    for issue in r.json():
        title = issue.get("title", "")
        # Title format: "[fingerprint] human text"
        if title.startswith("[") and "]" in title:
            fps.add(title[1:title.index("]")])
    return fps


def _ensure_label(repo: str, token: str) -> None:
    r = requests.get(f"{API}/repos/{repo}/labels/{LABEL}", headers=_headers(token), timeout=15)
    if r.status_code == 200:
        return
    requests.post(
        f"{API}/repos/{repo}/labels",
        headers=_headers(token),
        json={"name": LABEL, "color": "f9d71c", "description": "Auto-alert for matching Noah Kahan tickets"},
        timeout=15,
    )


def _body_for(listing: Listing) -> str:
    qty = listing.quantity
    price = listing.price_per_ticket
    total = qty * price
    lines = [
        "Matching listing found.",
        "",
        f"- **Source:** {listing.source}",
        f"- **Section:** {listing.section}",
        f"- **Row:** {listing.row or 'n/a'}",
        f"- **Quantity:** {qty}",
        f"- **Price per ticket:** ${price:.2f}",
        f"- **Total:** ${total:.2f}",
    ]
    if listing.url:
        lines += ["", f"[Open listing]({listing.url})"]
    lines += [
        "",
        "_Filter: sections 1–9 or 100–139, qty ≥ 2, < $300/ticket._",
    ]
    return "\n".join(lines)


def alert(repo: str, token: str, listings: Iterable[Listing]) -> List[str]:
    listings = list(listings)
    if not listings:
        return []
    _ensure_label(repo, token)
    seen = _existing_fingerprints(repo, token)
    created: List[str] = []
    for l in listings:
        fp = l.fingerprint()
        if fp in seen:
            log.info("Dedup: %s already alerted", fp)
            continue
        title = f"[{fp}] {l.source} sec {l.section} x{l.quantity} @ ${l.price_per_ticket:.0f}"
        r = requests.post(
            f"{API}/repos/{repo}/issues",
            headers=_headers(token),
            json={"title": title, "body": _body_for(l), "labels": [LABEL]},
            timeout=20,
        )
        if r.status_code in (200, 201):
            url = r.json().get("html_url", "")
            created.append(url)
            log.info("Created issue: %s", url)
        else:
            log.warning("Issue create failed: %d %s", r.status_code, r.text[:200])
    return created


def report_scrape_failure(repo: str, token: str, summary: str) -> None:
    """Open a tracking issue when EVERY source returned zero listings.

    Helps catch silent scraper rot. Deduped against an open issue with the
    same title.
    """
    title = "[scraper-health] All sources returned no listings"
    r = requests.get(
        f"{API}/repos/{repo}/issues",
        headers=_headers(token),
        params={"state": "open", "labels": LABEL, "per_page": 100},
        timeout=15,
    )
    if r.status_code == 200 and any(i.get("title") == title for i in r.json()):
        return
    requests.post(
        f"{API}/repos/{repo}/issues",
        headers=_headers(token),
        json={"title": title, "body": summary, "labels": [LABEL]},
        timeout=15,
    )
