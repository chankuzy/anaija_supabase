import { prepareStructured } from "./contentKinds.ts";

const NOW = Date.UTC(2026, 9, 27, 12);
const must = (c: boolean, m: string) => { if (!c) throw new Error(m); };
const day = (n: number) => new Date(NOW + n * 86_400_000).toISOString();
const PDF = { type: "document", mime_type: "application/pdf", size_bytes: 1000 };

Deno.test("legacy requests (no content) are untouched", () => {
  must(prepareStructured({ subtype: "event" }, NOW) === null, "expected null");
});
Deno.test("unknown subtype with content is rejected", () => {
  const r = prepareStructured({ subtype: "nope", content: {} }, NOW);
  must(!!r && !r.ok && !!r.errors.subtype, "expected subtype error");
});
Deno.test("poll: valid, normalised, ids assigned", () => {
  const r = prepareStructured({ subtype: "poll", content: { question: "  Best  jollof? ", options: ["Party", " Smoky ", ""], multiple: true, closes_at: day(1) } }, NOW);
  must(!!r && r.ok, "expected ok");
  if (r && r.ok) {
    must(r.caption === "Best jollof?", "caption");
    const o = r.content.options as { id: number; text: string }[];
    must(o.length === 2 && o[1].id === 1 && o[1].text === "Smoky", "options");
    must(r.content.multiple === true, "multiple");
  }
});
Deno.test("poll: needs 2 distinct options, future expiry within 30 days, no media", () => {
  const bad = (content: Record<string, unknown>, key: string, media: unknown[] = []) => {
    const r = prepareStructured({ subtype: "poll", content, media: media as never }, NOW);
    must(!!r && !r.ok && key in r.errors, `expected ${key}`);
  };
  bad({ question: "Q", options: ["a"] }, "options");
  bad({ question: "Q", options: ["A", "a"] }, "options");
  bad({ question: "", options: ["a", "b"] }, "question");
  bad({ question: "Q", options: ["a", "b"], closes_at: day(-1) }, "closes_at");
  bad({ question: "Q", options: ["a", "b"], closes_at: day(31) }, "closes_at");
  bad({ question: "Q", options: ["a", "b"] }, "media", [PDF]);
});
Deno.test("document: needs exactly one allowed file within size", () => {
  const ok = prepareStructured({ subtype: "document", content: { title: "Notes", file: { name: "n.pdf" } }, media: [PDF] }, NOW);
  must(!!ok && ok.ok, "expected ok");
  const none = prepareStructured({ subtype: "document", content: { title: "Notes" }, media: [] }, NOW);
  must(!!none && !none.ok && !!none.errors.media, "expected media error");
  const exe = prepareStructured({ subtype: "document", content: { title: "x" }, media: [{ ...PDF, mime_type: "application/x-msdownload" }] }, NOW);
  must(!!exe && !exe.ok, "expected rejection");
  const big = prepareStructured({ subtype: "document", content: { title: "x" }, media: [{ ...PDF, size_bytes: 26 * 1024 * 1024 }] }, NOW);
  must(!!big && !big.ok, "expected size rejection");
});
Deno.test("article: blocks cleaned, read time computed, paragraph required", () => {
  const r = prepareStructured({ subtype: "article", content: { headline: "H", blocks: [{ type: "heading", text: "A" }, { type: "paragraph", text: "word ".repeat(450) }, { type: "list", items: ["x", " ", "y"] }, { type: "quote", text: "" }] } }, NOW);
  must(!!r && r.ok, "expected ok");
  if (r && r.ok) {
    must((r.content.blocks as unknown[]).length === 3, "empty quote dropped");
    must(r.content.read_minutes === 3, "read minutes");
  }
  const none = prepareStructured({ subtype: "article", content: { headline: "H", blocks: [{ type: "heading", text: "A" }] } }, NOW);
  must(!!none && !none.ok && !!none.errors.blocks, "expected paragraph error");
});
Deno.test("announcement: publisher required, attachments typed", () => {
  const r = prepareStructured({ subtype: "announcement", content: { title: "T", body: "B", publisher_id: 7, deadline_at: day(3) }, media: [{ type: "image" }, PDF] }, NOW);
  must(!!r && r.ok && r.publisherId === 7, "expected ok");
  const nop = prepareStructured({ subtype: "announcement", content: { title: "T", body: "B" } }, NOW);
  must(!!nop && !nop.ok && !!nop.errors.publisher, "expected publisher error");
  const vid = prepareStructured({ subtype: "announcement", content: { title: "T", body: "B", publisher_id: 1 }, media: [{ type: "video" }] }, NOW);
  must(!!vid && !vid.ok, "video rejected");
});
