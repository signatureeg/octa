# Wake-word models

On startup, Octa copies any of these files that are missing into the folder that holds `wakeWordModelPath`.
It never overwrites a file already there, so a retrained `octa.onnx` survives updates.

| File | Source | License |
|---|---|---|
| `melspectrogram.onnx` | openWakeWord v0.5.1 release assets, https://github.com/dscripka/openWakeWord | Apache-2.0 |
| `embedding_model.onnx` | openWakeWord v0.5.1 release assets, a port of Google's speech_embedding model | Apache-2.0 |
| `octa.onnx` | Trained for Octa with `scripts/wake-word/` on top of the two models above | Same license as this repository |

## Runtime contract

`octa.onnx` takes one input named `input` with shape `[batch, 16, 96]`. Each row is one 80 ms embedding from
`embedding_model.onnx`, fed exactly as `OpenWakeWordOnnxEngine.process` builds it: mel values are scaled `x / 10 + 2` over a 76-frame window.
The model returns one score in `0..1`.
The detector wakes after **3 consecutive frames** with a score of at least `1 - wakeWordSensitivity`. At the default sensitivity of 0.55, that threshold is 0.45.
The output bias is calibrated so the default threshold matches the chosen operating point: a raw score of 0.8 maps to 0.45.

## Training data

- **Positives.** Gemini TTS said "يا أوكتا" and "أوكتا" in Egyptian dialect across 30 voices and 4 styles, giving 764 utterances. Each utterance was checked by transcribing the whole clip. Five augmented copies were made of each, varying speed (±12%), level, noise and real room speech underneath.
- **Negatives.**
  - Near-miss words from the same voices: أوكي، أكتوبر، دكتور، أكتر، يا أختي، octopus, okay, Alexa and similar.
  - Ordinary sentences.
  - About 6 hours of the owner's own dictation, in the original plus two augmented copies.
  - Three rounds of hard-negative mining.
- **Held out for testing.** Six voices (Kore, Puck, Leda, Orus, Sulafat, Achird) and 30% of the dictation files.

## Measured on held-out data

| Measure | Result |
|---|---|
| Wake-word recall, unseen voices, noisy and quiet mixes | 94.6% |
| False wakes on near-miss clips | 0% |
| False wakes in nonstop owner dictation | about 1 per hour of continuous talking |
| Owner's real voice ("أوكتا أو يا أوكتا" in a dictation) | both detected, nothing else in the 48 s clip |

Lowering sensitivity in Settings reduces false wakes. Raising it helps quiet or fast speakers.
