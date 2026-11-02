import "./globals.css";
import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { themeToCssVars } from "@/lib/theme";
import { getThemeForRequest } from "@/lib/tenant";
import { learningLabel, tenantDisplayName } from "@/lib/tenant-label";

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export async function generateMetadata(): Promise<Metadata> {
  const theme = await getThemeForRequest();
  return {
    title: learningLabel(tenantDisplayName(theme), " — "),
    description: "Learning",
    icons: theme.favicon_url ? [{ rel: "icon", url: theme.favicon_url }] : undefined,
  };
}

export default async function RootLayout({ children }: { children: ReactNode }) {
  const theme = await getThemeForRequest();
  return (
    <html lang="en">
      <head>
        <style
          data-tenant-theme={theme.slug}
          dangerouslySetInnerHTML={{ __html: themeToCssVars(theme) }}
        />
      </head>
      <body>{children}</body>
    </html>
  );
}
