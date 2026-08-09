import type { Session } from "./harness.ts";

/**
 * The mobile layout invariants, checked against whatever is on screen right
 * now.
 *
 * These are *global rules applied to every element*, not per-page selectors,
 * and that's the whole reason this layer is cheap enough to gate merges on.
 * There is no selector to keep in sync with the markup, so it can't rot into
 * the class of harness bug that makes DOM assertions untrustworthy here -- it
 * either finds a violation or it doesn't, and a new page is covered the moment
 * somebody adds it to the route list.
 *
 * Every rule below corresponds to a defect this app actually shipped:
 *
 *   - the FAB covering the last row of both tabs at full scroll
 *   - a support badge wrapping to two lines mid-row
 *   - "Invite by email (optional)" clipped by its own field after the 16px bump
 *   - `inline-block` on an `<a class="btn-*">` beating `inline-flex`, because
 *     the component classes are unlayered and so outrank Tailwind's utilities
 *   - six 16px checkbox labels in the day-setup sheet, close enough together
 *     that one thumb covered two people's names
 *   - "Sign out" wrapping next to a long name
 *
 * Not one of them is visible to a unit test, and none of them is pixel drift,
 * which is why this is a rule checker rather than screenshot comparison.
 */

export type Violation = {
  rule: string;
  detail: string;
};

/** iOS Safari zooms the viewport on focus below this, and never zooms back. */
const MIN_FONT_PX = 16;
/** The conventional minimum comfortable touch target. */
const MIN_TARGET_PX = 44;

export async function layoutViolations(session: Session): Promise<Violation[]> {
  return session.page.evaluate(
    ({ minFont, minTarget }) => {
      const found: { rule: string; detail: string }[] = [];
      const describe = (el: Element) => {
        const text = (el.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 40);
        const placeholder = (el as HTMLInputElement).placeholder ?? "";
        const name = (el as HTMLInputElement).name ?? "";
        return `<${el.tagName.toLowerCase()}${name ? ` name=${name}` : ""}>${
          text || placeholder ? ` "${text || placeholder}"` : ""
        }`;
      };

      /**
       * Skips anything not actually on screen: display:none (which is what a
       * closed <dialog> is, and the reason a naive sweep counts fields nobody
       * can see), visibility:hidden, and zero-size boxes. Also skips
       * screen-reader-only text, which is deliberately 1px and would otherwise
       * look like a tiny target.
       */
      const onScreen = (el: Element): boolean => {
        const box = el.getBoundingClientRect();
        if (box.width === 0 || box.height === 0) return false;
        if (box.width <= 1 && box.height <= 1) return false;
        const style = getComputedStyle(el);
        if (style.display === "none" || style.visibility === "hidden") return false;
        if (style.opacity === "0") return false;
        return true;
      };

      // --- 1 & 2: touch targets and the iOS zoom threshold ------------------
      const interactive = document.querySelectorAll(
        "a[href], button, input, select, textarea, [role=button], [tabindex]:not([tabindex='-1'])",
      );
      for (const el of interactive) {
        const input = el as HTMLInputElement;
        if (input.type === "hidden") continue;
        if (!onScreen(el)) continue;

        // For a checkbox or radio the thing a thumb lands on is the label
        // wrapping it, not the ~13px box the browser draws. Measuring the box
        // reports a violation nobody can fix; measuring the label reports the
        // real one, which is how the day-setup sheet's six were found.
        const isBox = input.type === "checkbox" || input.type === "radio";
        const target = isBox ? (el.closest("label") ?? el) : el;
        // Rounded, not raw: layout routinely lands on 43.996px, which is 44px
        // to every thumb but fails a strict compare -- and a rule that reports
        // "is 44px tall (min 44)" is one nobody trusts for long.
        const height = Math.round(target.getBoundingClientRect().height);
        if (height < minTarget) {
          found.push({
            rule: "touch-target",
            detail: `${describe(el)} is ${height}px tall (min ${minTarget})`,
          });
        }

        // Only text entry zooms; a checkbox or a file picker has no text to
        // size, and forcing 16px on them means nothing.
        const typesWithoutText = ["checkbox", "radio", "file", "range", "color", "submit", "button"];
        if (
          /^(INPUT|SELECT|TEXTAREA)$/.test(el.tagName) &&
          !typesWithoutText.includes(input.type)
        ) {
          const fontSize = parseFloat(getComputedStyle(el).fontSize);
          // Same sub-pixel tolerance as above; the threshold is what iOS
          // compares against, not a design token to police to four decimals.
          if (Math.round(fontSize * 100) / 100 < minFont) {
            found.push({
              rule: "ios-zoom-font",
              detail: `${describe(el)} is ${fontSize}px (min ${minFont})`,
            });
          }
        }
      }

      // --- 3: the page itself must not scroll sideways ----------------------
      const doc = document.documentElement;
      if (doc.scrollWidth > doc.clientWidth) {
        // Name the widest offender, or the report is a dead end.
        let worst: { el: Element; right: number } | null = null;
        for (const el of document.querySelectorAll("body *")) {
          if (!onScreen(el)) continue;
          const right = el.getBoundingClientRect().right;
          if (right > doc.clientWidth && (!worst || right > worst.right)) worst = { el, right };
        }
        found.push({
          rule: "horizontal-overflow",
          detail:
            `document scrolls to ${doc.scrollWidth}px in a ${doc.clientWidth}px viewport` +
            (worst ? `; widest is ${describe(worst.el)} reaching ${Math.round(worst.right)}px` : ""),
        });
      }

      // --- 4: a placeholder must fit the field it's in ----------------------
      // Measured rather than guessed: the 16px bump silently truncated
      // "Invite by email (optional)" and nothing caught it, because the field
      // was the right size for the old type scale.
      //
      // <input> only. A textarea wraps its placeholder over as many lines as
      // it has, so single-line width says nothing about whether it's cut off
      // -- checking it flagged a two-row notes field that renders perfectly.
      const canvas = document.createElement("canvas");
      const ctx = canvas.getContext("2d");
      if (ctx) {
        for (const el of document.querySelectorAll("input[placeholder]")) {
          if (!onScreen(el)) continue;
          const field = el as HTMLInputElement;
          const style = getComputedStyle(field);
          ctx.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
          const textWidth = ctx.measureText(field.placeholder).width;
          const usable =
            field.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
          if (textWidth > usable) {
            found.push({
              rule: "clipped-placeholder",
              detail: `${describe(field)} needs ${Math.ceil(textWidth)}px but has ${Math.floor(usable)}px`,
            });
          }
        }
      }

      return found;
    },
    { minFont: MIN_FONT_PX, minTarget: MIN_TARGET_PX },
  );
}

/** Renders violations as something a failing CI log can be read from. */
export function formatViolations(where: string, violations: Violation[]): string {
  return [
    `${violations.length} layout violation(s) at ${where}:`,
    ...violations.map((v) => `  [${v.rule}] ${v.detail}`),
  ].join("\n");
}
