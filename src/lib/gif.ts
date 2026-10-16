/**
 * Turns a GIF link into a file to upload, so a post shows the GIF itself
 * instead of a pasted URL. Takes a Tenor or Giphy page (its og:image is the
 * GIF) or a direct .gif / .webp / .png / .mp4 URL.
 */
import { GatewayError } from "./errors.ts";

/** Discord's upload limit for a server without boosts. */
export const MAX_GIF_BYTES = 10 * 1024 * 1024;

export interface GifFile {
  name: string;
  data: Uint8Array;
}

type FetchLike = (url: string, init?: { headers?: Record<string, string> }) => Promise<{
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
  arrayBuffer(): Promise<ArrayBuffer>;
}>;

const MEDIA_EXT = /\.(gif|webp|png|jpe?g|mp4)$/i;
// Some hosts refuse requests without a browser user agent.
const HEADERS = { "user-agent": "Mozilla/5.0 (compatible; Tsukumo)" };

/** The direct media URL a page's og:image (or og:video) names; null when there is none. */
export function mediaFromPage(html: string): string | null {
  for (const property of ["og:image", "og:video", "og:video:secure_url"]) {
    const tag = html.match(new RegExp(`<meta[^>]*property=["']${property}["'][^>]*>`, "i"))?.[0];
    const content = tag?.match(/content=["']([^"']+)["']/i)?.[1];
    if (content && /^https:\/\//.test(content)) return content.replaceAll("&amp;", "&");
  }
  return null;
}

/** A file name from the media URL's last path segment, e.g. `boo-problem-solved.gif`. */
export function fileNameFor(mediaUrl: string): string {
  const last = new URL(mediaUrl).pathname.split("/").filter(Boolean).pop() ?? "";
  return MEDIA_EXT.test(last) ? last : "image.gif";
}

/** Fetches the GIF a link points at, ready to attach to a message. */
export async function fetchGif(link: string, fetchFn: FetchLike = fetch as unknown as FetchLike): Promise<GifFile> {
  let url: URL;
  try {
    url = new URL(link);
  } catch {
    throw new GatewayError("Give the GIF as a link (a Tenor or Giphy page, or a direct .gif URL).", 400);
  }
  if (url.protocol !== "https:") throw new GatewayError("The GIF link must be https.", 400);

  let mediaUrl = url.toString();
  if (!MEDIA_EXT.test(url.pathname)) {
    const page = await fetchFn(mediaUrl, { headers: HEADERS });
    if (!page.ok) throw new GatewayError(`Couldn't open the GIF page (${page.status}).`, 502);
    const found = mediaFromPage(await page.text());
    if (!found) throw new GatewayError("That page has no GIF to post (no og:image).", 400);
    mediaUrl = found;
  }

  const media = await fetchFn(mediaUrl, { headers: HEADERS });
  if (!media.ok) throw new GatewayError(`Couldn't download the GIF (${media.status}).`, 502);
  const type = media.headers.get("content-type") ?? "";
  if (type && !/^(image|video)\//i.test(type)) throw new GatewayError(`That link is ${type}, not a GIF.`, 400);
  const size = Number(media.headers.get("content-length") ?? 0);
  if (size > MAX_GIF_BYTES) throw new GatewayError("That GIF is over Discord's 10 MB upload limit.", 413);
  const data = new Uint8Array(await media.arrayBuffer());
  if (data.byteLength > MAX_GIF_BYTES) throw new GatewayError("That GIF is over Discord's 10 MB upload limit.", 413);
  return { name: fileNameFor(mediaUrl), data };
}
