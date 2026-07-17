# ToMarkdown — Design Spec

**Date:** 2026-07-15  
**Location:** `/Volumes/WD_BLACK/Code/ToMarkdown`  
**Previous name:** AI Page Saver (`ai-page-saver`)

## Goal

One-click Chrome extension that saves the main content of the current web page as AI-friendly Markdown.

## Decisions

| Topic | Choice |
|-------|--------|
| Product name | **ToMarkdown** |
| Trigger | Toolbar icon click |
| Scope | Full page (v1.0.2+); only strip script/style/svg etc. |
| Format | Markdown (`.md`) |
| Action | Download to default Downloads folder |
| Engine | Defuddle full browser bundle (`markdown: true`) |
| Privacy | Local only; `activeTab` (no permanent host permissions) |

## Why Defuddle

Compared to Mozilla Readability + Turndown (MarkDownload-style):

- Purpose-built as a Readability replacement for Obsidian Web Clipper
- More forgiving extraction; standardizes footnotes, math, code blocks for clean MD
- Direct `markdown: true` output in the full bundle

Trafilatura scores well in academic benchmarks but is Python-oriented and unsuitable for a pure local extension without a backend.

## Architecture

```
User clicks icon
  → background service worker
  → reject restricted URLs (chrome://, web store, …)
  → chrome.scripting.executeScript: lib/defuddle.full.js + content/extract.js
  → assemble markdown (title + source meta + body)
  → chrome.downloads.download (Blob object URL)
  → badge: OK / ! / ERR
```

### Output shape

```markdown
# {title}

> Source: {url}
> Saved: {ISO-8601}
> Author: {author}   # optional

---

{body markdown}
```

### Filename

Sanitized page title + `.md`, max ~100 chars; Chrome `conflictAction: uniquify` on clash.

## Non-goals (v1)

- Options page / frontmatter toggle
- Clipboard dual-write
- Selection mode
- Image asset download
- Remote reader APIs (Jina, etc.)
- Readability fallback

## Error handling

| Case | Behavior |
|------|----------|
| Restricted URL | Badge ERR, no download |
| Empty / very short body | Still download with note line; badge ! |
| Inject / parse / download error | Badge ERR, log to console |
| file:// without file access | Badge ERR; console hint to enable file URLs |

## Permissions

- `activeTab`, `scripting`, `downloads`
