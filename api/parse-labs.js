// Second pass: extract structured lab values from document text using GPT-4o

const SUPABASE_URL  = 'https://jkitmbtrpswcotgsxpwg.supabase.co';
const SUPABASE_ANON = 'sb_publishable_Pzt-KZGmSl0ebkUwbuvYFg_5ksz0uHq';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const { document_id, text, date } = req.body;
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'OPENAI_API_KEY not set' });
  if (!document_id || !text) return res.status(400).json({ error: 'missing fields' });

  // Truncate to avoid token limits — lab results are usually near the top
  const truncated = text.slice(0, 40000);

  try {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: 'gpt-4o',
        messages: [
          {
            role: 'system',
            content: `You are extracting lab test results from medical document text. The document may contain results from a single visit or many visits across different dates.
Return ONLY a JSON object in this exact format:
{"results": [{"test_name": string, "value": string, "unit": string, "reference_range": string or null, "flag": "Normal" or "High" or "Low" or "Critical" or null, "date": "YYYY-MM-DD" or null}]}

Rules:
- Include every individual lab result you find, one object per test per date
- If the document has results from multiple dates, extract each separately with its own date
- date: find the collection or result date nearest to each result — return as YYYY-MM-DD. If you cannot determine a date for a specific result, return null
- value should be the numeric result as a string
- unit is the measurement unit (mg/dL, %, mmol/L, etc.)
- reference_range is the normal range if shown (e.g. "70-99")
- flag: infer from H/L/HH/LL markers or if value is outside reference range
- If no lab results exist in the document, return {"results": []}
- Do not include vitals like blood pressure or weight unless explicitly labeled as lab tests`
          },
          { role: 'user', content: truncated }
        ],
        response_format: { type: 'json_object' },
      }),
    });

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
      date: r.date || date || null,  // use per-result date, fall back to document date
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

export const config = { api: { bodyParser: { sizeLimit: '20mb' } } };
