from dataclasses import dataclass, asdict
from typing import Optional
import re


@dataclass
class Listing:
    source: str
    section: str
    row: Optional[str]
    quantity: int
    price_per_ticket: float
    url: Optional[str] = None

    def fingerprint(self) -> str:
        return f"{self.source}|{self.section}|{self.row}|{self.quantity}|{self.price_per_ticket:.2f}"

    def to_dict(self) -> dict:
        return asdict(self)


SECTION_NUM_RE = re.compile(r"\d+")


def section_in_target(section: str) -> bool:
    if not section:
        return False
    m = SECTION_NUM_RE.search(section)
    if not m:
        return False
    n = int(m.group(0))
    return (1 <= n <= 9) or (100 <= n <= 139)


def matches(listing: Listing, max_price: float = 300.0, min_qty: int = 2) -> bool:
    return (
        listing.quantity >= min_qty
        and listing.price_per_ticket < max_price
        and section_in_target(listing.section)
    )
