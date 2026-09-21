/**
 * Reading a code token out of the rendered diff.
 *
 * Diff lines are painted as highlight.js HTML, so there is no per-identifier
 * element to hang a click on — and wrapping every token in one would double
 * the DOM of the busiest view in the product. Instead the caret position under
 * the pointer is resolved back to an offset in the line's text, and the
 * identifier is read from the string. That also means the same code path works
 * for unhighlighted languages, revealed context lines, and both diff views.
 */

import { identifierAt } from "./symbolNav";

/** Marks the element holding one diff line's code text. Set by `CodeContent`. */
export const CODE_TEXT_ATTR = "data-code-text";

export interface CodeToken {
  name: string;
  filePath: string;
  /** 1-indexed file line the token sits on, when the row carries one. */
  line?: number;
  /** Viewport box of the whole identifier, for anchoring the preview to it. */
  rect: DOMRect;
  /**
   * One box per rendered fragment of the identifier — diff lines soft-wrap
   * mid-token (`break-all`), and the underline has to follow the wrap rather
   * than paint one bar across both halves.
   */
  rects: DOMRect[];
}

interface CaretPoint {
  node: Node;
  offset: number;
}

/**
 * Chrome exposes caret hit-testing on `Document` and — because the extension
 * overlay lives in a Shadow DOM — on `ShadowRoot`. Neither is in the DOM lib
 * types for shadow roots, hence the narrow structural casts.
 */
type CaretHost = {
  caretRangeFromPoint?: (x: number, y: number) => Range | null;
  caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
};

function caretAtPoint(node: Node, x: number, y: number): CaretPoint | null {
  const roots = [node.getRootNode() as unknown as CaretHost, document as unknown as CaretHost];
  for (const root of roots) {
    const range = root.caretRangeFromPoint?.(x, y);
    if (range) return { node: range.startContainer, offset: range.startOffset };
    const position = root.caretPositionFromPoint?.(x, y);
    if (position) return { node: position.offsetNode, offset: position.offset };
  }
  return null;
}

function textNodesOf(element: Element): Text[] {
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    nodes.push(node as Text);
  }
  return nodes;
}

/** Caret position → character offset into the element's full text, or null. */
function offsetInElement(nodes: Text[], caret: CaretPoint): number | null {
  let offset = 0;
  for (const node of nodes) {
    if (node === caret.node) return offset + caret.offset;
    offset += node.data.length;
  }
  // A caret can land on the element itself (between children); its offset is
  // then a child index, which is not a character offset we can use.
  return null;
}

/** Map a character range in the element's text back onto a live DOM Range. */
function rangeForOffsets(nodes: Text[], start: number, end: number): Range | null {
  const range = document.createRange();
  let cursor = 0;
  let started = false;
  for (const node of nodes) {
    const nodeEnd = cursor + node.data.length;
    if (!started && start >= cursor && start <= nodeEnd) {
      range.setStart(node, start - cursor);
      started = true;
    }
    if (started && end >= cursor && end <= nodeEnd) {
      range.setEnd(node, end - cursor);
      return range;
    }
    cursor = nodeEnd;
  }
  return null;
}

/**
 * The identifier under the pointer, or null when the pointer is not over one.
 * `target` is the event target, which is what keeps this cheap enough to run
 * on mouse move.
 */
export function tokenAtPoint(target: EventTarget | null, x: number, y: number): CodeToken | null {
  const element = target instanceof Element ? target.closest(`[${CODE_TEXT_ATTR}]`) : null;
  if (!element) return null;
  const filePath = element.closest("[data-file-path]")?.getAttribute("data-file-path");
  if (!filePath) return null;
  const lineNumber = Number(
    element.closest("[data-line-number]")?.getAttribute("data-line-number"),
  );

  const caret = caretAtPoint(element, x, y);
  if (!caret || !element.contains(caret.node)) return null;

  const nodes = textNodesOf(element);
  const offset = offsetInElement(nodes, caret);
  if (offset == null) return null;

  const text = nodes.map((node) => node.data).join("");
  const identifier = identifierAt(text, offset);
  if (!identifier) return null;

  const range = rangeForOffsets(nodes, identifier.start, identifier.end);
  if (!range) return null;

  return {
    name: identifier.name,
    filePath,
    line: Number.isInteger(lineNumber) && lineNumber > 0 ? lineNumber : undefined,
    rect: range.getBoundingClientRect(),
    rects: [...range.getClientRects()],
  };
}
