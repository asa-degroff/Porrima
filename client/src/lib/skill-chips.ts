/**
 * Skill chips in the composer.
 *
 * The composer is a contenteditable div and a saved draft is plain text. When a
 * draft is restored the editor has to be rebuilt from that text — and that
 * rebuild must never parse the text as HTML. Composer text routinely carries
 * markup (people paste HTML, selectors, JSX, shell snippets), and assigning it
 * through `innerHTML` turns inert text into live elements in the app origin:
 * an `<img onerror=…>` typed into the composer would execute on the next chat
 * switch. Building the nodes directly keeps markup markup.
 */

/** `/skill-name` token. The charset is deliberately narrow: a token can only
 *  ever be a plausible skill name, so nothing quote- or tag-shaped reaches a
 *  chip's attributes. */
export const SKILL_TOKEN_PATTERN = /\/([a-zA-Z0-9\-_]+)/g;

const CHIP_CSS_TEXT =
  "display:inline-block;padding:2px 8px;margin:0 4px;background:rgba(var(--theme-accent-muted));border:1px solid rgba(var(--theme-accent-border));border-radius:12px;font-size:12px;color:rgba(var(--theme-accent-text));font-weight:500;vertical-align:middle;";

export function createSkillChip(doc: Document, skillName: string): HTMLSpanElement {
  const chip = doc.createElement("span");
  chip.className = "skill-chip";
  chip.style.cssText = CHIP_CSS_TEXT;
  chip.textContent = `/${skillName}`;
  chip.setAttribute("data-skill", skillName);
  // Not editable as text: backspace deletes the whole chip (MessageInput).
  chip.setAttribute("contenteditable", "false");
  return chip;
}

/**
 * Rebuild composer content for `text`: every part of the text becomes a text
 * node, and every token naming a skill in `skills` becomes a chip. Unrecognized
 * tokens stay plain text, exactly as before. No HTML parsing is involved.
 */
export function buildSkillChipFragment(doc: Document, text: string, skills: string[]): DocumentFragment {
  const fragment = doc.createDocumentFragment();
  if (!text) return fragment;

  let cursor = 0;
  for (const match of text.matchAll(SKILL_TOKEN_PATTERN)) {
    const token = match[0];
    const skillName = match[1] ?? "";
    if (!skills.includes(skillName)) continue;

    const start = match.index ?? 0;
    if (start > cursor) {
      fragment.appendChild(doc.createTextNode(text.slice(cursor, start)));
    }
    fragment.appendChild(createSkillChip(doc, skillName));
    cursor = start + token.length;
  }

  if (cursor < text.length) {
    fragment.appendChild(doc.createTextNode(text.slice(cursor)));
  }
  return fragment;
}
