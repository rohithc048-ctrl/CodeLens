import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import fs from 'node:fs';
import path from 'node:path';

// Helper to securely read Gemini API key from .env during local development
function getLocalApiKey(): string {
  try {
    const envPath = path.resolve(process.cwd(), '.env');
    if (fs.existsSync(envPath)) {
      const content = fs.readFileSync(envPath, 'utf8');
      const match = content.match(/GEMINI_API_KEY=(.+)/);
      if (match && match[1]) {
        return match[1].trim();
      }
    }
  } catch (err) {
    console.error('[Vite Server] Failed reading .env:', err);
  }
  return process.env.GEMINI_API_KEY || '';
}

const GEMINI_MODEL = 'gemini-3.5-flash-lite';

async function callGemini(prompt: string, systemPrompt?: string, isJson: boolean = false): Promise<string> {
  const apiKey = getLocalApiKey();
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY is not configured in .env');
  }

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`;
  const payload: any = {
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: { temperature: 0.2 },
  };

  if (systemPrompt) {
    payload.systemInstruction = { parts: [{ text: systemPrompt }] };
  }
  if (isJson) {
    payload.generationConfig.responseMimeType = 'application/json';
  }

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    throw new Error(`Gemini API Error HTTP ${res.status}: ${await res.text()}`);
  }

  const data = (await res.json()) as any;
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error('No candidate content returned from Gemini');
  return text;
}

const ANALYSIS_SCHEMA_PROMPT = `You are CodeLens AI, an expert code analyzer, debugger, tutor, and compiler engineer.
Analyze the provided code and return ONLY valid JSON matching this schema:
{
  "language": "string",
  "confidence": number,
  "frameworks": ["string"],
  "libraries": ["string"],
  "database": "string or null",
  "summary": "1-2 sentence high-level summary",
  "errors": [{
    "id": "err-1",
    "line": 1,
    "severity": "error",
    "type": "syntax|runtime|logical|type|security|performance",
    "title": "Short descriptive title",
    "code": "problematic line of code",
    "explanation": "What is wrong",
    "why": "Underlying cause",
    "fix": "Actionable instructions on how to fix it",
    "corrected_code": "The single fixed replacement line"
  }],
  "warnings": [{
    "id": "warn-1",
    "line": 1,
    "severity": "warning",
    "type": "syntax|runtime|logical|type|security|performance",
    "title": "Short title",
    "code": "line of code",
    "explanation": "What warning condition was triggered",
    "why": "Why this pattern can be dangerous or slow",
    "fix": "Recommended modification",
    "corrected_code": "The recommended replacement line"
  }],
  "suggestions": [{
    "id": "sug-1",
    "line": 1,
    "severity": "suggestion",
    "type": "performance|logical|syntax",
    "title": "Optimization or simplification",
    "code": "line of code",
    "explanation": "How to improve",
    "why": "Benefit",
    "fix": "Suggested adjustment",
    "corrected_code": "Optional improved line"
  }],
  "line_explanations": [{
    "line_start": 1,
    "line_end": 1,
    "code": "line or block of code",
    "explanation": "Line explanation",
    "why_used": "Why it is used",
    "concept": "Concept name"
  }],
  "concepts": [{
    "id": "c1",
    "name": "Concept Name",
    "category": "Core Programming|Control Flow|Data Structures|Security|Memory",
    "what": "What is it?",
    "why": "Why is it important?",
    "how": "How does it work?",
    "where_used": "Where in the code is it applied?",
    "example": "Small illustrative example",
    "level": "BEGINNER|INTERMEDIATE|ADVANCED"
  }],
  "corrected_code": "Complete, working, clean, production-ready corrected code",
  "changes": ["Line X: Concise description of change made"],
  "quality_score": {
    "overall": 85,
    "correctness": 90,
    "readability": 85,
    "performance": 80,
    "security": 95,
    "maintainability": 85
  }
}
If the input code is already 100% clean and correct, errors and warnings should be empty arrays, suggestions may contain optional idioms, and quality_score.overall should be 100.`;

function geminiLocalDevPlugin(): Plugin {
  return {
    name: 'gemini-local-dev-server',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const url = req.url || '';

        if (url === '/api/status' && req.method === 'GET') {
          const key = getLocalApiKey();
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({
            ok: true,
            serverSide: true,
            model: GEMINI_MODEL,
            hasApiKey: !!key,
            keyPreview: key ? `${key.substring(0, 5)}...${key.substring(key.length - 4)}` : null,
          }));
          return;
        }

        if (url === '/api/analyze' && req.method === 'POST') {
          try {
            const body = await parseBody(req);
            const userPrompt = `Analyze this code${body.languageHint ? ` (hint: ${body.languageHint})` : ''}:\n\n\`\`\`\n${body.code}\n\`\`\``;
            const jsonText = await callGemini(userPrompt, ANALYSIS_SCHEMA_PROMPT, true);
            const parsed = JSON.parse(jsonText);
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({
              ...parsed,
              rawCode: body.code,
              timestamp: Date.now(),
              monacoLanguage: parsed.language?.toLowerCase() || 'python',
              aiModel: GEMINI_MODEL,
              backendProtected: true,
            }));
          } catch (err: any) {
            console.error('[Local Dev /api/analyze Error]', err.message);
            res.statusCode = 500;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ error: err.message || 'Analysis failed' }));
          }
          return;
        }

        if (url === '/api/reverify' && req.method === 'POST') {
          try {
            const body = await parseBody(req);
            const reverifySystemPrompt = `You are CodeLens AI Auditor and Scribe Verifier.
Your job is to rigorously re-verify whether a corrected code snippet successfully fixes the original code's defects.
Return ONLY valid JSON matching this schema:
{
  "status": "VERIFIED_PRISTINE | VERIFIED_WITH_SUGGESTIONS | REVERIFY_DEFECTS_REMAIN",
  "score": number (0-100),
  "summary": "1-2 sentence auditor conclusion",
  "fixedBugs": ["Description of bug that was resolved"],
  "remainingRisks": ["Any remaining risk or empty array if clean"],
  "certificationTitle": "e.g. Audit Pass Certificate / Pristine Execution Seal",
  "auditDetails": "Detailed paragraph explaining the mathematical/runtime guarantee of the fix",
  "executionSafety": "SAFE_TO_DEPLOY | NEEDS_ATTENTION | CRITICAL_DEFECTS",
  "quality_score": {
    "overall": 100,
    "correctness": 100,
    "readability": 95,
    "performance": 95,
    "security": 100,
    "maintainability": 95
  }
}`;
            const prompt = `ORIGINAL CODE:\n\`\`\`${body.language || ''}\n${body.originalCode}\n\`\`\`\n\nCORRECTED CODE:\n\`\`\`${body.language || ''}\n${body.correctedCode}\n\`\`\`\n\nPerform a comprehensive re-verification audit. Has every defect been eliminated?`;
            const jsonText = await callGemini(prompt, reverifySystemPrompt, true);
            const parsed = JSON.parse(jsonText);
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({
              ...parsed,
              timestamp: Date.now(),
              model: GEMINI_MODEL,
            }));
          } catch (err: any) {
            console.error('[Local Dev /api/reverify Error]', err.message);
            res.statusCode = 500;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ error: err.message || 'Re-verification failed' }));
          }
          return;
        }

        if (url === '/api/chat' && req.method === 'POST') {
          try {
            const body = await parseBody(req);
            const systemPrompt = `You are the CodeLens AI Scribe & Master Programming Tutor.
You embody scholarly, tactile craftsmanship: thorough, precise, encouraging, and razor-sharp.
Point out exact line numbers and concrete mechanisms. Keep explanations structured with crisp headers.`;

            let context = 'No code analysis sheet loaded.';
            if (body.analysis) {
              context = `ACTIVE CODE SHEET:
Language: ${body.analysis.language}
Score: ${body.analysis.quality_score?.overall || 'N/A'}/100
Issues: ${body.analysis.errors?.length || 0} errors, ${body.analysis.warnings?.length || 0} warnings
Current Code:
\`\`\`
${body.analysis.rawCode || ''}
\`\`\`
Corrected Code:
\`\`\`
${body.analysis.corrected_code || ''}
\`\`\``;
            }

            const conversationHistory = (body.history || [])
              .slice(-6)
              .map((m: any) => `${m.role.toUpperCase()}: ${m.content}`)
              .join('\n\n');

            const fullPrompt = `${context}\n\n${conversationHistory ? `RECENT CONVERSATION:\n${conversationHistory}\n\n` : ''}USER QUESTION: "${body.question}"`;
            const reply = await callGemini(fullPrompt, systemPrompt, false);
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ reply }));
          } catch (err: any) {
            console.error('[Local Dev /api/chat Error]', err.message);
            res.statusCode = 500;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ error: err.message || 'Chat failed' }));
          }
          return;
        }

        next();
      });
    },
  };
}

function parseBody(req: any): Promise<any> {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk: any) => { raw += chunk; });
    req.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    geminiLocalDevPlugin(),
  ],
});
