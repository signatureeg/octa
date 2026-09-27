"""Shift the classifier's output bias so its raw score `RAW` maps to `TARGET`.

The app wakes at 1 - wakeWordSensitivity (default 0.55, so 0.45). Evaluation picked raw 0.8 with three
consecutive frames as the operating point, so this makes the default slider land exactly there.
Run: uv run --no-project --python 3.12 --with numpy --with onnx python calibrate.py octa-b.onnx octa.onnx 0.8 0.45
"""
import sys

import numpy as np
import onnx
from onnx import numpy_helper

src, dst, raw, target = sys.argv[1], sys.argv[2], float(sys.argv[3]), float(sys.argv[4])
logit = lambda p: np.log(p / (1 - p))
shift = logit(target) - logit(raw)
model = onnx.load(src)
for i, init in enumerate(model.graph.initializer):
    if init.name == "b3":
        b3 = numpy_helper.to_array(init) + np.float32(shift)
        model.graph.initializer[i].CopyFrom(numpy_helper.from_array(b3.astype(np.float32), "b3"))
model.producer_name = "octa-wakeword"
model.doc_string = f"Octa wake word (يا أوكتا / أوكتا). Output calibrated: raw {raw} -> {target}. Input [batch,16,96] openWakeWord embeddings."
onnx.checker.check_model(model)
onnx.save(model, dst)
print(f"shift {shift:.4f} saved {dst}")
