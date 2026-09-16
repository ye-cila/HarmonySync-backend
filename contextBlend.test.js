const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createContextBlend, CONTEXTS } = require('./contextBlend');

const alice = {
  id: 'alice',
  playerName: 'Alice',
  topArtists: [
    { name: 'Nujabes', genres: ['lo-fi', 'jazz'] },
    { name: 'Daft Punk', genres: ['dance', 'electronic'] },
  ],
  topTracks: [
    {
      id: 'lofi-1',
      name: 'Lofi Study Beat',
      popularity: 22,
      artists: [{ name: 'Nujabes' }],
      album: { images: [{ url: 'https://img/lofi' }] },
      external_urls: { spotify: 'https://open.spotify.com/track/lofi-1' },
    },
    {
      id: 'party-1',
      name: 'One More Time',
      popularity: 88,
      artists: [{ name: 'Daft Punk' }],
      album: { images: [{ url: 'https://img/party' }] },
      external_urls: { spotify: 'https://open.spotify.com/track/party-1' },
    },
  ],
};

const bob = {
  id: 'bob',
  playerName: 'Bob',
  topArtists: [
    { name: 'Nujabes', genres: ['lo-fi'] },
    { name: 'Daft Punk', genres: ['dance'] },
  ],
  topTracks: [
    {
      id: 'lofi-1',
      name: 'Lofi Study Beat',
      popularity: 22,
      artists: [{ name: 'Nujabes' }],
      album: { images: [{ url: 'https://img/lofi' }] },
      external_urls: { spotify: 'https://open.spotify.com/track/lofi-1' },
    },
    {
      id: 'party-1',
      name: 'One More Time',
      popularity: 88,
      artists: [{ name: 'Daft Punk' }],
      album: { images: [{ url: 'https://img/party' }] },
      external_urls: { spotify: 'https://open.spotify.com/track/party-1' },
    },
  ],
};

test('focus blend ranks overlapping study tracks first', () => {
  const blend = createContextBlend([alice, bob], 'focus', { limit: 5 });

  assert.equal(blend.context.id, 'focus');
  assert.equal(blend.tracks[0].id, 'lofi-1');
  assert.equal(blend.tracks[0].reasons.sharedListeners, 2);
  assert.ok(blend.tracks[0].score >= blend.tracks[1].score);
});

test('party blend ranks overlapping dance tracks first', () => {
  const blend = createContextBlend([alice, bob], 'party', { limit: 5 });

  assert.equal(blend.context.id, 'party');
  assert.equal(blend.tracks[0].id, 'party-1');
  assert.equal(blend.compatibility[0].overlaps[0].sharedArtists.includes('Nujabes'), true);
});

test('unknown context and tiny rooms are rejected', () => {
  assert.throws(() => createContextBlend([alice, bob], 'gym'), /Unknown blend context/);
  assert.throws(() => createContextBlend([alice], 'focus'), /at least two people/);
  assert.ok(CONTEXTS.party.label.includes('Party'));
});

test('ranks context features and returns a large unique, diversified playlist', () => {
  const candidates = Array.from({ length: 110 }, (_, index) => ({
    id: `discovery-${index}`,
    name: `Roadtrip Track ${index}`,
    popularity: 60,
    source: 'discovery',
    audio_features: { energy: 0.8, danceability: 0.75, instrumentalness: 0.03, valence: 0.75 },
    artists: [{ name: `Discovery Artist ${index % 20}` }],
    album: { images: [] },
    external_urls: { spotify: `https://open.spotify.com/track/discovery-${index}` },
  }));
  const blend = createContextBlend([
    { ...alice, blendCandidates: candidates.slice(0, 55) },
    { ...bob, blendCandidates: candidates.slice(55) },
  ], 'roadtrip', { limit: 120 });

  assert.equal(blend.tracks.length, 100);
  assert.equal(new Set(blend.tracks.map((track) => track.id)).size, blend.tracks.length);
  assert.ok(blend.tracks[0].reasons.contextMatch > 0);
  assert.ok(blend.tracks.filter((track) => track.reasons.discovery).length > 90);
});

test('changing context changes the selected playlist, not only its label', () => {
  const tracks = [
    ...Array.from({ length: 8 }, (_, index) => ({ id: `focus-${index}`, name: `Focus Piano ${index}`, popularity: 20 + index, artists: [{ name: `Focus Artist ${index}` }] })),
    ...Array.from({ length: 8 }, (_, index) => ({ id: `road-${index}`, name: `Roadtrip Summer Anthem ${index}`, popularity: 55 + index, artists: [{ name: `Road Artist ${index}` }] })),
    ...Array.from({ length: 8 }, (_, index) => ({ id: `party-${index}`, name: `Party Dance Club ${index}`, popularity: 80 + index, artists: [{ name: `Party Artist ${index}` }] })),
  ];
  const users = [
    { id: 'a', topArtists: [
      ...Array.from({ length: 8 }, (_, index) => ({ name: `Focus Artist ${index}`, genres: ['piano', 'ambient'] })),
      ...Array.from({ length: 8 }, (_, index) => ({ name: `Road Artist ${index}`, genres: ['pop', 'rock'] })),
      ...Array.from({ length: 8 }, (_, index) => ({ name: `Party Artist ${index}`, genres: ['dance', 'edm'] })),
    ], topTracks: tracks },
    { id: 'b', topArtists: [], topTracks: tracks },
  ];
  const focus = createContextBlend(users, 'focus', { limit: 120 });
  const party = createContextBlend(users, 'party', { limit: 120 });

  assert.notDeepEqual(focus.tracks.map((track) => track.id), party.tracks.map((track) => track.id));
  assert.equal(focus.tracks[0].id.startsWith('focus-'), true);
  assert.equal(party.tracks[0].id.startsWith('party-'), true);
});
