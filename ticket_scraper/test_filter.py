from .models import Listing, matches, section_in_target


def test_section_target_ranges():
    assert section_in_target("1")
    assert section_in_target("9")
    assert section_in_target("100")
    assert section_in_target("139")
    assert section_in_target("Section 105")
    assert section_in_target("Sec 7")
    assert not section_in_target("10")
    assert not section_in_target("99")
    assert not section_in_target("140")
    assert not section_in_target("200")
    assert not section_in_target("Promenade 401")
    assert not section_in_target("")


def _l(section, qty=2, price=250.0):
    return Listing(source="t", section=section, row="A", quantity=qty, price_per_ticket=price)


def test_match_happy_path():
    assert matches(_l("105"))
    assert matches(_l("5"))


def test_match_rejects_high_price():
    assert not matches(_l("105", price=300.0))
    assert not matches(_l("105", price=350.0))


def test_match_rejects_low_quantity():
    assert not matches(_l("105", qty=1))


def test_match_rejects_wrong_section():
    assert not matches(_l("215"))
    assert not matches(_l("Promenade 401"))


if __name__ == "__main__":
    # Tiny runner so we don't need pytest installed
    import inspect, sys
    g = dict(globals())
    failures = 0
    for name, fn in g.items():
        if name.startswith("test_") and callable(fn):
            try:
                fn()
                print(f"  ok  {name}")
            except AssertionError as e:
                failures += 1
                print(f"  FAIL {name}: {e}")
    sys.exit(1 if failures else 0)
