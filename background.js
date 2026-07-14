/**
 * ToMarkdown — service worker
 * Click the toolbar icon → extract main content with Defuddle → download .md
 */

const BADGE = {
  clear: { text: "" },
  ok: { text: "OK", color: "#16a34a" },
  warn: { text: "!", color: "#ca8a04" },
  err: { text: "ERR", color: "#dc2626" },
  busy: { text: "...", color: "#4f46e5" },
};

const RESTRICTED_URL_RE =
  /^(chrome|chrome-extension|edge|about|devtools|view-source|chrome-search|chrome-untrusted|brave|opera|vivaldi):/i;

const EXTRACT_TIMEOUT_MS = 45_000;

async function setBadge(tabId, kind, ms = 2000) {
  const conf = BADGE[kind] || BADGE.clear;
  try {
    if (conf.color) {
      await chrome.action.setBadgeBackgroundColor({ tabId, color: conf.color });
    }
    await chrome.action.setBadgeText({ tabId, text: conf.text });
    if (kind !== "clear" && ms > 0) {
      setTimeout(() => {
        chrome.action.setBadgeText({ tabId, text: "" }).catch(() => {});
      }, ms);
    }
  } catch {
    // tab may be gone
  }
}

function sanitizeFilename(title) {
  let name = String(title || "page")
    // control chars & newlines → space first (preserve word boundaries)
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/[<>:"/\\|?*]/g, "")
    .replace(/\s+/g, " ")
    .trim();

  // Avoid hidden / trailing-dot names on Windows & Unix
  name = name.replace(/^\.+/, "").replace(/[. ]+$/g, "").trim();

  // Windows reserved device names
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(name)) {
    name = `page-${name}`;
  }
  if (!name) name = "page";
  if (name.length > 100) name = name.slice(0, 100).trim();
  // re-strip after length cut
  name = name.replace(/[. ]+$/g, "").trim() || "page";
  return name;
}

function isRestrictedUrl(url) {
  if (!url) return true;
  if (RESTRICTED_URL_RE.test(url)) return true;
  if (url.startsWith("https://chrome.google.com/webstore")) return true;
  if (url.startsWith("https://chromewebstore.google.com/")) return true;
  return false;
}

/**
 * Download markdown. Prefer Blob object URL; fall back to data: URL.
 */
async function downloadMarkdown(filename, markdown) {
  const tryDownload = async (url, revoke) => {
    try {
      const downloadId = await chrome.downloads.download({
        url,
        filename,
        saveAs: false,
        conflictAction: "uniquify",
      });
      if (typeof revoke === "function") {
        const onChanged = (delta) => {
          if (delta.id !== downloadId) return;
          if (
            delta.state &&
            (delta.state.current === "complete" ||
              delta.state.current === "interrupted")
          ) {
            chrome.downloads.onChanged.removeListener(onChanged);
            revoke();
          }
        };
        chrome.downloads.onChanged.addListener(onChanged);
        setTimeout(revoke, 60_000);
      }
      return downloadId;
    } catch (err) {
      if (typeof revoke === "function") revoke();
      throw err;
    }
  };

  try {
    const blob = new Blob([markdown], {
      type: "text/markdown;charset=utf-8",
    });
    const objectUrl = URL.createObjectURL(blob);
    return await tryDownload(objectUrl, () => {
      try {
        URL.revokeObjectURL(objectUrl);
      } catch {
        /* ignore */
      }
    });
  } catch (blobErr) {
    console.warn(
      "[ToMarkdown] Blob download failed, trying data URL:",
      blobErr
    );
  }

  if (markdown.length > 1_500_000) {
    throw new Error("Page too large to download via data URL fallback");
  }
  const dataUrl =
    "data:text/markdown;charset=utf-8," + encodeURIComponent(markdown);
  return tryDownload(dataUrl, null);
}

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${label} timed out after ${ms}ms`)),
      ms
    );
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function extractFromTab(tabId) {
  // Inject library + extractor in order; result comes from the last file.
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    files: ["lib/defuddle.full.js", "content/extract.js"],
  });

  const payload = results && results[0] && results[0].result;
  if (!payload) {
    throw new Error(
      "No extraction result returned (page may block scripting, or is not a normal document)"
    );
  }
  return payload;
}

chrome.action.onClicked.addListener(async (tab) => {
  if (!tab || tab.id == null) return;

  const tabId = tab.id;
  const url = tab.url || "";

  if (isRestrictedUrl(url)) {
    await setBadge(tabId, "err", 3000);
    console.warn("[ToMarkdown] Cannot access restricted page:", url);
    return;
  }

  await setBadge(tabId, "busy", 0);

  try {
    const payload = await withTimeout(
      extractFromTab(tabId),
      EXTRACT_TIMEOUT_MS,
      "Extraction"
    );

    if (!payload.ok) {
      console.error("[ToMarkdown] Extract failed:", payload.error);
      await setBadge(tabId, "err", 3000);
      return;
    }

    const base = sanitizeFilename(payload.title);
    const filename = `${base}.md`;
    await downloadMarkdown(filename, payload.markdown);

    await setBadge(tabId, payload.thin ? "warn" : "ok", 2500);
    console.info(
      `[ToMarkdown] Saved "${filename}" (${payload.charCount} chars, ~${payload.wordCount} words)`
    );
  } catch (err) {
    console.error("[ToMarkdown] Error:", err);
    // file:// often needs "Allow access to file URLs" on the extension card
    if (url.startsWith("file:")) {
      console.warn(
        "[ToMarkdown] For local files, enable “Allow access to file URLs” on chrome://extensions → ToMarkdown"
      );
    }
    await setBadge(tabId, "err", 3000);
  }
});
