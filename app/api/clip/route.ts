import { NextRequest, NextResponse } from 'next/server';
import { exec } from 'child_process';
import { promisify } from 'util';
import { extractVideoId } from '@/lib/subtitle';
import { writeFile, readFile, unlink, access } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { randomUUID } from 'crypto';

export const runtime = 'nodejs';
export const maxDuration = 300;
const execAsync = promisify(exec);

async function cleanupOldTempFiles() {
  try {
    const { stdout } = await execAsync(
      `find /tmp -maxdepth 1 \\( -name "raw_*.mp4" -o -name "out_*.mp4" -o -name "cmd_*.sh" \\) 2>/dev/null || true`
    );
    const files = stdout.trim().split('\n').filter(Boolean);
    await Promise.all(files.map(f => unlink(f).catch(() => {})));
    if (files.length > 0) console.log(`[clip] 🧹 Cleaned ${files.length} old temp file(s)`);
  } catch {}
}

async function findYtdlp(): Promise<string> {
  const paths = ['yt-dlp', '/usr/local/bin/yt-dlp', `${process.env.HOME}/.local/bin/yt-dlp`];
  for (const p of paths) {
    try { await execAsync(`${p} --version`, { timeout: 5000 }); return p; } catch {}
  }
  throw new Error('yt-dlp tidak ditemukan. Install: pip install yt-dlp');
}

async function validateStreamUrl(url: string): Promise<boolean> {
  try {
    const { stdout } = await execAsync(
      `ffprobe -v quiet -print_format json -show_streams "${url}"`,
      { timeout: 10000 }
    );
    return stdout.includes('"codec_type"');
  } catch { return false; }
}

export async function POST(req: NextRequest) {
  const id      = randomUUID().slice(0, 8);
  const tmp     = tmpdir();
  const outFile = join(tmp, `out_${id}.mp4`);
  const shFile  = join(tmp, `cmd_${id}.sh`);

  await cleanupOldTempFiles();

  try {
    const { youtubeUrl, start, end } = await req.json();
    const videoId = extractVideoId(youtubeUrl);
    if (!videoId)
      return NextResponse.json({ error: 'Video ID tidak valid' }, { status: 400 });

    const duration = Math.ceil(end - start);
    if (duration <= 0 || duration > 300)
      return NextResponse.json({ error: 'Durasi harus antara 1–300 detik' }, { status: 400 });

    const fullUrl = `https://www.youtube.com/watch?v=${videoId}`;
    const ytdlp   = await findYtdlp();

    console.log('[clip] Step 1: Getting stream URL...');
    let urlOut: string;
    try {
      const result = await execAsync(
        `${ytdlp} --format "bestvideo[height<=1080][ext=mp4]+bestaudio/best[height<=1080][ext=mp4]/best[height<=1080]/best" --get-url --no-playlist --no-warnings --socket-timeout 15 "${fullUrl}"`,
        { timeout: 30000 }
      );
      urlOut = result.stdout;
    } catch (e: any) {
      throw new Error(`Gagal mendapatkan stream URL: ${e.message?.slice(0, 200)}`);
    }

    const urls = urlOut.trim().split('\n').filter((l: string) => l.startsWith('http'));
    if (urls.length === 0)
      throw new Error('Stream URL tidak ditemukan — video mungkin private atau region-locked');

    const videoStreamUrl = urls[0];
    const audioStreamUrl = urls[1] || urls[0];
    const isSeparate     = urls.length >= 2;

    console.log(`[clip] Got ${urls.length} stream URL(s), separate=${isSeparate}`);
    console.log('[clip] Validating stream URL...');
    const isValid = await validateStreamUrl(videoStreamUrl);
    if (!isValid) throw new Error('Stream URL expired atau tidak valid, coba lagi');

    console.log('[clip] Step 2: Creating 9:16 HD split...');
    const inputFlags = isSeparate
      ? `-ss ${start} -i "${videoStreamUrl}" -ss ${start} -i "${audioStreamUrl}"`
      : `-ss ${start} -i "${videoStreamUrl}"`;
    const audioMap = isSeparate ? '-map 1:a' : '-map 0:a?';
    // Layout 9:16 universal — blur background + video center
    const filterComplex = [
      // Scale video ke 1080 lebar (preserve aspect ratio)
      `[0:v]scale=1080:-2:flags=bilinear[scaled]`,
      // Buat blur background 1080x1920
      `[scaled]scale=1080:1920:flags=bilinear,boxblur=20:20[bg]`,
      // Video utama: scale fit dalam 1080x1920
      `[0:v]scale=1080:-2:flags=bilinear[fg]`,
      // Overlay video di tengah background blur
      `[bg][fg]overlay=(W-w)/2:(H-h)/2[out]`,
    ].join(';');

    const sh = `#!/bin/bash
set -e
ffmpeg -y -nostdin \\
  -reconnect 1 -reconnect_streamed 1 -reconnect_delay_max 5 \\
  ${inputFlags} \\
  -t ${duration} \\
  -filter_complex "${filterComplex}" \\
  -map "[out]" ${audioMap} \\
  -c:v libx264 -preset ultrafast -crf 23 -threads 2 \\
  -c:a aac -b:a 192k \\
  -r 30 -pix_fmt yuv420p \\
  -movflags +faststart \\
  "${outFile}"
`;
    await writeFile(shFile, sh, { mode: 0o755 });
    const ffmpegTimeout = Math.min((duration + 60) * 1000, 240000);
    console.log(`[clip] Running FFmpeg (timeout: ${ffmpegTimeout / 1000}s)...`);
    let ffmpegStderr = '';
    try {
      const result = await execAsync(`bash "${shFile}"`, {
        timeout: ffmpegTimeout,
        maxBuffer: 800 * 1024 * 1024,
      });
      ffmpegStderr = result.stderr || '';
    } catch (ffmpegErr: any) {
      ffmpegStderr = ffmpegErr.stderr || ffmpegErr.message || '';
      // Log FULL error - ambil 2000 karakter terakhir
      console.error('[clip] FFmpeg FULL ERROR:\n' + ffmpegStderr.slice(-2000));
      throw ffmpegErr;
    }
    console.log('[clip] FFmpeg done:', ffmpegStderr?.slice(-100));

    const stat = await access(outFile).then(() => true).catch(() => false);
    if (!stat) throw new Error('File output tidak terbuat — FFmpeg gagal diam-diam');

    const videoBuffer = await readFile(outFile);
    if (videoBuffer.length < 1024)
      throw new Error('File output terlalu kecil, kemungkinan FFmpeg gagal');

    console.log(`[clip] ✅ Done! ${(videoBuffer.length / 1024 / 1024).toFixed(1)}MB`);
    await Promise.all([unlink(outFile).catch(() => {}), unlink(shFile).catch(() => {})]);

    return new NextResponse(videoBuffer, {
      status: 200,
      headers: {
        'Content-Type'       : 'video/mp4',
        'Content-Disposition': `attachment; filename="viralclip_${id}.mp4"`,
        'Content-Length'     : String(videoBuffer.length),
      },
    });

  } catch (err: any) {
    await Promise.all([unlink(outFile).catch(() => {}), unlink(shFile).catch(() => {})]);
    const msg = err.message?.slice(0, 300) ?? 'Unknown error';
    console.error('[clip] ERROR:', msg);
    if (err.killed || err.signal === 'SIGTERM' || msg.includes('timeout')) {
      return NextResponse.json(
        { error: 'Proses timeout — coba clip yang lebih pendek (max 90 detik)' },
        { status: 504 }
      );
    }
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
