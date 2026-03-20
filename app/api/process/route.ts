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

    let rawTranscript: TranscriptSegment[] = [];
    try {
      const data = await YoutubeTranscript.fetchTranscript(videoId, { lang: 'en' });
      rawTranscript = data.map(t => ({ offset: t.offset/1000, text: t.text, duration: t.duration/1000 }));
    } catch {
      try {
        const data = await YoutubeTranscript.fetchTranscript(videoId);
        rawTranscript = data.map(t => ({ offset: t.offset/1000, text: t.text, duration: t.duration/1000 }));
      } catch {
        return NextResponse.json({ error: 'Transcript tidak ditemukan.' }, { status: 422 });
      }
    }

    if (rawTranscript.length < 5)
      return NextResponse.json({ error: 'Transcript terlalu pendek' }, { status: 422 });

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
          { role: 'user', content: `Find up to 3 VIRAL clip moments (30-90s each). Return ONLY: {"clips":[{"start":0,"end":60,"title":"title","hook":"hook","viral_score":9,"viral_reason":"reason"}]}\n\nTranscript:\n${compressed}` },
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
    return NextResponse.json({ error: err.message || 'Server error' }, { status: 500 });
  }
}
