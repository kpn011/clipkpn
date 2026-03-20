'use client';

import { useState, useRef, useCallback, useEffect } from 'react';
import type { TranscriptSegment } from '@/lib/subtitle';

type Clip = { start: number; end: number; title: string; hook: string; viral_score: number; viral_reason: string; segments: TranscriptSegment[]; };
type ProcessStatus = 'idle' | 'transcript' | 'analyzing' | 'done' | 'error';
type ClipState = { status: 'idle' | 'loading-video' | 'cutting' | 'subtitles' | 'encoding' | 'done' | 'error'; progress: number; message: string; downloadUrl: string | null; fileName: string | null; };

function fmtTime(sec: number) { const m = Math.floor(sec / 60); const s = Math.floor(sec % 60); return `${m}:${String(s).padStart(2, '0')}`; }
function fmtDuration(start: number, end: number) { return `${Math.round(end - start)}s`; }
function scoreColor(score: number) { if (score >= 8) return '#ff2d78'; if (score >= 6) return '#f59e0b'; return '#8888aa'; }
function fmtASS(s) {
  const h=Math.floor(s/3600),m=Math.floor((s%3600)/60),sc=Math.floor(s%60),ms=Math.floor((s%1)*100);
  return h+':'+String(m).padStart(2,'0')+':'+String(sc).padStart(2,'0')+'.'+String(ms).padStart(2,'0');
}
function generateASSContent(segments, clipStart, clipEnd) {
  const H = ['[Script Info]','ScriptType: v4.00+','PlayResX: 1080','PlayResY: 1920','ScaledBorderAndShadow: yes','','[V4+ Styles]','Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding','Style: Default,Arial Black,68,&H0000FFFF,&H000000FF,&H00000000,&H99000000,-1,0,0,0,100,100,1,0,1,5,2,8,30,30,860,1','','[Events]','Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',''].join('\n');
  const COLORS = ['&H0000FFFF','&H00FFFFFF','&H0000FF00','&H00FF00FF','&H0000D7FF'];
  const clipDur = clipEnd - clipStart;
  const relevant = segments.filter(function(s){return s.offset>=clipStart&&s.offset<clipEnd;});
  let events='',ci=0;
  for(const seg of relevant){
    const relStart=Math.max(0,seg.offset-clipStart);
    const segDur=seg.duration?Math.min(seg.duration,4.0):Math.max(0.6,seg.text.trim().split(' ').length/3.5);
    const relEnd=Math.min(relStart+segDur,clipDur);
    if(relStart>=clipDur) continue;
    const txt=seg.text.trim().toUpperCase().replace(/[<>]/g,'');
    if(!txt) continue;
    const words=txt.split(' ').filter(Boolean);
    const chunks=[];
    for(let i=0;i<words.length;i+=4) chunks.push(words.slice(i,i+4).join(' '));
    const chunkDur=(relEnd-relStart)/chunks.length;
    for(let j=0;j<chunks.length;j++){
      const cs=relStart+j*chunkDur;
      const ce=Math.min(cs+chunkDur,clipDur);
      if(cs>=clipDur) break;
      const color=COLORS[ci%COLORS.length];ci++;
      events+='Dialogue: 0,'+fmtASS(cs)+','+fmtASS(ce)+',Default,,0,0,0,,{\\c'+color+'\\an8\\bord5\\shad2\\3c&H00000000&}'+chunks[j]+'\n';
    }
  }
  return H+events;
}
function sanitizeFilename(name: string) { return name.replace(/[^a-z0-9]/gi, '_').slice(0, 40).toLowerCase(); }

let ffmpegInstance: any = null;
let ffmpegLoaded = false;

async function getFFmpeg() {
  if (!ffmpegLoaded) {
    const { FFmpeg } = await import('@ffmpeg/ffmpeg');
    const { toBlobURL } = await import('@ffmpeg/util');
    ffmpegInstance = new FFmpeg();
    const base = 'https://unpkg.com/@ffmpeg/core@0.12.6/dist/umd';
    await ffmpegInstance.load({
      coreURL: await toBlobURL(`${base}/ffmpeg-core.js`, 'text/javascript'),
      wasmURL: await toBlobURL(`${base}/ffmpeg-core.wasm`, 'application/wasm'),
    });
    ffmpegLoaded = true;
  }
  return ffmpegInstance;
}




export default function Home() {
  const [youtubeUrl, setYoutubeUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [model, setModel] = useState('mistralai/mistral-small-3.1-24b-instruct');
  const [showSettings, setShowSettings] = useState(false);
  const [status, setStatus] = useState<ProcessStatus>('idle');
  const [statusMsg, setStatusMsg] = useState('');
  const [clips, setClips] = useState<Clip[]>([]);
  const [videoId, setVideoId] = useState('');
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [modelUsed, setModelUsed] = useState('');
  const [clipStates, setClipStates] = useState<ClipState[]>([]);
  const [ffmpegReady, setFfmpegReady] = useState(false);
  const [ffmpegLoading, setFfmpegLoading] = useState(false);

  useEffect(() => {
    const saved = localStorage.getItem('vca_api_key'); if (saved) setApiKey(saved);
    const savedModel = localStorage.getItem('vca_model'); if (savedModel) setModel(savedModel);
  }, []);

  const saveApiKey = (key: string) => { setApiKey(key); if (key) localStorage.setItem('vca_api_key', key); };
  const saveModel = (m: string) => { setModel(m); localStorage.setItem('vca_model', m); };

  const updateClipState = useCallback((idx: number, update: Partial<ClipState>) => {
    setClipStates((prev) => { const next = [...prev]; next[idx] = { ...next[idx], ...update }; return next; });
  }, []);

  const handleProcess = async () => {
    if (!youtubeUrl.trim()) return;
    if (!apiKey.trim()) { alert('Masukkan OpenRouter API Key di Settings ⚙️'); setShowSettings(true); return; }
    setStatus('transcript'); setStatusMsg('Mengambil transcript...'); setClips([]); setVideoUrl(null); setClipStates([]);
    try {
      const res = await fetch('/api/process', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ youtubeUrl, model }) });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      setStatus('analyzing'); setStatusMsg('AI menganalisis momen viral...');
      await new Promise((r) => setTimeout(r, 500));
      setClips(data.clips); setVideoId(data.videoId); setModelUsed(data.modelUsed);
      setClipStates(data.clips.map((): ClipState => ({ status: 'idle', progress: 0, message: '', downloadUrl: null, fileName: null })));
      setStatus('done'); setStatusMsg(`${data.clips.length} clips ditemukan!`);
      loadFFmpeg();
    } catch (err: any) { setStatus('error'); setStatusMsg(err.message || 'Terjadi kesalahan'); }
  };

  const loadFFmpeg = async () => {
    if (ffmpegReady || ffmpegLoading) return;
    setFfmpegLoading(true);
    try { await getFFmpeg(); setFfmpegReady(true); } catch (e) { console.error('FFmpeg load failed:', e); } finally { setFfmpegLoading(false); }
  };

  const fetchVideoUrl = async (): Promise<string | null> => {
    if (videoUrl) return videoUrl;
    try {
      const res = await fetch('/api/video-url', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ youtubeUrl }) });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setVideoUrl(data.videoUrl); return data.videoUrl;
    } catch { return null; }
  };

  const handleProcessClip = async (clipIdx: number) => {
    const clip = clips[clipIdx];
    updateClipState(clipIdx, { status: 'cutting', progress: 10, message: 'Menghubungi server...' });
    try {
      updateClipState(clipIdx, { progress: 25, message: 'Download + potong di server (30-60 detik)...' });
      const res = await fetch('/api/clip', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ youtubeUrl, start: clip.start, end: clip.end }),
      });
      updateClipState(clipIdx, { progress: 85, message: 'Hampir selesai...' });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || 'Server error');
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const fileName = 'viralclip_' + sanitizeFilename(clip.title) + '_' + Math.round(clip.start) + 's.mp4';
      updateClipState(clipIdx, { status: 'done', progress: 100, message: 'Selesai! 🎉', downloadUrl: url, fileName });
    } catch (err: any) {
      updateClipState(clipIdx, { status: 'error', message: err.message?.slice(0, 120) || 'Proses gagal' });
    }
  };

  const canProcess = youtubeUrl.trim().length > 5 && status !== 'transcript' && status !== 'analyzing';

  return (
    <main>
      <div className="container">
        <div className="hero">
          <div className="logo"><div className="logo-icon">✂️</div><span className="logo-text">ViralClip AI</span></div>
          <h1>Auto Clip YouTube<br /><span>Berpotensi Viral</span></h1>
          <p>Paste URL YouTube → AI cari momen terbaik → Download clips dengan subtitle berwarna otomatis</p>
        </div>

        <div className="card input-card">
          <label className="input-label">🔗 YouTube URL</label>
          <div className="url-row">
            <input className="url-input" type="url" placeholder="https://youtube.com/watch?v=..." value={youtubeUrl} onChange={(e) => setYoutubeUrl(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && canProcess && handleProcess()} />
            <button className={`btn btn-primary ${status === 'transcript' || status === 'analyzing' ? 'pulse' : ''}`} onClick={handleProcess} disabled={!canProcess}>
              {status === 'transcript' || status === 'analyzing' ? <><span className="spinner" />Proses...</> : '⚡ Generate'}
            </button>
          </div>
          <button className="settings-toggle" onClick={() => setShowSettings((v) => !v)}>⚙️ Pengaturan {showSettings ? '▲' : '▼'}</button>
          {showSettings && (
            <div className="settings-grid">
              <div>
                <label className="input-label">🔑 OpenRouter API Key</label>
                <input className="url-input" type="password" placeholder="sk-or-v1-..." value={apiKey} onChange={(e) => saveApiKey(e.target.value)} />
                <p style={{ fontSize: 11, color: 'var(--muted)', marginTop: 5 }}>Dapatkan di <a href="https://openrouter.ai/keys" target="_blank" rel="noreferrer" style={{ color: 'var(--accent3)' }}>openrouter.ai/keys</a></p>
              </div>
              <div>
                <label className="input-label">🤖 Model AI</label>
                <select className="url-input" value={model} onChange={(e) => saveModel(e.target.value)} style={{ cursor: 'pointer' }}>
                  <optgroup label="💰 Hemat (Recommended)">
                    <option value="mistralai/mistral-small-3.1-24b-instruct">Mistral Small 3.1 — $0.10/MTok ⭐</option>
                    <option value="openai/gpt-4o-mini">GPT-4o Mini — $0.15/MTok</option>
                    <option value="google/gemini-flash-1.5">Gemini Flash 1.5 — $0.075/MTok</option>
                  </optgroup>
                  <optgroup label="🧠 Paling Cerdas">
                    <option value="anthropic/claude-3.5-sonnet">Claude 3.5 Sonnet ⭐⭐</option>
                    <option value="anthropic/claude-3-haiku">Claude 3 Haiku — Cepat</option>
                    <option value="openai/gpt-4o">GPT-4o</option>
                  </optgroup>
                  <optgroup label="🆓 Gratis">
                    <option value="meta-llama/llama-3.1-8b-instruct:free">Llama 3.1 8B — FREE</option>
                    <option value="google/gemma-3-12b-it:free">Gemma 3 12B — FREE</option>
                  </optgroup>
                </select>
              </div>
            </div>
          )}
        </div>

        {status !== 'idle' && (
          <div className={`status-bar ${status === 'error' ? 'error' : status === 'done' ? 'success' : 'loading'}`}>
            {(status === 'transcript' || status === 'analyzing') && <span className="spinner" />}
            {status === 'error' && '❌'}{status === 'done' && '✅'}
            <span>{statusMsg}</span>
            {modelUsed && status === 'done' && <span style={{ marginLeft: 'auto', fontSize: 11, opacity: 0.7 }}>Model: {modelUsed.split('/').pop()}</span>}
          </div>
        )}

        {(status === 'transcript' || status === 'analyzing' || status === 'done') && (
          <div className="steps fade-up">
            <div className={`step ${status === 'transcript' ? 'active' : 'done'}`}>{status !== 'transcript' ? '✓' : <span className="spinner" style={{ width: 10, height: 10 }} />} Transcript</div>
            <div className={`step ${status === 'analyzing' ? 'active' : status === 'done' ? 'done' : 'pending'}`}>{status === 'done' ? '✓' : status === 'analyzing' ? <span className="spinner" style={{ width: 10, height: 10 }} /> : '○'} AI Analisis</div>
            <div className={`step ${status === 'done' ? 'done' : 'pending'}`}>{status === 'done' ? '✓' : '○'} Clips Siap</div>
          </div>
        )}

        {clips.length > 0 && (
          <div className="clips-section fade-up">
            <h2>🔥 {clips.length} Viral Clip{clips.length > 1 ? 's' : ''} Ditemukan {ffmpegLoading && <span style={{ fontSize: 13, color: 'var(--muted)', fontWeight: 400 }}>· Loading FFmpeg...</span>}</h2>
            <div className="clips-grid">
              {clips.map((clip, idx) => {
                const cs = clipStates[idx];
                const isProcessing = ['loading-video','cutting','subtitles','encoding'].includes(cs?.status);
                return (
                  <div key={idx} className="clip-card fade-up" style={{ animationDelay: `${idx * 0.1}s` }}>
                    <div className="clip-thumb">
                      <div className="thumb-icon">{idx === 0 ? '🔥' : idx === 1 ? '⚡' : '💎'}</div>
                      <div className="viral-score" style={{ background: scoreColor(clip.viral_score) }}>{clip.viral_score}/10</div>
                      <div className="clip-time-badge">{fmtTime(clip.start)} → {fmtTime(clip.end)} · {fmtDuration(clip.start, clip.end)}</div>
                      {videoId && <img src={`https://img.youtube.com/vi/${videoId}/mqdefault.jpg`} alt="thumb" style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover', opacity: 0.35 }} onError={(e) => (e.currentTarget.style.display = 'none')} />}
                    </div>
                    <div className="clip-body">
                      <div className="clip-number">CLIP #{idx + 1}</div>
                      <div className="clip-title">{clip.title}</div>
                      <div className="clip-hook">"{clip.hook}"</div>
                      <div className="clip-meta">
                        <span className="meta-badge time">⏱ {fmtTime(clip.start)}–{fmtTime(clip.end)}</span>
                        <span className="meta-badge" style={{ color: 'var(--accent)', borderColor: 'rgba(255,45,120,0.3)' }}>{clip.viral_reason?.slice(0, 30)}...</span>
                      </div>
                      {!cs || cs.status === 'idle' ? (
                        <button className="btn btn-primary" style={{ width: '100%' }} onClick={() => handleProcessClip(idx)} disabled={isProcessing}>✂️ Proses & Download</button>
                      ) : cs.status === 'done' ? (
                        <a href={cs.downloadUrl!} download={cs.fileName!} className="btn btn-success" style={{ width: '100%', textDecoration: 'none' }}>⬇️ Download Clip</a>
                      ) : cs.status === 'error' ? (
                        <div>
                          <p style={{ color: '#ef4444', fontSize: 12, marginBottom: 8 }}>❌ {cs.message}</p>
                          <button className="btn btn-secondary btn-small" onClick={() => updateClipState(idx, { status: 'idle', progress: 0, message: '' })}>Coba Lagi</button>
                        </div>
                      ) : (
                        <div className="clip-progress">
                          <p className="progress-label">{cs.message}</p>
                          <div className="progress-bar-wrap"><div className="progress-bar-fill" style={{ width: `${cs.progress}%` }} /></div>
                          <p style={{ fontSize: 11, color: 'var(--muted2)', marginTop: 4 }}>{cs.progress}%</p>
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        <div className="info-box" style={{ marginTop: clips.length > 0 ? 40 : 60 }}>
          <strong>💡 Cara Kerja:</strong> Transcript YouTube → AI analisis → FFmpeg WASM potong + subtitle langsung di browser.<br />
          <strong>💰 Hemat Token:</strong> ~1.500 token per video (~$0.0002 dengan Mistral Small).<br />
          <strong>⚠️ Catatan:</strong> Gunakan hanya untuk konten yang Anda miliki hak cipta-nya.
        </div>
        <div style={{ height: 60 }} />
      </div>
    </main>
  );
}
