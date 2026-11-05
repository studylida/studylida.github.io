---
title: "RAG 파이프라인 3편(실습): Weaviate 벡터 DB 구축과 청킹, 리랭킹 구현"
description: "로컬 추론 서버와 Weaviate 클라이언트를 연결하고, 네 가지 방식으로 문서를 나눈 뒤 메타데이터 필터링과 하이브리드 검색, 리랭킹을 결합한 RAG 파이프라인을 파이썬으로 구현한다."
pubDate: "2026-11-06 08:10:00"
tags: ["RAG", "Weaviate", "Chunking", "HybridSearch", "Reranking", "Python"]
categories: ["Architecture", "AI"]
draft: false
---

## 1. 로컬 임베딩 서버와 연결

### 로컬 추론 서버(`flask_app.py`)와 Weaviate 연동 구조

이전 글(3편 이론 편)에서는 대규모 문서 검색을 위한 HNSW 그래프 인덱스와 청킹, 그리고 크로스 인코더 리랭킹의 동작 원리를 살펴보았다. 이번 실습 편에서는 오픈소스 벡터 데이터베이스인 **Weaviate**를 활용해 원본 텍스트를 나누어 저장하고, 메타데이터 필터링과 하이브리드 검색, 리랭킹을 거쳐 언어 모델(LLM)의 답변을 생성하는 전체 파이프라인을 코드로 구현한다.

Weaviate에 문서를 적재하거나 시맨틱 검색, 리랭킹을 요청할 때 Weaviate 엔진 자체는 신경망 가중치를 직접 실행하지 않는다. 대신 외부 API(예: OpenAI)나 별도의 추론 컨테이너로 HTTP 요청을 보내 벡터와 점수를 받아온다. 유료 외부 API 없이 로컬 환경에서 이 과정을 처리하기 위해, 실습 환경에서는 백그라운드 스레드로 동작하는 Flask 추론 서버(`flask_app.py`)와 보조 모듈(`utils.py`)을 먼저 구동한다.

Weaviate와 통신하는 로컬 추론 서버의 핵심 엔드포인트 구현을 먼저 확인한다.

```python
from flask import Flask, request, jsonify
from FlagEmbedding import FlagReranker
from sentence_transformers import SentenceTransformer
import threading

# 1. 768차원 임베딩 모델 및 크로스 인코더 리랭커 모델 로드
embedding_model = SentenceTransformer("BAAI/bge-base-en-v1.5", cache_folder=".models")
reranker = FlagReranker("BAAI/bge-reranker-base", cache_dir=".models/", use_fp16=True)

app = Flask(__name__)

def generate_embedding(prompt):
    return embedding_model.encode(prompt).tolist()

# 2. Weaviate 상태 확인용 헬스 체크 엔드포인트
@app.route("/.well-known/ready", methods=["GET"])
def readiness_check():
    return "Ready", 200

@app.route("/meta", methods=["GET"])
def readiness_check_2():
    return jsonify({"status": "Ready"}), 200

# 3. 텍스트 임베딩 생성 엔드포인트 (text2vec-transformers 모듈 호출 대상)
@app.route("/vectors", methods=["POST"])
def vectorize():
    data = request.json.get("text") if request.json else request.data.decode("utf-8")
    text = json.loads(data) if isinstance(data, str) else data
    if isinstance(text, str):
        text = [text]
    elif isinstance(text, dict):
        text = text["text"]
    embeddings = generate_embedding(text)
    return jsonify({"vector": embeddings})

# 4. 크로스 인코더 리랭킹 엔드포인트 (reranker-transformers 모듈 호출 대상)
@app.route("/rerank", methods=["POST"])
def rerank():
    text = request.json
    query = text["query"]
    documents = text["documents"]
    if not documents:
        return jsonify({"scores": []})

    # (질문, 후보 문서) 쌍 리스트를 구성하여 크로스 인코더 점수 계산
    compares = [(query, doc) for doc in documents]
    scores = reranker.compute_score(compares)
    scores_list = scores.tolist() if hasattr(scores, "tolist") else scores

    reranked_results = [
        {"document": doc_text, "score": float(scores_list[i])}
        for i, doc_text in enumerate(documents)
    ]
    return jsonify({"scores": reranked_results})
```

`flask_app.py`를 임포트하면 백그라운드 스레드(`threading.Thread`)에서 로컬 `5000`번 포트로 위 서버가 실행된다. 이 서버는 두 개의 모델을 메모리에 상주시킨다.
- **`BAAI/bge-base-en-v1.5`**: 입력된 텍스트를 길이 `768`의 밀집 벡터(Dense Vector)로 변환하는 바이 인코더 임베딩 모델이다. Weaviate가 `/vectors`로 텍스트를 보내면 `{"vector": [...]}` 형태로 임베딩 배열을 반환한다.
- **`BAAI/bge-reranker-base`**: 질문과 후보 문서 쌍(`compares = [(query, doc) for doc in documents]`)을 동시에 입력받아 관련도 점수를 계산하는 크로스 인코더 모델이다. Weaviate가 1차 검색을 마친 뒤 `/rerank`로 질문과 후보 문서 리스트를 보내면, 각 문서의 재채점 점수를 `{"scores": [{"document": ..., "score": ...}]}` 규격으로 돌려준다.

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

# 이전 세션에서 점유 중인 백그라운드 포트 초기화
kill_processes_on_ports([5000, 8080, 8079, 8097, 50050, 50051])

import flask_app
```

`utils.py`에서 불러온 보조 함수들의 역할은 다음과 같다.
- **`kill_processes_on_ports`**: 로컬 포트(`5000`번 Flask 서버 및 `8079`, `8080`, `50050`, `50051`번 Weaviate HTTP/gRPC 포트)를 점유하고 있는 이전 프로세스를 찾아 종료한다. 포트 충돌이나 gRPC 연결 끊김(`_InactiveRpcError`)을 방지하기 위해 서버 구동 전에 호출한다.
- **`suppress_subprocess_output`**: Weaviate 엔진이 백그라운드에서 출력하는 상세 시스템 로그가 노트북 출력을 가리지 않도록 표준 출력과 에러 스트림을 임시로 숨기는 컨텍스트 매니저다.
- **`print_object_properties`**: 검색된 딕셔너리 객체의 속성을 알파벳순으로 정렬해 출력하되, 본문(`article_content`, `chunk`)이나 벡터 배열(`main_vector`)처럼 긴 필드는 앞부분 30\~100자만 자르고 `...(truncated)`를 붙여 가독성 있게 보여주는 출력 함수다.
- **`generate_with_single_input`**: 완성된 프롬프트 문자열을 언어 모델 API에 전달하고 생성된 답변 딕셔너리(`{'role': 'assistant', 'content': '...'}`)를 반환하는 함수다.

백그라운드에서 `flask_app`이 `5000`번 포트로 실행되었으므로, 이 엔드포인트를 바라보는 임베디드 Weaviate 클라이언트를 생성한다.

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

`weaviate.connect_to_embedded`는 별도의 독립 서버를 띄우지 않고 파이썬 애플리케이션 내부에서 Weaviate 엔진을 직접 실행하는 방식이다. `persistence_data_path="./.collections"`를 지정하면 생성된 컬렉션과 HNSW 인덱스 파일이 해당 경로에 영구 저장되어 클라이언트를 종료했다가 다시 열어도 데이터가 유지된다.

`environment_variables` 딕셔너리에는 앞서 살펴본 로컬 Flask 서버와의 연결 정보를 주입한다. `ENABLE_MODULES`에 `'text2vec-transformers, reranker-transformers'`를 선언하여 트랜스포머 기반 벡터화 및 리랭킹 모듈을 활성화하고, 두 모듈이 호출할 추론 서버 주소를 모두 로컬 Flask 서버(`http://127.0.0.1:5000/`)로 지정한다.

---

## 2. 네 가지 텍스트 청킹 구현

### 원본 텍스트 로드와 고정 크기 및 중첩 청킹

벡터 데이터베이스에 문서를 적재하기 전에, 긴 원본 텍스트를 적절한 크기의 조각으로 나누는 청킹(Chunking) 함수를 먼저 구현한다. 실습 데이터로 버전 관리 시스템 Git의 공식 해설서인 *Pro Git*의 1장 섹션(`what-is-git.asc`) 원문을 불러온다.

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

이 챕터 하나에만 약 1,495단어(약 1,944토큰)가 들어 있다. 이 텍스트를 단어 수 기준 일정한 길이로 자르는 첫 번째 함수인 **고정 크기 청킹(`get_chunks_fixed_size`)**을 작성한다.

```python
def get_chunks_fixed_size(text: str, chunk_size: int) -> List[str]:
    # 1. 입력 텍스트를 공백 기준 개별 단어 리스트로 분리
    text_words = text.split()
    chunks = []

    # 2. 0번부터 전체 단어 수까지 chunk_size 보폭(step)으로 인덱스 순회
    for i in range(0, len(text_words), chunk_size):
        # i번째부터 i + chunk_size 직전까지의 단어 슬라이싱
        chunk_words = text_words[i: i + chunk_size]
        # 잘라낸 단어 리스트를 다시 공백으로 이어 붙여 하나의 문자열로 결합
        chunk = " ".join(chunk_words)
        chunks.append(chunk)

    return chunks

fixed_size_chunks = get_chunks_fixed_size(source_text, chunk_size=100)
print(f"생성된 청크 수: {len(fixed_size_chunks)}")
```

`text.split()`으로 전체 본문을 단어 리스트(`text_words`)로 만든 뒤, `range(0, len(text_words), chunk_size)`를 사용해 인덱스를 `0, 100, 200, ...` 순서로 건너뛰며 100단어씩 슬라이싱(`text_words[i: i + chunk_size]`)한다. 1,495단어를 100단어씩 자르면 총 `15`개의 청크가 생성된다.

하지만 이 방식은 100번째 단어와 101번째 단어 사이를 무조건 끊어버리므로 문장이 중간에 잘려 문맥이 손실된다. 이를 보완하기 위해 인접한 청크끼리 지정된 비율(`overlap_fraction`)만큼 단어를 공유하는 **중첩 고정 크기 청킹(`get_chunks_fixed_size_with_overlap`)**으로 확장한다.

```python
def get_chunks_fixed_size_with_overlap(
    text: str, chunk_size: int, overlap_fraction: float
) -> List[str]:
    text_words = text.split()
    # 중첩할 단어 수를 정수로 계산 (예: 100 * 0.2 = 20단어)
    overlap_int = int(chunk_size * overlap_fraction)
    chunks = []

    for i in range(0, len(text_words), chunk_size):
        # 시작 인덱스를 overlap_int만큼 앞으로 당기되, 0보다 작아지지 않도록 방어
        chunk_words = text_words[max(i - overlap_int, 0): i + chunk_size]
        chunk = " ".join(chunk_words)
        chunks.append(chunk)

    return chunks
```

이 함수에서 가장 주의 깊게 볼 부분은 슬라이싱 시작점인 `max(i - overlap_int, 0)`이다. 만약 `chunk_size = 25`, `overlap_fraction = 0.2`여서 `overlap_int = 5`라고 가정해 본다.

첫 번째 반복(`i = 0`)에서 단순히 `text_words[i - overlap_int : i + chunk_size]`라고 작성하면 슬라이싱 범위가 `text_words[-5 : 25]`가 된다. 파이썬 리스트에서 음수 인덱스(`-5`)는 리스트의 끝에서 다섯 번째 요소를 가리키므로, `-5`번부터 `25`번까지 자르면 빈 리스트(`[]`)가 반환되어 첫 번째 청크가 빈 문자열로 들어가는 문제가 생긴다. `max(i - overlap_int, 0)`을 사용하면 `i = 0`일 때 `max(-5, 0)`이 되어 `0:25`를 안전하게 가져오고, 두 번째 반복(`i = 25`)부터는 `20:50`, 세 번째(`i = 50`)는 `45:75`처럼 앞 청크의 마지막 5단어를 겹쳐서 가져온다.

청크 크기를 `5`, `25`, `100`으로 바꾸어 실행해 보면 청크 크기가 작을수록 세부 구절에 집중하지만 문맥이 부족하고, 클수록 문단 전체의 맥락을 담게 되는 차이를 확인할 수 있다.

### 문단 구분자 분할과 버퍼 기반 혼합(Mixed) 청킹

이번에는 단어 수를 세는 대신 문서의 구조적 구분자(Marker)를 기준으로 자르는 가변 크기 청킹을 구현한다. 문단 사이에는 빈 줄(`\n\n`)이 들어가고, AsciiDoc 문서의 하위 섹션 제목 앞에는 `\n==` 기호가 붙는다.

```python
# 1. 빈 줄(\n\n) 기준 문단 단위 분할
def get_chunks_by_paragraph(source_text: str) -> List[str]:
    return source_text.split("\n\n")

# 2. AsciiDoc 섹션 마커(\n==) 기준 분할
def get_chunks_by_asciidoc_sections(source_text: str) -> List[str]:
    return source_text.split("\n==")
```

단순히 `split("\n\n")`이나 `split("\n==")`만 실행하면 한 가지 문제가 나타난다. 첫 번째 조각을 출력해 보면 `'=== What is Git?'`처럼 **본문 없이 단 4단어짜리 소제목만 단독 청크로 분리**된다. 소제목만 들어 있는 청크는 내용이 부족해 검색 가치가 떨어지고, 반대로 뒤에 이어지는 본문 청크는 자신이 어떤 소제목 아래의 글인지 잃어버리게 된다.

이 문제를 해결하려면 구분자(`\n==`)로 먼저 나눈 뒤, **최소 길이(`min_length = 25` 단어)에 미달하는 짧은 조각(소제목 등)을 임시 버퍼(`chunk_buffer`)에 담아두었다가 바로 다음 본문 조각 앞에 이어 붙이는 혼합 청킹(`mixed_chunking`)**을 작성해야 한다.

```python
def mixed_chunking(source_text: str) -> list:
    # 1. 섹션 마커(\n==)를 기준으로 1차 분할
    chunks = source_text.split("\n==")

    new_chunks = []
    chunk_buffer = ""
    min_length = 25

    for chunk in chunks:
        # 이전 반복에서 이월된 버퍼와 현재 조각을 결합
        new_buffer = chunk_buffer + chunk
        new_buffer_words = new_buffer.split(" ")

        # 결합된 단어 수가 25단어 미만이면 리스트에 넣지 않고 다음 조각으로 이월
        if len(new_buffer_words) < min_length:
            chunk_buffer = new_buffer
        else:
            # 25단어 이상이 되면 완성된 청크로 추가하고 버퍼 초기화
            new_chunks.append(new_buffer)
            chunk_buffer = ""

    # 루프 종료 후 버퍼에 남은 잔여 텍스트가 있다면 마지막 청크로 추가
    if len(chunk_buffer) > 0:
        new_chunks.append(chunk_buffer)

    return new_chunks
```

첫 번째 조각인 `'=== What is Git?'`은 공백 기준 4단어이므로 `len(new_buffer_words) < 25` 조건에 걸려 `new_chunks`에 바로 들어가지 않고 `chunk_buffer`에 보관된다. 이어서 두 번째 조각(본문 첫 문단)이 들어오면 `new_buffer = chunk_buffer + chunk`를 통해 소제목과 본문이 하나로 합쳐진다. 합쳐진 길이는 25단어를 넘으므로 비로소 `new_chunks`에 등록되고 `chunk_buffer`는 빈 문자열(`""`)로 비워진다. 마지막 `if len(chunk_buffer) > 0:` 구문은 글 맨 끝부분의 짧은 조각이 버퍼에 남은 채 유실되지 않도록 회수하는 방어 코드다.

### 메타데이터 상속과 전략별 청크 객체 조립

이제 *Pro Git*의 1장과 2장에 수록된 14개 섹션 파일 전체(`book_text_objs`)에 대해 앞서 만든 네 가지 청킹 전략을 일괄 적용한다. 각 원본 섹션 객체는 본문(`body`), 챕터명(`chapter_title`), 파일명(`filename`) 키를 가진 딕셔너리다.

원본 문서를 여러 청크로 쪼갤 때는 각 청크가 어느 챕터의 어느 파일에서 나온 몇 번째 조각인지 알 수 있도록 원본 메타데이터를 그대로 물려주어야 한다. 이를 수행하는 헬퍼 함수가 `build_chunk_objs`다.

```python
def build_chunk_objs(book_text_obj: dict, chunks: list) -> list:
    chunk_objs = list()

    # 분할된 문자열 리스트를 순회하며 인덱스(i)와 텍스트(c) 추출
    for i, c in enumerate(chunks):
        chunk_obj = {
            "chapter_title": book_text_obj["chapter_title"],
            "filename": book_text_obj["filename"],
            "chunk": c,
            "chunk_index": i
        }
        chunk_objs.append(chunk_obj)

    return chunk_objs
```

`build_chunk_objs`는 단순 문자열 리스트였던 `chunks`를 순회하며, 각 청크 문자열(`c`)에 원본 문서의 `chapter_title`과 `filename`, 그리고 문서 내 순서 번호인 `chunk_index`(`i`)를 결합한 딕셔너리 리스트로 변환한다.

이제 14개 챕터 섹션을 순회하며 네 가지 청킹 전략별로 청크 객체 리스트를 생성해 `chunk_obj_sets` 딕셔너리에 모은다.

```python
chunk_obj_sets = dict()

for book_text_obj in book_text_objs:
    text = book_text_obj["body"]

    # 4가지 청킹 전략 이름과 분할 결과를 순회
    for strategy_name, chunks in [
        ["fixed_size_25", get_chunks_fixed_size_with_overlap(text, 25, 0.2)],
        ["fixed_size_100", get_chunks_fixed_size_with_overlap(text, 100, 0.2)],
        ["para_chunks", get_chunks_by_paragraph(text)],
        ["para_chunks_min_25", mixed_chunking(text)]
    ]:
        chunk_objs = build_chunk_objs(book_text_obj, chunks)

        if strategy_name not in chunk_obj_sets.keys():
            chunk_obj_sets[strategy_name] = list()

        chunk_obj_sets[strategy_name] += chunk_objs
```

네 가지 전략의 이름(`strategy_name`)이 왜 이렇게 지어졌는지 살펴보면 각 전략의 특성이 한눈에 드러난다.
- **`fixed_size_25`**: 25단어 고정 크기에 $20\%$ 중첩을 적용한 전략이다.
- **`fixed_size_100`**: 100단어 고정 크기에 $20\%$ 중첩을 적용한 전략이다.
- **`para_chunks`**: 문단(Paragraph)이나 섹션 구분자로 단순 분할한 가변 길이 전략이다.
- **`para_chunks_min_25`**: 구분자 기반 분할(`mixed_chunking`)을 수행하되, 최소 25단어(`min_25`) 미만인 짧은 제목 조각은 다음 본문과 병합한 혼합 전략이다.

---

## 3. 컬렉션 생성과 청킹 실험

### 스키마 정의와 `Tokenization.FIELD` 설정

전처리된 청크 객체들을 저장할 Weaviate 컬렉션을 생성한다. 컬렉션을 만들 때는 어떤 임베딩 모델로 어떤 속성을 벡터화할지(`vectorizer_config`)와 각 속성의 데이터 타입(`properties`)을 명시해야 한다.

```python
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

컬렉션 생성 코드의 핵심 파라미터들을 하나씩 짚어본다.
1. **`vectorizer_config` 리스트와 `NamedVectors`**: Weaviate는 동일한 문서 객체에 대해 서로 다른 여러 임베딩 모델의 벡터를 동시에 저장할 수 있도록 설정을 리스트(`[...]`)로 받는다. 여기서는 로컬 Flask 서버(`http://127.0.0.1:5000`)를 호출하는 `text2vec_transformers` 벡터라이저 하나만 등록하고 이름을 `"vector"`로 지정했다.
2. **`source_properties`와 `vectorize_collection_name`**: 객체의 모든 속성을 다 임베딩할 필요는 없다. `source_properties`에 지정한 속성들만 서로 이어 붙여진 뒤 임베딩 모델로 전달된다. 예를 들어 여행지 추천 데이터셋에서 예산(`budget`) 속성값이 `"Moderate"`일 때, 값만 따로 떼어 임베딩하면 무엇이 보통 수준이라는 뜻인지 알기 어렵다. 이때 `Property(..., vectorize_property_name=True)`로 설정하면 속성 이름과 값을 합쳐 `"budget Moderate"`로 벡터화하므로 의미가 분명해진다. 반면 컬렉션 이름 자체(`"chunking_example"`)는 문맥과 무관하므로 `vectorize_collection_name=False`로 제외한다.
3. **`tokenization=Tokenization.FIELD`**: `chunking_strategy` 속성에만 특별히 부여된 옵션이다. Weaviate의 기본 텍스트 토큰화 방식(`Tokenization.WORD`)은 공백이나 특수문자, 밑줄(`_`)을 기준으로 단어를 쪼갠다. 만약 기본 설정을 그대로 두면 `"para_chunks"`와 `"para_chunks_min_25"`가 모두 `["para", "chunks", ...]`라는 토큰으로 쪼개진다. 그 결과 나중에 `chunking_strategy == "para_chunks"`인 것만 찾으려고 필터를 걸었을 때 `"para_chunks_min_25"`까지 함께 딸려 나오는 문제가 발생한다. **`Tokenization.FIELD`**를 지정하면 문자열 전체를 쪼개지 않고 통째로 하나의 단일 토큰으로 취급하므로, 코드값이나 전략 이름처럼 정확히 일치하는 값만 필터링할 때 필수적으로 사용한다.

### `generate_uuid5` 기반 결정론적 배치 적재

생성된 빈 컬렉션에 네 가지 전략으로 쪼갠 모든 청크 객체를 적재한다. 데이터를 넣을 때는 단건 호출 대신 `collection.batch.fixed_size` 컨텍스트 매니저를 사용한다.

```python
if len(collection) == 0:
    with collection.batch.fixed_size(batch_size=1, concurrent_requests=20) as batch:
        for chunking_strategy, chunk_objects in tqdm.tqdm(chunk_obj_sets.items()):
            for chunk_obj in chunk_objects:
                # 검색 시 전략별로 필터링할 수 있도록 전략 이름 속성 추가
                chunk_obj["chunking_strategy"] = chunking_strategy
                batch.add_object(
                    properties=chunk_obj,
                    uuid=generate_uuid5(chunk_obj)
                )
                # 오류 누적 건수가 임계치를 넘으면 배치 적재 중단
                if batch.number_errors > 10:
                    print("Batch import stopped due to excessive errors.")
                    break

    failed_objects = collection.batch.failed_objects
    if failed_objects:
        print(f"Number of failed imports: {len(failed_objects)}")
```

`batch.add_object`가 실행될 때마다 백그라운드에서는 로컬 Flask 서버를 호출해 텍스트를 768차원 벡터로 변환하고, 컬렉션 내부의 HNSW 다층 그래프 인덱스를 실시간으로 갱신한다. 이때 두 가지 실무 안전장치가 함께 쓰인다.
- **`generate_uuid5(chunk_obj)`**: 무작위(Random) ID인 UUID4와 달리, UUID5는 입력된 객체(`chunk_obj`)의 내용을 해시(SHA-1)하여 항상 동일한 고유 식별자를 생성한다. 따라서 실수로 적재 셀을 두 번 실행하더라도 동일한 청크는 똑같은 UUID를 부여받아 중복 삽입되지 않고 덮어써진다.
- **`batch.number_errors`와 `collection.batch.failed_objects`**: 이론 편 2장에서 살펴본 것처럼, 대량 적재 중 일부 문서에서 오류가 나더라도 전체 작업이 바로 멈추지 않고 `batch.number_errors`에 오류 횟수가 기록된다. 루프 안에서 오류 건수가 지정한 기준(예: 10건)을 넘으면 `break`로 멈출 수 있고, 블록이 끝난 뒤 `collection.batch.failed_objects`를 조회해 실패한 객체와 원인을 따로 확인할 수 있다.

적재가 완료된 후 각 전략별로 몇 개의 청크가 저장되었는지 `Filter.by_property`와 `aggregate.over_all`로 확인한다.

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

`Filter.by_property('chunking_strategy').equal(chunking_strategy)`는 SQL의 `WHERE chunking_strategy = '...'`와 동일한 조건 객체(`where_filter`)를 만든다. 전체 1,620개의 청크 중 25단어 고정 청크는 909개로 가장 잘게 쪼개졌고, 짧은 제목을 병합한 혼합 문단 청크(`para_chunks_min_25`)는 80개의 큼직한 청크로 구성된 것을 볼 수 있다.

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

두 가지 질문으로 실행 결과를 비교해 보면 청크 크기에 따른 차이가 나타난다.
1. **포괄적인 질문 (`"history of git"`)**: 25단어 고정 청크(`fixed_size_25`)는 질문과 단어 유사도는 높지만 앞뒤 설명이 잘려 있어 Git의 탄생 배경을 이해하기 어렵다. 반면 최소 25단어를 보장한 문단 청크(`para_chunks_min_25`)는 리누스 토르발즈와 리눅스 커널 커뮤니티가 BitKeeper 사용을 중단하고 2005년에 Git을 개발하게 된 배경과 설계 목표 전체를 완결된 문맥으로 가져온다.
2. **구체적인 단답형 질문 (`"how to add the url of a remote repository"`)**: 반대로 원격 저장소 URL 추가 명령어를 찾을 때는 `fixed_size_25`가 불필요한 부연 설명 없이 `git remote add <shortname> <url>` 구문이 들어 있는 핵심 구절만 정확히 짚어낸다.

그렇다면 이 검색 결과를 언어 모델(LLM)의 프롬프트에 넣어 답변을 생성할 때는 어떻게 해야 할까? 만약 모든 전략에서 똑같이 `limit = 2`개씩만 가져오면, 25단어 청크 전략은 총 50단어밖에 참고하지 못하고 100단어 청크 전략은 200단어를 참고하게 되어 공정한 비교가 되지 않는다. 따라서 **청크 크기가 작은 전략은 더 많은 개수를 가져오고, 청크 크기가 큰 전략은 더 적은 개수를 가져오도록 검색 개수(`n_chunks_by_strat`)를 보정**한다.

```python
PROMPT = (
    "Using this information and only this information, "
    "please explain {search_string} in a few short points.\nContext: {context}"
)

# 청크 크기 차이를 보정하기 위한 전략별 검색 개수(Number of chunks by strategy) 설정
n_chunks_by_strat = dict()
n_chunks_by_strat["fixed_size_25"] = 8       # 짧은 청크는 8개 인출 (약 200단어)
n_chunks_by_strat["para_chunks"] = 8
n_chunks_by_strat["fixed_size_100"] = 2      # 긴 청크는 2개만 인출 (약 200단어)
n_chunks_by_strat["para_chunks_min_25"] = 2

search_string = "history of git"

for chunking_strategy in chunk_obj_sets.keys():
    where_filter = Filter.by_property("chunking_strategy").equal(chunking_strategy)
    response = collection.query.near_text(
        search_string,
        filters=where_filter,
        limit=n_chunks_by_strat[chunking_strategy]
    )
    context_string = ""
    for obj in response.objects:
        context_string += obj.properties["chunk"] + "\n"

    prompt = PROMPT.format(search_string=search_string, context=context_string)
    llm_res = generate_with_single_input(prompt, role="assistant")
    print(f"Chunking Strategy: {chunking_strategy}\nResponse:\n\t{llm_res['content']}\n")
```

`n_chunks_by_strat`(Number of chunks by strategy) 딕셔너리를 통해 25단어 청크는 8개, 100단어 및 병합 문단 청크는 2개를 가져오도록 맞춰주면 LLM에 전달되는 총 컨텍스트 분량이 비슷해진다. 그럼에도 생성된 답변을 비교해 보면, 문장 중간이 잘린 조각 8개를 이어 붙인 `fixed_size_25`보다 문단의 논리적 완결성이 유지된 `para_chunks_min_25`가 훨씬 조리 있고 정확한 요약문을 생성한다.

---

## 4. 메타데이터 필터와 기본 검색

### BBC 뉴스 컬렉션 구조와 768차원 벡터 확인

앞선 1\~3장에서는 원본 문서를 직접 청킹하여 Weaviate 컬렉션에 적재하는 과정을 살펴보았다. 이제 4\~6장에서는 이미 청킹과 임베딩 적재가 완료된 대규모 뉴스 데이터셋인 **BBC News 컬렉션(`bbc_collection`)**을 불러와, 그 위에서 동작하는 다섯 가지 핵심 검색 함수와 최종 RAG 파이프라인을 차례대로 구축한다.

먼저 로컬 Weaviate 서버에 연결해 원본 BBC 뉴스 데이터(`bbc_data.joblib`)와 `bbc_collection`에 적재된 단일 청크 객체의 구조를 확인한다.

```python
client = weaviate.connect_to_local(port=8079, grpc_port=50050)
collection = client.collections.get("bbc_collection")

print(f"컬렉션 내 전체 청크 수: {len(collection)}")

# 벡터를 포함하여 첫 번째 청크 객체 1건 조회
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
print_object_properties(
    semantic_search_retrieve("Tell me about the last Taylor Swift show", collection, top_k=2)
)

print("=== 2. BM25 Search 결과 ===")
print_object_properties(
    bm25_retrieve("Tell me about the last Taylor Swift show", collection, top_k=2)
)
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

두 검색의 결과가 뚜렷하게 다르다. **시맨틱 검색(`near_text`)**은 질문의 전체 의미를 파악해 테일러 스위프트가 웸블리 스타디움에서 유럽 투어 마지막 공연을 마쳤다는 정확한 기사 청크를 찾아왔다. 반면 **BM25 검색(`bm25`)**은 질문에 들어 있는 일반 단어들(`"Tell"`, `"me"`, `"about"`, `"last"`, `"show"`)이 많이 등장한다는 이유만으로 테일러 스위프트와 무관한 래퍼 킬러 마이크(Killer Mike)의 그래미 수상 소감 기사를 1위로 가져왔다. 일상적인 대화형 질문에서는 단순 키워드 매칭만 쓰면 이처럼 질문 의도와 관련 없는 문서가 상위에 올라올 수 있다.

---

## 5. 하이브리드 검색과 리랭킹

### RRF 기반 하이브리드 검색 구현 (`hybrid_retrieve`)

키워드 검색의 정확한 고유명사 매칭 능력과 시맨틱 검색의 문맥 파악 능력을 결합하기 위해, Weaviate의 `collection.query.hybrid` 메서드를 사용하는 `hybrid_retrieve` 함수를 구현한다.

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
```

`collection.query.hybrid`가 호출되면 Weaviate는 백그라운드에서 BM25 검색과 시맨틱 벡터 검색을 동시에 수행한 뒤, 상호 순위 조합(Reciprocal Rank Fusion, RRF) 방식으로 두 순위표를 병합한다. 이때 **`alpha`** 파라미터가 두 검색의 가중치 균형을 결정한다.
- `alpha = 0.0`: $100\%$ 순수 BM25 키워드 검색만 사용한다.
- `alpha = 0.5` (기본값): 키워드 검색과 시맨틱 벡터 검색을 $50:50$ 동일 비중으로 결합한다.
- `alpha = 1.0`: $100\%$ 순수 시맨틱 벡터 검색만 사용한다.

앞서 테스트한 테일러 스위프트 질문을 `alpha=0.5`, `top_k=2`로 실행하면, BM25 1위였던 킬러 마이크 기사와 시맨틱 검색 1위였던 테일러 스위프트 웸블리 공연 기사가 나란히 상위 2개 결과로 통합되어 반환된다.

### 크로스 인코더 리랭킹 결합 (`semantic_search_with_reranking`)

이제 1차 시맨틱 검색이 가져온 후보들을 크로스 인코더 모델(`BAAI/bge-reranker-base`)로 다시 채점하여 순위를 바로잡는 `semantic_search_with_reranking` 함수를 구현한다.

이 함수는 1차 검색용 질문(`query`)과 별개로 리랭킹 전용 질문(`rerank_query`)을 따로 받을 수 있으며, 문서의 어느 속성(`rerank_property`, 예: 본문 `'chunk'` 또는 제목 `'title'`)을 기준으로 재채점할지 지정할 수 있도록 설계한다.

```python
def semantic_search_with_reranking(
    query: str,
    rerank_property: str,
    collection: "weaviate.collections.collection.sync.Collection",
    rerank_query: str = None,
    top_k: int = 5
) -> list:
    # 1. 리랭킹 전용 질문이 따로 주어지지 않으면 원래 검색 질문(query)을 그대로 사용
    if rerank_query is None:
        rerank_query = query

    # 2. 재채점할 대상 속성(prop)과 기준 질문(query)을 담아 Rerank 설정 객체 생성
    reranker = Rerank(prop=rerank_property, query=rerank_query)

    # 3. 1차 near_text 검색에 rerank 파라미터로 Rerank 객체를 주입하여 결과 재정렬
    response = collection.query.near_text(
        query=query,
        limit=top_k,
        rerank=reranker
    )

    response_objects = [x.properties for x in response.objects]
    return response_objects
```

코드의 동작 흐름을 두 단계로 나누어 살펴본다.
1. **`Rerank` 객체 생성**: `weaviate.classes.query`에서 불러온 `Rerank` 클래스에 두 개의 인자를 넘긴다. `prop=rerank_property`는 후보 객체의 여러 속성 중 어느 텍스트 칸(예: `'chunk'`)을 읽고 점수를 매길지 지정하고, `query=rerank_query`는 크로스 인코더에서 문서 앞에 이어 붙일 기준 질문을 지정한다.
2. **`near_text`와 리랭커 연동**: `collection.query.near_text` 호출 시 `rerank=reranker`를 함께 전달한다. 그러면 Weaviate는 먼저 HNSW 인덱스로 후보 청크들을 찾은 뒤, 각 후보의 `rerank_property` 텍스트와 `rerank_query`를 묶어 1장에서 구동해 둔 로컬 Flask 서버의 `/rerank` 엔드포인트(`FlagReranker`)로 전송한다. 최종적으로 크로스 인코더가 매긴 정밀도 점수 순서대로 `response.objects`가 재정렬되어 반환된다.

구현한 리랭킹 함수로 라틴 아메리카의 갈등 상황을 묻는 질문을 실행해 본다.

```python
query = "Tell me about the conflicts in Latin America"
results = semantic_search_with_reranking(
    query,
    collection=collection,
    top_k=2,
    rerank_property="chunk"
)
print_object_properties(results)
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

`'chunk'` 본문을 기준으로 크로스 인코더 리랭킹을 거친 결과, 아르헨티나와 스페인 간의 외교 갈등 기사 및 베네수엘라 대선 불복 시위 기사가 최상단으로 정확히 정렬되어 반환된다.

---

## 6. 프롬프트 조립과 RAG 완성

### 검색 함수를 교체할 수 있는 프롬프트 생성기 (`generate_final_prompt`)

지금까지 만든 네 가지 검색기(`semantic_search_retrieve`, `bm25_retrieve`, `hybrid_retrieve`, `semantic_search_with_reranking`)는 모두 동일한 형태의 속성 딕셔너리 리스트를 반환한다. 따라서 파이썬에서 함수를 인자(`retrieve_function: callable`)로 전달받는 구조를 활용하면, 단 하나의 프롬프트 생성 함수로 모든 검색 방식을 자유롭게 교체하며 실험할 수 있다.

```python
def generate_final_prompt(
    query: str,
    top_k: int,
    retrieve_function: callable,
    rerank_query: str = None,
    rerank_property: str = None,
    use_rerank: bool = False,
    use_rag: bool = True
) -> str:
    # 1. RAG를 사용하지 않는 경우(Baseline 비교용) 원본 질문만 그대로 반환
    if not use_rag:
        return query

    # 2. 리랭킹 사용 여부에 따라 검색 함수에 전달할 인자 분기
    if use_rerank:
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

    # 3. 검색된 청크들의 제목, 본문 조각, 발행일, 출처 링크를 문자열로 포맷팅
    formatted_data = ""
    for document in top_k_documents:
        document_layout = (
            f"Title: {document['title']}, Chunk: {document['chunk']}, "
            f"Published at: {document['pubDate']}\nURL: {document['link']}"
        )
        formatted_data += document_layout + "\n"

    # 4. 시스템 지시문과 사용자 질문, 검색된 2024년 뉴스 맥락을 결합하여 최종 프롬프트 조립
    prompt = (
        f"Answer the user query below. There will be provided additional information for you to compose your answer. "
        f"The relevant information provided is from 2024 and it should be added as your overall knowledge to answer the query, "
        f"you should not rely only on this information to answer the query, but add it to your overall knowledge."
        f"The news data is ordered by relevance."
        f"Query: {query}\n"
        f"2024 News: {formatted_data}"
    )

    return prompt
```

이 함수는 `use_rerank=True`일 때 `rerank_property`가 누락되었는지 먼저 검사(`if rerank_property is None: raise ValueError(...)`)하여 잘못된 호출을 방어한다. 이어서 검색된 각 청크 객체에서 청크 본문(`chunk`)뿐만 아니라 상속받은 원본 기사 제목(`title`), 발행 시각(`pubDate`), 원본 기사 URL(`link`)을 함께 묶어 프롬프트 하단에 주입한다. 이렇게 메타데이터를 프롬프트에 함께 넣어주어야 언어 모델이 답변을 작성할 때 사건의 시점과 근거 링크를 정확히 인용할 수 있다.

### LLM 호출 연동과 최종 RAG 응답 검증

마지막으로 `generate_final_prompt`가 조립한 프롬프트를 받아 언어 모델을 호출하는 `llm_call` 함수를 완성하고, 2024년 미국과 브라질의 외교 관계 및 출처 링크를 요구하는 질문을 실행한다.

```python
def llm_call(
    query: str,
    retrieve_function: callable = None,
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
    generated_message = generated_response["content"]

    return generated_message


# 하이브리드 검색기 기반 RAG 호출 테스트
query = (
    "Tell me about United States and Brazil's relationship over the course of 2024. "
    "Provide links for the resources you use in the answer."
)
print(llm_call(query=query, top_k=5, retrieve_function=hybrid_retrieve))

# 작업 종료 후 Weaviate 클라이언트 리소스 해제
client.close()
```

`llm_call`을 실행하면 하이브리드 검색기가 2024년 BBC 뉴스 컬렉션에서 미국과 브라질 정상회담, G20 외교 현안, 남미 정세 관련 청크 5건을 찾아 프롬프트에 주입한다. 언어 모델은 이 최신 맥락을 바탕으로 2024년 양국 관계의 주요 현안을 요약하고, 각 문단 끝에 함께 전달받은 `https://www.bbc.com/news/...` 출처 링크를 첨부하여 응답을 완성한다. 모든 작업이 끝난 뒤에는 `client.close()`를 호출해 임베디드 및 로컬 Weaviate 연결과 점유 포트를 정상적으로 해제한다.

---

## 7. 참고 자료

1. **DeepLearning.AI** — *Retrieval Augmented Generation (RAG)*, Module 3 Labs & Assignment: "Introduction to Weaviate API, Chunking, and Building RAG Systems with a Vector Database"
2. **Weaviate Documentation** — *Python Client v4: Manage Data, Collections, Hybrid Search, and Reranking* (`https://weaviate.io/developers/weaviate`)
