"use client";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { FileText, FolderUp, ImageIcon, Loader2, Paperclip, Plus, X } from "lucide-react";
import { iconButtonClass, Menu, MenuItem } from "@/components/studio/ui";
import {
  baseName,
  formatBytes,
  IMAGE_ACCEPT,
  inSkippedFolder,
  isImageType,
  isSecretName,
  isTextName,
  looksBinary,
  MAX_ATTACHMENTS,
  MAX_IMAGE_BYTES,
  MAX_IMAGE_SIDE,
  rejectReason,
  TEXT_ACCEPT,
  type AttachmentMeta,
} from "@/lib/code/attachments";
import { cn } from "@/lib/utils";

/** One attachment in the composer, from choosing it to its upload finishing (or failing). */
export interface DraftAttachment {
  key: string;
  name: string;
  kind: "text" | "image";
  size: number;
  status: "reading" | "uploading" | "ready" | "error";
  /** 0–1 while uploading. */
  progress: number;
  error?: string;
  /** The uploaded attachment, once the server has accepted it. */
  id?: string;
  /** A local thumbnail for images. */
  preview?: string;
}

let seq = 0;

/** Read and shrink an image in the browser: at most MAX_IMAGE_SIDE pixels on the long side, as PNG or JPEG. */
async function encodeImage(file: File): Promise<{ data: string; mediaType: "image/png" | "image/jpeg"; size: number }> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, MAX_IMAGE_SIDE / Math.max(bitmap.width, bitmap.height));
  const w = Math.max(1, Math.round(bitmap.width * scale));
  const h = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("This browser can't read images.");
  ctx.drawImage(bitmap, 0, 0, w, h);
  bitmap.close();
  const toBlob = (type: string, q?: number) => new Promise<Blob | null>((res) => canvas.toBlob(res, type, q));
  // Screenshots stay sharp as PNG when small enough; photos and big images become JPEG.
  let blob = file.type === "image/png" ? await toBlob("image/png") : null;
  if (!blob || blob.size > 1_200_000) blob = await toBlob("image/jpeg", 0.88);
  if (blob && blob.size > MAX_IMAGE_BYTES) blob = await toBlob("image/jpeg", 0.7);
  if (!blob) throw new Error("The image couldn't be read.");
  if (blob.size > MAX_IMAGE_BYTES) throw new Error(`Too large even after resizing (over ${MAX_IMAGE_BYTES / 1_000_000} MB).`);
  const data = await new Promise<string>((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(String(r.result).split(",")[1] ?? "");
    r.onerror = () => rej(new Error("The image couldn't be read."));
    r.readAsDataURL(blob);
  });
  return { data, mediaType: blob.type === "image/png" ? "image/png" : "image/jpeg", size: blob.size };
}

/** POST with upload progress (fetch can't report it). */
function upload(url: string, body: unknown, onProgress: (p: number) => void): Promise<AttachmentMeta> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", url);
    xhr.setRequestHeader("Content-Type", "application/json");
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
    xhr.onload = () => {
      let j: { attachment?: AttachmentMeta; error?: { message?: string } } = {};
      try {
        j = JSON.parse(xhr.responseText);
      } catch {}
      if (xhr.status >= 200 && xhr.status < 300 && j.attachment) resolve(j.attachment);
      else reject(new Error(j.error?.message ?? (xhr.status === 413 ? "Too large to upload." : `Upload failed (${xhr.status}).`)));
    };
    xhr.onerror = () => reject(new Error("Upload failed: check your connection."));
    xhr.send(JSON.stringify(body));
  });
}

/** Attachments for the next task: choosing, checking, reading, uploading and removing them. */
export function useAttachments(projectId: string) {
  const [items, setItems] = useState<DraftAttachment[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const live = useRef(items);
  useEffect(() => {
    live.current = items;
  }, [items]);
  // Thumbnails are freed when the composer goes away.
  useEffect(() => () => live.current.forEach((i) => i.preview && URL.revokeObjectURL(i.preview)), []);

  const patch = useCallback((key: string, p: Partial<DraftAttachment>) => setItems((list) => list.map((i) => (i.key === key ? { ...i, ...p } : i))), []);

  const addOne = useCallback(
    async (file: File, name: string) => {
      const key = `a${++seq}`;
      const image = isImageType(file.type);
      const reason = rejectReason({ name, type: file.type, size: file.size });
      const base: DraftAttachment = { key, name, kind: image ? "image" : "text", size: file.size, status: reason ? "error" : "reading", progress: 0, error: reason ?? undefined };
      if (image && !reason) base.preview = URL.createObjectURL(file);
      setItems((list) => [...list, base]);
      if (reason) return;
      try {
        let body: unknown;
        if (image) {
          const img = await encodeImage(file);
          body = { kind: "image", name, mediaType: img.mediaType, data: img.data };
          patch(key, { size: img.size, status: "uploading" });
        } else {
          const content = await file.text();
          if (looksBinary(content)) throw new Error("This isn't a text file.");
          body = { kind: "text", name, content };
          patch(key, { status: "uploading" });
        }
        const meta = await upload(`/api/code/projects/${projectId}/attachments`, body, (p) => patch(key, { progress: p }));
        // Removed while uploading: remove it on the server too.
        if (!live.current.some((i) => i.key === key)) {
          void fetch(`/api/code/projects/${projectId}/attachments/${meta.id}`, { method: "DELETE" });
          return;
        }
        patch(key, { status: "ready", id: meta.id, progress: 1, size: meta.size });
      } catch (e) {
        patch(key, { status: "error", error: (e as Error).message });
      }
    },
    [projectId, patch],
  );

  /** Add files (from the picker, a drop or a paste). Folders keep their paths and skip dependency folders, secrets and non-text files. */
  const add = useCallback(
    (files: File[], opts: { folder?: boolean } = {}) => {
      setNotice(null);
      let list = files.map((f) => ({ file: f, name: opts.folder ? f.webkitRelativePath || f.name : f.name || `pasted-image-${seq + 1}.png` }));
      if (opts.folder) {
        const all = list.length;
        list = list.filter(({ file, name }) => !inSkippedFolder(name) && !isSecretName(name) && (isTextName(name) || file.type.startsWith("text/")) && file.size <= 200_000);
        const room = MAX_ATTACHMENTS - live.current.filter((i) => i.status !== "error").length;
        if (list.length > room) {
          setNotice(`Added ${room} of ${list.length} text files from the folder (a task can have ${MAX_ATTACHMENTS}). For a whole project, import it from GitHub or start a project from it.`);
          list = list.slice(0, Math.max(0, room));
        } else if (list.length < all)
          setNotice(`Added ${list.length} text and source files from the folder; skipped ${all - list.length} (dependency and build folders, images, binaries, secrets, files over 200 KB).`);
        if (!list.length && all) setNotice("Nothing in that folder could be attached: only text and source files are added from folders.");
      } else {
        const room = MAX_ATTACHMENTS - live.current.filter((i) => i.status !== "error").length;
        if (list.length > room) {
          setNotice(`A task can have at most ${MAX_ATTACHMENTS} attachments.`);
          list = list.slice(0, Math.max(0, room));
        }
      }
      for (const { file, name } of list) void addOne(file, name);
    },
    [addOne],
  );

  const remove = useCallback(
    (key: string) => {
      const item = live.current.find((i) => i.key === key);
      if (!item) return;
      if (item.preview) URL.revokeObjectURL(item.preview);
      setItems((list) => list.filter((i) => i.key !== key));
      if (item.id) void fetch(`/api/code/projects/${projectId}/attachments/${item.id}`, { method: "DELETE" });
    },
    [projectId],
  );

  /** After the task starts: the attachments now belong to it, so they're only cleared here. */
  const reset = useCallback(() => {
    live.current.forEach((i) => i.preview && URL.revokeObjectURL(i.preview));
    setItems([]);
    setNotice(null);
  }, []);

  const busy = items.some((i) => i.status === "reading" || i.status === "uploading");
  const ids = items.filter((i) => i.status === "ready" && i.id).map((i) => i.id!);
  return { items, ids, busy, notice, add, remove, reset, dismissNotice: () => setNotice(null) };
}

export type Attachments = ReturnType<typeof useAttachments>;

/** The + button at the composer's bottom left: add files, images, or a folder. */
export function PlusMenu({ attachments, disabled }: { attachments: Attachments; disabled?: boolean }) {
  const files = useRef<HTMLInputElement>(null);
  const images = useRef<HTMLInputElement>(null);
  const folder = useRef<HTMLInputElement>(null);
  const pick = (e: React.ChangeEvent<HTMLInputElement>, opts?: { folder?: boolean }) => {
    attachments.add(Array.from(e.target.files ?? []), opts);
    e.target.value = "";
  };
  return (
    <>
      <Menu
        label="Add to the task"
        side="auto"
        width={240}
        disabled={disabled}
        buttonLabel="Add files, images or a folder"
        buttonTitle="Add files, images or a folder"
        buttonClassName={cn(iconButtonClass(), "h-9 w-9 border border-s-line")}
        button={<Plus />}
      >
        <MenuItem icon={<Paperclip />} hint="Source, text and config files" onClick={() => files.current?.click()}>
          Add files
        </MenuItem>
        <MenuItem icon={<ImageIcon />} hint="Screenshots, mockups, designs" onClick={() => images.current?.click()}>
          Add photos and images
        </MenuItem>
        <MenuItem icon={<FolderUp />} hint="Its text and source files" onClick={() => folder.current?.click()}>
          Upload folder
        </MenuItem>
      </Menu>
      <input ref={files} type="file" multiple hidden accept={TEXT_ACCEPT} onChange={(e) => pick(e)} data-testid="attach-files" />
      <input ref={images} type="file" multiple hidden accept={IMAGE_ACCEPT} onChange={(e) => pick(e)} data-testid="attach-images" />
      <input
        ref={(el) => {
          folder.current = el;
          // React doesn't know the folder attribute; set it on the element.
          if (el) el.setAttribute("webkitdirectory", "");
        }}
        type="file"
        multiple
        hidden
        onChange={(e) => pick(e, { folder: true })}
        data-testid="attach-folder"
      />
    </>
  );
}

/** Chosen attachments inside the composer: thumbnails for images, cards for files, each removable. */
export function AttachmentTray({ attachments }: { attachments: Attachments }) {
  const { items, notice } = attachments;
  if (!items.length && !notice) return null;
  return (
    <div className="px-1 pb-2">
      {items.length > 0 && (
        <ul className="flex flex-wrap gap-2" aria-label="Attachments">
          {items.map((a) => (
            <li
              key={a.key}
              className={cn(
                "relative flex max-w-[240px] items-center gap-2 overflow-hidden rounded-xl border p-1.5 pr-8 text-[12.5px]",
                a.status === "error" ? "border-s-danger/50 bg-s-danger/5" : "border-s-line bg-s-hover",
              )}
              title={a.error ?? a.name}
            >
              {a.kind === "image" && a.preview ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={a.preview} alt="" className="h-10 w-10 shrink-0 rounded-lg object-cover" />
              ) : (
                <span className="grid h-10 w-10 shrink-0 place-items-center rounded-lg bg-s-glass-strong text-s-ink-2">
                  {a.kind === "image" ? <ImageIcon className="h-4 w-4" aria-hidden /> : <FileText className="h-4 w-4" aria-hidden />}
                </span>
              )}
              <span className="min-w-0">
                <span className="block truncate font-medium text-s-ink">{baseName(a.name)}</span>
                <span className={cn("block truncate text-[11.5px]", a.status === "error" ? "text-s-danger" : "text-s-ink-3")}>
                  {a.status === "error"
                    ? a.error
                    : a.status === "reading"
                      ? "Reading…"
                      : a.status === "uploading"
                        ? `Uploading ${Math.round(a.progress * 100)}%`
                        : `${typeLabel(a)} · ${formatBytes(a.size)}`}
                </span>
              </span>
              {(a.status === "reading" || a.status === "uploading") && <Loader2 className="absolute right-8 h-3.5 w-3.5 animate-spin text-s-ink-3" aria-hidden />}
              {a.status === "uploading" && (
                <span className="absolute inset-x-0 bottom-0 h-0.5 bg-s-line" aria-hidden>
                  <span className="block h-full bg-s-ink-2 transition-[width]" style={{ width: `${Math.round(a.progress * 100)}%` }} />
                </span>
              )}
              <button
                type="button"
                onClick={() => attachments.remove(a.key)}
                aria-label={`Remove ${baseName(a.name)}`}
                className={cn(iconButtonClass("sm"), "absolute right-1 top-1/2 h-6 w-6 -translate-y-1/2")}
              >
                <X />
              </button>
            </li>
          ))}
        </ul>
      )}
      {notice && (
        <p role="status" className="mt-2 flex items-start gap-2 text-[12px] text-s-ink-3">
          <span className="flex-1">{notice}</span>
          <button type="button" onClick={attachments.dismissNotice} aria-label="Dismiss" className="shrink-0 hover:text-s-ink">
            <X className="h-3.5 w-3.5" />
          </button>
        </p>
      )}
    </div>
  );
}

function typeLabel(a: DraftAttachment): string {
  if (a.kind === "image") return "Image";
  const ext = baseName(a.name).includes(".") ? baseName(a.name).split(".").pop()!.toUpperCase() : "Text";
  return ext;
}

/** Drop files onto, or paste images into, a composer. */
export function dropAndPaste(attachments: Attachments, setDragging: (d: boolean) => void) {
  return {
    onDragOver: (e: React.DragEvent) => {
      if (e.dataTransfer.types.includes("Files")) {
        e.preventDefault();
        setDragging(true);
      }
    },
    onDragLeave: (e: React.DragEvent) => {
      if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragging(false);
    },
    onDrop: (e: React.DragEvent) => {
      if (!e.dataTransfer.files.length) return;
      e.preventDefault();
      setDragging(false);
      attachments.add(Array.from(e.dataTransfer.files));
    },
    onPaste: (e: React.ClipboardEvent) => {
      const files = Array.from(e.clipboardData.files).filter((f) => f.type.startsWith("image/"));
      if (!files.length) return;
      // Pasted screenshots become attachments; pasted text stays in the box.
      e.preventDefault();
      attachments.add(files.map((f, i) => (f.name && f.name !== "image.png" ? f : new File([f], `screenshot-${Date.now().toString(36)}${i ? `-${i}` : ""}.png`, { type: f.type }))));
    },
  };
}

export function Dragging({ show, children }: { show: boolean; children?: ReactNode }) {
  if (!show) return null;
  return (
    <div className="pointer-events-none absolute inset-0 z-10 grid place-items-center rounded-[24px] border-2 border-dashed border-s-line-strong bg-s-glass-strong text-[13px] font-medium text-s-ink-2">
      {children ?? "Drop files or images to attach"}
    </div>
  );
}
