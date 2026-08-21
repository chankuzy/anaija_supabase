const SENDCHAMP_BASE_URL = Deno.env.get("SENDCHAMP_BASE_URL")!;
const SENDCHAMP_SECRET_KEY = Deno.env.get("SENDCHAMP_SECRET_KEY")!;
const SENDCHAMP_SENDER_ID = Deno.env.get("SENDCHAMP_SENDER_ID") ?? "Anaija";

function normalizePhone(phone: string): string {
  let digits = phone.replace(/\D/g, "");
  if (digits.startsWith("0")) digits = "234" + digits.slice(1);
  if (!digits.startsWith("234")) digits = "234" + digits;
  return digits;
}

export async function sendOtp(phone: string, code: string): Promise<void> {
  const message = `Your Anaija verification code is: ${code}. Valid for 5 minutes. Do not share this code.`;

  const res = await fetch(`${SENDCHAMP_BASE_URL}/sms/send`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${SENDCHAMP_SECRET_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      to: normalizePhone(phone),
      message,
      sender_name: SENDCHAMP_SENDER_ID,
      route: "dnd",
    }),
  });

  if (!res.ok) {
    console.error("Sendchamp SMS failed", res.status, await res.text());
    throw new Error("Failed to send SMS. Please try again.");
  }
}