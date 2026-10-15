import { rebuildAddsContent } from "./session.ts";

// deno-lint-ignore no-explicit-any
const post = (id: number, k: "post" | "listing" = "post"): any => ({ t: "post", id, k, src: [], score: 0.5, stage: "seed", why: [] });
function expect(c: boolean, m: string) { if (!c) throw new Error(m); }

Deno.test("rebuild of only surplus listings adds no content", () => {
  expect(!rebuildAddsContent([post(1), post(2)], [post(9, "listing"), post(8, "listing")]), "listings only -> false");
});
Deno.test("rebuild of nothing adds no content", () => {
  expect(!rebuildAddsContent([post(1)], []), "empty -> false");
});
Deno.test("rebuild with a new post adds content", () => {
  expect(rebuildAddsContent([post(1)], [post(9, "listing"), post(5)]), "new post -> true");
});
Deno.test("a post already in the session is not new", () => {
  expect(!rebuildAddsContent([post(1), post(5)], [post(5)]), "already in session -> false");
});
Deno.test("legacy items without k count as posts", () => {
  // deno-lint-ignore no-explicit-any
  const legacy: any = { t: "post", id: 7, src: [], score: 0.3, stage: "seed", why: [] };
  expect(rebuildAddsContent([post(1)], [legacy]), "k undefined -> post -> true");
});
