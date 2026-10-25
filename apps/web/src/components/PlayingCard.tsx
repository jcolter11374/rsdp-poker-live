import type { CSSProperties, KeyboardEvent } from 'react';

const SUIT_SYMBOL: Record<string, string> = { c: '♣', d: '♦', h: '♥', s: '♠' };
const SUIT_NAME: Record<string, string> = { c: 'clubs', d: 'diamonds', h: 'hearts', s: 'spades' };
const RANK_NAME: Record<string, string> = { A: 'Ace', K: 'King', Q: 'Queen', J: 'Jack', T: '10' };

/** "Ace of spades", for screen readers. */
const cardName = (card: string) => `${RANK_NAME[card[0]] ?? card[0]} of ${SUIT_NAME[card[1]] ?? card[1]}`;

export const suitSymbol = (s: string) => SUIT_SYMBOL[s] ?? s;

/** Suits drawn as shapes, so no device swaps in an emoji or an empty box. */
const SUIT_PATH: Record<string, string> = {
  s: 'M12 2C9.2 5.6 4 8.8 4 13.2 4 15.9 6.1 18 8.7 18c1.3 0 2.5-.5 3.1-1.4-.2 2-1 3.6-2.6 4.6h5.6c-1.6-1-2.4-2.6-2.6-4.6.6.9 1.8 1.4 3.1 1.4 2.6 0 4.7-2.1 4.7-4.8C20 8.8 14.8 5.6 12 2z',
  h: 'M12 21.2S3 15.4 3 9.3A4.8 4.8 0 0 1 12 6.6a4.8 4.8 0 0 1 9 2.7c0 6.1-9 11.9-9 11.9z',
  d: 'M12 1.8l7.6 10.2L12 22.2 4.4 12z',
  c: 'M12 2.2a4.3 4.3 0 0 0-3.9 6.1 4.3 4.3 0 1 0 2.4 7.4c-.3 2.3-1.2 4-2.7 5.4h8.4c-1.5-1.4-2.4-3.1-2.7-5.4a4.3 4.3 0 1 0 2.4-7.4A4.3 4.3 0 0 0 12 2.2z',
};

const SuitIcon = ({ suit, className }: { suit: string; className: string }) => (
  <svg className={className} viewBox="0 0 24 24" aria-hidden="true">
    <path d={SUIT_PATH[suit]} fill="currentColor" />
  </svg>
);

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
  const face = !!card && card !== '??';
  const name = face ? cardName(card) : 'Face-down card';
  // A card you can tap (picking draw discards) is a button; otherwise it's a picture of a card.
  const a11y = onClick
    ? {
        role: 'button',
        tabIndex: 0,
        'aria-label': title ? `${name}. ${title}` : name,
        onKeyDown: (e: KeyboardEvent) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onClick();
          }
        },
      }
    : { role: 'img', 'aria-label': name };
  if (!face) return <div className={`${cls} back`} style={style} onClick={onClick} title={title} {...a11y} />;
  const rank = card[0] === 'T' ? '10' : card[0];
  const suit = card[1];
  return (
    <div className={`${cls} suit-${suit}`} style={style} onClick={onClick} title={title} {...a11y}>
      <span className="rank" aria-hidden="true">{rank}</span>
      <SuitIcon suit={suit} className="suit" />
      <SuitIcon suit={suit} className="pip" />
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
