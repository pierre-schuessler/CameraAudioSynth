let size = 8;
let numPixels = size * size;

let audioContext, synthOsc, masterVolume, analyserNode;
let video = document.getElementById('video');
let canvas = document.getElementById('canvas');
let ctx = canvas.getContext('2d', { willReadFrequently: true });
let grayscaleCanvas = document.getElementById('grayscaleCanvas');
let grayscaleCtx = grayscaleCanvas.getContext('2d');

let animationId;
let volumeMultiplier = 0.005; // Kept your original default
let minFreq = 50; // We use this as the fundamental pitch
let isRunning = false;
let hilbertCoords = [];

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

// --- UI Listeners (Safely mapped to your existing HTML) ---
function updateSize(newSize) {
  size = parseInt(newSize);
  numPixels = size * size;
  canvas.width = size;
  canvas.height = size;
  precomputeHilbertCurve(size);
  
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

// We repurpose your Min Freq input to be the Fundamental Base Pitch
document.getElementById('minFreqInput').onchange = function () {
  let newMin = parseInt(this.value) || 20;
  newMin = Math.max(20, Math.min(newMin, 19999));
  this.value = newMin;
  minFreq = newMin;
  if (synthOsc) {
    // Glide the pitch smoothly if changed while running
    synthOsc.frequency.setTargetAtTime(minFreq, audioContext.currentTime, 0.1);
  }
};

// Max Freq and Distribution are ignored by iFFT (harmonics must be mathematically linear).
// We stub them out so your existing HTML doesn't throw null reference errors.
const maxFreqEl = document.getElementById('maxFreqInput');
if (maxFreqEl) maxFreqEl.onchange = () => console.log("Max Freq ignored in iFFT mode.");

const distSelectEl = document.getElementById('distributionSelect');
if (distSelectEl) distSelectEl.onchange = () => console.log("Distribution ignored in iFFT mode.");


// --- Audio Engine ---
async function setupAudio() {
  audioContext = new AudioContext();
  
  masterVolume = audioContext.createGain();
  masterVolume.gain.value = 1.0;
  
  // Replace worklet with native Oscillator mapped to our dynamic waveform
  synthOsc = audioContext.createOscillator();
  synthOsc.frequency.value = minFreq; 
  
  synthOsc.connect(masterVolume);
  masterVolume.connect(audioContext.destination);
  
  synthOsc.start();
}

function setupWaveformVisualizer() {
  analyserNode = audioContext.createAnalyser();
  analyserNode.fftSize = 1024;
  masterVolume.connect(analyserNode);

  const waveformCanvas = document.getElementById('waveformCanvas');
  if (!waveformCanvas) return;
  const waveformCtx = waveformCanvas.getContext('2d');

  function drawWaveform() {
    if (!isRunning) return;
    requestAnimationFrame(drawWaveform);
    
    const bufferLength = analyserNode.fftSize;
    const dataArray = new Float32Array(bufferLength);
    // Switched to Float for better high-res rendering
    analyserNode.getFloatTimeDomainData(dataArray); 

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
    
    const sliceWidth = waveformCanvas.width / bufferLength;
    let x = 0;
    
    for (let i = 0; i < bufferLength; i++) {
      // Scale visual up because your volumeMultiplier (0.005) produces small raw waves
      const v = dataArray[i] * 50.0; 
      const y = (v * -0.5 * waveformCanvas.height) + (waveformCanvas.height / 2);
      i === 0 ? waveformCtx.moveTo(x, y) : waveformCtx.lineTo(x, y);
      x += sliceWidth;
    }
    waveformCtx.stroke();
  }
  drawWaveform();
}

// --- Core Processing Loop ---
function processFrameAndSend() {
  if (!isRunning) return;

  ctx.drawImage(video, 0, 0, size, size);
  let imageData = ctx.getImageData(0, 0, size, size).data;
  const grayscaleImageData = grayscaleCtx.createImageData(size, size);

  // PeriodicWave arrays: index 0 is DC offset (silence), indices 1 to N are harmonics
  const realAmplitudes = new Float32Array(numPixels + 1);
  const imagPhases = new Float32Array(numPixels + 1); // 0 ensures perfectly aligned phases

  for (let i = 0; i < numPixels; i++) {
    const [x, y] = hilbertCoords[i];
    const index = (y * size + x) * 4;
    const r = imageData[index], g = imageData[index + 1], b = imageData[index + 2];
    
    const gray = 0.299 * r + 0.587 * g + 0.114 * b;
    const normalizedGray = Math.pow(gray / 255, 1.5) * volumeMultiplier;
    
    // MATHEMATICAL CONVERGENCE: Apply 1/n decay to higher frequencies
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

  // Instantly compile 4000+ sine waves using C++ iFFT and apply to oscillator
  if (synthOsc && audioContext.state === 'running') {
    const wave = audioContext.createPeriodicWave(realAmplitudes, imagPhases, { disableNormalization: true });
    synthOsc.setPeriodicWave(wave);
  }

  animationId = requestAnimationFrame(processFrameAndSend);
}

// --- Initialization ---
async function start_stop() {
  if (isRunning) {
    isRunning = false;
    if (synthOsc) { synthOsc.stop(); synthOsc.disconnect(); synthOsc = null; }
    if (audioContext) { audioContext.close(); audioContext = null; }
    if (video.srcObject) { video.srcObject.getTracks().forEach(t => t.stop()); video.srcObject = null; }
    cancelAnimationFrame(animationId);
    document.getElementById("start-stop").innerHTML = "▶ Start";
    return;
  }

  try {
    // clampFreqInputs() is removed; we just use minFreq directly
    await setupAudio();
    setupWaveformVisualizer();
    const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
    video.srcObject = stream;
    isRunning = true;
    video.onloadedmetadata = () => { 
      video.play(); 
      processFrameAndSend(); 
    };
    document.getElementById('start-stop').innerHTML = "■ Stop";
  } catch (error) {
    console.error('Error starting:', error);
    alert('Error starting: ' + error.message);
  }
}

precomputeHilbertCurve(size);
document.getElementById('start-stop').onclick = start_stop;