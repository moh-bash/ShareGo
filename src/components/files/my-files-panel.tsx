"use client";

/**
 * The user's own share list.
 *
 * This is the honest answer to "which files are you sharing?": exactly the ones
 * listed here. A browser cannot read the rest of your disk, and ShareGo does not
 * pretend otherwise — see the note in the README about the desktop companion
 * app that could.
 */

import { useRef } from "react";
import { Button } from "@/components/ui/button";
import { CategoryBadge } from "@/components/ui/glyphs";
import { FolderIcon, InfoIcon, PlusIcon, TrashIcon } from "@/components/ui/icons";
import { formatBytes, truncateMiddle } from "@/lib/utils/format";
import { useFileActions, useSharedFiles } from "@/hooks/use-share-go";
import { useMounted } from "@/hooks/use-mounted";

export function MyFilesPanel() {
  const files = useSharedFiles();
  const { addFiles, removeFile, clearFiles } = useFileActions();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);

  // `webkitdirectory` is not in the DOM spec yet but is supported by Chrome,
  // Edge, Firefox and Safari. Reading `HTMLInputElement.prototype` during the
  // server render would throw, and during hydration the result could differ, so
  // the folder button simply appears once the component is mounted.
  const mounted = useMounted();
  const supportsFolders =
    mounted && typeof HTMLInputElement !== "undefined"
      ? "webkitdirectory" in HTMLInputElement.prototype
      : false;

  const totalBytes = files.reduce((sum, file) => sum + file.size, 0);

  return (
    <section className="panel p-4 sm:p-5" aria-labelledby="my-files-heading">
      <header className="mb-3 flex items-baseline justify-between gap-3">
        <h2 id="my-files-heading" className="text-sm font-semibold text-ink">
          Files I am sharing
        </h2>
        {files.length > 0 ? (
          <button
            type="button"
            onClick={clearFiles}
            className="focus-ring rounded-md text-xs text-ink-faint transition-colors hover:text-negative"
          >
            Clear all
          </button>
        ) : null}
      </header>

      <div className="flex flex-wrap gap-2">
        <Button
          variant="primary"
          icon={<PlusIcon className="size-4.5" />}
          onClick={() => fileInputRef.current?.click()}
        >
          Add files
        </Button>
        {supportsFolders ? (
          <Button
            variant="secondary"
            icon={<FolderIcon className="size-4.5" />}
            onClick={() => folderInputRef.current?.click()}
          >
            Add folder
          </Button>
        ) : null}
      </div>

      {/* The inputs are always mounted; a click from a real gesture is what
          grants the page read access to the picked files. */}
      <input
        ref={fileInputRef}
        type="file"
        multiple
        className="sr-only"
        aria-label="Choose files to share"
        onChange={(event) => {
          addFiles(event.target.files);
          // Reset so picking the same file twice still fires `change`.
          event.target.value = "";
        }}
      />
      <input
        ref={folderInputRef}
        type="file"
        multiple
        className="sr-only"
        aria-label="Choose a folder to share"
        // Non-standard but widely supported; TS needs the escape hatch.
        {...{ webkitdirectory: "", directory: "" }}
        onChange={(event) => {
          addFiles(event.target.files);
          event.target.value = "";
        }}
      />

      <p className="mt-2.5 flex items-start gap-1.5 text-[11px] leading-relaxed text-ink-faint">
        <InfoIcon className="mt-px size-3.5 shrink-0" />
        <span>
          Only files you pick here are visible to a connected device. Your browser never
          gives a website access to the rest of your storage.
        </span>
      </p>

      {files.length === 0 ? (
        <p className="mt-4 rounded-xl border border-dashed border-hairline px-4 py-6 text-center text-sm text-ink-faint">
          Nothing shared yet. Add a photo, a video or a document to get started.
        </p>
      ) : (
        <>
          <p className="mt-4 text-xs text-ink-faint">
            {files.length} file{files.length === 1 ? "" : "s"} · {formatBytes(totalBytes)}
          </p>
          <ul className="scroll-area mt-2 max-h-72 space-y-1.5 overflow-y-auto pr-1">
            {files.map((file) => (
              <li
                key={file.fileId}
                className="group flex items-center gap-3 rounded-xl border border-hairline bg-surface-2/50 px-2.5 py-2"
              >
                <CategoryBadge category={file.category} className="size-9" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm text-ink" title={file.name}>
                    {file.name}
                  </p>
                  <p className="truncate text-[11px] text-ink-faint">
                    {formatBytes(file.size)}
                    {file.path ? ` · ${truncateMiddle(file.path, 34)}` : ""}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => removeFile(file.fileId)}
                  aria-label={`Stop sharing ${file.name}`}
                  className="focus-ring grid size-9 shrink-0 place-items-center rounded-lg text-ink-faint transition-colors hover:bg-negative/12 hover:text-negative"
                >
                  <TrashIcon className="size-4" />
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
