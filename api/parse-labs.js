// Second pass: upload PDF directly to OpenAI, extract lab values, delete file

const SUPABASE_URL  = 'https://jkitmbtrpswcotgsxpwg.supabase.co';
const SUPABASE_ANON = 'sb_publishable_Pzt-KZGmSl0ebkUwbuvYFg_5ksz0uHq';

const PROMPT = `Extract ALL lab test results from this document.

Requirements:
- Include EVERY date present
- Include ALL lab markers — do not skip any test
- One result object per test per date
- If a table has multiple date columns, extract each column separately with its own date
- Do NOT omit any values — if a value is missing for a specific date use null
- Do NOT summarize or group date ranges — extract each individual date
- Look carefully at column headers, row labels, and stacked tables
- Flags: look for H/L/HH/LL markers, asterisks, or values outside reference range
- Ignore duplicate rows that are just different reference ranges for the same value

Return ONLY a JSON object:
{"results": [{"test_name": string, "value": string, "unit": string, "reference_range": string or null, "flag": "Normal" or "High" or "Low" or "Critical" or null, "date": "YYYY-MM-DD" or null}]}

If no lab results exist return {"results": []}.`;

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const { document_id, pdf_base64, filename, date } = req.body;
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'OPENAI_API_KEY not set' });
  if (!document_id || !pdf_base64) return res.status(400).json({ error: 'missing fields' });

  let fileId = null;

  try {
    // 1. Upload PDF to OpenAI Files API
    const pdfBuffer = Buffer.from(pdf_base64, 'base64');
    const formData = new FormData();
    formData.append('purpose', 'user_data');
    formData.append('file', new Blob([pdfBuffer], { type: 'application/pdf' }), filename || 'document.pdf');

    const uploadRes = await fetch('https://api.openai.com/v1/files', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}` },
      body: formData,
    });

    if (!uploadRes.ok) {
      const err = await uploadRes.json();
      return res.status(500).json({ error: err.error?.message || 'file upload failed' });
    }

    const fileData = await uploadRes.json();
    fileId = fileData.id;

    // 2. Extract lab values using the uploaded file
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: 'gpt-4o',
        messages: [{
          role: 'user',
          content: [
            { type: 'file', file: { file_id: fileId } },
            { type: 'text', text: PROMPT },
          ],
        }],
        response_format: { type: 'json_object' },
        max_tokens: 8192,
      }),
    });

    if (!response.ok) {
      const err = await response.json();
      return res.status(500).json({ error: err.error?.message || 'extraction failed' });
    }

    const data = await response.json();
    const parsed = JSON.parse(data.choices[0].message.content);
    const results = parsed.results || [];

    // 3. Store in Supabase
    if (results.length) {
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
    }

    return res.status(200).json({ count: results.length });

  } catch (e) {
    return res.status(500).json({ error: e.message });
  } finally {
    // Always delete the file from OpenAI after extraction
    if (fileId) {
      await fetch(`https://api.openai.com/v1/files/${fileId}`, {
        method: 'DELETE',
        headers: { 'Authorization': `Bearer ${apiKey}` },
      }).catch(() => {});
    }
  }
}

export const config = { api: { bodyParser: { sizeLimit: '50mb' } } };
