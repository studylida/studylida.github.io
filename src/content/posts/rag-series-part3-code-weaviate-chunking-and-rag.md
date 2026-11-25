---
title: "RAG 파이프라인 3편(실습): Weaviate 벡터 DB와 청킹, 리랭킹 구현"
description: "로컬 추론 서버와 Weaviate를 연결해 네 가지 청킹 전략을 적용하고, 메타데이터 필터링과 역순위 융합(RRF) 하이브리드 검색, 크로스 인코더 리랭킹 RAG를 구현한다."
pubDate: "2026-11-06 08:10:00"
tags: ["RAG", "Weaviate", "Chunking", "HybridSearch", "Reranking", "Python"]
categories: ["Architecture", "AI"]
draft: false
---

## 1. 로컬 임베딩 서버와 연결

### 로컬 추론 서버(`flask_app.py`)와 Weaviate 연동 구조

이전 글(3편 이론)에서는 대규모 문서 검색을 위한 HNSW 그래프 인덱스와 청킹, 그리고 크로스 인코더 리랭킹 원리를 살펴보았다. 이번 글에서는 **Weaviate** 벡터 데이터베이스를 활용해 원본 텍스트를 나누어 저장하고, 메타데이터 필터링과 하이브리드 검색, 리랭킹을 거쳐 언어 모델 답변을 생성하는 파이프라인을 구현한다.

Weaviate 엔진 자체는 신경망 가중치를 직접 실행하지 않는다. 문서를 적재하거나 검색, 리랭킹할 때 외부 API나 별도 추론 서버로 HTTP 요청을 보내 벡터와 점수를 받아온다. 외부 과금 API 없이 로컬에서 이를 처리하기 위해 백그라운드 스레드로 동작하는 Flask 추론 서버(`flask_app.py`)를 먼저 구동한다.

```python
import json
import threading
from flask import Flask, request, jsonify
from FlagEmbedding import FlagReranker
from sentence_transformers import SentenceTransformer

# 1. 768차원 임베딩 모델 및 크로스 인코더 리랭커 모델 로드
embedding_model = SentenceTransformer("BAAI/bge-base-en-v1.5", cache_folder=".models")
reranker = FlagReranker("BAAI/bge-reranker-base", cache_dir=".models/", use_fp16=True)

app = Flask(__name__)

def generate_embedding(prompt):
    return embedding_model.encode(prompt).tolist()

# 2. Weaviate가 추론 서버 기동 여부를 확인하는 헬스 체크 엔드포인트
@app.route("/.well-known/ready", methods=["GET"])
def readiness_check():
    return "Ready", 200

@app.route("/meta", methods=["GET"])
def readiness_check_2():
    return jsonify({"status": "Ready"}), 200

# 3. 텍스트 임베딩 생성 엔드포인트 (text2vec-transformers 호출 대상)
@app.route("/vectors", methods=["POST"])
def vectorize():
    # Weaviate 버전과 요청 형태에 따라 JSON 딕셔너리, JSON 직렬화 문자열, 순수 평문 문자열을 모두 정규화한다
    data = request.json.get("text") if request.json else request.data.decode("utf-8")
    if isinstance(data, str):
        try:
            text = json.loads(data)
        except json.JSONDecodeError:
            # {"text": "plain text"}처럼 JSON 문자열이 아닌 일반 문장이면 그대로 리스트로 감싼다
            text = data
    else:
        text = data
    if isinstance(text, str):
        text = [text]
    elif isinstance(text, dict):
        text = text["text"]
    embeddings = generate_embedding(text)
    return jsonify({"vector": embeddings})

# 4. 크로스 인코더 리랭킹 엔드포인트 (reranker-transformers 호출 대상)
@app.route("/rerank", methods=["POST"])
def rerank():
    text = request.json
    query = text["query"]
    documents = text["documents"]
    if not documents:
        return jsonify({"scores": []})

    compares = [(query, doc) for doc in documents]
    scores = reranker.compute_score(compares)
    # FlagReranker가 후보 수(단건 vs 다건)에 따라 ndarray 또는 list/float을 반환할 수 있어 일관된 리스트로 변환
    scores_list = scores.tolist() if hasattr(scores, "tolist") else (scores if isinstance(scores, list) else [scores])

    reranked_results = [
        {"document": doc_text, "score": float(scores_list[i])}
        for i, doc_text in enumerate(documents)
    ]
    return jsonify({"scores": reranked_results})

# 5. 임포트 즉시 백그라운드 데몬 스레드로 5000번 포트 추론 서버 시작
threading.Thread(
    target=lambda: app.run(host="127.0.0.1", port=5000, use_reloader=False),
    daemon=True,
).start()
```

`flask_app.py`를 임포트하면 백그라운드 데몬 스레드에서 로컬 `5000`번 포트로 서버가 올라간다.
- **`BAAI/bge-base-en-v1.5`**: `/vectors` 요청을 받아 텍스트를 `768`차원 밀집 벡터로 바꾼다.
- **`BAAI/bge-reranker-base`**: `/rerank` 요청으로 질문과 후보 문서 쌍(`compares`)을 받아 정밀 관련도 점수를 반환한다.

### 임베디드 클라이언트 구동과 포트 초기화

이제 필요한 파이썬 라이브러리와 보조 함수들을 불러오고 Weaviate 클라이언트를 연결한다.

```python
from typing import List
import os
import re
import joblib
import requests
import tqdm
import weaviate
from weaviate.classes.config import Configure, Property, DataType, Tokenization
from weaviate.classes.query import Filter, Rerank
from weaviate.util import generate_uuid5

from utils import (
    generate_with_single_input,
    suppress_subprocess_output,
    print_object_properties,
    kill_processes_on_ports
)

# 이전 실행에서 점유 중인 백그라운드 포트 초기화
kill_processes_on_ports([5000, 8080, 8079, 8097, 50050, 50051])

import flask_app
```

`utils.py` 보조 함수들의 역할은 다음과 같다.
- **`kill_processes_on_ports`**: 로컬 포트(`5000`, `8079`, `8080`, `50050`, `50051`)를 점유 중인 이전 프로세스를 종료해 포트 충돌과 gRPC 끊김을 막는다.
- **`suppress_subprocess_output`**: Weaviate 엔진이 백그라운드에서 내보내는 장황한 시스템 로그가 실행 출력을 가리지 않도록 임시로 숨긴다.
- **`print_object_properties`**: 단일 속성 딕셔너리를 받아 알파벳순으로 정렬 출력하되 긴 텍스트나 벡터는 앞부분만 잘라 보여준다.
- **`generate_with_single_input`**: 프롬프트 문자열을 언어 모델 API에 넘겨 `{'role': 'assistant', 'content': '...'}` 딕셔너리를 반환한다.

백그라운드에서 `flask_app`이 `5000`번 포트로 실행되었으므로 이 엔드포인트를 바라보는 임베디드 Weaviate 클라이언트를 생성한다.

```python
with suppress_subprocess_output():
    client = weaviate.connect_to_embedded(
        persistence_data_path="./.collections",
        environment_variables={
            "ENABLE_API_BASED_MODULES": "true",
            "ENABLE_MODULES": "text2vec-transformers, reranker-transformers",
            "TRANSFORMERS_INFERENCE_API": "http://127.0.0.1:5000/",
            "RERANKER_INFERENCE_API": "http://127.0.0.1:5000/"
        }
    )
```

`weaviate.connect_to_embedded`는 별도 서버 컨테이너 없이 파이썬 프로세스 내부에서 Weaviate 엔진을 실행한다. `persistence_data_path="./.collections"`를 지정하면 생성된 컬렉션과 HNSW 인덱스가 디스크에 남아 재실행 시에도 유지된다.

---

## 2. 네 가지 청킹 구현

### 원본 텍스트 로드와 고정 크기 및 중첩 청킹

벡터 DB에 적재하기 전에 긴 텍스트를 알맞은 크기로 나누는 청킹 함수를 구현한다. 실습 데이터로 *Pro Git* 1장 섹션(`what-is-git.asc`) 원문을 불러온다.

```python
url = "https://raw.githubusercontent.com/progit/progit2/main/book/01-introduction/sections/what-is-git.asc"
source_text = requests.get(url).text

print(source_text[:300])
print(f"총 단어 수: {len(source_text.split())} words (약 {round(len(source_text.split()) * 1.3)} tokens)")
```

```text
=== What is Git?

By far, the most widely used modern version control system in the world today is Git. Git is a mature, actively maintained open source project originally developed in 2005 by Linus Torvalds, the famous creator of the Linux operating system kernel.
...
총 단어 수: 1495 words (약 1944 tokens)
```

이 챕터에는 약 1,495단어가 들어 있다. 이를 단어 수 기준 일정 길이로 자르는 **고정 크기 청킹(`get_chunks_fixed_size`)**부터 작성한다.

```python
def get_chunks_fixed_size(text: str, chunk_size: int) -> List[str]:
    text_words = text.split()
    chunks = []
    for i in range(0, len(text_words), chunk_size):
        chunk = " ".join(text_words[i: i + chunk_size])
        chunks.append(chunk)
    return chunks

fixed_size_chunks = get_chunks_fixed_size(source_text, chunk_size=100)
print(f"생성된 청크 수: {len(fixed_size_chunks)}")
# 출력: 생성된 청크 수: 15
```

100단어씩 자르면 총 `15`개 청크가 만들어진다. 하지만 문장 중간이 무조건 끊어지므로 인접 청크끼리 지정 비율(`overlap_fraction`)만큼 단어를 겹쳐 가져오는 **중첩 청킹(`get_chunks_fixed_size_with_overlap`)**으로 확장한다.

```python
def get_chunks_fixed_size_with_overlap(
    text: str, chunk_size: int, overlap_fraction: float
) -> List[str]:
    text_words = text.split()
    overlap_int = int(chunk_size * overlap_fraction)
    chunks = []

    for i in range(0, len(text_words), chunk_size):
        # 첫 반복(i = 0)에서 i - overlap_int가 음수 인덱스로 뒤집히지 않도록 max(..., 0)으로 하한 고정
        chunk = " ".join(text_words[max(i - overlap_int, 0): i + chunk_size])
        chunks.append(chunk)

    return chunks
```

여기서 `max(i - overlap_int, 0)`이 중요하다. `i = 0`일 때 그냥 `i - overlap_int`로 슬라이싱하면 음수 인덱스(`[-5:25]`)가 되어 첫 청크가 빈 리스트로 비어 버린다. `max(..., 0)`을 걸어 두어야 첫 청크 `0:25`가 보존되고 이후 `20:50`, `45:75`처럼 앞 청크의 마지막 5단어를 겹쳐 가져온다.

### 문단 구분자 분할과 버퍼 기반 혼합 청킹

이번에는 단어 수 대신 문서의 구조 구분자를 기준으로 나눈다. 일반 문단은 빈 줄(`\n\n`)로 나뉘며, *Pro Git* 원문 같은 AsciiDoc 문서는 섹션 제목 앞에 `\n==` 마커가 붙는다.

```python
# 1. 빈 줄(\n\n) 기준 문단 분할
def get_chunks_by_paragraph(source_text: str) -> List[str]:
    return source_text.split("\n\n")

# 2. AsciiDoc 섹션 마커(\n==) 기준 분할
def get_chunks_by_asciidoc_sections(source_text: str) -> List[str]:
    return source_text.split("\n==")
```

단순히 `split("\n==")`만 실행하면 `'=== What is Git?'`처럼 **본문 없는 4단어짜리 소제목만 단독 청크로 떨어진다.** 소제목만 있는 청크는 검색 가치가 낮고, 뒤따르는 본문은 어느 소제목 아래 글인지 맥락을 잃는다.

이 문제를 막으려면 `\n==` 구분자로 나눈 뒤 짧은 조각을 버퍼에 모았다가 합치는 **혼합 청킹(`mixed_chunking`)**을 구현해야 한다. 최소 길이(`25`단어) 미만인 소제목 조각을 `chunk_buffer`에 쌓아 두었다가 다음 본문 조각 앞에 이어 붙이는 방식이다.

```python
def mixed_chunking(source_text: str) -> list:
    # 1. AsciiDoc 섹션 마커(\n==)를 기준으로 1차 분할
    chunks = source_text.split("\n==")

    new_chunks = []
    chunk_buffer = ""
    min_length = 25

    for chunk in chunks:
        # 2. 이전 반복에서 이월된 짧은 조각(소제목 등)과 현재 본문 결합
        new_buffer = chunk_buffer + chunk
        new_buffer_words = new_buffer.split(" ")

        # 3. 25단어 미만이면 확정하지 않고 다음 조각과 합치기 위해 버퍼에 유지
        if len(new_buffer_words) < min_length:
            chunk_buffer = new_buffer
        else:
            new_chunks.append(new_buffer)
            chunk_buffer = ""

    # 4. 문서 맨 끝의 짧은 조각이 버퍼에 남아 유실되지 않도록 마지막 청크로 회수
    if len(chunk_buffer) > 0:
        new_chunks.append(chunk_buffer)

    return new_chunks
```

첫 조각 `'=== What is Git?'`은 4단어이므로 `chunk_buffer`에 대기하다가 두 번째 본문 조각을 만났을 때 합쳐져 25단어 이상인 온전한 청크로 저장된다.

### 메타데이터 상속과 전략별 청크 객체 조립

이제 미리 준비된 *Pro Git* 1장과 2장의 14개 섹션 데이터 파일(`book_text_objs`)을 불러와 구조를 확인하고, 네 가지 전략을 일괄 적용한다.

```python
# 14개 섹션 딕셔너리 리스트 로드 및 샘플 1건 확인
book_text_objs = joblib.load("dataset/book_text_objs.joblib")
print("섹션 수:", len(book_text_objs))
print("샘플 키:", book_text_objs[0].keys())
print("챕터 제목:", book_text_objs[0]["chapter_title"], "| 파일명:", book_text_objs[0]["filename"])
```

원본 문서를 여러 청크로 쪼갤 때는 각 청크가 어느 챕터와 파일의 몇 번째 조각인지 추적할 수 있도록 메타데이터를 물려주어야 한다.

```python
def build_chunk_objs(book_text_obj: dict, chunks: list) -> list:
    chunk_objs = list()
    for i, c in enumerate(chunks):
        chunk_objs.append({
            "chapter_title": book_text_obj["chapter_title"],
            "filename": book_text_obj["filename"],
            "chunk": c,
            "chunk_index": i
        })
    return chunk_objs

chunk_obj_sets = dict()

for book_text_obj in book_text_objs:
    text = book_text_obj["body"]

    for strategy_name, chunks in [
        ["fixed_size_25", get_chunks_fixed_size_with_overlap(text, 25, 0.2)],
        ["fixed_size_100", get_chunks_fixed_size_with_overlap(text, 100, 0.2)],
        ["para_chunks", get_chunks_by_paragraph(text)],
        ["para_chunks_min_25", mixed_chunking(text)]
    ]:
        chunk_objs = build_chunk_objs(book_text_obj, chunks)
        chunk_obj_sets.setdefault(strategy_name, []).extend(chunk_objs)
```

네 가지 전략의 구분은 다음과 같다.
- **`fixed_size_25`**: 25단어 고정 크기에 $20\%$ 중첩을 적용한 전략
- **`fixed_size_100`**: 100단어 고정 크기에 $20\%$ 중첩을 적용한 전략
- **`para_chunks`**: 빈 줄(`\n\n`)로 단순 분할한 가변 길이 문단 전략
- **`para_chunks_min_25`**: AsciiDoc 섹션 마커(`\n==`)로 나눈 뒤 25단어 미만의 짧은 제목을 다음 본문과 병합한 혼합 전략 (원문 자체가 `\n==` 구분자를 쓰는 AsciiDoc 문서여서 문단 기반 혼합 전략의 하나로 이 이름을 붙였다)

---

## 3. 컬렉션 생성과 청킹 실험

### 스키마 정의와 정확 일치 토큰화

청크 객체들을 저장할 Weaviate 컬렉션을 생성한다. 컬렉션에는 어떤 속성들을 묶어 벡터화할지와 각 속성의 데이터 타입, 토큰화 규칙을 지정한다.

```python
# 이미 같은 이름의 컬렉션이 디스크에 있으면 중복 생성 오류를 피하기 위해 기존 컬렉션을 그대로 불러온다.
if not client.collections.exists("chunking_example"):
    collection = client.collections.create(
        name="chunking_example",
        vectorizer_config=[
            Configure.NamedVectors.text2vec_transformers(
                name="vector",
                source_properties=["chunk", "chapter_title", "filename"],
                vectorize_collection_name=False,
                inference_url="http://127.0.0.1:5000",
            )
        ],
        properties=[
            Property(name="chunk", data_type=DataType.TEXT),
            Property(name="chapter_title", data_type=DataType.TEXT),
            Property(name="filename", data_type=DataType.TEXT),
            Property(
                name="chunking_strategy",
                data_type=DataType.TEXT,
                tokenization=Tokenization.FIELD
            ),
            Property(name="chunk_index", data_type=DataType.INT),
        ]
    )
else:
    collection = client.collections.get("chunking_example")
```

컬렉션 설정에서 눈여겨볼 두 가지는 다음과 같다.
1. **`source_properties`와 `vectorize_collection_name=False`**: 임베딩할 때 본문(`chunk`)뿐 아니라 상위 챕터 제목(`chapter_title`)과 파일명(`filename`)을 함께 묶어 문맥 정보를 보강한다. 반면 컬렉션 이름(`"chunking_example"`)은 내용과 무관한 기술 식별자이므로 벡터 계산에서 제외한다.
2. **`tokenization=Tokenization.FIELD`**: 기본 단어 토큰화(`Tokenization.WORD`)는 밑줄(`_`)을 기준으로 `"para_chunks"`와 `"para_chunks_min_25"`를 모두 `["para", "chunks", ...]`로 쪼개 버린다. 그 결과 `"para_chunks"`만 골라내려 해도 `"para_chunks_min_25"`까지 같이 걸린다. **`Tokenization.FIELD`**를 지정하면 문자열 전체를 하나의 단일 토큰으로 취급해 전략 이름처럼 정확히 일치해야 하는 값을 안전하게 필터링한다.

### 고유 해시 ID 기반 배치 적재와 오류 제어

이제 네 전략의 청크들을 `collection.batch.fixed_size`로 적재한다.

```python
# 컬렉션이 비어 있을 때만 적재를 실행해 스크립트 재실행 시 중복 작업을 건너뛴다.
if len(collection) == 0:
    # 로컬 단일 Flask 서버로의 과대한 배치 타임아웃을 막기 위해 batch_size=1로 쪼개되 concurrent_requests=20으로 병렬 처리한다
    stop_import = False
    with collection.batch.fixed_size(batch_size=1, concurrent_requests=20) as batch:
        for chunking_strategy, chunk_objects in tqdm.tqdm(chunk_obj_sets.items()):
            if stop_import:
                break
            for chunk_obj in chunk_objects:
                chunk_obj["chunking_strategy"] = chunking_strategy
                batch.add_object(
                    properties=chunk_obj,
                    uuid=generate_uuid5(chunk_obj)
                )
                # 서버 오류나 네트워크 장애로 실패가 10건을 넘으면 나머지 전략 적재까지 즉시 중단한다.
                if batch.number_errors > 10:
                    print("Batch import stopped due to excessive errors.")
                    stop_import = True
                    break

    failed_objects = collection.batch.failed_objects
    if failed_objects:
        print(f"Number of failed imports: {len(failed_objects)}")
```

배치 적재 시 세 가지 안전장치가 동작한다.
- **`batch_size=1, concurrent_requests=20`**: 로컬 Flask 추론 서버는 단일 스레드로 동작하므로 한 요청에 청크를 50개씩 묶어 보내면 직렬 인코딩 중에 HTTP 타임아웃이 나기 쉽다. 반대로 요청 단위를 `1`건으로 작게 쪼개되 동시 요청(`concurrent_requests=20`)을 열어 두면 타임아웃을 피하면서 처리 속도를 확보할 수 있다.
- **`generate_uuid5(chunk_obj)`**: 무작위 ID(UUID4) 대신 객체 내용의 SHA-1 해시 기반 UUID5를 생성한다. 적재 스크립트를 두 번 실행해도 같은 청크가 중복 삽입되지 않고 덮어써진다.
- **`batch.number_errors`와 `collection.batch.failed_objects`**: 일부 실패 건수가 기준(`10`건)을 넘으면 루프를 멈추고, 종료 후 `failed_objects`로 실패 원인을 점검한다.

적재 후 전략별 청크 수를 집계해 확인한다.

```python
print(f"Total count: {collection.aggregate.over_all().total_count}")
for chunking_strategy in chunk_obj_sets.keys():
    where_filter = Filter.by_property("chunking_strategy").equal(chunking_strategy)
    count = collection.aggregate.over_all(filters=where_filter).total_count
    print(f"Object count for {chunking_strategy}: {count}")
```

```text
Total count: 1620
Object count for fixed_size_25: 909
Object count for fixed_size_100: 231
Object count for para_chunks: 400
Object count for para_chunks_min_25: 80
```

총 1,620개 청크 중 25단어 고정 청크는 909개로 가장 잘게 나뉘었고, 짧은 제목을 병합한 혼합 청크(`para_chunks_min_25`)는 80개의 큼직한 조각으로 정리되었다.

### 질문 성격에 따른 검색 비교와 청크 개수 보정

이제 동일한 컬렉션 안에서 `where_filter`로 청킹 전략만 바꾸어가며 질문의 성격에 따라 어떤 청킹 전략이 유리한지 실험한다.

```python
# 실험 1: 넓은 주제를 묻는 포괄적 질문 ("history of git")
# 실험 2: 구체적인 명령어를 묻는 좁은 질문 ("how to add the url of a remote repository")
search_string = "history of git"

for chunking_strategy in chunk_obj_sets.keys():
    where_filter = Filter.by_property("chunking_strategy").equal(chunking_strategy)
    response = collection.query.near_text(
        search_string, filters=where_filter, limit=2
    )
    print(f"RETRIEVED OBJECTS FOR CHUNKING STRATEGY {chunking_strategy.upper()}:")
    for i, obj in enumerate(response.objects):
        print(f"===== Object {i} =====")
        print(obj.properties["chunk"])
```

두 질문으로 검색 결과를 비교해 보면 청크 크기에 따른 차이가 분명하다.
1. **포괄적 질문 (`"history of git"`)**: 25단어 고정 청크(`fixed_size_25`)는 앞뒤 맥락이 끊겨 Git 탄생 배경을 파악하기 어렵다. 반면 최소 25단어를 보장한 혼합 청크(`para_chunks_min_25`)는 리누스 토르발즈가 BitKeeper 사용을 중단하고 2005년에 Git을 개발하게 된 배경과 설계 목표를 한 번에 가져온다.
2. **구체적인 명령어 질문 (`"how to add the url of a remote repository"`)**: 반대로 원격 저장소 URL 추가 명령어를 찾을 때는 `fixed_size_25`가 군더더기 없이 `git remote add <shortname> <url>` 구문 주변만 짚어낸다.

그렇다면 LLM 프롬프트에 검색 결과를 넣어 답변을 생성할 때는 어떻게 해야 할까? 모든 전략에서 똑같이 `limit = 2`개씩만 가져오면 25단어 청크는 50단어, 100단어 청크는 200단어를 보게 되어 공정한 비교가 되지 않는다. 따라서 **청크 길이에 반비례해 검색 개수(`n_chunks_by_strat`)를 보정**한다.

```python
PROMPT = (
    "Using this information and only this information, "
    "please explain {search_string} in a few short points.\nContext: {context}"
)

# 청크 크기 차이를 보정하기 위한 전략별 검색 개수 설정
n_chunks_by_strat = {
    "fixed_size_25": 8,
    "para_chunks": 8,
    "fixed_size_100": 2,
    "para_chunks_min_25": 2,
}

search_string = "history of git"

for chunking_strategy in chunk_obj_sets.keys():
    where_filter = Filter.by_property("chunking_strategy").equal(chunking_strategy)
    response = collection.query.near_text(
        search_string,
        filters=where_filter,
        limit=n_chunks_by_strat[chunking_strategy]
    )
    context_string = "\n".join(obj.properties["chunk"] for obj in response.objects)

    prompt = PROMPT.format(search_string=search_string, context=context_string)
    # 4편과 동일하게 실습 래퍼 규약으로 role을 넘긴다 (표준 OpenAI Chat API 직접 호출 시에는 role="user" 사용)
    llm_res = generate_with_single_input(prompt, role="assistant")
    print(f"Chunking Strategy: {chunking_strategy}\nResponse:\n\t{llm_res['content']}\n")
```

```text
Chunking Strategy: fixed_size_25
Response:
	Git began in 2005 after the Linux kernel community ended its relationship with BitKeeper... (조각난 문맥으로 요약 일부 누락)

Chunking Strategy: para_chunks_min_25
Response:
	- Developed in 2005 by Linus Torvalds and the Linux kernel community after BitKeeper's free license was revoked.
	- Designed for speed, simple design, strong support for non-linear branching, and distributed architecture.
```

전달되는 총 단어 분량을 200단어 수준으로 맞추더라도, 문장 중간이 끊긴 조각 8개를 이어 붙인 `fixed_size_25`보다 문단 완결성을 지킨 `para_chunks_min_25`가 훨씬 조리 있는 요약문을 만든다.

---

## 4. 필터와 기본 검색 구현

### BBC 뉴스 컬렉션 구조와 768차원 벡터 확인

앞선 1\~3장에서는 임베디드 Weaviate 클라이언트(`connect_to_embedded`)를 열어 직접 청킹과 적재를 수행했다. 4\~6장에서는 먼저 임베디드 연결을 닫는다(`client.close()`). 그다음 이미 청킹과 임베딩 적재가 끝난 **BBC News 컬렉션(`bbc_collection`)**이 떠 있는 로컬 Weaviate 서버(포트 `8079`, gRPC `50050`)에 새로 연결한다.

```python
# 1. 이전 임베디드 클라이언트 리소스 해제 후 로컬 Weaviate 서버(8079)로 전환
client.close()
client = weaviate.connect_to_local(port=8079, grpc_port=50050)
collection = client.collections.get("bbc_collection")

print(f"컬렉션 내 전체 청크 수: {len(collection)}")

# 2. 벡터를 포함해 첫 번째 청크 객체 1건 조회 (단일 속성 딕셔너리 전달)
obj = collection.query.fetch_objects(limit=1, include_vector=True).objects[0]
print_object_properties(obj.properties)
print("Vector (앞 5개 원소):", obj.vector["main_vector"][0:5])
print("Vector length:", len(obj.vector["main_vector"]))
```

```text
컬렉션 내 전체 청크 수: 29048
article_content: The 2024 awards season kicked off in style at the Golden Globes...(truncated)
chunk: some of his previous get-ups. The Bear's Jeremy Allen White...(truncated)
chunk_index: 4
description: Stars including Margot Robbie and Taylor Swift arrived in a variety of...(truncated)
link: https://www.bbc.co.uk/news/entertainment-arts-67908727?at_medium=RSS&at_campaign=KARANGA
pubDate: 2024-01-08 03:23:58+00:00
title: Margot Robbie, Taylor Swift and more on Golden Globes red carpet

Vector (앞 5개 원소): [-0.0314, 0.0128, -0.0441, 0.0089, 0.0512]
Vector length: 768
```

전체 기사들이 분할되어 총 `29,048`개의 청크가 적재되어 있다. 각 객체의 `properties`에는 원본 기사의 메타데이터(`title`, `pubDate`, `link`, `description`, `article_content`)와 함께 분할된 조각 텍스트인 `chunk`와 순서 번호 `chunk_index`가 들어 있다. 또한 `include_vector=True`로 조회한 `obj.vector["main_vector"]`의 길이가 `768`인 것을 통해, 모든 청크가 `BAAI/bge-base-en-v1.5` 모델에 의해 768차원 벡터로 매핑되어 있음을 확인할 수 있다.

### 메타데이터 필터링 함수 (`filter_by_metadata`)

첫 번째로 구현할 검색 함수는 벡터나 키워드 점수 계산 없이 순수하게 메타데이터 조건만으로 객체를 걸러내는 `filter_by_metadata`다.

Weaviate의 `Filter.by_property(속성명)` 뒤에는 다양한 조건 메서드를 연결할 수 있다. 예를 들어 숫자 속성이 특정 값 이상인지 볼 때는 `.greater_or_equal(3.5)`을 쓰고, 정확히 일치하는 값을 찾을 때는 `.equal('Low')`을 쓴다.

이번에 작성할 함수는 검사할 속성 이름(`metadata_property`)과 찾고자 하는 단어들의 리스트(`values: list[str]`)를 입력받아, **해당 속성에 주어진 단어들 중 어느 하나라도 포함된 객체를 최대 `limit`개 반환**해야 한다.

```python
def filter_by_metadata(
    metadata_property: str,
    values: list[str],
    collection: "weaviate.collections.collection.sync.Collection",
    limit: int = 5
) -> list:
    # 1. 지정된 속성이 values 리스트의 값 중 하나라도 포함하는지 검사하는 필터 생성
    metadata_filter = Filter.by_property(metadata_property).contains_any(values)

    # 2. 단순 메타데이터 조회이므로 fetch_objects에 limit과 filters를 키워드 인자로 전달
    response = collection.query.fetch_objects(
        limit=limit,
        filters=metadata_filter
    )

    # 3. QueryReturn 객체 내부의 .objects 리스트를 순회하며 속성 딕셔너리만 추출
    response_objects = [x.properties for x in response.objects]
    return response_objects
```

이 함수를 구현할 때 주의해야 할 세 가지 문법 포인트가 있다.
1. **`.equal()` 대신 `.contains_any(values)` 사용**: 기사 제목(`title`)이 `"Margot Robbie, Taylor Swift and more on Golden Globes red carpet"`처럼 긴 문장일 때, `values=['Taylor Swift']`가 제목의 일부로 포함되어 있기만 해도 찾아내야 한다. 또한 `values`가 단일 문자열이 아니라 리스트(`list[str]`)로 들어오므로, 리스트 내 원소 중 하나라도 포함되면 통과(OR 조건)시키는 `.contains_any(values)`를 사용한다.
2. **키워드 인자 전달**: `collection.query.fetch_objects(limit=limit, filters=metadata_filter)`처럼 파라미터 이름을 명시하여 전달한다.
3. **`QueryReturn` 반환 구조와 `.objects` 순회**: `fetch_objects()`를 호출하면 단일 객체가 아니라 검색 결과 전체를 감싼 `QueryReturn` 객체(`response`)가 반환된다. 실제 검색된 개별 데이터들은 `response.objects` 리스트 안에 들어 있으며, 각 원소 `x`의 실제 딕셔너리 데이터는 `x.properties`에 담겨 있다. 따라서 `fetch_objects(...)` 호출 끝에 `.objects[0]`을 붙여 단일 객체만 꺼내버리면, 아래의 리스트 컴프리헨션(`[x.properties for x in response.objects]`)에서 `.objects` 속성을 찾지 못해 에러가 발생한다. `response`에는 반드시 `QueryReturn` 객체 원본을 그대로 담아야 한다.

구현한 함수로 제목(`'title'`)에 `'Taylor Swift'`가 포함된 청크 2개를 조회해 본다.

```python
res = filter_by_metadata("title", ["Taylor Swift"], collection, limit=2)
for x in res:
    print_object_properties(x)
```

```text
article_content: The 2024 awards season kicked off in style at the Golden Globes...(truncated)
chunk: some of his previous get-ups. The Bear's Jeremy Allen White...(truncated)
chunk_index: 4
title: Margot Robbie, Taylor Swift and more on Golden Globes red carpet

article_content: The 2024 awards season kicked off in style at the Golden Globes...(truncated)
chunk: headpiece - not entirely a fashion choice. She says the "protective veil"...(truncated)
chunk_index: 5
title: Margot Robbie, Taylor Swift and more on Golden Globes red carpet
```

### 시맨틱 검색과 BM25 검색 함수 구현

이어서 768차원 벡터 거리를 기반으로 의미를 검색하는 `semantic_search_retrieve` 함수와, 역색인 단어 빈도를 기반으로 검색하는 `bm25_retrieve` 함수를 차례대로 구현한다.

```python
def semantic_search_retrieve(
    query: str,
    collection: "weaviate.collections.collection.sync.Collection",
    top_k: int = 5
) -> list:
    # 질문을 768차원 벡터로 변환한 뒤 HNSW 인덱스로 상위 top_k개 탐색
    response = collection.query.near_text(
        query=query,
        limit=top_k
    )
    response_objects = [x.properties for x in response.objects]
    return response_objects


def bm25_retrieve(
    query: str,
    collection: "weaviate.collections.collection.sync.Collection",
    top_k: int = 5
) -> list:
    # 역색인(Inverted Index) 기반 BM25 키워드 점수 상위 top_k개 탐색
    response = collection.query.bm25(
        query=query,
        limit=top_k
    )
    response_objects = [x.properties for x in response.objects]
    return response_objects
```

두 함수 모두 함수 시그니처에서는 가져올 개수를 `top_k`로 받지만, Weaviate 쿼리 메서드(`near_text`, `bm25`) 내부에서는 개수 제한 파라미터 이름이 `limit`이므로 `limit=top_k`로 매핑해 전달한다.

이제 동일한 질문(`"Tell me about the last Taylor Swift show"`)을 두 함수에 각각 넣어 검색 결과가 어떻게 달라지는지 비교해 본다.

```python
print("=== 1. Semantic Search 결과 ===")
for item in semantic_search_retrieve("Tell me about the last Taylor Swift show", collection, top_k=2):
    print_object_properties(item)

print("=== 2. BM25 Search 결과 ===")
for item in bm25_retrieve("Tell me about the last Taylor Swift show", collection, top_k=2):
    print_object_properties(item)
```

```text
=== 1. Semantic Search 결과 ===
chunk: size crowd at all". At an earlier show in Liverpool, she had also called the Eras Tour...(truncated)
pubDate: 2024-08-21 03:02:08+00:00
title: 'I've never had it this good' - Taylor Swift thanks fans after new Wembley record

=== 2. BM25 Search 결과 ===
chunk: Nicki Minaj. He also won a third award for best rap album with his album Michael. "You cannot tell m...(truncated)
pubDate: 2024-02-05 23:27:08+00:00
title: Killer Mike dismisses arrest at Grammys as 'speed bump'
```

두 검색 결과는 뚜렷하게 갈린다. **시맨틱 검색(`near_text`)**은 질문의 전체 맥락을 파악해 테일러 스위프트가 웸블리 스타디움에서 유럽 투어 마지막 공연을 마친 정확한 기사 청크를 찾아왔다. 반면 **BM25 검색(`bm25`)**은 질문 속 일반 단어(`"Tell"`, `"me"`, `"about"`, `"last"`, `"show"`)가 많이 나온 기사를 우선한다. 이 때문에 테일러 스위프트와 무관한 래퍼 킬러 마이크의 그래미 수상 소감 기사가 1위로 올라왔다. 일상 대화형 질문에 단순 키워드 매칭만 쓰면 이처럼 질문 의도와 무관한 문서가 최상단에 놓이기 쉽다.

---

## 5. 하이브리드 검색과 리랭킹

### 역순위 융합(RRF) 기반 하이브리드 검색 구현

키워드 검색의 정확한 고유명사 매칭과 시맨틱 검색의 문맥 파악 능력을 결합하기 위해 Weaviate의 `collection.query.hybrid` 메서드를 감싼 `hybrid_retrieve` 함수를 구현한다.

```python
def hybrid_retrieve(
    query: str,
    collection: "weaviate.collections.collection.sync.Collection",
    alpha: float = 0.5,
    top_k: int = 5
) -> list:
    # BM25와 시맨틱 검색을 병렬 실행한 뒤 alpha 가중치로 결합
    response = collection.query.hybrid(
        query=query,
        alpha=alpha,
        limit=top_k
    )
    response_objects = [x.properties for x in response.objects]
    return response_objects

hybrid_results = hybrid_retrieve("Tell me about the last Taylor Swift show", collection, alpha=0.5, top_k=2)
for item in hybrid_results:
    print(item["title"])
# 출력 예시:
# 'I've never had it this good' - Taylor Swift thanks fans after new Wembley record
# Killer Mike dismisses arrest at Grammys as 'speed bump'
```

`collection.query.hybrid`를 호출하면 Weaviate는 내부에서 BM25 검색과 시맨틱 벡터 검색을 함께 수행한 뒤 **역순위 융합(Reciprocal Rank Fusion, RRF)** 방식으로 두 순위표를 병합한다. 이때 **`alpha`** 파라미터가 두 검색의 가중치 균형을 조절한다.
- `alpha = 0.0`: $100\%$ 순수 BM25 키워드 검색만 사용
- `alpha = 0.5` (기본값): 키워드 검색과 시맨틱 벡터 검색을 $50:50$ 동일 비중으로 결합
- `alpha = 1.0`: $100\%$ 순수 시맨틱 벡터 검색만 사용

### 크로스 인코더 리랭킹 결합 (`semantic_search_with_reranking`)

이제 1차 시맨틱 검색이 가져온 후보들을 크로스 인코더 모델(`BAAI/bge-reranker-base`)로 재채점하는 `semantic_search_with_reranking` 함수를 구현한다.

이 함수는 1차 검색용 질문(`query`)과 별개로 리랭킹 전용 질문(`rerank_query`)을 따로 받을 수 있으며, 문서의 어느 속성(`rerank_property`, 예: `'chunk'` 또는 `'title'`)을 기준으로 채점할지 지정할 수 있다.

```python
def semantic_search_with_reranking(
    query: str,
    rerank_property: str,
    collection: "weaviate.collections.collection.sync.Collection",
    rerank_query: str = None,
    top_k: int = 5
) -> list:
    # 1. 리랭킹 전용 질문이 없으면 원래 검색 질문(query)을 그대로 사용
    if rerank_query is None:
        rerank_query = query

    # 2. 재채점할 대상 속성(prop)과 기준 질문(query)을 담아 Rerank 설정 객체 생성
    reranker = Rerank(prop=rerank_property, query=rerank_query)

    # 3. 1차 near_text 검색에 rerank 파라미터를 주입해 결과 재정렬
    response = collection.query.near_text(
        query=query,
        limit=top_k,
        rerank=reranker
    )

    response_objects = [x.properties for x in response.objects]
    return response_objects
```

실행은 두 단계로 이루어진다. 먼저 `Rerank(prop=rerank_property, query=rerank_query)`로 재채점 대상 칸과 기준 질문을 정의한다. 이어 `collection.query.near_text(..., rerank=reranker)`를 호출하면 Weaviate가 HNSW 인덱스로 후보를 추린 뒤 1장에서 띄운 로컬 Flask 서버 `/rerank` 엔드포인트로 보내 관련도 점수 순으로 다시 정렬해 돌려준다.

라틴 아메리카의 외교 갈등 상황을 묻는 질문으로 리랭킹 결과를 확인한다.

```python
query = "Tell me about the conflicts in Latin America"
results = semantic_search_with_reranking(
    query,
    collection=collection,
    top_k=2,
    rerank_property="chunk"
)
for item in results:
    print_object_properties(item)
```

```text
article_content: A huge diplomatic row has erupted after Spain's transport minister suggested Argentina's president h...(truncated)
chunk: weeks' to attend the launch of Vox's European election campaign, newspaper El Pais reported. Mr Mile...(truncated)
chunk_index: 3
title: Spain-Argentina row over drug-use accusation

article_content: Opposition supporters have gathered across Venezuela to protest against Nicolás Maduro's disputed vi...(truncated)
chunk: the world, from Australia to Spain and also in the United Kingdom, Canada, Colombia, Mexico and Arge...(truncated)
chunk_index: 4
title: Protests across Venezuela as election dispute goes on
```

`'chunk'` 본문을 기준으로 크로스 인코더 리랭킹을 거친 결과, 스페인-아르헨티나 외교 갈등 기사와 베네수엘라 대선 시위 기사가 최상단으로 정렬되어 나온다.

---

## 6. 프롬프트와 RAG 완성

### 검색 함수를 교체할 수 있는 프롬프트 생성기

지금까지 만든 네 가지 검색기(`semantic_search_retrieve`, `bm25_retrieve`, `hybrid_retrieve`, `semantic_search_with_reranking`)는 모두 동일한 속성 딕셔너리 리스트를 반환한다. 따라서 검색 함수를 인자(`retrieve_function`)로 넘기면 하나의 프롬프트 생성기(`generate_final_prompt`)로 모든 검색 방식을 교체하며 실험할 수 있다. *(리랭킹 전용 인자를 받는 `semantic_search_with_reranking`은 `use_rerank=True`와 함께 넘기고, 나머지 세 검색기는 `use_rerank=False`로 호출한다.)*

```python
from typing import Callable

def generate_final_prompt(
    query: str,
    top_k: int,
    retrieve_function: Callable | None = None,
    rerank_query: str = None,
    rerank_property: str = None,
    use_rerank: bool = False,
    use_rag: bool = True
) -> str:
    # 1. RAG 비활성화 모드(Baseline 비교용)면 원본 질문만 반환
    if not use_rag:
        return query

    # 검색기 함수가 생략된 경우 기본 하이브리드 검색기로 대체해 None 호출 오류를 막는다
    if retrieve_function is None:
        retrieve_function = hybrid_retrieve

    # 2. 리랭킹 옵션 활성화 여부에 따라 검색 함수 인자 분기
    if use_rerank:
        # 크로스 인코더 리랭킹에서는 어떤 속성 텍스트('chunk', 'title' 등)를 재채점할지 필수 지정해야 한다
        if rerank_property is None:
            raise ValueError("rerank_property must be set if use_rerank = True")
        top_k_documents = retrieve_function(
            query=query,
            top_k=top_k,
            collection=collection,
            rerank_property=rerank_property,
            rerank_query=rerank_query
        )
    else:
        top_k_documents = retrieve_function(
            query=query,
            top_k=top_k,
            collection=collection
        )

    # 3. 청크 본문과 함께 제목, 발행 시각, 출처 URL 메타데이터까지 문자열로 포맷팅
    formatted_data = ""
    for document in top_k_documents:
        document_layout = (
            f"Title: {document['title']}, Chunk: {document['chunk']}, "
            f"Published at: {document['pubDate']}\nURL: {document['link']}"
        )
        formatted_data += document_layout + "\n"

    # 4. 지시문, 질문, 검색된 2024년 뉴스 맥락을 결합해 최종 프롬프트 조립
    prompt = (
        f"Answer the user query below. There will be provided additional information for you to compose your answer. "
        f"The relevant information provided is from 2024 and it should be added as your overall knowledge to answer the query, "
        f"you should not rely only on this information to answer the query, but add it to your overall knowledge.\n"
        f"The news data is ordered by relevance.\n"
        f"Query: {query}\n"
        f"2024 News: {formatted_data}"
    )

    return prompt
```

`generate_final_prompt`는 `use_rerank=True`일 때 `rerank_property`가 빠졌는지 검사해 잘못된 호출을 막는다. 이어 청크 본문(`chunk`)뿐 아니라 원본 제목(`title`), 발행 시각(`pubDate`), 기사 URL(`link`)을 함께 묶어 모델이 시점과 근거 링크를 인용할 수 있게 만든다.

### LLM 호출 연동과 최종 RAG 응답 검증

마지막으로 `generate_final_prompt` 결과를 LLM에 전달하는 `llm_call`을 완성하고, 2024년 미국과 브라질의 외교 관계 및 출처 링크를 묻는 질문을 실행한다.

```python
def llm_call(
    query: str,
    retrieve_function: Callable | None = None,
    top_k: int = 5,
    use_rag: bool = True,
    use_rerank: bool = False,
    rerank_property: str = None,
    rerank_query: str = None
) -> str:
    # 1. 지정된 검색기 및 리랭킹 옵션으로 증강 프롬프트 생성
    PROMPT = generate_final_prompt(
        query,
        top_k=top_k,
        retrieve_function=retrieve_function,
        use_rag=use_rag,
        use_rerank=use_rerank,
        rerank_property=rerank_property,
        rerank_query=rerank_query
    )

    # 2. LLM 호출 및 응답 텍스트 추출
    generated_response = generate_with_single_input(PROMPT)
    return generated_response["content"]


query = (
    "Tell me about United States and Brazil's relationship over the course of 2024. "
    "Provide links for the resources you use in the answer."
)
print(llm_call(query=query, top_k=5, retrieve_function=hybrid_retrieve))

# 작업 종료 후 로컬 Weaviate 연결 해제
client.close()
```

```text
In 2024, the United States and Brazil engaged closely at multilateral summits including the G20 meeting in Rio de Janeiro, balancing diplomatic cooperation on climate and economic initiatives alongside regional debates over Western Hemisphere affairs.
- Source: https://www.bbc.com/news/world-latin-america-...
```

`llm_call`을 실행하면 하이브리드 검색기가 2024년 BBC 뉴스 컬렉션에서 미국과 브라질 관련 청크 5건을 찾아 프롬프트에 주입한다. 언어 모델은 이 맥락으로 2024년 양국 관계 현안을 요약하고 전달받은 `https://www.bbc.com/news/...` 링크를 함께 출력한다. 모든 작업이 끝난 뒤에는 `client.close()`로 연결과 점유 포트를 정상 해제한다.

---

## 7. 참고 자료

1. **DeepLearning.AI** — *Retrieval Augmented Generation (RAG)*, Module 3 Labs & Assignment: "Introduction to Weaviate API, Chunking, and Building RAG Systems with a Vector Database"
2. **Weaviate Documentation** — *Python Client v4: Manage Data, Collections, Hybrid Search, and Reranking* (`https://weaviate.io/developers/weaviate`)
