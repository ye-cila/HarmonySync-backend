# HarmonySync Backend

### Real-Time Multiplayer Backend for HarmonySync

[Live Backend »](https://harmonysync-backend.onrender.com)

Real-time Node.js backend powering Spotify authentication, multiplayer rooms, music games, and persistent player rankings for HarmonySync.

[Frontend App](https://harmony-sync-orpin.vercel.app/) · [Frontend Repository](https://github.com/ye-cila/HarmonySync-frontend)

## About The Project

This is the backend service for **HarmonySync**, a Spotify-powered social multiplayer application that lets friends connect through their music taste.

Built with **Node.js**, **Express**, and **Socket.IO**, the backend handles Spotify authentication, room management, real-time multiplayer state, music compatibility, game logic, and score persistence.

### Key Features:

- **Spotify Integration:** OAuth + PKCE authentication, profile synchronization, and Spotify API communication.
- **Multiplayer Rooms:** Create and join rooms with unique room codes and synchronized player state.
- **Real-Time Communication:** Socket.IO keeps players synchronized across rooms without polling.
- **Context Blend:** Generates shared music recommendations based on the listening tastes of players in a room.
- **Spotify Guess:** Real-time music guessing game with server-side answer validation and time-based scoring.
- **Music Werewolf:** Multiplayer deduction game with clues, voting, elimination, and imposter guessing.
- **Persistent Leaderboard:** Game scores are stored in Supabase and used to generate player rankings.
- **Production Deployment:** Backend deployed on Render with environment-based configuration.

## Built With

- [Node.js](https://nodejs.org/)
- [Express](https://expressjs.com/)
- [Socket.IO](https://socket.io/)
- [Supabase](https://supabase.com/)
- [Spotify Web API](https://developer.spotify.com/documentation/web-api/)
- [Axios](https://axios-http.com/)
- [Render](https://render.com/)

## Architecture

```text
                    Spotify
                       │
                  OAuth / PKCE
                       │
                       ▼
                ┌──────────────┐
                │    Express   │
                │      API     │
                └──────┬───────┘
                       │
                       ▼
                ┌──────────────┐
                │   Socket.IO  │
                │  Multiplayer │
                └──────┬───────┘
                       │
          ┌────────────┼────────────┐
          │            │            │
        Rooms     Context Blend    Games
          │                         │
          │                 ┌───────┴───────┐
          │                 │               │
          │          Spotify Guess    Music Werewolf
          │
          ▼
     In-Memory State
                       │
                       ▼
                  Supabase
                       │
                ┌──────┴──────┐
                │             │
              Users       Game Scores
````

## Real-Time Multiplayer

HarmonySync uses **Socket.IO** to maintain synchronized state between players in the same room.

When a player joins a room, the backend:

1. Validates the room and player.
2. Adds the player to the Socket.IO room.
3. Stores their Spotify listening data.
4. Broadcasts the updated player list.
5. Synchronizes game and music state with connected clients.

This event-driven architecture allows room state and game actions to update immediately across multiple clients.

## Game Architecture

### Spotify Guess

The backend controls the game state and scoring logic.

Each round:

```text
Track Selection
      ↓
Player Answers
      ↓
Server Validation
      ↓
Time-Based Scoring
      ↓
Round Result
      ↓
Next Round
```
Final scores are persisted to Supabase for the leaderboard.

### Music Werewolf

Music Werewolf uses a server-managed game state with multiple phases:

```text
Clue
 ↓
Voting
 ↓
Voting Results
 ↓
Imposter Guess
 ↓
Game Result
```

The backend manages roles, clues, votes, player elimination, timers, and game progression.

## Database

Supabase stores persistent data that should survive beyond an active multiplayer session.

### Users

Stores basic Spotify profile information:

```text
users
├── id
├── spotify_id
├── display_name
├── avatar_url
└── created_at
```

### Game Scores

Stores completed game scores:

```text
game_scores
├── id
├── user_id
├── game_type
├── score
└── created_at
```

The leaderboard uses a JavaScript `Map` to track each player's highest score before sorting the results.

## Engineering Decisions

### In-Memory Multiplayer State

Active rooms and games are stored in JavaScript `Map` objects.

This keeps frequently changing multiplayer state fast and simple while avoiding unnecessary database operations during gameplay.

Persistent information such as users and completed game scores is stored separately in Supabase.

### Server-Side Game Logic

Game rules and scoring are handled by the backend instead of trusting the client.

This allows the server to validate actions, control game phases, and calculate scores consistently for every player.

### Event-Driven Communication

Socket.IO was chosen instead of polling because multiplayer actions are naturally event-based.

```text
Player Action
     ↓
Backend Updates State
     ↓
Socket.IO Event
     ↓
All Relevant Clients
```

## Getting Started

### Prerequisites

* **Node.js** (v18+ recommended)
* **npm**
* Spotify Developer account
* Supabase project

### Installation

Clone the repository:

```bash
git clone https://github.com/ye-cila/HarmonySync-backend.git
cd HarmonySync-backend
```

Install dependencies:

```bash
npm install
```

Create a `.env` file:

```env
PORT=8888

CLIENT_URL=http://127.0.0.1:5173

SPOTIFY_CLIENT_ID=your_spotify_client_id
SPOTIFY_CLIENT_SECRET=your_spotify_client_secret
REDIRECT_URI=http://127.0.0.1:8888/callback

SUPABASE_URL=your_supabase_url
SUPABASE_SERVICE_ROLE_KEY=your_supabase_service_role_key
```

Start the server:

```bash
node server.js
```

The backend will run at:

```text
http://127.0.0.1:8888
```

> Never commit `.env` or expose `SPOTIFY_CLIENT_SECRET` or `SUPABASE_SERVICE_ROLE_KEY`.

## Testing

Run the Context Blend tests with:

```bash
npm test
```

## Deployment

The backend is deployed on **Render**.

**Runtime:** Node.js
**Start Command:** `node server.js`

## Future Improvements

* Redis-backed shared room state for horizontal scaling
* More persistent game statistics and history
* Stronger OAuth session/state management
* Expanded multiplayer game modes

## Related

**Frontend:**
[https://github.com/ye-cila/HarmonySync-frontend](https://github.com/ye-cila/HarmonySync-frontend)

**Live Application:**
[https://harmony-sync-orpin.vercel.app/](https://harmony-sync-orpin.vercel.app/)

**Live Backend:**
[https://harmonysync-backend.onrender.com](https://harmonysync-backend.onrender.com)

## Contact

Alice Nguyen - [LinkedIn](https://www.linkedin.com/in/alice-nguyen-b62ba2385/) - [Email](mailto:alicephgthao@gmail.com)
