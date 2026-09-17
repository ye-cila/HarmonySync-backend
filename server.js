const http = require('http');
const { Server } = require('socket.io');
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const querystring = require('querystring');
require('dotenv').config();
const crypto = require('crypto');
const {
  DatabaseError,
  getLeaderboard,
  isUuid,
  saveGameScores,
  upsertUser,
} = require('./services/supabase');

const rooms = new Map();
const games = new Map();
const werewolfGames = new Map();

const CLIENT_URL = process.env.CLIENT_URL || 'http://127.0.0.1:5173';
const { generateRandomString, generateCodeChallenge } = require('./pkceHelper');
const { CONTEXTS, createContextBlend } = require('./contextBlend');

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: '*',
  },
});
const PORT = process.env.PORT || 8888;
const WEREWOLF_VOTING_SECONDS = 30;
const GAME_TYPES = new Set(['werewolf', 'spotify_guess']);

const normalizeGameType = (value) => {
  const normalized = String(value || '').trim().toLowerCase();

  if (normalized === 'spotify-taste' || normalized === 'spotify_taste' || normalized === 'spotify-guess') {
    return 'spotify_guess';
  }

  return normalized;
};

const logDatabaseFailure = (operation, error) => {
  console.error(`[Database] ${operation} failed`, error?.message || error);
};

const persistSpotifyGameScores = (room, game) => {
  if (!room || !game?.scores) {
    return;
  }

  const scores = room.users
    .filter((user) => isUuid(user.databaseUserId))
    .map((user) => ({
      userId: user.databaseUserId,
      gameType: 'spotify_guess',
      score: game.scores.get(user.id) || 0,
    }));

  if (scores.length === 0) {
    return;
  }

  void saveGameScores(scores).catch((error) => {
    logDatabaseFailure('persist Spotify Guess scores', error);
  });
};

const respondWithDatabaseError = (res, error, fallbackMessage) => {
  if (error instanceof DatabaseError) {
    return res.status(error.statusCode || 502).json({ error: fallbackMessage });
  }

  logDatabaseFailure(fallbackMessage, error);
  return res.status(502).json({ error: fallbackMessage });
};

const generateRoomCode = () => {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
};

const createWerewolfGame = (room) => {
  const players = room.users.map((user) => user.id);

  // Pick one random player as the imposter
  const imposterIndex = Math.floor(
    Math.random() * players.length
  );

  const imposterId = players[imposterIndex];

  const roles = new Map();

  players.forEach((playerId) => {
    roles.set(
      playerId,
      playerId === imposterId ? 'imposter' : 'listener'
    );
  });

  return {
    phase: 'clue',
    roles,
    imposterId,
    clues: new Map(),
    votes: new Map(),
    eliminatedPlayers: [],
    votingTimer: null,
    imposterGuessTimer: null,
  };
};

const getRandomTrack = (room) => {
  const allTracks = room.users.flatMap(
    (user) => user.topTracks || []
  );

  if (allTracks.length === 0) {
    return null;
  }

  const randomIndex = Math.floor(
    Math.random() * allTracks.length
  );

  return allTracks[randomIndex];
};

const startWerewolfGame = (roomCode) => {
  const room = rooms.get(roomCode);

  if (!room || room.users.length < 4) {
    return false;
  }

  const allTracks = room.users.flatMap(
    (user) => user.topTracks || []
  );

  if (allTracks.length < 2) {
    return false;
  }

  const listenerSong = allTracks[
    Math.floor(Math.random() * allTracks.length)
  ];
  const differentTracks = allTracks.filter(
    (track) => track.id !== listenerSong.id
  );
  const imposterSong = differentTracks[
    Math.floor(Math.random() * differentTracks.length)
  ];

  if (!listenerSong || !imposterSong) {
    return false;
  }

  const previousGame = werewolfGames.get(roomCode);
  if (previousGame?.votingTimer) {
    clearTimeout(previousGame.votingTimer);
  }
  if (previousGame?.imposterGuessTimer) {
    clearTimeout(previousGame.imposterGuessTimer);
  }

  const game = createWerewolfGame(room);
  game.listenerSong = listenerSong;
  game.imposterSong = imposterSong;
  werewolfGames.set(roomCode, game);

  room.users.forEach((user) => {
    const targetSocket = [...io.sockets.sockets.values()].find(
      (roomSocket) => roomSocket.data.userId === user.id
    );

    if (!targetSocket) {
      return;
    }

    const role = game.roles.get(user.id);
    const song = role === 'imposter'
      ? game.imposterSong
      : game.listenerSong;

    targetSocket.emit('werewolf-started', {
      role,
      song: {
        name: song.name,
        artist: song.artists?.[0]?.name || 'Unknown Artist',
        image: song.album?.images?.[0]?.url || '',
        spotifyUrl: song.external_urls?.spotify || '',
      },
    });
  });

  console.log(`Werewolf game started in room ${roomCode}`);
  return true;
};

const scheduleWerewolfImposterGuess = (roomCode, game) => {
  if (!game || game.phase === 'imposter-guess' || game.imposterGuessTimer) {
    return;
  }

  if (game.votingTimer) {
    clearTimeout(game.votingTimer);
    game.votingTimer = null;
  }
  if (game.phase === 'voting') {
    game.phase = 'voting-results';
  }

  game.imposterGuessTimer = setTimeout(() => {
    game.imposterGuessTimer = null;
    const currentGame = werewolfGames.get(roomCode);

    if (!currentGame || currentGame !== game) {
      return;
    }

    currentGame.phase = 'imposter-guess';
    currentGame.clues = new Map();
    currentGame.votes = new Map();
    io.to(roomCode).emit('werewolf-imposter-guess-start');
    console.log(`Imposter final guess started in room ${roomCode}`);
  }, 3000);
};

const startWerewolfVoting = (roomCode) => {
  const game = werewolfGames.get(roomCode);
  const room = rooms.get(roomCode);

  if (!game || !room || game.phase !== 'clue') {
    return false;
  }

  const activePlayers = room.users.filter(
    (user) => !game.eliminatedPlayers.includes(user.id)
  );

  if (activePlayers.length === 0) {
    return false;
  }

  // With only two active players left, there is no useful vote to resolve.
  // Move the imposter to the final guess phase so the game can finish cleanly.
  if (
    activePlayers.length <= 2 &&
    activePlayers.some((player) => player.id === game.imposterId)
  ) {
    scheduleWerewolfImposterGuess(roomCode, game);
    return true;
  }

  if (game.clues.size !== activePlayers.length) {
    return false;
  }

  game.phase = 'voting';
  game.votingTimer = setTimeout(() => {
    resolveWerewolfVoting(roomCode, true);
  }, WEREWOLF_VOTING_SECONDS * 1000);

  const clues = activePlayers.map((user) => ({
    userId: user.id,
    playerName: user.playerName,
    clue: game.clues.get(user.id).clue,
  }));

  io.to(roomCode).emit('werewolf-voting-start', {
    clues,
    durationSeconds: WEREWOLF_VOTING_SECONDS,
  });

  return true;
};

const resolveWerewolfVoting = (roomCode, timedOut = false) => {
  const game = werewolfGames.get(roomCode);
  const room = rooms.get(roomCode);

  if (!game || !room || game.phase !== 'voting') {
    return;
  }

  if (game.votingTimer) {
    clearTimeout(game.votingTimer);
    game.votingTimer = null;
  }

  const activePlayers = room.users.filter(
    (user) => !game.eliminatedPlayers.includes(user.id)
  );

  if (activePlayers.length === 0) {
    return;
  }

  const activeIds = new Set(activePlayers.map((user) => user.id));
  const voteCounts = new Map();

  game.votes.forEach((votedUserId) => {
    if (!activeIds.has(votedUserId)) {
      return;
    }

    voteCounts.set(
      votedUserId,
      (voteCounts.get(votedUserId) || 0) + 1
    );
  });

  const highestVotes = Math.max(
    ...activePlayers.map((player) => voteCounts.get(player.id) || 0)
  );
  const leaders = activePlayers.filter(
    (player) => (voteCounts.get(player.id) || 0) === highestVotes
  );
  const isTie = leaders.length > 1;
  const eliminatedPlayer = isTie ? null : leaders[0];

  const voteResults = activePlayers.map((user) => ({
    playerName: user.playerName,
    votedUserId: game.votes.get(user.id) || null,
  }));
  const isImposter = Boolean(
    eliminatedPlayer && eliminatedPlayer.id === game.imposterId
  );

  game.phase = 'voting-results';
  if (eliminatedPlayer && !isImposter) {
    game.eliminatedPlayers.push(eliminatedPlayer.id);
  }

  const remainingActivePlayers = room.users.filter(
    (user) => !game.eliminatedPlayers.includes(user.id)
  );
  const imposterGuessPending = isImposter || (
    remainingActivePlayers.length <= 2 &&
    remainingActivePlayers.some((player) => player.id === game.imposterId)
  );

  io.to(roomCode).emit('werewolf-voting-results', {
    votes: voteResults,
    eliminatedPlayer: eliminatedPlayer
      ? {
          userId: eliminatedPlayer.id,
          playerName: eliminatedPlayer.playerName,
        }
      : null,
    isTie,
    tiedPlayers: isTie
      ? leaders.map((player) => ({
          userId: player.id,
          playerName: player.playerName,
          votes: highestVotes,
        }))
      : [],
    voteCounts: activePlayers.map((player) => ({
      userId: player.id,
      playerName: player.playerName,
      votes: voteCounts.get(player.id) || 0,
    })),
    isImposter,
    imposterGuessPending,
    timedOut,
    abstentions: activePlayers.filter((user) => !game.votes.has(user.id)).length,
  });

  if (imposterGuessPending) {
    scheduleWerewolfImposterGuess(roomCode, game);
    return;
  }

  setTimeout(() => {
    const currentGame = werewolfGames.get(roomCode);

    if (!currentGame || currentGame !== game) {
      return;
    }

    currentGame.clues = new Map();
    currentGame.votes = new Map();
    currentGame.phase = 'clue';
    io.to(roomCode).emit('werewolf-new-clue-round');
    console.log(`Werewolf new clue round started in room ${roomCode}`);
  }, 3000);
};

// Middleware
app.use(cors());
app.use(express.json());

let storedCodeVerifier = '';

// Logging in
app.get('/login', (req,res) => {
  const codeVerifier = generateRandomString(64);
  const codeChallenge = generateCodeChallenge(codeVerifier);
  storedCodeVerifier = codeVerifier;

  // Requests specific permissions from the Spotify user
  const scope = 'user-read-private user-read-email user-top-read playlist-modify-public playlist-modify-private';

  const queryParams = querystring.stringify({
    response_type: 'code',
    client_id: process.env.SPOTIFY_CLIENT_ID,
    scope: scope,
    redirect_uri: process.env.REDIRECT_URI,
    code_challenge_method: 'S256',
    code_challenge: codeChallenge,
  })

  // Redirect user to Spotify log in page
  res.redirect(`https://accounts.spotify.com/authorize?${queryParams}`);
});

// Callback route
app.get('/callback', async (req,res) => {
  const code = req.query.code || null;

  if (!code) {
    return res.status(400).json({ error: 'Authorization code missing' });
  }

  try {
    // Send request exchange code with token
    const response = await axios({
      method: 'post',
      url: 'https://accounts.spotify.com/api/token',
      data: querystring.stringify({
        client_id: process.env.SPOTIFY_CLIENT_ID,
        grant_type: 'authorization_code',
        code: code,
        redirect_uri: process.env.REDIRECT_URI,
        code_verifier: storedCodeVerifier,
      }),
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
    });

    const { access_token, refresh_token, expires_in } = response.data;

    // The Spotify token stays in the existing frontend flow. Only the
    // non-sensitive Spotify profile fields are persisted in Supabase.
    try {
      const profileResponse = await axios.get('https://api.spotify.com/v1/me', {
        headers: {
          Authorization: `Bearer ${access_token}`,
        },
      });

      await upsertUser({
        spotifyId: profileResponse.data.id,
        displayName: profileResponse.data.display_name,
        avatarUrl: profileResponse.data.images?.[0]?.url || null,
      });
    } catch (error) {
      // A database outage must not prevent Spotify authentication from
      // completing. The frontend retries persistence after loading /me.
      logDatabaseFailure('persist authenticated Spotify user', error);
    }

    // Redirect user back to frontend
    const redirectUrl = new URL(CLIENT_URL);
    redirectUrl.searchParams.set('access_token', access_token);
    redirectUrl.searchParams.set('refresh_token', refresh_token);
    res.redirect(redirectUrl.toString());

  } catch (error) {
    console.error('Error fetching token:', error.response?.data || error.message);
    res.status(500).json({ error: 'Authentication failed', details: error.response?.data });
  }

})

app.post('/users/sync', async (req, res) => {
  const { spotifyId, displayName, avatarUrl } = req.body || {};

  if (!spotifyId || typeof spotifyId !== 'string') {
    return res.status(400).json({ error: 'Spotify user id is required' });
  }

  try {
    const user = await upsertUser({ spotifyId, displayName, avatarUrl });
    return res.json({
      userId: user.id,
      spotifyId: user.spotify_id,
      displayName: user.display_name,
      avatarUrl: user.avatar_url,
    });
  } catch (error) {
    return respondWithDatabaseError(res, error, 'Could not sync Spotify user');
  }
});

app.get('/leaderboard', async (req, res) => {
  const gameType = normalizeGameType(req.query.gameType);

  if (!GAME_TYPES.has(gameType)) {
    return res.status(400).json({
      error: 'Invalid game type',
      allowedGameTypes: [...GAME_TYPES],
    });
  }

  try {
    const leaderboard = await getLeaderboard(gameType);
    return res.json(leaderboard);
  } catch (error) {
    return respondWithDatabaseError(res, error, 'Could not load leaderboard');
  }
});

// Refresh Spotify access token
app.post('/refresh', async (req, res) => {
  const { refresh_token } = req.body;

  if (!refresh_token) {
    return res.status(400).json({
      error: 'Refresh token missing',
    });
  }

  try {
    const response = await axios({
      method: 'post',
      url: 'https://accounts.spotify.com/api/token',
      data: querystring.stringify({
        grant_type: 'refresh_token',
        refresh_token,
        client_id: process.env.SPOTIFY_CLIENT_ID,
      }),
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
    });

    res.json({
      access_token: response.data.access_token,
      expires_in: response.data.expires_in,
    });

  } catch (error) {
    console.error(
      'Error refreshing token:',
      error.response?.data || error.message
    );

    res.status(500).json({
      error: 'Could not refresh access token',
    });
  }
});

// Room route
app.post('/rooms', (req, res) => {
  const maxUsers = Number(req.body.maxUsers);

  if (
    !Number.isInteger(maxUsers) ||
    maxUsers < 2 ||
    maxUsers > 8
  ) {
    return res.status(400).json({
      error: 'Room size must be between 2 and 8 people',
    });
  }

  let roomCode = generateRoomCode();

  while (rooms.has(roomCode)) {
    roomCode = generateRoomCode();
  }

  const userId = crypto.randomUUID();

  rooms.set(roomCode, {
    maxUsers,
    blendContext: 'focus',
    users: [{
      id: userId,
      databaseUserId: null,
      timeRange: 'medium_term',
    }],
  });

  res.json({
    roomCode,
    userId,
    users: rooms.get(roomCode).users,
    maxUsers,
  });
});

// Joining room
app.post('/rooms/:roomCode/join', (req, res) => {
  const roomCode = req.params.roomCode.toUpperCase();

  const room = rooms.get(roomCode);

  if (!room) {
    return res.status(404).json({
      error: 'Room not found',
    });
  }

  if (room.users.length >= room.maxUsers) {
    return res.status(409).json({
      error: 'Room is full',
    });
  }

  const userId = crypto.randomUUID();

  room.users.push({
    id: userId,
    databaseUserId: null,
    timeRange: 'medium_term',
  });

  res.json({
    roomCode,
    userId,
    users: room.users,
    maxUsers: room.maxUsers,
  });
});

io.on('connection', (socket) => {
  console.log('A user connected:', socket.id);

  socket.on('join-room', ({
    roomCode,
    userId,
    playerName,
    topArtists,
    topTracks,
    blendCandidates,
    databaseUserId,
    timeRange,
  }) => {
    socket.join(roomCode);

    socket.data.roomCode = roomCode;
    socket.data.userId = userId;
    socket.data.topArtists = topArtists;
    socket.data.topTracks = topTracks;
    socket.data.blendCandidates = blendCandidates;
    socket.data.databaseUserId = databaseUserId;
    socket.data.timeRange = timeRange;

    console.log(`${socket.id} joined room ${roomCode}`);

    const room = rooms.get(roomCode);

    if (!room) {
      return;
    }

    const nameTaken = room.users.some(
      (user) =>
        user.playerName?.toLowerCase() === playerName.trim().toLowerCase() &&
        user.id !== userId
    );

    if (nameTaken) {
      socket.emit('name-taken');
      return;
    }

    const user = room.users.find((user) => user.id === userId);

    if (user) {
      user.playerName = playerName;
      user.topArtists = topArtists;
      user.topTracks = topTracks;
      user.blendCandidates = blendCandidates || [];
      user.databaseUserId = isUuid(databaseUserId) ? databaseUserId : null;
      user.timeRange = timeRange || 'medium_term';
    }

    const readyUsers = room.users.filter(
      (roomUser) => (roomUser.topTracks || []).length > 0 || (roomUser.blendCandidates || []).length > 0
    );

    if (readyUsers.length >= 2) {
      try {
        room.blend = createContextBlend(readyUsers, room.blendContext || 'focus', { limit: 120 });
      } catch (error) {
        room.blend = null;
        socket.emit('context-blend-error', { error: error.message });
      }
    }

    socket.emit('join-room-success');
    socket.emit('blend-context-state', {
      context: room.blendContext || 'focus',
      hostId: room.users[0]?.id,
      blend: room.blend || null,
    });
             
    io.to(roomCode).emit('room-users', room.users);
  });

  socket.on('update-room-taste', ({
    roomCode,
    userId,
    playerName,
    topArtists,
    topTracks,
    blendCandidates,
    databaseUserId,
    timeRange,
  }) => {
    const room = rooms.get(roomCode);
    const user = room?.users.find((roomUser) => roomUser.id === userId);

    if (!room || !user) {
      return;
    }

    user.playerName = playerName || user.playerName;
    user.topArtists = topArtists || [];
    user.topTracks = topTracks || [];
    user.blendCandidates = blendCandidates || [];
    user.databaseUserId = isUuid(databaseUserId) ? databaseUserId : user.databaseUserId || null;
    user.timeRange = timeRange || user.timeRange || 'medium_term';
    socket.data.topArtists = user.topArtists;
    socket.data.topTracks = user.topTracks;
    socket.data.blendCandidates = user.blendCandidates;
    socket.data.databaseUserId = user.databaseUserId;
    socket.data.timeRange = user.timeRange;

    const readyUsers = room.users.filter(
      (roomUser) => (roomUser.topTracks || []).length > 0 || (roomUser.blendCandidates || []).length > 0
    );

    if (readyUsers.length >= 2) {
      try {
        room.blend = createContextBlend(readyUsers, room.blendContext || 'focus', { limit: 120 });
      } catch (error) {
        room.blend = null;
        socket.emit('context-blend-error', { error: error.message });
      }
    } else {
      room.blend = null;
    }

    io.to(roomCode).emit('room-users', room.users);
    io.to(roomCode).emit('blend-context-state', {
      context: room.blendContext || 'focus',
      hostId: room.users[0]?.id,
      blend: room.blend || null,
    });
  });

  socket.on('change-host', ({ roomCode, userId, targetUserId }) => {
    const room = rooms.get(roomCode);

    // Host transfers are a lobby action. During a game, the active game
    // controls and state remain owned by the current host.
    if (
      !room ||
      room.users[0]?.id !== userId ||
      games.has(roomCode) ||
      werewolfGames.has(roomCode) ||
      userId === targetUserId
    ) {
      return;
    }

    const targetIndex = room.users.findIndex(
      (user) => user.id === targetUserId
    );

    if (targetIndex < 1) {
      return;
    }

    const [targetUser] = room.users.splice(targetIndex, 1);
    room.users.unshift(targetUser);

    io.to(roomCode).emit('room-users', room.users);
    io.to(roomCode).emit('blend-context-state', {
      context: room.blendContext || 'focus',
      hostId: room.users[0]?.id,
      blend: room.blend || null,
    });
  });

  socket.on('start-werewolf', ({ roomCode, userId }) => {
    const room = rooms.get(roomCode);

    if (!room || room.users[0]?.id !== userId) {
      return;
    }

    startWerewolfGame(roomCode);
  });

  socket.on('restart-werewolf', ({ roomCode, userId }) => {
    const room = rooms.get(roomCode);

    if (!room || room.users[0]?.id !== userId) {
      return;
    }

    startWerewolfGame(roomCode);
  });

  socket.on('end-werewolf', ({ roomCode, userId }) => {
    const room = rooms.get(roomCode);

    if (!room || room.users[0]?.id !== userId) {
      return;
    }

    const game = werewolfGames.get(roomCode);
    if (game?.votingTimer) {
      clearTimeout(game.votingTimer);
    }
    if (game?.imposterGuessTimer) {
      clearTimeout(game.imposterGuessTimer);
    }
    werewolfGames.delete(roomCode);
    io.to(roomCode).emit('werewolf-ended');
  });

  socket.on('end-game', ({ roomCode, userId }) => {
    const room = rooms.get(roomCode);

    if (!room || room.users[0]?.id !== userId) {
      return;
    }

    const game = games.get(roomCode);
    if (game?.roundTimer) {
      clearTimeout(game.roundTimer);
    }
    persistSpotifyGameScores(room, game);
    games.delete(roomCode);
    io.to(roomCode).emit('game-ended');
  });

  socket.on('submit-werewolf-clue', ({ roomCode, userId, clue }) => {
    const game = werewolfGames.get(roomCode);
    const room = rooms.get(roomCode);

    if (!game || !room) {
      return;
    }

    if (game.phase !== 'clue') {
      return;
    }

    if (!clue || !clue.trim()) {
      return;
    }

    // Eliminated players are spectators and cannot submit clues
    if (game.eliminatedPlayers.includes(userId)) {
      return;
    }

    if (game.clues.has(userId)) {
      return;
    }

    const activePlayers = room.users.filter(
      (user) => !game.eliminatedPlayers.includes(user.id)
    );

    const player = activePlayers.find(
      (user) => user.id === userId
    );

    if (!player) {
      return;
    }

    game.clues.set(userId, {
      playerName: player.playerName,
      clue: clue.trim(),
    });

    console.log(
      `${player.playerName} submitted a Werewolf clue`
    );

    io.to(roomCode).emit('werewolf-clue-submitted', {
      playerName: player.playerName,
    });

    startWerewolfVoting(roomCode);
  });

  socket.on('submit-werewolf-vote', ({ roomCode, userId, votedUserId }) => {
    const game = werewolfGames.get(roomCode);
    const room = rooms.get(roomCode);

    if (!game || !room) {
      return;
    }

    if (game.phase !== 'voting') {
      return;
    }

    // Eliminated players are spectators and cannot vote
    if (game.eliminatedPlayers.includes(userId)) {
      return;
    }

    if (game.votes.has(userId)) {
      return;
    }

    const activePlayers = room.users.filter(
      (user) => !game.eliminatedPlayers.includes(user.id)
    );

    const voter = activePlayers.find(
      (user) => user.id === userId
    );

    const votedPlayer = activePlayers.find(
      (user) => user.id === votedUserId
    );

    if (!voter || !votedPlayer) {
      return;
    }

    game.votes.set(userId, votedUserId);

    console.log(
      `${voter.playerName} voted for ${votedPlayer.playerName}`
    );

    io.to(roomCode).emit('werewolf-vote-submitted', {
      playerName: voter.playerName,
    });

    if (game.votes.size === activePlayers.length) {
      resolveWerewolfVoting(roomCode);
    }
  });

  socket.on(
    'submit-werewolf-final-guess',
    ({ roomCode, userId, guessedSongId }) => {
      const game = werewolfGames.get(roomCode);
      const room = rooms.get(roomCode);

      if (!game || !room) {
        return;
      }

      if (game.phase !== 'imposter-guess') {
        return;
      }

      if (userId !== game.imposterId) {
        return;
      }

      const isCorrect =
        guessedSongId === game.listenerSong.id;

      game.phase = 'finished';

      io.to(roomCode).emit('werewolf-game-result', {
        winner: isCorrect ? 'imposter' : 'listeners',
        imposterId: game.imposterId,
        listenerSong: {
          name: game.listenerSong.name,
          artist:
            game.listenerSong.artists?.[0]?.name ||
            'Unknown Artist',
          image:
            game.listenerSong.album?.images?.[0]?.url ||
            '',
          spotifyUrl:
            game.listenerSong.external_urls?.spotify ||
            '',
        },
        imposterSong: {
          name: game.imposterSong.name,
          artist:
            game.imposterSong.artists?.[0]?.name ||
            'Unknown Artist',
          image:
            game.imposterSong.album?.images?.[0]?.url ||
            '',
          spotifyUrl:
            game.imposterSong.external_urls?.spotify ||
            '',
        },
      });

      console.log(
        `Werewolf game finished. Winner: ${
          isCorrect ? 'Imposter' : 'Listeners'
        }`
      );
    }
  );

  socket.on('leave-werewolf', ({ roomCode, userId }) => {
    const room = rooms.get(roomCode);

    if (!room) {
      socket.emit('room-left', { roomCode, userId });
      return;
    }

    // The host ends the game for everyone; only non-host players can leave
    // the room from the active Werewolf screen.
    if (room.users[0]?.id === userId) {
      return;
    }

    const user = room.users.find((roomUser) => roomUser.id === userId);

    if (!user) {
      socket.emit('room-left', { roomCode, userId });
      return;
    }

    const playerName = user.playerName || 'A player';
    const game = werewolfGames.get(roomCode);
    const hadWerewolfGame = Boolean(game);
    const wasImposter = game?.imposterId === userId;

    if (game) {
      game.roles?.delete(userId);
      game.clues?.delete(userId);
      game.votes?.delete(userId);
      game.eliminatedPlayers = game.eliminatedPlayers.filter(
        (playerId) => playerId !== userId
      );
    }

    room.users = room.users.filter((roomUser) => roomUser.id !== userId);

    socket.to(roomCode).emit('player-left', { userId, playerName });
    socket.leave(roomCode);
    socket.data.roomCode = null;
    socket.data.userId = null;
    socket.data.topArtists = null;
    socket.data.topTracks = null;
    socket.data.blendCandidates = null;
    socket.emit('room-left', { roomCode, userId });

    if (room.users.length === 0) {
      if (game?.votingTimer) {
        clearTimeout(game.votingTimer);
      }
      if (game?.imposterGuessTimer) {
        clearTimeout(game.imposterGuessTimer);
      }
      werewolfGames.delete(roomCode);
      rooms.delete(roomCode);
      return;
    }

    io.to(roomCode).emit('room-users', room.users);

    if (hadWerewolfGame && (wasImposter || room.users.length < 2)) {
      if (game?.votingTimer) {
        clearTimeout(game.votingTimer);
      }
      if (game?.imposterGuessTimer) {
        clearTimeout(game.imposterGuessTimer);
      }
      werewolfGames.delete(roomCode);
      io.to(roomCode).emit('werewolf-ended');
    } else if (hadWerewolfGame) {
      const activePlayers = room.users.filter(
        (roomUser) => !game.eliminatedPlayers.includes(roomUser.id)
      );

      if (
        activePlayers.length <= 2 &&
        activePlayers.some((roomUser) => roomUser.id === game.imposterId)
      ) {
        scheduleWerewolfImposterGuess(roomCode, game);
      }

      if (game.phase === 'clue') {
        // A player may have been the last clue submitter. Re-evaluate the
        // phase after removing them so the remaining room cannot hang.
        startWerewolfVoting(roomCode);
      } else if (game.phase === 'voting' && game.votes.size === activePlayers.length) {
        resolveWerewolfVoting(roomCode);
      }
    }

    const readyUsers = room.users.filter(
      (roomUser) =>
        (roomUser.topTracks || []).length > 0 ||
        (roomUser.blendCandidates || []).length > 0
    );
    if (readyUsers.length >= 2) {
      try {
        room.blend = createContextBlend(
          readyUsers,
          room.blendContext || 'focus',
          { limit: 120 }
        );
      } catch (error) {
        room.blend = null;
        io.to(roomCode).emit('context-blend-error', { error: error.message });
      }
    } else {
      room.blend = null;
    }

    io.to(roomCode).emit('blend-context-state', {
      context: room.blendContext || 'focus',
      hostId: room.users[0]?.id,
      blend: room.blend || null,
    });
  });

  socket.on('leave-room', ({ roomCode, userId }) => {
    const room = rooms.get(roomCode);

    if (!room) {
      socket.emit('room-left', { roomCode, userId });
      return;
    }

    const user = room.users.find((roomUser) => roomUser.id === userId);

    if (!user) {
      socket.emit('room-left', { roomCode, userId });
      return;
    }

    const playerName = user.playerName || 'A player';
    room.users = room.users.filter((roomUser) => roomUser.id !== userId);

    const game = werewolfGames.get(roomCode);
    const hadWerewolfGame = Boolean(game);
    const hadGuessGame = games.has(roomCode);
    if (game?.votingTimer) {
      clearTimeout(game.votingTimer);
    }
    if (game?.imposterGuessTimer) {
      clearTimeout(game.imposterGuessTimer);
    }
    games.delete(roomCode);
    werewolfGames.delete(roomCode);

    socket.to(roomCode).emit('player-left', { userId, playerName });
    socket.leave(roomCode);
    socket.data.roomCode = null;
    socket.data.userId = null;

    socket.emit('room-left', { roomCode, userId });

    if (room.users.length === 0) {
      rooms.delete(roomCode);
      return;
    }

    io.to(roomCode).emit('room-users', room.users);

    if (hadWerewolfGame) {
      io.to(roomCode).emit('werewolf-ended');
    }
    if (hadGuessGame) {
      io.to(roomCode).emit('game-ended');
    }

    const readyUsers = room.users.filter(
      (roomUser) => (roomUser.topTracks || []).length > 0 || (roomUser.blendCandidates || []).length > 0
    );
    if (readyUsers.length >= 2) {
      try {
        room.blend = createContextBlend(readyUsers, room.blendContext || 'focus', { limit: 120 });
      } catch (error) {
        room.blend = null;
        io.to(roomCode).emit('context-blend-error', { error: error.message });
      }
    } else {
      room.blend = null;
    }

    io.to(roomCode).emit('blend-context-state', {
      context: room.blendContext || 'focus',
      hostId: room.users[0]?.id,
      blend: room.blend || null,
    });

    if (room.users.length < 2 && !hadGuessGame) {
      io.to(roomCode).emit('game-ended');
    }
  });

  socket.on('disconnect', () => {
    const { roomCode, userId } = socket.data;

    console.log(`${socket.id} disconnected`);

    if (!roomCode || !userId) {
      return;
    }

    const room = rooms.get(roomCode);

    if (!room) {
      return;
    }

    const user = room.users.find(
      (user) => user.id === userId
    );

    if (!user) {
      return;
    }

    const playerName = user.playerName;
    const game = werewolfGames.get(roomCode);
    const hadWerewolfGame = Boolean(game);
    const hadGuessGame = games.has(roomCode);

    room.users = room.users.filter(
      (user) => user.id !== userId
    );

    // Tell the remaining players who left
    io.to(roomCode).emit('player-left', {
      userId,
      playerName,
    });

    // Update the room's player list
    io.to(roomCode).emit('room-users', room.users);

    // If only one player remains, stop any active game and promote the next
    // room member to host for future lobby actions.
    if (room.users.length < 2) {
      games.delete(roomCode);
      if (game?.votingTimer) {
        clearTimeout(game.votingTimer);
      }
      if (game?.imposterGuessTimer) {
        clearTimeout(game.imposterGuessTimer);
      }
      werewolfGames.delete(roomCode);
      io.to(roomCode).emit('game-ended');
    }

    if (hadWerewolfGame) {
      if (game?.votingTimer) {
        clearTimeout(game.votingTimer);
      }
      if (game?.imposterGuessTimer) {
        clearTimeout(game.imposterGuessTimer);
      }
      werewolfGames.delete(roomCode);
      io.to(roomCode).emit('werewolf-ended');
    }
    if (hadGuessGame) {
      const guessGame = games.get(roomCode);
      if (guessGame?.roundTimer) {
        clearTimeout(guessGame.roundTimer);
      }
      games.delete(roomCode);
      io.to(roomCode).emit('game-ended');
    }

    if (room.users.length === 0) {
      rooms.delete(roomCode);
    } else {
      const readyUsers = room.users.filter(
        (roomUser) => (roomUser.topTracks || []).length > 0 || (roomUser.blendCandidates || []).length > 0
      );
      if (readyUsers.length >= 2) {
        try {
          room.blend = createContextBlend(readyUsers, room.blendContext || 'focus', { limit: 120 });
        } catch (error) {
          room.blend = null;
          io.to(roomCode).emit('context-blend-error', { error: error.message });
        }
      } else {
        room.blend = null;
      }
      io.to(roomCode).emit('blend-context-state', {
        context: room.blendContext || 'focus',
        hostId: room.users[0]?.id,
        blend: room.blend,
      });
    }
  });

  const finishRound = (roomCode) => {
    const game = games.get(roomCode);
    const room = rooms.get(roomCode);

    if (!game || !room) {
      return;
    }

    // Prevent this round from ending twice
    if (game.roundTimer) {
      clearTimeout(game.roundTimer);
      game.roundTimer = null;
    }

    // Players who didn't answer are automatically wrong
    room.users.forEach((user) => {
      if (!game.answers.has(user.id)) {
        game.answers.set(user.id, {
          selectedUserId: null,
          correct: false,
          time: 15000,
          points: 0,
        });
      }
    });

    const leaderboard = room.users
      .map((user) => ({
        userId: user.id,
        score: game.scores.get(user.id) || 0,
      }))
      .sort((a, b) => b.score - a.score);

    room.users.forEach((user) => {
      const answer = game.answers.get(user.id);

      const targetSocket = [...io.sockets.sockets.values()].find(
        (socket) => socket.data.userId === user.id
      );

      if (targetSocket) {
        targetSocket.emit('round-result', {
          correct: answer.correct,
          points: answer.points,
          time: answer.time,
          leaderboard,
        });
      }
    });
  };

  socket.on('start-game', ({ roomCode }) => {
    const room = rooms.get(roomCode);

    if (!room || room.users.length < 2) {
      return;
    }

    const randomUserIndex = Math.floor(
      Math.random() * room.users.length
    );

    const selectedUser = room.users[randomUserIndex];

    const randomTrackIndex = Math.floor(
      Math.random() * selectedUser.topTracks.length
    );

    const selectedTrack = selectedUser.topTracks[randomTrackIndex];

    games.set(roomCode, {
      correctUserId: selectedUser.id,
      currentRound: 1,
      startedAt: Date.now(),
      scores: new Map(),
      answers: new Map(),
      roundTimer: null,
    });

    room.users.forEach((user) => {
      games.get(roomCode).scores.set(user.id, 0);
    });

    io.to(roomCode).emit('game-started');

    io.to(roomCode).emit('new-round', {
      track: {
        name: selectedTrack.name,
        artist: selectedTrack.artists[0].name,
        image: selectedTrack.album?.images?.[0]?.url || '',
      },
      choices: room.users.map((user) => ({
        id: user.id,
      })),
      round: 1,
    });

    games.get(roomCode).roundTimer = setTimeout(() => {
      finishRound(roomCode);
    }, 15000);
  });

  socket.on('submit-answer', ({ roomCode, userId, selectedUserId }) => {
    const game = games.get(roomCode);

    if (!game) {
      return;
    }

    const room = rooms.get(roomCode);

    if (!room) {
      return;
    }

    // Prevent a player from answering twice
    if (game.answers.has(userId)) {
      return;
    }

    const answerTime = Date.now() - game.startedAt;
    const isCorrect = selectedUserId === game.correctUserId;

    let points = 0;

    if (isCorrect) {
      if (answerTime <= 2000) {
        points = 100;
      } else if (answerTime <= 5000) {
        points = 75;
      } else {
        points = 50;
      }
    }

    const currentScore = game.scores.get(userId) || 0;
    game.scores.set(userId, currentScore + points);

    game.answers.set(userId, {
      selectedUserId,
      correct: isCorrect,
      time: answerTime,
      points,
    });

    console.log(
      `${userId} answered ${isCorrect ? 'CORRECT' : 'WRONG'} in ${answerTime}ms for ${points} points`
    );

    // End the round immediately if everyone has answered
    if (game.answers.size === room.users.length) {
      finishRound(roomCode);
    }
  });

  socket.on('next-round', ({ roomCode, userId }) => {
    const game = games.get(roomCode);
    const room = rooms.get(roomCode);

    if (!game || !room) {
      return;
    }

    // Only the host can advance the game
    if (room.users[0]?.id !== userId) {
      return;
    }

    game.currentRound += 1;

    // Reset answers for the new round
    game.answers = new Map();

    // Pick a random player
    const randomUserIndex = Math.floor(
      Math.random() * room.users.length
    );

    const selectedUser = room.users[randomUserIndex];

    // Pick a random track from that player's Top Tracks
    const randomTrackIndex = Math.floor(
      Math.random() * selectedUser.topTracks.length
    );

    const selectedTrack = selectedUser.topTracks[randomTrackIndex];

    // Store the correct answer for this round
    game.correctUserId = selectedUser.id;

    // Reset the timer
    game.startedAt = Date.now();

    io.to(roomCode).emit('new-round', {
      track: {
        name: selectedTrack.name,
        artist: selectedTrack.artists[0].name,
        image: selectedTrack.album?.images?.[0]?.url || '',
      },
      choices: room.users.map((user) => ({
        id: user.id,
      })),
      round: game.currentRound,
    });

    game.roundTimer = setTimeout(() => {
      finishRound(roomCode);
    }, 15000);
  });

  socket.on('quit-game', ({ roomCode, userId }) => {
    const room = rooms.get(roomCode);

    if (!room) {
      return;
    }

    const user = room.users.find(
      (user) => user.id === userId
    );

    if (!user) {
      return;
    }

    const playerName = user.playerName;

    room.users = room.users.filter(
      (user) => user.id !== userId
    );

    if (room.users.length < 2) {
      games.delete(roomCode);

      io.to(roomCode).emit('game-ended');
    }

    io.to(roomCode).emit('player-left', {
      userId,
      playerName,
    });

    io.to(roomCode).emit('room-users', room.users);

    socket.leave(roomCode);

    console.log(`${playerName} left game ${roomCode}`);
  });

  socket.on('set-blend-context', ({ roomCode, userId, context }) => {
    const room = rooms.get(roomCode);
    if (!room) return socket.emit('context-blend-error', { error: 'Room not found' });
    if (room.users[0]?.id !== userId) return socket.emit('context-blend-error', { error: 'Only the host can change the Blend context' });
    if (!CONTEXTS[context]) return socket.emit('context-blend-error', { error: 'Unknown Blend context' });
    room.blendContext = context;
    const readyUsers = room.users.filter(
      (user) => (user.topTracks || []).length > 0 || (user.blendCandidates || []).length > 0
    );

    if (readyUsers.length >= 2) {
      try {
        room.blend = createContextBlend(readyUsers, context, { limit: 120 });
      } catch (error) {
        room.blend = null;
        socket.emit('context-blend-error', { error: error.message });
      }
    } else {
      room.blend = null;
    }

    io.to(roomCode).emit('blend-context-state', {
      context,
      hostId: room.users[0]?.id,
      blend: room.blend,
    });
  });

  socket.on('create-context-blend', ({ roomCode, userId, context }) => {
    const room = rooms.get(roomCode);

    if (!room) {
      socket.emit('context-blend-error', {
        error: 'Room not found',
      });
      return;
    }

    if (room.users[0]?.id !== userId) {
      socket.emit('context-blend-error', {
        error: 'Only the host can create a blend',
      });
      return;
    }

    const readyUsers = room.users.filter(
      (user) => (user.topTracks || []).length > 0 || (user.blendCandidates || []).length > 0
    );

    if (readyUsers.length < 2) {
      socket.emit('context-blend-error', {
        error: 'Need at least two players with Spotify top tracks',
      });
      return;
    }

    try {
      const selectedContext = CONTEXTS[room.blendContext]
        ? room.blendContext
        : (CONTEXTS[context] ? context : 'focus');
      room.blendContext = selectedContext;
      const blend = createContextBlend(readyUsers, selectedContext, {
        limit: 120,
      });

      room.blend = blend;
      io.to(roomCode).emit('context-blend-ready', blend);
    } catch (error) {
      socket.emit('context-blend-error', {
        error: error.message,
      });
    }
  });
});

// Endpoint checking server status
app.get('/', (req, res) => {
  res.send('🚀 HarmonySync Backend Server is Running!');
});

server.listen(PORT, () => {
  console.log(`=================================`);
  console.log(`🎉 Server is running at: http://127.0.0.1:${PORT}`);
  console.log(`=================================`);
});
