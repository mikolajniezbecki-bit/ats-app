"use client";

// Rich-text editor for the requisition description (ats-project-scope.md §5.2):
// paragraphs, h2/h3, bold, italic, lists and links only, matching the server's
// allowlist, which sanitizes the HTML again on save.
import { EditorContent, useEditor, useEditorState } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { useTranslations } from "next-intl";

type Props = { id: string; labelId: string; describedBy?: string; initialHtml: string; onChange: (html: string) => void };

const SAFE_LINK = /^(https?:\/\/|mailto:)/i;

export function DescriptionEditor({ id, labelId, describedBy, initialHtml, onChange }: Props) {
  const t = useTranslations("Requisitions.editor");
  const editor = useEditor({
    immediatelyRender: false,
    extensions: [
      StarterKit.configure({
        heading: { levels: [2, 3] },
        blockquote: false,
        code: false,
        codeBlock: false,
        horizontalRule: false,
        strike: false,
        underline: false,
        link: { openOnClick: false, autolink: false, protocols: ["http", "https", "mailto"] },
      }),
    ],
    content: initialHtml,
    editorProps: {
      attributes: {
        id,
        role: "textbox",
        "aria-multiline": "true",
        "aria-labelledby": labelId,
        ...(describedBy ? { "aria-describedby": describedBy } : {}),
        class: "prose min-h-40 max-w-none rounded-b border px-3 py-2 focus:outline-2 focus:outline-black [&_h2]:text-xl [&_h2]:font-semibold [&_h3]:text-lg [&_h3]:font-semibold [&_ol]:list-decimal [&_ol]:pl-6 [&_ul]:list-disc [&_ul]:pl-6 [&_a]:underline",
      },
    },
    onUpdate: ({ editor: current }) => onChange(current.isEmpty ? "" : current.getHTML()),
  });
  const active = useEditorState({
    editor,
    selector: ({ editor: current }) => ({
      h2: current?.isActive("heading", { level: 2 }) ?? false,
      h3: current?.isActive("heading", { level: 3 }) ?? false,
      bold: current?.isActive("bold") ?? false,
      italic: current?.isActive("italic") ?? false,
      bulletList: current?.isActive("bulletList") ?? false,
      orderedList: current?.isActive("orderedList") ?? false,
      link: current?.isActive("link") ?? false,
    }),
  });

  function setLink() {
    if (!editor) return;
    const href = window.prompt(t("linkPrompt"), editor.getAttributes("link").href ?? "https://");
    if (href === null) return;
    if (href.trim() === "" || !SAFE_LINK.test(href.trim())) {
      editor.chain().focus().extendMarkRange("link").unsetLink().run();
      return;
    }
    editor.chain().focus().extendMarkRange("link").setLink({ href: href.trim() }).run();
  }

  const button = (label: string, pressed: boolean | undefined, run: () => void) => (
    <button
      type="button"
      aria-pressed={pressed ?? false}
      onClick={run}
      disabled={!editor}
      className="rounded border px-2 py-1 text-sm aria-pressed:bg-neutral-900 aria-pressed:text-white"
    >
      {label}
    </button>
  );

  return (
    <div>
      <div role="toolbar" aria-label={t("toolbar")} aria-controls={id} className="flex flex-wrap gap-1 rounded-t border border-b-0 bg-neutral-50 p-1">
        {button(t("paragraph"), false, () => editor?.chain().focus().setParagraph().run())}
        {button(t("heading2"), active?.h2, () => editor?.chain().focus().toggleHeading({ level: 2 }).run())}
        {button(t("heading3"), active?.h3, () => editor?.chain().focus().toggleHeading({ level: 3 }).run())}
        {button(t("bold"), active?.bold, () => editor?.chain().focus().toggleBold().run())}
        {button(t("italic"), active?.italic, () => editor?.chain().focus().toggleItalic().run())}
        {button(t("bulletList"), active?.bulletList, () => editor?.chain().focus().toggleBulletList().run())}
        {button(t("orderedList"), active?.orderedList, () => editor?.chain().focus().toggleOrderedList().run())}
        {button(t("link"), active?.link, setLink)}
        {button(t("unlink"), false, () => editor?.chain().focus().extendMarkRange("link").unsetLink().run())}
      </div>
      <EditorContent editor={editor} />
    </div>
  );
}
