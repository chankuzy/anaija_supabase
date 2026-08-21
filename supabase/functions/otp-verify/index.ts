/// <reference path="../_shared/deno-shim.d.ts" />

import { createClient } from "npm:@supabase/supabase-js@2";
import { corsHeaders } from "../_shared/cors.ts";
import { issueToken } from "../_shared/auth.ts";

const PHONE_REGEX = /^(\+?234|0)[789][01]\d{8}$/;
const CODE_REGEX = /^\d{6}$/;
const MAX_ATTEMPTS = 5;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const { phone, code, device } = await req.json();

    if (!phone || !PHONE_REGEX.test(phone)) return json({ message: "Invalid phone number." }, 422);
    if (!code || !CODE_REGEX.test(code)) return json({ message: "Invalid OTP code." }, 422);

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const { data: otp, error: otpError } = await supabase
      .from("otp_codes")
      .select("*")
      .eq("phone", phone)
      .eq("used", false)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (otpError) throw otpError;
    if (!otp) return json({ message: "Invalid or expired OTP." }, 422);
    if (otp.attempts >= MAX_ATTEMPTS) {
      return json({ message: "Too many incorrect attempts. Please request a new OTP." }, 429);
    }
    if (new Date(otp.expires_at) < new Date()) return json({ message: "Invalid or expired OTP." }, 422);

    if (otp.code !== code) {
      await supabase.from("otp_codes").update({ attempts: otp.attempts + 1 }).eq("id", otp.id);
      return json({ message: "Invalid or expired OTP." }, 422);
    }

    await supabase.from("otp_codes").update({ used: true }).eq("id", otp.id);

    let { data: user, error: userError } = await supabase
      .from("users").select("*").eq("phone", phone).maybeSingle();
    if (userError) throw userError;

    let isNewUser = false;

    if (!user) {
      isNewUser = true;
      const { data: created, error: createError } = await supabase
        .from("users")
        .insert({ phone, provider: "phone", is_verified: true, phone_verified_at: new Date().toISOString() })
        .select().single();
      if (createError) throw createError;
      user = created;
    } else {
      const { data: updated, error: updateError } = await supabase
        .from("users")
        .update({ is_verified: true, phone_verified_at: new Date().toISOString() })
        .eq("id", user.id).select().single();
      if (updateError) throw updateError;
      user = updated;
    }

    if (device?.device_hash) {
      await supabase.from("user_devices").upsert(
        {
          user_id: user.id,
          device_hash: device.device_hash,
          device_name: device.device_name ?? null,
          platform: device.platform ?? null,
          fcm_token: device.fcm_token ?? null,
          last_active_at: new Date().toISOString(),
        },
        { onConflict: "device_hash" },
      );
    }

    const token = await issueToken(supabase, user.id, device?.device_name ?? "mobile");

    return json({
      token,
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
    return json({ message: err instanceof Error ? err.message : "Something went wrong." }, 500);
  }
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
