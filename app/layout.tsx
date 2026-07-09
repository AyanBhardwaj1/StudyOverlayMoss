import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Moss Meeting Copilot",
  description: "A compact live meeting transcript and Moss session search overlay.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
