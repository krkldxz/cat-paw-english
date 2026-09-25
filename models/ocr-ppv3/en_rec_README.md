---
license: apache-2.0
library_name: onnxruntime
pipeline_tag: image-to-text
tags:
- paddleocr
- paddlex
- onnx
- ocr
---

# en_PP-OCRv3_mobile_rec ONNX

ONNX conversion of PaddlePaddle's official `en_PP-OCRv3_mobile_rec` text recognition inference model.

## Provenance

- Upstream archive: https://paddle-model-ecology.bj.bcebos.com/paddlex/official_inference_model/paddle3.0.0/en_PP-OCRv3_mobile_rec_infer.tar
- Upstream projects: [PaddleOCR](https://github.com/PaddlePaddle/PaddleOCR) and [PaddleX](https://github.com/PaddlePaddle/PaddleX)
- Conversion environment: PaddlePaddle 3.3.0, PaddleX 3.7.0, paddle2onnx 2.0.2rc3
- ONNX opset: 11

## Validation

The graph passed `onnx.checker`, loaded and ran with ONNX Runtime 1.28.0 on CPU, and was compared numerically with the original Paddle inference graph using the same deterministic float32 input. Maximum absolute output error: `3.2186508178710938e-6`.

## Runtime files

- `inference.onnx`: converted model graph and weights
- `inference.yml`: upstream preprocessing, postprocessing, and label metadata

This repository contains a format conversion, not a retrained model. Consult the upstream PaddleOCR documentation for model scope, accuracy, and intended use.

