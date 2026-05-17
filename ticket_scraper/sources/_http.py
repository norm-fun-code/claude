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


def get(url: str, render_js: bool = False, premium_proxy: bool = False, timeout: int = 60, **kwargs) -> requests.Response:
    """Fetch url, routing through ScrapingBee if SCRAPINGBEE_API_KEY is set.

    render_js=True costs 5 credits vs 1. premium_proxy=True costs 25 credits
    but uses residential IPs that bypass Cloudflare/DataDome. Use only when
    a regular proxy gets 403/500.
    """
    api_key = os.environ.get("SCRAPINGBEE_API_KEY")
    if api_key:
        # Merge caller-supplied params into the target URL
        caller_params = kwargs.pop("params", None)
        target_url = url
        if caller_params:
            from urllib.parse import urlencode
            sep = "&" if "?" in url else "?"
            target_url = url + sep + urlencode(caller_params)
        params = {
            "api_key": api_key,
            "url": target_url,
            "render_js": "true" if render_js else "false",
            "premium_proxy": "true" if premium_proxy else "false",
            "block_ads": "true",
        }
        log.info("ScrapingBee → %s (render_js=%s, premium=%s)", target_url, render_js, premium_proxy)
        resp = requests.get(SCRAPINGBEE_API, params=params, timeout=timeout, **kwargs)
        if resp.status_code != 200:
            log.warning("ScrapingBee returned %d for %s", resp.status_code, target_url)
        return resp
    # Fallback: plain requests
    s = session()
    return s.get(url, timeout=timeout, **kwargs)
