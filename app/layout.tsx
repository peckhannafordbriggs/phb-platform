import type { Metadata } from "next";
import localFont from "next/font/local";
import "./globals.css";

/**
 * Three typefaces, three jobs.
 *
 * Loaded through next/font so nothing renders unstyled and no request leaves the
 * browser for a font at runtime - and loaded from FILES IN THIS REPOSITORY
 * (`app/fonts/`), not from Google. Until 2026-10-30 these came through
 * `next/font/google`, which fetches Google's CSS at build time; a CI build
 * failed when Google answered with something the loader could not parse
 * (`loader.js`: "Cannot read properties of null (reading '1')"), and a deploy
 * is not allowed to depend on a third party's servers being in a good mood.
 * The files are the exact latin-subset variable woff2 Google was serving, so
 * nothing changed visually; `app/fonts/README.md` says where each came from.
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

/**
 * Google's CSS declared each family for the latin subset only (we asked for
 * `subsets: ["latin"]`), so the same range is declared on each; a glyph outside
 * it falls through to the system stack exactly as it did before. Written out
 * three times because the font loader accepts literals only - a shared constant
 * fails the build with "Font loader values must be explicitly written literals".
 */
const archivo = localFont({
  src: "./fonts/archivo-latin-wght.woff2",
  variable: "--font-archivo",
  weight: "500 700",
  display: "swap",
  declarations: [
    {
      prop: "unicode-range",
      value:
        "U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD",
    },
  ],
});

const figtree = localFont({
  src: "./fonts/figtree-latin-wght.woff2",
  variable: "--font-figtree",
  weight: "400 600",
  display: "swap",
  declarations: [
    {
      prop: "unicode-range",
      value:
        "U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD",
    },
  ],
});

const jetbrainsMono = localFont({
  src: "./fonts/jetbrains-mono-latin-wght.woff2",
  variable: "--font-jetbrains-mono",
  weight: "400 500",
  display: "swap",
  declarations: [
    {
      prop: "unicode-range",
      value:
        "U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD",
    },
  ],
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
