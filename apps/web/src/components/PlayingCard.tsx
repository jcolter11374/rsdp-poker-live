import type { CSSProperties } from 'react';

const SUIT_SYMBOL: Record<string, string> = { c: '♣', d: '♦', h: '♥', s: '♠' };

export const suitSymbol = (s: string) => SUIT_SYMBOL[s] ?? s;

/** A card face, or its back when the card is hidden ('??' or null). */
export function PlayingCard({
  card,
  small,
  className = '',
  style,
  onClick,
  title,
}: {
  card: string | null;
  small?: boolean;
  className?: string;
  style?: CSSProperties;
  onClick?: () => void;
  title?: string;
}) {
  const cls = `playing-card${small ? ' small' : ''}${onClick ? ' clickable' : ''} ${className}`;
  if (!card || card === '??') return <div className={`${cls} back`} style={style} onClick={onClick} title={title} />;
  const rank = card[0] === 'T' ? '10' : card[0];
  const suit = card[1];
  return (
    <div className={`${cls} suit-${suit}`} style={style} onClick={onClick} title={title}>
      <span className="rank">{rank}</span>
      <span className="suit">{suitSymbol(suit)}</span>
    </div>
  );
}

/** Log text with [Ah]-style cards drawn as small inline cards. */
export function LogText({ text }: { text: string }) {
  const parts = text.split(/(\[[2-9TJQKA][cdhs]\])/);
  return (
    <>
      {parts.map((p, i) =>
        /^\[[2-9TJQKA][cdhs]\]$/.test(p) ? (
          <span key={i} className={`log-card suit-${p[2]}`}>
            {p[1] === 'T' ? '10' : p[1]}
            {suitSymbol(p[2])}
          </span>
        ) : (
          p
        ),
      )}
    </>
  );
}
