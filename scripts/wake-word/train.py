"""Train Octa's wake-word classifier on openWakeWord embeddings and export octa.onnx.

Input  [1, 16, 96] (16 x 80 ms embeddings, exactly what OpenWakeWordOnnxEngine feeds), output [1, 1] in 0..1.
Run: uv run --python 3.12 --with numpy --with onnx train.py
"""
import json
import os
import sys

import numpy as np
import onnx
from onnx import TensorProto, helper, numpy_helper

ROOT = os.environ.get("WAKEWORD_DIR") or os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", ".octa", "wakeword")
FEATS = os.path.join(ROOT, "feats")
WIN, EMB = 16, 96
rs = np.random.default_rng(3)


def load(name):
    index = json.load(open(os.path.join(FEATS, f"{name}.json"), encoding="utf8"))
    data = np.fromfile(os.path.join(FEATS, f"{name}.f32"), dtype=np.float32).reshape(-1, EMB)
    return index, data


def windows(data, clip, frames):
    """Windows ending at the given frame indices, with the runtime's 15 zero rows of left padding."""
    seq = data[clip["offset"]: clip["offset"] + clip["frames"]]
    padded = np.concatenate([np.zeros((WIN - 1, EMB), np.float32), seq])
    return np.stack([padded[i: i + WIN] for i in frames]) if len(frames) else np.zeros((0, WIN, EMB), np.float32)


def all_windows(data, clip):
    return windows(data, clip, range(clip["frames"]))


tts_index, tts = load("tts")
owner_index, owner = load("owner")
AUG = [load(n) for n in os.environ.get("AUG", "").split(",") if n]

specs = []  # (data, clip, frame indices, labels)
for clip in tts_index:
    if clip["split"] != "train":
        continue
    labels = np.array(clip["labels"])
    keep = np.where(labels >= 0)[0]
    specs.append((tts, clip, keep, labels[keep]))
owner_step = int(os.environ.get("OWNER_STEP", "3"))
for data, index in [(owner, [c for c in owner_index if c["split"] == "train"])] + [(aug, idx) for idx, aug in AUG]:
    for clip in index:
        frames = np.arange(rs.integers(0, owner_step), clip["frames"], owner_step)
        specs.append((data, clip, frames, np.zeros(len(frames))))
total = sum(len(f) for _, _, f, _ in specs)
HARD_CAP = int(os.environ.get("HARD_CAP", "30000"))
X = np.empty((total + HARD_CAP, WIN * EMB), np.float32)
y = np.empty(total + HARD_CAP, np.float32)
at = 0
for data, clip, frames, labels in specs:
    if len(frames):
        X[at: at + len(frames)] = windows(data, clip, frames).reshape(len(frames), -1)
        y[at: at + len(frames)] = labels
        at += len(frames)
del specs
used = total
print(f"train windows {used}  positives {int(y[:used].sum())}", flush=True)

acc, acc2 = np.zeros(WIN * EMB), np.zeros(WIN * EMB)
for i in range(0, used, 20000):
    chunk = X[i: min(used, i + 20000)].astype(np.float64)
    acc += chunk.sum(0)
    acc2 += (chunk * chunk).sum(0)
mean = (acc / used).astype(np.float32)
std = (np.sqrt(np.maximum(acc2 / used - (acc / used) ** 2, 0)) + 1e-4).astype(np.float32)
for i in range(0, used, 20000):
    X[i: i + 20000][: max(0, used - i)] -= mean
    X[i: i + 20000][: max(0, used - i)] /= std
Xn = X

H = int(os.environ.get("HIDDEN", "96"))
params = {
    "W1": rs.normal(0, np.sqrt(2 / (WIN * EMB)), (WIN * EMB, H)).astype(np.float32), "b1": np.zeros(H, np.float32),
    "W2": rs.normal(0, np.sqrt(2 / H), (H, H)).astype(np.float32), "b2": np.zeros(H, np.float32),
    "W3": rs.normal(0, np.sqrt(1 / H), (H, 1)).astype(np.float32), "b3": np.zeros(1, np.float32),
}
m = {k: np.zeros_like(v) for k, v in params.items()}
v = {k: np.zeros_like(v) for k, v in params.items()}


def forward(x, p, train=False):
    h1 = np.maximum(0, x @ p["W1"] + p["b1"])
    if train:
        h1 *= (rs.random(h1.shape) > 0.2) / 0.8
    h2 = np.maximum(0, h1 @ p["W2"] + p["b2"])
    z = (h2 @ p["W3"] + p["b3"])[:, 0]
    return h1, h2, z


def predict(x_raw):
    _, _, z = forward((x_raw.reshape(-1, WIN * EMB) - mean) / std, params)
    return 1 / (1 + np.exp(-np.clip(z, -60, 60)))


NEG_WEIGHT = float(os.environ.get("NEG_WEIGHT", "3"))
HARD_WEIGHT = float(os.environ.get("HARD_WEIGHT", "8"))
EPOCHS = int(os.environ.get("EPOCHS", "14"))
ROUNDS = int(os.environ.get("ROUNDS", "3"))
BATCH, LR = 512, 1e-3
WD = float(os.environ.get("WD", "1e-4"))
INPUT_NOISE = float(os.environ.get("INPUT_NOISE", "0"))
step = 0
sample_weight = np.where(y == 1, 1.0, NEG_WEIGHT).astype(np.float32)
y[used:] = -1


def train(epochs, lr0):
    global step
    pos_idx = np.where(y[:used] == 1)[0]
    neg_idx = np.where(y[:used] == 0)[0]
    for epoch in range(epochs):
        # Every negative once per epoch, positives oversampled to a third of the batch.
        order = np.concatenate([neg_idx, rs.choice(pos_idx, len(neg_idx) // 2)])
        rs.shuffle(order)
        total = 0.0
        lr = lr0 * (0.5 ** (epoch // 5))
        for start in range(0, len(order), BATCH):
            b = order[start: start + BATCH]
            xb, yb, w = Xn[b], y[b], sample_weight[b]
            if INPUT_NOISE:
                xb = xb + rs.normal(0, INPUT_NOISE, xb.shape).astype(np.float32)
            h1, h2, z = forward(xb, params, train=True)
            pz = 1 / (1 + np.exp(-np.clip(z, -60, 60)))
            total += float(np.sum(w * (np.logaddexp(0, z) - yb * z)))
            dz = (w * (pz - yb) / len(b))[:, None].astype(np.float32)
            grads = {"W3": h2.T @ dz, "b3": dz.sum(0)}
            dh2 = (dz @ params["W3"].T) * (h2 > 0)
            grads["W2"], grads["b2"] = h1.T @ dh2, dh2.sum(0)
            dh1 = (dh2 @ params["W2"].T) * (h1 > 0)
            grads["W1"], grads["b1"] = xb.T @ dh1, dh1.sum(0)
            step += 1
            for k in params:
                g = grads[k] + (WD * params[k] if k.startswith("W") else 0)
                m[k] = 0.9 * m[k] + 0.1 * g
                v[k] = 0.999 * v[k] + 0.001 * g * g
                params[k] -= lr * (m[k] / (1 - 0.9 ** step)) / (np.sqrt(v[k] / (1 - 0.999 ** step)) + 1e-8)
        print(f"epoch {epoch + 1} loss {total / len(order):.4f}", flush=True)


def mine(threshold=0.15):
    """Every training window of negative audio that the current model scores >= threshold."""
    found = []
    sources = [(owner, c, None) for c in owner_index if c["split"] == "train"]
    sources += [(tts, c, np.array(c["labels"])) for c in tts_index if c["split"] == "train"]
    sources += [(aug, c, None) for aug_index, aug in AUG for c in aug_index]
    for data, clip, labels in sources:
        wins = all_windows(data, clip)
        if labels is not None:
            wins = wins[labels == 0]
        if len(wins) == 0:
            continue
        scores = predict(wins)
        hard = wins[scores >= threshold]
        if len(hard):
            found.append(hard.reshape(-1, WIN * EMB))
    return np.concatenate(found) if found else np.zeros((0, WIN * EMB), np.float32)


train(EPOCHS, LR)
for round_ in range(ROUNDS):
    hard = mine()
    print(f"round {round_ + 1}: {len(hard)} hard negatives", flush=True)
    if len(hard) == 0:
        break
    hard = hard[: HARD_CAP - (used - total)]
    hard -= mean
    hard /= std
    Xn[used: used + len(hard)] = hard
    y[used: used + len(hard)] = 0
    sample_weight[used: used + len(hard)] = HARD_WEIGHT
    used += len(hard)
    train(6, LR / 2)

# ---- evaluation on held-out voices and held-out owner recordings, streaming-style ----
COOLDOWN = 19  # 1.5 s of 80 ms frames, as in OpenWakeWordDetector
thresholds = [0.3, 0.45, 0.5, 0.6, 0.7, 0.8, 0.9]


def detections(scores, thr, k=1):
    count, last, run = 0, -10**9, 0
    for i, s in enumerate(scores):
        run = run + 1 if s >= thr else 0
        if run >= k and i - last >= COOLDOWN:
            count, last = count + 1, i
    return count


test_pos = [c for c in tts_index if c["split"] == "test" and c["kind"] == "pos"]
test_neg = [c for c in tts_index if c["split"] == "test" and c["kind"] == "neg"]
test_owner = [c for c in owner_index if c["split"] == "test"]
pos_scores = [predict(all_windows(tts, c)) for c in test_pos]
neg_scores = [predict(all_windows(tts, c)) for c in test_neg]
owner_scores = [predict(all_windows(owner, c)) for c in test_owner]
owner_hours = sum(c["frames"] for c in test_owner) * 0.08 / 3600
report = {"owner_test_hours": round(owner_hours, 2), "test_pos_clips": len(test_pos), "test_neg_clips": len(test_neg), "rows": []}
print(f"\nheld-out: {len(test_pos)} positive clips, {len(test_neg)} near-miss clips, {owner_hours:.2f} h of owner speech")
print("k thr   recall  nearmiss-FA  owner-FA/h")
for k in (1, 2, 3):
    for thr in thresholds:
        recall = np.mean([detections(s, thr, k) > 0 for s in pos_scores])
        near = np.mean([detections(s, thr, k) > 0 for s in neg_scores])
        fah = sum(detections(s, thr, k) for s in owner_scores) / owner_hours
        report["rows"].append({"consecutive": k, "threshold": thr, "recall": float(recall), "nearMissFalseAccept": float(near), "ownerFalseAcceptsPerHour": float(fah)})
        print(f"{k} {thr:.2f}  {recall:6.3f}  {near:10.3f}  {fah:9.2f}")
json.dump(report, open(os.path.join(ROOT, "eval.json"), "w"), indent=1)

# ---- export: fold the input normalisation into the first layer ----
W1 = (params["W1"] / std[:, None]).astype(np.float32)
b1 = (params["b1"] - (mean / std) @ params["W1"]).astype(np.float32)
nodes = [
    helper.make_node("Reshape", ["input", "shape"], ["flat"]),
    helper.make_node("Gemm", ["flat", "W1", "b1"], ["g1"]), helper.make_node("Relu", ["g1"], ["r1"]),
    helper.make_node("Gemm", ["r1", "W2", "b2"], ["g2"]), helper.make_node("Relu", ["g2"], ["r2"]),
    helper.make_node("Gemm", ["r2", "W3", "b3"], ["g3"]), helper.make_node("Sigmoid", ["g3"], ["output"]),
]
inits = [
    numpy_helper.from_array(np.array([-1, WIN * EMB], np.int64), "shape"),
    numpy_helper.from_array(W1, "W1"), numpy_helper.from_array(b1, "b1"),
    numpy_helper.from_array(params["W2"], "W2"), numpy_helper.from_array(params["b2"], "b2"),
    numpy_helper.from_array(params["W3"], "W3"), numpy_helper.from_array(params["b3"], "b3"),
]
graph = helper.make_graph(nodes, "octa_wakeword", [helper.make_tensor_value_info("input", TensorProto.FLOAT, ["batch", WIN, EMB])],
                          [helper.make_tensor_value_info("output", TensorProto.FLOAT, ["batch", 1])], inits)
model = helper.make_model(graph, opset_imports=[helper.make_opsetid("", 13)], producer_name="octa-wakeword")
model.ir_version = 8
onnx.checker.check_model(model)
out = os.path.join(ROOT, sys.argv[1] if len(sys.argv) > 1 else "octa.onnx")
onnx.save(model, out)
print("saved", out, os.path.getsize(out), "bytes")
