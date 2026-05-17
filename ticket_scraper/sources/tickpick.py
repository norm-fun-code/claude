"""TickPick scraper — uses hardcoded event ID."""
import json
import logging
import re
from typing import List

from ..models import Listing
from ._http import get

log = logging.getLogger(__name__)

EVENT_ID = "7732241"
EVENT_URL = "https://www.tickpick.com/buy-noah-kahan-tickets-citi-field-7-19-26-6pm/7732241/"


def fetch(date_iso: str, query: str = "Noah Kahan Citi Field") -> List[Listing]:
    # Try the public JSON API first — cheap (no JS) and gives clean section data
    api_url = f"https://www.tickpick.com/api/event-listings/{EVENT_ID}/"
    try:
        r = get(
            api_url,
            render_js=False,
            headers={"Accept": "application/json", "Referer": "https://www.tickpick.com/"},
            timeout=40,
        )
        if r.status_code == 200:
            try:
                data = r.json()
            except Exception:
                data = None
            if data:
                listings = _parse_api(data)
                if listings:
                    log.info("TickPick: parsed %d listings via API", len(listings))
                    return listings
                log.info("TickPick API returned 200 but no listings (keys: %s)",
                         list(data.keys()) if isinstance(data, dict) else type(data).__name__)
        else:
            log.info("TickPick API returned %d", r.status_code)
    except Exception as e:
        log.warning("TickPick API fetch failed: %s", e)

    # Fallback: scrape the event page HTML for embedded JSON
    try:
        r = get(EVENT_URL, render_js=True, timeout=60)
        if r.status_code != 200:
            log.info("TickPick event page returned %d", r.status_code)
            return []
    except Exception as e:
        log.warning("TickPick event page fetch failed: %s", e)
        return []

    html = r.text
    patterns = {
        "__NEXT_DATA__": bool(re.search(r'id="__NEXT_DATA__"', html)),
        "__next_f.push": bool(re.search(r"self\.__next_f\.push", html)),
        "APP_DATA": bool(re.search(r"window\.APP_DATA", html)),
        "tp_state": bool(re.search(r"window\.tp_?state", html, re.I)),
    }
    log.info("TickPick page patterns: %s", patterns)

    # Try Next.js App Router RSC payloads — they push JSON chunks into __next_f
    rsc_listings = _parse_rsc_payloads(html)
    if rsc_listings:
        return rsc_listings

    m = re.search(r'<script id="__NEXT_DATA__"[^>]*>(.*?)</script>', html, re.S)
    if not m:
        m = re.search(r'window\.APP_DATA\s*=\s*(\{.*?\});\s*</script>', html, re.S)
    if not m:
        log.info("TickPick: no known data pattern found on event page")
        return []
    try:
        data = json.loads(m.group(1))
    except json.JSONDecodeError:
        return []
    listings = _parse_next_data(data)
    log.info("TickPick: parsed %d listings via page HTML", len(listings))
    return listings


def _parse_api(data) -> List[Listing]:
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
                url=EVENT_URL,
            ))
        except (TypeError, ValueError):
            continue
    return out


def _parse_next_data(data) -> List[Listing]:
    out: List[Listing] = []
    for node in _walk(data):
        try:
            section = str(node.get("section") or node.get("s") or "")
            qty = int(node.get("quantity") or node.get("q") or 0)
            price = node.get("price") or node.get("p")
            row = node.get("row") or node.get("r")
            if not section or qty <= 0 or not price:
                continue
            out.append(Listing(
                source="tickpick",
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
        if ("section" in obj or "s" in obj) and ("price" in obj or "p" in obj):
            yield obj
        for v in obj.values():
            yield from _walk(v)
    elif isinstance(obj, list):
        for item in obj:
            yield from _walk(item)


def _parse_rsc_payloads(html: str) -> List[Listing]:
    """Extract listings from Next.js App Router RSC chunks pushed into __next_f."""
    chunks = re.findall(r'self\.__next_f\.push\(\[\s*\d+\s*,\s*"((?:[^"\\]|\\.)*)"', html)
    if not chunks:
        return []
    log.info("TickPick: found %d RSC chunks", len(chunks))
    out: List[Listing] = []
    for chunk in chunks:
        # Each chunk is a JS-escaped JSON string. Unescape and try to find listings.
        try:
            unescaped = bytes(chunk, "utf-8").decode("unicode_escape")
        except Exception:
            unescaped = chunk
        # Look for blocks that look like listings, e.g. {"section":"5","quantity":2,"price":250}
        for jm in re.finditer(
            r'\{[^{}]*?"section"\s*:\s*"[^"]+"[^{}]*?"(?:price|p)"\s*:\s*[\d.]+[^{}]*?\}',
            unescaped,
        ):
            try:
                obj = json.loads(jm.group(0))
            except json.JSONDecodeError:
                continue
            try:
                section = str(obj.get("section") or obj.get("s") or "")
                qty = int(obj.get("quantity") or obj.get("q") or 0)
                price = obj.get("price") or obj.get("p")
                if not section or qty <= 0 or not price:
                    continue
                out.append(Listing(
                    source="tickpick",
                    section=section,
                    row=str(obj.get("row") or obj.get("r") or "") or None,
                    quantity=qty,
                    price_per_ticket=float(price),
                    url=EVENT_URL,
                ))
            except (TypeError, ValueError):
                continue
    if out:
        log.info("TickPick: parsed %d listings from RSC payloads", len(out))
    return out
