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

  /** Escape Markdown metacharacters in inline text content.
   *  Only escapes characters that have semantic meaning inline: \\ ` * _ [ ] ( ) */
  function escapeMarkdownText(text) {
    if (!text) return "";
    // Backslash must be escaped first to avoid double-escaping later chars
    return String(text)
      .replace(/\\/g, "\\\\")
      .replace(/`/g, "\\`")
      .replace(/\*/g, "\\*")
      .replace(/_/g, "\\_")
      .replace(/\[/g, "\\[")
      .replace(/\]/g, "\\]")
      .replace(/\(/g, "\\(")
      .replace(/\)/g, "\\)");
  }

  /** Escape `)` and `\` in Markdown URL targets. */
  function escapeMarkdownUrl(url) {
    if (!url) return "";
    return String(url)
      .replace(/\\/g, "\\\\")
      .replace(/\)/g, "\\)");
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /** Prefer human-readable titles over duration-only / slug-like strings. */
  function titleQuality(t) {
    const s = (t || "").trim();
    if (!s) return -1;
    if (/^\d{1,2}:\d{2}(:\d{2})?$/.test(s)) return 0;
    if (/^[\d\s.:]+$/.test(s)) return 0;
    // Mostly slug-like: lowercase words from URL segments
    if (/^[a-z0-9]+(?: [a-z0-9]+)+$/.test(s) && s === s.toLowerCase()) return 2;
    let score = 3;
    if (/[A-Z]/.test(s)) score += 2;
    if (/[,!?'"&()|]| - /.test(s)) score += 1;
    if (s.length >= 12) score += 1;
    if (s.length < 4) score -= 2;
    return score;
  }

  function betterTitle(a, b) {
    const as = (a || "").trim();
    const bs = (b || "").trim();
    if (!as) return bs;
    if (!bs) return as;
    // Prefer full title when one is a truncated prefix of the other
    const al = as.toLowerCase();
    const bl = bs.toLowerCase();
    // Only treat as prefix match when A is >50% of B in length — prevents
    // false merging of titles that share only a short common prefix.
    const minPrefix = Math.max(12, Math.floor(Math.min(as.length, bs.length) * 0.55));
    if (as.length >= 10 && bl.startsWith(al.slice(0, Math.min(al.length, minPrefix)))) {
      return bs.length >= as.length ? bs : as;
    }
    if (bs.length >= 10 && al.startsWith(bl.slice(0, Math.min(bl.length, minPrefix)))) {
      return as.length >= bs.length ? as : bs;
    }
    const qa = titleQuality(as);
    const qb = titleQuality(bs);
    if (qa !== qb) {
      // Near-tie: keep the longer human title (aria often truncates mid-phrase)
      if (Math.abs(qa - qb) <= 1 && Math.abs(as.length - bs.length) >= 10) {
        return as.length >= bs.length ? as : bs;
      }
      return qa > qb ? as : bs;
    }
    return as.length >= bs.length ? as : bs;
  }

  /**
   * Generic slug → title. Merges a single letter after a number
   * (e.g. "2-b-loves" → "2b loves") which is common in product codes.
   */
  function slugToTitle(slug) {
    if (!slug) return "";
    let decoded = slug;
    try {
      decoded = decodeURIComponent(slug);
    } catch {
      /* keep raw */
    }
    const parts = decoded.split(/[-_]+/).filter(Boolean);
    const merged = [];
    for (const p of parts) {
      if (
        merged.length &&
        p.length === 1 &&
        /[a-z]/i.test(p) &&
        /\d$/i.test(merged[merged.length - 1])
      ) {
        merged[merged.length - 1] += p;
      } else {
        merged.push(p);
      }
    }
    return merged.join(" ").replace(/\s+/g, " ").trim();
  }

  /** Strip site boilerplate from accessibility labels (any storefront). */
  function cleanLabelTitle(raw) {
    let s = String(raw || "").replace(/\s+/g, " ").trim();
    if (!s) return "";
    // "Title by Creator on SiteName." / "Title on SiteName"
    s = s.replace(/\s+by\s+.+?\s+on\s+[A-Za-z0-9][\w .'-]{1,40}\.?\s*$/i, "");
    s = s.replace(/\s+on\s+[A-Za-z0-9][\w .'-]{1,40}\.?\s*$/i, "");
    // Leading duration overlay text "12:34 Title"
    s = s.replace(/^\d{1,2}:\d{2}(:\d{2})?\s+/, "");
    // Trailing " - Site" / " | Site" when site matches document host brand-ish
    s = s.replace(/\s+[|\-–—]\s*[A-Za-z0-9][\w .'-]{1,30}\s*$/, (m) => {
      // only strip if short brand suffix (not part of the real title)
      return m.length <= 24 ? "" : m;
    });
    return s.trim();
  }

  // Currency / price (multi-locale, storefront-agnostic)
  const PRICE_RE =
    /(?:USD|EUR|GBP|CAD|AUD|JPY|CNY|HKD|SGD|INR|€|£|¥|￥|\$|₹|₩|₽)\s?\d{1,3}(?:[.,]\d{3})*(?:[.,]\d{1,2})?|\d{1,3}(?:[.,]\d{3})*(?:[.,]\d{1,2})?\s?(?:USD|EUR|GBP|CAD|AUD|JPY|CNY|€|£|¥|\$|₹|₩|₽)/i;
  const PRICE_STRICT_RE =
    /^(?:USD|EUR|GBP|CAD|AUD|€|£|¥|￥|\$|₹|₩|₽)\s?\d{1,3}(?:[.,]\d{3})*(?:[.,]\d{1,2})?$/i;
  const DURATION_RE = /\b(\d{1,2}:\d{2}(?::\d{2})?)\b/;
  // View counts only:
  //  - plain 2–7 digits (954, 12345) — NOT single digit
  //  - compact with K/M only (1.2K, 12K, 3M) — NOT "2B"/"2b" character-name style
  // Capture group 1 = full count token
  const COUNT_TOKEN = "(\\d+(?:\\.\\d+)?[KkMm]|\\d{2,7})";
  // Terminator that works for both ASCII and CJK text (\\b only matches ASCII word boundaries)
  const WORD_END = "(?:$|[\\s,.;!?)}\\]>]|$)";
  const VIEWS_LABELED_RE = new RegExp(
    "\\b" + COUNT_TOKEN + "\\s*(?:views?|plays?|watches?|次播放|次观看|播放量?)" + WORD_END,
    "i"
  );
  const VIEWS_PREFIX_RE = new RegExp(
    "\\b(?:views?|plays?|watches?|播放量?)[:\\s]+" + COUNT_TOKEN + WORD_END,
    "i"
  );
  const PRICE_LOOKAHEAD = "(?=\\s*(?:\\$|USD|EUR|GBP|CAD|AUD|€|£|¥|₹|₩|₽))";

  function extractPriceFromText(text) {
    if (!text) return "";
    const t = String(text).replace(/\s+/g, " ").trim();
    if (PRICE_STRICT_RE.test(t)) return t;
    const m = t.match(PRICE_RE);
    return m ? m[0].replace(/\s+/g, " ").trim() : "";
  }

  function extractDurationFromText(text) {
    if (!text) return "";
    const m = String(text).match(DURATION_RE);
    return m ? m[1] : "";
  }

  function normalizeViewCount(raw) {
    if (!raw) return "";
    let s = String(raw).trim().replace(/,/g, "");
    // Reject years
    if (/^20[0-3]\d$/.test(s)) return "";
    // Reject single digit
    if (/^\d$/.test(s)) return "";
    // Reject character-code style "2B"/"2b"/"3M" alone with 1 digit + letter
    // Real compact counts need K/M and typically look like 1.2K or 12K+
    if (/^\d[Bb]$/i.test(s)) return "";
    // Bare "1K" is ok; "2B" already rejected. Reject any *B/b billion shorthand
    // unless multi-digit or decimal (2.1B / 12B) — still rare; skip all *B for safety
    if (/b$/i.test(s)) return "";
    // Compact must be K or M only
    if (/[a-z]$/i.test(s) && !/[KkMm]$/.test(s)) return "";
    return s;
  }

  /** Prefer a more trustworthy view count when merging harvest passes. */
  function viewScore(v) {
    if (!v) return -1;
    const s = String(v).trim();
    if (!s) return -1;
    if (/[Bb]$/.test(s) || /^\d[A-Za-z]$/.test(s)) return 0;
    if (/^\d+(?:\.\d+)?[KkMm]$/.test(s)) return 6; // 1.2K, 3M
    if (/^\d{3,7}$/.test(s)) return 5; // 726, 1234
    if (/^\d{2}$/.test(s)) return 2; // 18 — weak (often age/day in title)
    return 3;
  }

  function mergeViews(prev, next) {
    const p = normalizeViewCount(prev);
    const n = normalizeViewCount(next);
    if (!n) return p || "";
    if (!p) return n;
    const sp = viewScore(p);
    const sn = viewScore(n);
    if (sn !== sp) return sn > sp ? n : p;
    // tie: prefer larger magnitude for plain integers, else keep prev
    if (/^\d+$/.test(p) && /^\d+$/.test(n)) {
      return Number(n) >= Number(p) ? n : p;
    }
    return p;
  }

  /** Merge field value, preferring existing over lower-quality replacements. */
  function mergeField(prev, next) {
    const p = (prev && String(prev).trim()) || "";
    const n = (next && String(next).trim()) || "";
    if (!n) return p;
    if (!p) return n;
    // For price: prefer the one that matches the price regex with a currency symbol
    const pHasSymbol = PRICE_RE.test(p) && /[$€£¥₹₩₽]|\b(?:USD|EUR|GBP|CAD|AUD|JPY|CNY)/i.test(p);
    const nHasSymbol = PRICE_RE.test(n) && /[$€£¥₹₩₽]|\b(?:USD|EUR|GBP|CAD|AUD|JPY|CNY)/i.test(n);
    if (pHasSymbol && !nHasSymbol) return p;
    if (nHasSymbol && !pHasSymbol) return n;
    // For duration: prefer the longer one (less likely truncated)
    if (DURATION_RE.test(p) && DURATION_RE.test(n)) {
      return n.length >= p.length ? n : p;
    }
    // Default: prefer non-empty next
    return n;
  }

  /**
   * Strip title-like words so age numbers ("18 year") aren't taken as views.
   * Optional title string from the card is removed when present.
   */
  function scrubTitleFromBlob(text, title) {
    let t = String(text || "").replace(/\s+/g, " ").trim();
    if (!t) return "";
    if (title) {
      const esc = String(title)
        .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
        .replace(/\s+/g, "\\s+");
      try {
        t = t.replace(new RegExp(esc, "ig"), " ");
      } catch {
        /* ignore bad title */
      }
    }
    // Drop common "N year old" / age phrases that leak into counts
    t = t.replace(/\b\d{1,2}\s*years?\s*old\b/gi, " ");
    t = t.replace(/\b\d{1,2}\s*yr\.?\s*old\b/gi, " ");
    return t.replace(/\s+/g, " ").trim();
  }

  /**
   * Generic engagement/view extraction for media & storefront cards.
   * Only trusts structural anchors (label / duration neighbor / price neighbor),
   * never bare numbers floating inside a free-form title.
   */
  function extractViewsFromText(text, opts) {
    if (!text) return "";
    const title = opts && opts.title ? opts.title : "";
    const t = scrubTitleFromBlob(text, title);
    if (!t) return "";

    // 1) Explicit labels — highest confidence
    let m = t.match(VIEWS_LABELED_RE);
    if (m) return normalizeViewCount(m[1]);
    m = t.match(VIEWS_PREFIX_RE);
    if (m) return normalizeViewCount(m[1]);

    // 2) Count glued to price: "954 $24.99" / "1.2K €9.99"
    //    Must NOT take MM from a duration like "13:22 $6.99" → false "22"
    m = t.match(
      new RegExp(
        "(?<![\\d:])\\b" + COUNT_TOKEN + "\\b\\s*" + PRICE_LOOKAHEAD,
        "i"
      )
    );
    if (m) return normalizeViewCount(m[1]);

    // 3) Duration then count only if count is NOT followed by letters
    //    (rejects "15:56 18 year…"; accepts "14:30 954" / "14:30 954 $x")
    m = t.match(
      new RegExp(
        "\\b\\d{1,2}:\\d{2}(?::\\d{2})?\\s+" +
          COUNT_TOKEN +
          "(?!\\s*[A-Za-z\\u00C0-\\u024F\\u4e00-\\u9fff])"
      )
    );
    if (m) return normalizeViewCount(m[1]);

    // 4) Duration … (optional junk) … count glued to price
    //    Same (?<![\\d:]) guard so we never latch onto duration seconds.
    m = t.match(
      new RegExp(
        "\\b\\d{1,2}:\\d{2}(?::\\d{2})?\\b" +
          "(?:(?!\\d{1,2}:\\d{2})[^$€£¥]){0,100}?" +
          "(?<![\\d:])\\b" +
          COUNT_TOKEN +
          "\\b\\s*" +
          PRICE_LOOKAHEAD,
        "i"
      )
    );
    if (m) return normalizeViewCount(m[1]);

    return "";
  }

  /** Short leaf nodes that look like view/play badges (not prices). */
  function extractViewsFromLeafNodes(scope) {
    if (!scope || !scope.querySelectorAll) return "";
    const leaves = scope.querySelectorAll(
      "span, div, p, b, strong, em, i, small, time"
    );
    let best = "";
    for (const el of leaves) {
      if (el.children && el.children.length > 2) continue;
      const t = (el.textContent || "").replace(/\s+/g, " ").trim();
      if (!t || t.length > 12) continue;
      if (PRICE_STRICT_RE.test(t) || PRICE_RE.test(t)) continue;
      if (DURATION_RE.test(t)) continue;
      // Pure badge only: 954 | 1.2K | 12k — not "2B"
      if (/^\d{2,7}$/.test(t) || /^\d+(?:\.\d+)?[KkMm]$/.test(t)) {
        const v = normalizeViewCount(t);
        best = mergeViews(best, v);
        continue;
      }
      const labeled = extractViewsFromText(t);
      best = mergeViews(best, labeled);
    }
    return best;
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
      const raw = (node.nodeValue || "").replace(/[ \t\f\v]+/g, " ");
      return escapeMarkdownText(raw);
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
      const rawCode = el.textContent || "";
      const code = rawCode.replace(/\n$/, "");
      // Count longest run of backticks in the code, then use one more
      const backtickRun = (code.match(/`+/g) || []).reduce((max, m) => Math.max(max, m.length), 0);
      const fence = "`".repeat(Math.max(3, backtickRun + 1));
      const lang =
        (el.querySelector("code") &&
          (el.querySelector("code").getAttribute("class") || "").match(
            /language-([\w-]+)/
          )?.[1]) ||
        "";
      return `\n\n${fence}${lang}\n${code}\n${fence}\n\n`;
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
      return `[${inner || escapeMarkdownText(href)}](${escapeMarkdownUrl(href)})`;
    }

    if (tag === "img") {
      const src = absUrl(
        el.getAttribute("src") || el.getAttribute("data-src") || ""
      );
      const alt = el.getAttribute("alt") || "";
      if (!src) return alt || "";
      return `![${escapeMarkdownText(alt)}](${escapeMarkdownUrl(src)})`;
    }

    if (tag === "ul" || tag === "ol") {
      const items = Array.from(el.children).filter(
        (c) => c.tagName && c.tagName.toLowerCase() === "li"
      );
      if (!items.length) return childrenToMarkdown(el, listDepth);
      const lines = items.map((li, i) => {
        const bullet = tag === "ol" ? `${i + 1}. ` : "- ";
        const indent = "  ".repeat(listDepth);
        // Only wrap with this level's indent, not cumulative — child lists
        // already include their own indentation via listDepth + 1.
        const nextIndent = "  ".repeat(listDepth + 1);
        const body = childrenToMarkdown(li, listDepth + 1)
          .trim()
          .replace(/\n+/g, "\n" + nextIndent);
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
    // Use :scope > to only collect direct-child rows, preventing nested table
    // rows from leaking into the output.
    const directRows = [
      ...table.querySelectorAll(":scope > thead > tr, :scope > tbody > tr, :scope > tfoot > tr, :scope > tr"),
    ];
    if (!directRows.length) {
      // Fallback for tables using non-standard markup
      const allRows = Array.from(table.querySelectorAll("tr"));
      // Filter out rows that are descendants of nested tables
      const outerRows = allRows.filter((tr) => {
        let p = tr.parentElement;
        while (p && p !== table) {
          if (p.tagName === "TABLE") return false; // inside a nested table
          p = p.parentElement;
        }
        return true;
      });
      if (!outerRows.length) return "";
      return buildTableMatrix(outerRows);
    }
    return buildTableMatrix(directRows);
  }

  function buildTableMatrix(rows) {
    const matrix = rows.map((tr) =>
      Array.from(tr.querySelectorAll(":scope > th, :scope > td")).map((cell) =>
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

  // ─── Scroll-accumulate (virtualized product / media grids) ─────────

  /**
   * Product/media detail path patterns (storefront-agnostic).
   * Prefer detail URLs with an id or slug segment — not category/index pages.
   */
  const PRODUCT_DETAIL_RES = [
    /\/videos?\/(\d+)(?:\/([^/?#]*))?/i,
    /\/video\/(\d+)(?:\/([^/?#]*))?/i,
    /\/watch\/([^/?#]+)/i,
    /\/products?\/([^/?#]+)/i,
    /\/item\/([^/?#]+)/i,
    /\/p\/([^/?#]+)/i,
    /\/v\/(\d+)(?:\/([^/?#]*))?/i,
    /\/listing\/([^/?#]+)/i,
    /\/listings\/([^/?#]+)/i,
  ];

  /** Paths that look like indexes / profiles, not a single sellable item. */
  function isIndexLikePath(path) {
    const p = (path || "").replace(/\/+$/, "");
    if (/\/(store|shop|category|categories|search|explore|browse|catalog|collection|collections)(\/|$)/i.test(p)) {
      // Allow if there is also a detail segment later with an id: /shop/item/123
      if (!/\/(item|product|products|video|videos|watch|listing|p|v)\/[^/]+/i.test(p)) {
        return true;
      }
    }
    if (/\/profile\/\d+/i.test(p) && !/\/(video|videos|watch|product|item)\//i.test(p)) {
      return true;
    }
    // Trailing list endpoints: .../Store/Videos, .../shop/all
    if (/\/(videos|items|products|all|new|popular|featured)$/i.test(p)) {
      // detail form is /video/123/slug — already handled by detail match first
      if (!/\/(video|videos|watch|product|item|listing)\/[^/]+\/.+/.test(p) &&
          !/\/(video|videos|product|item)\/\d+/.test(p)) {
        return true;
      }
    }
    return false;
  }

  function parseProductHref(href) {
    if (!href || href.startsWith("javascript:") || href === "#" || href.startsWith("#")) {
      return null;
    }
    let u;
    try {
      u = new URL(href, location.href);
    } catch {
      return null;
    }
    // Same-origin product cards only (avoids nav/social off-site links)
    if (u.origin !== location.origin) return null;

    const path = u.pathname || "";
    if (isIndexLikePath(path)) return null;

    let id = "";
    let slug = "";
    let matched = false;

    for (const re of PRODUCT_DETAIL_RES) {
      const m = path.match(re);
      if (!m) continue;
      matched = true;
      // group1 is id or slug depending on pattern
      if (m[1] && /^\d+$/.test(m[1])) {
        id = m[1];
        slug = m[2] || "";
      } else if (m[1]) {
        slug = m[1];
        id = m[1];
      }
      break;
    }

    if (!matched) return null;
    if (!id) return null;

    // Prefer numeric id when path has one after the matched segment
    const segs = path.split("/").filter(Boolean);
    if (!/^\d+$/.test(id)) {
      for (let i = segs.length - 1; i >= 0; i--) {
        if (/^\d{3,}$/.test(segs[i])) {
          id = segs[i];
          break;
        }
      }
    }
    if (!slug) {
      const last = segs[segs.length - 1] || "";
      if (last && !/^\d+$/.test(last)) slug = last;
    }

    return {
      id,
      url: u.origin + u.pathname,
      slug,
      path,
    };
  }

  function isProductAnchor(a) {
    return !!parseProductHref(a.getAttribute("href") || "");
  }

  function allProductAnchors() {
    return Array.from(document.querySelectorAll("a[href]")).filter(isProductAnchor);
  }

  function productLinksIn(root) {
    if (!root || !root.querySelectorAll) return [];
    return Array.from(root.querySelectorAll("a[href]")).filter(isProductAnchor);
  }

  /**
   * Detect a virtualized / long product grid worth scrolling.
   * Domain-agnostic: count of product-like links or dense card grids with prices.
   */
  function shouldScrollAccumulate() {
    const links = allProductAnchors();
    if (links.length >= 8) return true;

    // Distinct product ids even if few anchors currently (virtualized)
    const ids = new Set(
      links.map((a) => parseProductHref(a.getAttribute("href") || "")?.id).filter(Boolean)
    );
    if (ids.size >= 6) return true;

    // Grid of cards with price-like text
    const cards = document.querySelectorAll(
      'article, li, [class*="card" i], [itemtype*="Product"]'
    );
    let priced = 0;
    for (const c of cards) {
      if (priced >= 8) break;
      if (extractPriceFromText(c.textContent || "")) priced += 1;
    }
    if (priced >= 8) return true;

    // Explicit list total in UI often implies a long catalog
    if (readExpectedTotal() && links.length >= 4) return true;

    return false;
  }

  function readExpectedTotal() {
    const text = (document.body && document.body.innerText) || "";
    // Ordered from highest to lowest specificity — first match wins.
    // Avoid capturing page-offset numbers (e.g. "Showing 1-20 of 500 results" → "1").
    const patterns = [
      /\bAll\s*\((\d+)\)/i,                                                      // "All (500)"
      /(?:of|\/)\s*(\d+)\s*(?:results?|items?|products?|videos?|listings?)\b/i,  // "of 500 results"
      /\b(\d{2,})\s+(?:results?|items?|products?|videos?|listings?)\b/i,         // "500 results" (≥2 digits)
      /\((\d+)\)\s*(?:videos?|items?|products?)\b/i,                              // "(500) videos"
      /\b(?:showing|results?|items?|products?|videos?|listings?)[:\s]*(\d+)\b/i,  // "Showing 500"
    ];
    for (const re of patterns) {
      const m = text.match(re);
      if (!m) continue;
      const n = Number(m[1]);
      if (n >= 5 && n <= 10000) return n;
    }
    return null;
  }

  /**
   * Expand from a product link to the smallest card that still includes
   * price / CTA siblings (without climbing into the whole grid).
   */
  function findCardRoot(anchor) {
    const semantic = anchor.closest(
      'article, li, [itemtype*="Product"], [itemtype*="Video"], [data-product-id], [data-item-id], [data-testid*="card" i], [class*="card" i], [class*="tile" i], [role="listitem"]'
    );
    let best = semantic || anchor.parentElement || anchor;
    let node = anchor.parentElement;
    for (let i = 0; i < 10 && node && node !== document.body; i++) {
      const links = productLinksIn(node);
      // Unique product ids inside this node
      const ids = new Set(
        links
          .map((a) => parseProductHref(a.getAttribute("href") || "")?.id)
          .filter(Boolean)
      );
      if (ids.size === 1) {
        best = node; // safe to expand — still one product
      } else if (ids.size > 1) {
        break; // reached grid
      }
      node = node.parentElement;
    }
    return best;
  }

  function collectAttrsPrice(el) {
    if (!el || !el.getAttribute) return "";
    const candidates = [
      el.getAttribute("data-price"),
      el.getAttribute("data-product-price"),
      el.getAttribute("data-amount"),
      el.getAttribute("data-sale-price"),
      el.getAttribute("content"), // itemprop=price
      el.getAttribute("value"),
    ];
    for (const c of candidates) {
      if (!c) continue;
      const p = extractPriceFromText(c) || (/^\d+(?:[.,]\d{1,2})?$/.test(c.trim()) ? c.trim() : "");
      if (p) {
        // bare numbers from content= often need currency from itemprop sibling — keep if $ already
        if (PRICE_RE.test(p) || PRICE_STRICT_RE.test(p)) return p;
        if (/^\d/.test(p) && el.getAttribute("itemprop") === "price") {
          const cur =
            el.getAttribute("contentCurrency") ||
            el.getAttribute("currency") ||
            (el.parentElement && el.parentElement.closest("[itemprop]") &&
              el.parentElement.querySelector('[itemprop="priceCurrency"]') &&
              el.parentElement.querySelector('[itemprop="priceCurrency"]').getAttribute(
                "content"
              )) ||
            "";
          return cur ? `${cur} ${p}`.trim() : p;
        }
      }
    }
    return "";
  }

  function harvestCardMeta(scope, titleHint) {
    let price = "";
    let duration = "";
    let views = "";
    const titleOpts = titleHint ? { title: titleHint } : undefined;

    if (!scope) return { price, duration, views };

    // Structured attributes first
    const pricedEls = scope.querySelectorAll(
      '[itemprop="price"], [data-price], [data-product-price], [data-amount], [data-sale-price], meta[itemprop="price"]'
    );
    for (const el of pricedEls) {
      price = collectAttrsPrice(el) || extractPriceFromText(el.textContent || "");
      if (price) break;
    }

    // data-views / interactionCount style attrs (schema-ish)
    const viewAttrEls = scope.querySelectorAll(
      "[data-views], [data-view-count], [data-play-count], [data-plays], [itemprop='interactionCount'], [itemprop='userInteractionCount']"
    );
    for (const el of viewAttrEls) {
      const raw =
        el.getAttribute("data-views") ||
        el.getAttribute("data-view-count") ||
        el.getAttribute("data-play-count") ||
        el.getAttribute("data-plays") ||
        el.getAttribute("content") ||
        (el.textContent || "").trim();
      const cleaned = String(raw).replace(/[^\d.KkMm]/g, "");
      const v =
        normalizeViewCount(raw) ||
        extractViewsFromText(String(raw), titleOpts) ||
        normalizeViewCount(cleaned);
      views = mergeViews(views, v);
    }

    // Buttons / CTAs / labeled controls (cart, buy, price chips)
    if (!price) {
      const controls = scope.querySelectorAll(
        "button, [role='button'], a, span, div, p, strong, b"
      );
      for (const el of controls) {
        const lab = el.getAttribute("aria-label") || el.getAttribute("title") || "";
        let p = extractPriceFromText(lab);
        if (!p) {
          const t = (el.childNodes.length <= 3 ? el.textContent : "").trim();
          // Prefer short nodes that are price-only or price-heavy
          if (t.length > 0 && t.length <= 24) p = extractPriceFromText(t);
        }
        if (p) {
          price = p;
          break;
        }
      }
    }

    // role=presentation / overlay / meta packs often hold "duration title views price"
    const packed = [];
    try {
      scope
        .querySelectorAll(
          '[role="presentation"], [class*="overlay" i], [class*="meta" i], [class*="stats" i], [class*="badge" i], [class*="info" i]'
        )
        .forEach((el) => {
          const t = (el.innerText || el.textContent || "").replace(/\s+/g, " ").trim();
          if (t && t.length < 400) packed.push(t);
        });
    } catch {
      /* ignore invalid selectors on old engines */
    }

    const blob = (scope.innerText || scope.textContent || "").replace(/\s+/g, " ");
    if (!price) price = extractPriceFromText(blob);
    duration = extractDurationFromText(blob);
    views = mergeViews(views, extractViewsFromText(blob, titleOpts));

    for (const p of packed) {
      if (!price) price = extractPriceFromText(p) || price;
      if (!duration) duration = extractDurationFromText(p) || duration;
      views = mergeViews(views, extractViewsFromText(p, titleOpts));
    }

    // Leaf badges: standalone "954" / "1.2K" (never "2B")
    views = mergeViews(views, extractViewsFromLeafNodes(scope));

    // Aria-labels often hold "Add to cart for $X" without visible $ in text
    if (!price) {
      for (const el of scope.querySelectorAll("[aria-label]")) {
        const p = extractPriceFromText(el.getAttribute("aria-label") || "");
        if (p) {
          price = p;
          break;
        }
      }
    }

    // Duration / views on thumbnails (link text like "14:30 954") and aria
    // Prefer short overlay texts; scrub title from long aria that includes product name
    for (const el of scope.querySelectorAll("a, [aria-label], [title], img")) {
      const lab =
        el.getAttribute("aria-label") ||
        el.getAttribute("title") ||
        el.getAttribute("alt") ||
        "";
      const txt = (el.innerText || el.textContent || "").replace(/\s+/g, " ").trim();
      // Prefer short overlay strings ("14:30 954") over long title aria
      const combined = [lab, txt]
        .filter((s) => s && s.length < 80)
        .join(" ")
        .trim();
      const longCombined = (lab + " " + txt).trim();
      if (!duration) {
        duration =
          extractDurationFromText(combined) ||
          extractDurationFromText(longCombined) ||
          duration;
      }
      views = mergeViews(
        views,
        extractViewsFromText(combined || longCombined, titleOpts)
      );
    }

    return { price, duration, views };
  }

  function titleFromAnchor(a, slug) {
    let title = "";
    const aria = cleanLabelTitle(a.getAttribute("aria-label") || "");
    if (aria && titleQuality(aria) > 0) title = aria;

    const titleAttr = cleanLabelTitle(a.getAttribute("title") || "");
    title = betterTitle(title, titleAttr);

    // Visible text of this and related title links in the card
    const text = cleanLabelTitle((a.innerText || a.textContent || "").replace(/\s+/g, " "));
    if (titleQuality(text) > 0) title = betterTitle(title, text);

    // img alt on the same card often holds the real name
    const root = findCardRoot(a);
    if (root) {
      for (const img of root.querySelectorAll("img[alt]")) {
        const alt = cleanLabelTitle(img.getAttribute("alt") || "");
        if (titleQuality(alt) >= 3) title = betterTitle(title, alt);
      }
      // Other product anchors in the same card may carry the full title
      for (const other of productLinksIn(root)) {
        const ot = cleanLabelTitle(
          (other.innerText || other.textContent || "").replace(/\s+/g, " ")
        );
        const oa = cleanLabelTitle(other.getAttribute("aria-label") || "");
        title = betterTitle(title, betterTitle(ot, oa));
      }
      // Headings inside card
      for (const h of root.querySelectorAll("h1,h2,h3,h4,h5,h6,[class*='title' i]")) {
        const ht = cleanLabelTitle((h.innerText || "").replace(/\s+/g, " "));
        if (titleQuality(ht) >= 3) title = betterTitle(title, ht);
      }
    }

    title = betterTitle(title, slugToTitle(slug));
    return title;
  }

  function harvestProductCards(byId) {
    const anchors = allProductAnchors();
    for (const a of anchors) {
      const parsed = parseProductHref(a.getAttribute("href") || "");
      if (!parsed) continue;
      const { id, url, slug } = parsed;

      const title = titleFromAnchor(a, slug);
      const root = findCardRoot(a);
      // Pass title so view parser can scrub "18 year old" / "2B" name noise
      const meta = harvestCardMeta(root, title);

      const prev = byId.get(id) || {};
      byId.set(id, {
        id,
        url: prev.url || url,
        title: betterTitle(prev.title, title),
        price: mergeField(prev.price, meta.price),
        duration: mergeField(prev.duration, meta.duration),
        // Never let a weak parse (2B, 18) overwrite a solid count (726, 1.2K)
        views: mergeViews(prev.views, meta.views),
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
    const sample = allProductAnchors()[0];
    let el = sample && sample.parentElement;
    for (let i = 0; i < 12 && el; i++) {
      try {
        const style = window.getComputedStyle(el);
        const oy = style.overflowY;
        if (
          (oy === "auto" || oy === "scroll" || oy === "overlay") &&
          el.scrollHeight > el.clientHeight + 40
        ) {
          return el;
        }
      } catch {
        /* ignore */
      }
      el = el.parentElement;
    }
    return null;
  }

  function metaCoverage(byId) {
    let withPrice = 0;
    let withViews = 0;
    let withDuration = 0;
    for (const it of byId.values()) {
      if (it.price) withPrice += 1;
      if (it.views) withViews += 1;
      if (it.duration) withDuration += 1;
    }
    return { withPrice, withViews, withDuration, total: byId.size };
  }

  async function scrollAccumulateProducts() {
    const byId = new Map();
    const startY = window.scrollY;
    const expected = readExpectedTotal();
    const nested = findScrollContainer();

    const scrollToY = async (y) => {
      if (nested) nested.scrollTop = y;
      else window.scrollTo(0, y);
      fireScrollSignals(400);
      await sleep(300);
    };

    const maxScroll = () => {
      if (nested) return Math.max(0, nested.scrollHeight - nested.clientHeight);
      return Math.max(
        0,
        document.documentElement.scrollHeight - window.innerHeight
      );
    };

    const currentY = () => (nested ? nested.scrollTop : window.scrollY);

    const harvest = () => harvestProductCards(byId);

    await scrollToY(0);
    await sleep(400);
    harvest();

    let stagnant = 0;
    let lastSize = byId.size;
    const maxSteps = 100;

    for (let step = 0; step < maxSteps; step++) {
      const links = allProductAnchors();
      // Scroll past the last visible anchor before stepping down — avoids
      // oscillating between scrollIntoView center and scrollBy.
      if (links.length) {
        try {
          links[links.length - 1].scrollIntoView({
            block: "start",
            inline: "nearest",
            behavior: "instant",
          });
        } catch {
          try {
            links[links.length - 1].scrollIntoView(true);
          } catch {
            /* ignore */
          }
        }
      }

      const before = currentY();
      const stepPx = Math.max(480, Math.floor(window.innerHeight * 0.75));
      if (nested) nested.scrollTop = before + stepPx;
      else window.scrollBy(0, stepPx);
      fireScrollSignals(stepPx);
      await sleep(450);
      harvest();
      await sleep(150);
      harvest();

      const size = byId.size;
      if (size === lastSize) stagnant += 1;
      else {
        stagnant = 0;
        lastSize = size;
      }

      // Do NOT stop solely because count matches expected — still need
      // enrichment passes so price/duration fill in across virtual windows.
      const y = currentY();
      const maxY = maxScroll();
      const atBottom = y >= maxY - 12;

      if (Math.abs(y - before) < 2) {
        await scrollToY(Math.min(maxY, before + stepPx * 2));
        harvest();
      }

      if (atBottom && stagnant >= 3) {
        await scrollToY(0);
        harvest();
        await scrollToY(maxScroll());
        harvest();
        if (byId.size === lastSize) break;
        lastSize = byId.size;
        stagnant = 0;
      }

      if (stagnant >= 10) break;
    }

    // Full sweep for virtual-window enrichment (prices often only on CTAs
    // visible in certain scroll positions)
    const sweepMax = maxScroll();
    const sweeps = 28;
    for (let i = 0; i <= sweeps; i++) {
      await scrollToY(Math.round((sweepMax * i) / sweeps));
      harvest();
    }

    // If meta fields are sparse, one more slower enrichment sweep
    let cov = metaCoverage(byId);
    const needsMeta =
      cov.total >= 5 &&
      (cov.withPrice < cov.total * 0.85 ||
        cov.withViews < cov.total * 0.85 ||
        cov.withDuration < cov.total * 0.85);
    if (needsMeta) {
      for (let i = 0; i <= 20; i++) {
        await scrollToY(Math.round((sweepMax * i) / 20));
        await sleep(220);
        harvest();
      }
      cov = metaCoverage(byId);
    }

    try {
      if (nested) nested.scrollTop = startY;
      else window.scrollTo(0, startY);
    } catch {
      /* ignore */
    }

    const items = [...byId.values()].sort((a, b) => {
      // Prefer numeric ids desc; else localeCompare
      const na = Number(a.id);
      const nb = Number(b.id);
      if (Number.isFinite(na) && Number.isFinite(nb) && String(na) === a.id && String(nb) === b.id) {
        return nb - na;
      }
      return String(b.id).localeCompare(String(a.id));
    });

    return {
      items,
      expected,
      collected: items.length,
      withPrice: items.filter((it) => it.price).length,
      withViews: items.filter((it) => it.views).length,
      withDuration: items.filter((it) => it.duration).length,
    };
  }

  function formatCatalogMarkdown(catalog) {
    const { items, expected, collected, withPrice, withViews, withDuration } =
      catalog;
    const lines = [];
    lines.push(`## Items (${collected}${expected ? ` / ${expected}` : ""})`);
    lines.push("");
    if (expected && collected < expected) {
      lines.push(
        `_Collected ${collected} of ${expected} labeled items. Some may still be virtualized off-screen — try again after the list finishes loading._`
      );
      lines.push("");
    } else if (expected && collected >= expected) {
      lines.push(`_Scroll-accumulate collected all ${collected} items._`);
      lines.push("");
    } else {
      lines.push(`_Scroll-accumulate collected ${collected} items._`);
      lines.push("");
    }
    if (typeof withPrice === "number" && collected > 0 && withPrice < collected) {
      lines.push(
        `_Prices found for ${withPrice}/${collected} items (others had no detectable price in the DOM)._`
      );
      lines.push("");
    }
    if (typeof withViews === "number" && collected > 0 && withViews < collected) {
      lines.push(
        `_View/play counts found for ${withViews}/${collected} items._`
      );
      lines.push("");
    }
    if (
      typeof withDuration === "number" &&
      collected > 0 &&
      withDuration < collected
    ) {
      lines.push(
        `_Durations found for ${withDuration}/${collected} items._`
      );
      lines.push("");
    }

    items.forEach((it, i) => {
      const title = (it.title || `Item ${it.id}`).replace(/\s+/g, " ").trim();
      const bits = [];
      if (it.price) bits.push(it.price);
      if (it.duration) bits.push(it.duration);
      if (it.views) bits.push(`${it.views} views`);
      const suffix = bits.length ? ` — ${bits.join(" · ")}` : "";
      lines.push(`${i + 1}. [${escapeMarkdownText(title)}](${escapeMarkdownUrl(it.url)})${suffix}`);
    });

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
        const catalog = await scrollAccumulateProducts();
        if (catalog.items.length >= 3) {
          mode = "scroll-accumulate";
          catalogInfo = catalog;
          body = formatCatalogMarkdown(catalog);
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
