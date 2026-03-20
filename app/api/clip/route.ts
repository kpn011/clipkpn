import { NextRequest, NextResponse } from 'next/server';
import { exec } from 'child_process';
import { promisify } from 'util';
import { extractVideoId } from '@/lib/subtitle';
import { writeFile, readFile, unlink } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { randomUUID } from 'crypto';

export const runtime = 'nodejs';
export const maxDuration = 60;
const execAsync = promisify(exec);

async function findYtdlp(): Promise<string> {
  const paths = ['yt-dlp', '/usr/local/bin/yt-dlp', `${process.env.HOME}/.local/bin/yt-dlp`];
  for (const p of paths) { try { await execAsync(`${p} --version`); return p; } catch {} }
  throw new Error('yt-dlp tidak ditemukan');
}

export async function POST(req: NextRequest) {
  const id = randomUUID().slice(0, 8);
  const tmp = tmpdir();
  const outFile = join(tmp, `out_${id}.mp4`);
  const shFile  = join(tmp, `cmd_${id}.sh`);

  try {
    const { youtubeUrl, start, end } = await req.json();

    // Support semua format URL: watch, live, youtu.be, shorts
    const videoId = extractVideoId(youtubeUrl);
    if (!videoId) return NextResponse.json({ error: 'Video ID tidak valid' }, { status: 400 });

    const duration = Math.ceil(end - start);
    // Selalu pakai format watch?v= agar kompatibel
    const fullUrl = `https://www.youtube.com/watch?v=${videoId}`;
    const ytdlp   = await findYtdlp();

    // Step 1: Ambil stream URL — minta format terbaik yang ada audio+video
    console.log('[clip] Step 1: Getting stream URL...');
    const { stdout: urlOut } = await execAsync(
      `${ytdlp} --format "bestvideo[height<=1080][ext=mp4]+bestaudio/best[height<=1080][ext=mp4]/best[height<=1080]/best" --get-url --no-playlist --no-warnings "${fullUrl}"`,
      { timeout: 25000 }
    );

    // yt-dlp bisa return 2 URL (video+audio terpisah) atau 1 URL (muxed)
    const urls = urlOut.trim().split('\n').filter((l: string) => l.startsWith('http'));
    if (urls.length === 0) throw new Error('Tidak bisa mendapatkan stream URL');

    // Kalau 2 URL: video terpisah dari audio — pakai keduanya
    // Kalau 1 URL: sudah muxed
    const videoStreamUrl = urls[0];
    const audioStreamUrl = urls[1] || urls[0];
    const isSeparate = urls.length >= 2;

    console.log(`[clip] Got ${urls.length} stream URL(s), separate=${isSeparate}`);

    // Step 2: FFmpeg — cut + 9:16 HD split TANPA GAP
    // Layout 1080x1920:
    // ┌─────────────┐ 0px
    // │  FACECAM HD │ 840px ← crop seluruh frame (facecam biasanya kiri bawah)
    // │             │        upscale lanczos ke full 1080x840
    // ├─────────────┤ 840px ← sambung langsung TANPA gap
    // │  GAMEPLAY   │ 1080px ← scale HD crop center 1080x1080
    // └─────────────┘ 1920px
    console.log('[clip] Step 2: Creating 9:16 HD split...');

    // Input flags
    const inputFlags = isSeparate
      ? `-ss ${start} -i "${videoStreamUrl}" -ss ${start} -i "${audioStreamUrl}"`
      : `-ss ${start} -i "${videoStreamUrl}"`;

    const videoMap = isSeparate ? '[0:v]' : '[0:v]';
    const audioMap = isSeparate ? '-map 1:a' : '-map 0:a?';

    // Facecam: crop pojok kiri bawah 30%w x 35%h, lanczos upscale ke 1080x840
    // Gameplay: scale ke 1920 lebar crop tengah 1080x1080 — TIDAK ada padding hitam
    const filterComplex = [
      `${videoMap}split=2[cam_src][gp_src]`,
      `[cam_src]crop=iw*0.30:ih*0.35:0:ih*0.65,scale=1080:840:flags=lanczos+accurate_rnd,unsharp=5:5:1.0:5:5:0.0,setsar=1[cam]`,
      `[gp_src]scale=1920:1080:flags=lanczos+accurate_rnd,crop=1080:1080:420:0,setsar=1[gp]`,
      `[cam][gp]vstack=inputs=2[out]`,
    ].join(';');

    const sh = `#!/bin/bash
set -e
ffmpeg -y \\
  ${inputFlags} \\
  -t ${duration} \\
  -filter_complex "${filterComplex}" \\
  -map "[out]" ${audioMap} \\
  -c:v libx264 -preset fast -crf 15 \\
  -c:a aac -b:a 192k \\
  -r 30 -pix_fmt yuv420p \\
  -movflags +faststart \\
  "${outFile}"
`;
    await writeFile(shFile, sh, { mode: 0o755 });
    const { stderr } = await execAsync(`bash "${shFile}"`, {
      timeout: 120000,
      maxBuffer: 800 * 1024 * 1024,
    });
    console.log('[clip] FFmpeg done:', stderr?.slice(-100));

    const videoBuffer = await readFile(outFile);
    console.log(`[clip] ✅ Done! ${(videoBuffer.length / 1024 / 1024).toFixed(1)}MB`);

    await Promise.all([unlink(outFile).catch(()=>{}), unlink(shFile).catch(()=>{})]);

    return new NextResponse(videoBuffer, {
      status: 200,
      headers: {
        'Content-Type': 'video/mp4',
        'Content-Disposition': `attachment; filename="viralclip_${id}.mp4"`,
        'Content-Length': String(videoBuffer.length),
      },
    });

  } catch (err: any) {
    await Promise.all([unlink(outFile).catch(()=>{}), unlink(shFile).catch(()=>{})]);
    console.error('[clip] ERROR:', err.message?.slice(0, 500));
    return NextResponse.json({ error: err.message?.slice(0, 300) }, { status: 500 });
  }
}
