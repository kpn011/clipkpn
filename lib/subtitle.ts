export type TranscriptSegment = {
  offset: number;
  text: string;
  duration?: number;
};

const VIRAL_COLORS = [
  '&H0000FFFF',
  '&H00FFFFFF',
  '&H0000FF00',
  '&H00FF00FF',
  '&H00FFFF00',
];

export function generateASS(
  segments: TranscriptSegment[],
  clipStart: number,
  clipEnd: number
): string {
  const header = `[Script Info]
ScriptType: v4.00+
PlayResX: 1920
PlayResY: 1080
ScaledBorderAndShadow: yes
Timer: 100.0000

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Arial Black,58,&H0000FFFF,&H000000FF,&H00000000,&HAA000000,-1,0,0,0,100,100,0,0,1,4,2,2,10,10,90,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;
  const clipDuration = clipEnd - clipStart;
  const relevant = segments.filter(
    (s) => s.offset >= clipStart - 0.5 && s.offset < clipEnd
  );
  let events = '';
  let colorIndex = 0;
  for (const seg of relevant) {
    const relStart = Math.max(0, seg.offset - clipStart);
    const rawDuration = seg.duration ?? estimateDuration(seg.text);
    const relEnd = Math.min(relStart + rawDuration, clipDuration);
    if (relStart >= clipDuration) continue;
    const words = seg.text.trim().toUpperCase().split(/\s+/);
    const chunks: string[] = [];
    for (let i = 0; i < words.length; i += 4) {
      chunks.push(words.slice(i, i + 4).join(' '));
    }
    const chunkDur = Math.max(0.3, (relEnd - relStart) / chunks.length);
    for (let ci = 0; ci < chunks.length; ci++) {
      const cs = relStart + ci * chunkDur;
      const ce = Math.min(cs + chunkDur, clipDuration);
      const color = VIRAL_COLORS[colorIndex % VIRAL_COLORS.length];
      colorIndex++;
      events += `Dialogue: 0,${fmt(cs)},${fmt(ce)},Default,,0,0,0,,{\\c${color}\\an2\\bord4\\shad3\\3c&H00000000&\\4c&H80000000&}${chunks[ci]}\n`;
    }
  }
  return header + events;
}

function fmt(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  const cs = Math.floor((sec % 1) * 100);
  return `${h}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}.${String(cs).padStart(2,'0')}`;
}

function estimateDuration(text: string): number {
  return Math.max(1.2, text.split(/\s+/).length / 2.5);
}

export function compressTranscript(segments: TranscriptSegment[]): string {
  const sampled = segments.filter((_, i) => i % 2 === 0).slice(0, 120);
  return sampled.map((s) => `[${Math.round(s.offset)}s] ${s.text.trim()}`).join('\n');
}

export function extractVideoId(url: string): string | null {
  try {
    const u = new URL(url);
    if (u.hostname === 'youtu.be') return u.pathname.slice(1).split('?')[0];
    if (u.searchParams.has('v')) return u.searchParams.get('v');
    const liveMatch = u.pathname.match(/\/live\/([^/?]+)/);
    if (liveMatch) return liveMatch[1];
    const embedMatch = u.pathname.match(/\/embed\/([^/?]+)/);
    if (embedMatch) return embedMatch[1];
    const shortsMatch = u.pathname.match(/\/shorts\/([^/?]+)/);
    if (shortsMatch) return shortsMatch[1];
    return null;
  } catch {
    if (/^[a-zA-Z0-9_-]{11}$/.test(url.trim())) return url.trim();
    return null;
  }
}
