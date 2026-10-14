// Server-side twin of lib/core/config/media_limits.dart. Override via env.
const num = (k: string, d: number) => {
  const v = Number(Deno.env.get(k));
  return Number.isFinite(v) && v > 0 ? v : d;
};

export const MEDIA_LIMITS = {
  maxVideoBytes: num("MAX_VIDEO_BYTES", 100 * 1024 * 1024),
  maxVideoSeconds: num("MAX_VIDEO_SECONDS", 180),
  // A story driven by attached sound never runs longer than this.
  maxStoryAudioSeconds: num("MAX_STORY_AUDIO_SECONDS", 30),
};
