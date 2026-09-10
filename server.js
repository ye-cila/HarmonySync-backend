const express = require('express');
const cors = require('cors');
const axios = require('axios');
const querystring = require('querystring');
require('dotenv').config();

const CLIENT_URL = process.env.CLIENT_URL || 'http://127.0.0.1:5173';
const { generateRandomString, generateCodeChallenge } = require('./pkceHelper');

const app = express();
const PORT = process.env.PORT || 8888;

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

// Endpoint checking server status
app.get('/', (req, res) => {
  res.send('🚀 HarmonySync Backend Server is Running!');
});

app.listen(PORT, () => {
  console.log(`=================================`);
  console.log(`🎉 Server is running at: http://127.0.0.1:${PORT}`);
  console.log(`=================================`);
});
