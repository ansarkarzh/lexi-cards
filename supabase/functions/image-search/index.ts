const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  });
}

async function isSignedIn(req: Request) {
  const response = await fetch(`${Deno.env.get('SUPABASE_URL')}/auth/v1/user`, {
    headers: {
      apikey: req.headers.get('apikey') ?? '',
      Authorization: req.headers.get('Authorization') ?? '',
    },
  });
  return response.ok;
}

Deno.serve(async req => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: CORS_HEADERS });
  }

  if (!(await isSignedIn(req))) {
    return json({ error: 'Sign in required' }, 401);
  }

  const { query } = await req.json().catch(() => ({}));
  if (typeof query !== 'string' || !query.trim() || query.length > 100) {
    return json({ error: 'Invalid query' }, 400);
  }

  const url = `https://api.pexels.com/v1/search?per_page=12&query=${encodeURIComponent(query.trim())}`;
  const response = await fetch(url, { headers: { Authorization: Deno.env.get('PEXELS_API_KEY') ?? '' } });
  if (!response.ok) {
    return json({ error: `Pexels responded with ${response.status}` }, 502);
  }

  const data = await response.json();
  const photos = data.photos.map((photo: { src: { medium: string }; alt: string; photographer: string }) => ({
    src: photo.src.medium,
    alt: photo.alt,
    photographer: photo.photographer,
  }));
  return json({ photos });
});
