const TMDB_API = 'https://api.themoviedb.org/3';

async function getMovieDetailsById(movieId) {
  if (!process.env.TMDB_API_KEY) return null;

  const url = new URL(`${TMDB_API}/movie/${encodeURIComponent(movieId)}`);
  url.searchParams.set('api_key', process.env.TMDB_API_KEY);
  url.searchParams.set('append_to_response', 'videos');

  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } catch (error) {
    console.warn('TMDB details unavailable:', error.message);
    return null;
  }
}

module.exports = { getMovieDetailsById };
