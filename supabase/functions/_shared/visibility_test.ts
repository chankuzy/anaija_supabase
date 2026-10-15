import { normalizeVisibility } from "./visibility.ts";

function eq(a: unknown, b: unknown, msg: string) {
  if (a !== b) throw new Error(`${msg}: expected ${b}, got ${a}`);
}

Deno.test("visibility whitelist", () => {
  eq(normalizeVisibility("public"), "public", "public");
  eq(normalizeVisibility(" Followers "), "followers", "trim+case");
  eq(normalizeVisibility("campus"), "campus", "campus");
  eq(normalizeVisibility("institution"), "campus", "legacy alias");
  eq(normalizeVisibility("private"), "private", "private");
  eq(normalizeVisibility("friends"), null, "unknown rejected");
  eq(normalizeVisibility(""), null, "empty rejected");
  eq(normalizeVisibility(undefined), null, "undefined rejected");
  eq(normalizeVisibility(1), null, "non-string rejected");
});
