import type { Metadata } from "next";
import { Geist } from "next/font/google";
import "./globals.css";

const geist = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Paris Beer Map — Prix de la pinte par quartier",
  description: "4 165 prix de bières collectés dans 7 778 bars parisiens. Médiane : 5,50 €. Trouve le bar le moins cher près de toi.",
  openGraph: {
    title: "Paris Beer Map — Prix de la pinte par quartier",
    description: "4 165 prix collectés dans 7 778 bars. Du 5€ dans le 20e au 8,50€ dans le 7e.",
    url: "https://paris-beer-map.vercel.app",
    siteName: "Paris Beer Map",
    locale: "fr_FR",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "Paris Beer Map",
    description: "Prix de la pinte dans 7 778 bars parisiens. Médiane 5,50€.",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="fr" className={`${geist.variable} h-full`}>
      <body className="h-full">{children}</body>
    </html>
  );
}
