"""Entry point for the Noah Kahan ticket scraper.

Run:  python -m ticket_scraper.scrape

Configurable via env vars:
  EVENT_DATE           default 2026-07-19
  MAX_PRICE_PER_TICKET default 300
  MIN_QUANTITY         default 2
  GITHUB_REPOSITORY    e.g. owner/name (set automatically in Actions)
  GITHUB_TOKEN         token with issues:write
"""
import logging
import os
import sys
from typing import List

from .models import Listing, matches
from .notify import alert, email_alert, report_scrape_failure
from .sources import seatgeek, ticketmaster, stubhub, vividseats, tickpick

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
)
log = logging.getLogger("scrape")

SOURCES = [
    ("seatgeek", lambda d: seatgeek.fetch(d)),
    ("ticketmaster", lambda d: ticketmaster.fetch(d)),
    ("stubhub", lambda d: stubhub.fetch(d)),
    ("vividseats", lambda d: vividseats.fetch(d)),
    ("tickpick", lambda d: tickpick.fetch(d)),
]


def main() -> int:
    event_date = os.environ.get("EVENT_DATE", "2026-07-19")
    max_price = float(os.environ.get("MAX_PRICE_PER_TICKET", "300"))
    min_qty = int(os.environ.get("MIN_QUANTITY", "2"))

    log.info("Scraping for Noah Kahan @ Citi Field on %s", event_date)
    log.info("Filter: sections 1-9 or 100-139, qty >= %d, < $%.0f/ticket", min_qty, max_price)

    all_listings: List[Listing] = []
    per_source_counts: dict[str, int] = {}
    for name, fetch in SOURCES:
        try:
            listings = fetch(event_date)
        except Exception as e:
            log.exception("Source %s crashed: %s", name, e)
            listings = []
        per_source_counts[name] = len(listings)
        all_listings.extend(listings)

    log.info("Scrape totals: %s", per_source_counts)

    matching = [l for l in all_listings if matches(l, max_price=max_price, min_qty=min_qty)]
    log.info("Matches after filter: %d", len(matching))
    for l in matching:
        log.info("  MATCH %s sec %s row %s qty %d @ $%.2f",
                 l.source, l.section, l.row, l.quantity, l.price_per_ticket)

    repo = os.environ.get("GITHUB_REPOSITORY")
    token = os.environ.get("GITHUB_TOKEN")

    if matching:
        email_alert(matching)
        if repo and token:
            created = alert(repo, token, matching)
            log.info("Created %d new issue(s)", len(created))
        else:
            log.warning("GITHUB_REPOSITORY / GITHUB_TOKEN not set; skipping issue creation")
    elif sum(per_source_counts.values()) == 0 and repo and token:
        summary = (
            "Daily ticket scrape found zero listings across every source. "
            "Likely causes: scraper selectors stale, anti-bot block, or event not yet listed.\n\n"
            f"Counts: {per_source_counts}"
        )
        report_scrape_failure(repo, token, summary)

    return 0


if __name__ == "__main__":
    sys.exit(main())
