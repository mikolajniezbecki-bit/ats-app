// Admin master data page (ats-project-scope.md §5.1): one section per type,
// picklist values grouped by picklist key. Changes go through
// /api/admin/master-data.
import { getTranslations } from "next-intl/server";
import Link from "next/link";
import { MASTER_DATA_TYPES } from "@/server/db/schema";
import { type MasterDataRow, listMasterData } from "@/server/master-data";
import { requirePermission } from "@/server/policy/guards";
import { CreateMasterDataForm, MasterDataRowActions } from "./master-data-forms";

export const dynamic = "force-dynamic";

export default async function MasterDataPage({ searchParams }: PageProps<"/admin/master-data">) {
  await requirePermission("masterData.manage", undefined, "/admin/master-data");
  const includeInactive = (await searchParams).inactive === "1";
  const t = await getTranslations("AdminMasterData");
  const rows = await listMasterData({ includeInactive });

  return (
    <main className="flex flex-1 flex-col gap-6 p-8">
      <h1 className="text-2xl font-semibold">{t("title")}</h1>
      <p className="text-sm text-muted-foreground">{t("description")}</p>
      <Link href={includeInactive ? "/admin/master-data" : "/admin/master-data?inactive=1"} className="self-start text-sm underline">
        {includeInactive ? t("hideInactive") : t("showInactive")}
      </Link>
      <CreateMasterDataForm />
      {MASTER_DATA_TYPES.map((type) => {
        const ofType = rows.filter((row) => row.type === type);
        const groups =
          type === "PICKLIST"
            ? [...new Set(ofType.map((row) => row.picklistKey!))].map((key) => ({ key, rows: ofType.filter((row) => row.picklistKey === key) }))
            : [{ key: null, rows: ofType }];
        return (
          <section key={type} aria-labelledby={`section-${type}`} className="space-y-3">
            <h2 id={`section-${type}`} className="text-xl font-semibold">
              {t(`types.${type}`)}
            </h2>
            {ofType.length === 0 && <p className="text-sm">{t("empty")}</p>}
            {groups.map((group) => (
              <div key={group.key ?? type} className="space-y-1">
                {group.key && (
                  <h3 className="font-mono text-sm font-semibold">
                    {t("columns.picklistKey")}: {group.key}
                  </h3>
                )}
                <MasterDataTable rows={group.rows} labels={{ code: t("columns.code"), label: t("columns.label"), status: t("columns.status"), actions: t("columns.actions"), active: t("active"), inactive: t("inactive") }} />
              </div>
            ))}
          </section>
        );
      })}
    </main>
  );
}

type TableLabels = { code: string; label: string; status: string; actions: string; active: string; inactive: string };

function MasterDataTable({ rows, labels }: { rows: MasterDataRow[]; labels: TableLabels }) {
  if (rows.length === 0) return null;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-sm">
        <thead>
          <tr className="border-b">
            <th className="py-1 pr-4">{labels.code}</th>
            <th className="py-1 pr-4">{labels.label}</th>
            <th className="py-1 pr-4">{labels.status}</th>
            <th className="py-1">{labels.actions}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id} className="border-b align-top" data-testid={`master-data-${row.code}`}>
              <td className="py-2 pr-4 font-mono">{row.code}</td>
              <td className="py-2 pr-4">{row.label}</td>
              <td className="py-2 pr-4">{row.isActive ? labels.active : labels.inactive}</td>
              <td className="py-2">
                <MasterDataRowActions id={row.id} label={row.label} isActive={row.isActive} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
