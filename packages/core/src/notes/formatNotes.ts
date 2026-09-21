import type { ReviewNote } from "../types";

function lineRangeLabel(note: ReviewNote): string {
  const { startLine, endLine } = note;
  if (startLine === undefined || endLine === undefined) return note.filePath;
  if (startLine === endLine) return `${note.filePath}:L${startLine}`;
  return `${note.filePath}:L${startLine}–L${endLine}`;
}

/**
 * Format local review notes as markdown for copy/export. Hosts must not
 * invent a second formatter.
 */
export function formatNotesMarkdown(notes: ReviewNote[]): string {
  if (notes.length === 0) return "";

  const sections = notes.map((note) => {
    const body = note.body.trim();
    return `## ${lineRangeLabel(note)}\n\n${body}`;
  });

  return `# Review notes\n\n${sections.join("\n\n")}\n`;
}
