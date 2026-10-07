import products from "@/data/products.json";
import type { Product } from "./types";

const catalog = products as Product[];

/** Public URL for a catalog image: merch at /images/merch, beans beside them. */
export function productImageUrl(id: string): string {
  const product = catalog.find((p) => p.id === id);
  const folder = product?.category === "beans" ? "images/beans" : "images/merch";
  return `/${folder}/${id}.svg`;
}
