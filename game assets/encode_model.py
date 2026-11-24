
import base64
from pathlib import Path

model = Path("skinstealer.glb")
output = Path("skinstealer_base64.txt")

if not model.exists():
    raise FileNotFoundError(f"Could not find {model}")

encoded = base64.b64encode(
    model.read_bytes()
).decode("ascii")

output.write_text(encoded, encoding="ascii")

print("Model encoded successfully!")
print(f"Original: {model.stat().st_size / 1024:.2f} KB")
print(f"Encoded:  {len(encoded) / 1024:.2f} KB")
print(f"Saved to: {output}")