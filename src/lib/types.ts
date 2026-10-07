export type Product = {
  id: string;
  name: string;
  category: "beans" | "merch";
  price: number; // cents
  blurb: string;
};

export type CartItem = { productId: string; quantity: number };
