import { describe, expect, test } from "bun:test";
import { fetchGif, fileNameFor, MAX_GIF_BYTES, mediaFromPage } from "./gif.ts";

const PAGE = `<html><head>
<meta class="dynamic" property="og:image" content="https://media1.example.com/m/abc/party-time.gif">
<meta class="dynamic" property="og:video" content="https://media.example.com/abc/party-time.mp4">
</head></html>`;

function fakeFetch(routes: Record<string, { status?: number; type?: string; body: string | Uint8Array; length?: number }>) {
  const asked: string[] = [];
  const fn = async (url: string) => {
    asked.push(url);
    const r = routes[url];
    if (!r) return { ok: false, status: 404, headers: { get: () => null }, text: async () => "", arrayBuffer: async () => new ArrayBuffer(0) };
    const bytes = typeof r.body === "string" ? new TextEncoder().encode(r.body) : r.body;
    const headers: Record<string, string> = {};
    if (r.type) headers["content-type"] = r.type;
    if (r.length !== undefined) headers["content-length"] = String(r.length);
    return {
      ok: (r.status ?? 200) < 400,
      status: r.status ?? 200,
      headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
      text: async () => (typeof r.body === "string" ? r.body : ""),
      arrayBuffer: async () => bytes.slice().buffer,
    };
  };
  return { fn, asked };
}

describe("gif", () => {
  test("a page link posts the GIF its og:image names", async () => {
    const { fn, asked } = fakeFetch({
      "https://gifs.example.com/view/party-time-gif-123": { type: "text/html", body: PAGE },
      "https://media1.example.com/m/abc/party-time.gif": { type: "image/gif", body: new Uint8Array([71, 73, 70]) },
    });
    const gif = await fetchGif("https://gifs.example.com/view/party-time-gif-123", fn as never);
    expect(gif.name).toBe("party-time.gif");
    expect([...gif.data]).toEqual([71, 73, 70]);
    expect(asked).toEqual(["https://gifs.example.com/view/party-time-gif-123", "https://media1.example.com/m/abc/party-time.gif"]);
  });

  test("a direct media link is downloaded as is", async () => {
    const { fn, asked } = fakeFetch({ "https://media.example.com/x/wave.gif": { type: "image/gif", body: new Uint8Array([1]) } });
    expect((await fetchGif("https://media.example.com/x/wave.gif", fn as never)).name).toBe("wave.gif");
    expect(asked).toEqual(["https://media.example.com/x/wave.gif"]);
  });

  test("refuses what isn't a postable GIF", async () => {
    const { fn } = fakeFetch({
      "https://gifs.example.com/empty": { type: "text/html", body: "<html></html>" },
      "https://media.example.com/big.gif": { type: "image/gif", body: new Uint8Array([1]), length: MAX_GIF_BYTES + 1 },
      "https://media.example.com/page.gif": { type: "text/html", body: "<html>" },
    });
    await expect(fetchGif("not a link", fn as never)).rejects.toThrow("as a link");
    await expect(fetchGif("http://media.example.com/a.gif", fn as never)).rejects.toThrow("https");
    await expect(fetchGif("https://gifs.example.com/empty", fn as never)).rejects.toThrow("no GIF");
    await expect(fetchGif("https://media.example.com/big.gif", fn as never)).rejects.toThrow("10 MB");
    await expect(fetchGif("https://media.example.com/page.gif", fn as never)).rejects.toThrow("not a GIF");
    await expect(fetchGif("https://media.example.com/missing.gif", fn as never)).rejects.toThrow("404");
  });

  test("reads og tags in either attribute order and names files sensibly", () => {
    expect(mediaFromPage(`<meta content="https://m.example.com/a.gif" property="og:image">`)).toBe("https://m.example.com/a.gif");
    expect(mediaFromPage(`<meta property="og:video" content="https://m.example.com/a.mp4">`)).toBe("https://m.example.com/a.mp4");
    expect(mediaFromPage("<html></html>")).toBeNull();
    expect(fileNameFor("https://m.example.com/x/wave.gif?x=1")).toBe("wave.gif");
    expect(fileNameFor("https://m.example.com/x/AAAA")).toBe("image.gif");
  });
});
