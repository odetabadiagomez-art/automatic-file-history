/* Generates images/icon.png (128x128 RGBA) without any image dependency. */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const SIZE = 128;
const pixels = Buffer.alloc(SIZE * SIZE * 4, 0);

function setPixel(x, y, r, g, b, a) {
	if (x < 0 || y < 0 || x >= SIZE || y >= SIZE) {
		return;
	}
	const i = (y * SIZE + x) * 4;
	const alpha = a / 255;
	pixels[i] = Math.round(r * alpha + pixels[i] * (1 - alpha));
	pixels[i + 1] = Math.round(g * alpha + pixels[i + 1] * (1 - alpha));
	pixels[i + 2] = Math.round(b * alpha + pixels[i + 2] * (1 - alpha));
	pixels[i + 3] = Math.min(255, pixels[i + 3] + a);
}

function insideRoundedSquare(x, y, radius) {
	const minX = radius;
	const maxX = SIZE - 1 - radius;
	const minY = radius;
	const maxY = SIZE - 1 - radius;
	if (x >= minX && x <= maxX) {
		return y >= minY && y <= maxY;
	}
	if (y >= minY && y <= maxY) {
		return x >= minX && x <= maxX;
	}
	const cx = x < minX ? minX : maxX;
	const cy = y < minY ? minY : maxY;
	return (x - cx) ** 2 + (y - cy) ** 2 <= radius * radius;
}

const CX = SIZE / 2;
const CY = SIZE / 2;
const RING_RADIUS = 40;
const RING_THICKNESS = 7;
const GAP_START = -2.5;
const GAP_END = -1.9;
const HEAD_ANGLE = -2.2;

for (let y = 0; y < SIZE; y++) {
	for (let x = 0; x < SIZE; x++) {
		if (!insideRoundedSquare(x, y, 22)) {
			continue;
		}
		const t = y / SIZE;
		setPixel(x, y, Math.round(28 + 12 * t), Math.round(34 + 14 * t), Math.round(48 + 18 * t), 255);

		const dx = x - CX;
		const dy = y - CY;
		const distance = Math.sqrt(dx * dx + dy * dy);
		const angle = Math.atan2(dy, dx);

		const inGap = angle > GAP_START && angle < GAP_END;
		if (!inGap && Math.abs(distance - RING_RADIUS) <= RING_THICKNESS / 2) {
			setPixel(x, y, 126, 211, 255, 255);
		}

		const headX = CX + Math.cos(HEAD_ANGLE) * RING_RADIUS;
		const headY = CY + Math.sin(HEAD_ANGLE) * RING_RADIUS;
		if ((x - headX) ** 2 + (y - headY) ** 2 <= 42) {
			setPixel(x, y, 126, 211, 255, 255);
		}

		const hourHand = distance <= 20 && Math.abs(dx * 0.6 - dy * 0.8) < 2.6 && dx <= 2;
		const minuteHand = distance <= 30 && Math.abs(dx + 0.25) < 2.6 && dy <= 1;
		if (hourHand || minuteHand || distance <= 3.5) {
			setPixel(x, y, 240, 246, 255, 255);
		}
	}
}

function crc32(buf) {
	let table = crc32.table;
	if (!table) {
		table = crc32.table = [];
		for (let n = 0; n < 256; n++) {
			let c = n;
			for (let k = 0; k < 8; k++) {
				c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
			}
			table[n] = c >>> 0;
		}
	}
	let crc = 0xffffffff;
	for (const byte of buf) {
		crc = table[(crc ^ byte) & 0xff] ^ (crc >>> 8);
	}
	return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
	const length = Buffer.alloc(4);
	length.writeUInt32BE(data.length);
	const typeAndData = Buffer.concat([Buffer.from(type, 'ascii'), data]);
	const crc = Buffer.alloc(4);
	crc.writeUInt32BE(crc32(typeAndData));
	return Buffer.concat([length, typeAndData, crc]);
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 6; // colour type: RGBA
ihdr[10] = 0;
ihdr[11] = 0;
ihdr[12] = 0;

const stride = SIZE * 4 + 1;
const raw = Buffer.alloc(SIZE * stride);
for (let y = 0; y < SIZE; y++) {
	raw[y * stride] = 0; // filter type: none
	pixels.copy(raw, y * stride + 1, y * SIZE * 4, (y + 1) * SIZE * 4);
}

const png = Buffer.concat([
	Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
	chunk('IHDR', ihdr),
	chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
	chunk('IEND', Buffer.alloc(0))
]);

const target = path.join(__dirname, '..', 'images', 'icon.png');
fs.mkdirSync(path.dirname(target), { recursive: true });
fs.writeFileSync(target, png);
console.log(`wrote ${target} (${png.length} bytes)`);
