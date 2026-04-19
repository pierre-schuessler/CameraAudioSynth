// --- State Variables ---
let size = 8;
let numPixels = size * size;

// We now have TWO oscillators for ping-pong crossfading
let audioContext, synthOscA, synthOscB, gainA, gainB, masterVolume, analyserNode;
let activeOsc = 'A';
let lastAudioUpdate = 0;

let video = document.getElementById('video');
let canvas = document.getElementById('canvas');
let ctx = canvas.getContext('2d', { willReadFrequently: true });
let grayscaleCanvas = document.getElementById('grayscaleCanvas');
let grayscaleCtx = grayscaleCanvas.getContext('2d');

let animationId;
let volumeMultiplier = 0.005; 
let minFreq = 50; 
let isRunning = false;
let hilbertCoords = [];

// Pre-allocate memory to prevent Garbage Collection audio stutters
let realAmplitudes = new Float32Array(0);
let imagPhases = new Float32Array(0);
let grayscaleImageData = null;
let visualizerDataArray = new Float32Array(0);


// --- Hilbert Curve Math ---
function hilbert(n, index) {
  let x = 0, y = 0;
  for (let s = 1, t = index; s < n; s *= 2) {
    let rx = 1 & (t >> 1);
    let ry = 1 & (t ^ rx);
    [x, y] = rot(s, x, y, rx, ry);
    x += s * rx;
    y += s * ry;
    t >>= 2;
  }
  return [x, y];
}

function rot(n, x, y, rx, ry) {
  if (ry === 0) {
    if (rx === 1) { x = n - 1 - x; y = n - 1 - y; }
    [x, y] = [y, x];
  }
  return [x, y];
}

function precomputeHilbertCurve(gridSize) {
  hilbertCoords = new Array(gridSize * gridSize);
  for (let i = 0; i < gridSize * gridSize; i++) {
    hilbertCoords[i] = hilbert(gridSize, i);
  }
}

// --- UI Listeners ---
function updateSize(newSize) {
  size = parseInt(newSize);
  numPixels = size * size;
  canvas.width = size;
  canvas.height = size;
  precomputeHilbertCurve(size);
  
  // Resize our pre-allocated memory blocks
  realAmplitudes = new Float32Array(numPixels + 1);
  imagPhases = new Float32Array(numPixels + 1);
  grayscaleImageData = grayscaleCtx.createImageData(size, size);
  
  const pixelCountEl = document.getElementById('pixelCount');
  if (pixelCountEl) pixelCountEl.textContent = numPixels + ' px';
  
  const videoTitleEl = document.getElementById('videoTitle');
  if (videoTitleEl) videoTitleEl.textContent = `OUTPUT — ${size}×${size}`;
}

document.getElementById('sizeSelect').onchange = function () { updateSize(this.value); };

document.getElementById('volumeControl').oninput = function () {
  volumeMultiplier = parseFloat(this.value);
  const volValEl = document.getElementById('volumeValue');
  if (volValEl) volValEl.textContent = this.value;
};

document.getElementById('minFreqInput').onchange = function () {
  let newMin = parseInt(this.value) || 20;
  newMin = Math.max(20, Math.min(newMin, 19999));
  this.value = newMin;
  minFreq = newMin;
  if (synthOscA && synthOscB) {
    // Glide both oscillators safely
    synthOscA.frequency.setTargetAtTime(minFreq, audioContext.currentTime, 0.1);
    synthOscB.frequency.setTargetAtTime(minFreq, audioContext.currentTime, 0.1);
  }
};

const maxFreqEl = document.getElementById('maxFreqInput');
if (maxFreqEl) maxFreqEl.onchange = () => console.log("Max Freq ignored in iFFT mode.");

const distSelectEl = document.getElementById('distributionSelect');
if (distSelectEl) distSelectEl.onchange = () => console.log("Distribution ignored in iFFT mode.");


// --- Audio Engine (Ping-Pong Setup) ---
async function setupAudio() {
  audioContext = new AudioContext();
  
  masterVolume = audioContext.createGain();
  masterVolume.gain.value = 1.0;
  
  // Create Dual Gains for crossfading
  gainA = audioContext.createGain();
  gainB = audioContext.createGain();
  gainA.gain.value = 1.0; // A starts ON
  gainB.gain.value = 0.0; // B starts OFF
  
  // Create Dual Oscillators
  synthOscA = audioContext.createOscillator();
  synthOscB = audioContext.createOscillator();
  synthOscA.frequency.value = minFreq; 
  synthOscB.frequency.value = minFreq; 
  
  synthOscA.connect(gainA);
  synthOscB.connect(gainB);
  gainA.connect(masterVolume);
  gainB.connect(masterVolume);
  masterVolume.connect(audioContext.destination);
  
  synthOscA.start();
  synthOscB.start();
}

function setupWaveformVisualizer() {
  analyserNode = audioContext.createAnalyser();
  analyserNode.fftSize = 1024;
  masterVolume.connect(analyserNode);
  
  // Pre-allocate visualizer array
  visualizerDataArray = new Float32Array(analyserNode.fftSize);

  const waveformCanvas = document.getElementById('waveformCanvas');
  if (!waveformCanvas) return;
  const waveformCtx = waveformCanvas.getContext('2d');

  function drawWaveform() {
    if (!isRunning) return;
    requestAnimationFrame(drawWaveform);
    
    analyserNode.getFloatTimeDomainData(visualizerDataArray); 

    waveformCtx.clearRect(0, 0, waveformCanvas.width, waveformCanvas.height);

    waveformCtx.strokeStyle = '#2a2a2a';
    waveformCtx.lineWidth = 1;
    waveformCtx.beginPath();
    waveformCtx.moveTo(0, waveformCanvas.height / 2);
    waveformCtx.lineTo(waveformCanvas.width, waveformCanvas.height / 2);
    waveformCtx.stroke();

    waveformCtx.strokeStyle = '#4ec9b0';
    waveformCtx.lineWidth = 1.5;
    waveformCtx.beginPath();
    
    const sliceWidth = waveformCanvas.width / analyserNode.fftSize;
    let x = 0;
    
    for (let i = 0; i < analyserNode.fftSize; i++) {
      const v = visualizerDataArray[i] * 50.0; 
      const y = (v * -0.5 * waveformCanvas.height) + (waveformCanvas.height / 2);
      i === 0 ? waveformCtx.moveTo(x, y) : waveformCtx.lineTo(x, y);
      x += sliceWidth;
    }
    waveformCtx.stroke();
  }
  drawWaveform();
}

// --- Core Processing Loop ---
function processFrameAndSend(timestamp) {
  if (!isRunning) return;

  // 1. VISUALS: Run at maximum frame rate
  ctx.drawImage(video, 0, 0, size, size);
  let imageData = ctx.getImageData(0, 0, size, size).data;

  // We reuse our pre-allocated realAmplitudes and grayscaleImageData
  for (let i = 0; i < numPixels; i++) {
    const [x, y] = hilbertCoords[i];
    const index = (y * size + x) * 4;
    const r = imageData[index], g = imageData[index + 1], b = imageData[index + 2];
    
    const gray = 0.299 * r + 0.587 * g + 0.114 * b;
    const normalizedGray = Math.pow(gray / 255, 1.5) * volumeMultiplier;
    
    const harmonicNumber = i + 1;
    realAmplitudes[harmonicNumber] = normalizedGray * (1 / harmonicNumber);

    const displayIndex = (y * size + x) * 4;
    grayscaleImageData.data[displayIndex] = gray;
    grayscaleImageData.data[displayIndex + 1] = gray;
    grayscaleImageData.data[displayIndex + 2] = gray;
    grayscaleImageData.data[displayIndex + 3] = 255;
  }

  grayscaleCtx.putImageData(grayscaleImageData, 0, 0);
  grayscaleCtx.imageSmoothingEnabled = false;
  grayscaleCtx.drawImage(grayscaleCanvas, 0, 0, size, size, 0, 0, 320, 320);

  // 2. AUDIO: Throttle to ~20fps (50ms) to allow crossfading to complete seamlessly
  if (synthOscA && audioContext.state === 'running' && (timestamp - lastAudioUpdate > 50)) {
    lastAudioUpdate = timestamp;
    
    const wave = audioContext.createPeriodicWave(realAmplitudes, imagPhases, { disableNormalization: true });
    const now = audioContext.currentTime;
    
    // 15ms timeConstant creates a smooth ~45ms crossfade
    const fadeSpeed = 0.015; 

    // Ping-Pong the waveforms
    if (activeOsc === 'A') {
      synthOscB.setPeriodicWave(wave);
      gainB.gain.setTargetAtTime(1.0, now, fadeSpeed); // Fade B in
      gainA.gain.setTargetAtTime(0.0, now, fadeSpeed); // Fade A out
      activeOsc = 'B';
    } else {
      synthOscA.setPeriodicWave(wave);
      gainA.gain.setTargetAtTime(1.0, now, fadeSpeed); // Fade A in
      gainB.gain.setTargetAtTime(0.0, now, fadeSpeed); // Fade B out
      activeOsc = 'A';
    }
  }

  animationId = requestAnimationFrame(processFrameAndSend);
}

// --- Initialization ---
async function start_stop() {
  if (isRunning) {
    isRunning = false;
    // Safely tear down both oscillators
    if (synthOscA) { synthOscA.stop(); synthOscA.disconnect(); synthOscA = null; }
    if (synthOscB) { synthOscB.stop(); synthOscB.disconnect(); synthOscB = null; }
    if (audioContext) { audioContext.close(); audioContext = null; }
    if (video.srcObject) { video.srcObject.getTracks().forEach(t => t.stop()); video.srcObject = null; }
    cancelAnimationFrame(animationId);
    document.getElementById("start-stop").innerHTML = "▶ Start";
    return;
  }

  try {
    await setupAudio();
    setupWaveformVisualizer();
    const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
    video.srcObject = stream;
    isRunning = true;
    video.onloadedmetadata = () => { 
      video.play(); 
      // Pass the initial timestamp so the throttle logic works immediately
      processFrameAndSend(performance.now()); 
    };
    document.getElementById('start-stop').innerHTML = "■ Stop";
  } catch (error) {
    console.error('Error starting:', error);
    alert('Error starting: ' + error.message);
  }
}

updateSize(size); // Initialize memory immediately
document.getElementById('start-stop').onclick = start_stop;