/**
 * DBJ RattleNIX - Pure Client-side CW / Morse Code Decoder
 * Ported directly from morse_decoder.py
 */

const MORSE_TABLE = {
  .-: A, -...: B, -.-.: C, -..: D, .: E,
  ..-.: F, --.: G, ....: H, ..: I, .---: J,
  -.-: K, .-..: L, --: M, -.: N, ---: O,
  .--.: P, --.-: Q, .-.: R, ...: S, -: T,
  ..-: U, ...-: V, .--: W, -..-: X, -.--: Y,
  --..: Z, -----: 0, .----: 1, ..---: 2, ...--: 3,
  ....-: 4, .....: 5, -....: 6, --...: 7, ---..: 8,
  ----.: 9, .-.-.-: ., --..--: ,, ..--..: ?, .----.: ",
  "-.-.--": "!", "-..-.": "/", "-.--.": "(", "-.--.-": ")", ".-...": "&",
  "---...": ":", "-.-.-.": ";", "-...-": "=", ".-.-.": "+", "-....-": "-",
  "..--.-": "_", ".-..-.": ', ...-..-: , .--.-.: @, ...-.-: SK,
  -.-.-: CT
};

class MorseDecoder {
  constructor(sampleRate = 48000, blockSize = 960) {
    this.sampleRate = sampleRate;
    this.blockSize = blockSize;
    this.frameSec = blockSize / sampleRate; // 0.02s (20ms)

    this.binStart = Math.floor((600 * blockSize) / sampleRate);
    this.binEnd = Math.floor((1150 * blockSize) / sampleRate) + 1;

    this.noiseFloor = 0.01;
    this.signalState = false;
    this.currStateTime = 0.0;

    this.ditLen = 0.08;
    this.currElements = ;
    this.decodedWord = ;
  }

  // Goertzel power calculation across CW range (600 - 1100 Hz)
  calculateCwPower(int16Array) {
    const N = int16Array.length;
    let maxPower = 0.0;

    // Test tone frequencies across repeater CW ID spectrum at 50Hz intervals
    for (let f = 600; f <= 1100; f += 50) {
      const k = (N * f) / this.sampleRate;
      const omega = (2 * Math.PI * k) / N;
      const coeff = 2 * Math.cos(omega);

      let q1 = 0.0;
      let q2 = 0.0;

      for (let i = 0; i < N; i++) {
        const x = int16Array[i] / 32768.0;
        const q0 = coeff * q1 - q2 + x;
        q2 = q1;
        q1 = q0;
      }

      const power = (q1 * q1 + q2 * q2 - q1 * q2 * coeff) / (N * N / 4);
      if (power > maxPower) {
        maxPower = power;
      }
    }
    return Math.sqrt(maxPower);
  }

  processFrame(int16Samples) {
    const maxP = this.calculateCwPower(int16Samples);
    const threshold = Math.max(0.04, this.noiseFloor * 4.0);
    const isOn = maxP > threshold;

    if (!isOn) {
      this.noiseFloor = this.noiseFloor * 0.95 + maxP * 0.05;
    } else {
      this.noiseFloor = this.noiseFloor * 0.999 + 0.001 * 0.001;
    }

    const events = [];

    if (isOn === this.signalState) {
      this.currStateTime += this.frameSec;

      if (!isOn && this.currStateTime > this.ditLen * 2.8 && this.currElements) {
        const char = MORSE_TABLE[this.currElements] || ;
        if (char) this.decodedWord += char;
        this.currElements = ;
      }

      if (!isOn && this.currStateTime > this.ditLen * 7.0 && this.decodedWord) {
        const word = this.decodedWord.trim();
        if (word.length >= 2) {
          events.push(word);
        }
        this.decodedWord = ;
      }
    } else {
      const duration = this.currStateTime;
      const wasOn = this.signalState;

      if (wasOn) {
        if (duration > 0.025) {
          if (duration < this.ditLen * 1.8) {
            this.currElements += .;
            this.ditLen = this.ditLen * 0.85 + duration * 0.15;
          } else {
            this.currElements += -;
          }
        }
      } else {
        if (duration > this.ditLen * 2.2 && this.currElements) {
          const char = MORSE_TABLE[this.currElements] || ;
          if (char) this.decodedWord += char;
          this.currElements = ;
        }
      }

      this.signalState = isOn;
      this.currStateTime = this.frameSec;
    }

    return events;
  }
}

window.MorseDecoder = MorseDecoder;
