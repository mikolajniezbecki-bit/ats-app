import { getRequestConfig } from "next-intl/server";

// Single locale, no i18n routing (tech-stack.md §1, tradeoffs.md TO-06).
export default getRequestConfig(async () => {
  const locale = "en";

  return {
    locale,
    messages: (await import(`../../messages/${locale}.json`)).default,
  };
});
