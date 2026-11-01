// Validation + normalisation for the structured post kinds. Pure: no I/O, no imports (unit-testable under Deno).
// A request is "structured" only when it carries a `content` object; everything else keeps the legacy path.
export const STRUCTURED_SUBTYPES = ["poll", "document", "article", "announcement"] as const;
export type StructuredSubtype = (typeof STRUCTURED_SUBTYPES)[number];

export const LIMITS = {
  question: 200, option: 80, minOptions: 2, maxOptions: 6, pollMaxDays: 30,
  docTitle: 120, docDescription: 500, docBytes: 25 * 1024 * 1024, fileName: 200,
  headline: 140, subtitle: 200, block: 5000, blocks: 200, bodyChars: 60000, listItems: 30,
  annTitle: 140, annBody: 3000, annMedia: 5,
} as const;

export const DOCUMENT_MIMES: readonly string[] = [
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-powerpoint",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "text/plain",
];

export interface MediaLike { type?: string; mime_type?: string; size_bytes?: number }
export interface StructuredInput { subtype?: unknown; content?: unknown; media?: MediaLike[] }
type Errors = Record<string, string>;
type Obj = Record<string, unknown>;
export type Prepared =
  | { ok: true; subtype: StructuredSubtype; caption: string; content: Obj; publisherId: number | null }
  | { ok: false; errors: Errors };

const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const fail = (errors: Errors): Prepared => ({ ok: false, errors });
const ok = (subtype: StructuredSubtype, caption: string, content: Obj, publisherId: number | null = null): Prepared =>
  ({ ok: true, subtype, caption, content, publisherId });

// deno-lint-ignore no-control-regex
const CTRL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;
function str(v: unknown, multiline = false): string {
  if (typeof v !== "string") return "";
  const s = v.replace(/\r\n?/g, "\n").replace(CTRL, "").trim();
  return multiline ? s.replace(/\n{3,}/g, "\n\n") : s.replace(/\s+/g, " ");
}
/** null = absent, undefined = present but invalid. */
function optDate(v: unknown): string | null | undefined {
  if (v === undefined || v === null || v === "") return null;
  if (typeof v !== "string") return undefined;
  const t = Date.parse(v);
  return Number.isFinite(t) ? new Date(t).toISOString() : undefined;
}
function checkDoc(m: MediaLike, e: Errors) {
  if (!m.mime_type || !DOCUMENT_MIMES.includes(m.mime_type)) e.media = "Unsupported document type.";
  else if (!m.size_bytes || m.size_bytes <= 0 || m.size_bytes > LIMITS.docBytes) e.media = "Documents can be up to 25 MB.";
}

function poll(c: Obj, media: MediaLike[], now: number): Prepared {
  const e: Errors = {};
  const question = str(c.question);
  if (!question) e.question = "Add a question.";
  else if (question.length > LIMITS.question) e.question = `Keep the question under ${LIMITS.question} characters.`;
  const options = (Array.isArray(c.options) ? c.options : []).map((o) => str(o)).filter(Boolean);
  if (options.length < LIMITS.minOptions || options.length > LIMITS.maxOptions) e.options = "A poll needs 2 to 6 options.";
  else if (options.some((o) => o.length > LIMITS.option)) e.options = `Keep each option under ${LIMITS.option} characters.`;
  else if (new Set(options.map((o) => o.toLowerCase())).size !== options.length) e.options = "Options must be different.";
  const closes = optDate(c.closes_at);
  if (closes === undefined) e.closes_at = "Invalid closing time.";
  else if (closes !== null) {
    const t = Date.parse(closes);
    if (t < now + 60_000) e.closes_at = "Closing time must be in the future.";
    else if (t > now + LIMITS.pollMaxDays * 86_400_000) e.closes_at = "Polls can stay open for up to 30 days.";
  }
  if (media.length) e.media = "Polls do not take attachments.";
  if (Object.keys(e).length) return fail(e);
  return ok("poll", question, {
    kind: "poll", question, options: options.map((text, id) => ({ id, text })), multiple: c.multiple === true, closes_at: closes,
  });
}

function documentKind(c: Obj, media: MediaLike[]): Prepared {
  const e: Errors = {};
  const title = str(c.title);
  const description = str(c.description, true);
  if (!title) e.title = "Add a title.";
  else if (title.length > LIMITS.docTitle) e.title = `Keep the title under ${LIMITS.docTitle} characters.`;
  if (description.length > LIMITS.docDescription) e.description = `Keep the description under ${LIMITS.docDescription} characters.`;
  const m = media[0];
  if (media.length !== 1 || m.type !== "document") e.media = "Attach one document.";
  else checkDoc(m, e);
  if (Object.keys(e).length) return fail(e);
  const name = (isObj(c.file) ? str(c.file.name) : "").slice(0, LIMITS.fileName) || "document";
  return ok("document", title, {
    kind: "document", title, description, file: { name, size: m.size_bytes, mime: m.mime_type },
  });
}

function blocks(raw: unknown, e: Errors): Obj[] | null {
  if (!Array.isArray(raw) || raw.length === 0) { e.blocks = "Write something first."; return null; }
  if (raw.length > LIMITS.blocks) { e.blocks = "This article is too long."; return null; }
  const out: Obj[] = [];
  let chars = 0;
  for (const b of raw) {
    if (!isObj(b)) continue;
    if (b.type === "list") {
      const items = (Array.isArray(b.items) ? b.items : []).map((i) => str(i)).filter(Boolean);
      if (items.length > LIMITS.listItems) { e.blocks = `Lists can have up to ${LIMITS.listItems} items.`; return null; }
      if (!items.length) continue;
      chars += items.join("").length;
      out.push({ type: "list", items });
    } else if (b.type === "heading" || b.type === "paragraph" || b.type === "quote") {
      const text = str(b.text, b.type !== "heading");
      if (!text) continue;
      if (text.length > LIMITS.block) { e.blocks = `A block can hold up to ${LIMITS.block} characters.`; return null; }
      chars += text.length;
      out.push({ type: b.type, text });
    } else { e.blocks = "Unsupported block type."; return null; }
  }
  if (!out.some((b) => b.type === "paragraph")) { e.blocks = "Write at least one paragraph."; return null; }
  if (chars > LIMITS.bodyChars) { e.blocks = "This article is too long."; return null; }
  return out;
}

function article(c: Obj, media: MediaLike[]): Prepared {
  const e: Errors = {};
  const headline = str(c.headline);
  const subtitle = str(c.subtitle);
  if (!headline) e.headline = "Add a headline.";
  else if (headline.length > LIMITS.headline) e.headline = `Keep the headline under ${LIMITS.headline} characters.`;
  if (subtitle.length > LIMITS.subtitle) e.subtitle = `Keep the subtitle under ${LIMITS.subtitle} characters.`;
  if (media.length > 1 || media.some((m) => m.type !== "image")) e.media = "A publication takes one cover image.";
  const body = blocks(c.blocks, e);
  if (Object.keys(e).length || !body) return fail(e);
  const words = body.map((b) => (b.type === "list" ? (b.items as string[]).join(" ") : String(b.text))).join(" ").split(/\s+/).filter(Boolean).length;
  return ok("article", headline, {
    kind: "article", headline, subtitle, blocks: body, read_minutes: Math.max(1, Math.ceil(words / 200)),
  });
}

function announcement(c: Obj, media: MediaLike[]): Prepared {
  const e: Errors = {};
  const title = str(c.title);
  const body = str(c.body, true);
  if (!title) e.title = "Add a title.";
  else if (title.length > LIMITS.annTitle) e.title = `Keep the title under ${LIMITS.annTitle} characters.`;
  if (!body) e.body = "Write the announcement.";
  else if (body.length > LIMITS.annBody) e.body = `Keep the announcement under ${LIMITS.annBody} characters.`;
  const eventAt = optDate(c.event_at);
  const deadlineAt = optDate(c.deadline_at);
  if (eventAt === undefined) e.event_at = "Invalid event date.";
  if (deadlineAt === undefined) e.deadline_at = "Invalid deadline.";
  const pid = Number(c.publisher_id);
  if (!Number.isInteger(pid) || pid <= 0) e.publisher = "Choose who is publishing.";
  const priority = c.priority === "important" ? "important" : "normal";
  const expiresAt = optDate(c.expires_at);
  if (expiresAt === undefined) e.expires_at = "Invalid expiry.";
  else if (expiresAt !== null && Date.parse(expiresAt) < Date.now() + 60_000) e.expires_at = "Expiry must be in the future.";
  if (media.length > LIMITS.annMedia) e.media = `Attach up to ${LIMITS.annMedia} files.`;
  else for (const m of media) {
    if (m.type === "document") checkDoc(m, e);
    else if (m.type !== "image") e.media = "Attachments must be images or documents.";
  }
  if (Object.keys(e).length) return fail(e);
  return ok("announcement", title, {
    kind: "announcement", title, body, event_at: eventAt, deadline_at: deadlineAt, publisher: null, priority, expires_at: expiresAt,
  }, pid);
}

/** null = not a structured request (legacy path). */
export function prepareStructured(input: StructuredInput, now = Date.now()): Prepared | null {
  const c = input.content;
  if (c === undefined || c === null) return null;
  if (!isObj(c)) return fail({ content: "Invalid content." });
  const sub = input.subtype;
  if (typeof sub !== "string" || !(STRUCTURED_SUBTYPES as readonly string[]).includes(sub)) {
    return fail({ subtype: "Unsupported content type." });
  }
  const media = Array.isArray(input.media) ? input.media : [];
  switch (sub as StructuredSubtype) {
    case "poll": return poll(c, media, now);
    case "document": return documentKind(c, media);
    case "article": return article(c, media);
    case "announcement": return announcement(c, media);
  }
}
