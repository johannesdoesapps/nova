import "server-only";
import { ApiError } from "@/lib/http";
import { isSecretName, looksBinary, MAX_ATTACHMENTS, MAX_IMAGE_BYTES, MAX_TEXT_BYTES, sniffImage, type AttachmentInput, type AttachmentMeta } from "./attachments";
import { dbError, type Authed } from "./server";

/** Task attachments in the database, with the user's own session (row-level security keeps them to the uploader). */

const META = "id, name, kind, media_type, size";
type Row = { id: string; name: string; kind: "text" | "image"; media_type: AttachmentMeta["mediaType"]; size: number; content?: string };
const toMeta = (r: Row): AttachmentMeta => ({ id: r.id, name: r.name, kind: r.kind, mediaType: r.media_type, size: r.size });

export interface Attachment extends AttachmentMeta {
  /** Text, or base64 for images. */
  content: string;
}

/** Checks the contents themselves, not the name or the browser's word: text must be text, images must be real PNG/JPEG within the limits. */
export function checkAttachment(input: AttachmentInput): { kind: "text" | "image"; mediaType: AttachmentMeta["mediaType"]; size: number; content: string } {
  if (isSecretName(input.name)) throw new ApiError("bad_request", "Files that look like they hold secrets (.env, keys) can't be attached.");
  if (input.kind === "text") {
    const size = Buffer.byteLength(input.content, "utf8");
    if (size > MAX_TEXT_BYTES) throw new ApiError("payload_too_large", `Text files can be at most ${Math.round(MAX_TEXT_BYTES / 1000)} KB.`);
    if (looksBinary(input.content)) throw new ApiError("bad_request", `${input.name} isn't a text file.`);
    return { kind: "text", mediaType: "text/plain", size, content: input.content };
  }
  const bytes = Buffer.from(input.data, "base64");
  if (bytes.length > MAX_IMAGE_BYTES) throw new ApiError("payload_too_large", `Images can be at most ${MAX_IMAGE_BYTES / 1_000_000} MB.`);
  const real = sniffImage(bytes);
  if (!real) throw new ApiError("bad_request", `${input.name} isn't a PNG or JPEG image.`);
  if (real !== input.mediaType) throw new ApiError("bad_request", `${input.name} isn't the image type it says it is.`);
  return { kind: "image", mediaType: real, size: bytes.length, content: bytes.toString("base64") };
}

export async function addAttachment(auth: Authed, projectId: string, input: AttachmentInput): Promise<AttachmentMeta> {
  const a = checkAttachment(input);
  // Uploads never used in a task are cleared after a day.
  await auth.supabase
    .from("code_agent_attachments")
    .delete()
    .is("run_id", null)
    .lt("created_at", new Date(Date.now() - 86_400_000).toISOString());
  const { data, error } = await auth.supabase
    .from("code_agent_attachments")
    .insert({ project_id: projectId, name: input.name, kind: a.kind, media_type: a.mediaType, size: a.size, content: a.content })
    .select(META)
    .single();
  if (error) throw dbError(error, "code.attachments.add");
  return toMeta(data as Row);
}

/** Remove an attachment that isn't part of a task yet. */
export async function removeAttachment(auth: Authed, projectId: string, id: string): Promise<void> {
  const { data, error } = await auth.supabase.from("code_agent_attachments").delete().eq("id", id).eq("project_id", projectId).is("run_id", null).select("id");
  if (error) throw dbError(error, "code.attachments.remove");
  if (!data?.length) throw new ApiError("not_found", "Attachment not found.");
}

/** Tie uploaded attachments to the task that uses them; every one must be the user's, on this project, and unused. */
export async function linkAttachments(auth: Authed, projectId: string, runId: string, ids: string[]): Promise<AttachmentMeta[]> {
  const unique = [...new Set(ids)];
  if (!unique.length) return [];
  if (unique.length > MAX_ATTACHMENTS) throw new ApiError("bad_request", `A task can have at most ${MAX_ATTACHMENTS} attachments.`);
  const { data, error } = await auth.supabase.from("code_agent_attachments").update({ run_id: runId }).in("id", unique).eq("project_id", projectId).is("run_id", null).select(META);
  if (error) throw dbError(error, "code.attachments.link");
  if ((data ?? []).length !== unique.length) throw new ApiError("bad_request", "Some attachments weren't found. They may have expired — add them again.");
  return (data as Row[]).map(toMeta);
}

/** Uploaded attachments not yet used, by id; all must exist (the user's, on this project). */
export async function pendingAttachments(auth: Authed, projectId: string, ids: string[]): Promise<AttachmentMeta[]> {
  const unique = [...new Set(ids)];
  const { data, error } = await auth.supabase.from("code_agent_attachments").select(META).in("id", unique).eq("project_id", projectId).is("run_id", null);
  if (error) throw dbError(error, "code.attachments.pending");
  if ((data ?? []).length !== unique.length) throw new ApiError("bad_request", "Some attachments weren't found. They may have expired — add them again.");
  return (data as Row[]).map(toMeta);
}

/** A task's attachments (with contents when the agent needs them). */
export async function runAttachments(auth: Authed, runId: string, withContent: true): Promise<Attachment[]>;
export async function runAttachments(auth: Authed, runId: string, withContent?: false): Promise<AttachmentMeta[]>;
export async function runAttachments(auth: Authed, runId: string, withContent = false): Promise<AttachmentMeta[] | Attachment[]> {
  const { data, error } = await auth.supabase
    .from("code_agent_attachments")
    .select(withContent ? `${META}, content` : META)
    .eq("run_id", runId)
    .order("created_at", { ascending: true });
  if (error) throw dbError(error, "code.attachments.list");
  return ((data ?? []) as unknown as Row[]).map((r) => (withContent ? { ...toMeta(r), content: r.content ?? "" } : toMeta(r)));
}
