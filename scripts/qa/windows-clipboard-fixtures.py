from pathlib import Path
from PIL import Image
import json
import sys

root = Path(sys.argv[1])
image = Image.new('RGBA', (512, 256))
image.putdata([(x % 256, y, (x * 7 + y * 3) % 256, 255) for y in range(256) for x in range(512)])
image.save(root / 'opaque.png')
transparent = image.copy()
transparent.putalpha(Image.frombytes('L', image.size, bytes((x // 2 for y in range(256) for x in range(512)))))
transparent.save(root / 'transparent.png')
image.convert('RGB').save(root / 'sample.jpg', quality=95)
image.convert('RGB').save(root / 'sample.gif')
image.save(root / 'sample.webp', lossless=True)
for i in range(21):
    (root / f'count-{i:02}.png').write_bytes((root / 'opaque.png').read_bytes())
for name, size in [('over-single.png', 25 * 1024 * 1024 + 1), ('exact-single.png', 25 * 1024 * 1024)]:
    with (root / name).open('wb') as f:
        f.write((root / 'opaque.png').read_bytes())
        f.truncate(size)
for i in range(5):
    with (root / f'total-{i}.png').open('wb') as f:
        f.write((root / 'opaque.png').read_bytes())
        f.truncate(21 * 1024 * 1024)
(root / 'index.html').write_text('<!doctype html><meta charset="utf-8"><title>Bridge clipboard QA</title><h1>Bridge clipboard QA</h1><p>Opaque reference 512 x 256</p><img src="opaque.png"><p>Transparent reference</p><img src="transparent.png">', encoding='utf-8')
print(json.dumps({'created': True, 'dimensions': list(image.size)}))
