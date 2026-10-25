import type { CSSProperties } from 'react';

const SUIT_SYMBOL: Record<string, string> = { c: '♣', d: '♦', h: '♥', s: '♠' };

export function PlayingCard({
  card,
  small,
  className = '',
  style,
}: {
  card: string | null;
  small?: boolean;
  className?: string;
  style?: CSSProperties;
}) {
  const cls = `playing-card${small ? ' small' : ''} ${className}`;
  if (!card) return <div className={`${cls} back`} style={style} />;
  const rank = card[0] === 'T' ? '10' : card[0];
  const suit = card[1];
  return (
    <div className={`${cls} suit-${suit}`} style={style}>
      <span className="rank">{rank}</span>
      <span className="suit">{SUIT_SYMBOL[suit]}</span>
    </div>
  );
}
