// Server-side copy + destinations for the activity inbox. Items store structure
// (kind, counts, targets); text is rendered here so wording can change without a migration.

export type Noun = "post" | "reel" | "story" | "listing";
export interface Actor { id: number; name: string; username: string; avatar: string | null }
export interface PostInfo {
  id: number; type: string; noun: Noun; caption: string | null; thumb: string | null;
  ownerId: number; active: boolean; price: string | null; mediaCount: number;
}
export interface RenderCtx {
  meId: number; meUsername: string;
  actors: Map<number, Actor>; posts: Map<number, PostInfo>; owners: Map<number, string>;
  now: number;
}
export interface Rendered {
  title: string; preview: string | null; quote: boolean; destination: Record<string, unknown>;
  thumb: string | null; thumbCount: number; content: Record<string, unknown> | null; noun: Noun; key: string;
}

const short = (s: string, n = 18) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);
const nm = (a?: Actor) => (a ? short(a.name?.trim() || a.username || "Someone") : "Someone");
const people = (n: number) => (n === 1 ? "1 person" : `${n} people`);
const plural = (n: Noun) => (n === "reel" ? "reels" : n === "listing" ? "listings" : n === "story" ? "stories" : "posts");
const QUOTED = new Set(["comment", "reply", "mention", "story_reply"]);

function names(actors: Actor[], count: number): string {
  if (count <= 1) return nm(actors[0]);
  if (count === 2) return `${nm(actors[0])} and ${nm(actors[1])}`;
  const rest = count - 2;
  return `${nm(actors[0])}, ${nm(actors[1])} and ${rest} other${rest === 1 ? "" : "s"}`;
}

function targetNouns(item: any, ctx: RenderCtx): string {
  const set = new Set(((item.targets_preview ?? []) as number[])
    .map((id) => ctx.posts.get(id)?.noun).filter(Boolean) as Noun[]);
  return set.size === 1 ? plural([...set][0]) : "posts";
}

export function renderActivity(item: any, ctx: RenderCtx): Rendered {
  const actors = ((item.actors_preview ?? []) as number[])
    .map((id) => ctx.actors.get(id)).filter(Boolean) as Actor[];
  const count = Math.max(item.actor_count ?? 0, actors.length, 1);
  const targets = (item.targets_preview ?? []) as number[];
  // A like item may cover several posts; the most recent one drives thumbnail + single-target destination.
  const postId: number | null = item.kind === "like" && targets.length ? targets[0] : (item.content_id ?? null);
  const post = postId ? ctx.posts.get(postId) : undefined;
  const p = (item.last_payload ?? {}) as Record<string, any>;
  const noun: Noun = post?.noun ?? "post";
  const who = names(actors, count);
  const first = actors[0];
  const expired = !!item.expires_at && new Date(item.expires_at).getTime() < ctx.now;

  const postDest = (): Record<string, unknown> =>
    noun === "listing" ? { kind: "listing", post_id: postId } : { kind: "post", post_id: postId };
  const commentDest = (): Record<string, unknown> =>
    noun === "listing"
      ? { kind: "listing", post_id: postId }
      : { kind: "comment", post_id: postId, comment_id: item.last_comment_id };
  const profileDest = (): Record<string, unknown> =>
    first ? { kind: "profile", username: first.username } : { kind: "none" };
  const convDest = (): Record<string, unknown> => ({
    kind: "conversation", conversation_id: p.conversation_id,
    title: first ? nm(first) : "Conversation", username: first?.username,
    user_id: first?.id, avatar: first?.avatar,
  });

  let title = "";
  let preview: string | null = null;
  let dest: Record<string, unknown> = { kind: "none" };

  switch (item.kind) {
    case "like": {
      const tc = item.target_count ?? 1;
      if (count === 1 && tc > 1) {
        title = `${who} liked ${tc} of your ${targetNouns(item, ctx)}`;
        dest = { kind: "posts_list", item_id: item.id };
      } else {
        title = `${who} liked your ${noun}`; dest = postDest();
      }
      break;
    }
    case "repost":
      title = `${who} reposted your post`; dest = postDest(); break;
    case "story_like":
      if (expired) {
        title = `This story has expired. ${people(count)} liked it.`;
        dest = { kind: "story_summary", item_id: item.id };
      } else {
        title = `${who} liked your story`; dest = { kind: "story", post_id: item.content_id };
      }
      break;
    case "story_reply":
      preview = p.preview || null;
      if (expired) {
        title = `Your story has expired. ${people(count)} replied.`;
        dest = { kind: "story_summary", item_id: item.id };
      } else {
        title = `${who} replied to your story`;
        dest = count === 1 ? convDest() : { kind: "chats" };
      }
      break;
    case "comment": {
      const n = item.event_count ?? 1;
      title = count === 1 && n > 1
        ? `${who} commented ${n} times on your ${noun}`
        : `${who} commented on your ${noun}`;
      preview = p.preview || null; dest = commentDest(); break;
    }
    case "reply": {
      const owner = post && post.ownerId !== ctx.meId ? ctx.owners.get(post.ownerId) : null;
      title = `${who} replied to your comment${owner ? ` on ${short(owner)}'s ${noun}` : ""}`;
      preview = p.preview || null; dest = commentDest(); break;
    }
    case "mention":
      title = p.where === "comment" ? `${who} mentioned you in a comment` : `${who} mentioned you in a ${noun}`;
      preview = p.preview || null;
      dest = p.where === "comment" ? commentDest() : postDest(); break;
    case "follow":
      if (count > 1) {
        title = `${people(count)} followed you`;
        preview = `${who} are now following you.`;
        dest = { kind: "followers" };
      } else {
        title = `${who} started following you`; dest = profileDest();
      }
      break;
    case "follow_back":
      if (count > 1) {
        title = `${people(count)} followed you back`;
        preview = `${who} are now following you.`;
        dest = { kind: "followers" };
      } else {
        title = `${who} followed you back`; dest = profileDest();
      }
      break;
    case "inquiry":
      title = `${who} asked about your listing`;
      preview = (p.message && String(p.message).trim()) || (post?.price ? `₦${post.price}` : null);
      dest = p.conversation_id ? convDest() : postDest(); break;
    case "post_new":
      title = noun === "listing" ? `${who} posted a new listing` : `${who} shared a new ${noun}`;
      dest = postDest(); break;
    case "milestone":
      if (p.metric === "followers") {
        title = `You now have ${Number(p.n).toLocaleString()} followers`; dest = { kind: "followers" };
      } else {
        title = `Your ${noun} just passed ${Number(p.n).toLocaleString()} likes`; dest = postDest();
      }
      break;
    case "system":
      title = p.title || "Anaija"; preview = p.body || null; break;
    default:
      title = "New activity";
  }

  const storyGone = String(item.kind).startsWith("story") && expired;
  const quote = !!preview && (QUOTED.has(item.kind) || (item.kind === "inquiry" && !!String(p.message ?? "").trim()));
  const showThumb = !(storyGone || item.kind === "follow" || item.kind === "follow_back");
  const thumb = showThumb ? (post?.thumb ?? null) : null;
  // Where the thumbnail itself leads: the content, independent of the row's own destination.
  const content: Record<string, unknown> | null = !thumb || !postId ? null
    : noun === "story" ? { kind: "story", post_id: postId }
    : postDest();
  return {
    title, preview, quote, destination: dest, noun,
    thumb, thumbCount: thumb ? (post?.mediaCount ?? 1) : 0, content,
    key: `${item.kind}${count > 1 ? ".many" : ""}`,
  };
}
