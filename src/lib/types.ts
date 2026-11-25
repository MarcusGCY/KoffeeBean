export const ROASTS = ["light", "medium", "medium-dark", "dark"] as const;
export type Roast = (typeof ROASTS)[number];

/** Taste and size facts for a coffee bean item. */
export type BeanAttributes = {
  roast: Roast;
  origin: string;
  notes: string[];
  grams: number;
};

export type Product = {
  id: string;
  name: string;
  category: "beans" | "merch";
  price: number; // cents
  blurb: string;
  /** Present on beans; merch omits it. */
  attributes?: BeanAttributes;
};

export type CartItem = { productId: string; quantity: number };

/** Auth0 fields safe to render. Session tokens stay on the server. */
export type Shopper = {
  id: string;
  email?: string;
  name?: string;
  /** HTTPS profile image from the session, when one is safe to render. */
  picture?: string;
};
