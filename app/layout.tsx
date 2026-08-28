import type { Metadata } from "next";
import { Archivo, Inter_Tight, JetBrains_Mono } from "next/font/google";
import "./globals.css";

/**
 * Three typefaces, three jobs.
 *
 * Loaded through next/font so nothing renders unstyled and no request leaves the
 * browser for a font at runtime.
 *
 * ARCHIVO — display. Headings, the wordmark, module titles, and the condensed
 * uppercase eyebrows. Chosen over Bricolage because its character is in the
 * proportions rather than in quirks, and a header seen two hundred times a day
 * should not have quirks. It carries a genuinely condensed cut in the same
 * family, which is what the eyebrows need without loading a fourth face.
 *
 * INTER TIGHT — everything dense. The only criterion is legibility at 13-14px in
 * a table, and this face should be invisible. Tighter default tracking than
 * Inter, which matters here: the subjects in this mailbox run past sixty
 * characters (`[CCHMC Bulletin 12] Change Order Request — Additional
 * Information Needed`) and every character of fit is a character less truncated.
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

const interTight = Inter_Tight({
  subsets: ["latin"],
  variable: "--font-inter-tight",
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
      className={`${archivo.variable} ${interTight.variable} ${jetbrainsMono.variable}`}
    >
      <body className="min-h-screen antialiased">{children}</body>
    </html>
  );
}
