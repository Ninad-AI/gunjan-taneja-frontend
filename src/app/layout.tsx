import type { Metadata } from "next";
import { Outfit, Playfair_Display } from "next/font/google";
import "./globals.css";
import { PROFILE } from "@/lib/profile";

const outfit = Outfit({
  subsets: ["latin"],
  variable: "--font-outfit",
});

const playfair = Playfair_Display({
  subsets: ["latin"],
  variable: "--font-playfair",
});

export const metadata: Metadata = {
  title: `${PROFILE.name} — Voice Chat`,
  description:
    `Premium interactive voice chat experience with ${PROFILE.name}, ${PROFILE.role}. Start a live session now.`,
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className={`${outfit.variable} ${playfair.variable} antialiased noise-overlay`}>
        {children}
      </body>
    </html>
  );
}
