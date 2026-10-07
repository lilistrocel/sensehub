/**
 * ImageSharpness — pure-JS blur metric and downscaler for the canopy frames.
 * The backend image has no sharp/ffmpeg, so JPEGs are decoded with jpeg-js.
 *
 *   sharpnessScore(jpegBuffer)  variance of the Laplacian of the grayscale image over the
 *                               centre 80 % of the frame, computed on a block-averaged
 *                               copy (<= 512 px wide) after a 3x3 median + 3x3 Gaussian
 *                               denoise. Higher = sharper. The denoise matters: a raw
 *                               Laplacian ranks sensor grain (e.g. a frame taken while the
 *                               camera switches to IR mode) as the "sharpest" frame of a
 *                               session; after it, real structure wins by ~4x while a
 *                               defocused frame still scores an order of magnitude lower.
 *                               Frames of the same size are directly comparable.
 *   downscaleJpeg(buf, maxEdge) area-average resample + re-encode when the long edge
 *                               exceeds maxEdge (used for the 4-hourly fallback frames,
 *                               which are stored at native resolution).
 */

const jpeg = require('jpeg-js');

const DECODE_OPTS = { useTArray: true, formatAsRGBA: true, tolerantDecoding: true, maxMemoryUsageInMB: 256 };
const SCORE_MAX_WIDTH = 512;
const CENTRE_FRACTION = 0.8;
const ENCODE_QUALITY = 85;

function decodeRgba(buf) {
  return jpeg.decode(buf, DECODE_OPTS);
}

/** Grayscale (Rec.601 luma) of the image, block-averaged (step x step) so the width is <= maxWidth. */
function grayscaleSubsample(img, maxWidth = SCORE_MAX_WIDTH) {
  const step = Math.max(1, Math.ceil(img.width / maxWidth));
  const w = Math.floor(img.width / step);
  const h = Math.floor(img.height / step);
  const gray = new Float32Array(w * h);
  const d = img.data;
  const inv = 1 / (step * step);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let s = 0;
      for (let yy = 0; yy < step; yy++) {
        let i = ((y * step + yy) * img.width + x * step) * 4;
        for (let xx = 0; xx < step; xx++, i += 4) s += 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
      }
      gray[y * w + x] = s * inv;
    }
  }
  return { gray, width: w, height: h, step };
}

/** 3x3 median filter (kills impulsive grain, keeps edges). Border pixels are copied. */
function median3(gray, width, height) {
  const out = Float32Array.from(gray);
  const a = new Float32Array(9);
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      let k = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) a[k++] = gray[(y + dy) * width + x + dx];
      a.sort();
      out[y * width + x] = a[4];
    }
  }
  return out;
}

/** 3x3 Gaussian (1 2 1 / 2 4 2 / 1 2 1) / 16. Border pixels are copied. */
function gauss3(gray, width, height) {
  const out = Float32Array.from(gray);
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const i = y * width + x;
      out[i] = (4 * gray[i] + 2 * (gray[i - 1] + gray[i + 1] + gray[i - width] + gray[i + width])
        + gray[i - width - 1] + gray[i - width + 1] + gray[i + width - 1] + gray[i + width + 1]) / 16;
    }
  }
  return out;
}

/** Variance of the 4-neighbour Laplacian over the centre `centre` fraction of the image. */
function laplacianVariance(gray, width, height, centre = CENTRE_FRACTION) {
  const mx = Math.max(1, Math.round(width * (1 - centre) / 2));
  const my = Math.max(1, Math.round(height * (1 - centre) / 2));
  const x0 = mx, x1 = width - mx, y0 = my, y1 = height - my;
  if (x1 - x0 < 2 || y1 - y0 < 2) return 0;
  let sum = 0, sumSq = 0, n = 0;
  for (let y = y0; y < y1; y++) {
    const row = y * width;
    for (let x = x0; x < x1; x++) {
      const c = gray[row + x];
      const lap = 4 * c - gray[row + x - 1] - gray[row + x + 1] - gray[row - width + x] - gray[row + width + x];
      sum += lap; sumSq += lap * lap; n++;
    }
  }
  if (!n) return 0;
  const mean = sum / n;
  return Math.max(0, sumSq / n - mean * mean);
}

/**
 * @returns { sharpness, brightness, width, height, sampleWidth, sampleHeight } —
 *          `width`/`height` are the decoded image's; the score is computed on the
 *          subsample. `brightness` is the mean luma 0-255 of the whole subsample (a
 *          "too dark to use" check for the preset tour; night/IR frames sit far below).
 */
function sharpnessScore(buf, { maxWidth = SCORE_MAX_WIDTH, centre = CENTRE_FRACTION } = {}) {
  const img = decodeRgba(buf);
  const g = grayscaleSubsample(img, maxWidth);
  const denoised = gauss3(median3(g.gray, g.width, g.height), g.width, g.height);
  const v = laplacianVariance(denoised, g.width, g.height, centre);
  let lum = 0;
  for (let i = 0; i < g.gray.length; i++) lum += g.gray[i];
  const brightness = g.gray.length ? Math.round((lum / g.gray.length) * 10) / 10 : null;
  return { sharpness: Math.round(v * 100) / 100, brightness, width: img.width, height: img.height, sampleWidth: g.width, sampleHeight: g.height };
}

/** Area-average resample of an RGBA image to (dw x dh). */
function resampleRgba(img, dw, dh) {
  const out = Buffer.alloc(dw * dh * 4);
  const sx = img.width / dw, sy = img.height / dh;
  const d = img.data;
  for (let y = 0; y < dh; y++) {
    const ys = Math.floor(y * sy), ye = Math.max(ys + 1, Math.min(img.height, Math.ceil((y + 1) * sy)));
    for (let x = 0; x < dw; x++) {
      const xs = Math.floor(x * sx), xe = Math.max(xs + 1, Math.min(img.width, Math.ceil((x + 1) * sx)));
      let r = 0, g = 0, b = 0, n = 0;
      for (let yy = ys; yy < ye; yy++) {
        let i = (yy * img.width + xs) * 4;
        for (let xx = xs; xx < xe; xx++, i += 4) { r += d[i]; g += d[i + 1]; b += d[i + 2]; n++; }
      }
      const o = (y * dw + x) * 4;
      out[o] = r / n; out[o + 1] = g / n; out[o + 2] = b / n; out[o + 3] = 255;
    }
  }
  return { data: out, width: dw, height: dh };
}

/**
 * Downscale a JPEG so its long edge is <= maxEdge. Returns the original buffer
 * (scaled=false) when it already fits.
 * @returns { buffer, width, height, scaled }
 */
function downscaleJpeg(buf, maxEdge, quality = ENCODE_QUALITY) {
  const img = decodeRgba(buf);
  const long = Math.max(img.width, img.height);
  if (long <= maxEdge) return { buffer: buf, width: img.width, height: img.height, scaled: false };
  const k = maxEdge / long;
  const dw = Math.max(1, Math.round(img.width * k));
  const dh = Math.max(1, Math.round(img.height * k));
  const small = resampleRgba(img, dw, dh);
  const enc = jpeg.encode(small, quality);
  return { buffer: Buffer.from(enc.data), width: dw, height: dh, scaled: true };
}

module.exports = {
  sharpnessScore, downscaleJpeg, laplacianVariance, grayscaleSubsample, median3, gauss3, resampleRgba, decodeRgba,
  SCORE_MAX_WIDTH, CENTRE_FRACTION,
};
