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
    `https://api.supadata.ai/v1/youtube/transcript?videoId=${videoId}&text=false`,
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
  if (items.length < 3) throw new Error('Supadata: transcript terlalu pendek');

  return items.map((item: any) => ({
    offset  : Number(item.offset) / 1000,
    text    : String(item.text || ''),
    duration: Number(item.duration) / 1000,
  }));
}

async function getTranscript(videoId: string): Promise<{ segments: TranscriptSegment[]; source: string }> {
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
  throw new Error('Transcript tidak tersedia. Pastikan video memiliki subtitle/CC aktif, atau coba video lain.');
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
          { role: 'user', content: `Find up to 3 VIRAL clip moments (30-90s each). Return ONLY: {"clips":[{"start":0,"end":60,"title":"title","hook":"hook","viral_score":9,"viral_reason":"reason"}]}\n\nTranscript:\n${compressed}` },
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
