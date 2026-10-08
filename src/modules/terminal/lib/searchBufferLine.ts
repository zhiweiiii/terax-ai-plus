import type { IBufferLine } from "@xterm/xterm";

export function searchBufferLine(
  line: IBufferLine,
  query: string,
  limit: number,
): { col: number; len: number }[] {
  if (!query || limit <= 0) return [];
  const text = line.translateToString(true).toLowerCase();
  const needle = query.toLowerCase();
  if (!text.includes(needle)) return [];
  const starts: number[] = [];
  const ends: number[] = [];
  let offset = 0;
  for (let col = 0; col < line.length && offset < text.length; col++) {
    const cell = line.getCell(col);
    if (!cell || cell.getWidth() === 0) continue;
    const length = (cell.getChars() || " ").toLowerCase().length;
    for (let i = 0; i < length && offset < text.length; i++, offset++) {
      starts[offset] = col;
      ends[offset] = col + cell.getWidth();
    }
  }
  const matches: { col: number; len: number }[] = [];
  let from = 0;
  while (matches.length < limit) {
    const index = text.indexOf(needle, from);
    if (index < 0) break;
    const col = starts[index];
    const end = ends[index + needle.length - 1];
    if (col !== undefined && end !== undefined)
      matches.push({ col, len: end - col });
    from = index + needle.length;
  }
  return matches;
}
