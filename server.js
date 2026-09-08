const express = require('express');
const cors = require('cors');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 8888;

// Middleware
app.use(cors());
app.use(express.json());

// Endpoint checking server status
app.get('/', (req, res) => {
  res.send('🚀 HarmonySync Backend Server is Running!');
});

// Endpoint checking env variables status
app.get('/api/test-config', (req, res) => {
  res.json({
    message: "Successfully checked!",
    clientIdLoaded: !!process.env.SPOTIFY_CLIENT_ID,
    redirectUri: process.env.REDIRECT_URI
  });
});

// Lắng nghe cổng
app.listen(PORT, '127.0.0.1', () => {
  console.log(`=================================`);
  console.log(`🎉 Server is running at: http://127.0.0.1:${PORT}`);
  console.log(`=================================`);
});