-- Shopping agent history: every item you add to a cart, so the Shop tab can
-- offer one-tap reorder. Not a payment record — just what you've shopped for.
CREATE TABLE IF NOT EXISTS shop_orders (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title       TEXT NOT NULL,
  business    TEXT,                 -- merchant domain (for rebuilding the cart)
  variant_id  TEXT,                 -- UCP product variant id
  price       TEXT,
  query       TEXT,                 -- the search that found it
  image       TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_shop_orders_time ON shop_orders (created_at DESC);
