import * as ort from 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.21.0/dist/ort.all.mjs';
import { DemucsProcessor, CONSTANTS } from './src/index.js';

const el = (id) => document.getElementById(id);
const ui = {
  drop: el('drop'), file: el('file'), browse: el('browse'), fileMeta: el('fileMeta'),
  fileName: el('fileName'), remove: el('remove'), video: el('video'), backend: el('backend'),
  phase: el('phase'), percent: el('percent'), bar: el('bar'), status: el('status'),
  elapsed: el('elapsed'), segment: el('segment'), eta: el('eta'), process: el('process'),
  result: el('result'), audioResult: el('audioResult'), downloadAudio: el('downloadAudio'),
  keyShift: el('keyShift'), applyKey: el('applyKey'), applyMix: el('applyMix'),
  mixControls: el('mixControls'), stemList: el('stemList'), stemPreview: el('stemPreview'),
  rgbScene: el('rgbScene'), rgbToggle: el('rgbToggle'), rgbBrightness: el('rgbBrightness'), rgbState: el('rgbState'),
  makeVideo: el('makeVideo'), downloadVideo: el('downloadVideo'), resultNote: el('resultNote')
};

let selectedFile = null;
let sourceUrl = null;
let audioUrl = null;
let stemUrl = null;
let webmUrl = null;
let decodedAudio = null;
let instrumentalBuffer = null;
let originalInstrumentalBuffer = null;
let separatedStems = null;
let audioContext = null;
let processor = null;
let processOfflinePromise = null;
let rgbContext = null;
let rgbSource = null;
let rgbAnalyser = null;
let rgbData = null;
let rgbFrame = 0;
let rgbEnabled = false;
let startedAt = 0;
let videoMode = false;

const fmtTime = (seconds) => {
  if (!Number.isFinite(seconds) || seconds < 0) return '—';
  const m = Math.floor(seconds / 60).toString().padStart(2, '0');
  const s = Math.floor(seconds % 60).toString().padStart(2, '0');
  return `${m}:${s}`;
};
const setProgress = (value, phase, message) => {
  const percent = Math.max(0, Math.min(100, value));
  ui.bar.style.width = `${percent}%`;
  ui.percent.textContent = `${Math.round(percent)}%`;
  if (phase) ui.phase.textContent = phase;
  if (message) ui.status.textContent = message;
};
const revoke = (url) => { if (url) URL.revokeObjectURL(url); };

function clearOutput() {
  setRgbEnabled(false);
  revoke(audioUrl); revoke(stemUrl); revoke(webmUrl);
  audioUrl = stemUrl = webmUrl = null;
  decodedAudio = instrumentalBuffer = originalInstrumentalBuffer = separatedStems = null;
  ui.audioResult.pause(); ui.stemPreview.pause();
  ui.audioResult.removeAttribute('src');
  ui.stemPreview.removeAttribute('src');
  ui.downloadAudio.removeAttribute('href');
  ui.stemList.replaceChildren(); ui.mixControls.replaceChildren();
  ui.downloadVideo.classList.add('hidden');
  ui.makeVideo.classList.add('hidden');
  ui.result.classList.remove('show');
}

function resetFile() {
  selectedFile = null;
  videoMode = false;
  revoke(sourceUrl); sourceUrl = null;
  ui.video.pause();
  ui.video.removeAttribute('src');
  ui.video.load();
  ui.video.classList.remove('show');
  ui.fileMeta.classList.remove('show');
  ui.file.value = '';
  ui.process.disabled = true;
  ui.status.classList.remove('error');
  clearOutput();
  ui.elapsed.textContent = '00:00';
  ui.segment.textContent = '—';
  ui.eta.textContent = '—';
  setProgress(0, '等待媒體', '選擇媒體後開始分離。較長的歌曲需要更多記憶體與時間。');
}

async function selectFile(file) {
  if (!file) return;
  const isVideo = file.type.startsWith('video/') || /\.(mp4|mov|m4v|webm|mkv)$/i.test(file.name);
  const isAudio = file.type.startsWith('audio/') || /\.(mp3|wav|m4a|aac|ogg|flac)$/i.test(file.name);
  if (!isVideo && !isAudio) {
    setProgress(0, '格式不支援', '請選擇瀏覽器可解碼的音訊或影片檔。');
    return;
  }
  resetFile();
  selectedFile = file;
  videoMode = isVideo;
  sourceUrl = URL.createObjectURL(file);
  ui.fileName.textContent = `${file.name} · ${(file.size / 1024 / 1024).toFixed(1)} MB`;
  ui.fileMeta.classList.add('show');
  ui.process.disabled = false;
  clearOutput();
  if (isVideo) {
    ui.video.src = sourceUrl;
    ui.video.classList.add('show');
    ui.resultNote.textContent = '伴奏 MV 會在本機播放並錄製成 WebM。瀏覽器不支援原生輸出 MP4。';
  }
  setProgress(0, '媒體已載入', '準備完成。按下按鈕即可開始分離。');
}

ui.browse.addEventListener('click', () => ui.file.click());
ui.drop.addEventListener('click', (event) => {
  if (!event.target.closest('button,input')) ui.file.click();
});
ui.file.addEventListener('change', () => selectFile(ui.file.files?.[0]));
ui.remove.addEventListener('click', resetFile);
for (const eventName of ['dragenter', 'dragover']) ui.drop.addEventListener(eventName, (event) => {
  event.preventDefault(); ui.drop.classList.add('drag');
});
for (const eventName of ['dragleave', 'drop']) ui.drop.addEventListener(eventName, (event) => {
  event.preventDefault(); ui.drop.classList.remove('drag');
});
ui.drop.addEventListener('drop', (event) => selectFile(event.dataTransfer.files?.[0]));

async function getProcessor() {
  if (processor) return processor;
  const canUseGpu = 'gpu' in navigator && await navigator.gpu.requestAdapter().catch(() => null);
  const isolated = window.crossOriginIsolated === true;
  ort.env.wasm.numThreads = isolated ? Math.max(1, Math.min(8, navigator.hardwareConcurrency || 4)) : 1;
  ui.backend.textContent = canUseGpu ? 'WEBGPU' : `WASM · ${ort.env.wasm.numThreads} THREAD`;
  ui.backend.title = canUseGpu ? 'WebGPU 優先，WASM 備援' : 'WASM 單執行緒（此靜態網站未啟用跨來源隔離）';
  processor = new DemucsProcessor({
    ort,
    onDownloadProgress: (loaded, total) => {
      const pct = total ? loaded / total * 100 : 0;
      setProgress(pct * 0.16, '下載模型', `首次下載 HTDemucs 模型：${(loaded / 1048576).toFixed(0)} / ${(total / 1048576).toFixed(0)} MB`);
    },
    onLog: (phase, message) => console.info(`[${phase}] ${message}`),
    onProgress: ({ progress, currentSegment, totalSegments }) => {
      setProgress(16 + progress * 84, '分離音軌', `正在分離音訊片段 ${currentSegment} / ${totalSegments}`);
      const elapsed = (Date.now() - startedAt) / 1000;
      ui.elapsed.textContent = fmtTime(elapsed);
      ui.segment.textContent = `${currentSegment}/${totalSegments}`;
      ui.eta.textContent = currentSegment ? fmtTime((totalSegments - currentSegment) * elapsed / currentSegment) : '—';
    }
  });
  setProgress(1, '載入模型', '正在載入 HTDemucs（約 172 MB，首次使用需下載）…');
  await processor.loadModel(CONSTANTS.DEFAULT_MODEL_URL);
  return processor;
}

function mixInstrumental(stems, length, gains = {}) {
  const left = new Float32Array(length);
  const right = new Float32Array(length);
  for (const name of ['drums', 'bass', 'other']) {
    const stem = stems[name];
    if (!stem) continue;
    const count = Math.min(length, stem.left.length, stem.right.length);
    const gain = gains[name] ?? 1;
    for (let i = 0; i < count; i++) {
      left[i] += stem.left[i] * gain;
      right[i] += stem.right[i] * gain;
    }
  }
  return { left, right };
}

function audioBufferFromStereo(stereo) {
  const buffer = audioContext.createBuffer(2, stereo.left.length, CONSTANTS.SAMPLE_RATE);
  buffer.copyToChannel(stereo.left, 0);
  buffer.copyToChannel(stereo.right, 1);
  return buffer;
}

function publishInstrumental(buffer) {
  instrumentalBuffer = buffer;
  revoke(audioUrl);
  audioUrl = URL.createObjectURL(stereoWav(buffer.getChannelData(0), buffer.getChannelData(1), buffer.sampleRate));
  ui.audioResult.src = audioUrl;
  ui.downloadAudio.href = audioUrl;
  const base = selectedFile.name.replace(/\.[^.]+$/, '');
  ui.downloadAudio.download = `${base}-伴奏${Number(ui.keyShift.value) ? `-${ui.keyShift.value}st` : ''}.wav`;
}

const STEM_INFO = {
  drums: ['鼓組', '鼓與打擊樂'],
  bass: ['Bass', '低音聲部'],
  other: ['其他伴奏', '吉他、鍵盤等混合音軌'],
  vocals: ['人聲', '主唱與和聲']
};

function showStemTracks() {
  ui.stemList.innerHTML = Object.entries(STEM_INFO).map(([name, [title, detail]]) =>
    `<div class="stem-row"><div class="stem-label">${title}<small>${detail}</small></div><button class="stem-action" data-stem="${name}" data-action="preview" type="button">預聽</button><button class="stem-action" data-stem="${name}" data-action="download" type="button">下載 WAV</button></div>`
  ).join('');
  ui.mixControls.innerHTML = ['drums', 'bass', 'other'].map((name) => {
    const [title] = STEM_INFO[name];
    return `<label class="mix-row">${title}<input type="range" min="0" max="150" value="100" data-mix="${name}"><output>100%</output></label>`;
  }).join('');
}

async function applyPitchShift() {
  if (!originalInstrumentalBuffer) return;
  const semitones = Number(ui.keyShift.value);
  ui.status.classList.remove('error');
  ui.applyKey.disabled = true;
  ui.applyMix.disabled = true;
  try {
    let output = originalInstrumentalBuffer;
    if (semitones !== 0) {
      setProgress(100, '升降 Key', `正在變調 ${semitones > 0 ? '+' : ''}${semitones} 個半音，保留歌曲速度…`);
      processOfflinePromise ||= import('https://esm.sh/@soundtouchjs/audio-worklet@2.1.1');
      const { processOffline } = await processOfflinePromise;
      output = await processOffline({
        input: originalInstrumentalBuffer,
        processorUrl: 'https://cdn.jsdelivr.net/npm/@soundtouchjs/audio-worklet@2.1.1/.dist/soundtouch-processor.js',
        pitchSemitones: semitones
      });
    }
    publishInstrumental(output);
    setProgress(100, '完成', semitones === 0 ? '已還原原調伴奏。' : `已升降 ${semitones > 0 ? '+' : ''}${semitones} 個半音，歌曲速度不變。`);
  } catch (error) {
    console.error(error);
    ui.status.classList.add('error');
    ui.status.textContent = `升降 Key 失敗：${error?.message || error}`;
  } finally {
    ui.applyKey.disabled = false;
    ui.applyMix.disabled = false;
  }
}

ui.keyShift.innerHTML = Array.from({ length: 25 }, (_, index) => index - 12).map((step) =>
  `<option value="${step}" ${step === 0 ? 'selected' : ''}>${step === 0 ? '原調' : `${step > 0 ? '+' : ''}${step} 半音`}</option>`
).join('');

ui.applyKey.addEventListener('click', applyPitchShift);
ui.applyMix.addEventListener('click', async () => {
  if (!separatedStems) return;
  const gains = Object.fromEntries([...ui.mixControls.querySelectorAll('[data-mix]')]
    .map((input) => [input.dataset.mix, Number(input.value) / 100]));
  const length = separatedStems.drums?.left.length || separatedStems.bass?.left.length || separatedStems.other?.left.length || 0;
  originalInstrumentalBuffer = audioBufferFromStereo(mixInstrumental(separatedStems, length, gains));
  await applyPitchShift();
});
ui.mixControls.addEventListener('input', (event) => {
  const input = event.target.closest('[data-mix]');
  if (input) input.parentElement.querySelector('output').textContent = `${input.value}%`;
});
ui.stemList.addEventListener('click', async (event) => {
  const button = event.target.closest('[data-stem][data-action]');
  if (!button || !separatedStems?.[button.dataset.stem]) return;
  const stem = separatedStems[button.dataset.stem];
  const blob = stereoWav(stem.left, stem.right, CONSTANTS.SAMPLE_RATE);
  const name = STEM_INFO[button.dataset.stem][0];
  if (button.dataset.action === 'preview') {
    revoke(stemUrl);
    stemUrl = URL.createObjectURL(blob);
    ui.stemPreview.src = stemUrl;
    await ui.stemPreview.play().catch(() => {});
  } else {
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${selectedFile.name.replace(/\.[^.]+$/, '')}-${name}.wav`;
    link.click();
    setTimeout(() => revoke(url), 60_000);
  }
});

function stereoWav(left, right, sampleRate) {
  const count = Math.min(left.length, right.length);
  const dataBytes = count * 4;
  const buffer = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buffer);
  const write = (offset, text) => { for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i)); };
  write(0, 'RIFF'); view.setUint32(4, 36 + dataBytes, true); write(8, 'WAVE');
  write(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true);
  view.setUint16(22, 2, true); view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 4, true); view.setUint16(32, 4, true);
  view.setUint16(34, 16, true); write(36, 'data'); view.setUint32(40, dataBytes, true);
  let offset = 44;
  for (let i = 0; i < count; i++) {
    const l = Math.max(-1, Math.min(1, left[i]));
    const r = Math.max(-1, Math.min(1, right[i]));
    view.setInt16(offset, l < 0 ? l * 32768 : l * 32767, true); offset += 2;
    view.setInt16(offset, r < 0 ? r * 32768 : r * 32767, true); offset += 2;
  }
  return new Blob([buffer], { type: 'audio/wav' });
}

function setRgbEnabled(enabled) {
  rgbEnabled = enabled;
  ui.rgbToggle.setAttribute('aria-pressed', String(enabled));
  ui.rgbToggle.textContent = enabled ? '關閉 RGB 燈效' : '開啟 RGB 燈效';
  ui.rgbState.textContent = enabled ? 'SYNC' : 'OFF';
  if (!enabled) {
    cancelAnimationFrame(rgbFrame);
    ui.rgbScene.style.setProperty('--low', '0.2');
    ui.rgbScene.style.setProperty('--mid', '0.2');
    ui.rgbScene.style.setProperty('--high', '0.2');
    ui.rgbScene.style.setProperty('--light', '0.15');
  }
}

async function enableRgb() {
  if (!rgbContext) {
    rgbContext = new AudioContext();
    rgbAnalyser = rgbContext.createAnalyser();
    rgbAnalyser.fftSize = 1024;
    rgbAnalyser.smoothingTimeConstant = 0.82;
    rgbSource = rgbContext.createMediaElementSource(ui.audioResult);
    rgbSource.connect(rgbAnalyser);
    rgbAnalyser.connect(rgbContext.destination);
    rgbData = new Uint8Array(rgbAnalyser.frequencyBinCount);
  }
  await rgbContext.resume();
  setRgbEnabled(true);
  const animate = () => {
    if (!rgbEnabled) return;
    rgbAnalyser.getByteFrequencyData(rgbData);
    const hzPerBin = rgbContext.sampleRate / rgbAnalyser.fftSize;
    const average = (fromHz, toHz) => {
      const start = Math.max(0, Math.floor(fromHz / hzPerBin));
      const end = Math.min(rgbData.length, Math.ceil(toHz / hzPerBin));
      let sum = 0;
      for (let i = start; i < end; i++) sum += rgbData[i];
      return end > start ? sum / (end - start) / 255 : 0;
    };
    const brightness = Number(ui.rgbBrightness.value) / 100;
    for (const [name, from, to] of [['low', 30, 180], ['mid', 180, 2000], ['high', 2000, 10000]]) {
      const energy = average(from, to);
      ui.rgbScene.style.setProperty(`--${name}`, (0.12 + energy * 1.55).toFixed(3));
    }
    ui.rgbScene.style.setProperty('--light', (0.15 + brightness * 0.85).toFixed(3));
    rgbFrame = requestAnimationFrame(animate);
  };
  animate();
}

ui.rgbToggle.addEventListener('click', async () => {
  if (rgbEnabled) return setRgbEnabled(false);
  try {
    await enableRgb();
  } catch (error) {
    console.error(error);
    ui.rgbState.textContent = 'ERROR';
    ui.status.textContent = `RGB 燈效無法啟動：${error?.message || error}`;
  }
});

ui.process.addEventListener('click', async () => {
  if (!selectedFile) return;
  ui.process.disabled = true;
  ui.status.classList.remove('error');
  clearOutput();
  startedAt = Date.now();
  ui.elapsed.textContent = '00:00'; ui.segment.textContent = '—'; ui.eta.textContent = '—';
  try {
    const activeProcessor = await getProcessor();
    if (!audioContext) audioContext = new AudioContext({ sampleRate: CONSTANTS.SAMPLE_RATE });
    if (audioContext.state === 'suspended') await audioContext.resume();
    setProgress(16, '讀取媒體', '正在解碼音訊並準備立體聲資料…');
    const bytes = await selectedFile.arrayBuffer();
    decodedAudio = await audioContext.decodeAudioData(bytes);
    const leftSource = decodedAudio.getChannelData(0);
    const rightSource = decodedAudio.numberOfChannels > 1 ? decodedAudio.getChannelData(1) : leftSource;
    let left = leftSource;
    let right = rightSource;
    if (decodedAudio.sampleRate !== CONSTANTS.SAMPLE_RATE) {
      const ratio = CONSTANTS.SAMPLE_RATE / decodedAudio.sampleRate;
      const length = Math.floor(leftSource.length * ratio);
      left = new Float32Array(length); right = new Float32Array(length);
      for (let i = 0; i < length; i++) {
        const position = i / ratio;
        const lo = Math.floor(position);
        const hi = Math.min(lo + 1, leftSource.length - 1);
        const fraction = position - lo;
        left[i] = leftSource[lo] * (1 - fraction) + leftSource[hi] * fraction;
        right[i] = rightSource[lo] * (1 - fraction) + rightSource[hi] * fraction;
      }
    }
    setProgress(17, '分離音軌', 'Demucs 正在分析歌曲…');
    const stems = await activeProcessor.separate(left, right);
    separatedStems = stems;
    showStemTracks();
    const mixed = mixInstrumental(stems, left.length);
    originalInstrumentalBuffer = audioBufferFromStereo(mixed);
    publishInstrumental(originalInstrumentalBuffer);
    const base = selectedFile.name.replace(/\.[^.]+$/, '');
    if (videoMode) {
      ui.makeVideo.classList.remove('hidden');
      ui.makeVideo.disabled = false;
      ui.downloadVideo.download = `${base}-伴奏MV.webm`;
    }
    ui.result.classList.add('show');
    const elapsed = (Date.now() - startedAt) / 1000;
    ui.elapsed.textContent = fmtTime(elapsed); ui.eta.textContent = '00:00';
    setProgress(100, '完成', `已完成 ${(decodedAudio.duration / 60).toFixed(1)} 分鐘音訊的伴奏分離。`);
  } catch (error) {
    console.error(error);
    ui.status.classList.add('error');
    setProgress(0, '處理失敗', error?.name === 'EncodingError'
      ? '瀏覽器無法解碼此媒體音訊。請先轉成 WAV、MP3 或 AAC 再試。'
      : `處理失敗：${error?.message || error}`);
  } finally {
    ui.process.disabled = !selectedFile;
  }
});

ui.makeVideo.addEventListener('click', async () => {
  if (!instrumentalBuffer) return;
  const capture = ui.video.captureStream || ui.video.mozCaptureStream;
  if (!capture) {
    ui.status.textContent = '此瀏覽器不支援影片串流錄製，仍可下載伴奏 WAV。';
    return;
  }
  const mimeType = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm']
    .find((type) => MediaRecorder.isTypeSupported(type));
  if (!mimeType) {
    ui.status.textContent = '此瀏覽器不支援 WebM 錄製，仍可下載伴奏 WAV。';
    return;
  }
  ui.makeVideo.disabled = true;
  revoke(webmUrl); webmUrl = null;
  ui.downloadVideo.classList.add('hidden');
  try {
    await audioContext.resume();
    ui.video.pause();
    ui.video.muted = true;
    ui.video.currentTime = 0;
    await new Promise((resolve, reject) => {
      if (ui.video.readyState >= 2) resolve();
      else { ui.video.addEventListener('loadeddata', resolve, { once: true }); ui.video.addEventListener('error', reject, { once: true }); }
    });
    const videoStream = capture.call(ui.video);
    const videoTrack = videoStream.getVideoTracks()[0];
    if (!videoTrack) throw new Error('無法擷取影片畫面');
    const destination = audioContext.createMediaStreamDestination();
    const source = audioContext.createBufferSource();
    source.buffer = instrumentalBuffer;
    source.connect(destination);
    const stream = new MediaStream([videoTrack, ...destination.stream.getAudioTracks()]);
    const recorder = new MediaRecorder(stream, { mimeType });
    const chunks = [];
    recorder.addEventListener('dataavailable', (event) => { if (event.data.size) chunks.push(event.data); });
    recorder.addEventListener('stop', () => {
      webmUrl = URL.createObjectURL(new Blob(chunks, { type: mimeType }));
      ui.downloadVideo.href = webmUrl;
      ui.downloadVideo.classList.remove('hidden');
      ui.makeVideo.disabled = false;
      ui.makeVideo.textContent = '重新錄製伴奏 MV';
      ui.status.textContent = '伴奏 MV 已完成，可以下載 WebM 檔案。';
      videoStream.getTracks().forEach((track) => track.stop());
      destination.stream.getTracks().forEach((track) => track.stop());
    }, { once: true });
    ui.video.onended = () => { if (recorder.state !== 'inactive') recorder.stop(); };
    recorder.start(1000);
    source.start();
    await ui.video.play();
    ui.makeVideo.textContent = '正在錄製 MV… 請勿切換分頁';
    ui.status.textContent = '正在即時播放並錄製畫面與伴奏，請保持此分頁開啟。';
  } catch (error) {
    console.error(error);
    ui.makeVideo.disabled = false;
    ui.makeVideo.textContent = '錄製伴奏 MV（WebM）';
    ui.status.textContent = `影片錄製失敗：${error?.message || error}`;
  }
});

// Detect and display a sensible first-run hint before the model is initialized.
ui.backend.textContent = ('gpu' in navigator) ? 'WEBGPU READY' : 'WASM';
