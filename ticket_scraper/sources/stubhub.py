"""StubHub scraper — uses hardcoded event URL.

Goes directly to the known event page and parses __NEXT_DATA__. Tries
render_js first, falls back to premium_proxy if blocked.
"""
import json
import logging
import re
from typing import List

from ..models import Listing
from ._http import get

log = logging.getLogger(__name__)

EVENT_URL = "https://www.stubhub.com/noah-kahan-flushing-tickets-7-19-2026/event/160467853/"


def fetch(date_iso: str, query: str = "Noah Kahan Citi Field") -> List[Listing]:
    # First attempt: render_js only (5 credits)
    html = _fetch_html(premium=False)
    listings = _parse(html) if html else []
    if listings:
        log.info("StubHub: parsed %d listings", len(listings))
        return listings

    # If the first attempt got blocked or returned no parseable data, try premium proxy (25 credits)
    log.info("StubHub: retrying with premium_proxy")
    html = _fetch_html(premium=True)
    listings = _parse(html) if html else []
    log.info("StubHub: parsed %d listings (premium)", len(listings))
    return listings


def _fetch_html(premium: bool) -> str | None:
    try:
        r = get(EVENT_URL, render_js=True, premium_proxy=premium, timeout=90)
        if r.status_code != 200:
            log.info("StubHub event page returned %d (premium=%s)", r.status_code, premium)
            return None
        return r.text
    except Exception as e:
        log.warning("StubHub event page fetch failed: %s", e)
        return None


def _parse(html: str) -> List[Listing]:
    m = re.search(r'<script id="__NEXT_DATA__"[^>]*>(.*?)</script>', html, re.S)
    if not m:
        log.info("StubHub: __NEXT_DATA__ not found on event page")
        return []
    try:
        data = json.loads(m.group(1))
    except json.JSONDecodeError:
        log.warning("StubHub: __NEXT_DATA__ JSON parse failed")
        return []

    out: List[Listing] = []
    for node in _walk(data):
        try:
            qty = int(node.get("quantity") or node.get("ticketQty") or 0)
            price = node.get("rawPrice") or node.get("price") or node.get("currentPrice")
            if isinstance(price, dict):
                price = price.get("amount") or price.get("value") or price.get("display")
            if not price:
                continue
            section = str(node.get("section") or node.get("sectionName") or node.get("zoneName") or "")
            row = node.get("row")
            if not section or qty <= 0:
                continue
            out.append(Listing(
                source="stubhub",
                section=section,
                row=str(row) if row else None,
                quantity=qty,
                price_per_ticket=float(price),
                url=EVENT_URL,
            ))
        except (TypeError, ValueError):
            continue
    return out


def _walk(obj):
    if isinstance(obj, dict):
        has_section = "section" in obj or "sectionName" in obj or "zoneName" in obj
        has_price = "price" in obj or "rawPrice" in obj or "currentPrice" in obj
        if has_section and has_price:
            yield obj
        for v in obj.values():
            yield from _walk(v)
    elif isinstance(obj, list):
        for item in obj:
            yield from _walk(item)
