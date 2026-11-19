"""Validate downloaded product photographs and make local WebP assets."""
import json
import sys
from pathlib import Path
from PIL import Image, ImageOps

input_path = Path(sys.argv[1])
rows = json.loads(input_path.read_text(encoding='utf-8'))
result = []
for row in rows:
    output = Path(row['output_path'])
    output.parent.mkdir(parents=True, exist_ok=True)
    with Image.open(row['raw_path']) as original:
        image = ImageOps.exif_transpose(original)
        assert image.width >= 120 and image.height >= 100, f"Image too small: {row['source_image_url']}"
        image.thumbnail((1200, 1200), Image.Resampling.LANCZOS)
        if image.mode in ('RGBA', 'LA') or image.mode == 'P' and 'transparency' in image.info:
            rgba = image.convert('RGBA')
            background = Image.new('RGBA', rgba.size, (255, 255, 255, 255))
            image = Image.alpha_composite(background, rgba).convert('RGB')
        else:
            image = image.convert('RGB')
        image.save(output, 'WEBP', quality=89, method=6)
        result.append(dict(key=row['key'], source_image_url=row['source_image_url'], width=image.width, height=image.height))
(input_path.parent / 'normalization-results.json').write_text(json.dumps(result), encoding='utf-8')
print(f'Validated and normalized {len(result)} product photos.')
