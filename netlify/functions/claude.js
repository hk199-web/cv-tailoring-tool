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

// cv_import: Haiku reicht für strukturiertes Parsing und ist deutlich schneller
// duplicate_check: ebenfalls Haiku
const MODEL_FAST = 'claude-haiku-4-5';
const MODEL_REASONING = 'claude-sonnet-5'; // für spätere komplexere Schritte

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

const JOB_EXTRACT_PROMPT = `Du analysierst eine Stellenanzeige und zerlegst sie in strukturierte Anforderungen.

Regeln:
- Erfinde nichts. Nur was tatsächlich in der Anzeige steht.
- Trenne Muss-Anforderungen von Kann-Anforderungen. Formulierungen wie "zwingend", "Voraussetzung", "mindestens" deuten auf muss; "wünschenswert", "von Vorteil", "idealerweise" auf kann.
- Eine Anforderung = ein Eintrag. Aufzählungen mit mehreren Kompetenzen in einem Satz aufteilen.
- Formuliere jede Anforderung knapp und neutral, ohne Werbesprache der Anzeige.
- tonalitaet: wie die Anzeige klingt, in 3 bis 6 Wörtern (z. B. "förmlich, konservativ" oder "locker, Du-Ansprache").
- sprache: "de" oder "en", je nachdem in welcher Sprache die Anzeige verfasst ist.

Antworte ausschließlich mit JSON in genau dieser Form. Keine Backticks, keine Erklärung:

{"unternehmen":"...","stellentitel":"...","sprache":"de","branche":"...","tonalitaet":"...","anforderungen":[{"text":"...","prioritaet":"muss","kategorie":"fachlich"}]}

Erlaubte Werte für prioritaet: "muss", "kann".
Erlaubte Werte für kategorie: "fachlich", "methodisch", "persoenlich", "formal".`;

const MATCHING_PROMPT = `Du gleichst die Anforderungen einer Stellenanzeige mit den vorhandenen Bausteinen eines Bewerbungs-Content-Pools ab.

Regeln:
- Ordne jeder Anforderung die Bausteine zu, die sie tatsächlich belegen. Ein Baustein kann mehrere Anforderungen belegen.
- staerke "stark": der Baustein belegt die Anforderung direkt und nachweisbar.
- staerke "teilweise": es gibt inhaltliche Nähe, aber kein direkter Nachweis.
- Ist zu einer Anforderung nichts vorhanden, lass sie in "treffer" weg und führe sie unter "luecken" auf.
- Sei streng. Eine erfundene oder weit hergeholte Zuordnung ist schlechter als eine ehrlich benannte Lücke.

Antworte ausschließlich mit JSON in genau dieser Form. Keine Backticks, keine Erklärung:

{"treffer":[{"anforderung_index":0,"baustein_id":"...","staerke":"stark","begruendung":"..."}],"luecken":[{"anforderung_index":0,"hinweis":"..."}]}`;

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
    if (body.text) {
      messages = [{
        role: 'user',
        content: CV_IMPORT_PROMPT + '\n\nLebenslauf:\n\n' + String(body.text).slice(0, 20000)
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

  } else if (task === 'job_extract') {
    if (!body.text) return json(400, { error: 'Es wurde keine Stellenanzeige übergeben.' });
    messages = [{
      role: 'user',
      content: JOB_EXTRACT_PROMPT + '\n\nStellenanzeige:\n\n' + String(body.text).slice(0, 20000)
    }];

  } else if (task === 'matching') {
    messages = [{
      role: 'user',
      content: MATCHING_PROMPT +
        '\n\nAnforderungen:\n' + JSON.stringify(body.anforderungen || []).slice(0, 20000) +
        '\n\nVorhandene Bausteine:\n' + JSON.stringify(body.bausteine || []).slice(0, 40000)
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
      body: JSON.stringify({
        model: task === 'matching' ? MODEL_REASONING : MODEL_FAST,
        max_tokens: 4000,
        messages
      })
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
