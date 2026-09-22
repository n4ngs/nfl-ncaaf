'use strict';

// Both providers arrive in the same normalized shape. Reuse the strict ESPN
// mapping and side handling, with a separate withdrawal identity for Sharp.
const { matchAll, reconcileBooks } = require('./owls');
module.exports = {
  matchAll,
  reconcileBooks: (previous, incoming, receivedAt, isLive) => reconcileBooks(previous, incoming, receivedAt, isLive, 'sharp'),
};
