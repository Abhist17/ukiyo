import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const sans = Geist({ subsets: ["latin"], variable: "--font-sans" });
const mono = Geist_Mono({ subsets: ["latin"], variable: "--font-mono" });

// Where the site is published (Vercel; set at build time by scripts/deploy-vercel.sh); link previews need absolute URLs.
const SITE = process.env.NEXT_PUBLIC_SITE_URL || "https://ukiyo-ochre.vercel.app/";

export const metadata: Metadata = {
  metadataBase: new URL(SITE),
  openGraph: {
    title: "Ukiyo · Rank liquidity curators by skill, not by luck",
    description: "A Uniswap v4 hook that scores every curator's Edge on-chain: user fees + user price impact − arbitrage loss.",
    images: [{ url: "og.png", width: 1200, height: 630 }],
    type: "website",
  },
  twitter: { card: "summary_large_image", images: ["og.png"] },
  title: "Ukiyo · Curator Edge on Uniswap v4",
  description:
    "An honest scoreboard for curated liquidity on Uniswap v4: Edge = user fees + user price impact − arbitrage loss.",
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f3ecdf" },
    { media: "(prefers-color-scheme: dark)", color: "#090c16" },
  ],
};

// Applies a remembered theme before first paint, so dark-mode readers never see a light flash.
// Also arms the landing page's scroll reveals before first paint (no flash of content that then hides), and disarms
// them after 3 s if the motion script never ran, so a failed script can never leave the page blank.
const themeScript = `try{var t=localStorage.getItem("ukiyo-theme");if(t==="light"||t==="dark")document.documentElement.dataset.theme=t}catch(e){}
try{if(!matchMedia("(prefers-reduced-motion: reduce)").matches){var d=document.documentElement;d.classList.add("motion");setTimeout(function(){if(!window.__motion)d.classList.remove("motion")},3000)}}catch(e){}`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${sans.variable} ${mono.variable}`} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
