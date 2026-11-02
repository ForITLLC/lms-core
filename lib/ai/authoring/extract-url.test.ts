import { test } from "node:test";
import assert from "node:assert/strict";
import { fakeWeb, type FakePage } from "@/lib/fixtures/fake-web";
import { checkPageUrl, decodeEntities, extractUrl, htmlToText, type UrlSourceDeps } from "./extract-url";
import { SOURCE_TEXT_MAX, SourceRefusedError, SourceUnavailableError, type SourceExtract } from "./source";

// A public web page as a course source (docs/plans/2026-10-29-ai-authoring.md,
// slice A3): HTML to text with no parser package, and the fetch's refusals as
// the job reads them.

const PAGE = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Wake turbulence &amp; separation &#8211; a primer</title>
  <style>body { color: red; } p > a { content: "</p>"; }</style>
  <script>var x = "<p>not text</p>"; if (a < b && c > d) {}</script>
  <link rel="stylesheet" href="/s.css">
</head>
<body>
  <!-- a comment <p>hidden</p> -->
  <nav><ul><li><a href="/">Home</a></li><li><a href="/wake">Wake</a></li></ul></nav>
  <main>
    <h1>Wake   turbulence</h1>
    <p>Vortices trail from the <b>wingtips</b> of every aircraft&nbsp;in flight.<br>They sink at 300&ndash;500&nbsp;ft/min.</p>
    <SCRIPT type="text/javascript">document.write("<h2>nope</h2>")</SCRIPT>
    <noscript><p>Turn on JavaScript</p></noscript>
    <svg viewBox="0 0 10 10"><text>diagram label</text></svg>
    <svg class="icon"/>
    <p>Heavy &gt; medium &gt; light; 5 &lt; 6 &amp;&amp; &quot;quoted&quot; &#39;single&#39; &#x2014; &copy; &eacute;t&eacute; &unknown; &amp</p>
    <table><tr><th>Leader</th><th>Follower</th><td>Minutes</td></tr><tr><td>Heavy</td><td>Light</td><td>3</td></tr></table>
    <p data-note="a > b">Price: &#128; 5 &#150; and a < sign</p>
    <template><p>template text</p></template>
    <pre>  line one
line two</pre>
  </main>
  <footer>&copy; 2026 aviation.example</footer>
</body>
</html>`;

const EXPECTED = [
  "Home",
  "Wake",
  "Wake turbulence",
  "Vortices trail from the wingtips of every aircraft in flight.",
  "They sink at 300–500 ft/min.",
  "Heavy > medium > light; 5 < 6 && \"quoted\" 'single' — © été &unknown; &amp",
  "Leader Follower Minutes",
  "Heavy Light 3",
  "Price: € 5 – and a < sign",
  "line one",
  "line two",
  "© 2026 aviation.example",
].join("\n");

test("HTML becomes plain text: script, style, noscript, svg, template and head dropped, blocks on their own lines, entities decoded", () => {
  const read = htmlToText(PAGE);
  assert.equal(read.title, "Wake turbulence & separation – a primer");
  assert.equal(read.text, EXPECTED);
  for (const hidden of ["color: red", "not text", "nope", "Turn on JavaScript", "diagram label", "template text", "hidden", "s.css"]) {
    assert.ok(!read.text.includes(hidden), hidden);
  }
});

test("markup that never closes ends the text where a browser would, and stray angle brackets are kept as text", () => {
  assert.deepEqual(htmlToText("<p>before</p><script>alert(1)"), { title: "", text: "before" });
  assert.deepEqual(htmlToText("<p>before</p><!-- never closed <p>after</p>"), { title: "", text: "before" });
  assert.deepEqual(htmlToText("<p>a <b class=\"x>y\">bold</b> c</p><p>d"), { title: "", text: "a bold c\nd" });
  assert.deepEqual(htmlToText("1 < 2 and 3 <4> 5 <"), { title: "", text: "1 < 2 and 3 <4> 5 <" });
  assert.deepEqual(htmlToText("<title>T</title><p>x</p><title>second</title>"), { title: "T", text: "x" });
  assert.deepEqual(htmlToText("<scripty>kept</scripty><p>y</p>"), { title: "", text: "kept\ny" });
  assert.deepEqual(htmlToText("text with no tags at all"), { title: "", text: "text with no tags at all" });
});

test("entities: named, decimal and hex, the Windows-1252 range as browsers read it, and out-of-range codes as U+FFFD", () => {
  assert.equal(decodeEntities("&lt;&gt;&amp;&quot;&apos;&nbsp;&mdash;&hellip;&euro;&alpha;&Omega;&sigmaf;"), "<>&\"' —…€αΩς");
  assert.equal(decodeEntities("&#65;&#x42;&#X43;&#97&#x62"), "ABCab");
  assert.equal(decodeEntities("&#147;quoted&#148; &#153;"), "“quoted” ™");
  assert.equal(decodeEntities("&#0;&#xD800;&#1114112;"), "���");
  assert.equal(decodeEntities("&nosuch; & &; &#; AT&T"), "&nosuch; & &; &#; AT&T");
});

const HTML = { "content-type": "text/html; charset=utf-8" };
const DNS = { "aviation.example": ["93.184.215.14"], "www.aviation.example": ["93.184.215.14"], "intranet.example": ["10.0.0.7"] };

function site(pages: Record<string, FakePage>) {
  const web = fakeWeb(DNS, pages);
  const videos: string[] = [];
  const deps: UrlSourceDeps = {
    fetch: { resolve: web.resolve, transport: web.transport, timeoutMs: 50 },
    youtube: async (url) => {
      videos.push(url);
      return { kind: "youtube", title: "Video", author: "A", url, text: "t", approxMinutes: 1, videoId: "abc123", thumbnailUrl: "", transcriptSource: "yt-dlp" };
    },
  };
  return { web, videos, read: (address: string) => extractUrl(address, deps) };
}

test("a page is read into a url extract named by its title and site, at the address the redirects ended on", async () => {
  const s = site({
    "https://aviation.example/old": { status: 301, headers: { location: "https://www.aviation.example/wake" } },
    "https://www.aviation.example/wake": { headers: HTML, body: PAGE },
  });
  const extract = await s.read("https://aviation.example/old#section");
  assert.deepEqual(extract, {
    kind: "url",
    title: "Wake turbulence & separation – a primer",
    author: "aviation.example",
    url: "https://www.aviation.example/wake",
    text: EXPECTED,
    approxMinutes: 1,
  } satisfies SourceExtract);
});

test("a text/plain page keeps its lines; with no title the site and path name it", async () => {
  const s = site({ "https://aviation.example/notes.txt": { headers: { "content-type": "text/plain" }, body: "Chock the wheels.\r\n\r\n  Check   the tow bar.  \r\n" } });
  const extract = await s.read("https://aviation.example/notes.txt");
  assert.deepEqual([extract.title, extract.text], ["aviation.example/notes.txt", "Chock the wheels.\nCheck the tow bar."]);
  const root = site({ "https://aviation.example/": { headers: HTML, body: "<p>Only text</p>" } });
  assert.equal((await root.read("https://aviation.example/")).title, "aviation.example");
});

test("the charset comes from the Content-Type, else from a meta tag, else UTF-8", async () => {
  const latin1 = Buffer.from("<p>caf\xe9 \x96 cr\xe8me</p>", "latin1");
  const declared = site({ "https://aviation.example/": { headers: { "content-type": "text/html; charset=windows-1252" }, body: latin1 } });
  assert.equal((await declared.read("https://aviation.example/")).text, "café – crème");
  const meta = site({ "https://aviation.example/": { headers: { "content-type": "text/html" }, body: Buffer.concat([Buffer.from('<meta charset="iso-8859-1">'), latin1]) } });
  // Browsers read ISO-8859-1 as Windows-1252, and so does decodeText.
  assert.equal((await meta.read("https://aviation.example/")).text, "café – crème");
  const utf8 = site({ "https://aviation.example/": { headers: { "content-type": "text/html" }, body: "<p>café</p>" } });
  assert.equal((await utf8.read("https://aviation.example/")).text, "café");
});

test("a YouTube address goes to the YouTube source and is never fetched as a page", async () => {
  const s = site({});
  for (const url of ["https://www.youtube.com/watch?v=abc123", " https://youtu.be/abc123 ", "https://m.youtube.com/shorts/abc123"]) {
    assert.equal((await s.read(url)).kind, "youtube");
  }
  assert.deepEqual(s.videos, ["https://www.youtube.com/watch?v=abc123", "https://youtu.be/abc123", "https://m.youtube.com/shorts/abc123"]);
  assert.deepEqual([s.web.lookups, s.web.connections], [[], []]);
});

test("a page whose text runs over 200,000 characters is refused, and so is one with no text; exactly the cap is read", async () => {
  const over = site({ "https://aviation.example/": { headers: HTML, body: `<p>${"a ".repeat(SOURCE_TEXT_MAX / 2 + 1)}</p>` } });
  await assert.rejects(over.read("https://aviation.example/"), (err: unknown) => err instanceof SourceRefusedError
    && err.message === "The page's text is 200,001 characters; the most is 200,000. Paste the part the course needs instead.");
  const full = site({ "https://aviation.example/": { headers: { "content-type": "text/plain" }, body: "a".repeat(SOURCE_TEXT_MAX) } });
  assert.equal((await full.read("https://aviation.example/")).text.length, SOURCE_TEXT_MAX);
  const empty = site({ "https://aviation.example/": { headers: HTML, body: "<html><head><title>Only a title</title><script>x()</script></head><body> </body></html>" } });
  await assert.rejects(empty.read("https://aviation.example/"), (err: unknown) => err instanceof SourceRefusedError && err.message === "The page has no readable text.");
});

test("the fetch's refusals reach the job as a refused source, and its transient failures as an unavailable one", async () => {
  const blocked = site({});
  await assert.rejects(blocked.read("https://intranet.example/"), (err: unknown) => err instanceof SourceRefusedError && /resolves to a private address/.test(err.message));
  assert.deepEqual(blocked.web.connections, []);
  const busy = site({ "https://aviation.example/": { status: 429, headers: { "retry-after": "30" } } });
  await assert.rejects(busy.read("https://aviation.example/"), (err: unknown) => err instanceof SourceUnavailableError && err.retryAfterMs === 30_000);
  const hung = site({ "https://aviation.example/": { hang: true } });
  await assert.rejects(hung.read("https://aviation.example/"), (err: unknown) => err instanceof SourceUnavailableError && /didn't answer/.test(err.message));
  const json = site({ "https://aviation.example/": { headers: { "content-type": "application/json" }, body: "{}" } });
  await assert.rejects(json.read("https://aviation.example/"), (err: unknown) => err instanceof SourceRefusedError && /application\/json/.test(err.message));
});

test("checkPageUrl gives the address the job will fetch, or refuses what the address alone gives away", () => {
  assert.equal(checkPageUrl(" https://aviation.example:443/wake?x=1#top "), "https://aviation.example/wake?x=1");
  for (const [address, message] of [
    ["http://127.0.0.1/", /a loopback address/],
    ["http://[::ffff:a9fe:a9fe]/", /a cloud metadata address/],
    ["file:///etc/passwd", /Only http and https/],
    ["https://aviation.example:8443/", /Only ports 80 and 443/],
    [`https://aviation.example/${"a".repeat(2030)}`, /^The web address is 2,05\d characters; the most is 2,048\.$/],
    ["nonsense", /not a valid web address/],
  ] as const) {
    assert.throws(() => checkPageUrl(address), (err: unknown) => err instanceof SourceRefusedError && message.test(err.message), address);
  }
  // Under the cap as typed, over it once the path is percent-encoded.
  assert.throws(() => checkPageUrl(`https://aviation.example/${"é".repeat(700)}`), /The web address is 4,2\d\d characters; the most is 2,048\./);
});
