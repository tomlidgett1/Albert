import type { Metadata } from "next";
import localFont from "next/font/local";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

const superiorSerif = localFont({
  src: [
    {
      path: "./fonts/LTSuperiorSerif-Regular.otf",
      weight: "400",
      style: "normal",
    },
    {
      path: "./fonts/LTSuperiorSerif-Medium.otf",
      weight: "500",
      style: "normal",
    },
    {
      path: "./fonts/LTSuperiorSerif-Semibold.otf",
      weight: "600",
      style: "normal",
    },
    {
      path: "./fonts/LTSuperiorSerif-Bold.otf",
      weight: "700",
      style: "normal",
    },
  ],
  variable: "--font-superior-serif",
  display: "swap",
});

const metadataBase = new URL(
  process.env.ALBERT_PUBLIC_ORIGIN ?? "http://localhost:3000",
);

const description =
  "Governed, natural-language analytics for small business.";

export const metadata: Metadata = {
  metadataBase,
  applicationName: "Albert",
  title: {
    default: "Albert — Governed natural-language analytics",
    template: "%s · Albert",
  },
  description,
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
  openGraph: {
    type: "website",
    siteName: "Albert",
    title: "Albert — Governed natural-language analytics",
    description,
    images: [
      {
        url: "/og.png",
        width: 1731,
        height: 909,
        alt: "A conversational reasoning trace resolving into a governed table and chart",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "Albert — Governed natural-language analytics",
    description,
    images: ["/og.png"],
  },
  robots: {
    index: false,
    follow: false,
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body
        className={`${geistSans.variable} ${geistMono.variable} ${superiorSerif.variable} antialiased`}
      >
        {children}
      </body>
    </html>
  );
}
