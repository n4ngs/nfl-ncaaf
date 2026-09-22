'use strict';
/* Every sportsbook the app knows about, in the default board order (sharp books first, then the Vegas windows,
   then national apps for reference). To add, rename, reorder or hide a book, edit this list.
   Each viewer can also hide books in the app.

   Eligible source-timed quotes win; each provider stays explicit:
     sharp   Sharp API streaming feed, delivery clocks distinct from source observations
     owls    Owls Insight authenticated streaming feed, supplied by the terminal
     an      Action Network live odds feed, by book id: fast, and the only free source of live in-game lines
     an1     Action Network public-betting feed, by book id (Station Casinos)
     vsin    VSiN's Vegas line tracker, by column name: today's games, refreshed every few minutes
     pin     Pinnacle's public guest feed: the offshore sharp line, cached up to 15 minutes by Pinnacle
     espn    ESPN's odds provider id (DraftKings), used when Action Network is unavailable
   Any book can also take a number you type in at the counter.

   `site` and `ios` are where to go to place the bet: the book's own page and its Nevada app in the App Store,
   each one checked to load. You sign in at the book — this app never asks for or holds a sportsbook login.
   Pinnacle, DraftKings and FanDuel don't take Nevada bets, so they carry no link and are reference only. */

const BOOKS = [
  { key: 'circa', color: '#E03131', name: 'Circa Sports', short: 'Circa', vegas: true, sharp: true, vsin: 'Circa', an: [78], site: 'https://www.circasports.com/', ios: 'https://apps.apple.com/us/app/circa-sports-nevada/id1463697334' },
  { key: 'pin', color: '#2F9E44', name: 'Pinnacle', short: 'Pinnacle', sharp: true, pin: true },
  { key: 'stn', color: '#1971C2', name: 'Station Casinos', short: 'Station', vegas: true, vsin: 'Stations', an1: [18], site: 'https://stnsports.com/', ios: 'https://apps.apple.com/us/app/stn-sports-and-race/id6444440650' },
  { key: 'boom', color: '#F08C00', name: "Boomer's", short: "Boomer's", vegas: true, vsin: 'Boomers', ios: 'https://apps.apple.com/us/app/boomers-sportsbook-nevada/id6749002754' },
  { key: 'czr', color: '#C2A24C', name: 'Caesars', short: 'Caesars', vegas: true, an: [49], vsin: 'Caesars', site: 'https://sportsbook.caesars.com/us/nv/bet', ios: 'https://apps.apple.com/us/app/caesars-sportsbook-casino/id1413099571' },
  { key: 'mgm', color: '#E8A33D', name: 'BetMGM', short: 'BetMGM', vegas: true, an: [444, 75], vsin: 'BetMGM', site: 'https://www.nv.betmgm.com/en/sports', ios: 'https://apps.apple.com/us/app/betmgm-sportsbook-casino/id1430875409' },
  { key: 'sp', color: '#7048E8', name: 'South Point', short: 'S. Point', vegas: true, vsin: 'South Point', an: [31], site: 'https://southpointcasino.com/', ios: 'https://apps.apple.com/us/app/southpoint-sports/id1464581805' },
  { key: 'wg', color: '#0CA678', name: 'Westgate SuperBook', short: 'Westgate', vegas: true, vsin: 'Westgate', an: [14], site: 'https://www.superbook.com/', ios: 'https://apps.apple.com/us/app/the-superbook/id1473895927' },
  { key: 'wynn', color: '#B08968', name: 'Wynn', short: 'Wynn', vegas: true, vsin: 'Wynn', ios: 'https://apps.apple.com/us/app/wynn-sports-nevada/id6476514610' },
  { key: 'dk', color: '#53A318', name: 'DraftKings', short: 'DK', an: [68], espn: '100' },
  { key: 'fd', color: '#1493FF', name: 'FanDuel', short: 'FanDuel', an: [69] },
  { key: 'bet365', color: '#128C69', name: 'bet365', short: 'bet365' },
  { key: 'betonline', color: '#B52A2E', name: 'BetOnline', short: 'BetOnline' },
  { key: 'hardrock', color: '#8860A4', name: 'Hard Rock Bet', short: 'Hard Rock' },
  { key: 'betr', color: '#198BA7', name: 'betr', short: 'betr' },
  { key: 'bovada', color: '#A4252B', name: 'Bovada', short: 'Bovada' },
  { key: 'novig', color: '#485D77', name: 'Novig', short: 'Novig' },
  { key: '1xbet', color: '#357A9B', name: '1xBet', short: '1xBet' },
  { key: 'ps3838', name: 'PS3838', short: 'PS3838' },
  { key: 'betrivers', name: 'BetRivers', short: 'BetRivers' },
  { key: 'betus', name: 'BetUS', short: 'BetUS' },
  { key: 'bet105', name: 'Bet105', short: 'Bet105' },
  { key: 'bookmaker', name: 'Bookmaker.eu', short: 'Bookmaker.eu' },
  { key: 'lowvig', name: 'LowVig', short: 'LowVig' },
  { key: 'mybookie', name: 'MyBookie', short: 'MyBookie' },
  { key: 'stake', name: 'Stake', short: 'Stake' },
  { key: 'thescore', name: 'theScore', short: 'theScore' },
  { key: 'thunderpick', name: 'Thunderpick', short: 'Thunderpick' },
  { key: 'versus', name: 'Versus', short: 'Versus' },
];

// Catalog coverage is independent of the plan's subscribed book limit. New
// reference products carry no betting URL; regional identities stay distinct.
const { BOOK_NAMES: SHARP_BOOK_NAMES } = require('../../shared/sharp-books');
for (const [key, name] of Object.entries(SHARP_BOOK_NAMES)) {
  const existing = BOOKS.find(book => book.key === key);
  if (existing) existing.src = [...new Set([...(existing.src || []), 'sharp'])];
  else BOOKS.push({ key, name, short: name, src: ['sharp'], catalogOnly: true });
}

// Not books you can bet at, but columns on the board.
const CONSENSUS = { key: 'cons', name: 'Market consensus', short: 'Market', an: [15] };
const OPENER = { key: 'open', name: 'Opening line', short: 'Open', an: [30] };

const byKey = Object.fromEntries(BOOKS.map((b) => [b.key, b]));
const AN_IDS = [...new Set([CONSENSUS, OPENER, ...BOOKS].flatMap((b) => b.an || []))];

module.exports = { BOOKS, CONSENSUS, OPENER, byKey, AN_IDS };
