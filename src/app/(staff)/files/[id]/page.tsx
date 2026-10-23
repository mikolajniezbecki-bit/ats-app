// Views one PDF inline (F5). The page and the viewer both go through the
// policy module; the viewer issues the signed link.
import { getTranslations } from "next-intl/server";
import { PdfViewer } from "@/components/pdf-viewer";
import { requirePermission } from "@/server/policy/guards";

export const dynamic = "force-dynamic";

export default async function FilePage({ params }: PageProps<"/files/[id]">) {
  const { id } = await params;
  const user = await requirePermission("file.view", undefined, `/files/${encodeURIComponent(id)}`);
  const t = await getTranslations("Files");

  return (
    <main className="flex flex-1 flex-col gap-4 p-8">
      <h1 className="text-2xl font-semibold">{t("title")}</h1>
      <PdfViewer fileId={id} user={user} />
    </main>
  );
}
