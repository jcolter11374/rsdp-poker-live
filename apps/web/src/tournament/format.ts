import { VARIANT_LIST } from '@rsdp/engine/variants';

export const chips = (n: number) => n.toLocaleString();

/** Countdown text: 4:05, 1:02:03, or 2d 3h for long waits. */
export function countdown(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const d = Math.floor(total / 86400);
  const h = Math.floor((total % 86400) / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (d > 0) return `${d}d ${h}h`;
  const mm = h > 0 ? String(m).padStart(2, '0') : String(m);
  return `${h > 0 ? `${h}:` : ''}${mm}:${String(s).padStart(2, '0')}`;
}

/** "Thu, Oct 29, 7:30 PM" in the viewer's own time zone. */
export function localTime(ms: number): string {
  return new Date(ms).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

export function ordinal(n: number): string {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

export const GAMES: { id: string; name: string }[] = VARIANT_LIST.map((v) => ({ id: v.id, name: v.name }));

export const gameName = (id: string) => GAMES.find((g) => g.id === id)?.name ?? id;

/** Money in the smallest unit (cents) shown as dollars. */
export const money = (cents: number) =>
  (cents / 100).toLocaleString(undefined, { style: 'currency', currency: 'USD', minimumFractionDigits: cents % 100 ? 2 : 0 });

export function blinds(l: { sb: number; bb: number; ante: number; anteType: string }): string {
  const ante = l.anteType === 'none' ? '' : l.anteType === 'big-blind' ? ` · BB ante ${chips(l.ante)}` : ` · ante ${chips(l.ante)}`;
  return `${chips(l.sb)} / ${chips(l.bb)}${ante}`;
}
