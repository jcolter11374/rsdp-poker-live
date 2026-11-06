/**
 * The /compare page: what this site offers next to PokerNow's free plan and PokerNow Plus.
 * D28 lets this one page name PokerNow. Keep it dated, factual and fair: keep the rows where
 * PokerNow is ahead, and recheck PokerNow's columns against its plans page when you change them.
 */

/** yes, partly (a limited version), paid (money or coins), planned (on our roadmap), no, unknown (not checked). */
export type Mark = 'yes' | 'partly' | 'paid' | 'planned' | 'no' | 'unknown';
export type Cell = { mark: Mark; note?: string };
export type Row = { feature: string; us: Cell; free: Cell; plus: Cell };
export type Group = { title: string; rows: Row[] };

/** When both columns were last checked: ours against the live site, PokerNow's against its public pages. */
export const CHECKED = '6 November 2026';
export const POKERNOW_PLANS = 'https://www.pokernow.com/subscription/plus';

export const MARKS: Record<Mark, { symbol: string; label: string }> = {
  yes: { symbol: '✓', label: 'Yes' },
  partly: { symbol: '~', label: 'Partly' },
  paid: { symbol: '$', label: 'Costs money or coins' },
  planned: { symbol: '⏳', label: 'Planned' },
  no: { symbol: '✕', label: 'No' },
  unknown: { symbol: '?', label: "Couldn't confirm" },
};

const y = (note?: string): Cell => ({ mark: 'yes', note });
const p = (note?: string): Cell => ({ mark: 'partly', note });
const c = (note?: string): Cell => ({ mark: 'paid', note });
const s = (note?: string): Cell => ({ mark: 'planned', note });
const n = (note?: string): Cell => ({ mark: 'no', note });
const q = (note?: string): Cell => ({ mark: 'unknown', note });

export const GROUPS: Group[] = [
  {
    title: 'Games',
    rows: [
      { feature: "Hold'em, Omaha, Omaha Hi-Lo, 5-card Omaha", us: y(), free: y(), plus: y() },
      { feature: "Stud, Razz, Stud Hi-Lo, 2-7 Triple Draw, Badugi", us: y('A guide for each'), free: n(), plus: n() },
      { feature: 'Game rotation (mixed games)', us: y('Any of our games'), free: c('NOW Coins'), plus: y("Hold'em and Omaha games") },
      { feature: 'HORSE and 8-Game in one tap', us: y('Cash games and tournaments'), free: n(), plus: n() },
      { feature: "Dealer's choice", us: s('On our roadmap'), free: n(), plus: n() },
    ],
  },
  {
    title: 'Side games and the table',
    rows: [
      { feature: 'Run it twice, straddles, rabbit hunt, time bank', us: y(), free: y(), plus: y() },
      { feature: 'Bomb pots, 7-2 bounty, double board', us: y(), free: c('NOW Coins per use'), plus: y() },
      { feature: 'Nit game', us: y('Simpler rules'), free: c('50 coins a game'), plus: y() },
      { feature: 'Chat and emotes', us: y(), free: p('Animated ones cost coins'), plus: p('Animated ones cost coins') },
      { feature: 'Your own avatar picture', us: y(), free: p('Preset avatars only'), plus: y() },
      { feature: 'Felts and card backs', us: y('Several, free'), free: n(), plus: p('4 themes') },
      { feature: 'Voice and video chat', us: n('On our roadmap, last'), free: p('30 minutes a day'), plus: y() },
      { feature: 'Alerts on a locked phone', us: p('Only while a tab is open'), free: q(), plus: p('Tournament alerts') },
      { feature: 'Practice bots with coach tips', us: y(), free: n(), plus: n() },
    ],
  },
  {
    title: 'Tournaments',
    rows: [
      { feature: "Scheduled tournaments and Sit & Gos", us: y(), free: y(), plus: y() },
      { feature: 'Starts by itself at the set time', us: y(), free: n('The host clicks Start'), plus: n('The host clicks Start') },
      { feature: 'Rebuys, add-ons, late registration', us: y(), free: y(), plus: y() },
      { feature: 'Bounty and knockout events, season leaderboards', us: y(), free: n('None found'), plus: n('None found') },
      { feature: 'Players per tournament', us: p('Up to 600, not yet tested beyond a few tables'), free: p('50'), plus: p('300') },
    ],
  },
  {
    title: 'Records',
    rows: [
      { feature: 'Ledger and settle-up', us: y(), free: y(), plus: y() },
      { feature: 'Hand replayer with filters, saved hands', us: y(), free: p('Basic replayer'), plus: y() },
      { feature: 'How long hands are kept', us: y('Forever'), free: p('Limited'), plus: y('Unlimited') },
      { feature: 'Player notes', us: y(), free: n(), plus: y('With colours') },
      { feature: 'Hand highlights', us: y(), free: p('1 a session, kept 7 days'), plus: y('5 a session') },
      { feature: 'Stats, profit graph, leaderboard', us: y(), free: q(), plus: y() },
      { feature: 'AI game analysis', us: n('Left out on purpose'), free: n(), plus: y('"Sam Says"') },
    ],
  },
  {
    title: 'Trust, cost and track record',
    rows: [
      { feature: 'Check for yourself that a deal was fair', us: y('You still trust John to run the server honestly'), free: n('None published'), plus: n('None published') },
      { feature: 'No ads or promotions', us: y(), free: n(), plus: p('Hidden for you only') },
      { feature: 'Clubs', us: n('Left out on purpose'), free: n('Join only'), plus: p('2 clubs of 10') },
      { feature: 'Price', us: y('Free'), free: y('Free'), plus: c('$9.99 a month') },
      { feature: 'Track record', us: p('Live since October 2026, on one small server, no big night yet'), free: y('Since 2017'), plus: y('Since 2017') },
    ],
  },
];
