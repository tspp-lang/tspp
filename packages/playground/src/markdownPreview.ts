import DOMPurify from "dompurify";
import { marked } from "marked";

/**
 * Renders a project's Markdown to HTML. The text can come from anyone's share link, so the result
 * is sanitized, and it keeps nothing that could restyle the page around it or ask for input.
 */
export function renderMarkdown(text: string): string {
  return DOMPurify.sanitize(marked.parse(text, { async: false }), {
    USE_PROFILES: { html: true },
    FORBID_TAGS: ["style", "form", "button", "select", "textarea"],
    FORBID_ATTR: ["style", "class", "id"],
  });
}

/** The project file a relative link in `fromFile` names, or undefined for links that leave the page. */
export function relativeLinkTarget(fromFile: string, href: string): string | undefined {
  if (href.startsWith("#") || /^[a-z][a-z\d+.-]*:/i.test(href)) return undefined;
  try {
    return decodeURIComponent(new URL(href, `file://${fromFile}`).pathname);
  }
  catch {
    return undefined;
  }
}
