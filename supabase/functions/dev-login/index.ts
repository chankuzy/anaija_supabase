/// <reference path="../_shared/deno-shim.d.ts" />
import bcrypt from "npm:bcryptjs@2.4.3";
import { serviceClient, issueToken } from "../_shared/auth.ts";
import { json, handleCors } from "../_shared/response.ts";

Deno.serve(async (req) => {
  const cors = handleCors(req);
  if (cors) return cors;

  try {
    const { email, password } = await req.json();

    if (!email || !password) {
      return json({ message: "Email and password are required." }, 422);
    }

    const supabase = serviceClient();

    const { data: user, error } = await supabase
      .from("users").select("*").eq("email", email).maybeSingle();

    if (error) throw error;
    if (!user || !user.password) {
      return json({ message: "Invalid credentials." }, 401);
    }

    const valid = await bcrypt.compare(password, user.password);
    if (!valid) {
      return json({ message: "Invalid credentials." }, 401);
    }

    const token = await issueToken(supabase, user.id, "dev-login");

    return json({
      token,
      user: {
        id: user.id, name: user.name, username: user.username, email: user.email,
        phone: user.phone, provider: user.provider,
      },
    });
  } catch (err) {
    console.error(err);
    return json({ message: "Something went wrong." }, 500);
  }
});