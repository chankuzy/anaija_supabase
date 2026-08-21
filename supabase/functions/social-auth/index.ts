/// <reference path="../_shared/deno-shim.d.ts" />
import { createClient } from "npm:@supabase/supabase-js@2";
import { corsHeaders } from "../_shared/cors.ts";
import { issueToken } from "../_shared/auth.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const { provider, token } = await req.json();

    if (provider !== "google") {
      return json({ message: `Unsupported provider: ${provider}` }, 422);
    }
    if (!token || typeof token !== "string" || token.length < 10) {
      return json({ message: "Invalid token." }, 422);
    }

    const googleUser = await verifyGoogleToken(token);
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    let isNewUser = false;

    let { data: user, error } = await supabase
      .from("users")
      .select("*")
      .eq("provider", "google")
      .eq("provider_id", googleUser.provider_id)
      .maybeSingle();
    if (error) throw error;

    if (!user && googleUser.email) {
      const { data: byEmail, error: emailErr } = await supabase
        .from("users").select("*").eq("email", googleUser.email).maybeSingle();
      if (emailErr) throw emailErr;
      if (byEmail) {
        const { data: linked, error: linkErr } = await supabase
          .from("users")
          .update({ provider_id: googleUser.provider_id, is_verified: true })
          .eq("id", byEmail.id).select().single();
        if (linkErr) throw linkErr;
        user = linked;
      }
    }

    if (!user) {
      isNewUser = true;
      const { data: created, error: createErr } = await supabase
        .from("users")
        .insert({
          name: googleUser.name,
          email: googleUser.email,
          avatar: googleUser.avatar,
          provider: "google",
          provider_id: googleUser.provider_id,
          is_verified: true,
          email_verified_at: new Date().toISOString(),
        })
        .select().single();
      if (createErr) throw createErr;
      user = created;
    } else if (googleUser.avatar && !user.avatar_key) {
      const { data: updated, error: updErr } = await supabase
        .from("users").update({ avatar: googleUser.avatar }).eq("id", user.id).select().single();
      if (updErr) throw updErr;
      user = updated;
    }

    const authToken = await issueToken(supabase, user.id, "mobile");

    return json({
      token: authToken,
      is_new_user: isNewUser,
      user: {
        id: user.id, name: user.name, username: user.username, phone: user.phone,
        email: user.email, avatar: user.avatar, bio: user.bio, location: user.location,
        links: user.links, is_verified: user.is_verified, profile_completed: user.profile_completed,
        provider: user.provider, institution_id: user.institution_id, campus_verified: user.campus_verified,
      },
    });
  } catch (err) {
    console.error(err);
    const status = err instanceof Error && (err as any).status ? (err as any).status : 500;
    return json({ message: err instanceof Error ? err.message : "Something went wrong." }, status);
  }
});

async function verifyGoogleToken(idToken: string) {
  const res = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${idToken}`);
  if (!res.ok) {
    const e: any = new Error("Invalid Google token.");
    e.status = 401;
    throw e;
  }
  const data = await res.json();

  const clientId = Deno.env.get("GOOGLE_CLIENT_ID");
  if (clientId && data.aud !== clientId) {
    const e: any = new Error("Google token audience mismatch.");
    e.status = 401;
    throw e;
  }

  return {
    provider_id: data.sub as string,
    email: (data.email as string) ?? null,
    name: (data.name as string) ?? null,
    avatar: (data.picture as string) ?? null,
  };
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
