// =========================================================================
// Claude-Proxy für das CV-Tailoring-Tool
//
// Zweck: Der Anthropic-API-Schlüssel darf niemals im Browser landen.
// Diese Datei läuft auf dem Netlify-Server. Der Schlüssel wird dort als
// Umgebungsvariable ANTHROPIC_API_KEY hinterlegt und nie mit ausgeliefert.
//
// Die Prompts stehen bewusst hier und nicht im Frontend — sonst könnte
// jemand über die eigene App beliebige Anfragen auf eure Rechnung stellen.
// =========================================================================

const MODEL = 'claude-sonnet-5';
const MAX_PDF_BYTES = 4 * 1024 * 1024; // 4 MB — darüber lehnt Netlify die Anfrage ohnehin ab

const CV_IMPORT_PROMPT = `Du analysierst einen Lebenslauf und zerlegst ihn in einzelne, wiederverwendbare Bausteine für einen Content-Pool.

Regeln:
- Erfinde nichts. Übernimm nur, was tatsächlich im Dokument steht.
- Eine berufliche Station = ein Baustein der Kategorie "erfahrung".
- Fachliche Fähigkeiten, Sprachen, Werkzeuge = jeweils ein Baustein der Kategorie "skill".
- Schulen, Studium, Weiterbildungen = Kategorie "ausbildung".
- Zusammenfassungen, Profile oder Über-mich-Abschnitte = Kategorie "leitbild".
- Bei mehrspaltigen Layouts: Ordne Aufzählungspunkte der Station zu, zu der sie inhaltlich gehören, nicht der räumlich nächstgelegenen.
- Vergib pro Baustein 1 bis 4 Tags, die die dahinterliegende Kompetenz benennen (z. B. "Führung", "Vertrieb", "Projektmanagement"). Keine Tags, die nur den Firmennamen wiederholen.
- Titel kurz halten: Rolle und Zeitraum, z. B. "Teamleitung Vertrieb 2021–2024".
- Der Text übernimmt die inhaltlichen Aussagen der Station, leicht geglättet, ohne Ausschmückung.

Antworte ausschließlich mit JSON in genau dieser Form. Keine Backticks, keine Erklärung, kein Text davor oder danach:

{"bausteine":[{"category":"erfahrung","title":"...","text":"...","tags":["...","..."]}]}`;

const DUPLICATE_PROMPT = `Du vergleichst neu importierte Lebenslauf-Bausteine mit bereits vorhandenen Einträgen eines Content-Pools.

Aufgabe: Finde heraus, welche neuen Bausteine dieselbe berufliche Station oder dieselbe Fähigkeit beschreiben wie ein vorhandener Eintrag — auch wenn sie anders formuliert sind.

Gleiche Station heißt: gleicher Arbeitgeber und überlappender Zeitraum, auch bei abweichender Rollenbezeichnung.
Unterschiedliche Rollen beim selben Arbeitgeber in unterschiedlichen Zeiträumen sind KEINE Dubletten.

Antworte ausschließlich mit JSON in genau dieser Form. Keine Backticks, keine Erklärung:

{"treffer":[{"neu_index":0,"vorhanden_id":"...","begruendung":"..."}]}`;

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return json(405, { error: 'Nur POST erlaubt' });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return json(500, { error: 'ANTHROPIC_API_KEY ist auf dem Server nicht gesetzt.' });
  }

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return json(400, { error: 'Ungültige Anfrage.' });
  }

  const { task } = body;
  let messages;

  if (task === 'cv_import') {
    // Zwei Wege: PDF wird als Dokument übergeben (Layout bleibt erhalten),
    // DOCX-Text kommt bereits als reiner Text an.
    if (body.pdfBase64) {
      const approxBytes = (body.pdfBase64.length * 3) / 4;
      if (approxBytes > MAX_PDF_BYTES) {
        return json(413, { error: 'Die Datei ist zu groß. Bitte eine PDF unter 4 MB verwenden.' });
      }
      messages = [{
        role: 'user',
        content: [
          { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: body.pdfBase64 } },
          { type: 'text', text: CV_IMPORT_PROMPT }
        ]
      }];
    } else if (body.text) {
      messages = [{
        role: 'user',
        content: CV_IMPORT_PROMPT + '\n\nLebenslauf:\n\n' + String(body.text).slice(0, 60000)
      }];
    } else {
      return json(400, { error: 'Es wurde kein Dokument übergeben.' });
    }

  } else if (task === 'duplicate_check') {
    messages = [{
      role: 'user',
      content: DUPLICATE_PROMPT +
        '\n\nVorhandene Einträge:\n' + JSON.stringify(body.vorhanden || []).slice(0, 60000) +
        '\n\nNeue Bausteine:\n' + JSON.stringify(body.neu || []).slice(0, 60000)
    }];

  } else {
    return json(400, { error: 'Unbekannte Aufgabe.' });
  }

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({ model: MODEL, max_tokens: 8000, messages })
    });

    if (!response.ok) {
      const detail = await response.text();
      console.error('Anthropic-Fehler:', response.status, detail);
      return json(502, { error: 'Die Analyse ist fehlgeschlagen. Bitte später erneut versuchen.' });
    }

    const data = await response.json();
    const raw = (data.content || [])
      .filter(b => b.type === 'text')
      .map(b => b.text)
      .join('\n')
      .replace(/```json|```/g, '')
      .trim();

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      console.error('Antwort war kein gültiges JSON:', raw.slice(0, 500));
      return json(502, { error: 'Die Antwort konnte nicht gelesen werden. Bitte erneut versuchen.' });
    }

    return json(200, parsed);

  } catch (err) {
    console.error('Netzwerkfehler:', err);
    return json(502, { error: 'Verbindung zur Analyse fehlgeschlagen.' });
  }
};

function json(statusCode, payload) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  };
}
