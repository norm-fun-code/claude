import logging
import os
from urllib.parse import quote

import requests

log = logging.getLogger(__name__)

UA = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/124.0.0.0 Safari/537.36"
)

SCRAPINGBEE_API = "https://app.scrapingbee.com/api/v1/"

_DEFAULT_HEADERS = {
    "User-Agent": UA,
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    "Accept-Encoding": "gzip, deflate, br",
    "Connection": "keep-alive",
    "Upgrade-Insecure-Requests": "1",
}


def session() -> requests.Session:
    s = requests.Session()
    s.headers.update(_DEFAULT_HEADERS)
    return s


def get(url: str, render_js: bool = False, timeout: int = 40, **kwargs) -> requests.Response:
    """Fetch url, routing through ScrapingBee if SCRAPINGBEE_API_KEY is set.

    render_js=True costs 5 ScrapingBee credits vs 1 for False. Use True
    only for React/Next.js pages where listings aren't in the initial HTML.
    """
    api_key = os.environ.get("SCRAPINGBEE_API_KEY")
    if api_key:
        params = {
            "api_key": api_key,
            "url": url,
            "render_js": "true" if render_js else "false",
            "premium_proxy": "false",
            "block_ads": "true",
        }
        # Pass any caller-supplied params by appending them to the target URL
        caller_params = kwargs.pop("params", None)
        if caller_params:
            from urllib.parse import urlencode
            sep = "&" if "?" in url else "?"
            params["url"] = url + sep + urlencode(caller_params)
        log.debug("ScrapingBee → %s (render_js=%s)", params["url"], render_js)
        resp = requests.get(SCRAPINGBEE_API, params=params, timeout=timeout, **kwargs)
        if resp.status_code == 200:
            return resp
        log.warning("ScrapingBee returned %d for %s", resp.status_code, url)
        return resp
    # Fallback: plain requests
    s = session()
    return s.get(url, timeout=timeout, **kwargs)
