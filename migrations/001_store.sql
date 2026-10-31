CREATE TABLE carts (
  user_id text PRIMARY KEY,
  coupon text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE cart_items (
  user_id text NOT NULL,
  product_id text NOT NULL,
  qty integer NOT NULL CHECK (qty > 0 AND qty <= 99),
  PRIMARY KEY (user_id, product_id)
);

-- Order ids are generated in the app as BB- plus 6 characters.
CREATE TABLE orders (
  id text PRIMARY KEY,
  user_id text NOT NULL,
  cancelled_at timestamptz,
  subtotal_cents integer NOT NULL,
  discount_cents integer NOT NULL,
  tax_cents integer NOT NULL,
  total_cents integer NOT NULL,
  coupon text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX orders_user_created_idx ON orders (user_id, created_at DESC);

CREATE TABLE order_items (
  order_id text NOT NULL REFERENCES orders (id) ON DELETE CASCADE,
  product_id text NOT NULL,
  name text NOT NULL,
  unit_price_cents integer NOT NULL,
  qty integer NOT NULL,
  PRIMARY KEY (order_id, product_id)
);
