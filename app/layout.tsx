import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "PHB Platform",
  description: "Peck Hannaford + Briggs internal platform",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body className="min-h-screen antialiased">{children}</body>
    </html>
  );
}
