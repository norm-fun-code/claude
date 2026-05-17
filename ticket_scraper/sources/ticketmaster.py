"""Ticketmaster Discovery API.

The free Discovery API only exposes priceRanges (min/max), not per-section
listings. We surface a single synthetic listing using the min price when an
event is found, with section="(unknown)" — which will be filtered out by
the section filter. Use this source mainly to confirm the event exists and
to deep-link the user to the official page.
"""
import logging
import os
from typing import List

from ..models import Listing
from ._http import session

log = logging.getLogger(__name__)

API_URL = "https://app.ticketmaster.com/discovery/v2/events.json"


def fetch(date_iso: str, keyword: str = "Noah Kahan", venue_id: str = "KovZpZA7AAEA") -> List[Listing]:
    api_key = os.environ.get("TICKETMASTER_API_KEY")
    if not api_key:
        log.warning("TICKETMASTER_API_KEY not set; skipping Ticketmaster")
        return []
    params = {
        "apikey": api_key,
        "keyword": keyword,
        "venueId": venue_id,
        "startDateTime": f"{date_iso}T00:00:00Z",
        "endDateTime": f"{date_iso}T23:59:59Z",
    }
    try:
        r = session().get(API_URL, params=params, timeout=20)
        r.raise_for_status()
    except Exception as e:
        log.warning("Ticketmaster API request failed: %s", e)
        return []

    events = r.json().get("_embedded", {}).get("events", [])
    if not events:
        log.info("Ticketmaster: no events found for %s on %s", keyword, date_iso)
        return []

    out: List[Listing] = []
    for event in events:
        url = event.get("url")
        ranges = event.get("priceRanges") or []
        for pr in ranges:
            mn = pr.get("min")
            if mn is None:
                continue
            out.append(Listing(
                source="ticketmaster",
                section=f"(unknown — TM Discovery {pr.get('type', 'standard')})",
                row=None,
                quantity=2,
                price_per_ticket=float(mn),
                url=url,
            ))
    log.info("Ticketmaster: %d price-range entries (no section data)", len(out))
    return out
