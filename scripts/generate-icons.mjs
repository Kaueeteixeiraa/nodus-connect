import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const outDir = "build";
mkdirSync(outDir, { recursive: true });

const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256">
  <defs>
    <linearGradient id="blue" x1="36" y1="28" x2="220" y2="232">
      <stop stop-color="#27a8ff"/>
      <stop offset=".55" stop-color="#0879dc"/>
      <stop offset="1" stop-color="#03284f"/>
    </linearGradient>
    <linearGradient id="letter" x1="92" y1="62" x2="164" y2="194">
      <stop stop-color="#fff"/>
      <stop offset=".48" stop-color="#eaf3ff"/>
      <stop offset="1" stop-color="#151b25"/>
    </linearGradient>
  </defs>
  <rect width="256" height="256" rx="52" fill="url(#blue)"/>
  <rect x="4" y="4" width="248" height="248" rx="48" fill="none" stroke="#8dd4ff" stroke-opacity=".55" stroke-width="4"/>
  <path d="M76 188V68L180 188V68" fill="none" stroke="url(#letter)" stroke-width="27" stroke-linecap="round" stroke-linejoin="round"/>
</svg>`;

writeFileSync(join(outDir, "icon.svg"), svg);
writeFileSync(join(outDir, "icon.ico"), createIco([16, 24, 32, 48, 64, 128, 256]));
writeFileSync(join(outDir, "installer-header.bmp"), createBmp(150, 57, headerColorAt));
writeFileSync(join(outDir, "installer-sidebar.bmp"), createBmp(164, 314, sidebarColorAt));

function createIco(sizes) {
  const images = sizes.map((size) => ({ size, data: createDib(size) }));
  const headerSize = 6 + images.length * 16;
  const total = headerSize + images.reduce((sum, image) => sum + image.data.length, 0);
  const buffer = Buffer.alloc(total);

  buffer.writeUInt16LE(0, 0);
  buffer.writeUInt16LE(1, 2);
  buffer.writeUInt16LE(images.length, 4);

  let entryOffset = 6;
  let imageOffset = headerSize;
  for (const image of images) {
    buffer.writeUInt8(image.size === 256 ? 0 : image.size, entryOffset);
    buffer.writeUInt8(image.size === 256 ? 0 : image.size, entryOffset + 1);
    buffer.writeUInt8(0, entryOffset + 2);
    buffer.writeUInt8(0, entryOffset + 3);
    buffer.writeUInt16LE(1, entryOffset + 4);
    buffer.writeUInt16LE(32, entryOffset + 6);
    buffer.writeUInt32LE(image.data.length, entryOffset + 8);
    buffer.writeUInt32LE(imageOffset, entryOffset + 12);
    image.data.copy(buffer, imageOffset);
    entryOffset += 16;
    imageOffset += image.data.length;
  }

  return buffer;
}

function createDib(size) {
  const rowBytes = size * 4;
  const maskRowBytes = Math.ceil(size / 32) * 4;
  const pixelBytes = rowBytes * size;
  const maskBytes = maskRowBytes * size;
  const buffer = Buffer.alloc(40 + pixelBytes + maskBytes);

  buffer.writeUInt32LE(40, 0);
  buffer.writeInt32LE(size, 4);
  buffer.writeInt32LE(size * 2, 8);
  buffer.writeUInt16LE(1, 12);
  buffer.writeUInt16LE(32, 14);
  buffer.writeUInt32LE(0, 16);
  buffer.writeUInt32LE(pixelBytes, 20);

  let offset = 40;
  for (let y = size - 1; y >= 0; y--) {
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = sample(size, x, y);
      buffer.writeUInt8(b, offset++);
      buffer.writeUInt8(g, offset++);
      buffer.writeUInt8(r, offset++);
      buffer.writeUInt8(a, offset++);
    }
  }

  return buffer;
}

function sample(size, px, py) {
  const samples = 3;
  let r = 0;
  let g = 0;
  let b = 0;
  let a = 0;
  for (let sy = 0; sy < samples; sy++) {
    for (let sx = 0; sx < samples; sx++) {
      const x = ((px + (sx + 0.5) / samples) / size) * 2 - 1;
      const y = ((py + (sy + 0.5) / samples) / size) * 2 - 1;
      const color = colorAt(x, y);
      r += color[0];
      g += color[1];
      b += color[2];
      a += color[3];
    }
  }
  const n = samples * samples;
  return [r / n, g / n, b / n, a / n].map((value) => Math.max(0, Math.min(255, Math.round(value))));
}

function colorAt(x, y) {
  const radius = roundedRectAlpha(x, y, 0.94, 0.94, 0.22);
  if (radius <= 0) return [0, 0, 0, 0];

  const diagonal = Math.max(0, Math.min(1, (x + y + 1.5) / 3));
  let color = mix([39, 168, 255], [3, 40, 79], diagonal);
  color = [...color, 255 * radius];
  color = addGlow(color, x, y, -0.35, -0.42, [110, 197, 255], 0.32, 0.8);

  const letterAlpha = Math.min(1,
    segmentAlpha(x, y, -0.4, -0.48, -0.4, 0.48, 0.105) +
    segmentAlpha(x, y, -0.4, -0.48, 0.4, 0.48, 0.105) +
    segmentAlpha(x, y, 0.4, -0.48, 0.4, 0.48, 0.105));
  const letterColor = mix([255, 255, 255], [21, 27, 37], Math.max(0, Math.min(1, (y + 0.35) / 0.9)));
  color = blend(color, [...letterColor, 255], letterAlpha);
  return color;
}

function roundedRectAlpha(x, y, width, height, radius) {
  const qx = Math.abs(x) - width + radius;
  const qy = Math.abs(y) - height + radius;
  const outside = Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) - radius;
  return 1 - smoothstep(0, 0.02, outside);
}

function circleAlpha(x, y, cx, cy, radius) {
  return 1 - smoothstep(radius - 0.015, radius + 0.015, Math.hypot(x - cx, y - cy));
}

function segmentAlpha(x, y, ax, ay, bx, by, width) {
  const dx = bx - ax;
  const dy = by - ay;
  const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy)));
  return 1 - smoothstep(width - 0.015, width + 0.015, Math.hypot(x - (ax + dx * t), y - (ay + dy * t)));
}

function addGlow(base, x, y, cx, cy, glow, strength, radius) {
  const amount = Math.max(0, 1 - Math.hypot(x - cx, y - cy) / radius) * strength;
  return blend(base, [glow[0], glow[1], glow[2], base[3]], amount);
}

function blend(base, over, alpha) {
  const t = Math.max(0, Math.min(1, alpha));
  return [
    base[0] * (1 - t) + over[0] * t,
    base[1] * (1 - t) + over[1] * t,
    base[2] * (1 - t) + over[2] * t,
    base[3],
  ];
}

function smoothstep(edge0, edge1, value) {
  const t = Math.max(0, Math.min(1, (value - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

function createBmp(width, height, sampler) {
  const rowBytes = Math.ceil((width * 3) / 4) * 4;
  const pixelBytes = rowBytes * height;
  const buffer = Buffer.alloc(54 + pixelBytes);
  buffer.write("BM", 0);
  buffer.writeUInt32LE(buffer.length, 2);
  buffer.writeUInt32LE(54, 10);
  buffer.writeUInt32LE(40, 14);
  buffer.writeInt32LE(width, 18);
  buffer.writeInt32LE(height, 22);
  buffer.writeUInt16LE(1, 26);
  buffer.writeUInt16LE(24, 28);
  buffer.writeUInt32LE(pixelBytes, 34);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [r, g, b] = sampler(x / (width - 1), y / (height - 1));
      const offset = 54 + (height - 1 - y) * rowBytes + x * 3;
      buffer[offset] = b;
      buffer[offset + 1] = g;
      buffer[offset + 2] = r;
    }
  }
  return buffer;
}

function sidebarColorAt(x, y) {
  let color = [5, 8, 17];
  const glow = Math.max(0, 1 - Math.hypot(x - 0.72, y - 0.25) / 0.7);
  color = mix(color, [8, 60, 116], glow * 0.72);

  const grid = Math.min(
    smoothstep(0.008, 0, Math.abs((x * 8) % 1) - 0.01),
    smoothstep(0.008, 0, Math.abs((y * 13) % 1) - 0.01),
  );
  color = mix(color, [24, 86, 148], grid * 0.2);

  const lx = (x - 0.5) / 0.32;
  const ly = (y - 0.24) / 0.17;
  const logo = colorAt(lx, ly);
  color = mix(color, [logo[0], logo[1], logo[2]], (logo[3] / 255) * 0.95);

  if (y > 0.62 && y < 0.64) color = mix(color, [37, 230, 255], 0.55);
  return color.map((value) => Math.round(Math.max(0, Math.min(255, value))));
}

function headerColorAt(x, y) {
  let color = [5, 8, 17];
  const glow = Math.max(0, 1 - Math.hypot(x - 0.75, y - 0.35) / 0.8);
  color = mix(color, [8, 66, 126], glow * 0.82);
  if (Math.abs(y - 0.82) < 0.018) color = mix(color, [37, 230, 255], 0.55);
  return color.map((value) => Math.round(Math.max(0, Math.min(255, value))));
}

function mix(a, b, amount) {
  const t = Math.max(0, Math.min(1, amount));
  return [a[0] * (1 - t) + b[0] * t, a[1] * (1 - t) + b[1] * t, a[2] * (1 - t) + b[2] * t];
}
