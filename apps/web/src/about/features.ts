/** What the /about page highlights. Plain words for friends, not a full feature list (that's the roadmap). */
export interface Feature {
  icon: string;
  title: string;
  detail: string;
  link?: { href: string; label: string };
}

export const FEATURES: Feature[] = [
  {
    icon: '♠',
    title: 'Every game you play, and some new ones',
    detail: "Hold'em, Omaha and Omaha Hi-Lo with 4, 5 or 6 cards, plus Seven Card Stud, Stud Hi-Lo, Razz, 2-7 Triple Draw and Badugi. Each game has a short How to play guide, so nobody has to learn mid-hand.",
    link: { href: '/rules', label: 'Learn the games' },
  },
  {
    icon: '💣',
    title: 'The fun extras, free for everyone',
    detail: 'Bomb pots, the 7-2 bounty, double board, run it twice, straddles and game rotation. Anyone can host a table with them, not just one person in the group.',
  },
  {
    icon: '🏆',
    title: 'Tournaments that start on their own',
    detail: 'Schedule one and it starts at the set time, even if the host is running late. Sit & Gos, bounty and knockout events, rebuys, add-ons and season leaderboards are all there.',
    link: { href: '/tn/new', label: 'Host a tournament' },
  },
  {
    icon: '🤖',
    title: 'Practice bots',
    detail: 'Trying a new game? Play it against bots with play chips first, and take your time with nobody waiting on you.',
  },
  {
    icon: '📈',
    title: 'Stats, leaderboard and hand search',
    detail: 'See how the group stacks up, follow your results over time, and find that one hand everyone is still arguing about. Replay any hand step by step.',
    link: { href: '/leaderboard', label: 'See the leaderboard' },
  },
  {
    icon: '🔒',
    title: 'Fair dealing you can check',
    detail: "Every deck is locked in before the deal, and every player's browser helps shuffle it. Afterwards, anyone can check that a hand was dealt fairly.",
    link: { href: '/fairness', label: 'How fair dealing works' },
  },
  {
    icon: '👤',
    title: 'An account if you want one',
    detail: 'Sign in with Google or a username so your name, picture, notes and history follow you to any device. Guests can still just click the link and play.',
    link: { href: '/signin', label: 'Sign in' },
  },
  {
    icon: '💬',
    title: 'Chat at the table',
    detail: 'Talk trash, call for a bomb pot, or say good game. Chat sits right next to the table on a computer and one tap away on a phone.',
  },
];
