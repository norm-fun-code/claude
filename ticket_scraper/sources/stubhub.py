"""StubHub scraper — uses ScrapingBee when SCRAPINGBEE_API_KEY is set.

StubHub is a React SPA with Akamai bot detection. We use render_js=True
so ScrapingBee executes the page's JS, then parse __NEXT_DATA__ from the
rendered HTML.
"""
import json
import logging
import re
from typing import List

from ..models import Listing
from ._http import get

log = logging.getLogger(__name__)

SEARCH_URL = "https://www.stubhub.com/find/"


def _find_event_url(query: str, date_iso: str) -> str | None:
    try:
        r = get(SEARCH_URL, render_js=True, params={"q": query}, timeout=60)
        if r.status_code != 200:
            log.info("StubHub search returned %d", r.status_code)
            return None
    except Exception as e:
        log.warning("StubHub search failed: %s", e)
        return None

    # Event links: /noah-kahan-tickets/.../12345678/
    candidates = list(re.finditer(r'href="(/[^"]*?-tickets[^"]*?/(\d{6,})/?)"', r.text))
    if not candidates:
        return None
    if date_iso in r.text or _ymd_to_human(date_iso) in r.text:
        return "https://www.stubhub.com" + candidates[0].group(1)
    return None


def _ymd_to_human(d: str) -> str:
    try:
        y, m, dd = d.split("-")
        months = ["", "Jan", "Feb", "Mar", "Apr", "May", "Jun",
                  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
        return f"{months[int(m)]} {int(dd)}"
    except Exception:
        return d


def fetch(date_iso: str, query: str = "Noah Kahan Citi Field") -> List[Listing]:
    event_url = _find_event_url(query, date_iso)
    if not event_url:
        log.info("StubHub: no event URL found for %r on %s", query, date_iso)
        return []

    try:
        r = get(event_url, render_js=True, timeout=60)
        if r.status_code != 200:
            log.info("StubHub event page returned %d", r.status_code)
            return []
    except Exception as e:
        log.warning("StubHub event page failed: %s", e)
        return []

    m = re.search(r'<script id="__NEXT_DATA__"[^>]*>(.*?)</script>', r.text, re.S)
    if not m:
        log.info("StubHub: __NEXT_DATA__ not found on event page")
        return []
    try:
        data = json.loads(m.group(1))
    except json.JSONDecodeError:
        return []

    out: List[Listing] = []
    for node in _walk(data):
        try:
            qty = int(node.get("quantity") or 0)
            price = node.get("rawPrice") or node.get("price")
            if isinstance(price, dict):
                price = price.get("amount") or price.get("value")
            if not price:
                continue
            section = str(node.get("section") or node.get("sectionName") or "")
            row = node.get("row")
            if not section or qty <= 0:
                continue
            out.append(Listing(
                source="stubhub",
                section=section,
                row=str(row) if row else None,
                quantity=qty,
                price_per_ticket=float(price),
                url=event_url,
            ))
        except (TypeError, ValueError):
            continue
    log.info("StubHub: parsed %d listings", len(out))
    return out


def _walk(obj):
    if isinstance(obj, dict):
        if "section" in obj and ("quantity" in obj or "qty" in obj):
            yield obj
        for v in obj.values():
            yield from _walk(v)
    elif isinstance(obj, list):
        for item in obj:
            yield from _walk(item)
