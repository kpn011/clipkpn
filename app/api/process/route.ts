import { NextRequest, NextResponse } from 'next/server';
import { YoutubeTranscript } from 'youtube-transcript';
import { compressTranscript, extractVideoId, TranscriptSegment } from '@/lib/subtitle';
export const runtime = 'nodejs';
export const maxDuration = 30;

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { youtubeUrl, model } = body;
    const apiKey = process.env.OPENROUTER_API_KEY || '';
    console.log('[process] API key exists:', !!apiKey, '| length:', apiKey.length);
    if (!youtubeUrl)
      return NextResponse.json({ error: 'URL diperlukan' }, { status: 400 });
    if (!apiKey)
      return NextResponse.json({ error: 'Set OPENROUTER_API_KEY di .env.local' }, { status: 400 });
    const videoId = extractVideoId(youtubeUrl);
    if (!videoId)
      return NextResponse.json({ error: 'URL YouTube tidak valid' }, { status: 400 });

    console.log('[process] Fetching transcript for:', videoId);
    let rawTranscript: TranscriptSegment[] = [];

    // Layer 1: bahasa Inggris
    try {
      const data = await YoutubeTranscript.fetchTranscript(videoId, { lang: 'en' });
      rawTranscript = data.map(t => ({ offset: t.offset/1000, text: t.text, duration: t.duration/1000 }));
    } catch {}

    // Layer 2: bahasa Indonesia
    if (rawTranscript.length < 5) {
      try {
        const data = await YoutubeTranscript.fetchTranscript(videoId, { lang: 'id' });
        rawTranscript = data.map(t => ({ offset: t.offset/1000, text: t.text, duration: t.duration/1000 }));
      } catch {}
    }

    // Layer 3: bahasa apapun
    if (rawTranscript.length < 5) {
      try {
        const data = await YoutubeTranscript.fetchTranscript(videoId);
        rawTranscript = data.map(t => ({ offset: t.offset/1000, text: t.text, duration: t.duration/1000 }));
      } catch {}
    }

    if (rawTranscript.length < 5)
      return NextResponse.json({ error: 'Transcript tidak ditemukan. Pastikan video memiliki CC/subtitle aktif.' }, { status: 422 });

    const compressed = compressTranscript(rawTranscript);
    const selectedModel = model || process.env.OPENROUTER_MODEL || 'mistralai/mistral-small-3.1-24b-instruct';

    const aiRes = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://viralclip.ai',
        'X-Title': 'ViralClip AI',
      },
      body: JSON.stringify({
        model: selectedModel,
        max_tokens: 600,
        temperature: 0.4,
        messages: [
          { role: 'system', content: 'You are a viral content expert. Return ONLY valid JSON.' },
          { role: 'user', content: `You are a viral content strategist for short-form video (TikTok, Reels, YouTube Shorts).
Analyze this transcript and find up to 3 moments with the HIGHEST viral potential.

VIRAL criteria:
1. Shocking/surprising revelation or plot twist
2. Emotional peak (funny, angry, sad, excited)
3. Controversial or debate-worthy statement
4. Relatable moment that triggers comments
5. Quotable one-liner or memorable phrase

Each clip must be 30-90 seconds. Pick moments that make viewers STOP scrolling.

Return ONLY valid JSON:
{"clips":[{"start":0,"end":60,"title":"catchy title max 6 words","hook":"first sentence that hooks viewer","viral_score":9,"viral_reason":"why this will get views"}]}

Transcript:
${compressed}` },
        ],
      }),
    });

    if (!aiRes.ok) {
      const errText = await aiRes.text();
      return NextResponse.json({ error: `OpenRouter error: ${aiRes.status} — ${errText.slice(0,200)}` }, { status: 502 });
    }

    const aiData = await aiRes.json();
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

    return NextResponse.json({ clips, videoId, totalTranscriptEntries: rawTranscript.length, modelUsed: selectedModel });
  } catch (err: any) {
    console.error('[process] ERROR:', err.message);
    return NextResponse.json({ error: err.message || 'Server error' }, { status: 500 });
  }
}
