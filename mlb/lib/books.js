'use strict';
/* Every book the MLB odds board knows about, in board order: the sharp books first, then the Las Vegas
   windows, then the national apps. This order and these labels match Hook & Ladder (the college football app). Keys are shared with the client (see the spec).
   Where a book's number comes from, in order of preference (the first fresh source wins):
     an     Action Network web scoreboard, by book id (every ~20 s)
     vsin   VSiN's Vegas line tracker, by column name (every ~2 min; only re-read when its stamp changes)
     pin    Pinnacle's public guest feed (every ~2 min)
     espn   ESPN's scoreboard odds, DraftKings only (every ~60 s), a fallback for Action Network
   `link` and `ios` are where to go to place the bet: the book's own page and its Nevada app in the App Store,
   each one checked to load. You sign in at the book — this app never asks for or holds a sportsbook login.
   Pinnacle, DraftKings and FanDuel don't take Nevada bets, so they carry no link and are reference only. */

const BOOKS = [
  { key: 'cons', name: 'Market consensus', short: 'Market', an: [15], src: ['an', 'an1'] },
  { key: 'open', name: 'Opening line', short: 'Open', an: [30], src: ['an', 'an1'] },
  { key: 'circa', name: 'Circa Sports', short: 'Circa', sharp: true, nv: true, vsin: 'Circa', src: ['vsin'], link: 'https://www.circasports.com/', ios: 'https://apps.apple.com/us/app/circa-sports-nevada/id1463697334' },
  { key: 'pin', name: 'Pinnacle', short: 'Pinnacle', sharp: true, src: ['pin'] },
  { key: 'stn', name: 'Station Casinos', short: 'Station', nv: true, vsin: 'Stations', src: ['vsin', 'an1'], link: 'https://stnsports.com/', ios: 'https://apps.apple.com/us/app/stn-sports-and-race/id6444440650' },
  { key: 'boom', name: "Boomer's", short: "Boomer's", nv: true, vsin: 'Boomers', src: ['vsin'], ios: 'https://apps.apple.com/us/app/boomers-sportsbook-nevada/id6749002754' },
  { key: 'czr', name: 'Caesars', short: 'Caesars', nv: true, an: [49], vsin: 'Caesars', src: ['an', 'vsin', 'an1'], link: 'https://sportsbook.caesars.com/us/nv/bet', ios: 'https://apps.apple.com/us/app/caesars-sportsbook-casino/id1413099571' },
  { key: 'mgm', name: 'BetMGM', short: 'BetMGM', nv: true, an: [444, 75], vsin: 'BetMGM', src: ['an', 'vsin', 'an1'], link: 'https://www.nv.betmgm.com/en/sports', ios: 'https://apps.apple.com/us/app/betmgm-sportsbook-casino/id1430875409' },
  { key: 'sp', name: 'South Point', short: 'S. Point', nv: true, vsin: 'South Point', src: ['vsin'], link: 'https://southpointcasino.com/', ios: 'https://apps.apple.com/us/app/southpoint-sports/id1464581805' },
  { key: 'wg', name: 'Westgate SuperBook', short: 'Westgate', nv: true, vsin: 'Westgate', src: ['vsin'], link: 'https://www.superbook.com/', ios: 'https://apps.apple.com/us/app/the-superbook/id1473895927' },
  { key: 'wynn', name: 'Wynn', short: 'Wynn', nv: true, vsin: 'Wynn', src: ['vsin'], ios: 'https://apps.apple.com/us/app/wynn-sports-nevada/id6476514610' },
  { key: 'dk', name: 'DraftKings', short: 'DK', an: [68], src: ['an', 'espn', 'an1'] },
  { key: 'fd', name: 'FanDuel', short: 'FanDuel', an: [69], src: ['an', 'an1'] },
];

const byKey = Object.fromEntries(BOOKS.map((b) => [b.key, b]));
const AN_IDS = [...new Set(BOOKS.flatMap((b) => b.an || []))];
const BETTABLE = new Set(BOOKS.filter((b) => b.key !== 'cons' && b.key !== 'open').map((b) => b.key));

module.exports = { BOOKS, byKey, AN_IDS, BETTABLE };
