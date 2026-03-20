import { NextRequest, NextResponse } from 'next/server';
import { YoutubeTranscript } from 'youtube-transcript';
import { compressTranscript, extractVideoId, TranscriptSegment } from '@/lib/subtitle';
import { exec } from 'child_process';
import { promisify } from 'util';

export const runtime = 'nodejs';
export const maxDuration = 60;

const execAsync = promisify(exec);


async function setupCookieFile(): Promise<string | null> {
  const cookieB64 = process.env.YOUTUBE_COOKIES_B64;
  if (!cookieB64) return null;
  try {
    const { writeFile } = await import('fs/promises');
    const cookiePath = '/tmp/yt_cookies.txt';
    await writeFile(cookiePath, Buffer.from(cookieB64, 'base64'));
    console.log('[process] Cookie ready at', cookiePath);
    return cookiePath;
  } catch (e: any) {
    console.error('[process] Cookie write failed:', e.message);
    return null;
  }
}

async function findYtdlp(): Promise<string> {
  const paths = ['yt-dlp', '/usr/local/bin/yt-dlp', `${process.env.HOME}/.local/bin/yt-dlp`];
  for (const p of paths) {
    try { await execAsync(`${p} --version`, { timeout: 5000 }); return p; } catch {}
  }
  throw new Error('yt-dlp tidak ditemukan');
}

async function getTranscriptViaYtdlp(videoId: string, cookiePath?: string | null): Promise<TranscriptSegment[]> {
  const ytdlp = await findYtdlp();
  const cookieArg = cookiePath ? `--cookies "${cookiePath}"` : "";
  const url   = `https://www.youtube.com/watch?v=${videoId}`;
  await execAsync(
    `${ytdlp} --write-auto-subs --write-subs --sub-format vtt --sub-langs "en,id,en-US,en-GB" --skip-download --no-playlist ${cookieArg} -o "/tmp/subs_${videoId}" "${url}" 2>/dev/null || ` +
    `${ytdlp} --write-auto-subs --sub-format vtt --sub-langs "all" --skip-download --no-playlist ${cookieArg} -o "/tmp/subs_${videoId}" "${url}" 2>/dev/null || true`,
    { timeout: 30000 }
  );
  const { stdout: files } = await execAsync(`ls /tmp/subs_${videoId}*.vtt 2>/dev/null || true`);
  const vttFiles = files.trim().split('\n').filter(Boolean);
  if (vttFiles.length === 0) throw new Error('Tidak ada subtitle file ditemukan');
  const { stdout: vttContent } = await execAsync(`cat "${vttFiles[0]}"`);
  const segments: TranscriptSegment[] = [];
  const lines = vttContent.split('\n');
  let i = 0;
  while (i < lines.length) {
    const line = lines[i].trim();
    const timeMatch = line.match(/(\d{2}):(\d{2}):(\d{2})\.(\d{3})\s+-->\s+(\d{2}):(\d{2}):(\d{2})\.(\d{3})/);
    if (timeMatch) {
      const toSec = (h: string, m: string, s: string, ms: string) =>
        parseInt(h) * 3600 + parseInt(m) * 60 + parseInt(s) + parseInt(ms) / 1000;
      const start = toSec(timeMatch[1], timeMatch[2], timeMatch[3], timeMatch[4]);
      const end   = toSec(timeMatch[5], timeMatch[6], timeMatch[7], timeMatch[8]);
      i++;
      const textLines: string[] = [];
      while (i < lines.length && lines[i].trim() !== '') {
        const clean = lines[i].replace(/<[^>]+>/g, '').trim();
        if (clean) textLines.push(clean);
        i++;
      }
      const text = textLines.join(' ').trim();
      if (text) segments.push({ offset: start, text, duration: end - start });
    } else { i++; }
  }
  await execAsync(`rm -f /tmp/subs_${videoId}* 2>/dev/null || true`);
  if (segments.length < 3) throw new Error('Subtitle terlalu sedikit');
  return segments;
}


async function getTranscriptViaSupadata(videoId: string): Promise<TranscriptSegment[]> {
  const apiKey = process.env.SUPADATA_API_KEY;
  if (!apiKey) throw new Error('SUPADATA_API_KEY tidak ada');

  const res = await fetch(
    `https://api.supadata.ai/v1/youtube/transcript?videoId=${videoId}`,
    {
      headers: {
        'x-api-key': apiKey,
        'Content-Type': 'application/json',
      },
    }
  );

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Supadata error: ${res.status} — ${err.slice(0, 100)}`);
  }

  const data = await res.json();
  const items = data?.content ?? [];
  const arr = Array.isArray(items) ? items : [];
  if (arr.length < 1) throw new Error('Supadata: tidak ada transcript');

  const segments: TranscriptSegment[] = [];
  for (const item of arr) {
    const offsetMs  = Number(item.offset ?? item.start ?? 0);
    const durMs     = Number(item.duration ?? item.dur ?? 10000);
    const offsetSec = offsetMs > 1000 ? offsetMs / 1000 : offsetMs;
    const durSec    = durMs    > 1000 ? durMs    / 1000 : durMs;
    const text      = String(item.text ?? item.content ?? '').trim();
    if (!text) continue;
    if (durSec > 15 && text.length > 50) {
      const words = text.split(' ');
      const chunkSec = 8;
      const chunks = Math.ceil(durSec / chunkSec);
      const perChunk = Math.ceil(words.length / chunks);
      for (let i = 0; i < chunks; i++) {
        const w = words.slice(i * perChunk, (i+1) * perChunk).join(' ');
        if (w) segments.push({ offset: offsetSec + i * chunkSec, text: w, duration: chunkSec });
      }
    } else {
      segments.push({ offset: offsetSec, text, duration: durSec });
    }
  }
  if (segments.length < 1) throw new Error('Supadata: transcript kosong');
  return segments;

  return items.map((item: any) => ({
    offset  : Number(item.offset) / 1000,
    text    : String(item.text || ''),
    duration: Number(item.duration) / 1000,
  }));
}


async function getTranscriptViaGroqWhisper(videoId: string): Promise<TranscriptSegment[]> {
  const groqKey = process.env.GROQ_API_KEY;
  if (!groqKey) throw new Error('GROQ_API_KEY tidak ada');

  const ytdlp = await findYtdlp();
  const url   = `https://www.youtube.com/watch?v=${videoId}`;
  const audioFile = `/tmp/audio_${videoId}.mp3`;

  console.log('[process] Groq: downloading audio...');
  try {
    const cookiePath = await setupCookieFile();
    const cookieArg  = cookiePath ? `--cookies "${cookiePath}"` : '';
    await execAsync(
      `${ytdlp} -f bestaudio --extract-audio --audio-format mp3 --audio-quality 5 ` +
      `--no-playlist ${cookieArg} --no-warnings ` +
      `-o "${audioFile}" "${url}"`,
      { timeout: 90000 }
    );
  } catch (e: any) {
    throw new Error('Groq: gagal download audio: ' + e.message?.slice(0,100));
  }

  console.log('[process] Groq: transcribing...');
  const { readFile, unlink } = await import('fs/promises');
  try {
    const audioBuffer = await readFile(audioFile);
    const formData    = new FormData();
    const blob        = new Blob([audioBuffer], { type: 'audio/mp3' });
    formData.append('file', blob, 'audio.mp3');
    formData.append('model', 'whisper-large-v3-turbo');
    formData.append('response_format', 'verbose_json');
    formData.append('timestamp_granularities[]', 'segment');

    const res = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
      method : 'POST',
      headers: { 'Authorization': `Bearer ${groqKey}` },
      body   : formData,
    });

    await unlink(audioFile).catch(() => {});

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Groq error: ${res.status} — ${err.slice(0,100)}`);
    }

    const data     = await res.json();
    const segs     = data?.segments ?? [];
    if (segs.length < 1) throw new Error('Groq: tidak ada segment');

    console.log('[process] Groq: got', segs.length, 'segments');
    return segs.map((s: any) => ({
      offset  : Number(s.start ?? 0),
      text    : String(s.text ?? '').trim(),
      duration: Number((s.end ?? 0) - (s.start ?? 0)),
    }));
  } catch (e: any) {
    await unlink(audioFile).catch(() => {});
    throw e;
  }
}

async function getTranscript(videoId: string): Promise<{ segments: TranscriptSegment[]; source: string }> {
  // Layer 0: Supadata API
  try {
    const segments = await getTranscriptViaSupadata(videoId);
    if (segments.length >= 1) return { segments, source: 'supadata' };
  } catch (e: any) {
    console.log('[process] Supadata failed:', e.message?.slice(0,100));
  }

  try {
    const data = await YoutubeTranscript.fetchTranscript(videoId, { lang: 'en' });
    const segments = data.map(t => ({ offset: t.offset/1000, text: t.text, duration: t.duration/1000 }));
    if (segments.length >= 5) return { segments, source: 'youtube-en' };
  } catch {}
  try {
    const data = await YoutubeTranscript.fetchTranscript(videoId, { lang: 'id' });
    const segments = data.map(t => ({ offset: t.offset/1000, text: t.text, duration: t.duration/1000 }));
    if (segments.length >= 5) return { segments, source: 'youtube-id' };
  } catch {}
  try {
    const data = await YoutubeTranscript.fetchTranscript(videoId);
    const segments = data.map(t => ({ offset: t.offset/1000, text: t.text, duration: t.duration/1000 }));
    if (segments.length >= 5) return { segments, source: 'youtube-auto' };
  } catch {}
  try {
    const cookiePath = await setupCookieFile();
    const segments = await getTranscriptViaYtdlp(videoId, cookiePath);
    return { segments, source: 'ytdlp-vtt' };
  } catch {}
  // Layer 5: Groq Whisper — transcribe dari audio (fallback terakhir)
  try {
    console.log('[process] Trying Groq Whisper...');
    const segments = await getTranscriptViaGroqWhisper(videoId);
    return { segments, source: 'groq-whisper' };
  } catch (e: any) {
    console.log('[process] Groq failed:', e.message?.slice(0,100));
  }

  throw new Error('Tidak bisa mendapatkan transcript. Coba lagi beberapa saat.');
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { youtubeUrl, model } = body;
    const apiKey = process.env.OPENROUTER_API_KEY || '';
    console.log('[process] API key exists:', !!apiKey, '| length:', apiKey.length);
    if (!youtubeUrl)
      return NextResponse.json({ error: 'URL diperlukan' }, { status: 400 });
    if (!apiKey)
      return NextResponse.json({ error: 'Set OPENROUTER_API_KEY di environment variables' }, { status: 400 });
    const videoId = extractVideoId(youtubeUrl);
    if (!videoId)
      return NextResponse.json({ error: 'URL YouTube tidak valid' }, { status: 400 });
    console.log(`[process] Fetching transcript for: ${videoId}`);
    let rawTranscript: TranscriptSegment[];
    let transcriptSource: string;
    try {
      const result = await getTranscript(videoId);
      rawTranscript    = result.segments;
      transcriptSource = result.source;
      console.log(`[process] Transcript via ${transcriptSource}: ${rawTranscript.length} segments`);
    } catch (e: any) {
      return NextResponse.json({ error: e.message }, { status: 422 });
    }
    if (rawTranscript.length < 5)
      return NextResponse.json({ error: 'Transcript terlalu pendek untuk dianalisis' }, { status: 422 });
    const compressed    = compressTranscript(rawTranscript);
    const selectedModel = model || process.env.OPENROUTER_MODEL || 'mistralai/mistral-small-3.1-24b-instruct';
    console.log(`[process] Calling AI: ${selectedModel}`);
    const aiRes = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization:  `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://viralclip.ai',
        'X-Title':      'ViralClip AI',
      },
      body: JSON.stringify({
        model: selectedModel, max_tokens: 600, temperature: 0.4,
        messages: [
          { role: 'system', content: 'You are a viral content expert. Return ONLY valid JSON.' },
          { role: 'user', content: `You are a viral content strategist for short-form video (TikTok, Reels, YouTube Shorts).
Analyze this transcript and find up to 3 moments with the HIGHEST viral potential.

VIRAL criteria (prioritize in order):
1. Shocking/surprising revelation or plot twist
2. Emotional peak (funny, angry, sad, excited)
3. Controversial or debate-worthy statement
4. Relatable moment that triggers comments
5. Quotable one-liner or memorable phrase
6. Conflict or tension moment

Each clip must be 30-90 seconds. Pick moments that make viewers STOP scrolling.

Return ONLY valid JSON:
{"clips":[{"start":0,"end":60,"title":"catchy title max 6 words","hook":"first sentence that hooks viewer in 2 seconds","viral_score":9,"viral_reason":"why this will get views and shares"}]}

Transcript:
\${compressed}` },
        ],
      }),
    });
    if (!aiRes.ok) {
      const errText = await aiRes.text();
      return NextResponse.json({ error: `OpenRouter error: ${aiRes.status} — ${errText.slice(0,200)}` }, { status: 502 });
    }
    const aiData  = await aiRes.json();
    const rawText: string = aiData?.choices?.[0]?.message?.content ?? '';
    let clips: any[] = [];
    try {
      const jsonMatch = rawText.match(/\{[\s\S]*\}/);
      if (!jsonMatch) throw new Error('No JSON');
      const parsed = JSON.parse(jsonMatch[0]);
      clips = (parsed.clips ?? []).slice(0, 3).map((c: any) => ({
        start: Number(c.start)||0, end: Number(c.end)||60,
        title: String(c.title||'Viral Clip'), hook: String(c.hook||''),
        viral_score: Number(c.viral_score)||7, viral_reason: String(c.viral_reason||''),
        segments: [],
      }));
    } catch {
      return NextResponse.json({ error: 'AI response tidak bisa di-parse.' }, { status: 500 });
    }
    clips = clips.map(clip => ({
      ...clip,
      segments: rawTranscript.filter(s => s.offset >= clip.start-1 && s.offset <= clip.end+1),
    }));
    return NextResponse.json({ clips, videoId, totalTranscriptEntries: rawTranscript.length, modelUsed: selectedModel, transcriptSource });
  } catch (err: any) {
    console.error('[process] ERROR:', err.message);
    return NextResponse.json({ error: err.message || 'Server error' }, { status: 500 });
  }
}
