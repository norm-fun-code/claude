"""SeatGeek scraper.

The public SeatGeek API (free client_id) only exposes event-level aggregates
(stats.lowest_price, average_price). Per-listing section/row data is gated
behind partner access. We use the API to find the event, then attempt to
parse the SeatGeek event page's embedded JSON for listings — this is
best-effort and may break without notice.
"""
import json
import logging
import os
import re
from typing import List

from ..models import Listing
from ._http import session

log = logging.getLogger(__name__)

API_BASE = "https://api.seatgeek.com/2"


def find_event(performer_slug: str, venue_slug: str, date_iso: str) -> dict | None:
    client_id = os.environ.get("SEATGEEK_CLIENT_ID")
    if not client_id:
        log.warning("SEATGEEK_CLIENT_ID not set; skipping SeatGeek event lookup")
        return None
    params = {
        "performers.slug": performer_slug,
        "venue.slug": venue_slug,
        "datetime_local.gte": date_iso,
        "datetime_local.lte": f"{date_iso}T23:59:59",
        "client_id": client_id,
    }
    r = session().get(f"{API_BASE}/events", params=params, timeout=20)
    r.raise_for_status()
    events = r.json().get("events", [])
    return events[0] if events else None


def fetch(date_iso: str, performer_slug: str = "noah-kahan", venue_slug: str = "citi-field") -> List[Listing]:
    try:
        event = find_event(performer_slug, venue_slug, date_iso)
    except Exception as e:
        log.warning("SeatGeek event lookup failed: %s", e)
        return []
    if not event:
        log.info("SeatGeek: no event for %s @ %s on %s", performer_slug, venue_slug, date_iso)
        return []

    event_url = event.get("url")
    if not event_url:
        return []

    try:
        html = session().get(event_url, timeout=20).text
    except Exception as e:
        log.warning("SeatGeek page fetch failed: %s", e)
        return []

    # SeatGeek embeds listings in a <script>window.__INITIAL_STATE__ = {...}</script>
    m = re.search(r"window\.__INITIAL_STATE__\s*=\s*(\{.*?\})\s*;</script>", html, re.S)
    if not m:
        log.info("SeatGeek: no embedded listing state on event page (likely paywalled markup)")
        return []
    try:
        state = json.loads(m.group(1))
    except json.JSONDecodeError:
        return []

    listings: List[Listing] = []
    for node in _walk_listings(state):
        try:
            qty = int(node.get("quantity") or node.get("availableTickets") or 0)
            price = float(node.get("displayPrice") or node.get("price") or node.get("p") or 0)
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
                url=event_url,
            ))
        except (TypeError, ValueError):
            continue
    log.info("SeatGeek: parsed %d listings", len(listings))
    return listings


def _walk_listings(obj):
    """Yield dicts that look like listing records, regardless of nesting."""
    if isinstance(obj, dict):
        if any(k in obj for k in ("section", "sectionName")) and any(
            k in obj for k in ("price", "displayPrice", "p")
        ):
            yield obj
        for v in obj.values():
            yield from _walk_listings(v)
    elif isinstance(obj, list):
        for item in obj:
            yield from _walk_listings(item)
