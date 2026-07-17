/**
 * Runs in the page's isolated world after Defuddle is injected.
 * Last expression value is returned to chrome.scripting.executeScript.
 *
 * Modes:
 * 1) scroll-accumulate — for virtualized store grids (e.g. ManyVids Videos)
 * 2) full-page — DOM walk of the current body (default for other pages)
 *
 * Async IIFE: Chrome awaits the returned Promise from executeScript.
 */
(async () => {
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

  function absUrl(href) {
    if (!href) return "";
    try {
      return new URL(href, location.href).href;
    } catch {
      return href;
    }
  }

  function collapseBlankLines(text) {
    return String(text || "")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function betterTitle(a, b) {
    const as = (a || "").trim();
    const bs = (b || "").trim();
    if (!as) return bs;
    if (!bs) return as;
    // Prefer human titles over slug / duration-only
    const aDur = /^\d{1,2}:\d{2}\b/.test(as);
    const bDur = /^\d{1,2}:\d{2}\b/.test(bs);
    if (aDur && !bDur) return bs;
    if (bDur && !aDur) return as;
    return as.length >= bs.length ? as : bs;
  }

  function slugToTitle(slug) {
    if (!slug) return "";
    return decodeURIComponent(slug)
      .replace(/[-_]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  // ─── Full-page HTML → Markdown (non-virtualized pages) ─────────────

  const STRIP_SELECTOR = [
    "script",
    "style",
    "noscript",
    "template",
    "svg",
    "canvas",
    "link",
    "meta",
    "iframe",
    "object",
    "embed",
    "portal",
  ].join(",");

  function prepareFullPageRoot() {
    const source = document.body;
    if (!source) return null;

    const clone = source.cloneNode(true);

    function flattenShadows(liveRoot, cloneRoot) {
      const liveEls = liveRoot.querySelectorAll("*");
      const cloneEls = cloneRoot.querySelectorAll("*");
      const n = Math.min(liveEls.length, cloneEls.length);
      for (let i = 0; i < n; i++) {
        const live = liveEls[i];
        const cl = cloneEls[i];
        if (!live.shadowRoot) continue;
        try {
          const frag = document.createDocumentFragment();
          for (const child of live.shadowRoot.childNodes) {
            frag.appendChild(child.cloneNode(true));
          }
          cl.appendChild(frag);
        } catch {
          /* ignore */
        }
      }
    }

    try {
      flattenShadows(source, clone);
    } catch {
      /* ignore */
    }

    clone.querySelectorAll(STRIP_SELECTOR).forEach((el) => el.remove());

    const walker = document.createTreeWalker(clone, NodeFilter.SHOW_COMMENT);
    const comments = [];
    while (walker.nextNode()) comments.push(walker.currentNode);
    comments.forEach((c) => c.parentNode && c.parentNode.removeChild(c));

    return clone;
  }

  const BLOCK_TAGS = new Set([
    "address",
    "article",
    "aside",
    "blockquote",
    "dd",
    "details",
    "dialog",
    "div",
    "dl",
    "dt",
    "fieldset",
    "figcaption",
    "figure",
    "footer",
    "form",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "header",
    "hgroup",
    "hr",
    "li",
    "main",
    "nav",
    "ol",
    "p",
    "pre",
    "section",
    "table",
    "tbody",
    "td",
    "tfoot",
    "th",
    "thead",
    "tr",
    "ul",
  ]);

  function nodeToMarkdown(node, listDepth = 0) {
    if (!node) return "";

    if (node.nodeType === Node.TEXT_NODE) {
      return (node.nodeValue || "").replace(/[ \t\f\v]+/g, " ");
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return "";

    const el = node;
    const tag = el.tagName.toLowerCase();

    if (
      tag === "script" ||
      tag === "style" ||
      tag === "noscript" ||
      tag === "template" ||
      tag === "svg" ||
      tag === "canvas"
    ) {
      return "";
    }

    if (tag === "br") return "\n";
    if (tag === "hr") return "\n\n---\n\n";
    if (tag === "wbr") return "";

    if (/^h[1-6]$/.test(tag)) {
      const level = Number(tag[1]);
      const inner = childrenToMarkdown(el, listDepth).replace(/\n+/g, " ").trim();
      if (!inner) return "";
      return `\n\n${"#".repeat(level)} ${inner}\n\n`;
    }

    if (tag === "p") {
      const inner = childrenToMarkdown(el, listDepth).trim();
      return inner ? `\n\n${inner}\n\n` : "";
    }

    if (tag === "blockquote") {
      const inner = childrenToMarkdown(el, listDepth).trim();
      if (!inner) return "";
      const quoted = inner
        .split("\n")
        .map((line) => (line ? `> ${line}` : ">"))
        .join("\n");
      return `\n\n${quoted}\n\n`;
    }

    if (tag === "pre") {
      const code = el.textContent || "";
      const lang =
        (el.querySelector("code") &&
          (el.querySelector("code").getAttribute("class") || "").match(
            /language-([\w-]+)/
          )?.[1]) ||
        "";
      return `\n\n\`\`\`${lang}\n${code.replace(/\n$/, "")}\n\`\`\`\n\n`;
    }

    if (tag === "code") {
      if (el.parentElement && el.parentElement.tagName.toLowerCase() === "pre") {
        return el.textContent || "";
      }
      const t = (el.textContent || "").replace(/`/g, "\\`");
      return `\`${t}\``;
    }

    if (tag === "a") {
      const href = absUrl(el.getAttribute("href") || "");
      const inner = childrenToMarkdown(el, listDepth).replace(/\n+/g, " ").trim();
      if (!inner && !href) return "";
      if (!href || href.startsWith("javascript:")) return inner || "";
      return `[${inner || href}](${href})`;
    }

    if (tag === "img") {
      const src = absUrl(
        el.getAttribute("src") || el.getAttribute("data-src") || ""
      );
      const alt = el.getAttribute("alt") || "";
      if (!src) return alt || "";
      return `![${alt}](${src})`;
    }

    if (tag === "ul" || tag === "ol") {
      const items = Array.from(el.children).filter(
        (c) => c.tagName && c.tagName.toLowerCase() === "li"
      );
      if (!items.length) return childrenToMarkdown(el, listDepth);
      const lines = items.map((li, i) => {
        const bullet = tag === "ol" ? `${i + 1}. ` : "- ";
        const indent = "  ".repeat(listDepth);
        const body = childrenToMarkdown(li, listDepth + 1)
          .trim()
          .replace(/\n+/g, "\n" + indent + "  ");
        return `${indent}${bullet}${body}`;
      });
      return `\n\n${lines.join("\n")}\n\n`;
    }

    if (tag === "li") return childrenToMarkdown(el, listDepth);

    if (tag === "table") return tableToMarkdown(el);

    if (tag === "strong" || tag === "b") {
      const inner = childrenToMarkdown(el, listDepth).trim();
      return inner ? `**${inner}**` : "";
    }
    if (tag === "em" || tag === "i") {
      const inner = childrenToMarkdown(el, listDepth).trim();
      return inner ? `*${inner}*` : "";
    }
    if (tag === "s" || tag === "del" || tag === "strike") {
      const inner = childrenToMarkdown(el, listDepth).trim();
      return inner ? `~~${inner}~~` : "";
    }

    if (tag === "input") {
      const type = (el.getAttribute("type") || "text").toLowerCase();
      if (type === "hidden" || type === "password") return "";
      const val = el.getAttribute("value") || el.value || "";
      const aria = el.getAttribute("aria-label") || "";
      return [aria, val].filter(Boolean).join(" ");
    }

    if (tag === "textarea" || tag === "select" || tag === "option") {
      return (el.value || el.textContent || "").trim();
    }

    const inner = childrenToMarkdown(el, listDepth);
    if (BLOCK_TAGS.has(tag)) {
      return inner.trim() ? `\n\n${inner.trim()}\n\n` : "";
    }
    return inner;
  }

  function childrenToMarkdown(el, listDepth) {
    let out = "";
    for (const child of el.childNodes) {
      out += nodeToMarkdown(child, listDepth);
    }
    return out;
  }

  function tableToMarkdown(table) {
    const rows = Array.from(table.querySelectorAll("tr"));
    if (!rows.length) return "";
    const matrix = rows.map((tr) =>
      Array.from(tr.querySelectorAll("th,td")).map((cell) =>
        childrenToMarkdown(cell, 0).replace(/\n+/g, " ").trim()
      )
    );
    const cols = Math.max(0, ...matrix.map((r) => r.length));
    if (!cols) return "";
    const norm = matrix.map((r) => {
      const row = r.slice();
      while (row.length < cols) row.push("");
      return row;
    });
    const header = norm[0];
    const sep = header.map(() => "---");
    const body = norm.slice(1);
    const lines = [
      `| ${header.join(" | ")} |`,
      `| ${sep.join(" | ")} |`,
      ...body.map((r) => `| ${r.join(" | ")} |`),
    ];
    return `\n\n${lines.join("\n")}\n\n`;
  }

  function fullPageMarkdown() {
    const root = prepareFullPageRoot();
    if (!root) return "";
    return collapseBlankLines(nodeToMarkdown(root));
  }

  function defuddleFullPage(Defuddle, url) {
    try {
      const parsed = new Defuddle(document, {
        markdown: true,
        url,
        useAsync: false,
        contentSelector: "body",
        removeExactSelectors: false,
        removePartialSelectors: false,
        removeHiddenElements: false,
        removeLowScoring: false,
        removeSmallImages: false,
        removeImages: false,
      }).parse();

      let body =
        (parsed && (parsed.contentMarkdown || parsed.content)) || "";

      if (body && !isProbablyMarkdown(body) && /<[a-z][\s\S]*>/i.test(body)) {
        const tmp = document.createElement("div");
        tmp.innerHTML = body;
        body = (tmp.innerText || tmp.textContent || "").trim();
      }

      return {
        body: (body || "").trim(),
        title: (parsed && parsed.title) || "",
        author: (parsed && parsed.author) || "",
        wordCount: (parsed && parsed.wordCount) || 0,
      };
    } catch {
      return { body: "", title: "", author: "", wordCount: 0 };
    }
  }

  function pickRicher(a, b) {
    const as = (a || "").trim();
    const bs = (b || "").trim();
    if (bs.length > as.length * 1.1 && bs.length >= as.length + 80) return bs;
    if (as.length >= bs.length) return as;
    return bs;
  }

  // ─── Scroll-accumulate (virtualized store grids) ───────────────────

  function isManyVidsStorePage() {
    const host = location.hostname || "";
    if (!/manyvids\.com$/i.test(host) && !/\.manyvids\.com$/i.test(host)) {
      return false;
    }
    if (/\/Store\/Videos/i.test(location.pathname || "")) return true;
    if (document.querySelector('[class*="videosGrid"]')) return true;
    if (document.querySelector('[class*="VideoCard"]')) return true;
    return false;
  }

  /** Generic: many product-like video cards currently in DOM. */
  function shouldScrollAccumulate() {
    if (isManyVidsStorePage()) return true;
    const videoLinks = document.querySelectorAll('a[href*="/Video/"]');
    if (videoLinks.length >= 8) return true;
    return false;
  }

  function readExpectedTotal() {
    const text = (document.body && document.body.innerText) || "";
    let m = text.match(/\bAll\s*\((\d+)\)/i);
    if (m) return Number(m[1]);
    m = text.match(/\b(\d+)\s*NSFW\s*Vids/i);
    if (m) return Number(m[1]);
    m = text.match(/\b(\d+)\s*videos?\b/i);
    if (m && Number(m[1]) >= 5 && Number(m[1]) <= 5000) return Number(m[1]);
    return null;
  }

  function cardRootFrom(el) {
    return (
      el.closest(
        '[class*="VideoCard"], [class*="gridCard"], [class*="ListItem"], [class*="video-card"], article, li'
      ) || el.parentElement
    );
  }

  function harvestVideoCards(byId) {
    const anchors = document.querySelectorAll('a[href*="/Video/"]');
    for (const a of anchors) {
      const href = a.getAttribute("href") || "";
      const m = href.match(/\/Video\/(\d+)(?:\/([^/?#]*))?/i);
      if (!m) continue;
      const id = m[1];
      const url = absUrl(href.split("?")[0]);
      const slug = m[2] || "";

      let title = "";
      const aria = (a.getAttribute("aria-label") || "").trim();
      if (aria) {
        title = aria
          .replace(/\s+by\s+.+?\s+on\s+ManyVids\.?\s*$/i, "")
          .replace(/\s+on\s+ManyVids\.?\s*$/i, "")
          .trim();
      }
      const text = (a.innerText || "").trim().replace(/\s+/g, " ");
      if (!title || /^\d{1,2}:\d{2}/.test(title)) {
        if (text && !/^\d{1,2}:\d{2}/.test(text) && text.length > 3) {
          title = text;
        }
      }

      let price = "";
      let duration = "";
      let views = "";

      const root = cardRootFrom(a);
      if (root) {
        const scope = root;
        // Prefer cart / price button aria
        for (const btn of scope.querySelectorAll("button, [role='button'], a")) {
          const lab = btn.getAttribute("aria-label") || "";
          const pm = lab.match(/\$\d+(?:\.\d{1,2})?/);
          if (pm) {
            price = pm[0];
            break;
          }
          const bt = (btn.textContent || "").trim();
          if (/^\$\d+(?:\.\d{1,2})?$/.test(bt)) {
            price = bt;
            break;
          }
        }
        const blob = (scope.innerText || "").replace(/\s+/g, " ");
        if (!price) {
          const pm = blob.match(/\$\d+(?:\.\d{1,2})?/);
          if (pm) price = pm[0];
        }
        const dm = blob.match(/\b(\d{1,2}:\d{2})\b/);
        if (dm) duration = dm[1];
        // views like 1.2K / 954 / 2.2K near the card
        const vm = blob.match(
          /\b(\d{1,2}:\d{2})\s+(\d+(?:\.\d+)?[KkMm]?)\b/
        );
        if (vm) views = vm[2];
        else {
          const vm2 = blob.match(/\b(\d+(?:\.\d+)?[KkMm])\b/);
          if (vm2) views = vm2[1];
        }
      }

      const prev = byId.get(id) || {};
      byId.set(id, {
        id,
        url: prev.url || url,
        title: betterTitle(
          prev.title,
          betterTitle(title, slugToTitle(slug) || id)
        ),
        price: price || prev.price || "",
        duration: duration || prev.duration || "",
        views: views || prev.views || "",
      });
    }
  }

  function fireScrollSignals(deltaY) {
    try {
      window.dispatchEvent(new Event("scroll", { bubbles: true }));
    } catch {
      /* ignore */
    }
    try {
      document.dispatchEvent(
        new WheelEvent("wheel", {
          deltaY,
          deltaMode: 0,
          bubbles: true,
          cancelable: true,
          view: window,
        })
      );
    } catch {
      /* ignore */
    }
    try {
      document.documentElement.dispatchEvent(
        new WheelEvent("wheel", {
          deltaY,
          bubbles: true,
          cancelable: true,
          view: window,
        })
      );
    } catch {
      /* ignore */
    }
  }

  function findScrollContainer() {
    // Prefer an overflowing ancestor of the video grid if present
    const grid =
      document.querySelector('[class*="videosGrid"]') ||
      document.querySelector('[class*="VideoCard"]') ||
      document.querySelector('a[href*="/Video/"]');
    let el = grid && grid.parentElement;
    for (let i = 0; i < 10 && el; i++) {
      const style = window.getComputedStyle(el);
      const oy = style.overflowY;
      if (
        (oy === "auto" || oy === "scroll" || oy === "overlay") &&
        el.scrollHeight > el.clientHeight + 40
      ) {
        return el;
      }
      el = el.parentElement;
    }
    return null;
  }

  async function scrollAccumulateVideos() {
    const byId = new Map();
    const startY = window.scrollY;
    const expected = readExpectedTotal();
    const nested = findScrollContainer();

    const scrollToY = async (y) => {
      if (nested) {
        nested.scrollTop = y;
      } else {
        window.scrollTo(0, y);
      }
      fireScrollSignals(400);
      await sleep(280);
    };

    const maxScroll = () => {
      if (nested) {
        return Math.max(0, nested.scrollHeight - nested.clientHeight);
      }
      return Math.max(
        0,
        document.documentElement.scrollHeight - window.innerHeight
      );
    };

    const currentY = () => (nested ? nested.scrollTop : window.scrollY);

    // Start at top
    await scrollToY(0);
    await sleep(350);
    harvestVideoCards(byId);

    let stagnant = 0;
    let lastSize = byId.size;
    const maxSteps = 100;

    for (let step = 0; step < maxSteps; step++) {
      // Bring last card into view — helps virtual lists recycle
      const links = document.querySelectorAll('a[href*="/Video/"]');
      if (links.length) {
        try {
          links[links.length - 1].scrollIntoView({
            block: "center",
            inline: "nearest",
            behavior: "instant",
          });
        } catch {
          try {
            links[links.length - 1].scrollIntoView(false);
          } catch {
            /* ignore */
          }
        }
      }

      const before = currentY();
      const stepPx = Math.max(480, Math.floor(window.innerHeight * 0.75));
      if (nested) {
        nested.scrollTop = before + stepPx;
      } else {
        window.scrollBy(0, stepPx);
      }
      fireScrollSignals(stepPx);
      await sleep(420);
      harvestVideoCards(byId);

      // Mid-pass harvest after small settle
      await sleep(120);
      harvestVideoCards(byId);

      const size = byId.size;
      if (size === lastSize) stagnant += 1;
      else {
        stagnant = 0;
        lastSize = size;
      }

      // Hit expected total early
      if (expected && size >= expected) break;

      const y = currentY();
      const maxY = maxScroll();
      const atBottom = y >= maxY - 12;

      // If scroll didn't move, force jump toward end
      if (Math.abs(y - before) < 2) {
        await scrollToY(Math.min(maxY, before + stepPx * 2));
        harvestVideoCards(byId);
      }

      if (atBottom && stagnant >= 3) {
        // bounce: top → bottom once more to catch missed windows
        await scrollToY(0);
        harvestVideoCards(byId);
        await scrollToY(maxScroll());
        harvestVideoCards(byId);
        if (byId.size === lastSize) break;
        lastSize = byId.size;
        stagnant = 0;
      }

      if (stagnant >= 10) break;
    }

    // Even-spaced sweep (catches windows scrollTo alone sometimes misses)
    const sweepMax = maxScroll();
    const sweeps = 24;
    for (let i = 0; i <= sweeps; i++) {
      await scrollToY(Math.round((sweepMax * i) / sweeps));
      harvestVideoCards(byId);
      if (expected && byId.size >= expected) break;
    }

    // Restore user scroll position
    try {
      if (nested) nested.scrollTop = startY;
      else window.scrollTo(0, startY);
    } catch {
      /* ignore */
    }

    const items = [...byId.values()].sort(
      (a, b) => Number(b.id) - Number(a.id)
    );

    return {
      items,
      expected,
      collected: items.length,
    };
  }

  function formatCatalogMarkdown(catalog, meta) {
    const { items, expected, collected } = catalog;
    const lines = [];
    lines.push(`## Videos (${collected}${expected ? ` / ${expected}` : ""})`);
    lines.push("");
    if (expected && collected < expected) {
      lines.push(
        `_Collected ${collected} of ${expected} labeled items. Scroll the page fully once, then try again if some are still missing._`
      );
      lines.push("");
    } else if (expected && collected >= expected) {
      lines.push(`_Scroll-accumulate collected all ${collected} items._`);
      lines.push("");
    } else {
      lines.push(`_Scroll-accumulate collected ${collected} items._`);
      lines.push("");
    }

    items.forEach((it, i) => {
      const title = (it.title || `Video ${it.id}`).replace(/\s+/g, " ").trim();
      const bits = [];
      if (it.price) bits.push(it.price);
      if (it.duration) bits.push(it.duration);
      if (it.views) bits.push(`${it.views} views`);
      const suffix = bits.length ? ` — ${bits.join(" · ")}` : "";
      lines.push(`${i + 1}. [${title}](${it.url})${suffix}`);
    });

    if (meta && meta.extra) {
      lines.push("");
      lines.push(meta.extra);
    }

    return lines.join("\n");
  }

  // ─── Main ─────────────────────────────────────────────────────────

  try {
    const Defuddle = resolveDefuddle();
    const url = location.href;
    const pageTitle = document.title || "";

    let mode = "full-page";
    let body = "";
    let catalogInfo = null;

    if (shouldScrollAccumulate()) {
      try {
        const catalog = await scrollAccumulateVideos();
        if (catalog.items.length >= 3) {
          mode = "scroll-accumulate";
          catalogInfo = catalog;
          body = formatCatalogMarkdown(catalog, {});
        }
      } catch (scrollErr) {
        console.warn("[ToMarkdown] scroll-accumulate failed:", scrollErr);
      }
    }

    // Full-page fallback / supplement
    if (mode === "full-page" || !body) {
      const localBody = fullPageMarkdown();
      const fromDefuddle = Defuddle
        ? defuddleFullPage(Defuddle, url)
        : { body: "", title: "", author: "", wordCount: 0 };

      body = pickRicher(localBody, fromDefuddle.body);
      if (!body || body.length < 40) {
        const plain =
          (document.body && (document.body.innerText || "")) || "";
        body = collapseBlankLines(plain);
      }
      body = collapseBlankLines(body);
      mode = "full-page";

      const title = fromDefuddle.title || pageTitle || "Untitled";
      const author = fromDefuddle.author || "";
      const wordCount =
        fromDefuddle.wordCount ||
        (body ? body.split(/\s+/).filter(Boolean).length : 0);
      const thin = !body || body.length < 40;
      const safeTitle =
        String(title).replace(/\s+/g, " ").trim() || "Untitled";

      const metaLines = [
        `# ${safeTitle}`,
        "",
        `> Source: ${url}`,
        `> Saved: ${new Date().toISOString()}`,
      ];
      if (author) metaLines.push(`> Author: ${author}`);
      metaLines.push(`> Mode: ${mode}`, "", "---", "");

      const warning = thin
        ? "_Note: Little visible content was found on this page._\n\n"
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
        mode,
      };
    }

    // scroll-accumulate success path
    const fromDefuddle = Defuddle
      ? defuddleFullPage(Defuddle, url)
      : { body: "", title: "", author: "", wordCount: 0 };

    const title = fromDefuddle.title || pageTitle || "Untitled";
    const author = fromDefuddle.author || "";
    const safeTitle =
      String(title).replace(/\s+/g, " ").trim() || "Untitled";

    const collected = catalogInfo ? catalogInfo.collected : 0;
    const expected = catalogInfo ? catalogInfo.expected : null;
    const incomplete = expected != null && collected < expected;
    const thin = collected < 3;

    const metaLines = [
      `# ${safeTitle}`,
      "",
      `> Source: ${url}`,
      `> Saved: ${new Date().toISOString()}`,
    ];
    if (author) metaLines.push(`> Author: ${author}`);
    metaLines.push(`> Mode: ${mode}`);
    if (expected != null) {
      metaLines.push(`> Items: ${collected} / ${expected}`);
    } else {
      metaLines.push(`> Items: ${collected}`);
    }
    metaLines.push("", "---", "");

    const markdown =
      metaLines.join("\n") + collapseBlankLines(body) + "\n";

    const wordCount = body
      ? body.split(/\s+/).filter(Boolean).length
      : 0;

    return {
      ok: true,
      markdown,
      title: safeTitle,
      url,
      wordCount,
      thin: thin || incomplete,
      charCount: markdown.length,
      mode,
      collected,
      expected,
    };
  } catch (err) {
    return {
      ok: false,
      error: err && err.message ? err.message : String(err),
    };
  }
})();
