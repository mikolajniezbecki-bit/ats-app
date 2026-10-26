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
  { href: "/admin/outbox", labelKey: "outbox", action: "outbox.view" },
  { href: "/admin/jobs", labelKey: "jobs", action: "jobs.view" },
  { href: "/requisitions", labelKey: "requisitions", action: "requisition.read" },
  { href: "/approvals", labelKey: "approvals", action: "approval.decide" },
  // A4: Recruiters and Admins find pending items to reassign.
  { href: "/approvals?view=all", labelKey: "allApprovals", action: "approval.reassign" },
  // Every role can be an interview participant (I1, task 34 Q6); last, so
  // the other items keep their order.
  { href: "/interviews", labelKey: "myInterviews", action: "staff.area" },
];
