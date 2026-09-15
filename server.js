const http = require('http');
const { Server } = require('socket.io');
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const querystring = require('querystring');
require('dotenv').config();
const crypto = require('crypto');

const rooms = new Map();
const games = new Map();
const werewolfGames = new Map();

const CLIENT_URL = process.env.CLIENT_URL || 'http://127.0.0.1:5173';
const { generateRandomString, generateCodeChallenge } = require('./pkceHelper');

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: '*',
  },
});
const PORT = process.env.PORT || 8888;

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

    // Redirect user back to frontend
    res.redirect(`${CLIENT_URL}/?access_token=${access_token}&refresh_token=${refresh_token}`);

  } catch (error) {
    console.error('Error fetching token:', error.response?.data || error.message);
    res.status(500).json({ error: 'Authentication failed', details: error.response?.data });
  }

})

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
    users: [{
      id: userId,
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
  }) => {
    socket.join(roomCode);

    socket.data.roomCode = roomCode;
    socket.data.userId = userId;
    socket.data.topArtists = topArtists;
    socket.data.topTracks = topTracks;

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
    }

    socket.emit('join-room-success');
             
    io.to(roomCode).emit('room-users', room.users);
  });

  socket.on('start-werewolf', ({ roomCode }) => {
    const room = rooms.get(roomCode);

    if (!room || room.users.length < 4) {
      return;
    }

    const game = createWerewolfGame(room);
    const allTracks = room.users.flatMap(
      (user) => user.topTracks || []
    );

    if (allTracks.length < 2) {
      return;
    }

    const listenerSong =
      allTracks[Math.floor(Math.random() * allTracks.length)];

    const differentTracks = allTracks.filter(
      (track) => track.id !== listenerSong.id
    );

    const imposterSong =
      differentTracks[
        Math.floor(Math.random() * differentTracks.length)
      ];

    if (!listenerSong || !imposterSong) {
      return;
    }

    game.listenerSong = listenerSong;
    game.imposterSong = imposterSong;

    werewolfGames.set(roomCode, game);

    room.users.forEach((user) => {
      const targetSocket = [...io.sockets.sockets.values()].find(
        (socket) => socket.data.userId === user.id
      );

      if (!targetSocket) {
        return;
      }

      const role = game.roles.get(user.id);

      const song =
        role === 'imposter'
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

    if (game.clues.size === activePlayers.length) {
      game.phase = 'voting';

      const clues = activePlayers.map((user) => ({
        userId: user.id,
        playerName: user.playerName,
        clue: game.clues.get(user.id).clue,
      }));

      io.to(roomCode).emit('werewolf-voting-start', {
        clues,
      });
    }
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
      const voteCounts = new Map();

      game.votes.forEach((votedUserId) => {
        const currentVotes =
          voteCounts.get(votedUserId) || 0;

        voteCounts.set(
          votedUserId,
          currentVotes + 1
        );
      });

      let eliminatedUserId = null;
      let highestVotes = 0;

      voteCounts.forEach((count, votedUserId) => {
        if (count > highestVotes) {
          highestVotes = count;
          eliminatedUserId = votedUserId;
        }
      });

      const eliminatedPlayer = activePlayers.find(
        (user) => user.id === eliminatedUserId
      );

      if (!eliminatedPlayer) {
        return;
      }

      const voteResults = activePlayers.map((user) => ({
        playerName: user.playerName,
        votedUserId: game.votes.get(user.id),
      }));

      const isImposter =
        eliminatedPlayer.id === game.imposterId;

      if (isImposter) {
        // Stay on the results screen first.
        game.phase = 'voting-results';
      } else {
        // Remember this player as eliminated.
        game.eliminatedPlayers.push(eliminatedPlayer.id);

        // Stay on the results screen.
        game.phase = 'voting-results';
      }

      io.to(roomCode).emit('werewolf-voting-results', {
        votes: voteResults,
        eliminatedPlayer: {
          userId: eliminatedPlayer.id,
          playerName: eliminatedPlayer.playerName,
        },
        isImposter,
      });

      if (isImposter) {
        setTimeout(() => {
          const currentGame = werewolfGames.get(roomCode);

          if (!currentGame) {
            return;
          }

          currentGame.phase = 'imposter-guess';

          io.to(roomCode).emit(
            'werewolf-imposter-guess-start'
          );

          console.log(
            `Imposter final guess started in room ${roomCode}`
          );
        }, 3000);
      }

      // If a Listener was eliminated, wait 3 seconds
      // before automatically starting the next clue round.
      if (!isImposter) {
        setTimeout(() => {
          const currentGame = werewolfGames.get(roomCode);

          if (!currentGame) {
            return;
          }

          currentGame.clues = new Map();
          currentGame.votes = new Map();
          currentGame.phase = 'clue';

          io.to(roomCode).emit('werewolf-new-clue-round');

          console.log(
            `Werewolf new clue round started in room ${roomCode}`
          );
        }, 3000);
      }
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

    // If only one player remains, stop the game
    if (room.users.length < 2) {
      games.delete(roomCode);

      io.to(roomCode).emit('game-ended');
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
