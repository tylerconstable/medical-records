// Second pass: extract structured lab values from PDF page images using GPT-4o Vision

const SUPABASE_URL  = 'https://jkitmbtrpswcotgsxpwg.supabase.co';
const SUPABASE_ANON = 'sb_publishable_Pzt-KZGmSl0ebkUwbuvYFg_5ksz0uHq';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const { document_id, images, date } = req.body;
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'OPENAI_API_KEY not set' });
  if (!document_id || !images?.length) return res.status(400).json({ error: 'missing fields' });

  try {
    // Build vision message — send page images so GPT-4o can see actual table layout
    const content = [
      {
        type: 'text',
        text: `Extract ALL lab values from these medical record pages.

Requirements:
- Include EVERY date present in the document
- Include ALL lab markers visible — do not skip any test
- One result object per test per date
- If a table has multiple date columns, extract each column separately with its own date
- Do NOT omit any values — if a value is missing for a date use null
- Do NOT summarize or group date ranges — extract each individual date
- Look carefully at column headers for dates, and row labels for test names
- Flags: look for H/L/HH/LL markers, asterisks, or values outside reference range
- Remove duplicate rows that are just different reference ranges for the same value

Return ONLY a JSON object:
{"results": [{"test_name": string, "value": string, "unit": string, "reference_range": string or null, "flag": "Normal" or "High" or "Low" or "Critical" or null, "date": "YYYY-MM-DD" or null}]}

If no lab results are visible return {"results": []}.`,
      },
      ...images.map(img => ({
        type: 'image_url',
        image_url: { url: `data:image/jpeg;base64,${img}`, detail: 'high' },
      })),
    ];

    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: 'gpt-4o',
        messages: [{ role: 'user', content }],
        response_format: { type: 'json_object' },
        max_tokens: 4096,
      }),
    });

    if (!response.ok) {
      const err = await response.json();
      return res.status(500).json({ error: err.error?.message || 'GPT-4o vision call failed' });
    }

    const data = await response.json();
    const parsed = JSON.parse(data.choices[0].message.content);
    const results = parsed.results || [];

    if (!results.length) return res.status(200).json({ count: 0 });

    // Store in Supabase
    const rows = results.map(r => ({
      document_id,
      test_name: r.test_name,
      value: r.value,
      unit: r.unit || null,
      reference_range: r.reference_range || null,
      flag: r.flag || null,
      date: r.date || date || null,
    }));

    const insertRes = await fetch(`${SUPABASE_URL}/rest/v1/lab_values`, {
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

    return res.status(200).json({ count: rows.length });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}

export const config = { api: { bodyParser: { sizeLimit: '50mb' } } };
