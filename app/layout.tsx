import type { Metadata } from "next";
import { Archivo, Figtree, JetBrains_Mono } from "next/font/google";
import "./globals.css";

/**
 * Three typefaces, three jobs.
 *
 * Loaded through next/font so nothing renders unstyled and no request leaves the
 * browser for a font at runtime.
 *
 * ARCHIVO — signage. The wordmark, buttons, and module headers: the things that
 * label rather than inform. A hard grotesque against Figtree's soft geometric,
 * so the two read as two deliberate voices rather than as one face that drifted.
 *
 * FIGTREE — everything read rather than scanned: nav, eyebrows, headings, body
 * copy, and every table. Soft geometric, so it answers the Memphis diamond the
 * logo is built from, but drawn FOR interfaces rather than adapted to them -
 * circular bowls, open apertures, a tall x-height, terminals cut on the
 * horizontal. The 13px table row is the test that counts, because that is where
 * most of the platform's text actually lives.
 *
 * The split with Archivo is by ROLE, never by size. Archivo is signage -
 * wordmark, buttons, module headers. Figtree is everything a person reads.
 * Splitting on size instead would put two faces on the same job with no visible
 * logic, at a size where the difference is too small to read as intent, which
 * looks like a bug rather than a decision.
 *
 * JETBRAINS MONO — data. Timestamps, immutable message ids, Niagara point names,
 * sensor values, and the bracketed project tag. Chosen over Geist Mono for one
 * reason: disambiguated 0/O and 1/l/I. This face renders `points_RoomT` and
 * `AAkALgAAAAAAHYQD…`, where a confused character is a real failure rather than
 * a cosmetic one.
 */

const archivo = Archivo({
  subsets: ["latin"],
  variable: "--font-archivo",
  weight: ["500", "600", "700"],
  display: "swap",
});

const figtree = Figtree({
  subsets: ["latin"],
  variable: "--font-figtree",
  weight: ["400", "500", "600"],
  display: "swap",
});

const jetbrainsMono = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-jetbrains-mono",
  weight: ["400", "500"],
  display: "swap",
});

export const metadata: Metadata = {
  title: "PHB Platform",
  description: "Peck Hannaford + Briggs internal platform",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html
      lang="en"
      className={`${archivo.variable} ${figtree.variable} ${jetbrainsMono.variable}`}
    >
      <body className="min-h-screen antialiased">{children}</body>
    </html>
  );
}
