import { describe, expect, it } from "vitest";
import { decodeEntities, htmlToText, MAX_HTML_CHARS } from "./html.ts";

describe("htmlToText", () => {
  it("strips tags, turns block ends and <br> into newlines, and collapses whitespace", () => {
    // Source newlines between blocks survive as at most one blank line.
    expect(htmlToText("<div><p>Hi,</p><p>Line   one<br>Line two</p>\n\n\n<ul><li>a</li><li>b</li></ul></div>")).toBe("Hi,\nLine one\nLine two\n\na\nb");
    expect(htmlToText("<p>1 < 2 and 3 > 1</p>")).toBe("1 < 2 and 3 > 1");
    expect(htmlToText("<table><tr><td>cell 1</td><td>cell 2</td></tr></table>")).toBe("cell 1 cell 2");
    expect(htmlToText("<h1>Title</h1><p>Body</p>")).toBe("Title\nBody");
  });

  it("decodes entities only after tags are stripped, so escaped markup stays text", () => {
    // "&lt;b&gt;" is literal text in the mail; decoding it first would let the tag stripper eat it.
    expect(htmlToText("<p>Use &lt;b&gt; for bold &amp; &quot;quotes&quot;</p>")).toBe('Use <b> for bold & "quotes"');
    expect(htmlToText("<p>Total:&nbsp;&euro;4,800 &#8211; due &#x2026;</p>")).toBe("Total: €4,800 – due …");
  });

  it("drops script, style, head and title blocks with their attributes and contents", () => {
    expect(htmlToText('<html><head><title>Ignored</title><style type="text/css">p { color: red }</style></head><body><script type="text/javascript" defer>alert("x")</script><p>Kept</p></body></html>')).toBe("Kept");
    expect(htmlToText("<p>Before</p><!-- <p>hidden</p> --><SCRIPT>1 < 2 && 3 > 1</SCRIPT><p>After</p>")).toBe("Before\nAfter");
  });

  it("does not split a tag on a '>' inside a quoted attribute", () => {
    expect(htmlToText('<p><a href="https://example.com/?a=1&amp;b=2" title="x > y">link</a> text</p>')).toBe("link text");
    expect(htmlToText("<img alt='a > b' src=\"x.png\"><span data-x='1>0'>ok</span>")).toBe("ok");
  });

  it("strips attribute soup the grammar rejects instead of leaking or swallowing text", () => {
    // An apostrophe in an unquoted value used to make the tag unmatched (leaked verbatim).
    expect(htmlToText("<p class=don't>Hello</p>")).toBe("Hello");
    // …or, when a later quote matched, swallow everything in between.
    expect(htmlToText("<a href=http://x.com/it's>click</a> Hello, don't panic. <b>Bold</b> end")).toBe("click Hello, don't panic. Bold end");
    // An unterminated quote must not eat the following tags and their text.
    expect(htmlToText('<p>a</p><img alt="unterminated><p>visible?</p>')).toBe("a\nvisible?");
    // A '>' inside a properly quoted value still does not split the tag.
    expect(htmlToText('<a title="x > y">link</a>')).toBe("link");
  });

  it("stays linear on hostile bodies and bounds the markup it scans", () => {
    const start = Date.now();
    for (const soup of ["<a ", "<a '", "<script", "<a \""]) {
      const text = htmlToText(soup.repeat(1_000_000 / soup.length));
      expect(text.length).toBeLessThanOrEqual(MAX_HTML_CHARS);
    }
    expect(Date.now() - start).toBeLessThan(2_000);
  });

  it("returns an empty string for markup without text", () => {
    expect(htmlToText("<div><br><br></div>")).toBe("");
    expect(htmlToText("")).toBe("");
  });
});

describe("decodeEntities", () => {
  it("decodes named, decimal and hex entities and leaves unknown or invalid ones alone", () => {
    expect(decodeEntities("&amp;&lt;&gt;&quot;&apos;&nbsp;&copy;&mdash;")).toBe("&<>\"' ©—");
    expect(decodeEntities("&#65;&#x42;&#X43;")).toBe("ABC");
    expect(decodeEntities("&AMP;&Lt;")).toBe("&<");
    expect(decodeEntities("&bogus; &#0; &#x110000; &amp")).toBe("&bogus; &#0; &#x110000; &amp");
  });
});
