import { Fragment, type ReactNode } from 'react';

// Just enough Markdown for docs/FAIRNESS.md, turned into React elements (never
// raw HTML): headings, paragraphs, lists, tables, code blocks, quotes (shown as
// a box), and inline code, bold, italics and links.

export type Block =
  | { t: 'h'; level: number; text: string }
  | { t: 'p'; text: string }
  | { t: 'ul' | 'ol'; items: string[] }
  | { t: 'code'; text: string }
  | { t: 'table'; head: string[]; rows: string[][] }
  | { t: 'box'; blocks: Block[] };

const cells = (line: string) =>
  line
    .trim()
    .replace(/^\||\|$/g, '')
    .split('|')
    .map((c) => c.trim());

export function parseBlocks(md: string): Block[] {
  const lines = md.replace(/\r/g, '').split('\n');
  const out: Block[] = [];
  for (let i = 0; i < lines.length; ) {
    const line = lines[i];
    if (!line.trim()) {
      i++;
    } else if (line.startsWith('```')) {
      const body: string[] = [];
      for (i++; i < lines.length && !lines[i].startsWith('```'); i++) body.push(lines[i]);
      out.push({ t: 'code', text: body.join('\n') });
      i++;
    } else if (line.startsWith('>')) {
      const body: string[] = [];
      for (; i < lines.length && lines[i].startsWith('>'); i++) body.push(lines[i].replace(/^> ?/, ''));
      out.push({ t: 'box', blocks: parseBlocks(body.join('\n')) });
    } else if (/^#{1,6} /.test(line)) {
      const m = /^(#+) (.*)$/.exec(line)!;
      out.push({ t: 'h', level: m[1].length, text: m[2] });
      i++;
    } else if (line.startsWith('|')) {
      const head = cells(line);
      const rows: string[][] = [];
      for (i += 2; i < lines.length && lines[i].startsWith('|'); i++) rows.push(cells(lines[i]));
      out.push({ t: 'table', head, rows });
    } else if (/^(- |\d+\. )/.test(line)) {
      const t = line.startsWith('- ') ? 'ul' : 'ol';
      const items: string[] = [];
      while (i < lines.length && (/^(- |\d+\. )/.test(lines[i]) || (/^ {2,}\S/.test(lines[i]) && items.length))) {
        if (/^(- |\d+\. )/.test(lines[i])) items.push(lines[i].replace(/^(- |\d+\. )/, ''));
        else items[items.length - 1] += ' ' + lines[i].trim();
        i++;
      }
      out.push({ t, items });
    } else {
      const para: string[] = [];
      for (; i < lines.length && lines[i].trim() && !/^(#|- |\d+\. |\||```|>)/.test(lines[i]); i++) para.push(lines[i].trim());
      out.push({ t: 'p', text: para.join(' ') });
    }
  }
  return out;
}

/** `code`, **bold**, *italic*, [text](url); `link` maps a link target (relative ones to the source on GitHub). */
export function inline(text: string, link: (href: string) => string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /`([^`]+)`|\*\*(.+?)\*\*|\*(.+?)\*|\[([^\]]+)\]\(([^)]+)\)/g;
  let last = 0;
  let k = 0;
  for (let m; (m = re.exec(text)); ) {
    if (m.index > last) out.push(text.slice(last, m.index));
    if (m[1] !== undefined) out.push(<code key={k++}>{m[1]}</code>);
    else if (m[2] !== undefined) out.push(<strong key={k++}>{inline(m[2], link)}</strong>);
    else if (m[3] !== undefined) out.push(<em key={k++}>{inline(m[3], link)}</em>);
    else {
      const href = link(m[5]);
      out.push(
        <a key={k++} href={href} {...(/^https?:/.test(href) ? { target: '_blank', rel: 'noreferrer' } : {})}>
          {inline(m[4], link)}
        </a>,
      );
    }
    last = re.lastIndex;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export function Markdown({ source, link }: { source: string; link: (href: string) => string }) {
  return <Blocks blocks={parseBlocks(source)} link={link} />;
}

function Blocks({ blocks, link }: { blocks: Block[]; link: (href: string) => string }) {
  const md = (s: string) => inline(s, link);
  return (
    <>
      {blocks.map((b, i) => {
        switch (b.t) {
          case 'h': {
            const H = `h${Math.min(b.level, 4)}` as 'h1';
            // An id from the words, so a section can be linked (#checking-john).
            const id = b.text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
            return (
              <H key={i} id={id}>
                {md(b.text)}
              </H>
            );
          }
          case 'p':
            return <p key={i}>{md(b.text)}</p>;
          case 'ul':
          case 'ol': {
            const L = b.t;
            return (
              <L key={i}>
                {b.items.map((it, j) => (
                  <li key={j}>{md(it)}</li>
                ))}
              </L>
            );
          }
          case 'code':
            return (
              <pre key={i}>
                <code>{b.text}</code>
              </pre>
            );
          case 'table':
            return (
              <div key={i} className="md-table">
                <table>
                  <thead>
                    <tr>
                      {b.head.map((c, j) => (
                        <th key={j}>{md(c)}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {b.rows.map((r, j) => (
                      <tr key={j}>
                        {r.map((c, n) => (
                          <td key={n}>{md(c)}</td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
          case 'box':
            return (
              <aside key={i} className="md-box">
                <Blocks blocks={b.blocks} link={link} />
              </aside>
            );
          default:
            return <Fragment key={i} />;
        }
      })}
    </>
  );
}
