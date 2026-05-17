"""TickPick scraper.

TickPick has a relatively permissive internal JSON API that backs their
event page. Endpoint shape (as of writing):
  GET https://www.tickpick.com/api/event-info/{eventId}/
  GET https://www.tickpick.com/api/event-listings/{eventId}/
The site's search results contain event URLs of the form
/buy/<slug>/<eventId>/
"""
import logging
import re
from typing import List

from ..models import Listing
from ._http import session

log = logging.getLogger(__name__)


def _search_event_id(query: str, date_iso: str) -> str | None:
    try:
        r = session().get(
            "https://www.tickpick.com/search/",
            params={"q": query},
            timeout=20,
        )
        if r.status_code != 200:
            return None
    except Exception as e:
        log.warning("TickPick search failed: %s", e)
        return None
    for m in re.finditer(r'/buy/[^/"]+/(\d+)/?', r.text):
        # Verify date appears in surrounding HTML to avoid wrong event
        if date_iso in r.text or _date_human(date_iso) in r.text:
            return m.group(1)
    return None


def _date_human(d: str) -> str:
    try:
        y, m, dd = d.split("-")
        return f"{int(m)}/{int(dd)}/{y[2:]}"
    except Exception:
        return d


def fetch(date_iso: str, query: str = "Noah Kahan Citi Field") -> List[Listing]:
    event_id = _search_event_id(query, date_iso)
    if not event_id:
        log.info("TickPick: no event id found")
        return []

    try:
        r = session().get(
            f"https://www.tickpick.com/api/event-listings/{event_id}/",
            headers={"Accept": "application/json", "Referer": "https://www.tickpick.com/"},
            timeout=25,
        )
        if r.status_code != 200:
            log.info("TickPick listings API returned %d", r.status_code)
            return []
        data = r.json()
    except Exception as e:
        log.warning("TickPick listings fetch failed: %s", e)
        return []

    raw = data.get("listings") or data.get("data") or []
    out: List[Listing] = []
    for item in raw:
        try:
            section = str(item.get("section") or item.get("s") or "")
            qty = int(item.get("quantity") or item.get("q") or 0)
            price = item.get("price") or item.get("p")
            row = item.get("row") or item.get("r")
            if not section or qty <= 0 or not price:
                continue
            out.append(Listing(
                source="tickpick",
                section=section,
                row=str(row) if row else None,
                quantity=qty,
                price_per_ticket=float(price),
                url=f"https://www.tickpick.com/buy/-/{event_id}/",
            ))
        except (TypeError, ValueError):
            continue
    log.info("TickPick: parsed %d listings", len(out))
    return out
