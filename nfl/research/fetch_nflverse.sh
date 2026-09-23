#!/bin/sh
# Resumable nflverse download (GitHub release assets, public, no login). Run from nfl/research.
set -e
mkdir -p data/nflverse data/raw && cd data/nflverse
for y in $(seq 2006 2026); do
  gh release download pbp -R nflverse/nflverse-data -p "play_by_play_${y}.parquet" --skip-existing
done
for y in $(seq 2009 2026); do gh release download injuries -R nflverse/nflverse-data -p "injuries_${y}.parquet" --skip-existing; done
for y in $(seq 2012 2026); do gh release download snap_counts -R nflverse/nflverse-data -p "snap_counts_${y}.parquet" --skip-existing; done
gh release download schedules -R nflverse/nflverse-data -p "games.parquet" --skip-existing || true
cd ../raw && [ -s games.csv ] || curl -sL -o games.csv https://github.com/nflverse/nfldata/raw/master/data/games.csv
echo done
