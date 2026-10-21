import type { Metadata } from "next";
import { NextIntlClientProvider } from "next-intl";
import { getLocale, getTranslations } from "next-intl/server";
import { getRequestId } from "@/server/request-id";
import "./globals.css";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("Home");
  return { title: t("title") };
}

export default async function RootLayout({ children }: LayoutProps<"/">) {
  const locale = await getLocale();
  // Read by error.tsx to show the request ID (M4). Reading headers makes every
  // route dynamic, which database routes are anyway (§3 rule 3).
  const requestId = await getRequestId();

  return (
    <html lang={locale} className="h-full antialiased">
      <body className="flex min-h-full flex-col" data-request-id={requestId}>
        <NextIntlClientProvider>{children}</NextIntlClientProvider>
      </body>
    </html>
  );
}
