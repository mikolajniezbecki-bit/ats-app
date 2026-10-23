// Back-office shell: every staff page requires a signed-in user and shows the
// navigation that user's role allows (V9; authorization stays in the policy
// module, the components only render).
import { getTranslations } from "next-intl/server";
import { NAV_ITEMS } from "@/components/staff-shell/nav-items";
import { SessionKeepAlive } from "@/components/staff-shell/session-keep-alive";
import { SignOutButton } from "@/components/staff-shell/sign-out-button";
import { StaffNav } from "@/components/staff-shell/staff-nav";
import { requireUser } from "@/server/policy/guards";
import { can } from "@/server/policy/permissions";

export const dynamic = "force-dynamic";

export default async function StaffLayout({ children }: LayoutProps<"/">) {
  const user = await requireUser();
  const t = await getTranslations("StaffShell");
  const roles = await getTranslations("Roles");
  const items = NAV_ITEMS.filter((item) => can(user, item.action)).map((item) => ({
    href: item.href,
    label: t(`nav.${item.labelKey}`),
  }));

  return (
    <>
      <header className="flex flex-wrap items-center gap-6 border-b px-8 py-3">
        <span className="font-semibold">{t("appName")}</span>
        <StaffNav items={items} label={t("navLabel")} />
        <div className="ml-auto flex items-center gap-4 text-sm">
          <span data-testid="header-user-name">{user.name}</span>
          <span data-testid="header-user-role">{roles(user.role)}</span>
          <SignOutButton />
        </div>
      </header>
      {children}
      <SessionKeepAlive />
    </>
  );
}
