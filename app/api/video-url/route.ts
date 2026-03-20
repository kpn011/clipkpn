import { NextRequest, NextResponse } from 'next/server';
import { exec } from 'child_process';
import { promisify } from 'util';
import { extractVideoId } from '@/lib/subtitle';

export const runtime = 'nodejs';
export const maxDuration = 25;
const execAsync = promisify(exec);

export async function POST(req: NextRequest) {
  try {
    const { youtubeUrl } = await req.json();
    const videoId = extractVideoId(youtubeUrl);
    if (!videoId) return NextResponse.json({ error: 'Video ID tidak valid' }, { status: 400 });

    const fullUrl = `https://www.youtube.com/watch?v=${videoId}`;
    const cmd = `yt-dlp --no-playlist --format "best[height<=480][ext=mp4]/best[height<=480]/best" --get-url --no-warnings "${fullUrl}"`;
    const { stdout } = await execAsync(cmd, { timeout: 20000 });
    const lines = stdout.trim().split('\n').filter((l: string) => l.startsWith('http'));

    if (lines.length === 0)
      return NextResponse.json({ error: 'yt-dlp tidak bisa ambil URL.' }, { status: 422 });

    return NextResponse.json({ videoUrl: lines[0], quality: '480p' });
  } catch (err: any) {
    if (err.message?.includes('not found'))
      return NextResponse.json({ error: 'yt-dlp belum install.' }, { status: 500 });
    return NextResponse.json({ error: err.message?.slice(0, 200) }, { status: 500 });
  }
}
