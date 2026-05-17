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
        # wait=5000: give the XHR listing requests 5 s to complete after render
        r = get(EVENT_URL, render_js=True, premium_proxy=premium, timeout=120,
                sb_params={"wait": "5000"})
        if r.status_code != 200:
            log.info("StubHub event page returned %d (premium=%s)", r.status_code, premium)
            return None
        return r.text
    except Exception as e:
        log.warning("StubHub event page fetch failed: %s", e)
        return None


def _parse(html: str) -> List[Listing]:
    patterns = {
        "__NEXT_DATA__": bool(re.search(r'id="__NEXT_DATA__"', html)),
        "REDUX_STATE": bool(re.search(r"__REDUX_STATE__", html)),
        "SH_DATA": bool(re.search(r"window\.SH_DATA", html)),
        "application/json": bool(re.search(r'type="application/json"', html)),
        "application/ld+json": bool(re.search(r'type="application/ld\+json"', html)),
        "__next_f": bool(re.search(r"self\.__next_f", html)),
    }
    body_start = html.find('<body')
    snippet = html[body_start:body_start + 500] if body_start != -1 else html[:500]
    log.info("StubHub page patterns: %s | body snippet: %.300s", patterns, re.sub(r'\s+', ' ', snippet))

    # Try every script block that contains JSON
    out = _parse_script_blocks(html)
    if out:
        return out

    # Try Next.js App Router RSC (same pattern as TickPick)
    out = _parse_rsc_chunks(html)
    if out:
        return out

    log.info("StubHub: no parseable listing data found")
    return []


def _parse_script_blocks(html: str) -> List[Listing]:
    candidates = [
        re.search(r'<script id="__NEXT_DATA__"[^>]*>(.*?)</script>', html, re.S),
        re.search(r'window\.__REDUX_STATE__\s*=\s*(\{.*?\});\s*</script>', html, re.S),
        re.search(r'window\.SH_DATA\s*=\s*(\{.*?\});\s*</script>', html, re.S),
    ]
    # Also try all application/json and application/ld+json blocks
    for jm in re.finditer(r'<script[^>]+type="application/(?:ld\+)?json"[^>]*>(.*?)</script>', html, re.S):
        candidates.append(jm)

    out: List[Listing] = []
    for m in candidates:
        if not m:
            continue
        try:
            data = json.loads(m.group(1))
        except (json.JSONDecodeError, IndexError):
            continue
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


def _parse_rsc_chunks(html: str) -> List[Listing]:
    chunks = re.findall(r'self\.__next_f\.push\(\[\s*\d+\s*,\s*"((?:[^"\\]|\\.)*)"', html)
    if not chunks:
        return []
    log.info("StubHub: found %d RSC chunks", len(chunks))
    decoder = json.JSONDecoder()
    out: List[Listing] = []
    for chunk in chunks:
        try:
            unescaped = bytes(chunk, "utf-8").decode("unicode_escape")
        except Exception:
            unescaped = chunk
        text = re.sub(r'^\d+:[A-Za-z]?', '', unescaped.strip())
        pos = 0
        while pos < len(text):
            idx = text.find('{', pos)
            arr_idx = text.find('[', pos)
            if idx == -1 and arr_idx == -1:
                break
            if idx == -1:
                idx = arr_idx
            elif arr_idx != -1:
                idx = min(idx, arr_idx)
            try:
                obj, end_pos = decoder.raw_decode(text, idx)
                if isinstance(obj, (dict, list)):
                    for node in _walk(obj):
                        try:
                            qty = int(node.get("quantity") or node.get("ticketQty") or 0)
                            price = node.get("rawPrice") or node.get("price") or node.get("currentPrice")
                            if isinstance(price, dict):
                                price = price.get("amount") or price.get("value")
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
                pos = end_pos
            except json.JSONDecodeError:
                pos = idx + 1
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
