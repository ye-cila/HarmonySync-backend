const { createClient } = require('@supabase/supabase-js');

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const supabaseUrl = process.env.SUPABASE_URL?.trim();
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
const isSupabaseConfigured = Boolean(supabaseUrl && serviceRoleKey);

const supabase = isSupabaseConfigured
  ? createClient(supabaseUrl, serviceRoleKey, {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
      },
    })
  : null;

class DatabaseError extends Error {
  constructor(message, statusCode = 502, code = 'DATABASE_ERROR') {
    super(message);
    this.name = 'DatabaseError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

const requireSupabase = () => {
  if (!supabase) {
    throw new DatabaseError(
      'Database integration is not configured',
      503,
      'DATABASE_UNAVAILABLE'
    );
  }

  return supabase;
};

const handleSupabaseError = (operation, error) => {
  console.error(`[Supabase] ${operation} failed`, {
    code: error?.code,
    message: error?.message,
    details: error?.details,
    hint: error?.hint,
  });
  throw new DatabaseError('Database operation failed');
};

const isUuid = (value) => (
  typeof value === 'string' && UUID_PATTERN.test(value)
);

const upsertUser = async ({ spotifyId, displayName, avatarUrl }) => {
  const client = requireSupabase();

  if (!spotifyId || typeof spotifyId !== 'string') {
    throw new DatabaseError('Spotify profile is incomplete', 400, 'INVALID_USER');
  }

  const { data, error } = await client
    .from('users')
    .upsert(
      {
        spotify_id: spotifyId,
        display_name: displayName || null,
        avatar_url: avatarUrl || null,
      },
      { onConflict: 'spotify_id' }
    )
    .select('id, spotify_id, display_name, avatar_url, created_at')
    .single();

  if (error) {
    handleSupabaseError('upsert user', error);
  }

  return data;
};

const saveGameScores = async (scores) => {
  const client = requireSupabase();
  const rows = (Array.isArray(scores) ? scores : [])
    .filter((score) => isUuid(score?.userId) && score?.gameType && Number.isFinite(Number(score.score)))
    .map((score) => ({
      user_id: score.userId,
      game_type: score.gameType,
      score: Math.round(Number(score.score)),
      created_at: score.createdAt || new Date().toISOString(),
    }));

  if (rows.length === 0) {
    return [];
  }

  const { data, error } = await client
    .from('game_scores')
    .insert(rows)
    .select('id, user_id, game_type, score, created_at');

  if (error) {
    handleSupabaseError('save game scores', error);
  }

  return data || [];
};

const getLeaderboard = async (gameType) => {
  const client = requireSupabase();

  const { data, error } = await client
    .from('game_scores')
    .select(`
      user_id,
      score,
      user:users!inner(
        id,
        display_name,
        avatar_url
      )
    `)
    .eq('game_type', gameType);

  if (error) {
    handleSupabaseError('load leaderboard', error);
  }

  const leaderboardMap = new Map();

  for (const entry of data || []) {
    const user = Array.isArray(entry.user)
      ? entry.user[0]
      : entry.user;

    const existing = leaderboardMap.get(entry.user_id);

    if (!existing || Number(entry.score) > existing.highScore) {
      leaderboardMap.set(entry.user_id, {
        userId: entry.user_id,
        displayName: user?.display_name || 'HarmonySync player',
        avatarUrl: user?.avatar_url || null,
        highScore: Number(entry.score) || 0,
      });
    }
  }

  return [...leaderboardMap.values()].sort(
    (a, b) => b.highScore - a.highScore
  );
};

module.exports = {
  DatabaseError,
  getLeaderboard,
  isSupabaseConfigured,
  isUuid,
  saveGameScores,
  upsertUser,
};
