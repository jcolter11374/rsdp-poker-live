const SUIT_SYMBOL: Record<string, string> = { c: '♣', d: '♦', h: '♥', s: '♠' };

export function PlayingCard({ card, small }: { card: string | null; small?: boolean }) {
  const size = small ? ' small' : '';
  if (!card) return <div className={`playing-card back${size}`} />;
  const rank = card[0] === 'T' ? '10' : card[0];
  const suit = card[1];
  return (
    <div className={`playing-card suit-${suit}${size}`}>
      <span className="rank">{rank}</span>
      <span className="suit">{SUIT_SYMBOL[suit]}</span>
    </div>
  );
}
