const CONTEXTS = {
  focus: {
    id: 'focus',
    label: 'Study / Focus',
    description: 'A steady, low-distraction session with warm, focused momentum.',
    target: { energy: 0.32, danceability: 0.28, instrumentalness: 0.52, valence: 0.42 },
    weights: { energy: 26, danceability: 18, instrumentalness: 22, valence: 8 },
    keywords: ['lofi', 'lo-fi', 'piano', 'rain', 'study', 'instrumental', 'ambient', 'focus', 'calm', 'acoustic', 'classical', 'jazz'],
    genreSignals: ['ambient', 'classical', 'piano', 'lo-fi', 'lofi', 'instrumental', 'acoustic', 'jazz', 'chill', 'sleep', 'soundtrack'],
    avoidSignals: ['party', 'dance', 'edm', 'club', 'house', 'metal', 'hardcore', 'trap', 'punk'],
    popularityBias: -12,
  },
  roadtrip: {
    id: 'roadtrip',
    label: 'Roadtrip',
    description: 'Familiar hooks, bright energy, and enough discovery to keep the drive moving.',
    target: { energy: 0.72, danceability: 0.66, instrumentalness: 0.08, valence: 0.68 },
    weights: { energy: 24, danceability: 20, instrumentalness: 8, valence: 18 },
    keywords: ['roadtrip', 'drive', 'summer', 'sing', 'anthem', 'pop', 'rock', 'indie', 'dance'],
    genreSignals: ['pop', 'rock', 'indie', 'alternative', 'folk', 'country', 'singer-songwriter', 'dance', 'r&b'],
    avoidSignals: ['ambient', 'sleep', 'drone', 'noise'],
    popularityBias: 5,
  },
  party: {
    id: 'party',
    label: 'Party',
    description: 'Upbeat, rhythmic tracks with a strong pulse and crowd-friendly payoff.',
    target: { energy: 0.84, danceability: 0.82, instrumentalness: 0.04, valence: 0.72 },
    weights: { energy: 28, danceability: 28, instrumentalness: 8, valence: 16 },
    keywords: ['party', 'dance', 'remix', 'club', 'night', 'bass', 'hype', 'workout', 'anthem', 'house', 'disco', 'funk', 'edm'],
    genreSignals: ['dance', 'edm', 'electronic', 'club', 'house', 'disco', 'funk', 'hip hop', 'hip-hop', 'trap', 'r&b', 'reggaeton', 'latin', 'pop'],
    avoidSignals: ['ambient', 'classical', 'sleep', 'drone', 'acoustic'],
    popularityBias: 14,
  },
};

const clamp = (value, min = 0, max = 1) => Math.max(min, Math.min(max, value));
const normalize = (value) => String(value || '').trim().toLowerCase();
const trackText = (track, genres = []) => [track?.name, track?.album?.name, ...(track?.artists || []).map((artist) => artist.name), ...genres].filter(Boolean).join(' ').toLowerCase();

const buildIndexes = (users) => {
  const artists = new Map();
  const tracks = new Map();
  users.forEach((user) => {
    (user.topArtists || []).forEach((artist, index) => {
      const key = normalize(artist.name);
      if (!key) return;
      const entry = artists.get(key) || { owners: new Set(), bestRank: Infinity, genres: new Set() };
      entry.owners.add(user.id);
      entry.bestRank = Math.min(entry.bestRank, index + 1);
      (artist.genres || []).forEach((genre) => entry.genres.add(normalize(genre)));
      artists.set(key, entry);
    });
    [...(user.topTracks || []), ...(user.blendCandidates || [])].forEach((track) => {
      if (!track?.id) return;
      Object.entries(track.artistGenres || {}).forEach(([artistName, artistGenres]) => {
        const key = normalize(artistName);
        if (!key) return;
        const artist = artists.get(key) || { owners: new Set(), bestRank: Infinity, genres: new Set() };
        (artistGenres || []).forEach((genre) => artist.genres.add(normalize(genre)));
        artists.set(key, artist);
      });
      const entry = tracks.get(track.id) || { track, owners: new Set(), sources: new Set() };
      entry.track = { ...entry.track, ...track };
      entry.owners.add(user.id);
      entry.sources.add(track.source || (user.topTracks?.some((item) => item.id === track.id) ? 'taste' : 'discovery'));
      tracks.set(track.id, entry);
    });
  });
  return { artists, tracks };
};

const featureScore = (track, profile) => {
  const features = track.audio_features || track.audioFeatures;
  if (!features) return 0;
  return Object.entries(profile.weights).reduce((score, [feature, weight]) => {
    const actual = Number(features[feature]);
    return Number.isFinite(actual) ? score + (1 - Math.abs(actual - profile.target[feature])) * weight : score;
  }, 0);
};

const contextSignalScore = (track, profile, genres) => {
  const haystack = trackText(track, genres);
  const positive = profile.genreSignals.reduce((score, signal) => score + (haystack.includes(signal) ? 11 : 0), 0);
  const negative = profile.avoidSignals.reduce((score, signal) => score + (haystack.includes(signal) ? 14 : 0), 0);
  const keyword = profile.keywords.reduce((score, keyword) => score + (haystack.includes(keyword) ? 5 : 0), 0);
  const popularity = clamp(Number(track.popularity || 0) / 100);
  return positive - negative + keyword + (popularity * profile.popularityBias);
};

const scoreTrack = (entry, profile, indexes, users) => {
  const { track, owners } = entry;
  const artistKeys = (track.artists || []).map((artist) => normalize(artist.name)).filter(Boolean);
  const artistEntries = artistKeys.map((key) => indexes.artists.get(key)).filter(Boolean);
  const sharedArtistListeners = Math.max(1, ...artistEntries.map((artist) => artist.owners.size));
  const tasteScore = artistEntries.reduce((sum, artist) => sum + Math.max(0, users.length * 2 - artist.bestRank / 5), 0);
  const overlapScore = (owners.size - 1) * 18 + (sharedArtistListeners - 1) * 10;
  const genres = artistEntries.flatMap((artist) => [...artist.genres]);
  const haystack = trackText(track, genres);
  const contextScore = featureScore(track, profile) + contextSignalScore(track, profile, genres);
  const popularity = clamp(Number(track.popularity || 0) / 100);
  const popularityScore = profile.id === 'focus' ? (1 - popularity) * 5 : popularity * 7;
  const discoveryScore = entry.sources.has('discovery') ? 6 : 0;
  const familiarityScore = owners.size > 1 || artistEntries.some((artist) => artist.owners.size > 1) ? 9 : 0;
  return {
    id: track.id,
    name: track.name,
    artists: (track.artists || []).map((artist) => artist.name),
    image: track.album?.images?.[0]?.url || '',
    spotifyUrl: track.external_urls?.spotify || '',
    popularity: track.popularity || 0,
    score: Math.round((tasteScore + overlapScore + contextScore + popularityScore + discoveryScore + familiarityScore) * 100) / 100,
    reasons: { sharedListeners: owners.size, sharedArtistListeners, contextMatch: Math.round(contextScore), tasteMatch: Math.round(tasteScore), discovery: entry.sources.has('discovery') },
  };
};

const diversify = (ranked, limit) => {
  const result = [];
  const artistCounts = new Map();
  const deferred = [];
  ranked.forEach((track) => {
    const artist = normalize(track.artists?.[0]);
    const count = artistCounts.get(artist) || 0;
    if (count >= 8 && result.length < limit - 8) deferred.push(track);
    else { result.push(track); artistCounts.set(artist, count + 1); }
  });
  for (const track of deferred) { if (result.length >= limit) break; result.push(track); }
  return result.slice(0, limit);
};

const buildCompatibility = (users) => users.map((user) => {
  const myArtists = new Set((user.topArtists || []).map((artist) => normalize(artist.name)));
  const myTracks = new Set((user.topTracks || []).map((track) => track.id));
  return {
    userId: user.id,
    playerName: user.playerName || 'Unknown',
    overlaps: users.filter((other) => other.id !== user.id).map((other) => {
      const sharedArtists = (other.topArtists || []).filter((artist) => myArtists.has(normalize(artist.name)));
      const sharedTracks = (other.topTracks || []).filter((track) => myTracks.has(track.id));
      const maxArtists = Math.max(user.topArtists?.length || 0, other.topArtists?.length || 0, 1);
      return { withUserId: other.id, withPlayerName: other.playerName || 'Unknown', sharedArtists: sharedArtists.map((artist) => artist.name), sharedTrackCount: sharedTracks.length, score: Math.round((sharedArtists.length / maxArtists) * 100) };
    }),
  };
});

const createContextBlend = (users, context, { limit = 120 } = {}) => {
  const profile = CONTEXTS[context];
  if (!profile) throw new Error(`Unknown blend context: ${context}`);
  if (!Array.isArray(users) || users.length < 2) throw new Error('Need at least two people in the room to blend');
  const indexes = buildIndexes(users);
  const ranked = [...indexes.tracks.values()].map((entry) => scoreTrack(entry, profile, indexes, users)).sort((a, b) => b.score - a.score || b.reasons.sharedListeners - a.reasons.sharedListeners);
  // Keep the playlist large when the room has enough material, but let context
  // selection remove the weakest quarter when the pool is smaller than 100.
  // This makes changing context change the actual playlist, not only its label.
  const selectionLimit = ranked.length >= 100 ? Math.min(100, limit, ranked.length) : Math.max(12, Math.ceil(ranked.length * 0.75));
  return { context: profile, tracks: diversify(ranked, selectionLimit), totalAvailable: ranked.length, compatibility: buildCompatibility(users) };
};

module.exports = { CONTEXTS, createContextBlend };
