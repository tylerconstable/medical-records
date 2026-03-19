// Receives text chunks, generates embeddings via OpenAI, stores in Supabase

const SUPABASE_URL  = 'https://xjcrtucwycyllzqyylwd.supabase.co';
const SUPABASE_ANON = 'sb_publishable_mFL0D4uzwnUdv7uZulHFug_kmWmpEpX';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const { document_id, chunks } = req.body;
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'OPENAI_API_KEY not set' });
  if (!document_id || !chunks?.length) return res.status(400).json({ error: 'missing document_id or chunks' });

  try {
    // Embed all chunks in one API call (OpenAI supports up to 2048 inputs)
    const embRes = await fetch('https://api.openai.com/v1/embeddings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: 'text-embedding-3-small',
        input: chunks.map(c => c.content),
      }),
    });

    if (!embRes.ok) {
      const err = await embRes.json();
      return res.status(500).json({ error: err.error?.message || 'embedding failed' });
    }

    const embData = await embRes.json();
    const embeddings = embData.data.map(d => d.embedding);

    // Insert chunks into Supabase
    const rows = chunks.map((chunk, i) => ({
      document_id,
      content: chunk.content,
      embedding: embeddings[i],
      page: chunk.page,
    }));

    const insertRes = await fetch(`${SUPABASE_URL}/rest/v1/chunks`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': SUPABASE_ANON,
        'Authorization': `Bearer ${SUPABASE_ANON}`,
        'Prefer': 'return=minimal',
      },
      body: JSON.stringify(rows),
    });

    if (!insertRes.ok) {
      const err = await insertRes.text();
      return res.status(500).json({ error: err });
    }

    return res.status(200).json({ ok: true, chunks: rows.length });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}

export const config = { api: { bodyParser: { sizeLimit: '20mb' } } };
