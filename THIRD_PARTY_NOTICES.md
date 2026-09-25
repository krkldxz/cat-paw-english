# THIRD_PARTY_NOTICES — 第三方组件与许可

本文件列出「英语背诵与学习软件 (cat paw)」使用或分发的第三方组件、其许可与来源。
本项目自身代码以 **Apache-2.0** 发布（见 `LICENSE`）。

> 生成/核对日期：2026-09-26。每条许可均通过 GitHub / Hugging Face **API 读取 LICENSE 原文**实测，非凭印象标注。

## 一、随仓库分发（in-tree）

| 组件 | 版本/范围 | 许可 | 来源 | 本仓库位置 |
|---|---|---|---|---|
| PP-OCRv3 / PP-OCRv5 mobile ONNX 模型（英文识别、检测、识别） | en_PP-OCRv3_mobile_rec / ppocrv5_mobile_det / ppocrv5_mobile_rec | **Apache-2.0** | PaddleOCR / PaddleX（PaddlePaddle）官方推理模型转 ONNX | `models/ocr-ppv3/*.onnx` |
| Lucide 图标（vendored SVG 图标库） | — | **ISC** | https://github.com/lucide-icons/lucide | `scripts/lucide/` |
| 词书数据 — 四六级 | CET4 5183 词 / CET6 5974 词 | **MIT** | https://github.com/tealun/moread-content（`vocabulary/exam/cet4.json`、`cet6.json`） | `data/词书-CET4.json`、`data/词书-CET6.json` |
| 词书数据 — 高考 / 中考 | 高考 3837 词 / 中考 1600 词 | **MIT** | 同上（`vocabulary/exam/gaokao.json`、`zhongkao.json`） | `data/词书-高考.json`、`data/词书-中考.json` |
| 词典底座 — 音标/释义/词性/词频/考试标签 | ECDICT 1.0.28 | **MIT** | https://github.com/skywind3000/ECDICT | 聚合进上述词书 JSON（原始 sqlite 不入库） |
| CEFR 分级词表 | 7035 词头 A1–C2 | **MIT** | https://github.com/Maximax67/Words-CEFR-Dataset | `data/词书-CEFR.json` |

### 上游链条说明

- `moread-content` 的 LICENSE 正文自带声明：*"Dictionary data derived from ECDICT (https://github.com/skywind3000/ECDICT), MIT License."*
- `Words-CEFR-Dataset` 自述基于 **CEFR-J 词表**（东京外国语大学投野研究室）与 **Google N-Gram 词频**。本仓库按 MIT 使用其整理成果，**不使用 "Cambridge EVP" 等不实标注**（早期代码注释中的该措辞已更正）。

## 二、运行期依赖，不随仓库分发（用户自行获取）

| 组件 | 许可 | 来源 | 获取方式 |
|---|---|---|---|
| **Gemma 4 E2B**（`google/gemma-4-E2B-it`，Q4_K_M GGUF + mmproj） | **Apache-2.0** | https://huggingface.co/google/gemma-4-E2B-it | `tools/fetch-models.ps1`（不打包进仓库） |
| **llama.cpp**（推理引擎，CUDA build） | **MIT** | https://github.com/ggml-org/llama.cpp | 同上（引擎目录不入库） |
| **RapidOCR**（Python 包，OCR 快路径） | **Apache-2.0** | https://github.com/RapidAI/RapidOCR | `pip install rapidocr` |
| **PyMuPDF**（PDF 解析） | AGPL-3.0 / 商业双许可 | https://github.com/pymupdf/PyMuPDF | 注意：AGPL 传染性，本项目仅以独立进程调用，不作为库链接 |
| **Node.js** | MIT | https://nodejs.org | 运行时 |
| **Microsoft Edge WebView2 Runtime**（Windows 壳） | Microsoft 可再分发组件条款 | Microsoft | 目标机已内置 |

> ⚠️ **再分发提醒**：若把模型权重（GGUF，含 mmproj）**随"一体化包"一起分发**，则构成 Apache-2.0 意义上的再分发，须在该分发包内附带 Apache-2.0 全文与 Google 的版权声明。若只提供下载脚本、由用户自行从上游获取，则不构成再分发（本仓库采用后者）。

## 三、未随分发、且不得随分发的数据

| 数据 | 原因 |
|---|---|
| `data/上海高考词汇手册.pdf` | 官方考纲原件，版权归原权利人（相关词汇手册由出版社出版），**不入库** |
| `data/词书-上海高考.json` | 由上述 PDF 解析衍生，**不入库**；软件提供「本地导入」通道，由用户自备原件构建 |

软件对这类数据的能力描述为：**支持用户导入自有词书**（JSON 词书 或 纯文本词表），不附带任何来源不明的词表。

## 四、复核方法

```bash
# 逐个组件实测上游许可（读 LICENSE 原文, 非看标签）
node scripts/_archive/license-audit.js            # 仓库名 → api.github.com/repos/<owner>/<repo>/license
node scripts/_tools/find-apache-license.js        # 本机找一份权威 Apache-2.0 全文副本
```
