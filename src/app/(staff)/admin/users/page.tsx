// Admin user management (ats-project-scope.md §5.1): list, create, change
// role or name, deactivate and reactivate. Changes go through
// /api/admin/users.
import { getTranslations } from "next-intl/server";
import Link from "next/link";
import { USER_ROLES } from "@/server/db/schema";
import { requirePermission } from "@/server/policy/guards";
import { listUsers } from "@/server/users";
import { CreateUserForm, UserRowActions } from "./user-forms";

export const dynamic = "force-dynamic";

const FILTERS = ["active", "inactive", "all"] as const;

export default async function UsersPage({ searchParams }: PageProps<"/admin/users">) {
  const admin = await requirePermission("users.manage", undefined, "/admin/users");
  const requested = (await searchParams).status;
  const status = FILTERS.find((filter) => filter === requested) ?? "active";
  const t = await getTranslations("AdminUsers");
  const roles = await getTranslations("Roles");
  const users = await listUsers(status);
  const roleOptions = USER_ROLES.map((role) => ({ value: role, label: roles(role) }));

  return (
    <main className="flex flex-1 flex-col gap-6 p-8">
      <h1 className="text-2xl font-semibold">{t("title")}</h1>
      <p className="text-sm text-muted-foreground">{t("description")}</p>
      <CreateUserForm roles={roleOptions} />
      <nav aria-label={t("filter.label")} className="flex gap-3 text-sm">
        <span>{t("filter.label")}:</span>
        {FILTERS.map((filter) => (
          <Link
            key={filter}
            href={filter === "active" ? "/admin/users" : `/admin/users?status=${filter}`}
            aria-current={filter === status ? "page" : undefined}
            className="underline aria-[current=page]:font-semibold aria-[current=page]:no-underline"
          >
            {t(`filter.${filter}`)}
          </Link>
        ))}
      </nav>
      {users.length === 0 ? (
        <p className="text-sm">{t("empty")}</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b">
                <th className="py-1 pr-4">{t("columns.email")}</th>
                <th className="py-1 pr-4">{t("columns.name")}</th>
                <th className="py-1 pr-4">{t("columns.role")}</th>
                <th className="py-1 pr-4">{t("columns.status")}</th>
                <th className="py-1">{t("columns.actions")}</th>
              </tr>
            </thead>
            <tbody>
              {users.map((user) => (
                <tr key={user.id} className="border-b align-top" data-testid={`user-${user.email}`}>
                  <td className="py-2 pr-4">{user.email}</td>
                  <td className="py-2 pr-4">
                    {user.name} {user.id === admin.id && <span className="text-neutral-700">{t("you")}</span>}
                  </td>
                  <td className="py-2 pr-4">{roles(user.role)}</td>
                  <td className="py-2 pr-4">{user.isActive ? t("active") : t("inactive")}</td>
                  <td className="py-2">
                    <UserRowActions user={{ id: user.id, name: user.name, role: user.role, isActive: user.isActive }} roles={roleOptions} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </main>
  );
}
