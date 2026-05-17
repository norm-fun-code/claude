"""SeatGeek scraper — uses hardcoded event URL.

The SeatGeek event page is behind Cloudflare so we go straight there with
premium_proxy. Listings live in window.__INITIAL_STATE__ in the HTML.
"""
import json
import logging
import re
from typing import List

from ..models import Listing
from ._http import get

log = logging.getLogger(__name__)

EVENT_URL = "https://seatgeek.com/noah-kahan-tickets/flushing-new-york-citi-field-2026-07-19-6-30-pm/concert/18065521"


def fetch(date_iso: str, performer_slug: str = "noah-kahan", venue_slug: str = "citi-field") -> List[Listing]:
    # SeatGeek's event page is Cloudflare-protected → go straight to premium.
    try:
        r = get(EVENT_URL, render_js=True, premium_proxy=True, timeout=90)
        if r.status_code != 200:
            log.info("SeatGeek event page returned %d", r.status_code)
            return []
    except Exception as e:
        log.warning("SeatGeek event page fetch failed: %s", e)
        return []

    html = r.text
    # Listings are typically in window.__INITIAL_STATE__ = {...}
    m = re.search(r"window\.__INITIAL_STATE__\s*=\s*(\{.*?\})\s*;</script>", html, re.S)
    if not m:
        # Some pages use Next.js style
        m = re.search(r'<script id="__NEXT_DATA__"[^>]*>(.*?)</script>', html, re.S)
    if not m:
        log.info("SeatGeek: no embedded listing state on event page")
        return []
    try:
        state = json.loads(m.group(1))
    except json.JSONDecodeError:
        log.warning("SeatGeek: state JSON parse failed")
        return []

    listings: List[Listing] = []
    for node in _walk_listings(state):
        try:
            qty = int(node.get("quantity") or node.get("availableTickets") or 0)
            price_raw = (node.get("displayPrice") or node.get("price") or
                         node.get("p") or node.get("totalPrice"))
            if isinstance(price_raw, dict):
                price_raw = price_raw.get("amount") or price_raw.get("value")
            price = float(price_raw or 0)
            section = str(node.get("section") or node.get("sectionName") or node.get("s") or "")
            row = node.get("row") or node.get("r")
            if not section or qty <= 0 or price <= 0:
                continue
            listings.append(Listing(
                source="seatgeek",
                section=section,
                row=str(row) if row else None,
                quantity=qty,
                price_per_ticket=price,
                url=EVENT_URL,
            ))
        except (TypeError, ValueError):
            continue
    log.info("SeatGeek: parsed %d listings", len(listings))
    return listings


def _walk_listings(obj):
    if isinstance(obj, dict):
        has_section = any(k in obj for k in ("section", "sectionName", "s"))
        has_price = any(k in obj for k in ("price", "displayPrice", "p", "totalPrice"))
        if has_section and has_price:
            yield obj
        for v in obj.values():
            yield from _walk_listings(v)
    elif isinstance(obj, list):
        for item in obj:
            yield from _walk_listings(item)
