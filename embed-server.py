#!/usr/bin/env python3
"""bge-m3 向量化服务。

不用 TEI/Docker 的原因：这里的负载是零星几条群消息，TEI 那套高并发批处理
带来的复杂度（容器、GPU 直通、模型文件格式要求 safetensors）不划算。
sentence-transformers 直接加载本地缓存的 pytorch_model.bin 就行。

接口刻意和 TEI 保持一致，所以 embed.mts 不用改：
    POST /embed   {"inputs": ["a","b"]}  ->  [[...1024], [...1024]]
    GET  /health  -> 200
"""
import os

import torch
import uvicorn
from fastapi import FastAPI
from pydantic import BaseModel
from sentence_transformers import SentenceTransformer

MODEL = os.environ.get("EMBED_MODEL", "BAAI/bge-m3")
PORT = int(os.environ.get("EMBED_PORT", "8181"))
DEVICE = "cuda" if torch.cuda.is_available() else "cpu"

print(f"加载 {MODEL} 到 {DEVICE} …", flush=True)
model = SentenceTransformer(MODEL, device=DEVICE)
DIM = model.get_sentence_embedding_dimension()
print(f"就绪：{DIM} 维，监听 :{PORT}", flush=True)

app = FastAPI()


class EmbedRequest(BaseModel):
    inputs: list[str]
    # TEI 的参数，这里收下但不用 —— SentenceTransformer 自己会截断
    truncate: bool = True


@app.get("/health")
def health() -> dict:
    return {"status": "ok", "model": MODEL, "dim": DIM, "device": DEVICE}


@app.post("/embed")
def embed(req: EmbedRequest) -> list[list[float]]:
    if not req.inputs:
        return []
    # normalize 之后余弦距离才等价于内积，pgvector 那边用的是 vector_cosine_ops
    vecs = model.encode(
        req.inputs,
        normalize_embeddings=True,
        batch_size=32,
        show_progress_bar=False,
    )
    return vecs.tolist()


if __name__ == "__main__":
    uvicorn.run(app, host="127.0.0.1", port=PORT, log_level="warning")
