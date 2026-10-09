import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { planFileChanges, transformFile } from "@/lib/text-patch";

const images = readFileSync("src/lib/images.ts", "utf8");
const imagesFixed = images;
const imagesBuggy = images.replace(
  'category === "beans" ? "images/beans"',
  'category === "beans" ? "imges/beans"',
);

describe("transformFile", () => {
  it("reverses the bean image fix without dropping a later commit's other lines", () => {
    expect(imagesBuggy).not.toBe(imagesFixed);
    const current = `// added after the fix\n${imagesFixed}`;
    const result = transformFile(imagesBuggy, imagesFixed, current, "reverse");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.changed).toBe(true);
    expect(result.text).toBe(`// added after the fix\n${imagesBuggy}`);
  });

  it("refuses when a later commit edited the same line", () => {
    const current = imagesFixed.replace(
      'category === "beans" ? "images/beans"',
      'category === "beans" ? "images/coffee"',
    );
    const result = transformFile(imagesBuggy, imagesFixed, current, "reverse");
    expect(result).toEqual({
      ok: false,
      reason: "later edits touched the same lines, so the change does not match the current file",
    });
  });

  it("keeps a neighboring edit when only the context line moved", () => {
    const before = ["a", "b", "OLD", "c", "d"].join("\n") + "\n";
    const after = ["a", "b", "NEW", "c", "d"].join("\n") + "\n";
    const current = ["a", "b", "NEW", "CHANGED", "d"].join("\n") + "\n";
    const result = transformFile(before, after, current, "reverse");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.text).toBe(["a", "b", "OLD", "CHANGED", "d"].join("\n") + "\n");
  });

  it("re-applies a multi-line cart bug and leaves a later function in place", () => {
    const before = [
      "export function addItem(cart: CartItem[], productId: string): CartItem[] {",
      "  const existing = cart.find((i) => i.productId === productId);",
      "  if (existing) {",
      "    return cart.map((i) =>",
      "      i.productId === productId ? { ...i, quantity: i.quantity + 1 } : i,",
      "    );",
      "  }",
      "  return [...cart, { productId, quantity: 1 }];",
      "}",
      "",
    ].join("\n");
    const after = [
      "export function addItem(cart: CartItem[], productId: string): CartItem[] {",
      '  const id = productId.replace("tote", "canvas-tote");',
      "  if (!getProduct(id)) return cart;",
      "",
      "  const existing = cart.find((i) => i.productId === id);",
      "  if (existing) {",
      "    return cart.map((i) =>",
      "      i.productId === id ? { ...i, quantity: i.quantity + 1 } : i,",
      "    );",
      "  }",
      "  return [...cart, { productId: id, quantity: 1 }];",
      "}",
      "",
    ].join("\n");
    const current = `${before}export function later() {\n  return 1;\n}\n`;
    const result = transformFile(before, after, current, "forward");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.text?.startsWith(after.trimEnd()) || result.text?.includes('replace("tote", "canvas-tote")')).toBe(true);
    expect(result.text).toContain("export function later()");
    const again = transformFile(before, after, result.text, "forward");
    expect(again).toMatchObject({ ok: true, changed: false });
  });

  it("restores a deleted file and deletes an added file", () => {
    expect(transformFile("hello\n", null, null, "reverse")).toEqual({
      ok: true,
      text: "hello\n",
      changed: true,
    });
    expect(transformFile(null, "hello\n", "hello\n", "reverse")).toEqual({
      ok: true,
      text: null,
      changed: true,
    });
    expect(transformFile(null, "hello\n", "edited\n", "reverse").ok).toBe(false);
  });

  it("changes one copy when the changed lines occur twice", () => {
    const before = "X\nOLD\nY\n";
    const after = "X\nNEW\nY\n";
    const current = "X\nNEW\nY\nX\nNEW\nY\n";
    const result = transformFile(before, after, current, "reverse");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.text).toBe("X\nNEW\nY\nX\nOLD\nY\n");
  });
});

describe("planFileChanges", () => {
  it("aborts every file when one path conflicts", () => {
    const plan = planFileChanges(
      [
        { path: "src/lib/images.ts", before: "old\n", after: "new\n", current: "new\n" },
        { path: "src/lib/cart.ts", before: "a\n", after: "b\n", current: "c\n" },
      ],
      "reverse",
    );
    expect(plan).toEqual({
      ok: false,
      path: "src/lib/cart.ts",
      reason: "later edits touched the same lines, so the change does not match the current file",
    });
  });

  it("reports no commit when every file is already in the target state", () => {
    const plan = planFileChanges(
      [
        { path: "src/lib/images.ts", before: imagesBuggy, after: imagesFixed, current: imagesBuggy },
        { path: "src/data/products.json", before: "2500\n", after: "25000\n", current: "2500\n" },
      ],
      "reverse",
    );
    expect(plan).toEqual({ ok: true, files: [], changed: false });
  });
});
