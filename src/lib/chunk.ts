// Splits extracted document text into overlapping, paragraph-aligned chunks
// small enough to embed and retrieve individually, but large enough to keep
// a rule's surrounding context (exceptions, timing, cross-references) intact.
const MAX_WORDS = 220;
const OVERLAP_WORDS = 40;

// A single "paragraph" (no blank-line break in the source) can still be far
// bigger than MAX_WORDS - e.g. plain-text extraction of a forum page/thread
// dump with no real paragraph breaks between posts. Without this, such a
// paragraph would sail straight through the loop below as one oversized,
// unsplit chunk (the loop only checks size *before* adding a new paragraph
// to what's already accumulated, so a single already-too-big paragraph
// never gets split on its own).
function splitOversizedParagraph(paragraph: string): string[] {
  const words = paragraph.split(/\s+/);
  if (words.length <= MAX_WORDS) return [paragraph];

  const pieces: string[] = [];
  let start = 0;
  while (start < words.length) {
    const end = Math.min(start + MAX_WORDS, words.length);
    pieces.push(words.slice(start, end).join(" "));
    if (end >= words.length) break;
    start = end - OVERLAP_WORDS;
  }
  return pieces;
}

export function chunkText(text: string): string[] {
  const paragraphs = text
    .split(/\n{2,}/)
    .map((p) => p.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .flatMap(splitOversizedParagraph);

  const chunks: string[] = [];
  let current: string[] = [];
  let currentWordCount = 0;

  const flush = () => {
    if (current.length) chunks.push(current.join("\n\n"));
  };

  for (const paragraph of paragraphs) {
    const wordCount = paragraph.split(/\s+/).length;

    if (currentWordCount + wordCount > MAX_WORDS && current.length) {
      flush();
      const overlapText = current.join(" ").split(/\s+/).slice(-OVERLAP_WORDS).join(" ");
      current = overlapText ? [overlapText] : [];
      currentWordCount = overlapText ? overlapText.split(/\s+/).length : 0;
    }

    current.push(paragraph);
    currentWordCount += wordCount;
  }
  flush();

  return chunks;
}
