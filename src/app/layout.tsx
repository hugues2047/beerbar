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
    description: "4 165 prix collectés dans 7 778 bars. Du 5€ dans le 20e au 8€ dans le 7e.",
    url: "https://speedbeer.vercel.app",
    siteName: "Paris Beer Map",
    locale: "fr_FR",
    type: "website",
    images: [{
      url: "https://speedbeer.vercel.app/beer-map-paris.png",
      width: 940,
      height: 870,
      alt: "Prix de la pinte à Paris par arrondissement",
    }],
  },
  twitter: {
    card: "summary_large_image",
    title: "Paris Beer Map",
    description: "Prix de la pinte dans 7 778 bars parisiens. Médiane 5,50€.",
    images: ["https://speedbeer.vercel.app/beer-map-paris.png"],
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
