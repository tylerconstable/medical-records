// Embeds question, finds relevant chunks + lab values, streams answer

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

    // 2. Vector search — most relevant text chunks
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

    // 3. Fetch all structured lab values (with document date)
    const labRes = await fetch(
      `${SUPABASE_URL}/rest/v1/lab_values?select=test_name,value,unit,reference_range,flag,date,document_id&order=date.asc`,
      {
        headers: {
          'apikey': SUPABASE_ANON,
          'Authorization': `Bearer ${SUPABASE_ANON}`,
        },
      }
    );
    const labValues = await labRes.json();

    // 4. Build context
    const chunkContext = chunks.length
      ? chunks.map((c, i) => `[Excerpt ${i + 1} — page ${c.page ?? '?'}]\n${c.content}`).join('\n\n---\n\n')
      : 'No relevant excerpts found.';

    // Group lab values by test name for trend visibility
    let labContext = '';
    if (labValues.length) {
      const byTest = {};
      for (const lv of labValues) {
        if (!byTest[lv.test_name]) byTest[lv.test_name] = [];
        byTest[lv.test_name].push(lv);
      }
      labContext = Object.entries(byTest).map(([name, rows]) => {
        const entries = rows.map(r =>
          `  ${r.date || 'unknown date'}: ${r.value} ${r.unit || ''}${r.flag ? ` [${r.flag}]` : ''}${r.reference_range ? ` (ref: ${r.reference_range})` : ''}`
        ).join('\n');
        return `${name}:\n${entries}`;
      }).join('\n\n');
    }

    // 5. Stream answer from GPT-4o
    const systemPrompt = `You are a precise medical records assistant. Answer the user's question using the structured lab data and document excerpts provided below.

For trend questions (e.g. "is my glucose going up?"), use the structured lab table — it shows values chronologically across all documents.
For general questions, use the document excerpts.
Always cite dates and values. If information is missing, say so clearly. Do not speculate.

--- STRUCTURED LAB VALUES (all documents, chronological) ---
${labContext || 'No structured lab values extracted yet.'}

--- DOCUMENT EXCERPTS (most relevant to question) ---
${chunkContext}`;

    const chatRes = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: 'gpt-4o',
        stream: true,
        messages: [
          { role: 'system', content: systemPrompt },
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
