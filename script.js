let size = 8;
    let numPixels = size * size;
    let numOscillators = size * size;

    let audioContext, workletNode;
    let video = document.getElementById('video');
    let canvas = document.getElementById('canvas');
    let ctx = canvas.getContext('2d', { willReadFrequently: true });
    let grayscaleCanvas = document.getElementById('grayscaleCanvas');
    let grayscaleCtx = grayscaleCanvas.getContext('2d');

    let animationId;
    let volumeMultiplier = 0.005;
    let frequencyDistribution = 'logarithmic';
    let minFreq = 50;
    let maxFreq = 5000;
    let currentFrequencies = [];
    let isRunning = false;
    let hilbertCoords = [];

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

    function generateFrequencies(distribution, numOsc) {
      const frequencies = new Array(numOsc);
      switch (distribution) {
        case 'linear':
          for (let i = 0; i < numOsc; i++)
            frequencies[i] = minFreq + (i / (numOsc - 1)) * (maxFreq - minFreq);
          break;
        case 'exponential': {
          // steeper curve than log — square the normalised position
          for (let i = 0; i < numOsc; i++) {
            const t = Math.pow(i / (numOsc - 1), 2);
            frequencies[i] = minFreq + t * (maxFreq - minFreq);
          }
          break;
        }
        case 'harmonic': {
          // integer multiples of the min frequency, clamped to maxFreq
          const fundamental = minFreq;
          for (let i = 0; i < numOsc; i++) {
            const harmonic = fundamental * (i + 1);
            frequencies[i] = Math.min(harmonic, maxFreq);
          }
          break;
        }
        case 'logarithmic':
        default: {
          const logMin = Math.log(minFreq), logMax = Math.log(maxFreq);
          for (let i = 0; i < numOsc; i++) {
            const logValue = logMin + (i / (numOsc - 1)) * (logMax - logMin);
            frequencies[i] = Math.exp(logValue);
          }
          break;
        }
      }
      return frequencies;
    }

    function applyFrequencyChange() {
      if (workletNode && isRunning) {
        const frequencies = generateFrequencies(frequencyDistribution, numOscillators);
        currentFrequencies = frequencies;
        workletNode.port.postMessage({ type: 'updateConfig', numOscillators, frequencies });
      }
    }

    function updateSize(newSize) {
      size = parseInt(newSize);
      numPixels = size * size;
      numOscillators = size * size;
      canvas.width = size;
      canvas.height = size;
      precomputeHilbertCurve(size);
      document.getElementById('pixelCount').textContent = numPixels + ' px';
      document.getElementById('videoTitle').textContent = `OUTPUT — ${size}×${size}`;
      applyFrequencyChange();
    }

    // Volume
    document.getElementById('volumeControl').oninput = function () {
      volumeMultiplier = parseFloat(this.value);
      document.getElementById('volumeValue').textContent = this.value;
    };

    // Grid size
    document.getElementById('sizeSelect').onchange = function () { updateSize(this.value); };

    // Freq range inputs
    function clampFreqInputs() {
      const minInput = document.getElementById('minFreqInput');
      const maxInput = document.getElementById('maxFreqInput');
      let newMin = parseInt(minInput.value) || 20;
      let newMax = parseInt(maxInput.value) || 20000;
      newMin = Math.max(20, Math.min(newMin, 19999));
      newMax = Math.max(newMin + 1, Math.min(newMax, 20000));
      minInput.value = newMin;
      maxInput.value = newMax;
      minFreq = newMin;
      maxFreq = newMax;
    }

    document.getElementById('minFreqInput').onchange = function () {
      clampFreqInputs();
      applyFrequencyChange();
    };
    document.getElementById('maxFreqInput').onchange = function () {
      clampFreqInputs();
      applyFrequencyChange();
    };

    // Distribution
    document.getElementById('distributionSelect').onchange = function () {
      frequencyDistribution = this.value;
      applyFrequencyChange();
    };

    async function setupAudio() {
      audioContext = new AudioContext();
      const frequencies = generateFrequencies(frequencyDistribution, numOscillators);
      currentFrequencies = frequencies;

      const workletCode = `
        class WideRangeSynthProcessor extends AudioWorkletProcessor {
          constructor() {
            super();
            this.numOscillators = 64;
            this.frequencies = new Array(this.numOscillators).fill(0).map((_, i) => {
              const logMin = Math.log(50), logMax = Math.log(10000);
              return Math.exp(logMin + (i / (this.numOscillators - 1)) * (logMax - logMin));
            });
            this.targetAmplitudes = new Float32Array(this.numOscillators).fill(0);
            this.currentAmplitudes = new Float32Array(this.numOscillators).fill(0);
            this.phases = new Float32Array(this.numOscillators);
            for (let i = 0; i < this.numOscillators; i++) this.phases[i] = Math.random() * 2 * Math.PI;
            this.phaseSteps = this.frequencies.map(f => 2 * Math.PI * f / sampleRate);
            this.masterGain = 0;
            this.port.onmessage = (event) => {
              if (event.data.type === 'amplitudes') {
                const pixelData = event.data.values;
                if (pixelData.length === this.numOscillators) {
                  for (let i = 0; i < this.numOscillators; i++) {
                    this.targetAmplitudes[i] = pixelData[i];
                    this.currentAmplitudes[i] = this.targetAmplitudes[i];
                  }
                } else {
                  const groupSize = Math.max(1, Math.floor(pixelData.length / this.numOscillators));
                  for (let i = 0; i < this.numOscillators; i++) {
                    let sum = 0;
                    const startIdx = i * groupSize;
                    const endIdx = Math.min(startIdx + groupSize, pixelData.length);
                    for (let j = startIdx; j < endIdx; j++) sum += pixelData[j];
                    this.targetAmplitudes[i] = sum / (endIdx - startIdx);
                    this.currentAmplitudes[i] = this.targetAmplitudes[i];
                  }
                }
                const totalEnergy = this.targetAmplitudes.reduce((a, b) => a + b * b, 0);
                this.masterGain = Math.sqrt(totalEnergy) * 0.08;
              } else if (event.data.type === 'updateConfig') {
                this.numOscillators = event.data.numOscillators;
                this.frequencies = [...event.data.frequencies];
                this.phaseSteps = this.frequencies.map(f => 2 * Math.PI * f / sampleRate);
                this.targetAmplitudes = new Float32Array(this.numOscillators).fill(0);
                this.currentAmplitudes = new Float32Array(this.numOscillators).fill(0);
                this.phases = new Float32Array(this.numOscillators);
                for (let i = 0; i < this.numOscillators; i++) this.phases[i] = Math.random() * 2 * Math.PI;
              }
            };
          }
          process(_, outputs) {
            const output = outputs[0][0];
            for (let i = 0; i < output.length; i++) {
              let sample = 0;
              for (let j = 0; j < this.numOscillators; j++) {
                this.phases[j] += this.phaseSteps[j];
                if (this.phases[j] > 6.28318530718) this.phases[j] -= 6.28318530718;
                if (this.currentAmplitudes[j] > 0.001) sample += this.currentAmplitudes[j] * Math.sin(this.phases[j]);
              }
              sample *= this.masterGain;
              if (sample > 0.7) sample = 0.7 + (sample - 0.7) * 0.05;
              else if (sample < -0.7) sample = -0.7 + (sample + 0.7) * 0.05;
              output[i] = sample;
            }
            return true;
          }
        }
        registerProcessor('wide-range-synth', WideRangeSynthProcessor);
      `;

      await audioContext.audioWorklet.addModule('data:application/javascript;base64,' + btoa(workletCode));
      workletNode = new AudioWorkletNode(audioContext, 'wide-range-synth');
      workletNode.connect(audioContext.destination);
      workletNode.port.postMessage({ type: 'updateConfig', numOscillators, frequencies });
    }

    let analyserNode;
    function setupWaveformVisualizer() {
      analyserNode = audioContext.createAnalyser();
      analyserNode.fftSize = 1024;
      workletNode.connect(analyserNode);

      const waveformCanvas = document.getElementById('waveformCanvas');
      const waveformCtx = waveformCanvas.getContext('2d');

      function drawWaveform() {
        requestAnimationFrame(drawWaveform);
        const bufferLength = analyserNode.fftSize;
        const dataArray = new Uint8Array(bufferLength);
        analyserNode.getByteTimeDomainData(dataArray);

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
          const v = dataArray[i] / 128.0;
          const y = (v - 1.0) * waveformCanvas.height / 2 + waveformCanvas.height / 2;
          i === 0 ? waveformCtx.moveTo(x, y) : waveformCtx.lineTo(x, y);
          x += sliceWidth;
        }
        waveformCtx.stroke();
      }
      drawWaveform();
    }

    function processFrameAndSend() {
      ctx.drawImage(video, 0, 0, size, size);
      let imageData = ctx.getImageData(0, 0, size, size).data;
      const amplitudes = new Float32Array(numPixels);
      const grayscaleImageData = grayscaleCtx.createImageData(size, size);

      for (let i = 0; i < numPixels; i++) {
        const [x, y] = hilbertCoords[i];
        const index = (y * size + x) * 4;
        const r = imageData[index], g = imageData[index + 1], b = imageData[index + 2];
        const gray = 0.299 * r + 0.587 * g + 0.114 * b;
        const normalizedGray = Math.pow(gray / 255, 1.5);
        amplitudes[i] = normalizedGray * volumeMultiplier;
        const displayIndex = (y * size + x) * 4;
        grayscaleImageData.data[displayIndex] = gray;
        grayscaleImageData.data[displayIndex + 1] = gray;
        grayscaleImageData.data[displayIndex + 2] = gray;
        grayscaleImageData.data[displayIndex + 3] = 255;
      }

      grayscaleCtx.putImageData(grayscaleImageData, 0, 0);
      grayscaleCtx.imageSmoothingEnabled = false;
      grayscaleCtx.drawImage(grayscaleCanvas, 0, 0, size, size, 0, 0, 320, 320);

      if (workletNode) workletNode.port.postMessage({ type: 'amplitudes', values: amplitudes });
      animationId = requestAnimationFrame(processFrameAndSend);
    }

    

    async function start_stop(){
      if (isRunning){
        isRunning = false;
        if (audioContext) { audioContext.close(); audioContext = null; }
        if (video.srcObject) { video.srcObject.getTracks().forEach(t => t.stop()); video.srcObject = null; }
        cancelAnimationFrame(animationId);
        document.getElementById("start-stop").innerHTML = "▶ Start";
        return;
      }

      try {
        clampFreqInputs();
        await setupAudio();
        setupWaveformVisualizer();
        const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
        video.srcObject = stream;
        isRunning = true;
        video.onloadedmetadata = () => { video.play(); processFrameAndSend(); };
      } catch (error) {
        console.error('Error starting:', error);
        alert('Error starting: ' + error.message);
      }
      document.getElementById('start-stop').innerHTML = "■ Stop"
    }

    precomputeHilbertCurve(size);
    document.getElementById('start-stop').onclick = start_stop;