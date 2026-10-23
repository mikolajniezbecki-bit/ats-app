"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

type Props = { items: { href: string; label: string }[]; label: string };

const matches = (pathname: string, href: string) => pathname === href || pathname.startsWith(`${href}/`);

/**
 * The items the layout already filtered with can(); marks the current one,
 * the most specific match (on /admin/settings that is Settings, not Administration).
 */
export function StaffNav({ items, label }: Props) {
  const pathname = usePathname();
  const currentHref = items
    .filter((item) => matches(pathname, item.href))
    .sort((a, b) => b.href.length - a.href.length)[0]?.href;

  return (
    <nav aria-label={label}>
      <ul className="flex gap-4">
        {items.map((item) => {
          const current = item.href === currentHref;
          return (
            <li key={item.href}>
              <Link
                href={item.href}
                aria-current={current ? "page" : undefined}
                className="rounded px-2 py-1 underline-offset-4 hover:underline focus-visible:outline-2 aria-[current=page]:font-semibold"
              >
                {item.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
