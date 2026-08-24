import type { Metadata } from "next";
import { Poppins, Fira_Code } from "next/font/google";
import { ClerkProvider } from "@clerk/nextjs";
import "./globals.css";

const poppins = Poppins({
  variable: "--font-poppins",
  subsets: ["latin"],
  weight: ["400", "500", "600", "700", "800"],
  style: ["normal", "italic"],
  display: "swap",
});

const firaCode = Fira_Code({
  variable: "--font-fira",
  subsets: ["latin"],
  weight: ["400", "500"],
  display: "swap",
});

export const metadata: Metadata = {
  title: "Sanofi GTM & GA Manager",
  description: "Zarządzaj Google Analytics 4 i Google Tag Manager przez czat AI",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <ClerkProvider>
      <html lang="pl" className={`${poppins.variable} ${firaCode.variable} h-full`}>
        <body className="min-h-full flex flex-col antialiased">
          {children}
        </body>
      </html>
    </ClerkProvider>
  );
}
