// Reads an MP4's duration from its mvhd box using tiny Range requests, so the
// server can enforce duration limits without downloading the video.
const ascii = (b: Uint8Array, s: number, e: number) =>
  String.fromCharCode(...b.subarray(s, e));

async function readRange(url: string, start: number, length: number): Promise<Uint8Array | null> {
  let res: Response;
  try {
    res = await fetch(url, { headers: { Range: `bytes=${start}-${start + length - 1}` } });
  } catch {
    return null;
  }
  if (!res.ok || !res.body) {
    await res.body?.cancel();
    return null;
  }
  // Server ignored Range and is sending the whole object: don't download it.
  if (res.status === 200 && start > 0) {
    await res.body.cancel();
    return null;
  }
  const reader = res.body.getReader();
  const out = new Uint8Array(length);
  let got = 0;
  while (got < length) {
    const { done, value } = await reader.read();
    if (done || !value) break;
    const take = Math.min(value.length, length - got);
    out.set(value.subarray(0, take), got);
    got += take;
  }
  await reader.cancel().catch(() => {});
  return out.subarray(0, got);
}

async function durationFromMoov(url: string, moovStart: number, moovHeader: number, moovSize: number) {
  const buf = await readRange(url, moovStart, Math.min(moovSize, 1024));
  if (!buf) return null;
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let p = moovHeader;
  while (p + 8 <= buf.length) {
    const size = dv.getUint32(p);
    const type = ascii(buf, p + 4, p + 8);
    if (type === "mvhd") {
      let timescale: number;
      let duration: number;
      if (buf[p + 8] === 1) {
        if (p + 40 > buf.length) return null;
        timescale = dv.getUint32(p + 28);
        duration = Number(dv.getBigUint64(p + 32));
      } else {
        if (p + 28 > buf.length) return null;
        timescale = dv.getUint32(p + 20);
        duration = dv.getUint32(p + 24);
      }
      return timescale > 0 ? duration / timescale : null;
    }
    if (size < 8) return null;
    p += size;
  }
  return null;
}

export async function probeMp4DurationSeconds(url: string, contentLength: number): Promise<number | null> {
  let pos = 0;
  for (let hop = 0; hop < 16 && pos + 8 <= contentLength; hop++) {
    const head = await readRange(url, pos, 16);
    if (!head || head.length < 8) return null;
    const dv = new DataView(head.buffer, head.byteOffset, head.byteLength);
    let size = dv.getUint32(0);
    const type = ascii(head, 4, 8);
    let headerSize = 8;
    if (size === 1) {
      if (head.length < 16) return null;
      size = Number(dv.getBigUint64(8));
      headerSize = 16;
    } else if (size === 0) {
      size = contentLength - pos;
    }
    if (size < headerSize) return null;
    if (type === "moov") return await durationFromMoov(url, pos, headerSize, Math.min(size, contentLength - pos));
    pos += size;
  }
  return null;
}
