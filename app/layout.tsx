import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "DockFlow Delivery Scheduling",
  description: "End-to-end delivery scheduling, gate verification, and warehouse receiving.",
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
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
