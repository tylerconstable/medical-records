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
        text: `You are extracting lab test results from medical record pages. Look carefully at all tables, columns, and values visible in the images.

Return ONLY a JSON object in this exact format:
{"results": [{"test_name": string, "value": string, "unit": string, "reference_range": string or null, "flag": "Normal" or "High" or "Low" or "Critical" or null, "date": "YYYY-MM-DD" or null}]}

Rules:
- Extract every individual lab test result you can see — one object per test per date
- If a table has multiple date columns, extract each column as a separate result with its own date
- date: find the collection/result date for each result — look for column headers, nearby dates, or date labels
- value: the numeric result as a string
- unit: e.g. mg/dL, %, U/L, mmol/L
- reference_range: the normal range if shown e.g. "70-99"
- flag: infer from H/L/HH/LL markers or asterisks, or if value is clearly outside reference range
- If no lab results are visible, return {"results": []}
- Do not include vitals (BP, weight, height) unless explicitly part of a lab panel`,
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
