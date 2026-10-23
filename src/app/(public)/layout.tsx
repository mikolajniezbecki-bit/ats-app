// Career portal layout (ats-project-scope.md §5.3, §8): public, no sign-in
// state, a skip link and a header linking back to the job board.
import { getTranslations } from "next-intl/server";
import Link from "next/link";

export default async function PublicLayout({ children }: { children: React.ReactNode }) {
  const t = await getTranslations("Careers");
  return (
    <div className="flex min-h-full flex-1 flex-col bg-white text-neutral-900">
      <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-10 focus:rounded focus:bg-white focus:px-4 focus:py-2 focus:underline">
        {t("skipToContent")}
      </a>
      <header className="border-b bg-neutral-50">
        <div className="mx-auto flex max-w-4xl flex-wrap items-center justify-between gap-4 px-4 py-4">
          <Link href="/jobs" className="text-lg font-semibold underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2">
            {t("appName")}
          </Link>
          <Link href="/jobs" className="underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2">
            {t("allJobs")}
          </Link>
        </div>
      </header>
      <main id="main" tabIndex={-1} className="mx-auto w-full max-w-4xl flex-1 px-4 py-8">
        {children}
      </main>
    </div>
  );
}
