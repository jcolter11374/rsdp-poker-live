/** A table log line as the server sends it. */
export interface LogLine {
  text: string;
}

const SAT = /^(?:(.+)'s practice bot )?(.+) sat down in seat \d+ with .+$/;

/**
 * The table log with runs of three or more "sat down" lines folded into one,
 * so a table that fills up at once opens on "6 players sat down" instead of
 * six near-identical lines. `full` keeps the original lines for a tooltip.
 */
export function groupLog(lines: readonly LogLine[]): { text: string; full?: string }[] {
  const out: { text: string; full?: string }[] = [];
  for (let i = 0; i < lines.length; ) {
    let j = i;
    while (j < lines.length && SAT.test(lines[j].text)) j++;
    if (j - i >= 3) {
      const names = lines.slice(i, j).map((l) => {
        const [, owner, name] = l.text.match(SAT)!;
        return owner ? `${name} (bot)` : name;
      });
      out.push({ text: `${names.length} players sat down: ${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`, full: lines.slice(i, j).map((l) => l.text).join('\n') });
      i = j;
    } else {
      out.push({ text: lines[i].text });
      i++;
    }
  }
  return out;
}
