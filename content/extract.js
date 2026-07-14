/**
 * Runs in the page's isolated world after Defuddle is injected.
 * Last expression value is returned to chrome.scripting.executeScript.
 */
(() => {
  function resolveDefuddle() {
    const candidates = [
      globalThis.Defuddle,
      typeof self !== "undefined" ? self.Defuddle : null,
      typeof window !== "undefined" ? window.Defuddle : null,
    ];
    for (const g of candidates) {
      if (!g) continue;
      if (typeof g === "function") return g;
      if (g && typeof g.default === "function") return g.default;
    }
    return null;
  }

  function isProbablyMarkdown(text) {
    if (!text || typeof text !== "string") return false;
    return (
      /^#{1,6}\s/m.test(text) ||
      /^\s*[-*+]\s/m.test(text) ||
      /\[.+?\]\(.+?\)/.test(text) ||
      /^```/m.test(text) ||
      !/<[a-z][\s\S]*>/i.test(text.slice(0, 500))
    );
  }

  try {
    const Defuddle = resolveDefuddle();
    if (!Defuddle) {
      return {
        ok: false,
        error: "Defuddle library failed to load",
      };
    }

    const url = location.href;
    const pageTitle = document.title || "";

    const parsed = new Defuddle(document, {
      markdown: true,
      url,
      useAsync: false, // fully local
    }).parse();

    let body =
      (parsed && (parsed.contentMarkdown || parsed.content)) || "";

    // Fallback: strip HTML to plain text if MD conversion did not apply
    if (body && !isProbablyMarkdown(body) && /<[a-z][\s\S]*>/i.test(body)) {
      const tmp = document.createElement("div");
      tmp.innerHTML = body;
      body = (tmp.innerText || tmp.textContent || "").trim();
    }

    body = (body || "").trim();

    const title = (parsed && parsed.title) || pageTitle || "Untitled";
    const author = (parsed && parsed.author) || "";
    const wordCount = (parsed && parsed.wordCount) || 0;
    const thin = !body || body.length < 40;

    // Escape ATX heading breakage if title has leading # or newlines
    const safeTitle = String(title).replace(/\s+/g, " ").trim() || "Untitled";

    const metaLines = [
      `# ${safeTitle}`,
      "",
      `> Source: ${url}`,
      `> Saved: ${new Date().toISOString()}`,
    ];
    if (author) metaLines.push(`> Author: ${author}`);
    metaLines.push("", "---", "");

    const warning = thin
      ? "_Note: Main content may not have been fully detected on this page._\n\n"
      : "";

    const markdown =
      metaLines.join("\n") +
      warning +
      (body || "_No content extracted._") +
      "\n";

    return {
      ok: true,
      markdown,
      title: safeTitle,
      url,
      wordCount,
      thin,
      charCount: markdown.length,
    };
  } catch (err) {
    return {
      ok: false,
      error: err && err.message ? err.message : String(err),
    };
  }
})();
