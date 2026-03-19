// Embeds user question, finds relevant chunks, streams Claude answer

const SUPABASE_URL  = 'https://xjcrtucwycyllzqyylwd.supabase.co';
const SUPABASE_ANON = 'sb_publishable_mFL0D4uzwnUdv7uZulHFug_kmWmpEpX';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const { question } = req.body;
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'OPENAI_API_KEY not set' });
  if (!question) return res.status(400).json({ error: 'missing question' });

  try {
    // 1. Embed the question
    const embRes = await fetch('https://api.openai.com/v1/embeddings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
      body: JSON.stringify({ model: 'text-embedding-3-small', input: question }),
    });
    const embData = await embRes.json();
    const embedding = embData.data[0].embedding;

    // 2. Find the most relevant chunks from Supabase
    const searchRes = await fetch(`${SUPABASE_URL}/rest/v1/rpc/match_chunks`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': SUPABASE_ANON,
        'Authorization': `Bearer ${SUPABASE_ANON}`,
      },
      body: JSON.stringify({ query_embedding: embedding, match_count: 10 }),
    });
    const chunks = await searchRes.json();

    if (!chunks.length) {
      return res.status(200).json({ answer: 'No relevant records found for that question.' });
    }

    // 3. Build context from chunks — include document info
    const context = chunks.map((c, i) =>
      `[Excerpt ${i + 1} — page ${c.page ?? '?'}]\n${c.content}`
    ).join('\n\n---\n\n');

    // 4. Stream answer from OpenAI (gpt-4o sees all context + question)
    const chatRes = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: 'gpt-4o',
        stream: true,
        messages: [
          {
            role: 'system',
            content: `You are a precise medical records assistant. Answer the user's question based only on the provided excerpts from their medical records.
- Cite specific values, dates, and document sources when available.
- If the excerpts don't contain enough information to answer, say so clearly.
- Do not speculate or add information not present in the excerpts.
- Format numbers and lab values clearly.

Medical record excerpts:
${context}`,
          },
          { role: 'user', content: question },
        ],
      }),
    });

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('X-Accel-Buffering', 'no');

    const reader = chatRes.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(value);
    }
    res.end();

  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}

export const config = { api: { bodyParser: { sizeLimit: '1mb' } } };
