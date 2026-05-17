"""Vivid Seats scraper — uses ScrapingBee with JS rendering."""
import json
import logging
import re
from typing import List

from ..models import Listing
from ._http import get

log = logging.getLogger(__name__)

SEARCH_URL = "https://www.vividseats.com/search"


def _find_event_url(query: str, date_iso: str) -> str | None:
    try:
        r = get(SEARCH_URL, render_js=True, params={"searchTerm": query}, timeout=60)
        if r.status_code != 200:
            log.info("Vivid Seats search returned %d", r.status_code)
            return None
    except Exception as e:
        log.warning("Vivid search failed: %s", e)
        return None
    candidates = list(re.finditer(r'href="(/[^"]*?/production/(\d+))"', r.text))
    if not candidates:
        return None
    if date_iso in r.text:
        return "https://www.vividseats.com" + candidates[0].group(1)
    return None


def fetch(date_iso: str, query: str = "Noah Kahan Citi Field") -> List[Listing]:
    event_url = _find_event_url(query, date_iso)
    if not event_url:
        log.info("Vivid Seats: no event URL found")
        return []
    try:
        r = get(event_url, render_js=True, timeout=60)
        if r.status_code != 200:
            log.info("Vivid Seats event page returned %d", r.status_code)
            return []
    except Exception as e:
        log.warning("Vivid Seats event page failed: %s", e)
        return []

    m = re.search(r'<script id="__NEXT_DATA__"[^>]*>(.*?)</script>', r.text, re.S)
    if not m:
        log.info("Vivid Seats: __NEXT_DATA__ not found on event page")
        return []
    try:
        data = json.loads(m.group(1))
    except json.JSONDecodeError:
        return []

    out: List[Listing] = []
    for node in _walk(data):
        try:
            qty = int(node.get("quantity") or node.get("availableQty") or 0)
            price = node.get("price") or node.get("currentPrice") or node.get("listingPrice")
            section = str(node.get("section") or node.get("sectionName") or "")
            row = node.get("row")
            if not section or qty <= 0 or not price:
                continue
            out.append(Listing(
                source="vividseats",
                section=section,
                row=str(row) if row else None,
                quantity=qty,
                price_per_ticket=float(price),
                url=event_url,
            ))
        except (TypeError, ValueError):
            continue
    log.info("Vivid Seats: parsed %d listings", len(out))
    return out


def _walk(obj):
    if isinstance(obj, dict):
        if "section" in obj and ("quantity" in obj or "availableQty" in obj):
            yield obj
        for v in obj.values():
            yield from _walk(v)
    elif isinstance(obj, list):
        for item in obj:
            yield from _walk(item)
