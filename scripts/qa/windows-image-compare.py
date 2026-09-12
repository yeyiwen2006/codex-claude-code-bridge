from PIL import Image, ImageChops
import sys, json
a = Image.open(sys.argv[1]).convert('RGBA')
b = Image.open(sys.argv[2]).convert('RGBA')
same_size = a.size == b.size
matches = same_size and a.tobytes() == b.tobytes()
diff = sum(x != y for x, y in zip(a.getdata(), b.getdata())) if same_size else None
print(json.dumps({'referenceSize': list(a.size), 'capturedSize': list(b.size), 'allPixelsEqual': matches, 'differentPixels': diff, 'pixelCount': a.width * a.height}))
