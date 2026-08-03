import type { Metadata } from "next";
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

const metadataBase = new URL(
  process.env.ALBERT_PUBLIC_ORIGIN ?? "http://localhost:3000",
);

const description =
  "Ask questions in plain English and get governed answers grounded in your business data.";

export const metadata: Metadata = {
  metadataBase,
  applicationName: "Albert",
  title: {
    default: "Albert — Natural-language analytics",
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
    title: "Albert — Natural-language analytics",
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
    title: "Albert — Natural-language analytics",
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
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
      >
        {children}
      </body>
    </html>
  );
}
