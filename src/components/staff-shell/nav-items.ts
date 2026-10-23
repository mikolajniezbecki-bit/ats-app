// Back-office navigation, in one place. The layout shows an item only when
// can(user, item.action) allows it; later tasks add their entries here.
import type { Action } from "@/server/policy/permissions";

export type NavItem = { href: string; labelKey: string; action: Action };

export const NAV_ITEMS: NavItem[] = [
  { href: "/dashboard", labelKey: "home", action: "staff.area" },
  { href: "/admin", labelKey: "administration", action: "admin.area" },
  { href: "/admin/settings", labelKey: "settings", action: "settings.manage" },
  { href: "/admin/master-data", labelKey: "masterData", action: "masterData.manage" },
  { href: "/admin/users", labelKey: "users", action: "users.manage" },
  { href: "/admin/templates", labelKey: "templates", action: "templates.manage" },
];
