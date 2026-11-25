import { Figtree } from "next/font/google";

const figtree = Figtree({
  variable: "--font-figtree",
  subsets: ["latin"],
  weight: ["500", "600", "700", "800"],
  display: "swap",
});

/** Scopes the Pelita theme (fonts, type scale, radii, colours) to /demo/pelita and below. */
export default function PelitaLayout({ children }: { children: React.ReactNode }) {
  return <div className={`pelita-theme ${figtree.variable} flex flex-1 flex-col`}>{children}</div>;
}
