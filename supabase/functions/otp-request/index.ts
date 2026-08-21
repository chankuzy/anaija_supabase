import { createClient } from "npm:@supabase/supabase-js@2";
import { corsHeaders } from "../_shared/cors.ts";
import { sendOtp } from "../_shared/sendchamp.ts";

const PHONE_REGEX = /^(\+?234|0)[789][01]\d{8}$/;
const OTP_TTL_SECONDS = 300;
const RATE_LIMIT = 5;
const RATE_WINDOW_MS = 60_000;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const { phone } = await req.json();

    if (!phone || !PHONE_REGEX.test(phone)) {
      return json({ message: "Please enter a valid Nigerian phone number." }, 422);
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const windowStart = new Date(Date.now() - RATE_WINDOW_MS).toISOString();
    const { count, error: countError } = await supabase
      .from("otp_codes")
      .select("*", { count: "exact", head: true })
      .eq("phone", phone)
      .gte("created_at", windowStart);

    if (countError) throw countError;
    if ((count ?? 0) >= RATE_LIMIT) {
      return json({ message: "Too many OTP requests. Try again shortly." }, 429);
    }

    const code = String(Math.floor(Math.random() * 1_000_000)).padStart(6, "0");
    const expiresAt = new Date(Date.now() + OTP_TTL_SECONDS * 1000).toISOString();
    const ip = req.headers.get("x-forwarded-for") ?? "unknown";

    const { error: insertError } = await supabase
      .from("otp_codes")
      .insert({ phone, code, expires_at: expiresAt, ip_address: ip });

    if (insertError) throw insertError;

    await sendOtp(phone, code);

    return json({ message: "OTP sent successfully.", expires_in: OTP_TTL_SECONDS });
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