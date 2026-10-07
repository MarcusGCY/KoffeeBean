export type Product = {
  id: string;
  name: string;
  category: "beans" | "merch";
  price: number; // cents
  blurb: string;
};

export type CartItem = { productId: string; quantity: number };

/** Auth0 fields safe to render. Session tokens stay on the server. */
export type Shopper = {
  id: string;
  email?: string;
  name?: string;
};
