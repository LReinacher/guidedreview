/**
 * Command-click go-to-definition for the diff pane.
 *
 * Holding the platform modifier turns identifiers into targets (underline +
 * pointer, the editor gesture); clicking one opens a preview of where it is
 * declared. Nothing here assumes a host can answer: declarations found in the
 * reviewed diff render immediately, and a host that can search the repo fills
 * the rest in when it responds.
 */

import { useCallback, useEffect, useRef, useState, type MouseEvent, type RefObject } from "react";
import { useReviewHost, type SymbolDefinition } from "./host";
import { useReviewStore } from "./store";
import { findDefinitionsInDiff, mergeDefinitions } from "./symbolNav";
import { tokenAtPoint, type CodeToken } from "./symbolDom";

export type SymbolLookupStatus = "loading" | "ready" | "empty" | "error";

/** Where the preview is anchored: the clicked token's viewport box. */
export interface TokenAnchor {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

export interface SymbolLookup {
  name: string;
  /** File the click came from. */
  fromPath: string;
  anchor: TokenAnchor;
  status: SymbolLookupStatus;
  definitions: SymbolDefinition[];
  /** Which definition the preview is showing. */
  index: number;
}

export interface SymbolNavigation {
  lookup: SymbolLookup | null;
  /**
   * Boxes to underline: the identifier under the pointer while the modifier is
   * held, one box per line it wraps onto.
   */
  hovered: TokenAnchor[] | null;
  modifierHeld: boolean;
  cardRef: RefObject<HTMLDivElement | null>;
  onClickCapture: (event: MouseEvent) => void;
  onMouseMove: (event: MouseEvent) => void;
  onMouseLeave: () => void;
  showDefinition: (index: number) => void;
  close: () => void;
}

function anchorOf(rect: DOMRect): TokenAnchor {
  return { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right };
}

function sameAnchors(a: TokenAnchor[] | null, b: TokenAnchor[] | null): boolean {
  if (!a || !b) return a === b;
  if (a.length !== b.length) return false;
  return a.every((box, i) => {
    const other = b[i]!;
    return box.top === other.top && box.left === other.left && box.right === other.right;
  });
}

/**
 * The go-to-definition modifier: ⌘ on a Mac, Ctrl elsewhere — and either one
 * accepted whatever the platform, because a browser reporting one OS while
 * running on another should not silently cost the user the gesture.
 */
function isNavModifier(event: { metaKey: boolean; ctrlKey: boolean }): boolean {
  return event.metaKey || event.ctrlKey;
}

/** Did this event happen inside the preview card itself? */
function isInsideCard(card: HTMLElement | null, event: Event): boolean {
  if (!card) return false;
  if (event.composedPath().includes(card)) return true;
  return event.target instanceof Node && card.contains(event.target);
}

/**
 * The open preview card, as a module singleton — the same shape the
 * confirmation dialog uses. The overlay's keyboard handler owns every key from
 * a window capture listener, so it has to be able to see this card and hand
 * Esc and Tab over to it.
 */
let activePreview: { element: HTMLElement | null; close: () => void } | null = null;

export function isDefinitionPreviewOpen(): boolean {
  return activePreview !== null;
}

export function getDefinitionPreviewElement(): HTMLElement | null {
  return activePreview?.element ?? null;
}

export function closeDefinitionPreview(): void {
  activePreview?.close();
}

export function useSymbolNavigation(): SymbolNavigation {
  const host = useReviewHost();
  const [lookup, setLookup] = useState<SymbolLookup | null>(null);
  const [hovered, setHovered] = useState<TokenAnchor[] | null>(null);
  const [modifierHeld, setModifierHeld] = useState(false);
  const cardRef = useRef<HTMLDivElement | null>(null);
  /** Bumped per lookup so a slow host answer cannot land on a newer click. */
  const requestRef = useRef(0);
  const frameRef = useRef(0);
  /**
   * Where the pointer last was over the diff. Tracked unconditionally so that
   * pressing the modifier underlines the symbol already under the cursor —
   * in an editor the affordance appears on the key, not on the next twitch.
   */
  const pointerRef = useRef<{ target: EventTarget | null; x: number; y: number } | null>(null);

  const close = useCallback(() => {
    requestRef.current += 1;
    setLookup(null);
  }, []);

  const refreshHover = useCallback((): void => {
    const pointer = pointerRef.current;
    if (!pointer) return;
    const token = tokenAtPoint(pointer.target, pointer.x, pointer.y);
    const next = token && token.rects.length > 0 ? token.rects.map(anchorOf) : null;
    setHovered((prev) => (sameAnchors(prev, next) ? prev : next));
  }, []);

  // The modifier is what makes tokens clickable, so its state has to survive
  // the pointer never moving — hence key listeners rather than event.metaKey.
  useEffect(() => {
    function onKey(event: KeyboardEvent): void {
      const held = isNavModifier(event);
      setModifierHeld(held);
      if (held) refreshHover();
      else setHovered(null);
    }
    function clearHover(): void {
      setModifierHeld(false);
      setHovered(null);
    }
    // The underline is drawn in viewport coordinates, so a scroll leaves it
    // pointing at whatever moved into that spot. Drop it and wait for the
    // next move.
    function onScroll(): void {
      setHovered(null);
    }
    // Capture, because the overlay's own key handler runs in the capture phase
    // and stops propagation on everything so the host page never sees a key.
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("keyup", onKey, true);
    window.addEventListener("blur", clearHover);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("keyup", onKey, true);
      window.removeEventListener("blur", clearHover);
      window.removeEventListener("scroll", onScroll, true);
      cancelAnimationFrame(frameRef.current);
    };
  }, [refreshHover]);

  // The card is positioned against a viewport rect, so anything that moves the
  // diff underneath it invalidates the anchor. Closing beats floating loose —
  // but scrolling *inside* the card is reading, not leaving.
  useEffect(() => {
    if (!lookup) {
      activePreview = null;
      return;
    }
    activePreview = { element: cardRef.current, close };
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === "Escape") {
        event.stopPropagation();
        close();
      }
    }
    function onPointerDown(event: Event): void {
      if (isInsideCard(cardRef.current, event)) return;
      close();
    }
    function onScroll(event: Event): void {
      if (isInsideCard(cardRef.current, event)) return;
      close();
    }
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", close);
    return () => {
      activePreview = null;
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", close);
    };
  }, [lookup, close]);

  const runLookup = useCallback(
    async (token: CodeToken): Promise<void> => {
      const request = (requestRef.current += 1);
      const { diff, prContext } = useReviewStore.getState();
      const inDiff = diff
        ? findDefinitionsInDiff(diff, token.name, token.filePath, token.line)
        : [];
      const merged = mergeDefinitions([], inDiff);
      const canAskHost = Boolean(host.findDefinition && prContext);

      setLookup({
        name: token.name,
        fromPath: token.filePath,
        anchor: anchorOf(token.rect),
        status: canAskHost ? "loading" : merged.length > 0 ? "ready" : "empty",
        definitions: merged,
        index: 0,
      });

      if (!host.findDefinition || !prContext) return;
      try {
        const fromHost = await host.findDefinition({
          symbol: token.name,
          fromPath: token.filePath,
          fromLine: token.line,
          context: prContext,
        });
        if (request !== requestRef.current) return;
        const all = mergeDefinitions(fromHost, inDiff);
        setLookup((prev) =>
          prev
            ? { ...prev, definitions: all, index: 0, status: all.length > 0 ? "ready" : "empty" }
            : prev,
        );
      } catch {
        if (request !== requestRef.current) return;
        setLookup((prev) =>
          prev ? { ...prev, status: prev.definitions.length > 0 ? "ready" : "error" } : prev,
        );
      }
    },
    [host],
  );

  const onClickCapture = useCallback(
    (event: MouseEvent): void => {
      if (!isNavModifier(event) || event.button !== 0) return;
      const token = tokenAtPoint(event.target, event.clientX, event.clientY);
      if (!token) return;
      // Stop the click before the diff treats it as a line interaction.
      event.preventDefault();
      event.stopPropagation();
      setHovered(null);
      void runLookup(token);
    },
    [runLookup],
  );

  const onMouseMove = useCallback(
    (event: MouseEvent): void => {
      pointerRef.current = { target: event.target, x: event.clientX, y: event.clientY };
      if (!isNavModifier(event)) {
        setHovered((prev) => (prev ? null : prev));
        return;
      }
      cancelAnimationFrame(frameRef.current);
      frameRef.current = requestAnimationFrame(refreshHover);
    },
    [refreshHover],
  );

  const onMouseLeave = useCallback((): void => {
    cancelAnimationFrame(frameRef.current);
    pointerRef.current = null;
    setHovered(null);
  }, []);

  const showDefinition = useCallback((index: number): void => {
    setLookup((prev) => (prev ? { ...prev, index } : prev));
  }, []);

  return {
    lookup,
    hovered,
    modifierHeld,
    cardRef,
    onClickCapture,
    onMouseMove,
    onMouseLeave,
    showDefinition,
    close,
  };
}
