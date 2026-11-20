import type { Metadata, Viewport } from "next";
import { Shippori_Mincho, Inter, JetBrains_Mono } from "next/font/google";
import "./globals.css";

const serif = Shippori_Mincho({ subsets: ["latin"], weight: ["500", "700", "800"], variable: "--font-serif" });
const sans = Inter({ subsets: ["latin"], variable: "--font-sans" });
const mono = JetBrains_Mono({ subsets: ["latin"], variable: "--font-mono" });

export const metadata: Metadata = {
  title: "Ukiyo · Curator Scoreboard",
  description:
    "An honest scoreboard for curated liquidity on Uniswap v4: Edge = user fees + user price impact − arbitrage loss.",
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f4ebdc" },
    { media: "(prefers-color-scheme: dark)", color: "#10141c" },
  ],
};

// Applies a remembered theme before first paint, so dark-mode readers never see a light flash.
const themeScript = `try{var t=localStorage.getItem("ukiyo-theme");if(t==="light"||t==="dark")document.documentElement.dataset.theme=t}catch(e){}`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${serif.variable} ${sans.variable} ${mono.variable}`} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
