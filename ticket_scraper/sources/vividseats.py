"""Vivid Seats scraper — uses hardcoded production ID."""
import json
import logging
import re
from typing import List

from ..models import Listing
from ._http import get

log = logging.getLogger(__name__)

EVENT_URL = "https://www.vividseats.com/noah-kahan-tickets-flushing-citi-field-7-19-2026--concerts-pop/production/6642335"


def fetch(date_iso: str, query: str = "Noah Kahan Citi Field") -> List[Listing]:
    html = _fetch_html(premium=False)
    listings = _parse(html) if html else []
    if listings:
        log.info("Vivid Seats: parsed %d listings", len(listings))
        return listings

    log.info("Vivid Seats: retrying with premium_proxy")
    html = _fetch_html(premium=True)
    listings = _parse(html) if html else []
    log.info("Vivid Seats: parsed %d listings (premium)", len(listings))
    return listings


def _fetch_html(premium: bool) -> str | None:
    try:
        r = get(EVENT_URL, render_js=True, premium_proxy=premium, timeout=90)
        if r.status_code != 200:
            log.info("Vivid Seats event page returned %d (premium=%s)", r.status_code, premium)
            return None
        return r.text
    except Exception as e:
        log.warning("Vivid Seats event page fetch failed: %s", e)
        return None


def _parse(html: str) -> List[Listing]:
    m = re.search(r'<script id="__NEXT_DATA__"[^>]*>(.*?)</script>', html, re.S)
    if not m:
        log.info("Vivid Seats: __NEXT_DATA__ not found | snippet: %.200s",
                 re.sub(r'\s+', ' ', html[:400]))
        return []
    try:
        data = json.loads(m.group(1))
    except json.JSONDecodeError:
        log.warning("Vivid Seats: __NEXT_DATA__ JSON parse failed")
        return []

    props = data.get("props", {}).get("pageProps", {})
    log.info("Vivid Seats __NEXT_DATA__ pageProps keys: %s", list(props.keys())[:20])

    ipdd = props.get("initialProductionDetailsData", {})
    if isinstance(ipdd, dict):
        log.info("Vivid Seats initialProductionDetailsData keys: %s", list(ipdd.keys())[:20])
        inner = ipdd.get("data", {})
        if isinstance(inner, dict):
            log.info("Vivid Seats data keys: %s", list(inner.keys())[:20])
            for k, v in list(inner.items())[:8]:
                if isinstance(v, list) and v:
                    sample = v[0]
                    log.info("Vivid Seats data.%s (list len=%d) sample keys: %s",
                             k, len(v),
                             list(sample.keys())[:15] if isinstance(sample, dict) else repr(sample)[:80])
                elif isinstance(v, dict):
                    log.info("Vivid Seats data.%s keys: %s", k, list(v.keys())[:15])
        elif isinstance(inner, list) and inner:
            sample = inner[0]
            log.info("Vivid Seats data is list len=%d sample keys: %s",
                     len(inner),
                     list(sample.keys())[:15] if isinstance(sample, dict) else repr(sample)[:80])

    out: List[Listing] = []
    for node in _walk(data):
        try:
            qty = int(node.get("quantity") or node.get("availableQty") or
                      node.get("availableTickets") or node.get("ticketQuantity") or 0)
            price = (node.get("price") or node.get("currentPrice") or
                     node.get("listingPrice") or node.get("amount") or
                     node.get("listPrice") or node.get("priceWithFees"))
            if isinstance(price, dict):
                price = price.get("amount") or price.get("value") or price.get("total")
            section = str(node.get("section") or node.get("sectionName") or
                          node.get("sectionAlias") or "")
            row = node.get("row") or node.get("rowId")
            if not section or qty <= 0 or not price:
                continue
            out.append(Listing(
                source="vividseats",
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
        has_section = any(k in obj for k in ("section", "sectionName", "sectionAlias"))
        has_qty = any(k in obj for k in ("quantity", "availableQty", "availableTickets", "ticketQuantity"))
        if has_section and has_qty:
            yield obj
        for v in obj.values():
            yield from _walk(v)
    elif isinstance(obj, list):
        for item in obj:
            yield from _walk(item)
