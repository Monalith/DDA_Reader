// Tiny dependency-free markdown renderer: headings, paragraphs, bullet / ordered
// lists, pipe tables, fenced code blocks, inline code, bold and italic.
// Deliberately minimal — it only has to render src/guide/*.md.
import type { ReactNode } from 'react';

/** Split `**bold**`, `*italic*` and `` `code` `` out of a line of text. */
function inline(src: string, keyBase: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /`([^`]+)`|\*\*([^*]+)\*\*|\*([^*]+)\*/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(src))) {
    if (m.index > last) out.push(src.slice(last, m.index));
    const key = `${keyBase}-i${i++}`;
    if (m[1] !== undefined) out.push(<code key={key}>{m[1]}</code>);
    else if (m[2] !== undefined) out.push(<strong key={key}>{m[2]}</strong>);
    else out.push(<em key={key}>{m[3]}</em>);
    last = m.index + m[0].length;
  }
  if (last < src.length) out.push(src.slice(last));
  return out;
}

function cells(row: string): string[] {
  const t = row.trim().replace(/^\|/, '').replace(/\|$/, '');
  return t.split('|').map((c) => c.trim());
}

const isDivider = (row: string) => /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(row) && row.includes('-');

export default function Markdown({ source, className }: { source: string; className?: string }) {
  const lines = source.replace(/\r\n/g, '\n').split('\n');
  const out: ReactNode[] = [];
  let i = 0;
  let k = 0;
  const key = () => `md-${k++}`;

  while (i < lines.length) {
    const line = lines[i];

    // blank
    if (!line.trim()) {
      i += 1;
      continue;
    }

    // fenced code
    if (/^\s*```/.test(line)) {
      const body: string[] = [];
      i += 1;
      while (i < lines.length && !/^\s*```/.test(lines[i])) body.push(lines[i++]);
      i += 1; // closing fence
      out.push(
        <pre className="md-pre" key={key()}>
          <code>{body.join('\n')}</code>
        </pre>,
      );
      continue;
    }

    // heading
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      const level = h[1].length;
      const text = inline(h[2].trim(), `h${k}`);
      const kk = key();
      if (level === 1) out.push(<h1 key={kk}>{text}</h1>);
      else if (level === 2) out.push(<h2 key={kk}>{text}</h2>);
      else if (level === 3) out.push(<h3 key={kk}>{text}</h3>);
      else if (level === 4) out.push(<h4 key={kk}>{text}</h4>);
      else if (level === 5) out.push(<h5 key={kk}>{text}</h5>);
      else out.push(<h6 key={kk}>{text}</h6>);
      i += 1;
      continue;
    }

    // table: header row + divider
    if (line.includes('|') && i + 1 < lines.length && isDivider(lines[i + 1])) {
      const head = cells(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) rows.push(cells(lines[i++]));
      const tkey = key();
      out.push(
        <table className="md-table" key={tkey}>
          <thead>
            <tr>
              {head.map((c, ci) => (
                <th key={ci}>{inline(c, `${tkey}-h${ci}`)}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, ri) => (
              <tr key={ri}>
                {r.map((c, ci) => (
                  <td key={ci}>{inline(c, `${tkey}-${ri}-${ci}`)}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>,
      );
      continue;
    }

    // bullet list
    if (/^\s*[-*+]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*[-*+]\s+/, ''));
        i += 1;
        // continuation lines of the same item
        while (i < lines.length && lines[i].trim() && !/^\s*([-*+]|\d+\.)\s+/.test(lines[i]) && !/^\s*#/.test(lines[i]) && !lines[i].includes('|')) {
          items[items.length - 1] += ` ${lines[i].trim()}`;
          i += 1;
        }
      }
      const lkey = key();
      out.push(
        <ul className="md-ul" key={lkey}>
          {items.map((it, ii) => (
            <li key={ii}>{inline(it, `${lkey}-${ii}`)}</li>
          ))}
        </ul>,
      );
      continue;
    }

    // ordered list
    if (/^\s*\d+\.\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*\d+\.\s+/, ''));
        i += 1;
        while (i < lines.length && lines[i].trim() && !/^\s*([-*+]|\d+\.)\s+/.test(lines[i]) && !/^\s*#/.test(lines[i]) && !lines[i].includes('|')) {
          items[items.length - 1] += ` ${lines[i].trim()}`;
          i += 1;
        }
      }
      const lkey = key();
      out.push(
        <ol className="md-ol" key={lkey}>
          {items.map((it, ii) => (
            <li key={ii}>{inline(it, `${lkey}-${ii}`)}</li>
          ))}
        </ol>,
      );
      continue;
    }

    // paragraph: consume until a blank line or a block start
    const para: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() &&
      !/^\s*#/.test(lines[i]) &&
      !/^\s*```/.test(lines[i]) &&
      !/^\s*([-*+]|\d+\.)\s+/.test(lines[i]) &&
      !(lines[i].includes('|') && i + 1 < lines.length && isDivider(lines[i + 1]))
    ) {
      para.push(lines[i].trim());
      i += 1;
    }
    const pkey = key();
    out.push(<p key={pkey}>{inline(para.join(' '), pkey)}</p>);
  }

  return (
    <div className={className ? `md ${className}` : 'md'} data-testid="markdown">
      {out}
    </div>
  );
}
