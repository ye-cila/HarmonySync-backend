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

    room.users = room.users.filter((user) => user.id !== userId);

    io.to(roomCode).emit('room-users', room.users);
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

  socket.on('next-round', ({ roomCode }) => {
    const game = games.get(roomCode);
    const room = rooms.get(roomCode);

    if (!game || !room) {
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
