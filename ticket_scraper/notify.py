"""GitHub issue creation and email alerts.

Issue creation dedupes by fingerprint embedded in the title.
Email uses Gmail SMTP with an App Password (no extra deps).
"""
import logging
import os
import smtplib
import ssl
from email.mime.text import MIMEText
from typing import Iterable, List

import requests

from .models import Listing

log = logging.getLogger(__name__)

API = "https://api.github.com"
LABEL = "noah-kahan-ticket-alert"


def _headers(token: str) -> dict:
    return {
        "Authorization": f"Bearer {token}",
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
    }


def _existing_fingerprints(repo: str, token: str) -> set[str]:
    r = requests.get(
        f"{API}/repos/{repo}/issues",
        headers=_headers(token),
        params={"state": "all", "labels": LABEL, "per_page": 100},
        timeout=20,
    )
    if r.status_code != 200:
        log.warning("GitHub list issues failed: %d %s", r.status_code, r.text[:200])
        return set()
    fps: set[str] = set()
    for issue in r.json():
        title = issue.get("title", "")
        # Title format: "[fingerprint] human text"
        if title.startswith("[") and "]" in title:
            fps.add(title[1:title.index("]")])
    return fps


def _ensure_label(repo: str, token: str) -> None:
    r = requests.get(f"{API}/repos/{repo}/labels/{LABEL}", headers=_headers(token), timeout=15)
    if r.status_code == 200:
        return
    requests.post(
        f"{API}/repos/{repo}/labels",
        headers=_headers(token),
        json={"name": LABEL, "color": "f9d71c", "description": "Auto-alert for matching Noah Kahan tickets"},
        timeout=15,
    )


def _body_for(listing: Listing) -> str:
    qty = listing.quantity
    price = listing.price_per_ticket
    total = qty * price
    lines = [
        "Matching listing found.",
        "",
        f"- **Source:** {listing.source}",
        f"- **Section:** {listing.section}",
        f"- **Row:** {listing.row or 'n/a'}",
        f"- **Quantity:** {qty}",
        f"- **Price per ticket:** ${price:.2f}",
        f"- **Total:** ${total:.2f}",
    ]
    if listing.url:
        lines += ["", f"[Open listing]({listing.url})"]
    lines += [
        "",
        "_Filter: sections 1–9 or 100–139, qty ≥ 2, < $300/ticket._",
    ]
    return "\n".join(lines)


def _email_body(listings: List[Listing]) -> str:
    lines = [
        f"🎟  {len(listings)} matching Noah Kahan ticket listing(s) found!",
        "Event: July 19, 2026 — Citi Field",
        "Filter: sections 1–9 or 100–139, qty ≥ 2, < $300/ticket",
        "",
    ]
    for l in listings:
        lines += [
            f"Source:  {l.source}",
            f"Section: {l.section}  Row: {l.row or 'n/a'}",
            f"Qty:     {l.quantity}",
            f"Price:   ${l.price_per_ticket:.2f}/ticket  (total ${l.quantity * l.price_per_ticket:.2f})",
        ]
        if l.url:
            lines.append(f"Link:    {l.url}")
        lines.append("")
    return "\n".join(lines)


def email_alert(listings: List[Listing]) -> None:
    gmail_address = os.environ.get("GMAIL_ADDRESS")
    app_password = os.environ.get("GMAIL_APP_PASSWORD")
    notify_email = os.environ.get("NOTIFY_EMAIL") or gmail_address

    if not gmail_address or not app_password:
        log.warning("GMAIL_ADDRESS / GMAIL_APP_PASSWORD not set; skipping email")
        return

    msg = MIMEText(_email_body(listings))
    msg["Subject"] = f"[Ticket Alert] {len(listings)} Noah Kahan listing(s) under $300 in target sections"
    msg["From"] = gmail_address
    msg["To"] = notify_email

    ctx = ssl.create_default_context()
    try:
        with smtplib.SMTP("smtp.gmail.com", 587, timeout=30) as smtp:
            smtp.ehlo()
            smtp.starttls(context=ctx)
            smtp.login(gmail_address, app_password)
            smtp.sendmail(gmail_address, notify_email, msg.as_string())
        log.info("Email sent to %s", notify_email)
    except Exception as e:
        log.warning("Email send failed: %s", e)


def alert(repo: str, token: str, listings: Iterable[Listing]) -> List[str]:
    listings = list(listings)
    if not listings:
        return []
    _ensure_label(repo, token)
    seen = _existing_fingerprints(repo, token)
    created: List[str] = []
    for l in listings:
        fp = l.fingerprint()
        if fp in seen:
            log.info("Dedup: %s already alerted", fp)
            continue
        title = f"[{fp}] {l.source} sec {l.section} x{l.quantity} @ ${l.price_per_ticket:.0f}"
        r = requests.post(
            f"{API}/repos/{repo}/issues",
            headers=_headers(token),
            json={"title": title, "body": _body_for(l), "labels": [LABEL]},
            timeout=20,
        )
        if r.status_code in (200, 201):
            url = r.json().get("html_url", "")
            created.append(url)
            log.info("Created issue: %s", url)
        else:
            log.warning("Issue create failed: %d %s", r.status_code, r.text[:200])
    return created


def email_scraper_failure(summary: str) -> None:
    gmail_address = os.environ.get("GMAIL_ADDRESS")
    app_password = os.environ.get("GMAIL_APP_PASSWORD")
    notify_email = os.environ.get("NOTIFY_EMAIL") or gmail_address
    if not gmail_address or not app_password:
        log.warning("GMAIL creds missing; skipping scraper-failure email")
        return
    msg = MIMEText(
        "Daily scraper ran but every source returned zero listings.\n\n"
        "This usually means anti-bot defenses are blocking the GitHub Actions\n"
        "runner. The scraper is still alive — you'd see no email at all if it\n"
        "had crashed.\n\n"
        + summary
    )
    msg["Subject"] = "[Ticket Watcher] Scraper alive but found no listings today"
    msg["From"] = gmail_address
    msg["To"] = notify_email
    ctx = ssl.create_default_context()
    try:
        with smtplib.SMTP("smtp.gmail.com", 587, timeout=30) as smtp:
            smtp.ehlo()
            smtp.starttls(context=ctx)
            smtp.login(gmail_address, app_password)
            smtp.sendmail(gmail_address, notify_email, msg.as_string())
        log.info("Scraper-failure email sent to %s", notify_email)
    except Exception as e:
        log.warning("Scraper-failure email send failed: %s", e)


def report_scrape_failure(repo: str, token: str, summary: str) -> None:
    """Open a tracking issue when EVERY source returned zero listings.

    Helps catch silent scraper rot. Deduped against an open issue with the
    same title. Also emails the user so silent failures don't go unnoticed.
    """
    email_scraper_failure(summary)
    if not repo or not token:
        log.warning("Repo/token missing; skipping scraper-failure issue")
        return
    title = "[scraper-health] All sources returned no listings"
    r = requests.get(
        f"{API}/repos/{repo}/issues",
        headers=_headers(token),
        params={"state": "open", "labels": LABEL, "per_page": 100},
        timeout=15,
    )
    if r.status_code != 200:
        log.warning("Scraper-failure list issues failed: %d %s", r.status_code, r.text[:200])
    elif any(i.get("title") == title for i in r.json()):
        log.info("Scraper-failure issue already open; skipping")
        return
    _ensure_label(repo, token)
    r2 = requests.post(
        f"{API}/repos/{repo}/issues",
        headers=_headers(token),
        json={"title": title, "body": summary, "labels": [LABEL]},
        timeout=15,
    )
    if r2.status_code in (200, 201):
        log.info("Scraper-failure issue created: %s", r2.json().get("html_url", ""))
    else:
        log.warning("Scraper-failure issue create failed: %d %s", r2.status_code, r2.text[:200])
