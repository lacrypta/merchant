import type { Metadata, Viewport } from "next";
import { standerd } from "./fonts";
import { Providers } from "./providers";
import "./globals.css";

export const viewport: Viewport = {
  themeColor: "#0A0A0A", // matches --background so browser chrome blends
  colorScheme: "dark",
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover", // required for env(safe-area-inset-bottom)
  interactiveWidget: "resizes-content", // sticky footers sit above the keyboard
};

export const metadata: Metadata = {
  title: {
    default: "Merchant Manager · La Crypta",
    template: "%s · Merchant Manager",
  },
  description: "Gestioná tu catálogo de productos y servicios sobre nostr.",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    // `dark` is hardcoded: this app is dark-only. No theme toggle, no
    // next-themes, so no suppressHydrationWarning is needed.
    <html lang="es-AR" className={`dark ${standerd.variable} h-full`}>
      <body className="flex min-h-full flex-col">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
