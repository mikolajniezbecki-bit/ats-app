"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

type Props = { items: { href: string; label: string }[]; label: string };

/** The items the layout already filtered with can(); marks the current one. */
export function StaffNav({ items, label }: Props) {
  const pathname = usePathname();

  return (
    <nav aria-label={label}>
      <ul className="flex gap-4">
        {items.map((item) => {
          const current = pathname === item.href || pathname.startsWith(`${item.href}/`);
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
